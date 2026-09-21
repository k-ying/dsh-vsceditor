# dsh-vsceditor · `fix/windows-paths` — Windows 部署与验证手册

**读者**：这台 Mac 上的你 + Windows 工作区里的那个 dsh agent。
**目的**：把 `#4 / #5 / #6` 三个 Windows 桌面模式的路径 bug 的修复，在一台真实 Windows 上跑一遍并留下证据。
**本文档在仓库里的副本**：`docs/windows-verification.md`（checkout 分支后可直接读）。

---

## 0. 一句话背景

三个 issue 同源：**路径被当成不透明字符串**（`===` 比较、不 `resolve` 的拼接、`split('/')` 切分）。
macOS 上能跑的自动化已经全绿（`npm test` → 106 项），但下面这四件事**只有真机能证伪**：

1. 真实 `vscode.diff` 标签的渲染与标题
2. 真实 VS Code `TextDocument` 的内存缓存行为（#6 的根源）
3. 真实盘符大小写下 `doc.uri.fsPath` 的取值（#4 的根源）
4. `%USERPROFILE%\.vscode\extensions` 的加载与版本比对

所以这份手册的操作全在 Windows 侧。**根因分析与证据强度见 `docs/windows-path-issues.md`，本文只讲怎么做、怎么判定。**

### 现在的代码状态

| 项 | 值 |
|---|---|
| 仓库 | `k-ying/dsh-vsceditor`（你的主仓，issues 都在这） |
| 分支 | `fix/windows-paths` |
| 代码提交 | `ccd51ef` *fix(windows): 修复 Windows 桌面模式的路径处理（#4 / #5 / #6）* |
| 分支头 | 其上加了一个**纯文档**提交（*docs: 新增 Windows 部署与验证手册…*），代码一行没动 |
| `main` | `a2387ff`，**未合并**分支，主线保持已验证状态 |
| 插件版本 | `0.5.2`（**未改动**） |
| 扩展版本 | `0.5.0`（**未改动**） |
| 发版 | 无 tag、无 npm 发布 |

> ⚠️ 版本号没动，正是第 2.4 节那个坑的来源，请务必读完再动手。

---

## 1. 分支里改了什么（验收时对着看）

| 文件 | 层 | 作用 |
|---|---|---|
| `lib/host.js` | host | 新增 `resolveEditPath()`：会话给的相对路径（`Tdata\config.lua`）按会话工作区解析成绝对路径 → 修 **#5**；新增 `isInsideOrEqualPath()`：`followWorkspaceOnly` 的包含判断改成大小写不敏感 + 分隔符归一 → 修同族 bug |
| `vscode-ext/dsh-bridge/paths.js` | 扩展 | **新增文件**。纯函数、平台可注入（`sameFsPath` / `resolveEditPath` / `baseName` / `encodePath` / `fsKey` / `canonicalizeUnder`） |
| `vscode-ext/dsh-bridge/extension.js` | 扩展 | 工作区匹配改用 `sameFsPath` → 修 **#4**；`lock/unlock/hello/edit/reveal` 统一走解析后的路径 → 修 **#5**；diff 右侧改用虚拟文档 `dsh-now://`（左侧 `dsh-snap://`）→ 修 **#6** |
| `test/windows-sim.mjs` | 测试 | **新增**，53 项。强制 win32 语义 + 桩化 `vscode` + 加载**未修改的真实** `extension.js` |
| `docs/windows-path-issues.md` | 文档 | 逐条根因、模拟实验的覆盖边界、证据强度说明 |

**顺序依赖**：#4 不修，SSE 连不上，`#5 / #6` 根本观察不到。所以下面的验证顺序不能打乱。

---

## 2. 部署

### 2.1 拿到分支代码

**那台机器上还没有 clone：**

```powershell
git clone https://github.com/k-ying/dsh-vsceditor.git "$env:USERPROFILE\.dsh\plugins\dsh-vsceditor"
cd "$env:USERPROFILE\.dsh\plugins\dsh-vsceditor"
git checkout fix/windows-paths
```

**已经有 clone：**

```powershell
cd "$env:USERPROFILE\.dsh\plugins\dsh-vsceditor"
git status                     # 若脏，先手动处理，别硬 checkout
git fetch origin
git checkout fix/windows-paths
git log --oneline -3           # 期望看到 fix(windows) 那条，及其上一条纯文档提交
```

clone 到别处也行，**只要第 2.2 节能证明 DSH 加载的就是它**。

### 2.2 证明 DSH 真的在跑这份代码 ← 最容易翻车的一步

`dsh plugin add <本地目录>` 装法会在 profile 里建一个**指向 clone 的链接**；从 GitHub/npm 装法则是一份**独立拷贝**。
如果是独立拷贝，你在 clone 里 checkout 分支，**DSH 跑的还是旧代码**，后面所有验证都是假阴性。

```powershell
Get-ChildItem "$env:USERPROFILE\.dsh\profiles" -Directory | ForEach-Object {
  $p = Join-Path $_.FullName 'node_modules\dsh-vsceditor'
  if (Test-Path $p) {
    [pscustomobject]@{
      Profile   = $_.Name
      Link      = (Get-Item $p -Force).LinkType
      HostFixed = [bool](Select-String -Path (Join-Path $p 'lib\host.js') -Pattern 'resolveEditPath' -Quiet)
      ExtFixed  = Test-Path (Join-Path $p 'vscode-ext\dsh-bridge\paths.js')
    }
  }
}
```

**判定：`HostFixed` 与 `ExtFixed` 必须都是 `True`。**

- `Link = Junction` / `SymbolicLink` 且指向 clone → 正常。
- `Link` 为空（普通目录）→ 是独立拷贝，让 DSH 重新指向本地 clone：

  ```powershell
  dsh plugin --profile <上面的 Profile> add "$env:USERPROFILE\.dsh\plugins\dsh-vsceditor"
  ```

  然后**重跑上面的检查**，必须变 True 才继续。
- 查不到任何 profile → 插件根本没装，先按 README 4.1 装，再回来。

### 2.3 重启 DSH 进程

插件是被 host 进程 `require` 进来的，**改文件后必须重启 DSH 进程**（刷新页面没用）。

### 2.4 ⚠️ 关键坑：桌面 VS Code 用的还是旧扩展

`installDesktopExtension()` 会 `rmSync` + 整目录 `cpSync`，**但只在 `extVersion !== BUNDLED_EXT_VERSION` 时才触发**（`ensureDesktopExtSynced()`）。
现在两边都是 `0.5.0` → **它什么都不做**。
UI 上那个「安装/更新扩展」按钮同样只在版本不一致时才渲染出来（`lib/client.js` 里按钮条件是 `!extInstalled || !extUpToDate`）。

**所以你直接启动 VS Code，跑的一定是修之前的扩展。** 三选一：

**A. 临时改版本号（推荐 —— 最接近真实发版路径，顺带把安装流程也验了）**

```powershell
cd "$env:USERPROFILE\.dsh\plugins\dsh-vsceditor"
# 把 vscode-ext\dsh-bridge\package.json 的 "version" 改成 0.5.3（只改这一行，不要提交）
```

重启 DSH 并进入本机模式 → 自动整套拷贝；UI 上也会出现「更新扩展」按钮可手动点。
验证结束后一定还原：`git checkout -- vscode-ext/dsh-bridge/package.json`

**B. 手动拷目录（零改动，最确定）**

```powershell
Remove-Item "$env:USERPROFILE\.vscode\extensions\dsh.dsh-bridge" -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item "$env:USERPROFILE\.dsh\plugins\dsh-vsceditor\vscode-ext\dsh-bridge" `
          "$env:USERPROFILE\.vscode\extensions\dsh.dsh-bridge" -Recurse -Force
```

**C. 删掉已装目录让插件重装**（走真实安装路径，但要人到 UI 上点一下「安装扩展」）

三条改完都要 **Reload Window**：VS Code 里 `Ctrl+Shift+P` → `Developer: Reload Window`；不生效就整个退出再打开。

**装没装上的唯一判定**（`paths.js` 是本分支新增文件，旧扩展里根本没有）：

```powershell
Test-Path "$env:USERPROFILE\.vscode\extensions\dsh.dsh-bridge\paths.js"   # 必须 True
Test-Path "$env:USERPROFILE\.vscode\extensions\dsh.dsh-bridge\package.json" # 顺带确认版本
```

### 2.5 切到本机 VS Code 模式

设置 → 插件配置 → 内嵌 VSCode 编辑器 → **编辑器后端 = 本机 VS Code**（`editorBackend: local`）。
VS Code 不在默认安装路径时，同时填 `vscodePath`。

等价于 `%USERPROFILE%\.dsh\settings.yaml`：

```yaml
dsh-vsceditor:
  editorBackend: local
  vscodePath: ''        # 只有非默认安装路径才填
  follow: true
```

### 2.6 先建日志目录（诊断用，别等出问题才建）

扩展的 `dbg()` 写死 `/tmp/dsh-bridge-debug.log`。Windows 上 `/tmp` 会落到**当前盘符的 `\tmp`**（通常是 `C:\tmp`），而且写入在 `try/catch` 里 —— **目录不存在就静默丢弃，你什么都看不到**。

```powershell
New-Item -ItemType Directory -Force C:\tmp
```

---

## 3. 验证用例

### 用例 1（前提）：#4 工作区匹配

1. 桌面 VS Code 打开工作区，**盘符用大写**：`E:\projects\demo`
2. 终端里 `cd e:\projects\demo`（**盘符小写**）后启动 DSH

| | 期望 |
|---|---|
| 通过 | 编辑器页签连上；状态栏显示 `DSH · 跟随`；不再出现「工作区不匹配 / workspace mismatch」 |
| 失败 | 扩展不连、跟随不生效 → 后面两条不用测了，直接进第 4 节抓证据 |

### 用例 2（先看这条，最容易看到）：#6 diff 右侧吃缓存

1. 在 VS Code 里把目标文件**作为普通标签打开**，内容例如 `5-15`
2. 让 Agent 把该文件改成 `15-25` 并写盘

| | 期望 |
|---|---|
| 通过 | diff **右侧显示 `15-25`**；左侧是 `5-15` |
| 失败 | 两侧都是 `5-15`（= 走了 `TextDocument` 内存缓存，修复没生效） |
| 追加检查 | 再让 Agent 改成 `15-30` → **同一个** diff 标签原地刷新：右侧 `15-30`，左侧仍是 `5-15`（本轮累计基线） |

### 用例 3：#5 相对路径丢盘符

1. 让 Agent 用**相对路径**改工作区内文件，例如 `Tdata\config.lua`

| | 期望 |
|---|---|
| 通过 | diff 标题为 `DSH: config.lua ⟵ 修改前 \| 当前 ⟶`（英文界面则是 `before \| current`）；标签能正常读到内容 |
| 失败 | 标题出现 `\Tdata\config.lua`（丢了盘符）；或标签读不到内容 |

### 用例 4：回归 —— 别让修复把别的平台弄坏

两台机器都跑：

```powershell
cd <clone 目录>
npm test
```

期望恰好两行：

```
CONTROL TRUST SMOKE PASSED (53 checks)
WINDOWS SIM PASSED (53 checks)
```

任何一行不是 `PASSED`，把完整输出发回来。

---

## 4. 失败时抓这三份材料

1. 设置里打开 **`bridgeDebug`**（运行时开关，SSH/SSE 下发，不用重启扩展）
2. 复现一次问题
3. 收集：

```powershell
# ① 扩展侧逐帧追踪（先确认 2.6 建过目录）
Get-Content C:\tmp\dsh-bridge-debug.log -Tail 200

# ② 扩展侧日志
Get-Content "$env:USERPROFILE\.dsh-editor\bridge-ext.log" -Tail 200

# ③ 桥接状态机：看 lastAck（opened / timeout / error）
Invoke-RestMethod http://127.0.0.1:<DSH端口>/__dsh-vsceditor/state | ConvertTo-Json -Depth 6
```

`lastAck` 的三态非常有指向性：`opened` = 扩展收到了帧但 diff 没开起来（看 ① 里 `vscode.diff` 那一帧的两个 scheme 是不是 `dsh-snap` / `dsh-now`）；`timeout` = 帧没送到（看 ② 的连接与工作区匹配）；`error` = 扩展侧抛了异常（① 里有原文）。

---

## 5. 回滚

```powershell
cd "$env:USERPROFILE\.dsh\plugins\dsh-vsceditor"
git checkout main          # 或回到原来那个提交
git checkout -- vscode-ext/dsh-bridge/package.json   # 还原 2.4-A 的临时改动
```

扩展按 2.4-B 反向拷回旧内容（建议动手前先把 `dsh.dsh-bridge` 备份成 `dsh.dsh-bridge.old`），然后 Reload Window。

本分支没改协议，host 与扩展可以短暂不同版本共存，但仍建议两边一起回。

---

## 6. 给 Windows 工作区的 dsh agent：你能做与不能做的

**你能独立做的（做完把原始输出贴回来）**

1. `npm test`（用例 4），贴完整输出。
2. 跑第 2.2 节的 profile 检查脚本，贴结果表。
3. `New-Item -ItemType Directory -Force C:\tmp`。
4. 按第 4 节收集三份材料（含 `/state` 的 `lastAck`）。
5. 用 `Select-String` 证明**实际被加载**的两份代码是新的：
   - `lib\host.js` 含 `resolveEditPath`
   - `%USERPROFILE%\.vscode\extensions\dsh.dsh-bridge\paths.js` 存在
6. 任何 diff 标签的标题/内容，如果人已经描述过现象，你可以据此定位到具体哪一帧、哪一行。

**必须人眼/人手做的（别替他做）**

- VS Code 里 diff 标签的标题和右侧内容（渲染结果）
- `Developer: Reload Window`、退出重开 VS Code
- 在设置里切「编辑器后端」、开关 `bridgeDebug`

**汇报格式**（沿用报告者那套）：`概述 / 环境 / 复现 / 实际表现 / 期望 / 证据`。
其中「环境」必须写明：Windows 版本、VS Code 版本与安装路径、DSH 端口、`editorBackend`、扩展目录里 `package.json` 的 version。

---

## 7. 诚实边界：这套自动化**证明不了**什么

`test/windows-sim.mjs` 能忠实复现的只有三样：**路径语义**、**交给 `vscode.diff` 的两个 URI 的 scheme**、**provider 返回的内容**。
它用桩替代掉、因而**必须靠这次真机验证覆盖**的是：

- 真实 `vscode.diff` 标签的渲染、标题、以及 VS Code 自己的 `TextDocument` 缓存行为
- 真实盘符大小写下 `doc.uri.fsPath` 的真实取值
- `%USERPROFILE%\.vscode\extensions` 的加载与版本比对
- Windows 文件系统的大小写不敏感是否与我们的假设一致

另外：**#5 的 issue 正文是截断的**（818 字节，停在「VS Code 日志：」，报告者没贴日志），所以 #5 的根因是**从代码推出来的**，不是从日志读出来的。修复逻辑本身独立成立（相对路径必须解析），但对外回复时应如实说明这层证据差异。
