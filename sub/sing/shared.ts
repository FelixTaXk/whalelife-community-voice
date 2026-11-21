/*! 唱歌插件共享路径与基础工具：复用语音模块的数据目录和通用工具，不单独保存模型。 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export {
  clampNumber, esc, freeComfy, isInside, looksWav, normalize, runProcess, speakFile, stamp,
  type Resolved,
} from '../../shared.ts';

const WIN = process.platform === 'win32';

export const VOICE_ROOT = process.env.WHALELIFE_VOICE_ROOT
  || fileURLToPath(new URL('../..', import.meta.url));
export const DATA_ROOT = join(VOICE_ROOT, 'data');
export const BREEZE_ROOT = join(DATA_ROOT, 'breeze');

const SING_ROOT = process.env.WHALELIFE_SING_ROOT || join(DATA_ROOT, 'seed-vc');
const FFMPEG = process.env.WHALELIFE_FFMPEG || 'ffmpeg';
const COMFY_SITE = process.env.WHALELIFE_COMFY_SITE || '';

export const SING = {
  python: process.env.WHALELIFE_SING_PYTHON
    || join(SING_ROOT, '.venv', WIN ? 'Scripts' : 'bin', WIN ? 'python.exe' : 'python'),
  runner: process.env.WHALELIFE_SING_RUNNER || join(SING_ROOT, 'run_seedvc.py'),
  cwd: SING_ROOT,
  refs: process.env.WHALELIFE_SING_REFS || join(SING_ROOT, 'refs'),
  input: process.env.WHALELIFE_SING_INPUT || join(SING_ROOT, 'input'),
  output: process.env.WHALELIFE_SING_OUTPUT || join(SING_ROOT, 'output', 'whalelife'),
  ffmpeg: FFMPEG,
  comfySite: COMFY_SITE,
};
