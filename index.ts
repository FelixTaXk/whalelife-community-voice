/*! 语音模块：只负责语音模型接入与共享配置；说话、唱歌在子插件里。 */

import { spawn } from 'node:child_process';
import { copyFile, link, mkdir, readdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Context } from '../../core/context.ts';
import {
  apiBase, authHeaders, BREEZE_MODEL_FILE, BREEZE_ROOT, DATA_ROOT, DEFAULTS, ensureBreeze,
  ensureDefaultVoice as ensureDefaultVoiceCore, esc, healthy, HIVE_MODEL, HIVE_VOICES, isInside,
  isLoopback, normalize, PLUGIN_ROOT, rootBase, runProcess, stopBreeze, synth, type Cfg, type Resolved,
} from './shared.ts';

export function apply(ctx: Context) {
  const readCfg = async (): Promise<Resolved> => {
    try {
      return normalize((await ctx.config.read()) as Cfg | null);
    } catch {
      return { ...DEFAULTS, cloudVoices: [] };
    }
  };

  const saveCfg = async (patch: Partial<Resolved>): Promise<Resolved> => {
    const current = await readCfg();
    const next = normalize({ ...current, ...patch } as Cfg);
    await ctx.config.save('config.json', next);
    return next;
  };

  const modelInfo = (cfg: Resolved) => {
    if (cfg.engine === 'local') return { model: '本机 Breeze', endpoint: cfg.baseUrl };
    if (!cfg.modelId) return { model: '', endpoint: '' };
    try {
      const conn = ctx.models.connection(cfg.modelId);
      return { model: conn.name, endpoint: conn.base_url };
    } catch {
      return { model: '', endpoint: '' };
    }
  };

  ctx.tools.register({
    name: 'voice_status',
    description: '查看语音模块接的是本机还是网络模型、模型名和地址，以及说话、唱歌两个子插件是否已加载。',
    danger: 'safe',
    schema: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      const cfg = await readCfg();
      const info = modelInfo(cfg);
      let online = false;
      if (cfg.engine === 'local') online = await healthy(cfg.baseUrl);
      else if (cfg.modelId) {
        try {
          const conn = ctx.models.connection(cfg.modelId);
          const res = await fetch(`${apiBase(conn.base_url)}/models`, {
            headers: authHeaders(conn.api_key || ''),
            signal: AbortSignal.timeout(6000),
          });
          online = res.status < 500;
        } catch {
          online = false;
        }
      }
      return {
        status: online ? 'ready' : 'stopped',
        engine: cfg.engine,
        model: info.model,
        endpoint: info.endpoint,
        defaultVoice: cfg.engine === 'local' ? cfg.voice : cfg.cloudVoice,
        children: {
          speak: ctx.tools.list().some((t: any) => t?.function?.name === 'say_out_loud'),
          sing: ctx.tools.list().some((t: any) => t?.function?.name === 'voice_sing'),
        },
        note: cfg.engine === 'local'
          ? (online ? '本机引擎已就绪。' : '本机引擎没起，说话时会自动拉起。')
          : (online ? '网络模型可连通。' : '网络模型连不上，检查地址或密钥。'),
      };
    },
  });

  ctx.provide('voice', {
    apiVersion: '1.0.0',
    config: readCfg,
    save: saveCfg,
    synthesize: async (input: { text: string; voice?: string }, options?: { signal?: AbortSignal }) => {
      const cfg = await readCfg();
      const text = String(input?.text ?? '').trim();
      if (!text) throw new Error('没有要说的内容。');
      if (Array.from(text).length > cfg.maxChars) throw new Error(`超过 ${cfg.maxChars} 字上限。`);
      const { bytes, voice, target } = await synth(ctx, cfg, text, input?.voice, options?.signal ?? ctx.signal);
      return { mime: 'audio/wav', base64: bytes.toString('base64'), bytes: bytes.length, voice, engine: target.kind, model: target.name };
    },
    sing: async (
      input: { sourcePath: string; ref?: string; steps?: number; cfgRate?: number; pitch?: number },
      options?: { signal?: AbortSignal },
    ) => {
      if (!ctx.tools.list().some((t: any) => t?.function?.name === 'voice_sing'))
        throw new Error('唱歌子插件没启用，先把“唱歌”子插件打开。');
      const call: any = await ctx.tools.call('voice_sing', input, { signal: options?.signal ?? ctx.signal });
      const result = call?.result ?? call;
      if (result?.status !== 'ok' || !result?.file) throw new Error(result?.error || '唱歌失败');
      const bytes = await readFile(result.file);
      return {
        mime: 'audio/wav', base64: bytes.toString('base64'), bytes: bytes.length,
        file: result.file, ref: result.ref, elapsedMs: Number(result.seconds ?? 0) * 1000,
        steps: result.steps, cfgRate: result.cfgRate, pitch: result.pitch,
      };
    },
  });

  // ── 设置页：模型接入 ───────────────────────────────────────
  const readJson = async (req: any, signal: AbortSignal) => {
    const chunks: Buffer[] = [];
    for await (const c of req) {
      signal.throwIfAborted();
      chunks.push(Buffer.from(c));
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    try {
      return JSON.parse(raw || '{}');
    } catch {
      throw new Error('请求体不是 JSON。');
    }
  };
  const sendJson = (res: any, code: number, value: unknown) => {
    res.statusCode = code;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(value));
  };

  // ── 本机语音一键部署 ───────────────────────────────────────
  type DeployStage = 'idle' | 'check' | 'binary' | 'model' | 'start' | 'voice' | 'done' | 'error' | 'cancelled';
  type Release = { version: string; assetName: string; assetUrl: string };
  const DEPLOY_DIR = join(DATA_ROOT, 'deploy');
  const MODEL_URL = 'https://huggingface.co/HoppouAI/Breeze-TTS-2.cpp/resolve/main/breeze-tts-2-q8_0.gguf?download=true';
  const FALLBACK_RELEASE: Release = {
    version: '0.1.7',
    assetName: 'breeze-tts-2-v0.1.7-windows-x64-vulkan.zip',
    assetUrl: 'https://github.com/HoppouAI/Breeze-TTS-2.cpp/releases/download/v0.1.7/breeze-tts-2-v0.1.7-windows-x64-vulkan.zip',
  };
  const deployState = {
    running: false,
    stage: 'idle' as DeployStage,
    message: '还没检查。',
    percent: 0,
    bytes: 0,
    total: 0,
    startedAt: 0,
    finishedAt: 0,
    error: '',
    voice: '',
    voiceError: '',
    online: false,
    version: '',
    latestVersion: '',
    mode: 'deploy' as 'deploy' | 'update',
    previousVersion: '',
  };
  let deployAbort: AbortController | null = null;
  let deployTask: Promise<void> | null = null;
  let releaseCache: { at: number; value: Release } | null = null;

  const fmtBytes = (n: number) => {
    if (!Number.isFinite(n) || n <= 0) return '0 B';
    if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
    if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
    if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${Math.round(n)} B`;
  };
  const sizeOf = async (file: string) => {
    try {
      const s = await stat(file);
      return s.isFile() ? s.size : 0;
    } catch {
      return 0;
    }
  };
  const versionOf = (file: string) => {
    const m = String(file ?? '').match(/breeze-tts-2-v(\d+\.\d+\.\d+)/i);
    return m ? m[1] : '';
  };
  const compareVersion = (a: string, b: string) => {
    const pa = String(a || '').split('.').map((n) => Number(n) || 0);
    const pb = String(b || '').split('.').map((n) => Number(n) || 0);
    for (let i = 0; i < 3; i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d) return d > 0 ? 1 : -1;
    }
    return 0;
  };
  const setDeployProgress = (stage: DeployStage, message: string, bytes = 0, total = 0) => {
    deployState.stage = stage;
    deployState.message = message;
    deployState.bytes = bytes;
    deployState.total = total;
    deployState.percent = total > 0 ? Math.min(99, Math.round((bytes / total) * 100)) : 0;
  };

  const latestRelease = async (): Promise<Release> => {
    if (releaseCache && Date.now() - releaseCache.at < 10 * 60_000) return releaseCache.value;
    try {
      const res = await fetch('https://api.github.com/repos/HoppouAI/Breeze-TTS-2.cpp/releases/latest', {
        headers: { 'user-agent': 'WhaleLife voice deploy', accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: any = await res.json();
      const asset = (data?.assets ?? []).find((a: any) => /windows-x64-vulkan\.zip$/i.test(String(a?.name ?? '')));
      if (asset?.browser_download_url) {
        const value: Release = {
          version: String(data?.tag_name ?? '').replace(/^v/i, '') || versionOf(asset.name),
          assetName: String(asset.name),
          assetUrl: String(asset.browser_download_url),
        };
        releaseCache = { at: Date.now(), value };
        return value;
      }
    } catch {
      /* 网络不可用时用固定版本兜底 */
    }
    releaseCache = { at: Date.now(), value: FALLBACK_RELEASE };
    return FALLBACK_RELEASE;
  };

  const findBinary = async (cfg: Resolved) => {
    const binRoot = join(BREEZE_ROOT, 'bin');
    try {
      const dirs = (await readdir(binRoot, { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort((a, b) => b.localeCompare(a));
      for (const dir of dirs) {
        const exe = join(binRoot, dir, 'breeze-server.exe');
        if ((await sizeOf(exe)) > 1_000_000) return exe;
      }
    } catch {
      /* 目录还没建 */
    }
    if ((await sizeOf(cfg.breezeExe)) > 1_000_000) return cfg.breezeExe;
    return '';
  };

  const findModel = async (cfg: Resolved) => {
    const modelRoot = join(BREEZE_ROOT, 'models');
    const portable = join(modelRoot, BREEZE_MODEL_FILE);
    if ((await sizeOf(portable)) > 100_000_000) return portable;
    if ((await sizeOf(cfg.breezeModel)) > 100_000_000) return cfg.breezeModel;
    try {
      const names = (await readdir(modelRoot))
        .filter((n) => n.toLowerCase().endsWith('.gguf'))
        .sort((a, b) => {
          const aq = /q8_0/.test(a) ? 0 : 1;
          const bq = /q8_0/.test(b) ? 0 : 1;
          return aq - bq || a.localeCompare(b);
        });
      for (const name of names) {
        const file = join(modelRoot, name);
        if ((await sizeOf(file)) > 100_000_000) return file;
      }
    } catch {
      /* 目录还没建 */
    }
    return '';
  };

  const copyTree = async (src: string, dst: string, signal: AbortSignal) => {
    await mkdir(dst, { recursive: true });
    for (const entry of await readdir(src, { withFileTypes: true })) {
      signal.throwIfAborted();
      const from = join(src, entry.name);
      const to = join(dst, entry.name);
      if (entry.isDirectory()) {
        await copyTree(from, to, signal);
      } else if (entry.isFile()) {
        if ((await sizeOf(to)) > 0) continue;
        try {
          await link(from, to);
        } catch {
          await copyFile(from, to);
        }
      }
    }
  };

  const migrateBinary = async (cfg: Resolved, signal: AbortSignal) => {
    const src = cfg.breezeExe;
    if ((await sizeOf(src)) < 1_000_000 || isInside(BREEZE_ROOT, src)) return '';
    const srcDir = dirname(src);
    const dstDir = join(BREEZE_ROOT, 'bin', basename(srcDir));
    setDeployProgress('binary', '把已有的 Breeze 迁移到插件目录……');
    await copyTree(srcDir, dstDir, signal);
    const exe = join(dstDir, 'breeze-server.exe');
    return (await sizeOf(exe)) > 1_000_000 ? exe : '';
  };

  const migrateModel = async (cfg: Resolved, signal: AbortSignal) => {
    const src = cfg.breezeModel;
    if ((await sizeOf(src)) < 100_000_000 || isInside(BREEZE_ROOT, src)) return '';
    const dst = HIVE_MODEL;
    if ((await sizeOf(dst)) > 100_000_000) return dst;
    await mkdir(dirname(dst), { recursive: true });
    setDeployProgress('model', '把已有模型迁移到插件目录……');
    signal.throwIfAborted();
    try {
      await link(src, dst);
    } catch {
      await copyFile(src, dst);
    }
    return (await sizeOf(dst)) > 100_000_000 ? dst : '';
  };

  const migrateVoices = async (cfg: Resolved, signal: AbortSignal) => {
    const src = cfg.voicesDir;
    if (!src || src === HIVE_VOICES) return;
    let names: string[] = [];
    try {
      names = (await readdir(src)).filter((n) => n.toLowerCase().endsWith('.breeze'));
    } catch {
      return;
    }
    if (!names.length) return;
    await mkdir(HIVE_VOICES, { recursive: true });
    for (const name of names) {
      signal.throwIfAborted();
      const from = join(src, name);
      const to = join(HIVE_VOICES, name);
      if ((await sizeOf(to)) > 0) continue;
      try {
        await link(from, to);
      } catch {
        await copyFile(from, to);
      }
    }
  };

  const listVoiceFiles = async (dir: string) => {
    try {
      return (await readdir(dir)).filter((n) => n.toLowerCase().endsWith('.breeze'));
    } catch {
      return [];
    }
  };

  const downloadWithCurl = async (
    url: string,
    dest: string,
    signal: AbortSignal,
    stage: DeployStage,
    label: string,
  ) => {
    await mkdir(dirname(dest), { recursive: true });
    const part = `${dest}.part`;
    const have = await sizeOf(part);
    const args = [
      '--location', '--fail', '--silent', '--show-error',
      '--ssl-no-revoke', '--retry', '3', '--retry-delay', '2',
      '--output', part,
    ];
    if (have > 0) args.push('--continue-at', '-');
    args.push(url);
    setDeployProgress(stage, `${label}：连接下载源…`, have, 0);
    await new Promise<void>((resolvePromise, rejectPromise) => {
      let stderr = '';
      const child = spawn('C:\\Windows\\System32\\curl.exe', args, {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      const timer = setInterval(() => {
        void sizeOf(part).then((bytes) => {
          setDeployProgress(stage, `${label}：${fmtBytes(bytes)}`, bytes, 0);
        }).catch(() => undefined);
      }, 500);
      const done = (error?: Error) => {
        clearInterval(timer);
        if (error) rejectPromise(error);
        else resolvePromise();
      };
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-600);
      });
      child.on('error', (error) => done(error));
      child.on('close', (code) => {
        if (signal.aborted) return done(new Error('已取消'));
        if (code !== 0 && !(code === 33 && have > 0)) {
          return done(new Error(`${label}下载失败：${stderr.trim() || `curl exit ${code}`}`));
        }
        done();
      });
      const abort = () => {
        try { child.kill(); } catch { /* 进程可能已经退出 */ }
      };
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    });
    const bytes = await sizeOf(part);
    if (bytes < 1_000_000) throw new Error(`${label}下载后文件太小（${fmtBytes(bytes)}）。`);
    try {
      await unlink(dest);
    } catch {
      /* 目标文件还不存在 */
    }
    await rename(part, dest);
    setDeployProgress(stage, `${label}：下载完成（${fmtBytes(bytes)}）`, bytes, bytes);
  };

  const downloadFile = async (
    url: string,
    dest: string,
    signal: AbortSignal,
    stage: DeployStage,
    label: string,
  ) => {
    await mkdir(dirname(dest), { recursive: true });
    const part = `${dest}.part`;
    let have = await sizeOf(part);
    const headers: Record<string, string> = { 'user-agent': 'WhaleLife voice deploy' };
    if (have > 0) headers.range = `bytes=${have}-`;
    setDeployProgress(stage, `${label}：连接下载源…`, have, 0);
    try {
      const res = await fetch(url, { headers, signal, redirect: 'follow' });
      if (!res.ok || !res.body) throw new Error(`${label}下载失败（HTTP ${res.status}）。`);
      if (have > 0 && res.status === 200) have = 0;
      const total = Number(res.headers.get('content-length') || 0) + (res.status === 206 ? have : 0);
      let bytes = have;
      let lastTick = 0;
      const counter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          bytes += chunk.length;
          const now = Date.now();
          if (now - lastTick > 500) {
            lastTick = now;
            setDeployProgress(
              stage,
              `${label}：${fmtBytes(bytes)}${total > 0 ? ` / ${fmtBytes(total)}` : ''}`,
              bytes,
              total,
            );
          }
          cb(null, chunk);
        },
      });
      await pipeline(
        Readable.fromWeb(res.body as any),
        counter,
        createWriteStream(part, { flags: have > 0 ? 'a' : 'w' }),
      );
      if (total > 0 && bytes < total * 0.98) throw new Error(`${label}下载不完整（${fmtBytes(bytes)} / ${fmtBytes(total)}）。`);
      try {
        await unlink(dest);
      } catch {
        /* 目标文件还不存在 */
      }
      await rename(part, dest);
      setDeployProgress(stage, `${label}：下载完成（${fmtBytes(bytes)}）`, bytes, total);
    } catch (e: any) {
      if (signal.aborted) throw e;
      ctx.logger.warn('fetch 下载失败，改用系统 curl 重试', { error: String(e?.message ?? e), url });
      await downloadWithCurl(url, dest, signal, stage, label);
    }
  };

  const extractZip = async (zip: string, target: string, signal: AbortSignal) => {
    await mkdir(target, { recursive: true });
    const result = await runProcess('C:\\Windows\\System32\\tar.exe', ['-xf', zip, '-C', target], {
      signal,
      timeout: 300_000,
    });
    if (result.code !== 0) throw new Error(`解压 Breeze 运行包失败：${result.stderr.slice(-400) || `exit ${result.code}`}`);
  };

  const ensureBinary = async (cfg: Resolved, signal: AbortSignal) => {
    const found = await findBinary(cfg);
    if (found) {
      if (isInside(BREEZE_ROOT, found)) return found;
      try {
        const migrated = await migrateBinary(cfg, signal);
        if (migrated) return migrated;
      } catch (e: any) {
        ctx.logger.warn('Breeze 迁移到插件目录失败，暂用原路径', { error: String(e?.message ?? e) });
      }
      return found;
    }
    const release = await latestRelease();
    deployState.latestVersion = release.version;
    setDeployProgress('binary', `未找到 Breeze，准备下载 v${release.version} 运行包…`);
    const zip = join(DEPLOY_DIR, release.assetName);
    if ((await sizeOf(zip)) < 10_000_000) {
      await downloadFile(release.assetUrl, zip, signal, 'binary', `Breeze v${release.version} 运行包`);
    }
    setDeployProgress('binary', '解压运行包…');
    const binRoot = join(BREEZE_ROOT, 'bin');
    await extractZip(zip, binRoot, signal);
    const expected = join(binRoot, release.assetName.replace(/\.zip$/i, ''), 'breeze-server.exe');
    if ((await sizeOf(expected)) > 1_000_000) return expected;
    const again = await findBinary({ ...cfg, breezeExe: expected });
    if (!again) throw new Error('运行包解压后没有找到 breeze-server.exe。');
    return again;
  };

  const updateBinary = async (cfg: Resolved, release: Release, signal: AbortSignal) => {
    const binRoot = join(BREEZE_ROOT, 'bin');
    const targetDir = join(binRoot, release.assetName.replace(/\.zip$/i, ''));
    const expected = join(targetDir, 'breeze-server.exe');
    if ((await sizeOf(expected)) > 1_000_000 && versionOf(expected) === release.version) return expected;
    setDeployProgress('binary', `更新 Breeze 到 v${release.version}：准备运行包…`);
    const zip = join(DEPLOY_DIR, release.assetName);
    if ((await sizeOf(zip)) < 10_000_000) {
      await downloadFile(release.assetUrl, zip, signal, 'binary', `Breeze v${release.version} 运行包`);
    }
    setDeployProgress('binary', `解压 Breeze v${release.version} 运行包…`);
    await extractZip(zip, binRoot, signal);
    if ((await sizeOf(expected)) < 1_000_000) throw new Error('更新包解压后没有找到 breeze-server.exe。');
    return expected;
  };

  const ensureModel = async (cfg: Resolved, signal: AbortSignal) => {
    const found = await findModel(cfg);
    if (found) {
      if (isInside(BREEZE_ROOT, found)) return found;
      try {
        const migrated = await migrateModel(cfg, signal);
        if (migrated) return migrated;
      } catch (e: any) {
        ctx.logger.warn('模型迁移到插件目录失败，暂用原路径', { error: String(e?.message ?? e) });
      }
      return found;
    }
    const dest = join(BREEZE_ROOT, 'models', BREEZE_MODEL_FILE);
    await downloadFile(MODEL_URL, dest, signal, 'model', `q8_0 模型（约 ${fmtBytes(3_568_844_480)}）`);
    if ((await sizeOf(dest)) < 100_000_000) throw new Error('模型下载后文件不完整。');
    return dest;
  };

  const startDeploy = async (mode: 'deploy' | 'update' = 'deploy') => {
    if (deployTask) return { ok: true, started: false, running: true };
    const ac = new AbortController();
    deployAbort = ac;
    Object.assign(deployState, {
      running: true, stage: 'check', message: mode === 'update' ? '开始检查 Breeze 更新……' : '开始检查本机语音……',
      percent: 0, bytes: 0, total: 0, startedAt: Date.now(), finishedAt: 0, error: '', voice: '', voiceError: '',
      online: false, mode, previousVersion: '',
    });
    deployTask = (async () => {
      try {
        await mkdir(DEPLOY_DIR, { recursive: true });
        await mkdir(join(BREEZE_ROOT, 'bin'), { recursive: true });
        await mkdir(join(BREEZE_ROOT, 'models'), { recursive: true });
        await mkdir(join(BREEZE_ROOT, 'voices'), { recursive: true });
        const cfg = await readCfg();
        const release = await latestRelease();
        deployState.latestVersion = release.version;
        const currentExe = await findBinary(cfg);
        const currentVersion = versionOf(currentExe);
        deployState.previousVersion = currentVersion;
        if (mode === 'update' && currentExe && currentVersion && compareVersion(release.version, currentVersion) <= 0) {
          deployState.previousVersion = '';
          deployState.running = false;
          deployState.stage = 'done';
          deployState.percent = 100;
          deployState.finishedAt = Date.now();
          deployState.message = `Breeze 已是最新版本 v${currentVersion}。`;
          return;
        }
        setDeployProgress('check', mode === 'update'
          ? `检查 Breeze 更新：v${currentVersion || '?'} → v${release.version}……`
          : '检查运行包、模型和音色……');
        await migrateVoices(cfg, ac.signal);
        const exe = mode === 'update'
          ? (currentExe
              ? await updateBinary(cfg, release, ac.signal)
              : await ensureBinary(cfg, ac.signal))
          : await ensureBinary(cfg, ac.signal);
        const model = await ensureModel(cfg, ac.signal);
        const voicesDir = HIVE_VOICES;
        await mkdir(voicesDir, { recursive: true });
        const next = await saveCfg({ breezeExe: exe, breezeModel: model, voicesDir });
        deployState.version = versionOf(exe);
        if (mode === 'update' || exe !== cfg.breezeExe || model !== cfg.breezeModel) await stopBreeze();
        setDeployProgress('start', mode === 'update' ? '重启本机语音服务……' : '启动本机语音服务……');
        const boot = await ensureBreeze(next, ac.signal);
        if (!boot.ready) throw new Error('Breeze 已启动，但 90 秒内没就绪；可能是显卡被占用或模型文件不完整。');
        deployState.online = true;
        setDeployProgress('voice', '服务已就绪，准备默认音色……');
        try {
          const voice = await ensureDefaultVoiceCore(ctx, next, ac.signal);
          deployState.voice = String(voice?.voice ?? '');
          if (voice?.voice && voice.voice !== next.voice) await saveCfg({ voice: voice.voice });
        } catch (e: any) {
          deployState.voiceError = String(e?.message ?? e);
        }
        deployState.running = false;
        deployState.stage = 'done';
        deployState.percent = 100;
        deployState.finishedAt = Date.now();
        deployState.message = deployState.voiceError
          ? (mode === 'update'
              ? `Breeze 已更新到 v${deployState.version}，但默认音色没建好：${deployState.voiceError}`
              : `本机语音已就绪，但默认音色没建好：${deployState.voiceError}`)
          : (mode === 'update'
              ? `Breeze 已更新到 v${deployState.version}，可以直接说话。`
              : '本机语音已就绪，可以直接说话。');
      } catch (e: any) {
        deployState.running = false;
        deployState.finishedAt = Date.now();
        if (ac.signal.aborted) {
          deployState.stage = 'cancelled';
          deployState.message = mode === 'update' ? '更新已取消，已下载的部分会保留。' : '部署已取消，已下载的部分会保留。';
        } else {
          deployState.stage = 'error';
          deployState.error = String(e?.message ?? e);
          deployState.message = (mode === 'update' ? '更新失败：' : '部署失败：') + deployState.error;
        }
      } finally {
        deployTask = null;
        deployAbort = null;
      }
    })();
    return { ok: true, started: true, running: true };
  };

  const deployStatus = async () => {
    const cfg = await readCfg();
    const exe = await findBinary(cfg);
    const model = await findModel(cfg);
    const release = await latestRelease();
    const voices = await listVoiceFiles(HIVE_VOICES);
    const legacyVoices = cfg.voicesDir && cfg.voicesDir !== HIVE_VOICES ? await listVoiceFiles(cfg.voicesDir) : [];
    const missing: string[] = [];
    if (!exe) missing.push('Breeze 运行包');
    if (!model) missing.push('q8_0 模型');
    if (!voices.length && !legacyVoices.length) missing.push('音色文件');
    let online = false;
    if (cfg.engine === 'local') {
      try {
        online = await healthy(cfg.baseUrl);
      } catch {
        online = false;
      }
    }
    return {
      ok: true,
      running: deployState.running,
      stage: deployState.stage,
      message: deployState.message,
      percent: deployState.percent,
      bytes: deployState.bytes,
      total: deployState.total,
      error: deployState.error,
      voiceError: deployState.voiceError,
      voice: deployState.voice || cfg.voice,
      online: deployState.online || online,
      mode: deployState.mode,
      previousVersion: deployState.previousVersion,
      updateAvailable: Boolean(exe && versionOf(exe) && release.version && compareVersion(release.version, versionOf(exe)) > 0),
      installed: {
        binary: Boolean(exe),
        model: Boolean(model),
        voices: voices.length,
        legacyVoices: legacyVoices.length,
        version: versionOf(exe) || deployState.version,
        exe,
        modelPath: model,
        modelBytes: await sizeOf(model),
        voicesDir: HIVE_VOICES,
      },
      paths: {
        pluginRoot: PLUGIN_ROOT,
        breezeRoot: BREEZE_ROOT,
        deploy: DEPLOY_DIR,
      },
      latest: release,
      missing,
      engine: cfg.engine,
      currentVoice: cfg.voice,
    };
  };

  ctx.web.page('/plugins/voice/settings', async (_req, res) => {
    const cfg = await readCfg();
    const cfgJson = JSON.stringify(cfg).replace(/</g, '\\u003c');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>语音模块 · WhaleLife</title>
<style>
:root{color-scheme:light dark;font:15px/1.65 system-ui,-apple-system,"Microsoft YaHei",sans-serif;--ink:#203438;--muted:#617477;--line:#dce6e5;--paper:#fff;--soft:#f4f8f7;--accent:#126e68;background:var(--soft);color:var(--ink)}
@media (prefers-color-scheme:dark){:root{--ink:#e4ecee;--muted:#9aadb2;--line:#2d3b3f;--paper:#1b2427;--soft:#151b1d;--accent:#5cb5ad}}
*{box-sizing:border-box}
body{margin:0;padding:32px 28px 36px}
main{max-width:880px;margin:0 auto}
header{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:20px}
h1{font-size:27px;letter-spacing:-.5px;margin:0 0 4px;font-weight:650}
p.sub{margin:0;color:var(--muted);font-size:13px}
section.card{background:var(--paper);border:1px solid var(--line);border-radius:14px;padding:20px 22px;margin:18px 0}
.card-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:6px}
h2{font-size:16px;margin:0}
.deploy-bar{height:8px;background:var(--line);border-radius:99px;overflow:hidden;margin:14px 0 8px}
.deploy-bar i{display:block;height:100%;width:0;background:var(--accent);transition:width .3s}
label{display:grid;gap:6px;font-size:13px;color:var(--muted)}
input,select{font:inherit;padding:9px 12px;border:1px solid var(--line);border-radius:7px;background:var(--paper);color:var(--ink);width:100%}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px 18px;margin-top:12px}
.wide{grid-column:1/-1}
.row{display:flex;gap:10px;align-items:center;margin-top:18px;flex-wrap:wrap}
.row.tight{margin-top:10px}
button{font:inherit;padding:9px 14px;border:1px solid var(--line);border-radius:7px;background:var(--paper);color:var(--ink);cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
.seg{display:flex;gap:8px;margin:14px 0 4px}
.seg button{flex:1;padding:10px;border-radius:9px}
.seg button.on{background:var(--accent);border-color:var(--accent);color:#fff}
.pill{font-size:12px;padding:2px 10px;border-radius:99px;border:1px solid var(--line);color:var(--muted)}
.hint{color:var(--muted);font-size:12px;margin:10px 0 0}
#deployInfo{white-space:pre-line}
.link{color:var(--accent);font-size:13px;text-decoration:none;padding:8px 12px;border:1px solid var(--line);border-radius:8px}
pre{background:var(--soft);border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin:16px 0 0;white-space:pre-wrap;font-size:12px;color:var(--muted);min-height:18px}
@media (max-width:640px){.grid{grid-template-columns:1fr}body{padding:20px 16px 28px}h1{font-size:23px}header{flex-direction:column}.seg{flex-direction:column}}
</style></head><body><main>
<header><div><h1>语音模块</h1><p class="sub">先在这里接模型 · 说话和唱歌分别去子插件</p></div><span class="pill" id="enginePill">本机模型</span></header>

<section class="card">
  <div class="card-head"><h2>1 模型接入</h2></div>
  <p class="sub">主插件只负责选模型、连服务、存共享配置。说话和唱歌两个子插件都从这里取配置。</p>
  <div class="seg" id="engine"><button type="button" data-engine="local">本机模型</button><button type="button" data-engine="cloud">网络模型</button></div>

  <div id="localBox">
    <div class="grid">
      <label class="wide">Breeze 服务地址<input type="text" id="baseUrl" value="${esc(cfg.baseUrl)}" placeholder="http://127.0.0.1:8139"></label>
      <label>默认音色 id<input type="text" id="voice" value="${esc(cfg.voice)}" placeholder="dafeiyu"></label>
      <label>ComfyUI 地址（腾显存）<input type="text" id="comfyUrl" value="${esc(cfg.comfyUrl)}"></label>
    </div>
    <p class="hint">本机 Breeze 没起会自动拉起；显存被 ComfyUI 占着会先让它卸载模型。任何 OpenAI 兼容的本地语音服务也可以直接把地址填在这里。</p>
  </div>

  <div id="cloudBox" hidden>
    <div class="grid">
      <label class="wide">语音合成模型<select id="modelId"><option value="">载入中…</option></select></label>
      <label class="wide">默认音色 id<input type="text" id="cloudVoice" list="voiceHints" value="${esc(cfg.cloudVoice)}" placeholder="alloy / FunAudioLLM/CosyVoice2-0.5B:alex"></label>
      <datalist id="voiceHints"></datalist>
    </div>
    <div class="row tight"><button type="button" id="refreshModels">刷新模型列表</button><a class="link" href="/#models" target="_blank">去“模型服务”添加语音合成模型</a></div>
    <p class="hint">网络模型走 OpenAI 兼容的 /v1/audio/speech，密钥取自“模型服务”里的提供商配置，不在这里重复填。</p>
  </div>

  <div class="row"><button class="primary" type="button" id="saveModel">保存模型设置</button><button type="button" id="test">测试连接</button></div>
</section>

<section class="card">
  <div class="card-head"><h2>本机语音一键部署</h2><span class="pill" id="deployPill">检查中…</span></div>
  <p class="sub">第一次用本机模型时点一次：自动下载 Breeze 运行包和 q8_0 模型（约 3.6GB），装到本插件目录的 data/breeze，解压、启动并准备默认音色。已有的文件会迁移或跳过，下载支持断点续传。</p>
  <div class="deploy-bar"><i id="deployBar"></i></div>
  <div class="hint" id="deployInfo">还没检查。</div>
  <div class="row">
    <button class="primary" type="button" id="deployBtn">一键部署本机语音</button>
    <button type="button" id="deployUpdate" hidden>更新 Breeze</button>
    <button type="button" id="deployRefresh">重新检查</button>
    <button type="button" id="deployCancel" hidden>取消部署</button>
  </div>
  <p class="hint">更新 Breeze 只替换运行包，模型和音色都保留；更新时语音会短暂中断，完成后自动重启。</p>
</section>

<section class="card">
  <div class="card-head"><h2>2 子插件</h2></div>
  <p class="sub">模型配好后，去对应的子插件操作。说话负责音色库、TTS 和 QQ 语音；唱歌负责 Seed-VC 歌声转换。</p>
  <div class="row"><a class="link" href="/plugins/voice/speak/settings" data-console-href="#plugin:voice/speak">说话设置 →</a><a class="link" href="/plugins/voice/sing/settings" data-console-href="#plugin:voice/sing">唱歌设置 →</a></div>
  <p class="hint">两个子插件都依赖这里的配置，所以先保存模型设置，再进子插件。</p>
</section>

<section class="card">
  <details><summary>高级：本机引擎路径与显存</summary>
    <div class="grid">
      <label class="wide">breeze-server.exe<input type="text" id="breezeExe" value="${esc(cfg.breezeExe)}"></label>
      <label class="wide">模型 gguf<input type="text" id="breezeModel" value="${esc(cfg.breezeModel)}"></label>
      <label class="wide">voices 目录<input type="text" id="voicesDir" value="${esc(cfg.voicesDir)}"></label>
      <label>单句上限字数<input type="number" id="maxChars" value="${cfg.maxChars}"></label>
      <label style="display:flex;align-items:center;gap:8px;color:var(--ink)"><input type="checkbox" id="play" ${cfg.play ? 'checked' : ''}>默认在本机扬声器播放</label>
    </div>
    <div class="row"><button type="button" id="saveAdv">保存高级设置</button></div>
    <p class="hint">这些是本机模型和显存相关设置；网络模型用不到。</p>
  </details>
</section>
<pre id="out"></pre>
</main>
<script>
const CFG = ${cfgJson};
let draftEngine = CFG.engine || 'local';
let models = [];
const $ = function (id) { return document.getElementById(id); };
const out = function (v) { $('out').textContent = (typeof v === 'string') ? v : JSON.stringify(v, null, 2); };
const h = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); };
document.addEventListener('click', function (ev) {
  var a = ev.target && ev.target.closest ? ev.target.closest('[data-console-href]') : null;
  if (!a || window.top === window.self) return;
  ev.preventDefault();
  try { window.top.location.hash = a.getAttribute('data-console-href'); } catch (e) {}
});
async function post(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const text = await r.text();
  try { return JSON.parse(text); } catch (e) { return { ok: false, error: text || ('HTTP ' + r.status) }; }
}
function paint() {
  const local = draftEngine === 'local';
  $('localBox').hidden = !local;
  $('cloudBox').hidden = local;
  $('enginePill').textContent = local ? '本机模型' : '网络模型';
  Array.prototype.forEach.call(document.querySelectorAll('#engine button'), function (b) { b.classList.toggle('on', b.dataset.engine === draftEngine); });
}
Array.prototype.forEach.call(document.querySelectorAll('#engine button'), function (b) {
  b.onclick = function () { draftEngine = b.dataset.engine; paint(); out('切换后点“保存模型设置”生效。'); };
});
function voiceHintsFor(model) {
  if (!model) return [];
  if (model.indexOf('FunAudioLLM/') === 0 || model.indexOf('fishaudio/') === 0 || model.indexOf('IndexTeam/') === 0) {
    return ['alex', 'anna', 'bella', 'benjamin', 'charles', 'claire', 'david', 'diana'].map(function (n) { return model + ':' + n; });
  }
  if (model === 'gpt-4o-mini-tts' || model === 'tts-1' || model === 'tts-1-hd') {
    return ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'onyx', 'nova', 'sage', 'shimmer', 'verse', 'marin', 'cedar'];
  }
  return [];
}
function fillVoiceHints(id) {
  const m = models.filter(function (x) { return x.id === id; })[0];
  const list = voiceHintsFor(m && m.model);
  $('voiceHints').innerHTML = list.map(function (v) { return '<option value="' + h(v) + '"></option>'; }).join('');
  $('cloudVoice').placeholder = list.length ? ('推荐：' + list[0]) : '音色 id，例如 alloy / FunAudioLLM/CosyVoice2-0.5B:alex';
}
async function loadModels() {
  const j = await post('/plugins/voice/models');
  if (!j.ok) { out(j.error || '模型列表读取失败'); return; }
  models = j.models || [];
  const sel = $('modelId');
  let html = '<option value="">— 选择语音合成模型 —</option>';
  models.forEach(function (m) {
    html += '<option value="' + h(m.id) + '"' + (m.id === CFG.modelId ? ' selected' : '') + (m.supported ? '' : ' disabled') + '>' + h(m.name) + ' · ' + h(m.providerName || '未知提供商') + (m.supported ? '' : '（协议不支持）') + '</option>';
  });
  sel.innerHTML = html;
  if (!models.length) out('还没有语音合成模型。去“模型服务”新建一个 tts 类型的模型，或切回本机模型。');
  fillVoiceHints(sel.value);
}
function fmtBytes(n) {
  n = Number(n) || 0;
  if (n >= 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(1) + ' GB';
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return Math.round(n) + ' B';
}
let deployTimer = null;
function paintDeploy(s) {
  var inst = s.installed || {};
  var latest = s.latest || {};
  var newer = Boolean(s.updateAvailable && latest.version);
  var pill = $('deployPill');
  if (s.running) {
    pill.textContent = (s.mode === 'update' ? '更新中 ' : '部署中 ') + (s.percent || 0) + '%';
  } else if (inst.binary && inst.model) {
    pill.textContent = newer ? '有更新' : '已就绪';
  } else {
    pill.textContent = s.stage === 'error' ? '部署失败' : '待部署';
  }
  var lines = [];
  if (s.running) {
    lines.push(s.message || (s.mode === 'update' ? '更新中…' : '部署中…'));
    if (s.bytes) lines.push(fmtBytes(s.bytes) + (s.total ? ' / ' + fmtBytes(s.total) : ''));
  } else if (s.stage === 'error') {
    lines.push(s.message || '部署失败');
  } else {
    lines.push('运行包：' + (inst.binary ? ('v' + (inst.version || '?')) : '未安装') + (newer ? ('（可更新到 v' + latest.version + '）') : (inst.binary ? '（已是最新）' : '')));
    lines.push('模型：' + (inst.model ? fmtBytes(inst.modelBytes) : '未下载'));
    lines.push('音色：' + (inst.voices || 0) + ' 个' + (inst.legacyVoices ? ('（另有 ' + inst.legacyVoices + ' 个待迁移）') : '') + (inst.voicesDir ? (' · ' + inst.voicesDir) : ''));
    lines.push('服务：' + (s.online ? '在线' : '未启动'));
    if (s.previousVersion && s.mode === 'update' && s.previousVersion !== inst.version) lines.push('本次更新：v' + s.previousVersion + ' → v' + (inst.version || '?'));
    if ((s.missing || []).length) lines.push('缺少：' + s.missing.join('、'));
    if (s.voiceError) lines.push('默认音色：' + s.voiceError);
    if (s.voice) lines.push('本次音色：' + s.voice);
  }
  $('deployInfo').textContent = lines.join(String.fromCharCode(10));
  $('deployBar').style.width = ((s.running || s.stage === 'done') ? (s.percent || 0) : 0) + '%';
  $('deployBtn').disabled = !!s.running;
  $('deployUpdate').hidden = !newer;
  $('deployUpdate').disabled = !!s.running;
  if (newer) $('deployUpdate').textContent = '更新 Breeze 到 v' + latest.version;
  $('deployCancel').hidden = !s.running;
  if (s.running) {
    if (!deployTimer) deployTimer = setInterval(refreshDeploy, 1000);
  } else if (deployTimer) {
    clearInterval(deployTimer);
    deployTimer = null;
  }
}
async function refreshDeploy() {
  var s = await post('/plugins/voice/deploy/status');
  if (!s.ok) { $('deployInfo').textContent = s.error || '检查失败'; return; }
  paintDeploy(s);
}
$('deployBtn').onclick = async function () {
  out('开始部署本机语音…');
  var r = await post('/plugins/voice/deploy');
  if (!r.ok) { out(r); return; }
  refreshDeploy();
};
$('deployUpdate').onclick = async function () {
  out('开始更新 Breeze…');
  var r = await post('/plugins/voice/deploy/update');
  if (!r.ok) { out(r); return; }
  refreshDeploy();
};
$('deployRefresh').onclick = function () { out('重新检查本机语音…'); refreshDeploy(); };
$('deployCancel').onclick = async function () { out(await post('/plugins/voice/deploy/cancel')); refreshDeploy(); };
$('refreshModels').onclick = function () { loadModels(); out('已刷新模型列表。'); };
$('modelId').onchange = function () { fillVoiceHints($('modelId').value); out('换模型后，记住重新选一个该模型支持的音色。'); };
function readAll() {
  return {
    engine: draftEngine,
    baseUrl: $('baseUrl').value.trim(),
    voice: $('voice').value.trim(),
    modelId: $('modelId').value,
    cloudVoice: $('cloudVoice').value.trim(),
    comfyUrl: $('comfyUrl').value.trim(),
    breezeExe: $('breezeExe').value.trim(),
    breezeModel: $('breezeModel').value.trim(),
    voicesDir: $('voicesDir').value.trim(),
    maxChars: Number($('maxChars').value) || 400,
    play: $('play').checked
  };
}
async function saveConfig() {
  if (draftEngine === 'cloud' && !$('cloudVoice').value.trim() && $('voiceHints').options[0])
    $('cloudVoice').value = $('voiceHints').options[0].value;
  const r = await post('/plugins/voice/config', { config: readAll() });
  out(r);
  if (r.ok && r.config) { Object.assign(CFG, r.config); draftEngine = CFG.engine; paint(); }
}
$('saveModel').onclick = saveConfig;
$('saveAdv').onclick = saveConfig;
$('test').onclick = async function () { out('检测中…'); out(await post('/plugins/voice/test')); };
paint();
loadModels();
refreshDeploy();
</script></body></html>`);
  }, { title: '语音模块设置', settings: true, navigation: true });

  ctx.web.api('/plugins/voice/models', async (_req, res) => {
    const models = ctx.models.list('tts').map((m) => {
      let providerName = '';
      let protocol = '';
      let baseUrl = '';
      let supported = false;
      try {
        const c = ctx.models.connection(m.id);
        providerName = c.provider_name;
        protocol = c.protocol;
        baseUrl = c.base_url;
        supported = c.protocol === 'openai-compatible';
      } catch {
        supported = false;
      }
      return { id: m.id, name: m.name, model: m.model, providerName, protocol, baseUrl, supported };
    });
    sendJson(res, 200, { ok: true, models });
  });

  ctx.web.api('/plugins/voice/config', async (req, res, { signal }) => {
    try {
      const body = await readJson(req, signal);
      const input = body?.config ?? {};
      const baseUrl = String(input.baseUrl || DEFAULTS.baseUrl).replace(/\/$/, '');
      if (!/^https?:\/\//.test(baseUrl)) throw new Error('服务地址要以 http:// 或 https:// 开头。');
      const next: Partial<Resolved> = {
        engine: input.engine === 'cloud' ? 'cloud' : 'local',
        baseUrl,
        voice: String(input.voice || DEFAULTS.voice),
        modelId: String(input.modelId || ''),
        cloudVoice: String(input.cloudVoice || ''),
        comfyUrl: String(input.comfyUrl || DEFAULTS.comfyUrl).replace(/\/$/, ''),
        breezeExe: String(input.breezeExe || DEFAULTS.breezeExe),
        breezeModel: String(input.breezeModel || DEFAULTS.breezeModel),
        voicesDir: String(input.voicesDir || DEFAULTS.voicesDir),
        play: input.play !== false,
        maxChars: Number(input.maxChars) > 0 && Number(input.maxChars) <= 2000 ? Math.floor(Number(input.maxChars)) : DEFAULTS.maxChars,
      };
      if (next.engine === 'cloud' && next.modelId) {
        const model = ctx.models.list('tts').find((m) => m.id === next.modelId);
        if (!model) throw new Error('这个语音模型现在不可用（被停用或配置有误）。');
        const conn = ctx.models.connection(next.modelId);
        if (conn.protocol !== 'openai-compatible') throw new Error('暂时只支持 OpenAI 兼容协议的语音合成模型。');
      }
      const cfg = await saveCfg(next);
      sendJson(res, 200, { ok: true, config: cfg });
    } catch (e: any) {
      sendJson(res, 400, { ok: false, error: String(e?.message ?? e) });
    }
  });

  ctx.web.api('/plugins/voice/test', async (_req, res) => {
    const cfg = await readCfg();
    if (cfg.engine === 'local') {
      const up = await healthy(cfg.baseUrl);
      if (!up && isLoopback(cfg.baseUrl)) {
        try {
          await ensureBreeze(cfg, AbortSignal.timeout(120_000));
        } catch {
          /* ignore */
        }
      }
      sendJson(res, 200, { ok: true, engine: 'local', online: await healthy(cfg.baseUrl), baseUrl: cfg.baseUrl, voice: cfg.voice });
      return;
    }
    try {
      const conn = ctx.models.connection(cfg.modelId);
      const r = await fetch(`${apiBase(conn.base_url)}/models`, {
        headers: authHeaders(conn.api_key || ''),
        signal: AbortSignal.timeout(8000),
      });
      sendJson(res, 200, { ok: true, engine: 'cloud', online: true, status: r.status, model: conn.name, baseUrl: rootBase(conn.base_url) });
    } catch (e: any) {
      sendJson(res, 200, { ok: false, engine: 'cloud', online: false, error: String(e?.message ?? e) });
    }
  });

  ctx.web.api('/plugins/voice/deploy/status', async (_req, res) => {
    try {
      sendJson(res, 200, await deployStatus());
    } catch (e: any) {
      sendJson(res, 400, { ok: false, error: String(e?.message ?? e) });
    }
  });

  ctx.web.api('/plugins/voice/deploy', async (_req, res) => {
    try {
      const result = await startDeploy();
      sendJson(res, 200, result);
    } catch (e: any) {
      sendJson(res, 400, { ok: false, error: String(e?.message ?? e) });
    }
  });

  ctx.web.api('/plugins/voice/deploy/update', async (_req, res) => {
    try {
      const result = await startDeploy('update');
      sendJson(res, 200, result);
    } catch (e: any) {
      sendJson(res, 400, { ok: false, error: String(e?.message ?? e) });
    }
  });

  ctx.web.api('/plugins/voice/deploy/cancel', async (_req, res) => {
    if (deployAbort) deployAbort.abort();
    sendJson(res, 200, { ok: true, running: Boolean(deployTask), cancelled: Boolean(deployAbort) });
  });

  ctx.logger.info('语音模块已加载：模型接入 + 共享配置（说话/唱歌在子插件）');
}
