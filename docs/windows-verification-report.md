# dsh-vsceditor `fix/windows-paths` —— Windows 真机验证报告

**验证机器**:Parallels 虚拟机上的 Windows 10 Pro 22H2(非 mac 侧)
**验证日期**:2026-09-23
**验证对象**:分支 `fix/windows-paths` @ `d8f5f67`(代码提交 `ccd51ef`)
**执行者**:Windows 工作区里的 dsh agent + 人手操作

> **溯源说明**:本报告最初写在 Windows 侧的共享工作目录里,现随分支归档进仓库。
> 文中所有 `C:\...` / `%USERPROFILE%` 路径都是**那台验证机器**的,属于现场记录,不是可移植路径。
> 复现脚本已一并移到 [`docs/evidence/probes/`](evidence/probes/),其中的绝对路径需要按你的机器重指。
> 手册(部署与判定)见 [`docs/windows-verification.md`](windows-verification.md);§7 列出的偏差已在归档时同步修正。

---

## 0. 结论摘要

### 修复本身:**三个 issue 全部通过真机验证** ✅

| # | 问题 | 结论 | 证据强度 |
|---|---|---|---|
| **#4** | 工作区匹配(盘符大小写) | ✅ 生效 | **强** —— 盘符大小写差异是机器上**自然出现**的,非构造 |
| **#5** | 相对路径丢盘符 | ✅ 生效 | **强** —— 真实相对路径调用工具,帧内绝对路径 + 标题纯文件名 |
| **#6** | diff 右侧吃 `TextDocument` 缓存 | ✅ 生效 | **强** —— 帧级日志 + 人眼确认渲染 |
| 用例 4 | `npm test` 回归 | ✅ 53 + 53 | 强 |
| §7 缺口 4 | 真机 FS 大小写不敏感假设 | ✅ 53/53 | 强 |

### 顺带发现:**2 个缺陷,均与 Windows 平台无关** ❌

| 缺陷 | 位置 | 平台相关? | 论证方式 |
|---|---|---|---|
| **A** SSE 每 2.5s 重连(自维持循环) | `extension.js:593-672` | **否** | 最小复现器(`sse-loop-repro.mjs`)**纯 Node http,零平台 API**,复现出与真机完全相同的日志序列 |
| **B** `editKeyOf` 去重键碰撞 | `extension.js:408-413` | **否** | 函数只用 `length` / `charCodeAt` / `+`,无平台分支;win32 与 posix 路径**同样碰撞** |

> 详细论证见 §5.3。

---

## 1. 环境

| 项 | 值 |
|---|---|
| Windows | Windows 10 Pro 22H2,build **19045.6466**,AMD64,Parallels 虚拟机 |
| VS Code | **1.138.0** x64,用户版 |
| VS Code 路径 | `C:\Users\apple\AppData\Local\Programs\Microsoft VS Code\` |
| `code.cmd` | `%LOCALAPPDATA%\Programs\Microsoft VS Code\bin\code.cmd`(命中 `cliCandidates()` win32 候选 → `vscodePath` 无需填) |
| VS Code commit | `7debcd0e2acdea1c52de81bf9ee1620444407dda` |
| DSH | **0.1.5-rc.2**,`DSH_HOME=C:\Users\apple\.dsh`,profile=**web**,端口 **51173** |
| 插件版本 | **0.5.2** |
| 扩展版本 | **0.5.0** |
| Node | v24.21.0(DSH 自带 `%LOCALAPPDATA%\dsh-studio\tools\node\v24.21.0`) |
| `editorBackend` | `local` |
| 插件安装方式 | `Junction` → `C:\Users\apple\.dsh\plugins\dsh-vsceditor` |
| §2.2 判定 | `web | Junction | HostFixed=True | ExtFixed=True` |

### ⚠️ 两处环境差异(报告里必须写明)

1. **这台机器没有 `git`**。§2.1 的 `git clone` 无法照做 —— 分支代码是用 node 拉 GitHub tarball 解出来的:
   `https://codeload.github.com/k-ying/dsh-vsceditor/tar.gz/refs/heads/fix/windows-paths`
   因此插件目录里**没有 `.git`**,§5 的 `git checkout main` 回滚**不可用**(替代方案见 §8)。
2. **没有 `E:` 盘**(只有 C/D/Y/Z)。用例 1 的 `E:\projects\demo` 只是举例盘符,**关键是大小写差异本身**,盘符可替换。

### §2.4 那个"版本坑"在本机不成立

手册说两边都是 `0.5.0` → `ensureDesktopExtSynced()` 什么都不做。但该函数是:

```js
if (d.cli && d.extInstalled && !d.extUpToDate) installDesktopExtension()
```

它要求 `extInstalled === true`。本机扩展**从未装过**,所以自动同步本来也不会触发 —— 但同样因为 `extInstalled=false`,
UI 按钮的条件 `!extInstalled || !extUpToDate`(`client.js:1253`)**一定为真**,连接向导第 2 步也会自动装(`client.js:993`)。

**结论:全新机器上不需要改版本号、也不需要手动拷贝,走真实安装路径即可。**
反过来,**手动拷贝会让 `extInstalled=true`、`extUpToDate=true`,把真实安装流程跳过去。**

---

## 2. 用例 1 —— #4 工作区匹配 ✅

**这是本次最有价值的一条:盘符大小写差异是这台机器上自然出现的,不是构造的。**

`GET /__dsh-vsceditor/state`:

```json
{
  "extConnected": true,
  "extReady": {
    "mode": "desktop",
    "version": "0.5.0",
    "workspace": "c:\\Users\\apple\\ai",     ← 小写 c:
    "trusted": true
  },
  "workspace": "C:\\Users\\apple\\ai"        ← 大写 C:
}
```

- `extReady.workspace` 来自 `extension.js:637` 的 `vscode.workspace.workspaceFolders[0].uri.fsPath`
- 两侧字符串**真的不同**(`c:` vs `C:`),`extension.js:272` 用 `sameFsPath` 比对 → 匹配 → `extConnected: true`
- 旧代码那句 `===` 在这两个真实字符串上是 `false` → 扩展**永不连接**,即 #4

### ⭐ 这条回答了手册 §7 的第 3 个缺口

> §7:"真实盘符大小写下 `doc.uri.fsPath` 的真实取值"

**答案:`uri.fsPath` 报的是小写盘符 `c:`,而 host 的工作区根是大写 `C:`。**

---

## 3. 用例 3 —— #5 相对路径 ✅

**方法**:用 `edit` 工具,`file_path` 传**相对路径** `wintest\Tdata\config.lua`。
`host.js:711` 的 `editPathOf` 读的正是工具调用里的原始 `file_path`,再交给 `resolveEditPath`。

`C:\tmp\dsh-bridge-debug.log`:

```
recv: lock   C:\Users\apple\ai\wintest\Tdata\config.lua
recv: unlock C:\Users\apple\ai\wintest\Tdata\config.lua
recv: edit   C:\Users\apple\ai\wintest\Tdata\config.lua    ← 绝对路径、盘符完整
onEdit start, follow=true
calling vscode.diff, windowFocused=false visibleEditors=2
snap provider called, key=c:\Users\apple\ai\wintest\Tdata\config.lua hit=true
now  provider called, key=c:\Users\apple\ai\wintest\Tdata\config.lua hit=true
diff opened for config.lua                                  ← baseName → 纯文件名
```

`lastAck`:
```json
{"kind":"edit","path":"c:\\Users\\apple\\ai\\wintest\\Tdata\\config.lua",
 "opened":true,"timeout":false,"error":""}
```

`recent[0].path` = `C:\Users\apple\ai\wintest\Tdata\config.lua`(绝对)。
**人眼确认**:标题 = `DSH: config.lua ⟵ 修改前 | 当前 ⟶`,内容可读。

**反面对照(旧代码)**:`editPathOf` 会把 `wintest\Tdata\config.lua` **原样**发出,
扩展 `vscode.Uri.file()` 按进程盘符解析 → `\wintest\Tdata\config.lua`(**无盘符**)→
正是 issue 里"标题丢盘符 / 标签读不到内容"。

---

## 4. 用例 2 —— #6 diff 缓存 ✅

### 4.1 主检查

**前提(重要)**:用 pwsh 直接落盘 `wintest\cache-test.txt` = `5-15`(**不经工具调用**,避免插件提前建快照),
再由**人在 VS Code 里作为普通标签打开**。日志里 `visibleEditors=1` 证明前提成立。

改成 `15-25` 后:

```
recv: edit C:\Users\apple\ai\wintest\cache-test.txt
onEdit start, follow=true
calling vscode.diff, windowFocused=false visibleEditors=1     ← 你打开的那 1 个编辑器在
snap provider called, key=c:\Users\apple\ai\wintest\cache-test.txt hit=true
now  provider called, key=c:\Users\apple\ai\wintest\cache-test.txt hit=true
diff opened for cache-test.txt
```

`lastAck` = `{"opened":true,"timeout":false,"error":""}`

**人眼确认**:右侧 **`15-25`**、左侧 `5-15`、标题 **`DSH: cache-test.txt ⟵ 修改前 | 当前 ⟶`**。

**机制**:右侧走 `dsh-now://` 虚拟文档(`extension.js:363,720`),内容来自 **host 的磁盘读取**(帧里的 `newText`),
**不经过 VS Code 的 `TextDocument` 缓存** —— 这就是 #6 的修复点。
两个 provider 的 key 都是**小写 `c:`**,说明 host 的 `C:` 被 `canonicalizeUnder` 规范化到了 VS Code 的拼写,map 才能命中(同族修复)。

### 4.2 追加检查(同一轮内两次改动)

⚠️ **手册这条期望值缺了一个前提,见 §7 偏差 #1。**

严格版(同一轮内连续改两次,中间不插用户消息):`15-30` → `15-40` → `15-50`

```
recv: turn                                          ← 本轮开始
recv: edit ...cache-test.txt                        ← 第 1 次:基线 = 15-30
... diff opened for cache-test.txt
recv: edit ...cache-test.txt                        ← 第 2 次
now provider called, key=c:\...\cache-test.txt hit=true
onEdit dedup skip for c:\...\cache-test.txt         ← 被去重(缺陷 B)
```

**人眼确认:左 `15-30`、右 `15-50`、仍然只有一个标签。**

- **轮次级基线正确** —— 左侧跨两次改动**保持不变**(`15-30`,不是 `15-40`)
- **原地刷新正确** —— 右侧连续更新,单标签

> 注意:右侧能刷新到 `15-50`,是因为 `extension.js:475` 的 `currents.set()` 会 fire 虚拟文档 change 事件。
> **缺陷 B 的 dedup 跳掉的只是 `openDiff`**,内容更新并未被阻断 —— 这点对评估缺陷 B 的严重性很关键。

---

## 5. 本次新发现的缺陷

### 5.1 缺陷 A:SSE 每 2.5 秒重连(自维持循环)

**现象**
- `bridge-ext.log` 无尽循环:`SSE 流错误：aborted` → `SSE 已连接`
- `dsh-bridge-debug.log` 里 `recv: hello` 每 **~2.5s** 一次(2500ms 正是 `scheduleReconnect` 的延迟)

**根因(客户端,不在服务端)**

```
connectSSE() 被调用两次(或任何一次多余的 scheduleReconnect)
  └─ 第 2 次在 extension.js:609  state.sseReq.destroy() 掉【仍然活着】的第 1 条流
       └─ 第 1 条的 res.on('error') 收到 'aborted'  (extension.js:655)
            └─ scheduleReconnect()  → 2500ms 后 setTimeout  (extension.js:666-672)
                 └─ connectSSE() → 又 destroy 掉上一条 → 回到上一行
```

**一旦 `scheduleReconnect()` 在 `state.sseReq` 仍指向活流时被调用,循环就永不停止。**

可能的最初触发点(均为 VS Code API 事件,平台无关):

| 位置 | 事件 |
|---|---|
| `extension.js:806` | `activate()` |
| `extension.js:802` | `onDidGrantWorkspaceTrust` |
| `extension.js:796` | `onDidChangeWorkspaceFolders` |
| `extension.js:729,752` | 手动「重新连接」命令 / 状态栏菜单 |

**排除服务端**
- 旁路客户端 `sse-lifetime.mjs` 挂同一 SSE 端点,**30 秒未收到 `end`/`error`**,流稳定
- `host.js:806-837` 除建立时的 `hello` 外**没有任何周期性心跳**
- `extension.js` 里**没有 `setInterval`、没有 `createFileSystemWatcher`** —— 2.5s 只可能来自 `scheduleReconnect` 的 `setTimeout`

**影响**
- 状态栏连接态闪烁、日志刷屏
- destroy/reconnect 的瞬间若有 edit 帧,**可能丢帧**
- 本机实测中 diff 仍能正常弹出(`lastAck.opened = true`),所以是**可靠性隐患**而非确定性故障

**建议修法**

最小改动:让"主动顶替"和"被动断开"区分开,并在成功连接时清掉待定定时器。

```js
function connectSSE() {
  if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
  if (state.sseReq) {
    state.sseReq.__superseded = true;   // 主动顶替:不要让它的 error 再排重连
    try { state.sseReq.destroy(); } catch (e) {}
    state.sseReq = null;
  }
  ...
  // 各 handler 开头加:
  //   if (req.__superseded) return;
}
```

或更直接:让 `connectSSE()` 幂等 —— `if (state.sseReq && state.connected) return;`

---

### 5.2 缺陷 B:`editKeyOf` 去重键碰撞(短字符串退化)

**现象**:同一轮内第二次改动被 `onEdit dedup skip` 吞掉(`lastAck.dedup = true`)。

**根因**(`extension.js:408-413`):

```js
function editKeyOf(fsPath, newText) {
  const t = typeof newText === 'string' ? newText : '';
  let h = 0;
  for (let i = 0; i < t.length; i += 97) h = (h * 31 + t.charCodeAt(i)) | 0;
  return fsPath + '|' + t.length + '|' + h;
}
```

步长 `i += 97`,所以**任何短于 97 字符的字符串循环体只跑一次**,`h` 退化成 `charCodeAt(0)`。
去重键实际只剩 **fsPath + 长度 + 首字符** 三个维度。

复算证明(`dedup-key-collision.mjs`):

```
"5-15"   -> c:\Users\apple\ai\wintest\cache-test.txt|4|53
"15-25"  -> c:\Users\apple\ai\wintest\cache-test.txt|5|49
"15-30"  -> c:\Users\apple\ai\wintest\cache-test.txt|5|49
"15-40"  -> c:\Users\apple\ai\wintest\cache-test.txt|5|49
"15-50"  -> c:\Users\apple\ai\wintest\cache-test.txt|5|49   ← 与 15-40 同 key

"local M = {}"  vs "local N = {}"    -> COLLIDE
"x = 1"         vs "x = 2"           -> COLLIDE
"15-40"         vs "25-40"           -> distinct(首字符不同)
"15-40"         vs "15-400"          -> distinct(长度不同)
```

注释(`extension.js:404-405`)写的意图是"**同一份**编辑帧在 30s 窗口内只处理一次
(SSE 重连、多路径投递)",但实现把"等长同首字符"的**不同**编辑也判成同一份。

**实际影响**(已实测)

| 影响 | 是否发生 |
|---|---|
| 右侧内容仍然刷新 | ✅ 正常(`extension.js:475` 的 `currents.set()` fire change 事件) |
| 不再聚焦已有 diff 标签 | ❌ 退化 |
| 不再定位到改动行(`firstLine`) | ❌ 退化 |
| **diff 标签被用户关掉后,30s 内再改同一文件不会重新弹出** | ❌ **退化**(`extension.js:478-482` 在 `openDiff` 之前 early return) |

**建议修法**

`i += 97` 看起来是想"避免给大文档做全量哈希"的抽样优化,但抽样哈希不可能抗碰撞。而这里要判等的其实是
"**是不是同一份帧**",最贴合注释意图、又最简单的做法是直接记住上一帧:

```js
let lastEditPath = '', lastEditText = '', lastEditAt = 0;
// ...
if (fsPath === lastEditPath && msg.newText === lastEditText && Date.now() - lastEditAt < 30000) {
  // dedup
}
lastEditPath = fsPath; lastEditText = msg.newText; lastEditAt = Date.now();
```

(代价是留一份字符串;若担心内存,再退一步改成全量哈希 `for (let i = 0; i < t.length; i++)`。)

**附带建议**:`editKeyOf` **没有导出**在 `__test`(`extension.js:820` 只有
`handleMessage, workspaceMatches, openDiff, normPath, pathKeyOf, isProtected, snapshots, currents, state, bridge`),
所以这条逻辑**无法被单元测试覆盖**。建议一并导出并补回归用例。

---

### 5.3 平台无关性论证(用户特意问的)

**结论:两个缺陷都与 Windows 平台无关。**

#### 静态证据

对 `vscode-ext/dsh-bridge/extension.js` 全文检索 `process.platform` / `win32` / `darwin` / `path.sep`:

```
命中 1 处:第 818 行
  // stubbed \`vscode\` and a forced win32 platform, so the Windows desktop reports
```

**唯一命中是注释。整个扩展文件没有任何平台分支。** 因此这两个缺陷在代码层面**不可能**是平台条件性的。

#### 缺陷 A 的动态证据

`sse-loop-repro.mjs` —— **纯 Node `http`,不含任何平台 API、不含路径处理、不含 VS Code**,
忠实复刻 `connectSSE` / `scheduleReconnect` / `state.sseReq` 的簿记逻辑与 host 的 SSE 路由:

```
SSE server on 127.0.0.1:54493  (node v24.21.0, win32)

--- SCENARIO 1: connectSSE() called ONCE ---
  over 9.0s, connections established : 1
  verdict                       : stable (no loop)

--- SCENARIO 2: connectSSE() called TWICE ---
  over 13.0s, connections established : 6
  event sequence : reqerr:socket hang up -> connected -> error:aborted -> connected
                   -> error:aborted -> connected -> error:aborted -> ...
  verdict        : *** RECONNECT LOOP ***
```

`error:aborted -> connected -> error:aborted -> connected -> ...` 与真机
`bridge-ext.log` 的 `SSE 流错误：aborted` → `SSE 已连接` **序列完全一致**。

该复现器不依赖任何平台特性,在任何能跑 Node 的平台上都会得到同样结果 →
**缺陷 A 是纯客户端簿记 bug。**

#### 缺陷 B 的动态证据

`editKeyOf` 只用 `String.length`、`String.prototype.charCodeAt`、数值运算和字符串拼接 ——
`charCodeAt` 由 ECMAScript 规定为 UTF-16 码元,**各平台一致**。且 `fsPath` 只是 key 的前缀,
碰撞完全发生在 `(t.length, h)` 这一对里:

```
=== PLATFORM INDEPENDENCE ===
  win32 fsPath   "15-40" vs "15-50" -> COLLIDE
  posix fsPath   "15-40" vs "15-50" -> COLLIDE
```

→ **缺陷 B 是纯算法 bug。**

#### 诚实边界

- 两个缺陷我**只在 Windows 上实际观测到**。上面给出的是"代码无平台分支 + 最小复现器不依赖平台"的论证,
  属于**强推断**;要 100% 坐实,需在 macOS 上跑一次同样的流程(看 `bridge-ext.log` 是否也出现 2.5s 循环)。
- 但**缺陷 B 的碰撞是纯数学事实**,与运行环境无关,这一点无需再验。

> **归档时补测(2026-09-24,macOS/darwin,node v26.7.0)**:上一条的边界已撤掉一半 ——
> `sse-loop-repro.mjs` 在 macOS 上跑出与真机**完全相同**的结果:
> `SCENARIO 1`(调用一次)= 1 条连接、稳定;`SCENARIO 2`(调用两次)= 13s 内 6 条连接,
> 序列 `reqerr:socket hang up -> connected -> error:aborted -> connected -> ...`,退出时定时器仍在待命。
> `dedup-key-collision.mjs` 结果同样一致。
> 因此**「客户端簿记 bug」这半不再依赖平台推断**;仍未观测到的是「macOS 真实 VS Code 里也存在
> 足以触发双次 `connectSSE()` 的事件序列」—— 本机 `bridge-ext.log` 里 6 次 `SSE 流错误:aborted`
> 都是**孤立单次**(内嵌模式页面重载所致),没有形成 2.5s 风暴。

---

## 6. 用例 4 与额外证据

### `npm test` ✅

```
CONTROL TRUST SMOKE PASSED (53 checks)
[dsh-bridge] mode=none
WINDOWS SIM PASSED (53 checks)
```
exit code 0 · node v24.21.0 · npm 11.19.0

### 真机路径语义探针 ✅ 53/53

`work\probe\win-path-probe.mjs` —— 补的正是手册 §7 承认"模拟证明不了"的**第 4 条**
(*Windows 文件系统的大小写不敏感是否与我们的假设一致*)。模拟是**注入** `platform='win32'` + 桩化 fs;
探针反过来用**默认 platform** 调**真实** `paths.js`,再拿**真实 NTFS** 交叉验证:

- 真实 NTFS 确实能用小写拼写解析到同一目录,`dev+ino` 相同 → `isCaseInsensitiveFs()===true` 的物理前提成立
- 小写盘符 `c:\...` 真实可解析
- `canonicalizeUnder` 把 `c:\users\...\projcase` 还原成真实大小写 `C:\Users\...\ProjCase`
- 覆盖 `host.js` 的 `platform===undefined` **生产分支**(`isInsideOrEqualPath`)—— smoke test 永远显式传 platform,这条只有真 win32 机器才跑到
- `demo2` vs `demo` 前缀陷阱、盘符大小写、尾分隔符全过

**一处良性观察**(非 bug):`encodePath('C:\\')` 会留尾斜杠 `"/C%3A/"`(不丢弃 split 出的空段)。
只对**裸盘符根**成立,diff 流程只传文件 fsPath,不可达。

---

## 7. 文档偏差(建议修 `docs/windows-verification.md`)

> **状态:5 条已在归档时全部修正** —— 本节保留为「手册哪里为什么改」的记录,实测数据也回填进了手册正文。

1. **§3 用例 2 追加检查** —— 期望"左侧**仍**是 `5-15`"**缺了前提:两次改动必须在同一轮对话内**。
   实测:若中间插一条用户消息(新一轮),`host.js:729-741` 会把基线重置为**本轮动手前**的内容。
   本次实测:跨轮 → 左 `15-25` / 右 `15-30`(预测与实测一致);同一轮内 → 左 `15-30` / 右 `15-50` 保持不变。
2. **§3 用例 1** 写死 `E:\projects\demo` —— 该机器**没有 E: 盘**。建议改述为"任意盘符,关键是 VS Code 用大写、终端用小写"。
3. **§3 用例 4** 说 `npm test`"期望恰好两行" —— 实际有第三行 `[dsh-bridge] mode=none`(windows-sim 桩打印)。
4. **§2.1 / §5** 依赖 `git`,而这台机器没有 git。建议补一条无 git 环境的替代路径。
5. **§2.4** 的三选一在"扩展从未安装过"的机器上都不必要 —— 此时 UI 按钮**必然**渲染。
   建议补一句前提说明,避免读者以为必须先改版本号。

---

## 8. 回滚(本机无 git)

重启插件前已备份 profile 元数据到 `C:\Users\apple\.dsh\profile-backup-20260923-162534\`
(`package.json` / `pnpm-lock.yaml` / `cordis.patch.yml`)。

```powershell
$nodeDir = "$env:LOCALAPPDATA\dsh-studio\tools\node\v24.21.0"
$env:PATH = "$nodeDir;$env:LOCALAPPDATA\dsh-studio\harness\node_modules\.bin;$env:PATH"
$dsh = "$env:LOCALAPPDATA\dsh-studio\harness\node_modules\.bin\dsh.cmd"
& $dsh plugin --profile web remove dsh-vsceditor
```

扩展侧回滚:删掉 `%USERPROFILE%\.vscode\extensions\dsh.dsh-bridge`,再 **Reload Window**。

> `bridgeDebug` 目前**仍开着**(运行时开关),还在往 `C:\tmp\dsh-bridge-debug.log` 写。
> 关掉:`POST /__dsh-vsceditor/action` body `{"action":"set-config","patch":{"bridgeDebug":false}}`
> (需带 `Origin: http://127.0.0.1:51173` 头,见 `host.js:479-480` 的 mutation 校验)。

---

## 9. 仍未验证的部分

| 项 | 状态 |
|---|---|
| 真实 `vscode.diff` 标签的**渲染与标题** | ✅ 已验证(#6 主检查 + #5 标题,均人眼确认) |
| 真实 VS Code `TextDocument` **内存缓存**行为(#6 根源) | ✅ 已验证(文件作为普通标签打开、`visibleEditors=1` 前提下右侧仍为 `15-25`) |
| 真实盘符大小写下 `doc.uri.fsPath` 的真实取值 | ✅ 已验证 = 小写 `c:` |
| `%USERPROFILE%\.vscode\extensions` 的加载与版本比对 | ✅ 已验证(扩展 0.5.0 由插件真实安装路径装入,`extInstalled` / `extUpToDate` 均 true) |
| `followWorkspaceOnly` 真机端到端 | ⚠️ **未跑**(配置 `false`;纯函数层已由探针覆盖) |
| 内嵌 code-server 模式 | ⚠️ **未测**(本次只验 `editorBackend: local`;`running: false`) |
| 缺陷 A/B 的**修复** | ❌ 只定位根因,**未改代码** |
| 缺陷 A 在 macOS 上的复现 | ✅ **已跑**(归档时补测,见 §5.3;机制层面完全一致) |

沿用手册提醒:**#5 的 issue 正文是截断的**(818 字节,停在「VS Code 日志:」),
根因原本是**从代码推出来的**。本次真机验证使这层证据差异**不再重要** ——
它已从"代码推断"升级为"真机实测复现"。

---

## 10. 复现素材清单

| 文件 | 用途 |
|---|---|
| `wintest\cache-test.txt` | #6 用例素材(当前 `15-50`) —— 在验证机器的会话工作区里 |
| `wintest\Tdata\config.lua` | #5 用例素材(当前 `mode = "after"`) —— 同上 |
| `C:\tmp\dsh-bridge-debug.log` | 扩展侧帧级追踪(`dbg()`) —— **仍在验证机器上,未归档** |
| `C:\Users\apple\.dsh-editor\bridge-ext.log` | 扩展侧日志(**注意是 UTF-8**,用 ANSI 读会乱码) —— **仍在验证机器上,未归档** |
| [`docs/evidence/probes/win-path-probe.mjs`](evidence/probes/win-path-probe.mjs) | 真机路径语义探针(53/53) |
| [`docs/evidence/probes/sse-lifetime.mjs`](evidence/probes/sse-lifetime.mjs) | 缺陷 A:旁路客户端对照实验(证明服务端无辜) |
| [`docs/evidence/probes/sse-loop-repro.mjs`](evidence/probes/sse-loop-repro.mjs) | 缺陷 A:**平台无关**最小复现器(已在 macOS 复现) |
| [`docs/evidence/probes/dedup-key-collision.mjs`](evidence/probes/dedup-key-collision.mjs) | 缺陷 B:复算证明 + 平台无关性 |
| `work\HANDOFF-windows-verification.md` | 重启前写的操作单 —— 内容已并入 [`docs/windows-verification.md`](windows-verification.md) §2.1 / §2.6,未单独归档 |
