/*! 语音模块共享配置与基础工具：主插件、说话子插件、唱歌子插件共用。 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Context } from '../../core/context.ts';

const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
export const PLUGIN_ROOT = fileURLToPath(new URL('.', import.meta.url));
export const DATA_ROOT = join(PLUGIN_ROOT, 'data');
export const BREEZE_ROOT = join(DATA_ROOT, 'breeze');
export const BREEZE_MODEL_FILE = 'breeze-tts-2-q8_0.gguf';
export const HIVE_BIN = join(BREEZE_ROOT, 'bin', 'breeze-server.exe');
export const HIVE_MODEL = join(BREEZE_ROOT, 'models', BREEZE_MODEL_FILE);
export const HIVE_VOICES = join(BREEZE_ROOT, 'voices');

const LEGACY_SING_ROOT = 'D:\\AI\\seed-vc';
const SING_ROOT = process.env.WHALELIFE_SING_ROOT
  || (existsSync(join(LEGACY_SING_ROOT, '.venv')) ? LEGACY_SING_ROOT : join(DATA_ROOT, 'seed-vc'));
const LEGACY_FFMPEG = 'D:\\dafeiyu\\ffmpeg\\bin\\ffmpeg.exe';
const FFMPEG = process.env.WHALELIFE_FFMPEG || (existsSync(LEGACY_FFMPEG) ? LEGACY_FFMPEG : 'ffmpeg');
const LEGACY_COMFY_SITE = 'D:\\ComfyUI\\venv\\Lib\\site-packages';
const COMFY_SITE = process.env.WHALELIFE_COMFY_SITE || (existsSync(LEGACY_COMFY_SITE) ? LEGACY_COMFY_SITE : '');

export const SING = {
  python: process.env.WHALELIFE_SING_PYTHON || join(SING_ROOT, '.venv', 'Scripts', 'python.exe'),
  runner: process.env.WHALELIFE_SING_RUNNER || join(SING_ROOT, 'run_seedvc.py'),
  cwd: SING_ROOT,
  refs: process.env.WHALELIFE_SING_REFS || join(SING_ROOT, 'refs'),
  defaultRef: 'xiaochi_breeze_ref.wav',
  input: process.env.WHALELIFE_SING_INPUT || join(SING_ROOT, 'input'),
  output: process.env.WHALELIFE_SING_OUTPUT || join(SING_ROOT, 'output', 'whalelife'),
  ffmpeg: FFMPEG,
  comfySite: COMFY_SITE,
};

export const VOICE_NAME = /^[A-Za-z0-9_-]{1,64}$/;
export const CLOUD_VOICE = /^[A-Za-z0-9._:/-]{1,160}$/;

export type Engine = 'local' | 'cloud';

export type Cfg = {
  engine?: Engine;
  baseUrl?: string;
  voice?: string;
  modelId?: string;
  cloudVoice?: string;
  cloudVoices?: string[];
  comfyUrl?: string;
  breezeExe?: string;
  breezeModel?: string;
  voicesDir?: string;
  play?: boolean;
  maxChars?: number;
};

export type Resolved = {
  engine: Engine;
  baseUrl: string;
  voice: string;
  modelId: string;
  cloudVoice: string;
  cloudVoices: string[];
  comfyUrl: string;
  breezeExe: string;
  breezeModel: string;
  voicesDir: string;
  play: boolean;
  maxChars: number;
};

export const DEFAULTS: Resolved = {
  engine: 'local',
  baseUrl: 'http://127.0.0.1:8139',
  voice: 'xiaochi_soft',
  modelId: '',
  cloudVoice: '',
  cloudVoices: [],
  comfyUrl: 'http://127.0.0.1:8188',
  breezeExe: HIVE_BIN,
  breezeModel: HIVE_MODEL,
  voicesDir: HIVE_VOICES,
  play: true,
  maxChars: 400,
};

export type Target = { kind: Engine; base: string; key: string; model: string; name: string };

export type VoiceRow = {
  id: string;
  seconds: number;
  description: string;
  saved: boolean;
  source: string;
};

export type Caps = { list: boolean; design: boolean; clone: boolean; delete: boolean; add: boolean };

export type Library = {
  engine: Engine;
  model: string;
  endpoint: string;
  online: boolean;
  status: number | null;
  defaultVoice: string;
  capabilities: Caps;
  voices: VoiceRow[];
  note: string;
};

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
export const esc = (v: unknown) => String(v ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function normalize(stored: Cfg | null): Resolved {
  const s = stored ?? {};
  const maxChars = Number(s.maxChars);
  return {
    engine: s.engine === 'cloud' ? 'cloud' : 'local',
    baseUrl: String(s.baseUrl || DEFAULTS.baseUrl).replace(/\/$/, ''),
    voice: String(s.voice || DEFAULTS.voice),
    modelId: String(s.modelId || ''),
    cloudVoice: String(s.cloudVoice || ''),
    cloudVoices: Array.isArray(s.cloudVoices)
      ? s.cloudVoices.map((x) => String(x)).filter((x) => CLOUD_VOICE.test(x)).slice(0, 200)
      : [],
    comfyUrl: String(s.comfyUrl || DEFAULTS.comfyUrl).replace(/\/$/, ''),
    breezeExe: String(s.breezeExe || DEFAULTS.breezeExe),
    breezeModel: String(s.breezeModel || DEFAULTS.breezeModel),
    voicesDir: String(s.voicesDir || DEFAULTS.voicesDir),
    play: s.play !== false,
    maxChars: Number.isFinite(maxChars) && maxChars > 0 && maxChars <= 2000 ? Math.floor(maxChars) : DEFAULTS.maxChars,
  };
}

export function apiBase(base: string) {
  const b = base.replace(/\/$/, '');
  return /\/v1$/.test(b) ? b : `${b}/v1`;
}

export function rootBase(base: string) {
  return base.replace(/\/$/, '').replace(/\/v1$/, '');
}

export function isLoopback(url: string) {
  try {
    const u = new URL(url);
    return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}

export function portOf(url: string) {
  try {
    const u = new URL(url);
    if (u.port) return Number(u.port);
    return u.protocol === 'https:' ? 443 : 80;
  } catch {
    return 8139;
  }
}

export function authHeaders(key: string): Record<string, string> {
  return key ? { Authorization: `Bearer ${key}` } : {};
}

export async function healthy(base: string, ms = 3000) {
  try {
    const res = await fetch(`${rootBase(base)}/health`, { signal: AbortSignal.timeout(ms) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function freeComfy(url: string) {
  try {
    await fetch(`${rootBase(url)}/free`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"unload_models":true,"free_memory":true}',
      signal: AbortSignal.timeout(20_000),
    });
    return true;
  } catch {
    return false;
  }
}

type BreezeOwner = {
  child: ReturnType<typeof spawn>;
  pid: number;
  exe: string;
  model: string;
  baseUrl: string;
  voicesDir: string;
  port: number;
  startedAt: number;
};

type ProcessInfo = { executablePath: string; commandLine: string };

const BREEZE_OWNERS_KEY = Symbol.for('whalelife.voice.breeze.owners');
const breezeOwners: Map<string, BreezeOwner> =
  ((globalThis as any)[BREEZE_OWNERS_KEY] ??= new Map<string, BreezeOwner>());

const breezeOwnerKey = (cfg: Resolved) =>
  `${String(cfg.baseUrl || '').replace(/\/$/, '')}|${portOf(cfg.baseUrl)}|${resolve(cfg.breezeExe)}`;

const normalizeProcessPath = (value: string) => {
  const text = String(value || '').trim().replace(/^\\\\\?\\/, '');
  return text ? resolve(text).toLowerCase() : '';
};

const processMatchesOwner = (info: ProcessInfo, owner: BreezeOwner) => {
  if (!normalizeProcessPath(info.executablePath) || normalizeProcessPath(info.executablePath) !== normalizeProcessPath(owner.exe)) return false;
  const command = String(info.commandLine || '').toLowerCase();
  if (!command) return false;
  const model = String(owner.model || '').toLowerCase();
  const voices = String(owner.voicesDir || '').toLowerCase();
  if (!model || !voices) return false;
  return command.includes(model)
    && command.includes(voices)
    && new RegExp(`--port(?:=|\\s+)${owner.port}(?:\\s|$)`).test(command);
};

export function spawnBreeze(cfg: Resolved) {
  const child = spawn(cfg.breezeExe, [cfg.breezeModel, '--host', '127.0.0.1', '--port', String(portOf(cfg.baseUrl)),
    '--voices-dir', cfg.voicesDir, '--ws-port', '-1'], {
    detached: true, windowsHide: true, stdio: 'ignore',
  });
  if (!child.pid) throw new Error('Breeze 启动后没有拿到进程号。');
  const key = breezeOwnerKey(cfg);
  const owner: BreezeOwner = {
    child,
    pid: child.pid,
    exe: resolve(cfg.breezeExe),
    model: String(cfg.breezeModel || ''),
    baseUrl: String(cfg.baseUrl || '').replace(/\/$/, ''),
    voicesDir: String(cfg.voicesDir || ''),
    port: portOf(cfg.baseUrl),
    startedAt: Date.now(),
  };
  breezeOwners.set(key, owner);
  child.once('exit', () => {
    if (breezeOwners.get(key)?.child === child) breezeOwners.delete(key);
  });
  child.unref();
  return owner;
}

export async function ensureBreeze(cfg: Resolved, signal: AbortSignal) {
  if (await healthy(cfg.baseUrl)) return { ready: true, started: false };
  if (!isLoopback(cfg.baseUrl)) return { ready: true, started: false };
  await freeComfy(cfg.comfyUrl);
  try {
    spawnBreeze(cfg);
  } catch {
    return { ready: false, started: false };
  }
  for (let i = 0; i < 45; i++) {
    if (signal.aborted) throw new Error('已取消');
    await sleep(2000);
    if (await healthy(cfg.baseUrl)) return { ready: true, started: true };
  }
  return { ready: false, started: true };
}

export async function speakFile(path: string) {
  const child = spawn(PS, ['-NoProfile', '-NonInteractive', '-Command',
    `$p = New-Object Media.SoundPlayer '${path}'; $p.PlaySync()`], {
    detached: true, windowsHide: true, stdio: 'ignore',
  });
  child.unref();
}

export function pcmToWav(pcm: Buffer, rate: number) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

export function looksWav(bytes: Buffer) {
  return bytes.length > 44 && bytes.subarray(0, 4).toString('ascii') === 'RIFF';
}

/**
 * Breeze 是流式输出，WAV 头的 RIFF/data 长度字段写的是最大值。
 * 这种文件再被 Breeze 自己解析会越界崩溃，所以落盘和上传前都按真实长度重写。
 */
export function normalizeWav(bytes: Buffer) {
  if (!looksWav(bytes)) return bytes;
  let p = 12;
  let dataStart = -1;
  let dataLen = 0;
  while (p + 8 <= bytes.length) {
    const id = bytes.toString('ascii', p, p + 4);
    const declared = bytes.readUInt32LE(p + 4);
    const start = p + 8;
    const avail = bytes.length - start;
    const len = Math.min(declared, avail);
    if (id === 'data') {
      dataStart = start;
      dataLen = len;
      break;
    }
    if (declared > avail) break;
    p = start + len + (len & 1);
  }
  if (dataStart < 0) return bytes;
  const out = Buffer.from(bytes);
  out.writeUInt32LE(out.length - 8, 4);
  out.writeUInt32LE(dataLen, dataStart - 4);
  return out;
}

export function loudenWav(bytes: Buffer) {
  if (!looksWav(bytes)) return bytes;
  let p = 12, dataStart = -1, dataLen = 0, format = 1, bits = 16;
  while (p + 8 <= bytes.length) {
    const id = bytes.toString('ascii', p, p + 4);
    const declared = bytes.readUInt32LE(p + 4);
    const start = p + 8;
    const avail = bytes.length - start;
    const len = Math.min(declared, avail);
    if (id === 'fmt ' && len >= 16) {
      format = bytes.readUInt16LE(start);
      bits = bytes.readUInt16LE(start + 14);
    }
    if (id === 'data') {
      dataStart = start;
      dataLen = len;
      break;
    }
    if (declared > avail) break;
    p = start + len + (len & 1);
  }
  if (format !== 1 || bits !== 16 || dataStart < 0 || dataLen < 2) return bytes;
  let peak = 0;
  for (let i = 0; i + 1 < dataLen; i += 2) {
    const value = Math.abs(bytes.readInt16LE(dataStart + i));
    if (value > peak) peak = value;
  }
  if (peak < 500 || peak >= 32000) return bytes;
  const gain = Math.min(3.2, 30000 / peak);
  if (gain <= 1.08) return bytes;
  const out = Buffer.from(bytes);
  for (let i = 0; i + 1 < dataLen; i += 2) {
    const value = Math.round(out.readInt16LE(dataStart + i) * gain);
    out.writeInt16LE(value > 32767 ? 32767 : value < -32768 ? -32768 : value, dataStart + i);
  }
  return out;
}

export function audioFrom(bytes: Buffer, type: string, rate: number) {
  if (looksWav(bytes)) return bytes;
  if (type.includes('pcm') || type.includes('octet-stream')) return pcmToWav(bytes, rate || 24_000);
  if (type.includes('mpeg') || type.includes('mp3'))
    throw new Error('这个网络模型只返回 MP3，当前还不支持。换一个支持 response_format=wav 的语音模型，或改用本机模型。');
  throw new Error(`返回了无法识别的音频格式（${type || '未知'}）。`);
}

export function targetOf(ctx: Context, cfg: Resolved): Target {
  if (cfg.engine === 'cloud') {
    if (!cfg.modelId) throw new Error('还没有选择网络语音模型，请先在“语音模块”的模型接入里选一个。');
    const c = ctx.models.connection(cfg.modelId);
    if (c.protocol !== 'openai-compatible')
      throw new Error(`这个模型的协议是 ${c.protocol}，暂时只支持 OpenAI 兼容的语音合成模型。`);
    return { kind: 'cloud', base: c.base_url.replace(/\/$/, ''), key: c.api_key || '', model: c.model, name: c.name };
  }
  return { kind: 'local', base: cfg.baseUrl.replace(/\/$/, ''), key: '', model: 'breeze', name: '本机 Breeze' };
}

export async function requestSpeech(t: Target, text: string, voice: string, signal: AbortSignal, timeout = 180_000) {
  return fetch(`${apiBase(t.base)}/audio/speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(t.key) },
    body: JSON.stringify({ model: t.model, input: text, voice, response_format: 'wav' }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
  });
}

export async function readError(res: Response, prefix: string) {
  let body = '';
  try {
    body = (await res.text()).slice(0, 300);
  } catch {
    /* ignore */
  }
  let message = body;
  try {
    const parsed = JSON.parse(body);
    message = parsed?.error?.message ?? parsed?.error ?? parsed?.message ?? body;
  } catch {
    /* keep raw */
  }
  return `${prefix}（HTTP ${res.status}）：${String(message).slice(0, 240)}`;
}

export async function synth(ctx: Context, cfg: Resolved, text: string, voice: string | undefined, signal: AbortSignal) {
  const t = targetOf(ctx, cfg);
  if (t.kind === 'local') {
    const boot = await ensureBreeze(cfg, signal);
    if (!boot.ready) throw new Error('Breeze 没起来（可能显卡被占用），这句先说文字。');
    const chosen = voice || cfg.voice;
    if (!chosen) throw new Error('还没有默认音色，先到设置页的音色库里选一个。');
    const res = await requestSpeech(t, text, chosen, signal);
    if (!res.ok) throw new Error(await readError(res, '合成失败'));
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length < 44) throw new Error('合成结果为空。');
    return { bytes: loudenWav(normalizeWav(bytes)), started: boot.started, voice: chosen, target: t };
  }

  const chosen = voice || cfg.cloudVoice || cfg.cloudVoices[0] || '';
  if (!chosen) throw new Error('还没有默认音色。先在音色库里选一个，或在“语音模块”的模型接入里填一个音色 id。');
  let res = await requestSpeech(t, text, chosen, signal, 90_000);
  if (res.status === 409) {
    await new Promise((r) => setTimeout(r, 1500));
    res = await requestSpeech(t, text, chosen, signal, 90_000);
  }
  if (!res.ok) throw new Error(await readError(res, '网络模型合成失败'));
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length < 44) throw new Error('网络模型没有返回音频。');
  const rate = Number(res.headers.get('x-sample-rate') || 24_000);
  return {
    bytes: loudenWav(normalizeWav(audioFrom(bytes, String(res.headers.get('content-type') || ''), rate))),
    started: false, voice: chosen, target: t,
  };
}

export async function designSample(ctx: Context, cfg: Resolved, instruction: string, text: string, signal: AbortSignal) {
  const t = targetOf(ctx, cfg);
  if (t.kind !== 'local') throw new Error('网络语音模型不支持按描述造音色；可以试试参考音频克隆，或直接用服务商自带的音色。');
  const boot = await ensureBreeze(cfg, signal);
  if (!boot.ready) throw new Error('Breeze 没起来（可能显卡被占用），暂时造不了新音色。');
  const fd = new FormData();
  fd.set('text', text);
  fd.set('instruction', instruction);
  fd.set('seed', String(Math.floor(Math.random() * 500) + 1));
  const res = await fetch(`${apiBase(t.base)}/audio/speech`, {
    method: 'POST',
    body: fd,
    signal: AbortSignal.any([signal, AbortSignal.timeout(300_000)]),
  });
  if (!res.ok) throw new Error(await readError(res, '音色设计失败'));
  const rate = Number(res.headers.get('x-sample-rate') || 24_000);
  const pcm = Buffer.from(await res.arrayBuffer());
  if (pcm.length < 1024) throw new Error('音色设计没有返回音频。');
  return { wav: pcmToWav(pcm, rate), rate, text };
}

export async function saveVoice(
  ctx: Context,
  cfg: Resolved,
  input: { name: string; description?: string; refText: string; wav: Buffer },
  signal: AbortSignal,
) {
  if (!VOICE_NAME.test(input.name)) throw new Error('本机音色名只能字母、数字、- 和 _，最多 64 字。');
  const t = targetOf(ctx, cfg);
  if (t.kind === 'local') {
    const boot = await ensureBreeze(cfg, signal);
    if (!boot.ready) throw new Error('Breeze 没起来，暂时存不了音色。');
  }
  const fd = new FormData();
  fd.set('ref_audio', new Blob([normalizeWav(input.wav) as any], { type: 'audio/wav' }), `${input.name}.wav`);
  fd.set('ref_text', input.refText);
  fd.set('name', input.name);
  if (input.description) fd.set('description', input.description.slice(0, 400));
  const res = await fetch(`${apiBase(t.base)}/voices`, {
    method: 'POST',
    headers: authHeaders(t.key),
    body: fd,
    signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`保存音色失败（HTTP ${res.status}）：${text.slice(0, 200)}`);
  try {
    return JSON.parse(text);
  } catch {
    return { id: input.name };
  }
}

export async function ensureDefaultVoice(ctx: Context, cfg: Resolved, signal: AbortSignal) {
  if (cfg.engine !== 'local') throw new Error('只有本机语音模型需要自动准备音色。');
  let existing: string[] = [];
  try {
    existing = (await readdir(cfg.voicesDir)).filter((n) => n.toLowerCase().endsWith('.breeze'));
  } catch {
    /* 目录还没建 */
  }
  const wanted = VOICE_NAME.test(cfg.voice) ? cfg.voice : 'xiaochi_soft';
  if (existing.some((n) => n.slice(0, -7) === wanted)) return { created: false, voice: wanted, adopted: false };
  if (existing.length) {
    const first = existing[0].slice(0, -7);
    if (VOICE_NAME.test(first)) return { created: false, voice: first, adopted: true };
  }
  const instruction = '年轻女性，声音清亮偏软，语速偏慢，温柔自然，普通话标准，轻微气声，像深夜电台主持。';
  const sampleText = '你好，我是周小迟。夜里睡不着的话，就和我说说话吧。';
  const sample = await designSample(ctx, cfg, instruction, sampleText, signal);
  await saveVoice(ctx, cfg, { name: wanted, description: instruction, refText: sampleText, wav: sample.wav }, signal);
  return { created: true, voice: wanted, adopted: false, seconds: Math.round(sample.wav.length / 48_000) };
}

export function clampNumber(value: unknown, fallback: number, min: number, max: number) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function isInside(dir: string, file: string) {
  const d = resolve(dir);
  const f = resolve(file);
  return f === d || f.startsWith(d + sep);
}

export function runProcess(
  exe: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string | undefined>; signal?: AbortSignal; timeout?: number } = {},
) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolvePromise, rejectPromise) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(exe, args, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e: any) {
      rejectPromise(e);
      return;
    }
    let stdout = '';
    let stderr = '';
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      fn();
    };
    const kill = () => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    };
    if (opts.signal) {
      if (opts.signal.aborted) {
        kill();
        finish(() => rejectPromise(new Error('已取消')));
        return;
      }
      opts.signal.addEventListener('abort', () => {
        kill();
        finish(() => rejectPromise(new Error('已取消')));
      }, { once: true });
    }
    if (opts.timeout) {
      timer = setTimeout(() => {
        kill();
        finish(() => rejectPromise(new Error('处理超时')));
      }, opts.timeout);
    }
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
      if (stdout.length > 160_000) stdout = stdout.slice(-160_000);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 160_000) stderr = stderr.slice(-160_000);
    });
    child.on('error', (e) => finish(() => rejectPromise(e)));
    child.on('close', (code) => finish(() => resolvePromise({ code, stdout, stderr })));
  });
}

const processInfo = async (pid: number): Promise<ProcessInfo | null> => {
  try {
    const script = `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction SilentlyContinue; if ($p) { [pscustomobject]@{ ExecutablePath = [string]$p.ExecutablePath; CommandLine = [string]$p.CommandLine } | ConvertTo-Json -Compress }`;
    const result = await runProcess(PS, ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 8_000 });
    const stdout = result.stdout.replace(/^\uFEFF/, '').trim();
    if (result.code !== 0 || !stdout) return null;
    const value = JSON.parse(stdout);
    return {
      executablePath: String(value?.ExecutablePath ?? ''),
      commandLine: String(value?.CommandLine ?? ''),
    };
  } catch {
    return null;
  }
};

const waitForExit = async (owner: BreezeOwner, ms: number) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (owner.child.exitCode !== null || owner.child.signalCode !== null) return true;
    const info = await processInfo(owner.pid);
    if (!info) return true;
    await sleep(250);
  }
  return owner.child.exitCode !== null || owner.child.signalCode !== null || !(await processInfo(owner.pid));
};

/**
 * 只停止本实例登记过、且仍能核对上可执行文件与命令行归属的 Breeze。
 * 不按进程名批量结束，避免同一台机器上的另一个实例被误杀。
 */
export async function stopBreeze(cfg?: Resolved) {
  const key = cfg ? breezeOwnerKey(cfg) : '';
  const targets = [...breezeOwners.entries()].filter(([k]) => !cfg || k === key);
  let stopped = 0;
  let skipped = 0;
  for (const [ownerKey, owner] of targets) {
    if (owner.child.exitCode !== null || owner.child.signalCode !== null) {
      breezeOwners.delete(ownerKey);
      continue;
    }
    const info = await processInfo(owner.pid);
    if (!info || !processMatchesOwner(info, owner)) {
      skipped++;
      breezeOwners.delete(ownerKey);
      continue;
    }
    try {
      owner.child.kill();
    } catch {
      /* 进程可能已经退出 */
    }
    const exited = await waitForExit(owner, 5_000);
    if (!exited) {
      const again = await processInfo(owner.pid);
      if (again && processMatchesOwner(again, owner)) {
        try {
          await runProcess('C:\\Windows\\System32\\taskkill.exe', ['/PID', String(owner.pid), '/F'], { timeout: 15_000 });
        } catch {
          /* 结束失败时保留登记，交给下次重试 */
          continue;
        }
      }
    }
    breezeOwners.delete(ownerKey);
    stopped++;
  }
  return { stopped, skipped };
}

export async function sha256File(file: string) {
  return await new Promise<string>((ok, fail) => {
    const hash = createHash('sha256');
    const stream = createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', fail);
    stream.on('end', () => ok(hash.digest('hex')));
  });
}

export async function verifyFileSha256(file: string, expected: string, label = '文件') {
  const want = String(expected ?? '').trim().toLowerCase().replace(/^sha256:/, '');
  if (!/^[0-9a-f]{64}$/.test(want)) throw new Error(`${label}缺少可信的 SHA256 摘要，拒绝使用。`);
  const actual = await sha256File(file);
  if (actual !== want) throw new Error(`${label} SHA256 校验失败：期望 ${want}，实际 ${actual}。`);
  return actual;
}
