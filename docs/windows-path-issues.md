# Windows 桌面模式的路径问题（issue #4 / #5 / #6）

三条报告都来自同一位报告者，环境一致：**Windows + 桌面 VS Code（`editorBackend: local`）+ 0.5.x**。
已在本版修复，`test/windows-sim.mjs` 覆盖了可在任意平台复现的部分。

## 共同根因

路径在整条链路上被当作**不透明字符串**：比较用 `===`、拼接不 resolve、切分用 `split('/')`。
Windows 与 POSIX 的区别（盘符大小写不敏感、反斜杠分隔符）在每一处都咬了一口，于是表现成三个看起来无关的 bug。

修复集中在新的纯函数模块 `vscode-ext/dsh-bridge/paths.js`（平台可注入，便于在 POSIX 上跑 win32 语义）。

| Issue | 层 | 根因 | 修法 |
|---|---|---|---|
| #4 工作区不匹配 | 扩展 | `workspaceMatches()` 用 `===` 比较路径；`E:\` 与 `e:\` 不等 → SSE 连不上，跟随全废 | `sameFsPath()`：win32 大小写不敏感 + 分隔符归一 |
| #5 丢盘符 `\Tdata\x.lua` | **host 为主** | `editPathOf()` 原样透传 `exec.arguments.file_path`；相对路径直达 `vscode.Uri.file()` | host `resolveEditPath()` 按会话工作区解析；扩展侧再防御性解析一次 |
| #6 diff 右侧吃缓存 | 扩展 | `openDiff()` 右侧用 `vscode.Uri.file()`，已打开的标签走 TextDocument 内存缓存 | 右侧改虚拟文档 `dsh-now://`，内容取 host 回读的 `newText` |

顺带修掉同族三处：`encodePath()` 与 diff 标题的 `baseName()` 用 `split('/')` 切 win32 路径；
`followWorkspaceOnly` 的工作区包含判断用 `p.indexOf(root + path.sep) !== 0`（盘符大小写不同时把工作区内文件误判为区外、静默不弹 diff）。

**顺序依赖**：#4 不修，SSE 连不上，#5/#6 根本观察不到。报告者能观察到 #5/#6，说明他那次盘符大小写恰好一致。

**#5 的证据强度**：该 issue 正文是截断的（818 字节，停在「VS Code 日志：」），报告者没贴日志。
所以 #5 的根因是**从代码推的**，不是从日志读到的。修复逻辑本身独立成立（相对路径必须解析），但回复该 issue 时应如实说明。

## 模拟实验覆盖了什么

`test/windows-sim.mjs`（47 项）**强制 win32 语义 + 桩化 `vscode` + 加载未修改的真实 `extension.js`**，
用报告里的路径驱动 `handleMessage()`。断言层次：

- 路径语义（`sameFsPath` / `resolveEditPath` / `canonicalizeUnder` / `baseName` / `encodePath`）
- `workspaceMatches()` 在盘符大小写、尾分隔符、正反斜杠下的结果
- `vscode.diff` 实际收到的两个 URI 的 scheme（右侧必须是 `dsh-now`，且**不得**是 `file:`）
- provider 返回的内容（左 = 本轮基线，右 = 磁盘新内容）
- 锁定/解锁在相对与绝对两种写法下映射到同一个键
- `activate()` 确实注册了**两个**虚拟 scheme（漏注册会静默废掉所有 diff）

这套实验很有价值：**它当场抓出了三个我自己写出来的缺陷**，详见 CHANGELOG。

## 模拟实验覆盖不了什么

诚实边界 —— 以下必须真机验证：

- 真实 `vscode.diff` 标签的渲染、标题、以及 VS Code 自己的 TextDocument 缓存行为
- 真实盘符大小写下 `doc.uri.fsPath` 的取值
- `--extensions-dir` / `~/.vscode/extensions` 的加载与版本比对
- Windows 文件系统的大小写不敏感是否如假设

## Windows 验证清单

### 0. 准备

```powershell
git clone https://github.com/k-ying/dsh-vsceditor.git   # 或 git pull
cd dsh-vsceditor
npm test          # 在 Windows 上跑，win32 分支用的是真实平台语义
```

把插件挂到 DSH 并设 `editorBackend: local`（设置卡片或 `~/.dsh/settings.yaml` 的 `dsh-vsceditor` 节）。

### 0b. 关键：让桌面 VS Code 拿到新扩展代码

`installDesktopExtension()` 会 `rmSync` + 整目录 `cpSync`，**但只在版本不一致时才触发**。
本版尚未发号（extension 仍是 `0.5.0`），所以三选一：

1. **本地把 `vscode-ext/dsh-bridge/package.json` 的 `version` 临时改成 `0.5.3`**（推荐，最接近真实发版路径）
2. 手动删除 `%USERPROFILE%\.vscode\extensions\dsh.dsh-bridge`，再让插件触发一次安装
3. 手动把仓库的 `vscode-ext\dsh-bridge` 整个目录拷到 `%USERPROFILE%\.vscode\extensions\dsh.dsh-bridge`

改完都要 **Reload Window**。

### 1. 验 #4（工作区匹配）

1. 桌面 VS Code 打开 `E:\projects\demo`（盘符**大写**）
2. 从终端 `cd e:\projects\demo`（盘符**小写**）后启动 DSH
3. 期望：编辑器标签页连上，状态栏显示 `DSH · 跟随`，**不再**出现「工作区不匹配」

### 2. 验 #5（相对路径）

1. 让 Agent 用**相对路径**改一个工作区内文件，例如 `Tdata\config.lua`
2. 期望：diff 标签标题显示 `DSH: config.lua ⟵ 修改前 | 当前 ⟶`，**不是** `\Tdata\config.lua`
3. 期望：标签能正常读到文件内容

### 3. 验 #6（文档缓存）—— 这条最值得先验，因为最容易看到

1. 在 VS Code 里把目标文件**作为普通标签打开**（内容例如 `5-15`）
2. 让 Agent 把该文件改成 `15-25` 并写盘
3. 期望：diff **右侧显示 `15-25`**（修复前两侧都是 `5-15`）
4. 再让 Agent 改一次（例如 `15-30`）：期望仍是**同一个** diff 标签原地刷新，右侧变 `15-30`，左侧保持 `5-15`（本轮累计）

### 4. 失败时抓什么

1. 设置里打开 `bridgeDebug`
2. 复现问题
3. 收集三份材料：
   - `/tmp/dsh-bridge-debug.log`（Windows 上即 `C:\tmp\dsh-bridge-debug.log`，扩展侧逐帧追踪）
   - `%USERPROFILE%\.dsh-editor\bridge-ext.log`（扩展侧日志）
   - `http://127.0.0.1:<DSH端口>/__dsh-vsceditor/state` 的 `lastAck`（`opened`/`timeout`/`error`）

## 回复 issue 时沿用的格式

仓库**没有** `.github/ISSUE_TEMPLATE`；报告者自己用的是一套固定格式，回复时沿用：
`概述 / 环境 / 复现 / 实际表现 / 期望 / 原因 / 建议改法`。

三条都已在代码层修复；对外回复应注明**修的是 Windows 桌面模式**，并附上本文件的验证清单。
