# 语音模块 · AI 一键部署手册

这份手册给「另一个 AI」或另一个人执行。目标是把本机语音模型装进 **WhaleLife 仓库里的语音插件目录**，不依赖任何外部固定路径。

## 0. 适用范围

- 系统：Windows 10/11 x64。
- WhaleLife 已能启动，默认 Web 地址 `http://127.0.0.1:9270`。
- Node.js 22+、PowerShell 7（`pwsh`）。
- 磁盘至少预留 5GB；模型约 3.6GB，运行包约 180MB。
- 推荐 NVIDIA / AMD / Intel 显卡并支持 Vulkan；没有独显也能跑 CPU，但会慢很多。
- 需要能访问 GitHub Releases 和 Hugging Face。

部署后的目录固定为：

```text
<WhaleLife>/plugins/voice/
├─ plugin.yaml
├─ README.md
├─ AI-DEPLOY.md
├─ data/
│  ├─ config.json
│  ├─ deploy/                         # 下载缓存和 .part 断点
│  ├─ breeze/
│  │  ├─ bin/breeze-tts-2-vX.Y.Z-windows-x64-vulkan/
│  │  │  └─ breeze-server.exe
│  │  ├─ models/breeze-tts-2-q8_0.gguf
│  │  ├─ voices/*.breeze
│  │  └─ output/                      # 唱歌页「一键生成念白人声轨」的输出
│  └─ songs/                          # 曲目库：放已分离好的歌曲人声（WAV/MP3/M4A/FLAC/OGG）
└─ sub/
   ├─ speak/
   └─ sing/
```

说话 `speak` 和唱歌 `sing` 是语音模块的独立子插件，分别安装到 `plugins/voice/sub/speak`、`plugins/voice/sub/sing`，设置页分别是 `/plugins/voice/speak/settings`、`/plugins/voice/sing/settings`。0.14.0 起它们各自作为商店条目发布；主插件包只含根目录，不再包含 `sub/`。

**不要**把模型装到插件目录以外的私人目录。插件只使用自己的 `data` 目录；如果配置里保留旧路径，部署时会迁移到插件目录。无图形环境或非 Windows 机器可以跳过 Breeze，直接使用本机 OpenAI 兼容服务或网络 TTS。

## 1. 把插件放进目标仓库

如果目标仓库还没有这个插件，把整个 `plugins/voice` 目录复制到：

```text
<WhaleLife>\plugins\voice
```

确认存在：

```text
<WhaleLife>\plugins\voice\plugin.yaml
<WhaleLife>\plugins\voice\index.ts
<WhaleLife>\plugins\voice\shared.ts
<WhaleLife>\plugins\voice\sub\speak\plugin.yaml
<WhaleLife>\plugins\voice\sub\sing\plugin.yaml
<WhaleLife>\plugins\voice\sub\sing\index.ts
```

`plugin.yaml` 里应当是：

```yaml
id: voice
name: 语音模块
sub: [speak, sing]
```

## 2. 启动 WhaleLife

在仓库根目录启动 WhaleLife，确认：

```powershell
Invoke-RestMethod http://127.0.0.1:9270/api/status
```

返回里至少有 `voice`；安装了子插件后还应有 `voice/speak`、`voice/sing`，且 `status` 为 `active`。

如果插件没加载，先在 WhaleLife 设置页重载插件，或执行：

```powershell
$Base = 'http://127.0.0.1:9270'
$Session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
Invoke-RestMethod "$Base/api/login" -Method Post -WebSession $Session -ContentType 'application/json' -Body '{"password":""}' | Out-Null
Invoke-RestMethod "$Base/api/plugin" -Method Post -WebSession $Session -ContentType 'application/json' -Body '{"id":"voice","action":"reload"}'
```

如果目标机器设置了登录密码，把 `{"password":""}` 换成实际密码。

## 3. 一键部署

### 方式 A：打开设置页点按钮

打开：

```text
http://127.0.0.1:9270/plugins/voice/settings
```

在「本机语音一键部署」卡片点「一键部署本机语音」。页面会显示：

- 运行包版本和大小
- 模型大小
- 音色数量
- 服务是否在线
- 下载进度和当前阶段

### 方式 B：AI / 无头执行（推荐给其他 AI）

在 PowerShell 7 里执行下面整段。它只使用部署接口，不需要浏览器：

```powershell
$Base = 'http://127.0.0.1:9270'
$Session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
Invoke-RestMethod "$Base/api/login" -Method Post -WebSession $Session -ContentType 'application/json' -Body '{"password":""}' | Out-Null

# 1) 先看现状：已安装就不要重复下载
$Status = Invoke-RestMethod "$Base/plugins/voice/deploy/status" -Method Post -WebSession $Session -ContentType 'application/json' -Body '{}'
$Status | ConvertTo-Json -Depth 8

# 2) 缺文件才部署；已就绪也可以执行，它只会补缺
if (-not $Status.running) {
  Invoke-RestMethod "$Base/plugins/voice/deploy" -Method Post -WebSession $Session -ContentType 'application/json' -Body '{}' | Out-Null
}

# 3) 轮询到结束（最多约 10 分钟）
for ($i = 0; $i -lt 120; $i++) {
  Start-Sleep -Seconds 5
  $Now = Invoke-RestMethod "$Base/plugins/voice/deploy/status" -Method Post -WebSession $Session -ContentType 'application/json' -Body '{}'
  "{0}  {1}  {2}%  {3}" -f (Get-Date -Format 'HH:mm:ss'), $Now.stage, $Now.percent, $Now.message
  if (-not $Now.running) { break }
}

# 4) 输出最终结果
$Now | ConvertTo-Json -Depth 8
if ($Now.stage -ne 'done') { throw "部署没有完成：$($Now.error)" }
```

### 方式 C：直接调用单条接口

```text
POST /plugins/voice/deploy/status
POST /plugins/voice/deploy
POST /plugins/voice/deploy/update
POST /plugins/voice/deploy/cancel
```

取消后 `.part` 文件保留，下次部署会从断点继续。

### 更新已有 Breeze

运行包有新版本时，设置页会出现「更新 Breeze 到 vX」按钮。也可以直接调用：

```powershell
$Status = Invoke-RestMethod "$Base/plugins/voice/deploy/status" -Method Post -WebSession $Session -ContentType 'application/json' -Body '{}'
if ($Status.updateAvailable -and -not $Status.running) {
  Invoke-RestMethod "$Base/plugins/voice/deploy/update" -Method Post -WebSession $Session -ContentType 'application/json' -Body '{}' | Out-Null
}
```

更新只替换 Breeze 运行包，不改模型、音色和 `config.json` 里的模型设置。下载包进入解压前，会先用该发行资产自带的官方 SHA256 摘要校验；摘要缺失或不匹配就停止安装，不会解包坏包。更新时只会短暂停掉本实例登记且仍能核对归属的 Breeze，完成后自动用新版本重启；`previousVersion` 会记录更新前版本，`updateAvailable=false` 表示已是最新。已是最新时调用更新接口会直接返回 `stage=done`，不会重复下载或重启。

如果 GitHub 运行包下载报 `fetch failed`，插件会改用 `curl` 命令重试；Windows 10+ 和主流 Linux/macOS 都自带 `curl`，也可以用高级设置里的 `curlPath` 指向其他位置。下载缓存在 `data/deploy`，中断后可续传。

## 4. 验收

### 4.1 部署状态

要求：

```text
stage = done
running = false
online = true
installed.binary = true
installed.model = true
installed.voices >= 1
missing 为空数组
updateAvailable = false
```

`installed.exe`、`installed.modelPath`、`installed.voicesDir` 必须都在：

```text
<WhaleLife>\plugins\voice\data\breeze
```

### 4.2 模型连接

```powershell
Invoke-RestMethod "$Base/plugins/voice/test" -Method Post -WebSession $Session -ContentType 'application/json' -Body '{}' | ConvertTo-Json
```

应返回 `ok: true`、`engine: local`、`online: true`。

### 4.3 说话子插件

```powershell
Invoke-RestMethod "$Base/plugins/voice/speak/voices/list" -Method Post -WebSession $Session -ContentType 'application/json' -Body '{}' | ConvertTo-Json -Depth 6
```

应返回 `ok: true`，并且 `voices` 至少有一个音色（新部署通常生成 `default`）。如果已有用户音色，会沿用第一个可用音色。

### 4.4 实际合成

```powershell
$Voices = (Invoke-RestMethod "$Base/plugins/voice/speak/voices/list" -Method Post -WebSession $Session -ContentType 'application/json' -Body '{}').voices
$Name = $Voices[0].id
$Body = @{ name = $Name; text = '语音模块部署完成，这是一段测试。' } | ConvertTo-Json -Compress
$Result = Invoke-RestMethod "$Base/plugins/voice/speak/voices/preview" -Method Post -WebSession $Session -ContentType 'application/json' -Body $Body
$Result | Select-Object ok, voice, engine, model, bytes, mime, error | Format-List
```

要求 `ok: true`、`bytes > 0`、`mime: audio/wav`。

### 4.5 运行进程（可选）

```powershell
Get-CimInstance Win32_Process -Filter "Name='breeze-server.exe'" |
  Select-Object ProcessId, ExecutablePath, CommandLine | Format-List
```

`ExecutablePath` 必须位于：

```text
<WhaleLife>\plugins\voice\data\breeze\bin
```

如果还指向旧目录，说明迁移没有生效，重跑一次一键部署。

## 5. 部署阶段说明

| stage | 含义 |
| --- | --- |
| `check` | 检查运行包、模型、音色 |
| `binary` | 下载或迁移 Breeze 运行包、解压 |
| `model` | 下载或迁移 q8_0 模型 |
| `start` | 启动 Breeze，等待 `/health` 就绪 |
| `voice` | 准备默认音色 |
| `done` | 全部完成 |
| `error` | 失败，看 `error` |
| `cancelled` | 用户取消 |

## 6. 常见问题

| 现象 | 处理 |
| --- | --- |
| 运行包显示「有更新」 | 点「更新 Breeze 到 vX」或调 `POST /plugins/voice/deploy/update`；模型和音色会保留。 |
| 更新报 `fetch failed` | 插件会自动回退系统 `curl`，重新点一次即可；仍失败时检查 `github.com` 和 `release-assets.githubusercontent.com` 是否可达。 |
| 下载 GitHub 很慢或失败 | 重试；`.part` 会续传。必要时给机器配置代理，确认能访问 `github.com` 和 `huggingface.co`。 |
| 模型下载到 99% 不动 | 等待校验；如果报“不完整”，重新点部署，会从 `.part` 继续。 |
| 磁盘不足 | 至少留 5GB；模型 3.6GB，解压包另占约 180MB。 |
| `online=false`，启动超时 | 检查显卡驱动 / Vulkan；检查 8139 端口是否被占用；看 `data/breeze` 下模型是否完整。 |
| 显存被 ComfyUI 占用 | 保持 `comfyUrl` 为 `http://127.0.0.1:8188`，部署和合成会自动让它卸载模型。 |
| 没有音色 | 重跑部署；或到 `/plugins/voice/speak/settings` 用“按描述生成”造一个。 |
| 端口 9270 被占用 | 改 WhaleLife Web 端口，并同步修改手册里的 `$Base`。 |
| 登录 401 | 用目标机器实际密码替换 `{"password":""}`。 |

## 7. 可选：网络 TTS

不装本机模型也能用网络语音：

1. 在 WhaleLife「模型服务」新建一个 `tts` 类型、`openai-compatible` 协议的连接。
2. 打开 `/plugins/voice/settings`，切到「网络模型」，选择该模型并填写音色 id。
3. 保存后用 `/plugins/voice/test` 验证。

## 8. 可选：唱歌（Seed-VC）

唱歌是语音模块的独立子插件，安装到 `plugins/voice/sub/sing`，控制台设置页是 `/plugins/voice/sing/settings`。0.14.0 起单独作为商店条目发布。它不是一键部署范围，需要单独的 Python 环境和 Seed-VC 仓库。默认在语音模块目录 `plugins/voice/data/seed-vc` 查找，也可用环境变量指向已有环境：

```powershell
$env:WHALELIFE_SING_ROOT = 'D:\path\to\seed-vc'
$env:WHALELIFE_SING_PYTHON = "$env:WHALELIFE_SING_ROOT\.venv\Scripts\python.exe"
$env:WHALELIFE_SING_RUNNER = "$env:WHALELIFE_SING_ROOT\run_seedvc.py"
$env:WHALELIFE_FFMPEG = 'ffmpeg'
```

设置后重启 WhaleLife，再打开 `/plugins/voice/sing/settings` 上传人声轨。唱歌页也支持用 Breeze 一键生成念白人声轨（带进度条、阶段日志和取消），把本地音频上传到 `data/breeze/output` 后直接选用，以及从 `data/songs` 曲目库选一首带旋律的歌曲人声。

## 9. AI 执行约束

给执行部署的 AI：

1. 先读 `deploy/status`，不要不看状态就重复下载。
2. 只把文件放到 `<WhaleLife>\plugins\voice\data\breeze`，不要写到插件目录以外的私人目录。
3. 不要删除 `data/config.json`、`data/breeze/voices` 或用户已有的 `.breeze`。
4. 轮询 `deploy/status` 直到 `running=false`；`stage=done` 才算成功。
5. `stage=error` 时停止，把 `error` 和 `message` 原样回报，不要盲目重试多次。
6. 验收必须包含 `/plugins/voice/test`、`/plugins/voice/speak/voices/list` 和一次实际合成。
7. 不要用 `taskkill` 清理其他进程，除非部署明确报端口冲突。

## 10. 分发包说明

0.14.0 是三个独立商店条目，主包只含主插件：

- `voice-0.14.0-win32-x64.wlpkg.gz`：只含主插件根目录，安装到 `<WhaleLife>\plugins\voice`；不含 `sub/`。
- `speak-0.6.2-win32-x64.wlpkg.gz`：说话子插件，作为 `voice/speak` 条目安装到 `<WhaleLife>\plugins\voice\sub\speak`。
- `sing-0.9.1-win32-x64.wlpkg.gz`：唱歌子插件，作为 `voice/sing` 条目安装到 `<WhaleLife>\plugins\voice\sub\sing`。

从旧合包升级时，商店会先卸载旧父包，再安装 0.14.0 主包，并按旧包的 `bundledPluginIds` 重新安装说话和唱歌的独立子包；`plugins/voice/data` 不删，配置、音色和任务记录保留。旧的 0.9.4、0.13.1 发行包在商店目录里标记为 `legacy`，只用于识别已安装版本和提供升级来源，不再作为新安装目标。

三个包都来自本仓库，代码文件不拆到别的仓库。包内不含 `data/breeze`、模型、音色和下载缓存。手动安装时先装主插件，再按需安装说话和唱歌；装好后按第 3 节执行一键部署，模型和运行包会自动下载到 `data` 下。

如果包来自别人已经部署过的机器，仍然建议先检查 `data/breeze` 是否被误带进来；带了也可以直接用，但会失去“一键部署”的干净初始状态。

