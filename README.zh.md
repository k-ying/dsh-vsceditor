# dsh-vsceditor

![dsh-vsceditor banner](assets/banner.zh.svg)

[English](README.md) | **简体中文**

**DeepSeek Harness 内嵌 VSCode 编辑器插件** —— 在 DSH Web 界面里嵌入一个完整的 code-server（完整版 VSCode），agent 每次写文件/改文件时自动在编辑器里弹出红绿 diff 并定位到改动行，所见即所得地"看着 AI 干活"。

## 1. 特性

- **双后端：内嵌 / 本机** —— 默认内嵌 code-server；也可切换为「本机 VS Code」，跟随、diff、锁定全部搬进你自己的桌面编辑器
- **完整 VSCode，不是玩具编辑器** —— 内嵌的是 code-server 4.x（完整 VSCode 内核），扩展、主题、快捷键、Git 面板全部可用
- **跟随模式（follow）** —— agent 调用 `write`/`edit` 工具改文件时，编辑器自动打开该文件的红绿 diff 视图并滚动到首个改动行；DSH 侧还同时内置一个只读 diff 标签页，两边都能看
- **文件锁定** —— agent 正在写某个文件期间，编辑器里该文件被锁定（防止你和 AI 同时改一个文件互相覆盖），写完自动解锁
- **工作区自动跟随会话** —— 一个 DSH 进程只跑一个 code-server；当前活跃会话的工作区变化时，编辑器自动切换到对应目录（必要时自动重启 code-server）
- **iframe 常驻不重建** —— 编辑器页面固定在 `<body>` 上、切换标签页只是隐藏/显示，不会每次点进去都新开一个 VSCode 会话
- **设置页集成** —— 「设置 → 插件 → 插件配置」里有本插件的折叠卡片：跟随开关、自动启动、端口、code-server 目录，全部即时生效并持久化（`~/.dsh/settings.yaml`）
- **零依赖** —— host/client 两端都是手写原生 JS，不依赖任何 npm 包；settings schema 用手写的 schemastery 兼容外形，不需要 `@deepseek-ai/schemastery`

## 2. 工作原理

```
┌─ DSH 进程 ─────────────────────────────────────────────┐
│  host.js（host 层 cordis 插件，进程级单例）              │
│   · 监听所有会话的 tools/pre-execute、tools/result 事件   │
│   · 捕获 write/edit 的目标路径，读出改前/改后文本          │
│   · 管理 code-server 子进程（spawn/重启/退出重试）         │
│   · 通过 webServer 暴露：                                 │
│       /__dsh-vsceditor/state|action   （控制面，页面用）   │
│       /__dsh-vsceditor-<rand>/events  （SSE → 扩展）      │
│       /__dsh-vsceditor-<rand>/rpc     （扩展 → host）     │
└───────┬──────────────────────────────▲─────────────────┘
        │ SSE: hello/follow/edit/lock/unlock/reveal
        │                              POST: ready/ack/log
┌───────▼──────────────────────────────┴─────────────────┐
│  code-server（独立进程，--auth none，仅 127.0.0.1）        │
│   └─ dsh-bridge 扩展（vscode-ext/dsh-bridge）            │
│        收到 edit 消息 → 打开红绿 diff 并定位改动行          │
│        收到 lock → 对应文件只读；unlock → 恢复             │
└────────────────────────────────────────────────────────┘
        ▲ iframe（client.js 注册到 conversation.view，
          标签页「编辑器」，常驻 body 不随切换销毁）
```

消息语义参考 ACP `session/update`：`edit {path, oldText, newText, firstLine}` 由 host 计算 diff 统计后推送，扩展负责呈现。host 以 unscoped 方式挂载，因此能看到所有会话的工具事件（scoped 事件会沿 scope 链向上流动）。

## 3. 前置要求

- DeepSeek Harness（dsh）web profile（本插件是 profile bundle，挂在 host 层）
- macOS 或 Linux（Windows 未测试；code-server 官方不支持 Windows 直装）
- **内嵌模式**：需要一个 code-server 安装（见 4.2）；**本机 VS Code 模式**：需要桌面版 VS Code。两者至少满足其一——**不装 code-server 也能用插件，只是只能用本机 VS Code 模式**

## 4. 安装

### 4.1 安装插件

**方式 A：从 GitHub 安装（推荐）**

```sh
dsh plugin --profile web add github:k-ying/dsh-vsceditor
```

`dsh plugin add` 会把包加进 `~/.dsh/profiles/web/package.json` 的依赖并自动登记到 `dsh.profile.bundles`（本插件通过 `cordis.patch.yml` 自挂载，无需手工编辑组合文件）。

**方式 B：本地目录安装**

```sh
git clone https://github.com/k-ying/dsh-vsceditor.git
dsh plugin --profile web add /path/to/dsh-vsceditor
```

### 4.2 安装 code-server（内嵌模式必需）

> ⚠️ **想用默认的内嵌编辑器，这一步不可跳过。** 插件本体不带 code-server 运行时（约 100MB）。不装的话内嵌模式不可用——「编辑器」标签页会提示"未找到 code-server"并引导你切换到**本机 VS Code 模式**（功能等价，见 5.1）。

**方式一：一键安装（推荐）**。打开「编辑器」标签页（或 设置 → 插件配置 → 内嵌 VSCode 编辑器），点击 **「⬇ 一键安装 code-server」**，弹窗会显示下载地址、实时进度百分比和安装/启动进度，可随时取消，完成后自动进入编辑器。安装到 `~/.dsh-editor`，所有工作区共用一份。

**方式二：命令行全局安装**（与一键安装等效，适合无法打开面板时）：

```sh
sh ~/.dsh/profiles/web/node_modules/dsh-vsceditor/scripts/install-code-server.sh ~/.dsh-editor
```

如果想让某个工作区用独立的 code-server，不传参数即可（默认装到当前目录的 `.dsh-editor`，优先级高于全局）：

```sh
cd <你的 DSH 工作区>   # 例如 ~/Documents/AI
sh ~/.dsh/profiles/web/node_modules/dsh-vsceditor/scripts/install-code-server.sh
```

脚本按平台（macOS arm64/x64、Linux x64/arm64/armhf）从 code-server 官方 release 下载并解压。版本固定为 4.133.0，可用 `DSH_VSCEDITOR_VERSION` 环境变量覆盖。

手动安装也可以：把 code-server 解压到以下任一位置（按查找优先级）：

1. 设置卡片里填写的 `code-server 目录`（优先级最高）
2. 环境变量 `$DSH_VSCEDITOR_HOME`
3. `<工作区>/.dsh-editor`（工作区级）
4. `~/.dsh-editor`（全局，推荐）

目录下需存在 `code-server/bin/code-server`。

> 📁 **编辑器的运行数据（user-data、配置、日志）不放在工作区里**，统一存放在全局 `~/.dsh-editor/workspaces/<哈希>-<工作区名>/` 下按工作区隔离（与 VS Code 的用户级数据目录同一范式），你的工作区目录不会被污染。旧版本曾存放在 `<工作区>/.dsh-editor`，已存在该目录的工作区会继续沿用以保留数据。

#### Windows（实验性）

code-server 官方[不发布 Windows 构建](https://github.com/coder/code-server/issues/1397)，且直接 `npm install -g code-server` 在 Windows 上是坏的（postinstall 脚本与 argon2 原生编译都会失败）。本插件提供 `scripts/install-code-server.ps1` 绕过这两个坑，手法参考 [naspenang/code-server-windows](https://github.com/naspenang/code-server-windows)（MIT）：跳过 postinstall、手动补装依赖、**从本机已安装的桌面版 VS Code 借用原生模块**。

前置条件：

- Windows 10/11 + PowerShell
- 已安装**桌面版 VS Code**，且版本与 code-server 内置的 VS Code **完全一致**（脚本会校验并报出期望版本，可用 `-CodeServerVersion` 换 code-server 版本来对齐，或加 `-SkipVSCodeVersionCheck` 强行尝试）

```powershell
cd <你的 DSH 工作区>
Set-ExecutionPolicy -Scope Process Bypass
& "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-vsceditor\scripts\install-code-server.ps1"
```

产物布局（host 端在 Windows 下按此约定查找）：

```
<工作区>\.dsh-editor\code-server\node\node.exe
<工作区>\.dsh-editor\code-server\runtime\node_modules\code-server\out\node\entry.js
```

注意：此路径未经大规模验证，仅保证 127.0.0.1 本机使用。若遇到问题，**WSL2 里是官方维护的 Linux 流程**，体验与 macOS/Linux 完全一致，是更稳妥的选择。

### 4.3 启动

```sh
dsh web
```

启动后顶栏出现「编辑器」标签页，点进去等待 code-server 就绪（首次约几秒）。标签文字旁有状态点：灰=加载中，绿=扩展已连接，黄=等待扩展连接，红=未运行/未安装 code-server/桥接未挂载。

## 5. 使用

### 5.1 本机 VS Code 模式

在「设置 → 插件 → 插件配置」里把「编辑器后端」切到 **本机 VS Code**（与内嵌 code-server 互斥，切换即时生效），或直接点「编辑器」标签页状态卡片里的「连接向导」：

1. 插件自动探测本机 VS Code（macOS `.app` 与 Spotlight、Windows 标准安装目录与 `where`、Linux `/usr/bin` 与 `which`），探测不到可在设置里手动指定路径
2. 未装桥扩展时，「编辑器」标签页的状态卡片会出现「安装扩展到本机 VS Code」按钮——点击后自动拷贝到 `~/.vscode/extensions/`（家目录，无需提权）；失败时给出手动拷贝的源/目标路径
3. 在桌面 VS Code 里 Reload Window，并**打开与 DSH 会话相同的工作区**——扩展只在工作区匹配的窗口接单，多窗口不会串台
4. 之后跟随 diff、文件锁定与内嵌模式体验一致；扩展随插件版本自动更新（提示 Reload Window 即可）

原理：桌面 VS Code 无法注入环境变量，插件改为把桥接坐标（端口/token/工作区）写入 `~/.dsh-editor/bridge.json`，扩展轮询该文件自动握手。同一份扩展代码两种模式自动分流，内嵌模式不受影响。

#### 工作区信任（Workspace Trust）

桌面 VS Code 默认对新打开的文件夹启用[受限模式](https://code.visualstudio.com/docs/editor/workspace-trust)，本插件做了完整适配：

- 桥扩展声明了 `untrustedWorkspaces: limited` 支持——**未信任的窗口也能激活并保持握手**，但不会执行任何 edit/reveal 同步指令
- 此时 DSH 侧状态点显示黄色「等待信任工作区」，编辑器标签页与连接向导都会提示；扩展侧会在 VS Code 里弹一次「管理工作区信任」的引导通知
- 在 VS Code 的信任弹窗里点「信任」（或命令面板 → `Workspaces: Manage Workspace Trust`）后**自动恢复**，无需 Reload（扩展监听 `onDidGrantWorkspaceTrust` 自动重连）
- 内嵌 code-server 以 `--disable-workspace-trust` 启动，不存在此问题

建议：DSH 工作区是你自己的目录，直接信任即可；如果会话工作区都在某个父目录下（如 `~/Documents/AI`），信任父文件夹可一劳永逸。

### 5.2 跟随模式

默认开启。agent 每次 `write`/`edit` 落地后：

- 编辑器自动切到该文件的 diff 视图（左旧右新），并滚动到首个改动行
- DSH 标签页工具栏的「跟随」勾选框可随时开关；关掉后仍会记录最近改动（recent 列表），只是不主动弹窗
- **编辑器内也能切换**：点击 VS Code 状态栏的 `DSH · 跟随/编辑` 按钮弹出菜单（切换跟随 / 重新连接），或命令面板 → `DSH Bridge: Toggle Follow Mode`；扩展会把请求发回 DSH，所有端同步生效
- 只想看工作区内的改动：设置卡片勾选「仅跟随工作区内文件」，工作区外的写入只进 recent 列表，不弹 diff

### 5.3 文件锁定

agent 开始写某文件时该文件在编辑器里变为只读（状态栏有提示），写完自动解锁。这是防冲突提示，不是安全边界。

### 5.4 设置卡片

「设置 → 插件 → 插件配置 → 内嵌 VSCode 编辑器」（默认折叠，点标题展开）：

| 配置项 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `editorBackend` | string | `embedded` | 编辑器后端：`embedded` = 内嵌 code-server；`local` = 本机桌面版 VS Code |
| `follow` | boolean | `true` | 跟随 DSH 编辑：改文件时自动弹出红绿 diff 并定位改动行 |
| `followWorkspaceOnly` | boolean | `false` | 仅跟随工作区内文件：开启后工作区外的改动只记录、不弹 diff |
| `autoStart` | boolean | `true` | DSH 启动后自动拉起 code-server；关闭后需在「编辑器」标签页手动启动 |
| `port` | number | `0` | code-server 监听端口；`0` = 随机（18200–18900）；改动会自动重启编辑器 |
| `codeServerHome` | string | `""` | 手动指定 code-server 安装目录；留空按上面的优先级自动查找 |
| `vscodePath` | string | `""` | 手动指定本机 VS Code 路径（code CLI 或 .app/Code.exe）；留空自动探测 |
| `language` | string | `auto` | 界面语言：`auto` = 跟随浏览器语言；或显式指定 `zh`、`en`、`pt-BR`、`es` |

写入即持久化到 `~/.dsh/settings.yaml` 的 `dsh-vsceditor` 节，重启后保留。也可以在 `~/.dsh/profiles/web/cordis.patch.yml` 的插件行加 `config:` 作为组合层 base（用户层覆盖 base 层）。

### 5.5 快捷键/命令

VS Code 命令面板（`Cmd/Ctrl+Shift+P`）：

- `DSH Bridge: Toggle Follow Mode` —— 切换跟随模式（也可以直接点状态栏的 `DSH` 按钮，菜单里有开关）
- `DSH Bridge: Reconnect` —— 手动重连桥接（一般不需要，扩展会自动重连）

## 6. 故障排查

**「编辑器」标签页显示"未安装 code-server" / "未找到 code-server"**
没装 code-server 或不在查找路径上。三个选择：⓪ 点页面上的「⬇ 一键安装 code-server」（推荐）；① 运行 4.2 的安装脚本（或在设置卡片填 `code-server 目录`）；② 不想装就点页面上的「改用本机 VS Code →」按钮，插件会切到本机模式并弹出连接向导。

**本机模式一直"等待信任工作区"（黄点）**
VS Code 受限模式拦截了编辑同步。在 VS Code 里信任该工作区（命令面板 → `Workspaces: Manage Workspace Trust`），信任后自动恢复，不用 Reload。详见 5.1 的「工作区信任」小节。

**一直"等待扩展连接"（黄点）**
扩展只在 code-server 窗口打开时才会启动扩展宿主。点进「编辑器」标签页等几秒；如果页面是旧的（code-server 重启过），刷新整个 DSH 页面。

**改动不弹 diff**
① 看标签页状态点是否绿色；② 看工具栏「跟随」是否勾选；③ 扩展日志：`DSH_BRIDGE_DEBUG=1` 重启 DSH 后看 `/tmp/dsh-bridge-debug.log`（本机模式看 `~/.dsh-editor/bridge-ext.log`）。

**端口被占用/想换端口**
设置卡片改端口，保存后编辑器自动重启到新端口。

**code-server 进程残留**
DSH 退出时不会强杀已脱离的子进程。手动清理：`pkill -f 'code-server.*--auth none'`。

**设置 → 插件 → 插件配置 整页空白**
这是本插件 0.1.x 时代踩过的坑：settings schema 缺 `toJSON` 会把整页拖挂。0.2.0 已修复；若仍出现请提 issue 并附 `~/.dsh/settings.yaml` 的 `dsh-vsceditor` 节。

## 7. 卸载

```sh
dsh plugin --profile web remove dsh-vsceditor
```

再删掉运行数据（可选）：`~/.dsh-editor`（含 `workspaces/` 下按工作区隔离的运行数据；旧版可能还有 `<工作区>/.dsh-editor`）、`~/.vscode/extensions/dsh.dsh-bridge`、`~/.dsh/settings.yaml` 里的 `dsh-vsceditor` 节。

## 8. 安全说明

- code-server 以 `--auth none` 启动，但**只监听 127.0.0.1**，不暴露到局域网；请勿改绑到 0.0.0.0
- 桥接端点（SSE/RPC）带每次启动随机生成的 token，扩展通过环境变量拿到
- 插件不收集、不上传任何数据；code-server 启动参数带 `--disable-telemetry --disable-update-check`

## 9. 目录结构

```
dsh-vsceditor/
├── cordis.patch.yml              # profile bundle 自挂载补丁（host 层插件行）
├── package.json                  # dsh.bundle.patch / dsh.client 声明
├── lib/
│   ├── host.js                   # host 半：进程管理、事件桥、settings 命名空间
│   └── client.js                 # client 半：标签页 iframe、设置卡片（手写 bundle 格式）
├── scripts/
│   ├── install-code-server.sh    # code-server 下载安装脚本（macOS/Linux）
│   └── install-code-server.ps1   # code-server 安装脚本（Windows 实验性）
└── vscode-ext/
    └── dsh-bridge/               # 随 --extensions-dir 注入 code-server 的桥接扩展
        ├── package.json
        └── extension.js
```

`vscode-ext/extensions.json` 与 `vscode-ext/.obsolete` 是 code-server 启动时按本机路径自动生成的运行态文件，已 gitignore。

## 10. 开发

改 `lib/host.js` 后需要重启 DSH 生效；改 `lib/client.js` 只需刷新页面（bundle 路由按请求读盘）。校验组合是否仍能被 profile 正确装配：

```sh
dsh --profile web --dump-config
```

### 版本号规范

插件（根 `package.json`）与桥扩展（`vscode-ext/dsh-bridge/package.json`）的版本号保持 **major.minor 一致**——例如插件 `0.3.x` 配套扩展 `0.3.x`；两者的 patch 位可独立递增。host 端会把扩展版本与插件内置版本（`vscode-ext/dsh-bridge/package.json` 的 `version`）比对，不一致时自动重新拷贝到 `~/.vscode/extensions/` 并提示 Reload Window，所以升级插件后无需手动重装扩展。

## License

[MIT](LICENSE)
