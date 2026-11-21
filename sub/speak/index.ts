/*! 说话子插件：本机 Breeze / 本机 OpenAI 兼容 / 网络 TTS 合成 + 音色库 + 本机扬声器播放。 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { Context } from '../../../../core/context.ts';
import {
  apiBase, authHeaders, audioFrom, CLOUD_VOICE, designSample, ensureBreeze, ensureDefaultVoice as ensureDefaultVoiceCore,
  esc, healthy, type Library, looksWav, loudenWav, normalize, normalizeWav, pcmToWav, PLUGIN_ROOT, type Resolved,
  saveVoice, speakFile, stamp, synth, type Target, targetOf, VOICE_NAME, type VoiceRow,
} from '../../shared.ts';

const ROOT = join(PLUGIN_ROOT, 'sub', 'speak', 'data', 'wav');

async function serverVoices(t: Target, signal?: AbortSignal): Promise<VoiceRow[] | null> {
  try {
    const res = await fetch(`${apiBase(t.base)}/voices`, {
      headers: authHeaders(t.key),
      signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    const arr = Array.isArray(data) ? data : Array.isArray(data?.voices) ? data.voices : null;
    if (!arr) return null;
    return arr
      .map((v: any) => ({
        id: String(v?.id ?? v?.name ?? ''),
        seconds: Number(v?.seconds ?? v?.duration ?? 0) || 0,
        description: String(v?.description ?? ''),
        saved: v?.saved !== false,
        source: '服务端',
      }))
      .filter((v: VoiceRow) => v.id && CLOUD_VOICE.test(v.id)) as VoiceRow[];
  } catch {
    return null;
  }
}

async function fileVoices(cfg: Resolved): Promise<VoiceRow[]> {
  try {
    const names = await readdir(cfg.voicesDir);
    return names
      .filter((n) => n.endsWith('.breeze'))
      .map((n) => ({ id: n.slice(0, -7), seconds: 0, description: '', saved: true, source: '文件' }))
      .filter((v) => VOICE_NAME.test(v.id));
  } catch {
    return [];
  }
}

async function libraryView(ctx: Context, cfg: Resolved, signal?: AbortSignal): Promise<Library> {
  try {
    const t = targetOf(ctx, cfg);
    if (t.kind === 'cloud') {
      let online = false;
      let status: number | null = null;
      try {
        const res = await fetch(`${apiBase(t.base)}/models`, {
          headers: authHeaders(t.key),
          signal: AbortSignal.timeout(6000),
        });
        online = true;
        status = res.status;
      } catch {
        online = false;
      }
      const found = await serverVoices(t, signal);
      const manual = cfg.cloudVoices.map((id) => ({ id, seconds: 0, description: '', saved: true, source: '手动' }));
      const merged = [...(found ?? []), ...manual.filter((m) => !(found ?? []).some((f) => f.id === m.id))];
      const list = found !== null;
      const note = !online
        ? '连不上这个网络模型，检查地址或网络。'
        : status === 401 || status === 403
          ? '能连上，但密钥被拒了，去“模型服务”检查 API Key。'
          : list
            ? '这个模型带音色接口：可以直接用下面的音色，也可以尝试克隆新音色。'
            : '这个模型没有音色列表接口，只能用它自带的音色；把音色 id 手动加进来即可。';
      return {
        engine: 'cloud', model: t.name, endpoint: t.base, online, status,
        defaultVoice: cfg.cloudVoice,
        capabilities: { list: list || manual.length > 0, design: false, clone: list, delete: list || manual.length > 0, add: true },
        voices: merged, note,
      };
    }
    const breeze = cfg.localMode === 'breeze';
    let online = false;
    try {
      if (breeze) online = await healthy(cfg.baseUrl);
      else {
        const res = await fetch(`${apiBase(cfg.baseUrl)}/models`, { signal: AbortSignal.timeout(6000) });
        online = res.status < 500;
      }
    } catch {
      online = false;
    }
    const found = await serverVoices(t, signal);
    const files = found === null && breeze ? await fileVoices(cfg) : [];
    const voices = found ?? files;
    return {
      engine: 'local', model: t.name, endpoint: t.base, online, status: null,
      defaultVoice: cfg.voice,
      capabilities: breeze
        ? { list: true, design: true, clone: true, delete: true, add: false }
        : { list: true, design: false, clone: found !== null, delete: found !== null, add: false },
      voices,
      note: breeze
        ? (online ? 'Breeze 已就绪。' : (cfg.breezeAutoStart ? 'Breeze 还没起，生成时会自动拉起；也可以点“测试连接”手动启动。' : 'Breeze 还没起，自动启动已关闭。'))
        : (online ? '本机 OpenAI 兼容服务已连通。' : '本机 OpenAI 兼容服务连不上，检查地址和服务状态。') +
          (found === null ? ' 这个服务没有 /v1/voices 接口，音色 id 直接填服务里已有的。' : ''),
    };
  } catch (e: any) {
    const manual = cfg.cloudVoices.map((id) => ({ id, seconds: 0, description: '', saved: true, source: '手动' }));
    return {
      engine: cfg.engine, model: '', endpoint: '', online: false, status: null,
      defaultVoice: cfg.engine === 'local' ? cfg.voice : cfg.cloudVoice,
      capabilities: { list: manual.length > 0, design: false, clone: false, delete: manual.length > 0, add: cfg.engine === 'cloud' },
      voices: manual,
      note: String(e?.message ?? e),
    };
  }
}

async function deleteVoice(ctx: Context, cfg: Resolved, name: string): Promise<{ deleted: boolean; fileDeleted: boolean; serverDeleted: boolean }> {
  const t = targetOf(ctx, cfg);
  let serverDeleted = false;
  try {
    const res = await fetch(`${apiBase(t.base)}/voices/${encodeURIComponent(name)}`, {
      method: 'DELETE',
      headers: authHeaders(t.key),
      signal: AbortSignal.timeout(20_000),
    });
    serverDeleted = res.ok;
  } catch {
    serverDeleted = false;
  }
  let fileDeleted = false;
  if (t.kind === 'local' && cfg.localMode === 'breeze' && VOICE_NAME.test(name)) {
    const dir = resolve(cfg.voicesDir);
    const file = resolve(join(dir, `${name}.breeze`));
    if (file.startsWith(dir + sep)) {
      try {
        await unlink(file);
        fileDeleted = true;
      } catch {
        fileDeleted = false;
      }
    }
  }
  return { deleted: serverDeleted || fileDeleted, fileDeleted, serverDeleted };
}

export function apply(ctx: Context) {
  const parent = () => (ctx.get as any)('voice');
  const readCfg = async (): Promise<Resolved> => normalize(await parent().config());
  const saveCfg = async (patch: Partial<Resolved>) => parent().save(patch) as Promise<Resolved>;

  ctx.tools.register({
    name: 'say_out_loud',
    description:
      '把这句话念出来（在这台电脑的扬声器上放），同时留一份 wav。不管是本机还是网络模型，都走同一个入口。' +
      '她说“说给我听”“念一下”、或者你想听她声音时用。一次别超过四百字；太长的内容拆成两三句分别调用。' +
      '本机引擎没起会自动拉起，显存被 ComfyUI 占着会先让它卸载模型。',
    danger: 'ask',
    schema: {
      type: 'object',
      properties: {
        text: { type: 'string', minLength: 1, description: '要念出来的话，中文，带自然停顿标点。' },
        voice: { type: 'string', description: '音色 id；不确定就留空，用当前默认。' },
        play: { type: 'boolean', description: '是否在这台电脑上播放，默认 true。' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    async run(args: any, session) {
      const cfg = await readCfg();
      const signal = session.signal ?? ctx.signal;
      const text = String(args.text ?? '').trim();
      if (!text) return { status: 'error', error: '没有要念的内容。' };
      if (Array.from(text).length > cfg.maxChars)
        return { status: 'error', error: `太长（${Array.from(text).length} 字），上限 ${cfg.maxChars} 字，拆成几句分别说。` };

      try {
        const { bytes, started, voice, target } = await synth(ctx, cfg, text, args.voice, signal);
        await mkdir(ROOT, { recursive: true });
        const file = join(ROOT, `say-${stamp()}-${Math.random().toString(36).slice(2, 6)}.wav`);
        await writeFile(file, bytes);
        const wantPlay = args.play === undefined ? cfg.play : Boolean(args.play);
        if (wantPlay) {
          ctx.signal.throwIfAborted();
          await speakFile(file, cfg);
        }
        return {
          status: 'ok', file, bytes: bytes.length, played: wantPlay,
          engine: target.kind, model: target.name, engineStarted: started, voice, text,
        };
      } catch (e: any) {
        return { status: 'error', error: String(e?.message ?? e) };
      }
    },
  });

  ctx.tools.register({
    name: 'qq_say',
    description:
      '把这句话合成语音，然后作为一条语音私聊发给 QQ 白名单里的好友。' +
      '本机和网络模型都能发；只有对方在私聊白名单内才发得出去；一次不超过四百字，太长就拆句。QQ 不发语音时改用 qq_send_message 发文字。',
    danger: 'ask',
    schema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: '接收方 QQ 号，必须是私聊白名单里的好友。' },
        text: { type: 'string', minLength: 1, description: '要说的话，中文，带自然停顿标点。' },
        actionId: { type: 'string', description: '可选；同一句话重发请保持同一个 ID。' },
        voice: { type: 'string', description: '音色 id；不确定就留空，用当前默认。' },
      },
      required: ['userId', 'text'],
      additionalProperties: false,
    },
    async run(args: any, session) {
      const qq = (ctx.get as any)('qq', false);
      if (!qq?.sendMedia) return { status: 'error', error: 'QQ 插件没接上，这条语音发不出去。' };
      const cfg = await readCfg();
      const signal = session.signal ?? ctx.signal;
      const text = String(args.text ?? '').trim();
      if (!text) return { status: 'error', error: '没有要说的内容。' };
      if (Array.from(text).length > cfg.maxChars)
        return { status: 'error', error: `太长（${Array.from(text).length} 字），上限 ${cfg.maxChars} 字，拆成几句分别说。` };
      try {
        const { bytes, started, voice, target } = await synth(ctx, cfg, text, args.voice, signal);
        ctx.signal.throwIfAborted();
        await mkdir(ROOT, { recursive: true });
        const file = join(ROOT, `qq-${stamp()}-${Math.random().toString(36).slice(2, 6)}.wav`);
        await writeFile(file, bytes);
        const id = createHash('sha256').update(bytes).digest('hex');
        const receipt = await qq.sendMedia({
          sessionId: session.id,
          userId: String(args.userId),
          actionId: String(args.actionId || `voice-${id.slice(0, 16)}`),
          personaId: session.personaId,
          parts: [{ type: 'voice', id, mime: 'audio/wav', base64: bytes.toString('base64') }],
        }, { signal });
        return { ...receipt, file, bytes: bytes.length, engine: target.kind, model: target.name, engineStarted: started, voice, text };
      } catch (e: any) {
        return { status: 'error', error: String(e?.message ?? e) };
      }
    },
  });

  ctx.tools.register({
    name: 'voice_list',
    description: '列出当前模型下能用的音色（id、时长、描述、来源），以及当前默认音色。想换声音、或者要确认某个音色还在不在时用。',
    danger: 'safe',
    schema: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      const cfg = await readCfg();
      try {
        const lib = await libraryView(ctx, cfg);
        return {
          status: 'ok',
          engine: lib.engine,
          model: lib.model,
          defaultVoice: lib.defaultVoice,
          capabilities: lib.capabilities,
          voices: lib.voices.map((v) => ({ id: v.id, seconds: v.seconds || null, description: v.description, saved: v.saved, source: v.source })),
          note: lib.note,
        };
      } catch (e: any) {
        return { status: 'error', error: String(e?.message ?? e) };
      }
    },
  });

  ctx.tools.register({
    name: 'voice_use',
    description: '把音色库里的某个音色设为当前默认音色。之后 say_out_loud / qq_say 不指定 voice 就用它。',
    danger: 'ask',
    schema: {
      type: 'object',
      properties: { name: { type: 'string', minLength: 1, description: '音色 id，必须是 voice_list 里有的。' } },
      required: ['name'],
      additionalProperties: false,
    },
    async run(args: any) {
      const cfg = await readCfg();
      const name = String(args.name ?? '').trim();
      if (!name) return { status: 'error', error: '没选音色。' };
      if (cfg.engine === 'local' && cfg.localMode === 'breeze' && !VOICE_NAME.test(name)) return { status: 'error', error: '本机 Breeze 音色名只能字母、数字、- 和 _。' };
      if (cfg.engine === 'local' && cfg.localMode === 'openai' && !CLOUD_VOICE.test(name)) return { status: 'error', error: '本机音色 id 不合法。' };
      try {
        const lib = await libraryView(ctx, cfg);
        if (!lib.voices.some((v) => v.id === name))
          return { status: 'error', error: `音色库里没有 ${name}，先用 voice_list 看一下。` };
        await saveCfg(cfg.engine === 'local' ? { voice: name } : { cloudVoice: name });
        return { status: 'ok', engine: cfg.engine, defaultVoice: name };
      } catch (e: any) {
        return { status: 'error', error: String(e?.message ?? e) };
      }
    },
  });

  ctx.tools.register({
    name: 'voice_create',
    description:
      '用一段中文描述造出一个新音色，存进音色库之后就能一直用。只有本机模型支持；网络模型请用音色克隆或服务商自带音色。' +
      'description 写声音本身：年龄、性别、音色质感、语速、口音、情绪基调。' +
      'name 只能字母数字和 - _。setDefault 为 true 时顺手设为默认。' +
      '当你想换一种声音、或主人提到想听某种声音时，可以直接调用，不必先问。',
    danger: 'ask',
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, description: '音色名，字母/数字/-/_，最多 64 位，例如 narration。' },
        description: { type: 'string', minLength: 1, description: '音色描述（中文），越具体越像。' },
        sampleText: { type: 'string', description: '用来定音色的试音文本，默认一句自我介绍。' },
        setDefault: { type: 'boolean', description: '是否设为默认音色，默认 false。' },
      },
      required: ['name', 'description'],
      additionalProperties: false,
    },
    async run(args: any, session) {
      const cfg = await readCfg();
      const signal = session.signal ?? ctx.signal;
      const name = String(args.name ?? '').trim();
      if (!VOICE_NAME.test(name)) return { status: 'error', error: '音色名只能字母、数字、- 和 _，最多 64 字。' };
      const description = String(args.description ?? '').trim();
      if (!description) return { status: 'error', error: '需要一段音色描述。' };
      const sampleText = String(args.sampleText ?? '').trim() || '你好，这是一段用来试听音色的示例文本。';
      try {
        const { wav } = await designSample(ctx, cfg, description, sampleText, signal);
        const saved = await saveVoice(ctx, cfg, { name, description, refText: sampleText, wav }, signal);
        let isDefault = cfg.voice === name;
        if (args.setDefault === true) {
          await saveCfg({ voice: name });
          isDefault = true;
        }
        return { status: 'ok', voice: saved, wavBytes: wav.length, isDefault, file: join(cfg.voicesDir, `${name}.breeze`), description };
      } catch (e: any) {
        return { status: 'error', error: String(e?.message ?? e) };
      }
    },
  });

  ctx.tools.register({
    name: 'voice_clone',
    description:
      '从一段参考音频克隆音色并存进音色库。sourcePath 是本机 WAV 的绝对路径。' +
      '只有带音色接口的模型（本机 Breeze 或支持 /v1/voices 的服务商）能做；克隆后就能在 say_out_loud / qq_say 里选它。',
    danger: 'ask',
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, description: '音色名，字母/数字/-/_，最多 64 位。' },
        refText: { type: 'string', minLength: 1, description: '参考音频的逐字稿，必须和音频内容一字不差。' },
        sourcePath: { type: 'string', minLength: 1, description: '参考音频在本机的绝对路径（WAV）。' },
        description: { type: 'string', description: '可选描述，方便以后认出来。' },
        setDefault: { type: 'boolean', description: '是否顺手设为默认音色。' },
      },
      required: ['name', 'refText', 'sourcePath'],
      additionalProperties: false,
    },
    async run(args: any, session) {
      const cfg = await readCfg();
      const signal = session.signal ?? ctx.signal;
      const name = String(args.name ?? '').trim();
      const refText = String(args.refText ?? '').trim();
      const sourcePath = String(args.sourcePath ?? '').trim();
      if (!VOICE_NAME.test(name)) return { status: 'error', error: '音色名只能字母、数字、- 和 _。' };
      if (!refText) return { status: 'error', error: '需要参考音频的逐字稿。' };
      if (!sourcePath) return { status: 'error', error: '需要参考音频的本机路径。' };
      try {
        const wav = await readFile(sourcePath);
        if (wav.length < 1024 || !looksWav(wav)) return { status: 'error', error: '参考音频要 WAV（RIFF）文件。' };
        const saved = await saveVoice(ctx, cfg, { name, description: String(args.description ?? ''), refText, wav }, signal);
        let isDefault = false;
        if (args.setDefault === true) {
          await saveCfg(cfg.engine === 'local' ? { voice: name } : { cloudVoice: name });
          isDefault = true;
        }
        return { status: 'ok', voice: saved, bytes: wav.length, engine: cfg.engine, isDefault };
      } catch (e: any) {
        return { status: 'error', error: String(e?.message ?? e) };
      }
    },
  });

  ctx.tools.register({
    name: 'voice_delete',
    description:
      '从音色库里删掉一个音色。本机模型会同时删掉 .breeze 文件，不会再自己回来；' +
      '如果删的正好是默认音色，会自动换一个还在的。网络模型只从服务端卸载/从手动库里移除。',
    danger: 'ask',
    schema: {
      type: 'object',
      properties: { name: { type: 'string', minLength: 1, description: '要删的音色 id。' } },
      required: ['name'],
      additionalProperties: false,
    },
    async run(args: any) {
      const cfg = await readCfg();
      const name = String(args.name ?? '').trim();
      if (!name) return { status: 'error', error: '没指定要删的音色。' };
      try {
        const lib = await libraryView(ctx, cfg);
        if (!lib.voices.some((v) => v.id === name))
          return { status: 'error', error: `音色库里没有 ${name}。` };
        const result = await deleteVoice(ctx, cfg, name);
        const remaining = (await libraryView(ctx, cfg)).voices.filter((v) => v.id !== name);
        const nextDefault = remaining[0]?.id ?? '';
        const isDefault = lib.defaultVoice === name;
        if (isDefault) {
          await saveCfg(cfg.engine === 'local' ? { voice: nextDefault } : { cloudVoice: nextDefault });
        }
        const manual = cfg.cloudVoices.filter((x) => x !== name);
        const manualRemoved = cfg.engine === 'cloud' && manual.length !== cfg.cloudVoices.length;
        if (manualRemoved) await saveCfg({ cloudVoices: manual });
        const removed = result.deleted || manualRemoved;
        return { status: removed ? 'ok' : 'error', ...result, deleted: name, manualRemoved, defaultVoice: isDefault ? nextDefault : lib.defaultVoice, replacedDefault: isDefault };
      } catch (e: any) {
        return { status: 'error', error: String(e?.message ?? e) };
      }
    },
  });

  ctx.provide('voice/speak', {
    apiVersion: '1.0.0',
    config: readCfg,
    save: saveCfg,
    ensureDefaultVoice: async (options?: { signal?: AbortSignal }) => {
      const cfg = await readCfg();
      const sig = options?.signal ?? ctx.signal;
      const result = await ensureDefaultVoiceCore(ctx, cfg, sig);
      if (result.voice && result.voice !== cfg.voice) await saveCfg({ voice: result.voice });
      return result;
    },
    synthesize: async (input: { text: string; voice?: string }, options?: { signal?: AbortSignal }) => {
      const cfg = await readCfg();
      const text = String(input?.text ?? '').trim();
      if (!text) throw new Error('没有要说的内容。');
      if (Array.from(text).length > cfg.maxChars) throw new Error(`超过 ${cfg.maxChars} 字上限。`);
      const { bytes, voice, target } = await synth(ctx, cfg, text, input?.voice, options?.signal ?? ctx.signal);
      return { mime: 'audio/wav', base64: bytes.toString('base64'), bytes: bytes.length, voice, engine: target.kind, model: target.name };
    },
  });

  // ── 设置页：音色库与说话 ───────────────────────────────────
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

  ctx.web.page('/plugins/voice/speak/settings', async (_req, res) => {
    const cfg = await readCfg();
    const cfgJson = JSON.stringify(cfg).replace(/</g, '\\u003c');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>说话 · WhaleLife</title>
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
section.card[hidden],div[hidden]{display:none}
.card-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:6px}
h2{font-size:16px;margin:0}
h3{font-size:13px;margin:22px 0 10px;color:var(--muted);font-weight:500}
label{display:grid;gap:6px;font-size:13px;color:var(--muted)}
input,select{font:inherit;padding:9px 12px;border:1px solid var(--line);border-radius:7px;background:var(--paper);color:var(--ink);width:100%}
input[type=checkbox]{width:auto;margin:0}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px 18px;margin-top:12px}
.wide{grid-column:1/-1}
.row{display:flex;gap:10px;align-items:center;margin-top:18px;flex-wrap:wrap}
.row.tight{margin-top:10px}
button{font:inherit;padding:9px 14px;border:1px solid var(--line);border-radius:7px;background:var(--paper);color:var(--ink);cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
button.small{padding:4px 10px;font-size:12px}
button.danger{color:#b23a3a;border-color:#e6c9c9}
button:disabled{opacity:.55;cursor:default}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:500}
td.desc{color:var(--muted);max-width:360px}
td.ops{white-space:nowrap}
.badge{color:var(--accent);font-weight:600}
.pill{font-size:12px;padding:2px 10px;border-radius:99px;border:1px solid var(--line);color:var(--muted)}
.hint{color:var(--muted);font-size:12px;margin:10px 0 0}
.link{color:var(--accent);font-size:13px;text-decoration:none}
pre{background:var(--soft);border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin:16px 0 0;white-space:pre-wrap;font-size:12px;color:var(--muted);min-height:18px}
.scroll{overflow-x:auto}
details summary{cursor:pointer;color:var(--muted);font-size:13px}
.focus-card{outline:2px solid var(--accent);outline-offset:2px;transition:outline-color .3s}
@media (max-width:640px){.grid{grid-template-columns:1fr}body{padding:20px 16px 28px}h1{font-size:23px}header{flex-direction:column}}
</style></head><body><main>
<header><div><h1>说话</h1><p class="sub">音色库 · 试听 · 造音色 · QQ 语音</p></div><div style="display:flex;gap:8px;align-items:center"><span class="pill" id="libState">—</span><a class="link" href="/plugins/voice/settings" data-console-href="#plugin:voice">← 语音模块</a></div></header>

<section class="card" id="libraryCard">
  <div class="card-head"><h2>音色库</h2></div>
  <p class="sub" id="libNote"></p>
  <div class="row tight" id="auditionBox">
    <input type="text" id="auditionText" placeholder="试听文本（留空用默认一句）" style="max-width:420px">
    <button type="button" id="auditionDefault">试听默认音色</button>
    <button type="button" id="test">测试连接</button>
  </div>
  <audio id="auditionAudio" controls hidden style="width:100%;max-width:460px;margin-top:8px"></audio>
  <p class="hint">试听由浏览器播放，不走后台扬声器；没自动响就点播放器里的播放键。</p>
  <div class="scroll" id="voices"><p class="sub">载入中…</p></div>
  <div class="row tight" id="manualAdd" hidden><input type="text" id="manualId" placeholder="音色 id，例如 zh-CN-XiaoxiaoNeural" style="max-width:340px"><button type="button" id="addVoice">加入音色库</button></div>
</section>

<section class="card" id="genCard">
  <div class="card-head"><h2>生成音色</h2></div>
  <p class="hint" id="genNote"></p>
  <div id="designBox">
    <h3>按描述造一个新音色</h3>
    <div class="grid">
      <label>音色名<input id="cname" placeholder="narration"></label>
      <label>声音描述<input id="cdesc" placeholder="二十五岁左右女声，偏软，语速慢"></label>
      <label class="wide">试音文本（可留空）<input id="ctext" placeholder="默认一句自我介绍"></label>
      <label class="wide" style="display:flex;align-items:center;gap:8px;color:var(--ink)"><input type="checkbox" id="cdefault">顺手设为默认音色</label>
    </div>
    <div class="row"><button class="primary" type="button" id="create">生成并保存</button></div>
  </div>
  <div id="cloneBox">
    <h3>用参考音频克隆</h3>
    <div class="grid">
      <label>音色名<input id="kname" placeholder="jiejie"></label>
      <label>描述（可留空）<input id="kdesc"></label>
      <label class="wide">这段音频的逐字稿<input id="ktext"></label>
      <label class="wide">参考音频（WAV）<input type="file" id="kfile" accept=".wav,audio/wav"></label>
    </div>
    <div class="row"><button type="button" id="clone">保存克隆</button></div>
  </div>
</section>

<section class="card">
  <details><summary>高级：本机引擎路径与显存</summary>
    <div class="grid">
      <label class="wide">Breeze 可执行文件<input type="text" id="breezeExe" value="${esc(cfg.breezeExe)}"></label>
      <label class="wide">Breeze 模型文件<input type="text" id="breezeModel" value="${esc(cfg.breezeModel)}"></label>
      <label class="wide">音色目录<input type="text" id="voicesDir" value="${esc(cfg.voicesDir)}"></label>
      <label>单句上限字数<input type="number" id="maxChars" value="${cfg.maxChars}"></label>
      <label style="display:flex;align-items:center;gap:8px;color:var(--ink)"><input type="checkbox" id="play" ${cfg.play ? 'checked' : ''}>默认在本机扬声器播放</label>
    </div>
    <div class="row"><button type="button" id="saveAdv">保存高级设置</button></div>
    <p class="hint">这些只影响本机模型；网络模型用不到。</p>
  </details>
</section>
<pre id="out"></pre>
</main>
<script>
const CFG = ${cfgJson};
let lib = null;
const $ = function (id) { return document.getElementById(id); };
const out = function (v) { $('out').textContent = (typeof v === 'string') ? v : JSON.stringify(v, null, 2); };
const h = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); };
document.addEventListener('click', function (ev) {
  var a = ev.target && ev.target.closest ? ev.target.closest('[data-console-href]') : null;
  if (!a || window.top === window.self) return;
  ev.preventDefault();
  try { window.top.location.hash = a.getAttribute('data-console-href'); } catch (e) {}
});
function focusVoiceGen() {
  var focus = '';
  try { focus = sessionStorage.getItem('whalelife:voice-focus') || ''; } catch (e) {}
  if (focus !== 'genCard' && location.hash !== '#genCard') return;
  try { sessionStorage.removeItem('whalelife:voice-focus'); } catch (e) {}
  setTimeout(function () {
    var card = $('genCard');
    if (card) {
      card.scrollIntoView({ block: 'center' });
      card.classList.add('focus-card');
      setTimeout(function () { card.classList.remove('focus-card'); }, 1800);
    }
    if ($('cname')) $('cname').focus();
  }, 250);
}
async function post(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const text = await r.text();
  try { return JSON.parse(text); } catch (e) { return { ok: false, error: text || ('HTTP ' + r.status) }; }
}
function renderLib(j) {
  $('libraryCard').hidden = false;
  $('genCard').hidden = false;
  $('libState').textContent = j.engine === 'local' ? (j.online ? '本机 · 已就绪' : '本机 · 未启动') : (j.online ? '网络 · 可连通' : '网络 · 未连通');
  $('libNote').textContent = j.note || '';
  const rows = j.voices || [];
  if (!rows.length) {
    $('voices').innerHTML = '<p class="sub" style="margin:0">' + (j.capabilities.list ? '还没有音色，下面可以造一个。' : '还没有音色。先在服务商那边准备，或手动把音色 id 加进来。') + '</p>';
  } else {
    let html = '<table><thead><tr><th>音色</th><th>来源</th><th>时长</th><th>描述</th><th>操作</th></tr></thead><tbody>';
    rows.forEach(function (v) {
      const cur = v.id === j.defaultVoice;
      html += '<tr><td>' + (cur ? '<span class="badge">● </span>' : '') + h(v.id) + '</td><td>' + h(v.source || '') + '</td><td>' + (v.seconds ? v.seconds.toFixed(1) + 's' : '-') + '</td><td class="desc">' + h(v.description || '-') + '</td><td class="ops">';
      html += '<button class="small" data-hear="' + h(v.id) + '">试听</button> ';
      html += '<button class="small" data-use="' + h(v.id) + '">' + (cur ? '当前' : '使用') + '</button> ';
      html += '<button class="small danger" data-del="' + h(v.id) + '">删除</button>';
      html += '</td></tr>';
    });
    html += '</tbody></table>';
    $('voices').innerHTML = html;
  }
  Array.prototype.forEach.call($('voices').querySelectorAll('[data-use]'), function (b) {
    b.onclick = async function () { const r = await post('/plugins/voice/speak/voices/use', { name: b.dataset.use }); out(r); if (r.ok) loadVoices(); };
  });
  let audioCtx = null, audioNode = null;
  function unlockAudio() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      return audioCtx;
    } catch (e) { return null; }
  }
  async function audition(voice, btn) {
    if (!voice) { out('还没有可试听的音色。'); return; }
    if (btn) btn.disabled = true;
    const ac = unlockAudio();
    if (ac) { try { await ac.resume(); } catch (e) { } }
    out('合成中…（本机合成通常要十几秒）');
    const r = await post('/plugins/voice/speak/voices/preview', { name: voice, text: $('auditionText').value.trim() });
    if (btn) btn.disabled = false;
    if (!r.ok) { out(r.error || '试听失败'); return; }
    const au = $('auditionAudio');
    au.hidden = false;
    au.src = 'data:' + (r.mime || 'audio/wav') + ';base64,' + r.audio;
    let played = false;
    if (ac && ac.state === 'running' && r.audio) {
      try {
        const bin = atob(r.audio);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const buffer = await ac.decodeAudioData(bytes.buffer);
        if (audioNode) { try { audioNode.stop(); } catch (e) { } }
        audioNode = ac.createBufferSource();
        audioNode.buffer = buffer;
        audioNode.connect(ac.destination);
        audioNode.start();
        played = true;
      } catch (e) { played = false; }
    }
    if (!played) au.play().catch(function (e) { out('音频已生成，但浏览器没自动播放：' + (e && e.message ? e.message : '点下面的播放器按钮手动播放')); });
    out((played ? '正在播放：' : '音频已生成，点播放器播放：') + r.voice + '（' + Math.round(r.bytes / 1024) + ' KB，' + r.engine + ' 模型）');
  }
  Array.prototype.forEach.call($('voices').querySelectorAll('[data-hear]'), function (b) {
    b.onclick = function () { audition(b.dataset.hear, b); };
  });
  $('auditionDefault').onclick = function () { audition((lib && lib.defaultVoice) || CFG.cloudVoice || CFG.voice, $('auditionDefault')); };
  Array.prototype.forEach.call($('voices').querySelectorAll('[data-del]'), function (b) {
    b.onclick = async function () {
      if (!confirm('确定删除音色 ' + b.dataset.del + '？本机模型会同时删掉 .breeze 文件。')) return;
      const r = await post('/plugins/voice/speak/voices/delete', { name: b.dataset.del }); out(r); if (r.status === 'ok' || r.ok) loadVoices();
    };
  });
  $('manualAdd').hidden = j.engine !== 'cloud';
  $('designBox').hidden = !j.capabilities.design;
  $('cloneBox').hidden = !j.capabilities.clone;
  if (!j.capabilities.design && !j.capabilities.clone) $('genNote').textContent = '当前模型不支持新建音色，只能从上面的音色库里挑服务商自带的音色。';
  else if (!j.capabilities.design) $('genNote').textContent = '这个网络模型不支持按描述造音色；可以用参考音频克隆，取决于服务商是否支持。';
  else $('genNote').textContent = '造出来的音色会存成本机 .breeze 文件，随时可用。';
}
async function loadVoices() {
  const j = await post('/plugins/voice/speak/voices/list');
  if (!j.ok) { $('libraryCard').hidden = false; $('voices').innerHTML = '<p class="sub" style="margin:0">' + h(j.error || '读不到音色') + '</p>'; return; }
  lib = j;
  renderLib(j);
}
function readAdv() {
  return {
    engine: CFG.engine,
    baseUrl: CFG.baseUrl,
    voice: CFG.voice,
    modelId: CFG.modelId,
    cloudVoice: CFG.cloudVoice,
    comfyUrl: CFG.comfyUrl,
    breezeExe: $('breezeExe').value.trim(),
    breezeModel: $('breezeModel').value.trim(),
    voicesDir: $('voicesDir').value.trim(),
    maxChars: Number($('maxChars').value) || 400,
    play: $('play').checked
  };
}
$('saveAdv').onclick = async function () {
  const r = await post('/plugins/voice/config', { config: readAdv() });
  out(r); if (r.ok && r.config) Object.assign(CFG, r.config);
};
$('test').onclick = async function () { out('检测中…'); out(await post('/plugins/voice/speak/test')); };
$('addVoice').onclick = async function () {
  const r = await post('/plugins/voice/speak/voices/add', { name: $('manualId').value.trim() });
  out(r); if (r.ok) { $('manualId').value = ''; loadVoices(); }
};
$('create').onclick = async function () {
  out('生成中，大约十到三十秒…');
  const r = await post('/plugins/voice/speak/voices/create', {
    name: $('cname').value.trim(), description: $('cdesc').value.trim(),
    sampleText: $('ctext').value.trim(), setDefault: $('cdefault').checked
  });
  out(r); if (r.ok) loadVoices();
};
$('clone').onclick = async function () {
  const file = $('kfile').files[0];
  if (!file) { out('先选一个 wav 文件。'); return; }
  out('读取音频…');
  const b64 = await new Promise(function (resolve) {
    const fr = new FileReader();
    fr.onload = function () { resolve(String(fr.result).split(',')[1] || ''); };
    fr.readAsDataURL(file);
  });
  const r = await post('/plugins/voice/speak/voices/clone', {
    name: $('kname').value.trim(), description: $('kdesc').value.trim(),
    refText: $('ktext').value.trim(), base64: b64
  });
  out(r); if (r.ok) loadVoices();
};
loadVoices();
focusVoiceGen();
</script></body></html>`);
  }, { title: '说话设置', settings: true, navigation: true });

  ctx.web.api('/plugins/voice/speak/test', async (_req, res) => {
    const cfg = await readCfg();
    if (cfg.engine === 'local') {
      if (cfg.localMode === 'breeze') {
        const up = cfg.breezeAutoStart
          ? await ensureBreeze(cfg, AbortSignal.timeout(120_000)).then((r) => r.ready).catch(() => false)
          : await healthy(cfg.baseUrl);
        sendJson(res, 200, { ok: true, engine: 'local', localMode: 'breeze', online: up, baseUrl: cfg.baseUrl, voice: cfg.voice });
      } else {
        try {
          const t = targetOf(ctx, cfg);
          const r = await fetch(`${apiBase(t.base)}/models`, { signal: AbortSignal.timeout(8000) });
          sendJson(res, 200, { ok: true, engine: 'local', localMode: 'openai', online: true, status: r.status, model: t.name, baseUrl: t.base });
        } catch (e: any) {
          sendJson(res, 200, { ok: false, engine: 'local', localMode: 'openai', online: false, error: String(e?.message ?? e) });
        }
      }
      return;
    }
    try {
      const t = targetOf(ctx, cfg);
      const r = await fetch(`${apiBase(t.base)}/models`, { headers: authHeaders(t.key), signal: AbortSignal.timeout(8000) });
      sendJson(res, 200, { ok: true, engine: 'cloud', online: true, status: r.status, model: t.name, baseUrl: t.base });
    } catch (e: any) {
      sendJson(res, 200, { ok: false, engine: 'cloud', online: false, error: String(e?.message ?? e) });
    }
  });

  ctx.web.api('/plugins/voice/speak/voices/list', async (_req, res) => {
    const cfg = await readCfg();
    try {
      const lib = await libraryView(ctx, cfg);
      sendJson(res, 200, { ok: true, ...lib });
    } catch (e: any) {
      sendJson(res, 200, { ok: false, error: String(e?.message ?? e) });
    }
  });

  ctx.web.api('/plugins/voice/speak/voices/preview', async (req, res, { signal }) => {
    try {
      const body = await readJson(req, signal);
      const cfg = await readCfg();
      const name = String(body?.name ?? '').trim();
      if (!name) throw new Error('没选要试听的音色。');
      if (cfg.engine === 'local' && cfg.localMode === 'breeze' && !VOICE_NAME.test(name)) throw new Error('本机 Breeze 音色名只能字母、数字、- 和 _。');
      if (cfg.engine === 'cloud' && !CLOUD_VOICE.test(name)) throw new Error('网络音色 id 不合法。');
      if (cfg.engine === 'local' && cfg.localMode === 'openai' && !CLOUD_VOICE.test(name)) throw new Error('本机音色 id 不合法。');
      const text = (String(body?.text ?? '').trim() || '你好，这是一段用来试听音色的示例文本。').slice(0, 200);
      const limit = Math.min(cfg.maxChars, 200);
      if (Array.from(text).length > limit) throw new Error(`试听文本最多 ${limit} 字。`);
      const out = await synth(ctx, cfg, text, name, signal);
      await mkdir(ROOT, { recursive: true });
      const file = join(ROOT, `preview-${createHash('sha1').update(name).digest('hex').slice(0, 12)}.wav`);
      await writeFile(file, out.bytes);
      if (body?.play === true) await speakFile(file, cfg);
      sendJson(res, 200, {
        ok: true, voice: out.voice, bytes: out.bytes.length, engine: out.target.kind,
        model: out.target.name, engineStarted: out.started, text, file,
        mime: 'audio/wav', audio: out.bytes.toString('base64'), played: body?.play === true,
      });
    } catch (e: any) {
      sendJson(res, 400, { ok: false, error: String(e?.message ?? e) });
    }
  });

  ctx.web.api('/plugins/voice/speak/voices/add', async (req, res, { signal }) => {
    try {
      const body = await readJson(req, signal);
      const cfg = await readCfg();
      if (cfg.engine !== 'cloud') throw new Error('本机模型的音色靠生成和克隆，不需要手动加。');
      const name = String(body?.name ?? '').trim();
      if (!CLOUD_VOICE.test(name)) throw new Error('音色 id 只能用字母、数字、点、冒号、斜杠、- 和 _，最多 160 字。');
      if (!cfg.cloudVoices.includes(name)) await saveCfg({ cloudVoices: [...cfg.cloudVoices, name] });
      sendJson(res, 200, { ok: true, name });
    } catch (e: any) {
      sendJson(res, 400, { ok: false, error: String(e?.message ?? e) });
    }
  });

  ctx.web.api('/plugins/voice/speak/voices/use', async (req, res, { signal }) => {
    try {
      const body = await readJson(req, signal);
      const name = String(body?.name ?? '').trim();
      if (!name) throw new Error('没选音色。');
      const cfg = await readCfg();
      await saveCfg(cfg.engine === 'local' ? { voice: name } : { cloudVoice: name });
      sendJson(res, 200, { ok: true, voice: name });
    } catch (e: any) {
      sendJson(res, 400, { ok: false, error: String(e?.message ?? e) });
    }
  });

  ctx.web.api('/plugins/voice/speak/voices/delete', async (req, res, { signal }) => {
    try {
      const body = await readJson(req, signal);
      const cfg = await readCfg();
      const name = String(body?.name ?? '').trim();
      if (!name || !CLOUD_VOICE.test(name)) throw new Error('音色 id 无效。');
      const result = await deleteVoice(ctx, cfg, name);
      const libBefore = await libraryView(ctx, cfg);
      if (libBefore.defaultVoice === name) {
        const remaining = libBefore.voices.filter((v) => v.id !== name);
        await saveCfg(cfg.engine === 'local' ? { voice: remaining[0]?.id ?? '' } : { cloudVoice: remaining[0]?.id ?? '' });
      }
      if (cfg.engine === 'cloud' && cfg.cloudVoices.includes(name)) {
        await saveCfg({ cloudVoices: cfg.cloudVoices.filter((x) => x !== name) });
      }
      const manualRemoved = cfg.engine === 'cloud' && cfg.cloudVoices.includes(name);
      const removed = result.deleted || manualRemoved;
      sendJson(res, 200, { ok: removed, status: removed ? 'ok' : 'error', ...result, deleted: name, manualRemoved });
    } catch (e: any) {
      sendJson(res, 400, { ok: false, error: String(e?.message ?? e) });
    }
  });

  ctx.web.api('/plugins/voice/speak/voices/create', async (req, res, { signal }) => {
    try {
      const body = await readJson(req, signal);
      const cfg = await readCfg();
      const name = String(body?.name ?? '').trim();
      const description = String(body?.description ?? '').trim();
      const sampleText = String(body?.sampleText ?? '').trim() || '你好，这是一段用来试听音色的示例文本。';
      if (!VOICE_NAME.test(name)) throw new Error('音色名只能字母、数字、- 和 _。');
      if (!description) throw new Error('需要一段音色描述。');
      const { wav } = await designSample(ctx, cfg, description, sampleText, signal);
      const saved = await saveVoice(ctx, cfg, { name, description, refText: sampleText, wav }, signal);
      if (body?.setDefault === true) await saveCfg({ voice: name });
      sendJson(res, 200, { ok: true, voice: saved });
    } catch (e: any) {
      sendJson(res, 400, { ok: false, error: String(e?.message ?? e) });
    }
  });

  ctx.web.api('/plugins/voice/speak/voices/clone', async (req, res, { signal }) => {
    try {
      const body = await readJson(req, signal);
      const cfg = await readCfg();
      const name = String(body?.name ?? '').trim();
      const refText = String(body?.refText ?? '').trim();
      const description = String(body?.description ?? '').trim();
      const b64 = String(body?.base64 ?? '');
      if (!VOICE_NAME.test(name)) throw new Error('音色名只能字母、数字、- 和 _。');
      if (!refText) throw new Error('需要这段参考音频的逐字稿。');
      if (!b64) throw new Error('没有收到参考音频。');
      const wav = Buffer.from(b64, 'base64');
      if (wav.length < 1024 || !looksWav(wav)) throw new Error('参考音频要 WAV（RIFF）。');
      const saved = await saveVoice(ctx, cfg, { name, description, refText, wav }, signal);
      sendJson(res, 200, { ok: true, voice: saved });
    } catch (e: any) {
      sendJson(res, 400, { ok: false, error: String(e?.message ?? e) });
    }
  });

  ctx.logger.info('说话子插件已加载：音色库 + TTS + QQ 语音');
}

