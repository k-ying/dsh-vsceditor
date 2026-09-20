# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

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
