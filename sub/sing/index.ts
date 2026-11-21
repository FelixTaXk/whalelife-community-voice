/*! 唱歌插件：Seed-VC 零样本歌声转换，把人声轨换成参考音色。作为语音模块的子插件安装。 */

import { basename, join, resolve } from 'node:path';
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import type { Context } from '../../../../core/context.ts';
import {
  BREEZE_ROOT, clampNumber, DATA_ROOT, esc, freeComfy, isInside, looksWav, normalize, runProcess, SING,
  speakFile, stamp, type Resolved,
} from './shared.ts';

const AUDIO_ROOT = join(DATA_ROOT, 'audio');
const GENERATED_DIR = join(AUDIO_ROOT, 'output');
const LEGACY_GENERATED_DIR = join(BREEZE_ROOT, 'output');
const GENERATED_DIRS = [GENERATED_DIR, LEGACY_GENERATED_DIR];
const DEFAULT_SING_TEXT = '你好，这是一段用来测试歌声转换的示例念白。';
const SONGS_DIR = join(DATA_ROOT, 'songs');
const SONG_ROOTS = [SONGS_DIR, join(SING.cwd, 'repo', 'examples', 'source')];

let pluginCtx: Context | null = null;
async function releaseVoiceBreeze() {
  const voice = pluginCtx ? (pluginCtx.get as any)('voice', false) : null;
  if (!voice?.stopBreeze) throw new Error('语音模块版本太旧，请先升级语音模块后再唱歌。');
  try {
    const cfg = voice.config ? await voice.config() : null;
    if (cfg && (cfg.engine !== 'local' || cfg.localMode !== 'breeze')) return { ok: true, skipped: true };
  } catch {
    /* 读不到配置时按旧行为尝试停一次 */
  }
  return voice.stopBreeze();
}

type GenJobLog = { t: number; msg: string };
type GenJob = {
  id: string;
  state: 'running' | 'done' | 'failed' | 'cancelled';
  stage: string;
  label: string;
  progress: number;
  started: number;
  updated: number;
  logs: GenJobLog[];
  result?: any;
  error?: string;
  controller: AbortController;
};

async function refNames() {
  try {
    return (await readdir(SING.refs))
      .filter((n) => /^[A-Za-z0-9._-]+\.wav$/i.test(n))
      .sort((a, b) => a.localeCompare(b, 'zh-CN'));
  } catch {
    return [];
  }
}

async function defaultRefName() {
  return (await refNames())[0] || '';
}

async function singRefPath(name?: string) {
  const n = String(name || await defaultRefName()).trim();
  if (!n) throw new Error('refs 目录里还没有 WAV 参考音，先放一段 10–30 秒的干净人声。');
  if (!/^[A-Za-z0-9._-]+\.wav$/i.test(n)) throw new Error('参考音文件名不合法。');
  const path = resolve(join(SING.refs, n));
  if (!isInside(SING.refs, path)) throw new Error('参考音不在 refs 目录里。');
  return { name: n, path };
}

async function singRefs() {
  const names = await refNames();
  const first = names[0] || '';
  return names.map((n) => ({ name: n, label: n.replace(/\.wav$/i, ''), default: n === first }));
}

async function generatedTracks() {
  const rows: any[] = [];
  for (const dir of GENERATED_DIRS) {
    try {
      const files = (await readdir(dir))
        .filter((n) => /\.wav$/i.test(n))
        .map(async (name) => {
          const path = join(dir, name);
          const info = await stat(path);
          return {
            name,
            path,
            bytes: info.size,
            mtime: info.mtimeMs,
            label: name.startsWith('vocal-')
              ? '念白 · ' + name.replace(/\.wav$/i, '')
              : (name.startsWith('upload-') ? '上传 · ' + name.replace(/\.wav$/i, '') : name.replace(/\.wav$/i, '')),
          };
        });
      rows.push(...await Promise.all(files));
    } catch {
      /* 目录还没建 */
    }
  }
  const seen = new Set<string>();
  return rows
    .sort((a, b) => b.mtime - a.mtime)
    .filter((row) => {
      if (seen.has(row.name)) return false;
      seen.add(row.name);
      return true;
    });
}

function prettySongName(name: string) {
  return name.replace(/\.(wav|mp3|m4a|flac|ogg)$/i, '')
    .replace(/\[vocals\]/gi, '')
    .replace(/_\s*\[cut_\d+(?:sec)?\]/gi, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*-\s*$/, '')
    .trim();
}

async function songTracks() {
  const rows: any[] = [];
  for (const root of SONG_ROOTS) {
    let names: string[] = [];
    try {
      names = (await readdir(root)).filter((n) => /\.(wav|mp3|m4a|flac|ogg)$/i.test(n));
    } catch {
      continue;
    }
    for (const name of names) {
      try {
        const path = join(root, name);
        const info = await stat(path);
        if (!info.isFile()) continue;
        rows.push({
          name, path, bytes: info.size, mtime: info.mtimeMs,
          label: (root === SONGS_DIR ? '曲目 · ' : '示例 · ') + prettySongName(name),
        });
      } catch {
        /* skip unreadable entry */
      }
    }
  }
  return rows.sort((a, b) => b.mtime - a.mtime);
}

async function singVoices(cfg: Resolved) {
  try {
    const names = (await readdir(cfg.voicesDir))
      .filter((n) => n.toLowerCase().endsWith('.breeze'))
      .sort((a, b) => a.localeCompare(b, 'zh-CN'));
    return names.map((n) => {
      const id = n.slice(0, -7);
      return { id, label: id, selected: id === cfg.voice };
    });
  } catch {
    return [];
  }
}

async function prepareSource(source: string, signal: AbortSignal) {
  const bytes = await readFile(source);
  if (looksWav(bytes)) return { path: source, temp: null as string | null };
  const token = `${stamp()}-${Math.random().toString(36).slice(2, 7)}`;
  const wav = join(SING.input, `song-${token}-norm.wav`);
  await mkdir(SING.input, { recursive: true });
  const conv = await runProcess(SING.ffmpeg, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', source, '-vn', '-ac', '1', '-ar', '44100', '-c:a', 'pcm_s16le', wav,
  ], { signal, timeout: 120_000 });
  if (conv.code !== 0) throw new Error(`曲目音频转 WAV 失败：${(conv.stderr || '').slice(-300)}`);
  const out = await readFile(wav);
  if (!looksWav(out)) throw new Error('曲目音频转换后不是有效 WAV。');
  return { path: wav, temp: wav };
}

async function runSeedVc(
  source: string,
  reference: string,
  options: { steps?: number; cfgRate?: number; pitch?: number },
  cfg: Resolved,
  signal: AbortSignal,
) {
  const prepared = await prepareSource(source, signal);
  try {
  const refStat = await stat(reference);
  if (refStat.size < 1024) throw new Error('参考音太小了，至少给 10 秒干净人声。');
  const steps = Math.floor(clampNumber(options.steps, 30, 10, 100));
  const cfgRate = clampNumber(options.cfgRate, 0.7, 0.1, 1.5);
  const pitch = Math.floor(clampNumber(options.pitch, 0, -24, 24));

  await freeComfy(cfg.comfyUrl);
  await releaseVoiceBreeze();
  await mkdir(SING.output, { recursive: true });

  const started = Date.now();
  const result = await runProcess(SING.python, [
    SING.runner,
    '--source', prepared.path,
    '--target', reference,
    '--output', SING.output,
    '--diffusion-steps', String(steps),
    '--length-adjust', '1.0',
    '--inference-cfg-rate', String(cfgRate),
    '--f0-condition', 'True',
    '--auto-f0-adjust', 'False',
    '--semi-tone-shift', String(pitch),
    '--fp16', 'True',
  ], {
    cwd: SING.cwd,
    signal,
    timeout: 15 * 60_000,
    env: {
      ...process.env,
      PYTHONPATH: SING.comfySite,
      HF_HUB_OFFLINE: '1',
      TRANSFORMERS_OFFLINE: '1',
      HF_ENDPOINT: 'https://huggingface.co',
      PYTHONIOENCODING: 'utf-8',
    },
  });

  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout || '').trim().slice(-700);
    throw new Error(`Seed-VC 失败（退出码 ${result.code}）：${detail || '没有输出'}`);
  }
  const saved = result.stdout.match(/Saved:\s*(.+\.wav)\s*$/m);
  if (!saved) throw new Error('Seed-VC 跑完了，但没找到输出文件。');
  const file = saved[1].trim();
  const bytes = await readFile(file);
  if (bytes.length < 1024 || !looksWav(bytes)) throw new Error('Seed-VC 输出不是有效 WAV。');
  return { file, bytes, steps, cfgRate, pitch, elapsedMs: Date.now() - started, ref: basename(reference) };
  } finally {
    if (prepared.temp) await unlink(prepared.temp).catch(() => undefined);
  }
}

async function singBuffer(
  cfg: Resolved,
  buffer: Buffer,
  filename: string,
  options: { ref?: string; steps?: number; cfgRate?: number; pitch?: number },
  signal: AbortSignal,
) {
  if (buffer.length < 1024) throw new Error('上传的音频太小了。');
  if (buffer.length > 60 * 1024 * 1024) throw new Error('音频太大，先剪到 3 分钟以内。');
  const ext = (String(filename || 'wav').split('.').pop() || 'wav').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5) || 'wav';
  await mkdir(SING.input, { recursive: true });
  const token = `${stamp()}-${Math.random().toString(36).slice(2, 7)}`;
  const input = join(SING.input, `source-${token}.${ext}`);
  const wav = join(SING.input, `source-${token}-norm.wav`);
  await writeFile(input, buffer);
  try {
    const conv = await runProcess(SING.ffmpeg, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', input, '-vn', '-ac', '1', '-ar', '44100', '-c:a', 'pcm_s16le', wav,
    ], { signal, timeout: 120_000 });
    if (conv.code !== 0) throw new Error(`音频转 WAV 失败：${(conv.stderr || '').slice(-300)}`);
    const ref = await singRefPath(options.ref);
    const result = await runSeedVc(wav, ref.path, options, cfg, signal);
    return { ...result, source: wav, refName: ref.name };
  } finally {
    await unlink(input).catch(() => undefined);
  }
}

async function generateVocal(
  ctx: Context,
  cfg: Resolved,
  text: string,
  voice: string | undefined,
  signal: AbortSignal,
  onStage?: (stage: string, label: string, progress: number, msg: string) => void,
) {
  const voiceApi = (ctx.get as any)('voice', false);
  if (!voiceApi?.synthesize) throw new Error('语音模块没准备好，生成不了人声轨。');
  onStage?.('synth', '语音合成中', 35, '正在调用语音模块生成人声轨，首次使用或服务没起来时可能要等它加载模型…');
  const result = await voiceApi.synthesize({ text, voice }, { signal });
  const bytes = Buffer.from(String(result?.base64 ?? ''), 'base64');
  if (bytes.length < 44) throw new Error('语音模块没有返回有效音频。');
  if (signal.aborted) throw new Error('已取消');
  onStage?.('write', '写入人声轨', 82, `语音模块已返回 ${Math.round(bytes.length / 1024)} KB，正在写入人声轨目录…`);
  await mkdir(GENERATED_DIR, { recursive: true });
  const file = join(GENERATED_DIR, `vocal-${stamp()}-${Math.random().toString(36).slice(2, 6)}.wav`);
  await writeFile(file, bytes);
  onStage?.('write', '写入人声轨', 92, `已写入 ${basename(file)}，准备刷新列表…`);
  return {
    file,
    path: file,
    name: basename(file),
    bytes: bytes.length,
    voice: String(result?.voice ?? voice ?? ''),
    engine: String(result?.engine ?? 'local'),
  };
}

async function saveUploadedTrack(buffer: Buffer, filename: string, signal: AbortSignal) {
  if (buffer.length < 1024) throw new Error('上传的音频太小了。');
  if (buffer.length > 60 * 1024 * 1024) throw new Error('音频太大，先剪到 3 分钟以内。');
  const ext = (basename(String(filename || 'audio.wav')).split('.').pop() || 'wav')
    .toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5) || 'wav';
  const token = `${stamp()}-${Math.random().toString(36).slice(2, 7)}`;
  await mkdir(SING.input, { recursive: true });
  await mkdir(GENERATED_DIR, { recursive: true });
  const temp = join(SING.input, `import-${token}.${ext}`);
  const file = join(GENERATED_DIR, `upload-${token}.wav`);
  let ok = false;
  try {
    await writeFile(temp, buffer);
    const conv = await runProcess(SING.ffmpeg, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', temp, '-vn', '-ac', '1', '-ar', '44100', '-c:a', 'pcm_s16le', file,
    ], { signal, timeout: 120_000 });
    if (conv.code !== 0) throw new Error(`音频转 WAV 失败：${(conv.stderr || '').slice(-300)}`);
    const bytes = await readFile(file);
    if (bytes.length < 1024 || !looksWav(bytes)) throw new Error('上传的音频转换后不是有效 WAV。');
    ok = true;
    return { file, path: file, name: basename(file), bytes: bytes.length, engine: 'upload' };
  } finally {
    await unlink(temp).catch(() => undefined);
    if (!ok) await unlink(file).catch(() => undefined);
  }
}

async function sendSingToGroup(ctx: Context, groupId: string, bytes: Buffer, signal: AbortSignal) {
  if (!/^\d{5,12}$/.test(groupId)) throw new Error('群号不合法。');
  if (bytes.length > 25 * 1024 * 1024) throw new Error('语音太大，QQ 单条最多 25 MiB。');
  const qq = (ctx.get as any)('qq', false);
  if (!qq?.sendGroupMedia) throw new Error('QQ 插件没接上，这条歌唱语音发不出去。');
  return qq.sendGroupMedia({
    groupId,
    parts: [{ type: 'voice', mime: 'audio/wav', base64: bytes.toString('base64') }],
  }, { signal });
}

let singQueue: Promise<unknown> = Promise.resolve();
function enqueueSing<T>(task: () => Promise<T>): Promise<T> {
  const next = singQueue.then(task, task);
  singQueue = next.then(() => undefined, () => undefined);
  return next;
}

export function apply(ctx: Context) {
  pluginCtx = ctx;
  const voice = () => (ctx.get as any)('voice');
  const readCfg = async (): Promise<Resolved> => normalize(await voice().config());

  ctx.tools.register({
    name: 'voice_sing',
    description:
      '用 Seed-VC 把一段现成人声轨唱成参考音色（第一期零样本歌声转换）。' +
      'sourcePath 是已经分离好的人声 WAV 绝对路径，不是整首歌；整首带伴奏的音频要先分离人声。' +
      'ref 是参考音文件名，留空使用 refs 目录里第一个 WAV。' +
      '可选 groupId：唱完直接作为群语音发到白名单群。第一次跑会加载模型，约半分钟到一分钟。',
    danger: 'ask',
    schema: {
      type: 'object',
      properties: {
        sourcePath: { type: 'string', minLength: 1, description: '现成人声轨的 WAV 绝对路径。' },
        ref: { type: 'string', description: '参考音文件名；留空用 refs 目录里第一个 WAV。' },
        steps: { type: 'number', description: '扩散步数，默认 30；越高越慢。' },
        cfgRate: { type: 'number', description: '相似度 CFG，默认 0.7。' },
        pitch: { type: 'number', description: '升降调半音，默认 0。' },
        groupId: { type: 'string', description: '可选；唱完直接发到这个 QQ 群。' },
        play: { type: 'boolean', description: '是否在这台电脑上播放，默认 false。' },
      },
      required: ['sourcePath'],
      additionalProperties: false,
    },
    async run(args: any, session) {
      const cfg = await readCfg();
      const signal = session.signal ?? ctx.signal;
      const source = String(args.sourcePath ?? '').trim();
      if (!source) return { status: 'error', error: '没有源人声轨。' };
      try {
        const ref = await singRefPath(args.ref);
        await stat(ref.path);
        const result = await enqueueSing(() => runSeedVc(
          resolve(source),
          ref.path,
          { steps: args.steps, cfgRate: args.cfgRate, pitch: args.pitch },
          cfg,
          signal,
        ));
        if (args.play === true) await speakFile(result.file, cfg);
        let sent: any = null;
        if (args.groupId) sent = await sendSingToGroup(ctx, String(args.groupId), result.bytes, signal);
        return {
          status: 'ok', file: result.file, bytes: result.bytes.length,
          seconds: Math.round(result.elapsedMs / 1000), ref: result.ref,
          steps: result.steps, cfgRate: result.cfgRate, pitch: result.pitch,
          played: args.play === true, sent,
        };
      } catch (e: any) {
        return { status: 'error', error: String(e?.message ?? e) };
      }
    },
  });

  ctx.provide('voice/sing', {
    apiVersion: '1.0.0',
    refs: singRefs,
    sing: async (input: { sourcePath: string; ref?: string; steps?: number; cfgRate?: number; pitch?: number }, options?: { signal?: AbortSignal }) => {
      const cfg = await readCfg();
      const source = String(input?.sourcePath ?? '').trim();
      if (!source) throw new Error('没有源人声轨。');
      const ref = await singRefPath(input?.ref);
      await stat(ref.path);
      const result = await enqueueSing(() => runSeedVc(resolve(source), ref.path, input ?? {}, cfg, options?.signal ?? ctx.signal));
      return {
        mime: 'audio/wav', base64: result.bytes.toString('base64'), bytes: result.bytes.length,
        file: result.file, ref: result.ref, elapsedMs: result.elapsedMs,
        steps: result.steps, cfgRate: result.cfgRate, pitch: result.pitch,
      };
    },
  });

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

  const genJobs = new Map<string, GenJob>();
  const stageLabels: Record<string, string> = {
    queue: '排队中', prepare: '准备中', synth: '语音合成中', write: '写入人声轨',
    done: '完成', failed: '失败', cancelled: '已取消',
  };
  const cleanGenJobs = () => {
    const now = Date.now();
    for (const [id, job] of genJobs) {
      if (job.state !== 'running' && now - job.updated > 30 * 60_000) genJobs.delete(id);
    }
  };
  const pushGenJob = (job: GenJob, stage: string, label: string, progress: number, msg: string) => {
    job.stage = stage;
    job.label = label || stageLabels[stage] || stage;
    job.progress = Math.max(0, Math.min(100, Math.round(progress)));
    job.logs.push({ t: Math.max(0, Date.now() - job.started), msg });
    if (job.logs.length > 40) job.logs.splice(0, job.logs.length - 40);
    job.updated = Date.now();
  };
  const genJobView = (job: GenJob) => ({
    id: job.id, state: job.state, stage: job.stage, label: job.label, progress: job.progress,
    elapsedMs: Date.now() - job.started, logs: job.logs, result: job.result, error: job.error,
    dir: GENERATED_DIR,
  });
  const runGenJob = (job: GenJob, cfg: Resolved, text: string, chosen: string) => {
    const timer = setTimeout(() => job.controller.abort(new Error('生成超时（5 分钟）')), 5 * 60_000);
    const onCtxAbort = () => job.controller.abort(new Error('插件已停止'));
    ctx.signal.addEventListener('abort', onCtxAbort, { once: true });
    void (async () => {
      try {
        const result = await enqueueSing(() => generateVocal(
          ctx, cfg, text, chosen, job.controller.signal,
          (stage, label, progress, msg) => pushGenJob(job, stage, label, progress, msg),
        ));
        if (job.state !== 'running') return;
        const files = await generatedTracks();
        job.result = { ...result, files };
        job.state = 'done';
        pushGenJob(job, 'done', '完成', 100, `已生成 ${result.name}（${Math.round(result.bytes / 1024)} KB），音色 ${result.voice || '默认'}。`);
        ctx.logger.info(`唱歌人声轨生成完成：${result.path}`);
      } catch (e: any) {
        if (job.state === 'cancelled') {
          pushGenJob(job, 'cancelled', '已取消', job.progress, '已取消生成。');
          return;
        }
        job.state = 'failed';
        job.error = String(e?.message ?? e);
        pushGenJob(job, 'failed', '失败', 100, `生成失败：${job.error}`);
        ctx.logger.warn(`唱歌人声轨生成失败：${job.error}`);
      } finally {
        clearTimeout(timer);
        ctx.signal.removeEventListener('abort', onCtxAbort);
        job.updated = Date.now();
      }
    })();
  };

  ctx.web.page('/plugins/voice/sing/settings', async (_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>唱歌 · WhaleLife</title>
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
label{display:grid;gap:6px;font-size:13px;color:var(--muted)}
input,select,textarea{font:inherit;padding:9px 12px;border:1px solid var(--line);border-radius:7px;background:var(--paper);color:var(--ink);width:100%}
textarea{min-height:92px;resize:vertical}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px 18px;margin-top:12px}
.wide{grid-column:1/-1}
.row{display:flex;gap:10px;align-items:center;margin-top:18px;flex-wrap:wrap}
.row.tight{margin-top:10px}
.seg{display:flex;gap:8px;margin:14px 0 4px;flex-wrap:wrap}
.seg button{flex:1;min-width:180px;padding:10px;border-radius:9px}
.seg button.on{background:var(--accent);border-color:var(--accent);color:#fff}
button{font:inherit;padding:9px 14px;border:1px solid var(--line);border-radius:7px;background:var(--paper);color:var(--ink);cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
button:disabled{opacity:.55;cursor:default}
.pill{font-size:12px;padding:2px 10px;border-radius:99px;border:1px solid var(--line);color:var(--muted)}
.hint{color:var(--muted);font-size:12px;margin:10px 0 0}
.warn{color:#b23a3a}
.link{color:var(--accent);font-size:13px;text-decoration:none}
.genBlock{margin-top:16px;padding-top:14px;border-top:1px solid var(--line)}
.genProgress{margin-top:14px;padding:12px;border:1px solid var(--line);border-radius:10px;background:var(--soft)}
.genBar{height:10px;border-radius:99px;background:var(--paper);border:1px solid var(--line);overflow:hidden}
.genBar i{display:block;height:100%;width:2%;background:var(--accent);transition:width .3s ease}
.genMeta{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:8px;font-size:12px;color:var(--muted)}
.genLog{margin:8px 0 0;min-height:0;max-height:150px;overflow:auto;font-size:11px;line-height:1.55}
pre{background:var(--soft);border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin:16px 0 0;white-space:pre-wrap;font-size:12px;color:var(--muted);min-height:18px}
@media (max-width:640px){.grid{grid-template-columns:1fr}body{padding:20px 16px 28px}h1{font-size:23px}header{flex-direction:column}.seg{flex-direction:column}.seg button{min-width:0}}
</style></head><body><main>
<header><div><h1>唱歌</h1><p class="sub">Seed-VC 零样本歌声转换 · 第一期只换音色</p></div><div style="display:flex;gap:8px;align-items:center"><span class="pill" id="singState">Seed-VC</span><a class="link" href="/plugins/voice/settings" data-console-href="#plugin:voice">← 语音模块</a></div></header>

<section class="card" id="startCard">
  <div class="card-head"><h2>开始唱</h2><span class="pill" id="singVoiceState">检查音色中…</span></div>
  <p class="sub">先从「曲目库」选一首带旋律的歌，再选参考音色；点「开始唱」。想用语音模块念白或本地文件，再切到下面两个页签。</p>
  <p class="hint warn" id="singVoiceHint"></p>
  <div class="seg" id="singSource"><button type="button" data-source="song" class="on">曲目库</button><button type="button" data-source="generated">用语音模块念白</button><button type="button" data-source="upload">上传本地人声</button></div>

  <div id="songBox">
    <div class="grid"><label class="wide">选择曲目<select id="singSong"><option value="">载入中…</option></select></label></div>
    <div class="row tight"><button type="button" id="singRefreshSongs">刷新曲目库</button></div>
    <p class="hint">曲目库读取 <code>data/songs</code> 和 Seed-VC 自带示例；把已经分离好的歌曲人声放进去就能选。支持 WAV/MP3/M4A/FLAC/OGG，非 WAV 会先转成 WAV。曲目本身必须带旋律，Seed-VC 才能唱出歌。</p>
  </div>

  <div id="generatedBox" hidden>
    <div class="grid"><label class="wide">生成或已有的人声轨<select id="singGenerated"><option value="">载入中…</option></select></label></div>
    <div class="row tight"><button type="button" id="singRefreshGenerated">刷新列表</button><button type="button" id="goVoice">去生成音色</button></div>
    <div class="grid" style="margin-top:14px"><label class="wide">也可以上传本地文件到人声轨目录（WAV / MP3 / M4A / FLAC）<input type="file" id="singBreezeFile" accept="audio/*,.wav,.mp3,.m4a,.flac,.ogg"></label></div>
    <div class="row tight"><button type="button" id="singUploadBreeze">上传到人声轨目录</button></div>
    <p class="hint">默认读取语音模块的 <code>data/audio/output</code>；旧版 <code>data/breeze/output</code> 也会列出。浏览器文件框不能指定默认目录，所以这里直接列目录，避免每次弹到别处。上传的文件会转成 44.1 kHz 单声道 WAV 并加入这个列表。</p>
    <div class="genBlock" id="generateCard">
      <div class="card-head"><h3>生成念白人声轨</h3><span class="pill" id="singVoicePill">—</span></div>
      <p class="sub">语音模块只会把歌词或文本“念”成 WAV，不会作曲或生成旋律；它生成的是念白，不是带旋律的歌声。</p>
      <div class="grid">
        <label>生成音色<select id="singVoice"><option value="">载入中…</option></select></label>
        <label class="wide">歌词或文本<textarea id="singText" maxlength="400" placeholder="${esc(DEFAULT_SING_TEXT)}">${esc(DEFAULT_SING_TEXT)}</textarea></label>
      </div>
      <div class="row"><button class="primary" type="button" id="singGenerate">一键生成人声轨</button><button type="button" id="singGenCancel" hidden>取消生成</button></div>
      <div class="genProgress" id="singGenProgress" hidden>
        <div class="genBar"><i id="singGenBar"></i></div>
        <div class="genMeta"><span id="singGenStage">准备中…</span><span id="singGenElapsed">0.0s</span></div>
        <pre class="genLog" id="singGenLog"></pre>
      </div>
      <p class="hint">歌词或文本不是必填，已经预填一段默认文本；清空后会继续使用这段默认文本。生成后会自动选中这条人声轨；音色库为空时点生成会跳到「说话 · 生成音色」。</p>
    </div>
  </div>

  <div id="uploadBox" hidden>
    <div class="grid"><label class="wide">本地人声轨（WAV / MP3 / M4A）<input type="file" id="singFile" accept="audio/*,.wav,.mp3,.m4a,.flac,.ogg"></label></div>
    <p class="hint">上传本地人声不依赖音色库；要真正“唱”出旋律，请上传本身带旋律的歌曲人声轨，整首带伴奏的音频要先分离人声。一键生成的是念白，不能代替歌曲人声轨。</p>
  </div>

  <div class="grid" style="margin-top:18px">
    <label>参考音色<select id="singRef"><option value="">载入中…</option></select></label>
    <label>扩散步数<input type="number" id="singSteps" value="30" min="10" max="100"></label>
    <label>相似度 CFG<input type="number" id="singCfg" value="0.7" min="0.1" max="1.5" step="0.05"></label>
    <label>升降调（半音）<input type="number" id="singPitch" value="0" min="-24" max="24"></label>
  </div>
  <div class="row"><button class="primary" type="button" id="singGo">开始唱</button><button type="button" id="singRefreshRefs">刷新参考音</button></div>
  <audio id="singAudio" controls hidden style="width:100%;max-width:520px;margin-top:10px"></audio>
  <div class="row tight"><select id="singGroup" style="max-width:260px"><option value="">选择群聊…</option></select><button type="button" id="singSend">发到群聊</button></div>
  <p class="hint">第一次跑会加载模型，约半分钟到一分钟；唱歌时会临时停掉 Breeze（如果当前用的是 Breeze），下一句说话会自动拉起。注意：源轨必须本身带旋律；如果源是念白，这里只会把念白换成参考音色，不会自动唱出歌。</p>
</section>
<pre id="out"></pre>
</main>
<script>
const $ = function (id) { return document.getElementById(id); };
const out = function (v) { $('out').textContent = (typeof v === 'string') ? v : JSON.stringify(v, null, 2); };
const h = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); };
const DEFAULT_SING_TEXT = ${JSON.stringify(DEFAULT_SING_TEXT)};
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
let singCtx = null, singNode = null, lastSing = null;
let singSourceMode = 'song';
let generatedFiles = [];
let singVoiceList = [];
let songFiles = [];
function paintSourceMode() {
  $('generatedBox').hidden = singSourceMode !== 'generated';
  $('uploadBox').hidden = singSourceMode !== 'upload';
  $('songBox').hidden = singSourceMode !== 'song';
  $('generateCard').hidden = singSourceMode !== 'generated';
  Array.prototype.forEach.call(document.querySelectorAll('#singSource button'), function (b) {
    b.classList.toggle('on', b.dataset.source === singSourceMode);
  });
}
function goCreateVoice(reason) {
  out(reason || '音色库为空，先去生成一个音色，或改用上传本地人声。');
  try {
    if (window.top !== window.self) {
      window.top.sessionStorage.setItem('whalelife:voice-focus', 'genCard');
      window.top.location.hash = '#plugin:voice/speak';
    } else {
      location.href = '/plugins/voice/speak/settings#genCard';
    }
  } catch (e) {
    location.href = '/plugins/voice/speak/settings#genCard';
  }
}
function paintVoices() {
  var n = singVoiceList.length;
  $('singVoiceState').textContent = '音色 ' + n + ' 个';
  $('singVoicePill').textContent = n ? '音色已就绪' : '音色库为空';
  $('singVoiceHint').textContent = n ? '' : '音色库为空：生成人声轨前先创建音色，或切换到“上传本地人声”。';
  var sel = $('singVoice');
  if (!n) {
    sel.innerHTML = '<option value="">音色库为空</option>';
  } else {
    sel.innerHTML = singVoiceList.map(function (v) {
      return '<option value="' + h(v.id) + '"' + (v.selected ? ' selected' : '') + '>' + h(v.label) + '</option>';
    }).join('');
  }
}
async function loadGenerated(selectPath) {
  const sel = $('singGenerated');
  const j = await post('/plugins/voice/sing/generated', {});
  if (!j.ok) {
    sel.innerHTML = '<option value="">人声轨读取失败</option>';
    out(j.error || '人声轨读取失败');
    return;
  }
  generatedFiles = j.files || [];
  singVoiceList = j.voices || [];
  paintVoices();
  if (!generatedFiles.length) {
    sel.innerHTML = '<option value="">还没有生成的人声轨</option>';
    return;
  }
  sel.innerHTML = generatedFiles.map(function (f) {
    return '<option value="' + h(f.path) + '">' + h(f.label) + ' · ' + Math.round(f.bytes / 1024) + ' KB</option>';
  }).join('');
  if (selectPath) sel.value = selectPath;
  if (!sel.value) sel.selectedIndex = 0;
}

async function loadSongs() {
  const sel = $('singSong');
  const j = await post('/plugins/voice/sing/songs', {});
  if (!j.ok) {
    sel.innerHTML = '<option value="">曲目库读取失败</option>';
    out(j.error || '曲目库读取失败');
    return;
  }
  songFiles = j.songs || [];
  if (!songFiles.length) {
    sel.innerHTML = '<option value="">曲目库还是空的</option>';
    return;
  }
  sel.innerHTML = songFiles.map(function (f) {
    return '<option value="' + h(f.path) + '">' + h(f.label) + ' · ' + Math.round(f.bytes / 1024) + ' KB</option>';
  }).join('');
  if (!sel.value) sel.selectedIndex = 0;
}

function singUnlock() {
  try {
    singCtx = singCtx || new (window.AudioContext || window.webkitAudioContext)();
    singCtx.resume().catch(function () {});
    return singCtx;
  } catch (e) { return null; }
}
async function loadSingRefs() {
  const j = await post('/plugins/voice/sing/refs', {});
  const sel = $('singRef');
  if (!j.ok) { sel.innerHTML = '<option value="">参考音读取失败</option>'; return; }
  const refs = j.refs || [];
  if (!refs.length) { sel.innerHTML = '<option value="">refs 目录里没有 WAV</option>'; return; }
  sel.innerHTML = refs.map(function (v) {
    return '<option value="' + h(v.name) + '"' + (v.default ? ' selected' : '') + '>' + h(v.label) + (v.default ? '（默认）' : '') + '</option>';
  }).join('');
}
async function loadSingGroups() {
  const sel = $('singGroup');
  try {
    const r = await fetch('/plugins/qq/group/groups');
    const j = await r.json();
    const groups = (j && j.groups) || [];
    if (!groups.length) { sel.innerHTML = '<option value="">没有可发的群</option>'; return; }
    sel.innerHTML = '<option value="">选择群聊…</option>' + groups.map(function (g) {
      const id = g.groupId || g.id || '';
      const name = g.name || id;
      return '<option value="' + h(id) + '">' + h(name) + '（' + h(id) + '）</option>';
    }).join('');
  } catch (e) {
    sel.innerHTML = '<option value="">群列表读取失败</option>';
  }
}
function singFileB64(file) {
  return new Promise(function (resolve) {
    const fr = new FileReader();
    fr.onload = function () { resolve(String(fr.result).split(',')[1] || ''); };
    fr.readAsDataURL(file);
  });
}
let genClock = null;
let genLogSeen = 0;
let currentGenId = '';
function appendGenLog(line) {
  const box = $('singGenLog');
  const text = String(line || '');
  box.textContent = box.textContent ? (box.textContent + '\\n' + text) : text;
  box.scrollTop = box.scrollHeight;
}
function paintGenJob(j) {
  const pct = Math.max(2, Math.min(100, Number(j.progress) || 2));
  $('singGenBar').style.width = pct + '%';
  $('singGenStage').textContent = j.label || j.stage || '生成中…';
  $('singGenElapsed').textContent = ((Number(j.elapsedMs) || 0) / 1000).toFixed(1) + 's';
  const logs = j.logs || [];
  for (let i = genLogSeen; i < logs.length; i++) {
    const t = (Number(logs[i].t) || 0) / 1000;
    appendGenLog('[+' + t.toFixed(1) + 's] ' + logs[i].msg);
  }
  genLogSeen = logs.length;
}
function startGenProgress() {
  $('singGenProgress').hidden = false;
  $('singGenLog').textContent = '';
  genLogSeen = 0;
  currentGenId = '';
  $('singGenBar').style.width = '2%';
  $('singGenStage').textContent = '提交生成请求…';
  $('singGenElapsed').textContent = '0.0s';
  $('singGenCancel').hidden = false;
  const started = Date.now();
  if (genClock) clearInterval(genClock);
  genClock = setInterval(function () {
    $('singGenElapsed').textContent = ((Date.now() - started) / 1000).toFixed(1) + 's';
  }, 300);
}
function stopGenProgress() {
  if (genClock) { clearInterval(genClock); genClock = null; }
  $('singGenCancel').hidden = true;
  currentGenId = '';
}
async function playSing(audio, mime) {
  const au = $('singAudio');
  au.hidden = false;
  au.src = 'data:' + (mime || 'audio/wav') + ';base64,' + audio;
  const ac = singCtx;
  if (!ac || ac.state !== 'running') return false;
  try {
    const bin = atob(audio);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const buf = await ac.decodeAudioData(bytes.buffer);
    if (singNode) { try { singNode.stop(); } catch (e) {} }
    singNode = ac.createBufferSource();
    singNode.buffer = buf;
    singNode.connect(ac.destination);
    singNode.start();
    return true;
  } catch (e) { return false; }
}
$('singRefreshRefs').onclick = function () { loadSingRefs(); out('已刷新参考音列表。'); };
Array.prototype.forEach.call(document.querySelectorAll('#singSource button'), function (b) {
  b.onclick = function () {
    const mode = b.dataset.source;
    singSourceMode = (mode === 'upload' || mode === 'song') ? mode : 'generated';
    lastSing = null;
    paintSourceMode();
    if (singSourceMode === 'song' && !songFiles.length) loadSongs();
  };
});
$('singRefreshGenerated').onclick = async function () { await loadGenerated(); out('已刷新人声轨列表。'); };
$('singRefreshSongs').onclick = async function () { await loadSongs(); out('已刷新曲目库。'); };
$('goVoice').onclick = function () { goCreateVoice('去「说话 · 生成音色」创建一个音色。'); };
$('singUploadBreeze').onclick = async function () {
  const input = $('singBreezeFile');
  const file = input.files[0];
  if (!file) { out('先选择一个本地音频文件。'); return; }
  const btn = $('singUploadBreeze');
  btn.disabled = true;
  out('正在上传并转换：' + file.name + '…');
  try {
    const b64 = await singFileB64(file);
    const r = await post('/plugins/voice/sing/upload', { base64: b64, filename: file.name });
    if (!r.ok) { out('上传失败：' + (r.error || '未知错误')); return; }
    await loadGenerated(r.path);
    singSourceMode = 'generated';
    paintSourceMode();
    out('已上传并选中：' + r.path + '（' + Math.round(r.bytes / 1024) + ' KB）');
    input.value = '';
  } catch (e) {
    out('上传失败：' + (e && e.message ? e.message : e));
  } finally {
    btn.disabled = false;
  }
};
$('singGenCancel').onclick = async function () {
  if (!currentGenId) return;
  $('singGenCancel').disabled = true;
  out('正在取消生成…');
  try {
    const r = await post('/plugins/voice/sing/generate/cancel', { id: currentGenId });
    if (r.job) paintGenJob(r.job);
    if (!r.ok) out(r.error || '取消失败');
  } catch (e) {
    out('取消失败：' + (e && e.message ? e.message : e));
  }
};
$('singGenerate').onclick = async function () {
  let text = $('singText').value.trim();
  if (!text) {
    text = DEFAULT_SING_TEXT;
    $('singText').value = text;
    out('没有输入歌词或文本，已使用默认文本。');
  }
  if (!singVoiceList.length) { goCreateVoice('音色库为空，先生成一个音色再生成人声轨。'); return; }
  const btn = $('singGenerate');
  btn.disabled = true;
  $('singState').textContent = '生成人声轨';
  startGenProgress();
  out('已提交生成请求，正在等待语音模块输出人声轨…');
  try {
    const r = await post('/plugins/voice/sing/generate/start', {
      text: text,
      voice: $('singVoice').value
    });
    let jobId = String(r.id || '');
    if (!r.ok) {
      if (r.code === 'no_voices') { $('singGenProgress').hidden = true; goCreateVoice(r.error); return; }
      if (r.code === 'busy' && r.job) {
        jobId = r.job.id;
        out('检测到已有一条人声轨正在生成，正在接管这个任务的进度…');
      } else {
        if (r.job) paintGenJob(r.job);
        $('singGenStage').textContent = '提交失败';
        appendGenLog(r.error || '生成请求失败');
        out(r.error || '生成人声轨失败');
        return;
      }
    }
    currentGenId = jobId;
    if (r.job) paintGenJob(r.job);
    const started = Date.now();
    while (true) {
      await new Promise(function (resolve) { setTimeout(resolve, 600); });
      if (Date.now() - started > 5 * 60_000 + 10_000) {
        appendGenLog('等待超过 5 分钟，先停止轮询；任务可能仍在后台运行，可以刷新列表看看。');
        out('等待超时，先停止轮询。');
        break;
      }
      const st = await post('/plugins/voice/sing/generate/status', { id: currentGenId });
      if (!st.ok) {
        appendGenLog(st.error || '读取生成状态失败');
        out(st.error || '读取生成状态失败');
        break;
      }
      const job = st.job;
      paintGenJob(job);
      if (job.state === 'done') {
        const result = job.result || {};
        if (result.path) await loadGenerated(result.path);
        singSourceMode = 'generated';
        paintSourceMode();
        out('已生成并选中：' + result.path + '（' + Math.round((result.bytes || 0) / 1024) + ' KB，音色 ' + (result.voice || '默认') + '）');
        break;
      }
      if (job.state === 'failed' || job.state === 'cancelled') {
        out(job.error || (job.state === 'cancelled' ? '已取消生成。' : '生成人声轨失败。'));
        break;
      }
    }
  } catch (e) {
    appendGenLog('请求异常：' + (e && e.message ? e.message : e));
    out('生成人声轨失败：' + (e && e.message ? e.message : e));
  } finally {
    stopGenProgress();
    btn.disabled = false;
    $('singState').textContent = 'Seed-VC';
  }
};
$('singGo').onclick = async function () {
  singUnlock();
  lastSing = null;
  const btn = $('singGo');
  btn.disabled = true;
  $('singState').textContent = '转换中';
  try {
    const options = {
      ref: $('singRef').value,
      steps: Number($('singSteps').value) || 30,
      cfgRate: Number($('singCfg').value) || 0.7,
      pitch: Number($('singPitch').value) || 0
    };
    let body;
    let sourceNote = '';
    if (singSourceMode === 'generated') {
      const sourcePath = $('singGenerated').value;
      if (!sourcePath) { out('先选一条生成的人声轨，或切换为上传本地人声。'); return; }
      const sourceName = sourcePath.split(/[\\\\/]/).pop() || '';
      if (sourceName.indexOf('vocal-') === 0) sourceNote = '注意：当前源是念白，不带旋律，转换后只会换音色、不会唱歌。';
      out('用生成的 ' + sourcePath + ' 转换中…');
      body = Object.assign({ sourcePath: sourcePath }, options);
    } else if (singSourceMode === 'song') {
      const sourcePath = $('singSong').value;
      if (!sourcePath) { out('先选一个曲目；曲目库里没有歌的话，把歌曲人声放到 data/songs 再刷新。'); return; }
      out('用曲目 ' + sourcePath + ' 转换中…');
      body = Object.assign({ sourcePath: sourcePath }, options);
    } else {
      const file = $('singFile').files[0];
      if (!file) { out('先选一首本地人声轨。'); return; }
      if (/ref/i.test(file.name)) sourceNote = '注意：这个文件名看起来像参考音，不是歌曲人声轨。';
      out('上传并转 WAV 中…');
      const b64 = await singFileB64(file);
      body = Object.assign({ base64: b64, filename: file.name }, options);
    }
    out((sourceNote ? sourceNote + ' ' : '') + 'Seed-VC 转换中…第一次会加载模型，请等半分钟到一分钟。');
    const r = await post('/plugins/voice/sing/convert', body);
    if (!r.ok) { out(r.error || '唱歌失败'); return; }
    lastSing = r;
    const played = await playSing(r.audio, r.mime);
    out((played ? '正在播放：' : '唱好了，点播放器播放：') + '参考音 ' + (r.refName || r.ref) + '，用时 ' + r.seconds + ' 秒，' + Math.round(r.bytes / 1024) + ' KB');
  } catch (e) {
    out('唱歌失败：' + (e && e.message ? e.message : e));
  } finally {
    btn.disabled = false;
    $('singState').textContent = 'Seed-VC';
  }
};
$('singSend').onclick = async function () {
  if (!lastSing || !lastSing.audio) { out('先唱一首，再发群。'); return; }
  const groupId = $('singGroup').value;
  if (!groupId) { out('先选一个群。'); return; }
  const btn = $('singSend');
  btn.disabled = true;
  out('发送到群 ' + groupId + '…');
  try {
    const r = await post('/plugins/voice/sing/send', { base64: lastSing.audio, groupId: groupId });
    out(r);
  } finally { btn.disabled = false; }
};
paintSourceMode();
loadSingRefs();
loadSingGroups();
loadSongs();
loadGenerated();
</script></body></html>`);
  }, { title: '唱歌设置', settings: true, navigation: true });

  ctx.web.api('/plugins/voice/sing/generated', async (_req, res) => {
    const cfg = await readCfg();
    sendJson(res, 200, {
      ok: true,
      dir: GENERATED_DIR,
      files: await generatedTracks(),
      voices: await singVoices(cfg),
    });
  });

  ctx.web.api('/plugins/voice/sing/songs', async (_req, res) => {
    sendJson(res, 200, {
      ok: true,
      dirs: SONG_ROOTS,
      mainDir: SONGS_DIR,
      songs: await songTracks(),
    });
  });

  ctx.web.api('/plugins/voice/sing/generate/start', async (req, res, { signal }) => {
    try {
      const body = await readJson(req, signal);
      const text = String(body?.text ?? '').trim() || DEFAULT_SING_TEXT;
      const cfg = await readCfg();
      if (Array.from(text).length > cfg.maxChars) throw new Error(`超过 ${cfg.maxChars} 字上限。`);
      const voices = await singVoices(cfg);
      if (!voices.length) {
        sendJson(res, 409, { ok: false, code: 'no_voices', error: '音色库为空，先生成一个音色，或改用上传本地人声。' });
        return;
      }
      const chosen = String(body?.voice ?? '').trim() || cfg.voice;
      if (!voices.some((v) => v.id === chosen)) throw new Error(`音色库里没有 ${chosen}。`);
      cleanGenJobs();
      const running = Array.from(genJobs.values()).find((j) => j.state === 'running');
      if (running) {
        sendJson(res, 409, { ok: false, code: 'busy', error: '已有一条人声轨正在生成，等它完成或先取消。', job: genJobView(running) });
        return;
      }
      const id = `gen-${stamp()}-${Math.random().toString(36).slice(2, 6)}`;
      const job: GenJob = {
        id, state: 'running', stage: 'queue', label: stageLabels.queue, progress: 2,
        started: Date.now(), updated: Date.now(), logs: [], controller: new AbortController(),
      };
      genJobs.set(id, job);
      pushGenJob(job, 'queue', '排队中', 5, `已提交生成请求，音色 ${chosen}，文本 ${Array.from(text).length} 字。`);
      runGenJob(job, cfg, text, chosen);
      sendJson(res, 200, { ok: true, id, job: genJobView(job) });
    } catch (e: any) {
      sendJson(res, 400, { ok: false, code: e?.code || '', error: String(e?.message ?? e) });
    }
  });

  ctx.web.api('/plugins/voice/sing/generate/status', async (req, res, { signal }) => {
    try {
      const body = await readJson(req, signal);
      const id = String(body?.id ?? '').trim();
      const job = genJobs.get(id);
      if (!job) {
        sendJson(res, 404, { ok: false, error: '这个生成任务不存在或已过期。' });
        return;
      }
      sendJson(res, 200, { ok: true, job: genJobView(job) });
    } catch (e: any) {
      sendJson(res, 400, { ok: false, error: String(e?.message ?? e) });
    }
  });

  ctx.web.api('/plugins/voice/sing/generate/cancel', async (req, res, { signal }) => {
    try {
      const body = await readJson(req, signal);
      const id = String(body?.id ?? '').trim();
      const job = genJobs.get(id);
      if (!job) {
        sendJson(res, 404, { ok: false, error: '这个生成任务不存在或已过期。' });
        return;
      }
      if (job.state === 'running') {
        job.state = 'cancelled';
        job.stage = 'cancelled';
        job.label = stageLabels.cancelled;
        job.error = '已取消';
        job.updated = Date.now();
        job.controller.abort(new Error('用户取消'));
      }
      sendJson(res, 200, { ok: true, job: genJobView(job) });
    } catch (e: any) {
      sendJson(res, 400, { ok: false, error: String(e?.message ?? e) });
    }
  });

  ctx.web.api('/plugins/voice/sing/generate', async (req, res, { signal }) => {
    try {
      const body = await readJson(req, signal);
      const text = String(body?.text ?? '').trim() || DEFAULT_SING_TEXT;
      const cfg = await readCfg();
      if (Array.from(text).length > cfg.maxChars) throw new Error(`超过 ${cfg.maxChars} 字上限。`);
      const voices = await singVoices(cfg);
      if (!voices.length) {
        sendJson(res, 409, { ok: false, code: 'no_voices', error: '音色库为空，先生成一个音色，或改用上传本地人声。' });
        return;
      }
      const chosen = String(body?.voice ?? '').trim() || cfg.voice;
      if (!voices.some((v) => v.id === chosen)) throw new Error(`音色库里没有 ${chosen}。`);
      const result = await enqueueSing(() => generateVocal(ctx, cfg, text, chosen, signal));
      sendJson(res, 200, { ok: true, dir: GENERATED_DIR, ...result, files: await generatedTracks() });
    } catch (e: any) {
      sendJson(res, 400, { ok: false, code: e?.code || '', error: String(e?.message ?? e) });
    }
  });

  ctx.web.api('/plugins/voice/sing/upload', async (req, res, { signal }) => {
    try {
      const body = await readJson(req, signal);
      const raw = String(body?.base64 ?? '').replace(/^data:[^;]+;base64,/, '');
      if (!raw) throw new Error('没有收到要上传的音频。');
      const buffer = Buffer.from(raw, 'base64');
      const result = await saveUploadedTrack(buffer, String(body?.filename ?? 'audio.wav'), signal);
      sendJson(res, 200, { ok: true, dir: GENERATED_DIR, ...result, files: await generatedTracks() });
    } catch (e: any) {
      sendJson(res, 400, { ok: false, error: String(e?.message ?? e) });
    }
  });

  ctx.web.api('/plugins/voice/sing/refs', async (_req, res) => {
    sendJson(res, 200, { ok: true, refs: await singRefs(), defaultRef: await defaultRefName() });
  });

  ctx.web.api('/plugins/voice/sing/convert', async (req, res, { signal }) => {
    try {
      const body = await readJson(req, signal);
      const cfg = await readCfg();
      const sourcePath = String(body?.sourcePath ?? '').trim();
      const options = {
        ref: String(body?.ref ?? '').trim(),
        steps: body?.steps,
        cfgRate: body?.cfgRate,
        pitch: body?.pitch,
      };
      let result: any;
      if (sourcePath) {
        const source = resolve(sourcePath);
        if (!GENERATED_DIRS.some((dir) => isInside(dir, source)) && !SONG_ROOTS.some((root) => isInside(root, source))) {
          throw new Error('只能选择人声轨目录或曲目库里的文件。');
        }
        await stat(source);
        const ref = await singRefPath(options.ref);
        await stat(ref.path);
        result = await enqueueSing(() => runSeedVc(source, ref.path, options, cfg, signal));
        result.source = source;
        result.refName = ref.name;
      } else {
        const raw = String(body?.base64 ?? '').replace(/^data:[^;]+;base64,/, '');
        if (!raw) throw new Error('没有收到人声轨。');
        const buffer = Buffer.from(raw, 'base64');
        const refCheck = await singRefPath(String(body?.ref ?? '').trim());
        const refBytes = await readFile(refCheck.path);
        if (buffer.length === refBytes.length && buffer.equals(refBytes)) {
          throw new Error('上传的音频就是参考音，不是歌曲人声轨。请换一条带旋律的歌曲人声。');
        }
        result = await enqueueSing(() => singBuffer(cfg, buffer, String(body?.filename ?? 'source.wav'), options, signal));
      }
      sendJson(res, 200, {
        ok: true, mime: 'audio/wav', audio: result.bytes.toString('base64'),
        bytes: result.bytes.length, file: result.file, ref: result.ref,
        refName: result.refName, source: result.source,
        steps: result.steps, cfgRate: result.cfgRate, pitch: result.pitch,
        seconds: Math.round(result.elapsedMs / 1000),
      });
    } catch (e: any) {
      sendJson(res, 400, { ok: false, error: String(e?.message ?? e) });
    }
  });

  ctx.web.api('/plugins/voice/sing/send', async (req, res, { signal }) => {
    try {
      const body = await readJson(req, signal);
      const raw = String(body?.base64 ?? '').replace(/^data:[^;]+;base64,/, '');
      if (!raw) throw new Error('没有收到要发送的歌声。');
      const bytes = Buffer.from(raw, 'base64');
      const groupId = String(body?.groupId ?? '').trim();
      const receipt = await sendSingToGroup(ctx, groupId, bytes, signal);
      sendJson(res, 200, { ok: true, groupId, ...receipt, bytes: bytes.length });
    } catch (e: any) {
      sendJson(res, 400, { ok: false, error: String(e?.message ?? e) });
    }
  });

  ctx.logger.info('唱歌子插件已加载：Seed-VC 歌声转换 + 试听 + 群语音');
}


