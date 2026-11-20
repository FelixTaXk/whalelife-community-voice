# 语音模块

语音模块只负责「接哪个语音模型」和「共享配置」，具体的说话、唱歌各是一个子插件：

| 子插件 | 页面 | 工具 | 服务 |
| --- | --- | --- | --- |
| 说话 `speak` | `/plugins/voice/speak/settings` | `say_out_loud`、`qq_say`、`voice_list`、`voice_use`、`voice_create`、`voice_clone`、`voice_delete` | `voice/speak` |
| 唱歌 `sing` | `/plugins/voice/sing/settings` | `voice_sing` | `voice/sing` |

主页面 `http://127.0.0.1:9270/plugins/voice/settings` 只管模型接入：本机 Breeze 或 OpenAI 兼容网络 TTS、连接测试、本机引擎路径与显存。音色库、试听、造音色、唱歌都在各自子页面里。

## 本机语音一键部署

主设置页的「本机语音一键部署」卡片用于第一次装本机模型。所有文件都放在本插件自己的目录，不依赖作者的机器路径：

```text
plugins/voice/
├─ data/
│  ├─ config.json
│  ├─ deploy/                 # 下载压缩包和 .part 断点文件
│  └─ breeze/
│     ├─ bin/breeze-tts-2-vX.Y.Z-windows-x64-vulkan/
│     ├─ models/breeze-tts-2-q8_0.gguf
│     ├─ voices/*.breeze
│     └─ output/              # 唱歌页生成的人声轨
```

- 自动检查 Breeze 运行包、q8_0 模型和音色文件；已有可用文件就跳过，不会重复下载。
- 运行包有新版本时，卡片会出现「更新 Breeze 到 vX」；只替换运行包，模型和音色保留，更新时短暂停一次语音。
- 缺运行包时下载 GitHub 最新 Windows Vulkan 包，解压前先用该发行资产自带的官方 SHA256 摘要校验；摘要缺失或不匹配时停止安装，坏包会被删除。GitHub 下载走 Node fetch，证书链异常时自动回退系统 `curl`。
- 缺模型时下载 `breeze-tts-2-q8_0.gguf`（约 3.6GB）到 `data/breeze/models`。
- 如果配置里还是旧的外部路径，会优先迁移到插件目录：同盘用硬链接，跨盘自动复制。
- 启动服务后，如果音色目录为空，会用一段固定描述生成默认音色；已有音色则直接采用。
- 下载支持断点续传：进度存在 `.part` 文件里，取消或中断后下次接着下。

接口：

- `POST /plugins/voice/deploy/status`：安装状态、文件大小、缺失项和当前进度。
- `POST /plugins/voice/deploy`：开始部署；已有服务在跑也能执行，只会补缺。
- `POST /plugins/voice/deploy/update`：检查并更新 Breeze 运行包，保留模型和音色；已是最新时直接返回。
- `POST /plugins/voice/deploy/cancel`：取消当前下载/部署。

给别人或别的 AI 看的一键部署手册在 [AI-DEPLOY.md](AI-DEPLOY.md)。

## 模型接入

- **本机 Breeze**：默认。没起会自动拉起；显存被 ComfyUI 占用时会先让它卸载模型。
- **网络 TTS**：在「模型服务」里配好 OpenAI 兼容连接，再回到语音模块选它。地址统一按 `baseUrl + /v1` 使用。
- 配置存在 `plugins/voice/data/config.json`，父子插件共用这一份。

主插件提供的服务（合成直接走共享实现，不依赖子插件服务能否被父级看到）：

```ts
const voice = ctx.get('voice');
await voice.config();
await voice.save({ voice: 'xiaochi_soft' });
await voice.synthesize({ text: '你好' });
await voice.sing({ sourcePath: '...' }); // 通过 voice_sing 工具转给唱歌子插件
```

## 说话（子插件 speak）

- 音色库：列表、试听、设为默认、删除；本机模型按描述造新音色，或上传参考 WAV 克隆。
- 合成：本机 Breeze 与网络 OpenAI 兼容 TTS 共用一套入口；输出 WAV 峰值归一到 0.95。
- 播放：本机扬声器、QQ 私聊语音（`qq_say`，依赖 QQ 插件和私聊白名单）。
- 页面接口：
  - `POST /plugins/voice/speak/test`
  - `POST /plugins/voice/speak/voices/list|preview|add|use|delete|create|clone`

## 唱歌（子插件 sing，第一期 Seed-VC）

唱歌是可选能力，需要另外准备 Seed-VC 环境。默认按插件目录 `data/seed-vc` 查找，也可以用环境变量指向已有环境：

| 环境变量 | 默认 |
| --- | --- |
| `WHALELIFE_SING_ROOT` | 插件目录 `data/seed-vc`；如果本机已有 `D:\AI\seed-vc\.venv` 会自动沿用 |
| `WHALELIFE_SING_PYTHON` | `<SING_ROOT>/.venv/Scripts/python.exe` |
| `WHALELIFE_SING_RUNNER` | `<SING_ROOT>/run_seedvc.py` |
| `WHALELIFE_SING_REFS` | `<SING_ROOT>/refs` |
| `WHALELIFE_SING_INPUT` | `<SING_ROOT>/input` |
| `WHALELIFE_SING_OUTPUT` | `<SING_ROOT>/output/whalelife` |
| `WHALELIFE_FFMPEG` | `ffmpeg`（或本机已有的 `D:\dafeiyu\ffmpeg\bin\ffmpeg.exe`） |
| `WHALELIFE_COMFY_SITE` | 空；需要复用 ComfyUI 的 CUDA torch 时填它的 `site-packages` |

- 唱歌页的「开始唱」卡片里默认展示「曲目库」；另有两个页签「用 Breeze 念白」和「上传本地人声」。曲目库默认读 `data/songs`，同时列出 Seed-VC 自带示例。把已经分离好的歌曲人声放进去，选曲目后直接开始唱；非 WAV 会先转 WAV。曲目本身必须带旋律。
- 「用 Breeze 念白」页签里可以选 `data/breeze/output` 里已有的人声轨，也可以把本地 WAV/MP3/M4A/FLAC 上传到该目录；上传后会转成 44.1 kHz 单声道 WAV 并出现在列表里。
- 「一键生成念白人声轨」用当前音色把歌词或文本念成 WAV，存到 `data/breeze/output` 并自动选中。生成过程有进度条、阶段和带时间戳的日志，可以取消。音色库为空时会提示并跳到「说话 · 生成音色」；上传本地人声不受音色库限制。
- 唱歌页里的「上传本地人声」仍然可以直接把文件送去 Seed-VC，不写入 Breeze 目录；两种上传互不影响。
- 默认参考音是 `refs/xiaochi_breeze_ref.wav`（周小迟，Breeze 生成，约 19.6 秒）。
- 输出落在 `output/whalelife`，页面可试听，也可选群聊发群语音。
- 唱歌前会让 ComfyUI 卸载模型，并只停掉本实例登记且仍能核对上归属的 Breeze，避免误杀另一个实例的服务；下一次说话会自动拉起 Breeze。

### 参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| 扩散步数 | 30 | 越高越细，越慢 |
| 相似度 CFG | 0.7 | 越接近参考音色，过高会失真 |
| 升降调 | 0 | 半音；男声唱女声可试 +12 |

### 接口

- `POST /plugins/voice/sing/refs`：列出参考音。
- `POST /plugins/voice/sing/generated`：列出 `data/breeze/output` 里的人声轨和音色库。
- `POST /plugins/voice/sing/songs`：列出 `data/songs` 和 Seed-VC 示例曲目。
- `POST /plugins/voice/sing/generate/start`：body `{ text, voice? }`，立即返回 `{ id, job }`，后台生成；`job` 含 `state/stage/progress/elapsedMs/logs`。
- `POST /plugins/voice/sing/generate/status`：body `{ id }`，轮询进度；完成后 `job.result` 带 `path/bytes/voice`。
- `POST /plugins/voice/sing/generate/cancel`：body `{ id }`，取消正在生成的任务。
- `POST /plugins/voice/sing/upload`：body `{ base64, filename }`，把本地音频转成 WAV 存进 `data/breeze/output`，返回 `path/bytes`。
- `POST /plugins/voice/sing/generate`：同步版生成接口，body `{ text, voice? }`，保留给脚本调用；音色库为空返回 409 `no_voices`。
- `POST /plugins/voice/sing/convert`：body `{ sourcePath, ref?, steps?, cfgRate?, pitch? }`，`sourcePath` 可在 `data/breeze/output` 或曲目库里；或 `{ base64, filename, ... }` 用上传的人声。返回 WAV base64。子插件路由前缀是 `/plugins/voice/sing/`，所以转换接口带 `/convert`，避免和精确路径 `/plugins/voice/sing` 冲突。
- `POST /plugins/voice/sing/send`：body `{ base64, groupId }`，作为群语音发送。

### 限制

- 第一期只换音色，不分离整首歌的伴奏；源音频要是已经分离好的人声轨。
- 一键生成人声轨是 Breeze 把人声文本念成 WAV，不会自动作曲或生成旋律；要唱某首歌，仍要提供带旋律的人声轨。
- 参考音越干净越像；真人 20–30 秒干声最好，Breeze 生成的参考音偏播音。
- 28 秒的歌在 RTX 4070 上约 9 秒推理，加模型加载约 20–30 秒。
- 第二期再考虑 DiffSinger/OpenUtau 或 ACE-Step 的清唱 SVS。

## 备份

重构前的单体实现备份在仓库的 `.artifacts/voice-pre-split-20261120/`。

## 手动安装

1. 下载本仓库（`git clone` 或 Code → Download ZIP）。
2. 把仓库内容放进 WhaleLife 本体的 `plugins/voice/` 目录；**目录名必须是 `voice`**（manifest 要求 id 与目录同名）。
3. 重启本体，或到控制台「插件管理」里重载该插件。
4. 在「插件管理」确认状态为「运行中」；首次使用请打开插件设置页完成必要配置。

本插件不包含任何运行时数据（`data/` 已被忽略），升级时直接覆盖源码即可保留你自己的配置。
