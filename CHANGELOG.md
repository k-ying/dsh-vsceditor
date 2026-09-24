# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

> 未发版：代码已就位，尚未升版本号、未打 tag、未发布 npm。

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

### 发版前必做

- 本版改动了 `vscode-ext/dsh-bridge/`（`extension.js` 与**新增的 `paths.js`**）。按 README「版本号规范」（插件与扩展保持 major.minor 一致），**发版时扩展版本必须从 `0.5.0` 提到 `0.5.x`**——否则 host 会认为已安装扩展与内置扩展同版本、不重新拷贝，用户拿不到新扩展代码。`paths.js` 无需额外处理：`installDesktopExtension()` 是整目录 `cpSync`，`package.json` 的 `files` 也已包含整个 `vscode-ext/dsh-bridge`
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
