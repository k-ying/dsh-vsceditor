# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [0.5.10] - 2026-11-07

### 修复（一键安装 code-server 在 DSH 0.1.3+ 上直接失败）

- **现象**：点「下载并安装 code-server」立刻报 `spawn failed: Cannot read properties of undefined (reading 'includes')`，安装脚本根本没启动，一个字节都没下载
- **根因**：`startInstall()` 调 `subprocess.spawn` 时漏传 `cwd`。DSH 从 `0.1.3-alpha.2` 起在 subprocess 入口加了严格参数校验（`validateNoNullByte("options.cwd", spec.cwd)`），`undefined.includes("\0")` 当场抛 `TypeError`，插件的 `catch` 把它包成 `spawn failed: ...`。0.1.2 及更早没有这层校验，缺省 `cwd` 会退回 `process.cwd()`，所以 8 月底加进安装向导的这个漏参一直没暴露
- **同一处漏参还压着两个静默故障**：`runCmd()` 既没 `cwd` 也没 `graceMs`，异常被 `catch` 吞成空字符串 —— 「检测本机 VS Code」「接管已运行的 code-server」从同一个 DSH 版本起就失效，不报错、只是永远检测不到
- **修法**：新增 `SPAWN_CWD = os.homedir()`（目录必然存在，不必先建），`startInstall` 与 `runCmd` 补齐 `cwd`；`runCmd` 同时补 `graceMs: 3000`（只是 TERM→KILL 宽限，总超时仍由 `ctx.timeout` 控制）。`startServer` 本来就传了 `cwd`，未动

### 测试

- `npm test` = **186 项**（`control-trust-smoke` 84 / `client-slots-sim` 28 / `windows-sim` 53 / `bridge-regressions` 21）
- 真机核对：把补丁后的参数交给 DSH 同一个底层启动函数，`exitCode=0` 并取回 stdout；改前同样参数必抛 `TypeError`

### 升级须知

- **宿主半改动**：装好后需要重启 dsh 生效（市场热挂载会替换；重启同样有效）
- `vscode-ext/dsh-bridge` 未改动，扩展版本保持 `0.5.3`（major.minor 仍是 `0.5`）

## [0.5.9] - 2026-11-06

### 修复（桌面窗口里重启报 403 · 重启后编辑器连不上）

- **重启按钮仍然 403 的真因**：桌面壳把页面的请求用自己的代理转发，**丢掉了 `Origin` 头**（但保留了 `Sec-Fetch-Site: none`）。0.5.8 只放行了"非 http(s) 来源"，对"根本没有来源"的写操作仍然拒绝。现在围栏接受「无 `Origin` + `Sec-Fetch-Site: none` + 回环 socket」的写操作 —— 网页无法设置这个头（浏览器只会给 same-origin / cross-site），普通本地脚本两个头都不带，仍然被拒
- **重启后编辑器卡在 "Cannot reconnect. Please reload the window."**：随机端口在同一个插件实例里只生成一次，重启后 `url` 不变，而前端只凭 url 判断要不要重载 iframe，于是永远停在旧页面。`/state` 新增 `bootAt`（每次真正拉起 code-server 时刷新），前端据此重载 iframe

### 变更（声明宿主版本范围）

- **`package.json` 新增 `engines.dsh: ">=0.1.0-rc.1 <0.3.0-0"`**：此前只有 `engines.node` 和一条 `@deepseek-ai/dsh-client-runtime` 的 peer，而那条 peer 指向的是**客户端包**、宿主安装目录里并不存在，所以 dsh-market 的「宿主要求」一直显示「未声明宿主要求」。现在市场会显示 `DSH >=0.1.0-rc.1 <0.3.0-0`
- **`engines.dsh` 是独占判定**：一旦声明，dsh 的安装闸门与市场的推导都**不再回看 `peerDependencies`**，所以范围必须自己写全。本范围覆盖 0.1.0-rc.1 到 0.2.x（含 `0.2.1-alpha.1`、`0.2.2-rc.1` 这类预发布）—— 两边用的 `satisfies` 都带 `includePrerelease`，不会误杀预发布宿主
- **0.0.x 不再声明支持**：README 的前置要求从 `0.0.x – 0.2.x` 收敛为 `0.1.0-rc.1 – 0.2.x`（中英同步）

> 测试：`control-trust-smoke.mjs` 81 → 84 项（新增 3 条桌面代理形状的用例，变异验证过）；`npm test` = **186 项**

## [0.5.8] - 2026-11-06

### 修复（桌面窗口里所有写操作 403）

- **现象**：dsh 0.2.2 起，桌面窗口里点「重启」、保存设置、切后端都会在顶栏报「操作被拒绝（restart）：HTTP 403 —— 写操作没通过控制面围栏……」，而面板本身能正常显示状态。**只坏写操作，不坏只读**
- **根因**：控制面围栏要求写操作的 `Origin` 与 `Host` 同源。桌面窗口的页面在自定义协议上（`dsh-app://app`），经壳自己的代理访问 `127.0.0.1:3080`，所以 `Origin` 恒为 `dsh-app://app`，**不可能**等于 http 的 Host；而 `new URL('dsh-app://app').origin` 在 Node 里又是 opaque 的 `"null"`。GET 不要求 Origin，因此只有写操作被拒 —— 看上去就像"设置保存坏了"
- **修法**：围栏改为接受**任何非 http(s) 的页面来源**（桌面壳的窗口来自自定义协议，如 `dsh-app://app`），且**仅在回环 socket 上**放行。网页的 Origin 只可能是 http(s) 或 opaque 的 `"null"`，所以自定义协议只可能来自应用窗口；`"null"`（`file:` / sandboxed iframe / `data:`）**仍然一律拒绝**——放行它才是真的 CSRF 洞。写成"任意非 http(s)"而不是写死 `dsh-app://app`，是为了壳将来换协议名（如 `tauri://localhost`）时不再复现同一个故障
- **排查抓手**：围栏拒绝时把实际看到的 `host` / `origin` / `sec-fetch-site` / socket 地址记进 `/state` 的 `fenceReject`，下次 403 不用猜是哪条规则拦的
- **测试**：`test/control-trust-smoke.mjs` 75 → 81 项，新增 6 条（自定义协议来源可写、被壳标成 cross-site 仍可写、另一个应用协议来源也可写、非回环来源拒绝、`null` 仍拒绝、其他端口的 http 来源仍拒绝），**已做变异验证**（退回旧行为后 3 条立刻失败）

### 升级须知

- **桌面窗口用户必须升到本版**，否则重启编辑器 / 保存设置全部 403
- 这是**宿主半**改动：装好后需让新代码生效（市场热挂载会替换；重启 dsh 同样有效）。之前 0.5.7 是纯客户端改动，刷新页面即可，两者不同
- `vscode-ext/dsh-bridge` 未改动，扩展版本保持 `0.5.3`（major.minor 仍是 `0.5`）

## [0.5.7] - 2026-11-01

### 修复（dsh 0.2.1-rc.4+ 上会话顶栏整条消失）

- **根因是「label 返回 React 元素」违反插槽契约**：`conversation.view` 的 `label` 契约是 `string | (() => string)`，而插件从 rc.3 时代起让它返回一个 `<span>`（用来画彩色状态点，并兼职 2.5 秒轮询）。dsh **0.2.1-rc.4** 起核心给 tab 量宽改成 `for (const glyph of label)`，元素不可迭代 → 抛 `TypeError: label is not iterable` → `SlotErrorBoundary` 把整条 `conversation.session.header` **abdicate** 掉，顶栏（标题 / 按钮 / tab 行）整条消失，只剩约 20px 空白带；刷新才短暂恢复，随后同一路径再崩。**rc.3 没有这段代码，所以这是 rc.4 引入的回归**，触发条件是本插件违约的 label
- **label 回归纯文本**，每次投影重新求值（切界面语言不用重新注册）。删掉兼任轮询的 `TabLabel` 组件 —— 让装饰性元素承担关键职责，正是这次事故的形态；轮询改由 `startTabPoller()` 独立管理，不再依赖 tab 是否挂载
- **状态点改由伪元素绘制**：核心的 `.tabLabel` 是 `display:block`，行内伪元素必然被挤到下一行；而 `.tab::after` 已被核心占用画激活下划线，不能抢占。所以改用 `::before` + 绝对定位画在按钮**右外侧**（`.viewTabs` 有 32px 间距），不参与布局、不换行、也不覆盖下划线
- **打标不再依赖网络**：每秒重试且先用默认色，dsh 重启后 1 秒内出现；找不到按钮就静默降级为纯文字，绝不抛错
- **留下排查抓手**：`<html data-dsh-vsced-diag>` 记录插件实际看到的 tab 文本与匹配结果（只在值变化时写，平时零开销）

### 测试

- `test/client-slots-sim.mjs` 新增「view label 必须解析为字符串」（25 → 28 项），**已做变异验证**：把 label 改回数组包元素，该断言立刻失败
- `npm test` = **75 + 28 + 53 + 21 = 177 项**

### 升级须知

- 插件版本 `0.5.6 → 0.5.7`；`vscode-ext/dsh-bridge` 未改动，扩展版本保持 `0.5.3`（major.minor 仍是 `0.5`）
- 这是**客户端**改动：装上后刷新页面即生效，不需要重启 dsh（重启也无害）
- **dsh 0.2.1-rc.4 / rc.5 用户务必升级到本版**，否则顶栏会因上述回归整条消失
- 上游 `labelNeedsTooltip` 缺少类型守卫的问题仍建议核心侧修复（第三方插件的非字符串 label 不该能吞掉整条顶栏）；本版**不依赖**该修复，也未附带任何修改 dsh 核心的补丁

## [0.5.6] - 2026-10-08

### 修复（dsh 0.2.x 上设置不持久化）

- **`settings.register` 在 dsh 0.2.x 已被删除**：插件原来直接调 `sctx.settings.register(ns, schema, {base})`（0.1.x 的 API，返回带 `get/watch/update` 的 scope），在 0.2.1 上抛 `sctx.settings.register is not a function` → 被 catch → `settingsScope` 为空 → 设置面板顶出「⚠️ 设置服务不可用，以上改动仅本次运行有效」，**任何改动重启即丢**
  现在按能力分流：`typeof sctx.settings.register === 'function'` 时走 0.1.x 老路；否则改为写**插件自己的 profile 条目** —— `configEditor.edit(entry, change)`，它负责校验、落盘 profile patch 并 reconcile（`patchReload: live`）。写盘前先过一遍 `configSchema`，坏值必须被拒绝，而不是落进用户的配置文件
- **0.2.x 的 settings 服务只投影 entry 的 `Config` schema，且只接受 `meta.volatile` 字段**（`volatileForm()`），而本插件是零依赖、手搓 schemastery 兼容外形，没有 `meta.volatile` → 即使注册成功也拿不到可写表单。所以这里**不导出 `Config`**：cordis 会拿 `runtime.Config` 跑 `resolveConfig()`、写回时还会调 `Config.simplify`，手搓 schema 未必满足，风险是插件**整个加载失败**；而 `configEditor` 走的是组合后的 row，`resolveConfig` 对没有 `Config` 的插件是直通

### 修复（部署层 trustedHosts 从未生效）

- 插件一直从 **`connection`** 服务读部署层的 `trustedHosts`，但该字段在 **`webRuntime`** 上（`dsh-web-app` 用 `ctx.provide("webRuntime", { lanAddresses, trustedHosts })` 注册，0.1.5 与 0.2.1 都是）。因为外面套了 `try/catch` + `Array.isArray` 防御，失败是**静默**的 —— 0.5.2 起标称的「自动并集 DSH 部署层 `trustedHosts`」**在写下那天起就没生效过**
- 现在改从 `webRuntime` 读。插件自身的 `trustedHosts` 设置不受影响

### 测试

- `test/control-trust-smoke.mjs` 新增「dsh-generation adapters」13 项（62 → 75）：
  - `deploymentTrustedHosts`：必须读 `webRuntime` 且裁剪空白；**不得**读 `connection`（反向断言）；非数组忽略；服务抛错不炸；缺 ctx 不炸
  - `pickOwnEntry`：按模块名精确匹配；退回比较 **id 的最后一段**（`include:vsceditor` ↔ 包名 `dsh-vsceditor`）；**不误认领** `vsceditor-fork` 这类仅含名称的无关行；空列表不炸
- **变异验证**（均逐字节还原）：退回读 `connection` 报 2 条失败；退回子串匹配报 1 条失败
- `npm test` = **75 + 25 + 53 + 21 = 174 项**

### 升级须知

- 插件版本 `0.5.5 → 0.5.6`；`vscode-ext/dsh-bridge` 未改动，扩展版本保持 `0.5.3`（major.minor 仍是 `0.5`）
- **dsh 0.2.x 上的设置落点**：写进该 profile 的 `cordis.patch.yml` —— 在既有 `- id: vsceditor` 行上更新 `config:`，没有就追加一条。顶层同 id 行是对组合层那一行的**覆盖**，不会重复挂载
- 装上本版后**需要重启 dsh** 才能生效（改的是宿主半的代码）

## [0.5.5] - 2026-10-08

### 修复（0.1.x 上设置界面被渲染两遍）

- **设置插槽仲裁**：0.5.4 为兼容 dsh 0.2.x，把设置界面**同时**注册进了两个插槽，前提是「0.1.x 只声明 `settings.plugin.item`、0.2.x 只声明 `settings.plugins.tab`，各命中一条」。**这个前提是错的** —— 0.1.x 两个都声明：它的 `settings.plugins.tab` 里有一个内建的 "configurable" 标签页，而 `settings.plugin.item` 正是挂在该标签页下的卡片。于是 0.1.x 上「设置 → 插件」会**同时**出现一个「内嵌 VSCode 编辑器」标签页**和**「插件配置」里的同一张卡片，同一份设置渲染两遍
  现在**标签页优先**：`settings.plugin.item` 只作为「连 `settings.plugins.tab` 都没有的更老壳」的兜底，并且标签页一旦出现就把已注册的卡片撤回 —— 任何声明顺序、任何壳上都**恰好一份**设置界面
- 实测确认：`settings.plugins.tab` 自 **dsh 0.1.5** 起就已声明（`dsh-client-ui-settings-plugins` 把它作为 `settings.section` 的子插槽，`dsh-client-ui-settings-plugin-inventory` 也注册在里面）；0.2.1 只声明它，`settings.plugin.item` 在 0.2.1 的运行时代码里已不存在。README 的「设置入口」描述据此更正

### 测试

- 新增 `test/client-slots-sim.mjs`（25 项）：stub `window.__ModuleLoader__` + 桩化 DOM + 一个实现了 `slots.inject` / `slots.register` 真实生命周期的假 slots 服务，加载**未修改的真实** `lib/client.js`，按六种形态断言「**恰好注册一次**设置界面」—— 0.1.x 双插槽、0.2.x 单插槽、只有卡片的老壳、**声明顺序颠倒**（卡片先到、标签页后到必须撤回卡片）、延迟声明、插槽塌缩与重新声明
- `npm test` = **62 + 25 + 53 + 21 = 161 项**
- **变异验证**（三处，均逐字节还原）：退回「两条都无条件注册」报 3 条失败；只去掉「撤回」报 2 条失败（正对着声明顺序那条）；去掉兜底卡片报 4 条失败

### 升级须知

- 插件版本 `0.5.4 → 0.5.5`；`vscode-ext/dsh-bridge` 未改动，扩展版本保持 `0.5.3`（major.minor 仍是 `0.5`）
- 若你在 0.5.4 上见过设置界面出现两份，本版修的就是它

## [0.5.4] - 2026-10-08

### 修复（dsh 0.2.x 上装不上、设置界面不显示）

- **peer 范围挡住了整个 dsh 0.2.x**：`peerDependencies` 原先上界停在 `<0.2.0-0`。dsh 装载时会拿**每一条** `@deepseek-ai/dsh-*` 的 peer 声明与**当前运行时版本**做 `semver.satisfies(runtimeVersion, range, { includePrerelease: true })`（见 `dsh-app-boot`），不在范围内就**直接拒绝安装**，只留一条 exact-version 豁免的指引。Tauri 桌面壳自带的那份 dsh 已是 `0.2.1-alpha.1`，于是从 `dsh-market` 安装被拒（`Plugin dsh-vsceditor@0.5.3 is incompatible with dsh 0.2.1-alpha.1`）。现在追加 `>=0.2.0-0 <0.3.0-0`：0.0.x/0.1.x 与 0.2.x 都能装，0.3.x 仍被拦住
- **设置界面挂在了一个已消失的插槽上**：0.2.1 起 `settings.plugin.item` 不再声明，第三方设置改为「设置 → 插件」下的标签页 `settings.plugins.tab`（`dsh-market` 自己也注册在那里）。原先的设置卡片只挂在旧插槽上，在 0.2.x 里**既不报错也不显示**。现在两条注册并存：旧插槽渲染可折叠卡片（外层 `<li>`），新插槽渲染常显的标签面板（外层 `<div>`、静态头部、无折叠按钮与箭头）。`slots.inject` 对未声明的插槽只是挂起等待、不会报错，所以两代壳各自只会命中一条，不会重复渲染
- **0.2.1-alpha.1 核对结论（活体注册表，不是读文档）**：宿主侧契约仍然完好 —— 注入的 `webServer`/`subprocess`/`timer`/`agents` 四个服务都在，监听的 `tools/pre-execute`/`tools/result`/`agent/created`/`agent/inbox/claimed` 四个事件都在且回调签名一致，`ToolExecutionInput` 的 `name`/`arguments`/`agent` 与 `ToolExecutionResult.isError` 也都还在；客户端插槽 `conversation.view`（编辑器标签页）同样还在。所以这次是**版本范围 + 一处插槽名**的兼容问题，不是协议断代。`@deepseek-ai/dsh-client-runtime` 这个 peer 名在两代 dsh 的磁盘上都不存在，它只是「客户端运行时 API 契约」的声明名，dsh 按名字前缀比对版本，并不要求真的装上该包

### 测试

- `test/control-trust-smoke.mjs` 新增一组「manifest 不变量」（9 项，53 → 62）：用最小实现的 semver 精度比较（语义等价于 dsh 的 `includePrerelease: true`，从而保持**零依赖**）断言 peer 范围**接受** `0.1.5-rc.1` / `0.2.0-0` / `0.2.0-rc.2` / `0.2.1-alpha.1` / `0.2.99`、**拒绝** `0.3.0-0` / `0.3.0`，并断言客户端**同时**保留新旧两条设置插槽注册。**已做变异验证**：把 peer 范围退回旧值报 4 条失败，拿掉 0.2+ 插槽注册报 1 条失败
- `npm test` = **62 + 53 + 21 = 136 项**

### 升级须知

- 插件版本 `0.5.3 → 0.5.4`；`vscode-ext/dsh-bridge` 未改动，扩展版本保持 `0.5.3`（major.minor 仍是 `0.5`，符合「插件与扩展版本 major.minor 必须一致」的约定，因此不会触发扩展重拷）
- 在 0.2.x 起的 dsh 上，设置入口由「设置 → 插件 → 插件配置」的卡片变为「设置 → 插件」下的标签页；字段与行为完全不变

## [0.5.3] - 2026-09-25

### 修复（Windows 桌面模式的路径处理，#4 / #5 / #6）

三条报告都来自 Windows + `editorBackend: local`，根因是同一个：路径在整条链路上被当作**不透明字符串**。修法是引入 `vscode-ext/dsh-bridge/paths.js`（纯函数、平台可注入），让扩展与 host 都按文件系统语义处理路径。

- **#4 工作区匹配忽略盘符大小写**：`workspaceMatches()` 原先用 `===` 比较 `workspaceFolders[0].uri.fsPath` 与 bridge 里的工作区路径。Windows 上 VS Code 报大写盘符（`E:\projects\demo`）、DSH 的 cwd 常是小写（`e:\projects\demo`），两者被当成不同目录，于是扩展**一直连不上**——状态栏「工作区不匹配」，跟随 / diff / 锁定全部失效。现在改用 `sameFsPath()`：win32 下大小写不敏感，并归一化分隔符与尾分隔符；POSIX 保持大小写敏感（Linux 确实区分，macOS 未被报告过）。**Windows 只在盘符大小写不同时才会触发，所以这条不修，#5/#6 根本观察不到**
- **#5 相对路径丢盘符**：Agent 有时把工作区相对路径（`Tdata\config.lua`）交给 write/edit 工具，而 `editPathOf()` 原样透传，扩展再 `vscode.Uri.file()` 就得到 `\Tdata\xxx.lua`。现在 host 侧 `resolveEditPath()` 先按会话工作区解析成绝对路径（内外嵌两个后端都受益——内嵌在 macOS 上收到的多是绝对路径所以从未暴露），扩展侧再做一次防御性解析，并把 `lock`/`unlock`/`hello`/`edit`/`reveal` 的路径统一规范化，相对与绝对两种写法映射到同一个键
- **#6 跟随 diff 右侧吃到 VS Code 文档缓存**：`openDiff()` 右侧用的是 `vscode.Uri.file(fsPath)`，走 TextDocument，于是**文件已作为普通标签打开时**，diff 左右两侧都显示改前内容，看起来像 Agent 没写上。现在右侧改为虚拟文档 `dsh-now://`，内容取自 host 回读的磁盘内容（`newText`，host 早已在发）。**注意**：这也意味着右侧不再随磁盘实时刷新——每次新编辑会经 provider 事件原地刷新，本轮累计 diff 语义不变
- 顺手修掉同族的另外三处：`encodePath()` 与 diff 标题的 `baseName()` 都用 `split('/')` 切分，而 win32 路径是反斜杠 —— 编码后整条路径坍缩成一个 `%5C` 段、标题显示完整路径；`followWorkspaceOnly` 的工作区包含判断用 `p.indexOf(root + path.sep) !== 0`，盘符大小写不同时会把**工作区内的文件误判为区外**并静默不弹 diff（host 侧的 #5 变体）。现分别改为按 `[\\/]` 切分、以及 `isInsideOrEqualPath()`（win32 大小写不敏感，容忍 root 带尾分隔符）
- **模拟实验**：新增 `test/windows-sim.mjs`（53 项）。三条报告都是 Windows + 桌面模式，贡献者在 macOS/Linux 上跑不了，所以该用例**强制 win32 语义 + 桩化 `vscode` + 加载未修改的真实 `extension.js`**，用报告里的路径驱动 `handleMessage()`，断言工作区匹配、路径解析、`vscode.diff` 收到的 URI scheme 与 provider 内容。**它当场抓出了三个我自己的缺陷**：(a) 锁定键按原始拼写存、而 `isProtected` 用 `doc.uri.fsPath` 查，Windows 下会**静默失去保护**；(b) `lastKnown` 同一文件存两份拼写，回滚保护可能取到过期那份；(c) 相对帧与绝对帧拼写不同会给同一文件开**两个 diff 标签**。三者统一改为「按工作区文件夹的拼写规范化 + 大小写折叠键」后消解
- **真机验证**：三条修复在 Windows 10 Pro 22H2 + VS Code 1.138.0 上全部通过（含人眼确认的 diff 标签渲染与标题）。部署手册见 `docs/windows-verification.md`，完整报告与复现脚本见 `docs/windows-verification-report.md`、`docs/evidence/`

### 修复（SSE 重连自维持循环 / 编辑帧去重键碰撞）

两条都不是 Windows 特有的，`main` 上就已存在，是 Windows 真机验证时顺带发现的（见 `docs/windows-verification-report.md` §5）。

- **SSE 每 2.5s 重连的自维持循环**：`connectSSE()` 会先 `destroy()` 掉上一条流再开新的，而被顶替的那条流会以 `error: aborted` 走完自己的 error 回调 —— 原代码没有门禁，于是该回调排出下一次重连，2.5s 后又顶掉当时**活着的**流，循环永不停止（状态栏闪烁、日志刷屏，destroy/reconnect 的瞬间还可能丢帧）。现在所有 handler 先判 `state.sseReq === req`：只有当前这条流能改连接状态或排下一次重连；`connectSSE()` 入口额外清掉待触发的重连定时器（已经在连了就不必再留一个），连接成功时把退避归零。触发场景很常见：`activate()` 之后紧跟一次 `onDidGrantWorkspaceTrust` / `onDidChangeWorkspaceFolders`
- **编辑帧去重键碰撞**：去重本意是「同一份帧 30s 内只处理一次」（SSE 重连、多路径投递），但键是 `path|长度|抽样哈希`，抽样步长 `i += 97` 对任何短于 97 字符的正文只让循环体跑一次、哈希退化成首字符码 —— 于是「等长 + 同首字符」的**不同**编辑被判成同一份帧：不再聚焦已有标签、不再定位改动行，标签被用户关掉后 30s 内也不会重开（右侧内容仍会刷新，那条走 provider 的 change 事件）。现在直接记住上一帧的 (路径, 正文) 做精确比较，并在 turn 边界清空（新一轮的帧不该被上一轮误判）
- **重连退避**：已经拿到端点却握不上手 / 被断流时按 2.5s → 30s 指数退避。此前是固定 2.5s：token 不同步期间本地日志里留下了连续 27 次 `SSE 握手失败：HTTP 403`。但「还没拿到端点」的发现阶段（`bridge.json` 尚未出现、窗口工作区不匹配）**保持固定 2.5s** —— 这两种情况只能靠轮询发现变化，退避会让刚切到本机模式的用户白等半分钟
- **回归覆盖**：新增 `test/bridge-regressions.mjs`（21 项）。这两处此前**无法被测试覆盖**（`connectSSE()` 没导出、去重键由未导出的内部函数计算），所以先把它们纳入 `__test`，再用真实 `extension.js` + 桩化 `vscode` + 一个**真实 HTTP SSE 服务端**驱动（循环只在 destroy 活流时出现，假服务端测不出来）。已做变异验证：把两处修复退回旧行为后该用例报 8 条失败，其中一条正是循环复现（窗口内连接数 4 > 2）
- **CI 加矩阵**：`.github/workflows/test.yml` 从单个 `ubuntu-latest` 改为 `ubuntu-latest` / `windows-latest` / `macos-latest` —— `#4/#5/#6` 这三个 bug 恰好是 CI 看不见的类型（模拟用例本来就是注入 win32 的，只有真实平台才跑得到默认 `process.platform` 分支）

### 可观测性

- **扩展 ack 不再被丢弃**：`/state` 新增 `lastAck`（`kind`/`path`/`follow`/`opened`/`timeout`/`dedup`/`error`/`at`）。此前 host 的 RPC 分发只处理 `ready`/`set-follow`/`log`，扩展对每个 edit 帧回报的 ack 被直接扔掉，于是「diff 到底弹没弹」在面板侧毫无凭据。现在 `openDiff` 会把结果如实带回：6 秒超时既不抛错也不等于已弹出，ack 里用 `opened`/`timeout` 区分；扩展明确抛错时面板给出红字提示并指向 `~/.dsh-editor/bridge-ext.log`
- **写操作失败不再静默**：客户端 `postAction` 此前是 `.catch(() => null)`，被围栏拒绝时面板毫无反应，只是 2.5 秒后轮询把控件弹回原值，用户会以为「点了没生效」。现在失败会在编辑器标签页与设置卡片里显示一行红字，HTTP 403 直接点名控制面围栏并提示检查 `trustedHosts`；业务失败（`{ok:false}`）仍把结果交给调用方，调用方行为完全兼容
- **新增 `bridgeDebug` 设置**：让扩展侧追踪可现场开启。开关经 SSE 的 `debug` 帧即时下发（扩展侧 `DEBUG` 由 `const` 改为运行时可改），**无需重启 DSH 或 code-server**；对不是本插件拉起的桌面 VS Code 窗口同样生效（环境变量到不了那里）。开启后追踪写入 `/tmp/dsh-bridge-debug.log`
- **修 `bridgeDebug` 关闭时的确认信息写不出来**：`dbg()` 自身在追踪关闭时直接 return，而 `case 'debug'` 原先先赋值 `DEBUG = !!msg.enabled` 再调 `dbg(...)`，于是「开启」能落盘、「关闭」永远被自己吞掉。现在改为在标志落下**之前**写关闭那一行（开启仍走赋值后写）。功能上开关两个方向本来就生效，这条只影响确认信息，属于上一版引入的顺序问题
- 测试：新增 ack 归一化矩阵 + 配置不变量（三处键清单必须一致：`CONFIG_DEFAULTS`、`configSchema.dict`、以及 `normalizeConfig` 返回的字面量对象——控制路由的写白名单遍历第一处，而漏在第三处会让该键被**静默丢弃、设置永不生效**；本次新增 `bridgeDebug` 时真的踩了这个坑，靠这条不变量抓出来并修掉）；冒烟测试现在报告检查条数（53 条）

### 升级须知

- **扩展版本 0.5.0 → 0.5.3**：本版改动了 `vscode-ext/dsh-bridge/`（`extension.js` 与**新增的 `paths.js`**）。按 README「版本号规范」（插件与扩展保持 major.minor 一致），扩展版本必须提档 —— 否则 host 会认为已安装扩展与内置扩展同版本、**不重新拷贝**，用户拿不到新扩展代码。现在 host 检测到版本不一致会自动整目录重拷到 `~/.vscode/extensions/dsh.dsh-bridge` 并提示 Reload Window（`installDesktopExtension()` 是整目录 `cpSync`，`paths.js` 无需额外处理）
- `test/` 不在 `files` 中，所以三个测试文件不随 npm 包发布（`npm test` 只在仓库内跑）

## [0.5.2] - 2026-09-20

### 安全

- **控制面路由加信任围栏**（修复 HIGH，感谢 @sheecegardezi 的 PR #3）：`/state` 与 `/action` 此前没有任何校验 —— 任意网页可跨站 POST `set-config` 写入攻击者选定的 `vscodePath`，再 `detect-vscode` 让宿主执行该二进制（CSRF → 命令执行）。该路径真实可达：`readBody` 不看 content-type，用默认 `text/plain` 的跨站 fetch 属简单请求、不触发预检，POST 会被直接投递执行；DNS rebinding 下还可直接读取 `/state`（泄露工作区与最近文件路径）。现在：Host 必须是回环 / 请求实际到达的本机地址 / 已声明的信任主机、`sec-fetch-site: cross-site` 拒绝、Origin 存在时必须匹配 Host、**写操作 POST 必须带 Origin**（浏览器必带；本地非浏览器脚本不带 → 拒绝）。插件自身客户端（同源 fetch）不受影响
- **非回环 socket 只能代表已声明的信任主机**：浏览器之外 Host 与 Origin 都可以伪造，socket 地址是唯一可信信号。没有这条规则，本机任意进程（或 DSH 绑到局域网时的任意局域网主机）只要声称 `Host: 127.0.0.1` 即可绕过围栏驱动控制面；同机经本机局域网地址/主机名访问仍然放行（回环 socket 已证明客户端在本机）
- **新增 `trustedHosts` 设置**：逗号分隔的裸授权（`host` 或 `host:port`），与 DSH 核心同语义（带端口精确匹配，不带端口匹配该主机名任意端口），供反向代理 / 自定义域名 / Tailscale MagicDNS / ngrok 等场景声明信任主机；同时自动并集 DSH 部署层 `connection.trustedHosts`，部署层已声明过的不必重复声明。通配符、协议、路径一律拒绝
- **`set-config` 键白名单**（纵深防御）：控制路由只允许写 `CONFIG_DEFAULTS` 中已知的配置键，多余字段直接丢弃
- **code-server 随机端口扩到全范围** 10000-65000（原固定窄段 18200-18900，本地端口扫描数秒即可定位 `--auth none` 实例）
- **bridge.json 改 0600 权限**：该文件含 SSE token，可订阅携带文件全文的 edit 事件流，此前为默认 0644
- 残余风险（如实记录）：内嵌 code-server 仍为 `--auth none`（loopback 绑定），多用户机器上本机其它用户仍可能经端口扫描访问；单用户开发机与 DSH 本身的本地 HTTP 面同威胁级

### 修复

- IPv6 主机名误判：`new URL('http://[::ffff:127.0.0.1]:3080')` 会把 hostname 规范成带方括号的 `[::ffff:7f00:1]`，原先的 IPv6 正则匹配不到，导致非回环 IPv6 访问被误判 403。现在统一按地址规范化判定（含 IPv4-mapped 的 `::ffff:1.2.3.4` 与十六进制对两种形式）
- 端口范围文案同步：`lib/host.js` 的 4 语言 `cfg.port` 描述、客户端 `settings.portHint`、两个 README 的设置表原先仍写 18200–18900，与实际范围不符

### 文档

- README 安全内容并入既有的「安全说明 / Security notes」小节（原先被插成无编号的 `## Security`，打乱了 1/2/3 的章节编号），并同步 `README.zh.md`（本仓库坚持中英双语同步）
- 新增排障条目：经反向代理 / 自定义域名访问时控制接口返回 403、且设置卡片自身也存不了的处置方式（改 `~/.dsh/settings.yaml` 的 `dsh-vsceditor` 节或插件行 `config:`）

### 测试

- 扩测围栏矩阵：socket 来源校验（远端伪造回环 Host 必须被拒、远端 + 已声明信任主机放行）、信任主机端口精确/任意端口语义、IPv4-mapped IPv6、`trustedHosts` 解析（通配符/协议/路径拒绝、去重、数组形式）
- 新增 GitHub Actions 工作流（`.github/workflows/test.yml`）在 push / PR 上跑 `npm test`

## [0.5.1] - 2026-09-09

### 新增

- **编辑器后端新增「关闭」互斥项**：`editorBackend` 从 embedded/local 二选扩展为 embedded/local/off 三态互斥（设置 → 插件配置 → 编辑器后端，单选按钮）。选中「关闭」后不连接任何后端：host 停掉看门狗（级联关闭整棵 code-server 进程树，零孤儿）、摘除 bridge.json 让本机 VS Code 扩展断开，释放内存；关闭态下自动启动、崩溃重试、重启定时器、安装完成拉起等所有拉起路径全部被 `startServer` 的 off 守卫拦截，不会重复启动。关闭状态持久化，DSH 重启后保持关闭
- **编辑器工具栏电源按钮**：重启按钮右边新增「关闭 code-server」（本机模式为「断开连接」），与设置卡片的关闭项联动同一配置位；关闭态下该按钮变为「打开 code-server」
- **关闭态引导界面**：编辑器标签页在关闭态显示按需启动引导——「启动内嵌 code-server」或「连接本机 VS Code」一键切换；状态灯为灰色（已关闭）；常驻 iframe 同步释放渲染进程内存

## [0.5.0] - 2026-09-08

### 新增

- **轮次级 diff 生命周期**：diff 基线改为跟随对话轮次，不再跟随标签页。一轮对话内（agent 开始输出到停止）所有改动按文件累计成 diff；手动关闭 diff 标签不再丢基线——本轮内该文件再被编辑、或从资源管理器/快速打开点开它，都会带原基线自动重开 diff；内嵌模式刷新/重开编辑器后，host 重放本轮全部改动，整轮 diff 完整恢复。直到下一轮对话产生首次编辑，上一轮的 diff 标签才整体清场，只显示新一轮的变化（通过 `agent/inbox/claimed` 识别轮次边界）
- **code-server 看门狗（lib/cs-supervisor.js）**：code-server 改由看门狗进程拉起成独立进程组。看门狗每 5s 心跳 host 状态端点，连续约 60s 不通判定 DSH 已死，杀整棵子进程树后自杀——DSH 崩溃 / 被强杀 / Studio 升级替换进程时不再残留孤儿 code-server。正常停止/重启路径行为不变（信号级联转发、退出码透传，host 的崩溃重试逻辑不受影响）；本机 VS Code 模式不涉及
- **孤儿收割器**：插件启动时（+ 30s 补收 + 每 30min 巡检）扫描进程表，回收 PPID=1 且带本插件签名（我们的 code-server 目录 + extensions-dir 参数）的历史残留；祖先存活的实例和用户自装的 code-server / 桌面 VS Code 不会被误伤

### 修复

- 崩溃重试计数改为「稳定运行 30s 后重置」：之前 4 次重试额度是终身的，长期运行后偶发退出会耗尽额度导致编辑器不再自动拉起；现在只有 30s 内连续夭折才消耗额度

## [0.4.1] - 2026-09-03

### 修复

- **diff 标签不再互相顶掉**：之前 `vscode.diff` 打开的是 VS Code 预览标签，新编辑会替换掉上一个 diff——一轮改多个文件时只剩最后一个文件的 diff，同一文件改多次时只剩最后一次的 diff。现在每个文件的 diff 是独立的固定标签页（`preview: false`），同文件重复编辑时原地刷新为**累计 diff**（本轮动手前 vs 当前）；手动关闭 diff 标签后基线重置，下次编辑以当时内容重新计算
- 内嵌模式刷新页面后，恢复的 diff 标签左侧不再空白（扩展宿主重建导致快照丢失，现由回放帧重新填充）

### 变更

- **界面语言 `auto` 改为跟随 DSH 界面语言**（此前跟随浏览器语言），切换 DSH 语言后插件界面即时跟随，无需刷新；`pt-BR`/`es` 不再被自动选中（DSH 本身只有中英界面），需要时请在设置中显式指定
- 设置页插件卡片标题不再硬编码中文，跟随界面语言（英文界面下显示 "Embedded VS Code editor"）

### 文档

- README 只保留中英双语（删除 es / pt-BR 版本及重复的 README.en.md），插件界面翻译不受影响

## [0.4.0] - 2026-08-31

### 新增

- **多语言支持（i18n）**：web 面板、host 运行时提示、VS Code 桥扩展全面支持 简体中文 / English / Português (Brasil) / Español，新增 `language` 设置项（`auto` = 跟随浏览器语言）。感谢 @WalissonRodrigo 的贡献（PR #1）
- README 重组为四语言版本（英文为默认），新增多语言 banner

### 修复

- 修复 i18n 中 host 消息参数未被替换的问题（`{cwd}` 等占位符原样显示）

## [0.3.5] - 2026-08-31

### 新增

- **一键安装 code-server 向导**：未安装 code-server 时，「编辑器」标签页和设置卡片会出现「⬇ 一键安装 code-server」按钮，弹窗实时显示下载地址、安装路径、进度百分比（curl `--progress-bar` 解析）和启动/扩展握手进度，装完自动启动编辑器
- 安装过程中可随时**取消安装**（安装脚本新增 TERM trap，取消时 curl 子进程一并终止、临时目录自动清理，不留孤儿进程）
- 安装向导最后一步不再死等扩展握手：code-server 启动后直接引导用户点击「编辑器」标签页，弹窗进入可关闭的完成状态，扩展连上后自动打勾

### 变更

- **编辑器运行数据迁出工作区目录**：user-data / 配置 / 日志从 `<工作区>/.dsh-editor` 改为全局 `~/.dsh-editor/workspaces/<哈希>-<工作区名>/` 按工作区隔离存放（与 VS Code 用户级数据目录同一范式），工作区目录不再出现多余文件夹。已有旧版数据的工作区自动沿用旧位置，数据不丢

## [0.3.4] - 2026-08-29

### 新增

- npm 自动发布 workflow（GitHub Release 触发）
- 插件市场展示截图
- `peerDependencies` 声明

### 修复

- 修复桌面模式重连风暴导致强制打开过期 diff 的问题
