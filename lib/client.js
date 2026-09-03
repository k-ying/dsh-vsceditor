/* dsh-vsceditor — Client half (web boot bundle, hand-written in the
 * window.__ModuleLoader__ format that dsh-client-modules serves).
 * Registers a conversation view tab (对话 / 轨迹 / 编辑器) hosting the
 * code-server iframe; talks to the host half over /__dsh-vsceditor/*.
 */
window.__ModuleLoader__.load({
  id: 'dsh-vsceditor',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')

    var STATE_URL = '/__dsh-vsceditor/state'
    var ACTION_URL = '/__dsh-vsceditor/action'

    var CSS =
      '.dsh-vsced-view{display:flex;flex-direction:column;height:100%;min-height:0;background:#1b1b1e;color:#ddd}' +
      '.dsh-vsced-toolbar{display:flex;align-items:center;gap:8px;padding:6px 10px;font-size:12px;border-bottom:1px solid rgba(128,128,128,.25);flex:none}' +
      '.dsh-vsced-toolbar .sp{flex:1}' +
      '.dsh-vsced-toolbar label{display:flex;align-items:center;gap:4px;cursor:pointer}' +
      '.dsh-vsced-btn{padding:3px 10px;border-radius:6px;border:1px solid rgba(128,128,128,.4);background:transparent;color:inherit;font-size:12px;cursor:pointer;text-decoration:none;display:inline-block}' +
      '.dsh-vsced-btn:hover{background:rgba(128,128,128,.15)}' +
      '.dsh-vsced-frame{flex:1;border:0;width:100%;min-height:0;background:#1e1e1e}' +
      '.dsh-vsced-anchor{flex:1;min-height:0;position:relative}' +
      '.dsh-vsced-frame-float{position:fixed;z-index:50;border:0;background:#1e1e1e}' +
      // 设置页卡片：对齐官方 PluginCard 的折叠样式（边框/圆角/hover/箭头旋转），
      // 主题变量来自 shell，括号内是兜底值。
      '.dsh-vsced-card{list-style:none;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.25));background:var(--dsw-alias-bg-layer-3,transparent);border-radius:12px;font-size:13px;color:inherit;transition:border-color .16s,background .16s}' +
      '.dsh-vsced-card:hover{border-color:var(--dsw-alias-label-dimmed,rgba(128,128,128,.5))}' +
      '.dsh-vsced-card-open{background:var(--dsw-alias-bg-layer-2,transparent);border-color:var(--dsw-alias-label-dimmed,rgba(128,128,128,.5))}' +
      '.dsh-vsced-cardhead{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}' +
      '.dsh-vsced-cardhead:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d8fff);outline-offset:-2px}' +
      '.dsh-vsced-headtext{display:flex;flex-direction:column;flex:1;gap:4px;min-width:0}' +
      '.dsh-vsced-name{font-size:15px;font-weight:600;line-height:1.4;display:flex;align-items:center;gap:8px}' +
      '.dsh-vsced-desc{color:var(--dsw-alias-label-tertiary,#999);font-size:13px;line-height:1.5}' +
      '.dsh-vsced-status{color:var(--dsw-alias-label-tertiary,#999);font-size:12px;flex:none}' +
      '.dsh-vsced-chevron{color:var(--dsw-alias-label-tertiary,#999);flex:none;transition:transform .16s;display:inline-flex}' +
      '.dsh-vsced-chevron-open{transform:rotate(180deg)}' +
      '.dsh-vsced-cardbody{border-top:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.25));margin:0 16px;padding:12px 0 8px;display:flex;flex-direction:column;gap:10px}' +
      '.dsh-vsced-card .row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}' +
      '.dsh-vsced-card .hint{color:var(--dsw-alias-label-tertiary,#999);font-size:12px}' +
      '.dsh-vsced-card input[type=text],.dsh-vsced-card input[type=number],.dsh-vsced-card select{background:rgba(128,128,128,.12);border:1px solid rgba(128,128,128,.3);border-radius:6px;color:inherit;padding:4px 8px;font-size:12px}' +
      '.dsh-vsced-view .row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;max-width:720px}' +
      '.dsh-vsced-view .hint{color:#999;font-size:12px;max-width:720px}' +
      // 本机 VS Code 连接向导（命令式弹窗，挂在 body 上，切标签页不销毁）
      '.dsh-vsced-wiz-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:100000;display:flex;align-items:center;justify-content:center}' +
      '.dsh-vsced-wiz{background:var(--dsw-alias-bg-layer-2,#2a2a2e);border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));border-radius:12px;width:480px;max-width:92vw;padding:18px 20px;color:var(--dsw-alias-label-primary,inherit);font-size:13px;box-shadow:0 12px 40px rgba(0,0,0,.4)}' +
      '.dsh-vsced-wiz-title{font-size:15px;font-weight:600;margin-bottom:10px}' +
      '.dsh-vsced-wiz-step{display:flex;gap:8px;padding:6px 0;align-items:flex-start}' +
      '.dsh-vsced-wiz-icon{flex:none;width:16px;text-align:center;line-height:1.5}' +
      '.dsh-vsced-wiz-detail{color:var(--dsw-alias-label-tertiary,#999);font-size:12px;margin-top:2px;word-break:break-all}' +
      '.dsh-vsced-wiz-log{margin-top:10px;font-size:12px;color:var(--dsw-alias-label-tertiary,#999);line-height:1.7}' +
      '.dsh-vsced-wiz-log code{user-select:all;background:rgba(128,128,128,.15);padding:1px 5px;border-radius:4px}' +
      '.dsh-vsced-wiz-btns{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}' +
      '@keyframes dsh-vsced-spin{to{transform:rotate(360deg)}}' +
      '.dsh-vsced-spin{display:inline-block;animation:dsh-vsced-spin 1s linear infinite}' +
      '.dsh-vsced-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;font-size:13px;color:#999;padding:24px;text-align:center}' +
      '.dsh-vsced-dot{display:inline-block;width:8px;height:8px;border-radius:50%;flex:none}' +
      '.dsh-vsced-tab{display:inline-flex;align-items:center;gap:5px}' +
      '.dsh-vsced-tab .dsh-vsced-dot{width:7px;height:7px}' +
      'body.dsh-vsced-active [data-composer-seat]{display:none!important}'

    var LANG_IDS = { zh: 1, en: 1, 'pt-BR': 1, es: 1 }
    var LANG_OPTIONS = [
      { id: 'auto', key: 'lang.auto' },
      { id: 'zh', label: '简体中文' },
      { id: 'en', label: 'English' },
      { id: 'pt-BR', label: 'Português (Brasil)' },
      { id: 'es', label: 'Español' },
    ]

    var L10N = {
      zh: {
        'lang.auto': '自动（跟随 DSH 界面语言）',
        'st.loading': '加载中',
        'st.bridgeUnmounted': '桥接未挂载',
        'st.waitingTrust': '等待信任工作区',
        'st.localConnected': '本机 VS Code 已连接',
        'st.waitingExt': '等待扩展连接',
        'st.extNotInstalled': '扩展未安装',
        'st.noVscode': '未检测到 VS Code',
        'st.extConnected': '扩展已连接',
        'st.noCodeserver': '未安装 code-server',
        'st.notRunning': '未运行',
        'tab.editor': '编辑器',
        'tab.title': '内嵌编辑器 · {status}',
        'vs.local': '本机 VS Code',
        'vs.embedded': '内嵌编辑器',
        'tb.coverTitle': '切换编辑器是否遮住下方对话框（关掉后可以和 AI 边聊边看编辑器）',
        'tb.showChat': '💬 显示对话框',
        'tb.hideChat': '💬 隐藏对话框',
        'tb.followTitle': '跟随模式：只读，自动定位并显示 DSH 修改的红绿 diff；关闭后可编辑（DSH 占用文件仍锁定）',
        'tb.follow': '跟随 DSH 编辑',
        'tb.openWindow': '新窗口打开',
        'tb.restart': '重启',
        'empty.bridgeUnmounted': '编辑器桥接未挂载：插件被禁用，或 DSH 尚未带插件重启',
        'empty.starting': 'code-server 已启动但尚未就绪',
        'empty.notRunning': 'code-server 未运行',
        'empty.noCsHint': '没装 code-server 也能用：切到「本机 VS Code」模式，跟随/文件锁定体验一致。',
        'empty.switchLocal': '改用本机 VS Code →',
        'empty.tryStart': '尝试启动',
        'wiz.title': '连接本机 VS Code',
        'wiz.step1': '探测本机 VS Code',
        'wiz.step2': '检查 / 安装桥扩展',
        'wiz.step3': '等待扩展连接',
        'wiz.debugLog': '调试日志（可拷贝给开发者排查）：<br>扩展侧 <code>~/.dsh-editor/bridge-ext.log</code>',
        'wiz.error': '错误：',
        'wiz.cancel': '取消',
        'wiz.ok': '确定',
        'wiz.retry': '重试',
        'wiz.close': '关闭',
        'wiz.noLocalVscode': '未检测到本机 VS Code',
        'wiz.noVscodeHint': '未检测到 VS Code：请在「设置 → 插件配置」里手动指定 VS Code 路径后重试',
        'wiz.updatingOld': '发现旧版本 v{v}，正在更新…',
        'wiz.installing': '未安装，正在安装…',
        'wiz.manualCopy': '自动安装失败，可手动拷贝：{from} → {to}',
        'wiz.installFailed': '安装失败：{err}',
        'wiz.unknownError': '未知错误',
        'wiz.installedOk': '已安装 v{v}',
        'wiz.installedReload': '已安装 v{v}（若 VS Code 已打开，请 Reload Window）',
        'wiz.openWorkspaceHint': '请在 VS Code 中打开 DSH 当前工作区并【信任】它；刚装/更新过扩展需 Reload Window',
        'wiz.connectedWindow': '已连接窗口：{w}',
        'wiz.connected': '已连接',
        'wiz.trustRestricted': '已连接，但 VS Code 处于受限模式：请在 VS Code 的信任弹窗中信任该工作区（或命令面板 → 管理工作区信任），信任后自动继续',
        'wiz.waitingExtDetail': '等待扩展连接… 请确认 VS Code 已打开工作区 {ws} 并已【信任】它（必要时 Reload Window）',
        'wiz.timeout': '120 秒内未收到扩展连接',
        'wiz.extNotConnected': '扩展未连接：请确认扩展已启用、窗口已 Reload、工作区已打开并信任',
        'local.vscodeNotDetected': '未检测到（可在设置里手动指定路径）',
        'local.dshExt': 'DSH 扩展',
        'local.workspace': '工作区',
        'local.waitingSession': '等待会话',
        'local.connectedWindow': '已连接窗口',
        'local.connectedWinValue': '{ws} · 扩展 v{v}',
        'local.extLatest': '已安装 v{v}（最新）',
        'local.extNew': '已安装 v{v}（有新版本 v{newer}）',
        'ext.notInstalled': '未安装',
        'local.trustWarning': '⚠️ VS Code 处于受限模式：请在 VS Code 中信任该工作区（命令面板 → 管理工作区信任），信任后才会同步编辑',
        'local.installDone': '安装完成：请在 VS Code 中 Reload Window（或重启 VS Code）使扩展生效',
        'local.installManual': '自动安装失败：{err}。可手动拷贝 {from} 到 {to}',
        'local.installFailed': '安装失败：{err}',
        'btn.updateExt': '更新扩展',
        'btn.installExt': '安装扩展到本机 VS Code',
        'btn.redetect': '重新检测',
        'btn.wizard': '连接向导',
        'local.hint': '本机模式下请在桌面 VS Code 中打开当前工作区（{ws}），扩展会自动与 DSH 握手。',
        'settings.name': '内嵌 VSCode 编辑器',
        'settings.desc': 'code-server 内嵌编辑器：跟随编辑、自动启动、端口与工作区。',
        'settings.collapse': '收起设置',
        'settings.expand': '展开设置',
        'settings.aria': '{action}：{name}',
        'settings.backend': '编辑器后端',
        'settings.backendEmbedded': '内嵌 code-server',
        'settings.vscodePath': 'VS Code 路径',
        'settings.vscodePathPh': '留空 = 自动探测（常见路径 → which/where/mdfind）',
        'settings.detectedPrefix': '检测到：{cli}{ver}',
        'settings.extLatest': ' · 扩展 v{v}（最新）',
        'settings.extUpdate': ' · 扩展 v{v}（可更新到 v{newer}）',
        'settings.extNone': ' · 扩展未安装',
        'settings.followHint': '改文件时自动弹出红绿 diff 并定位到改动行',
        'settings.followWs': '仅跟随工作区内文件',
        'settings.followWsHint': '开启后，工作区外的改动只记录到最近列表，不弹 diff',
        'settings.autoStart': '自动启动 code-server',
        'settings.autoStartHint': '关闭后需在「编辑器」标签页手动启动',
        'settings.port': '端口',
        'settings.portHint': '0 = 随机（18200–18900）；改动会自动重启编辑器',
        'settings.csHome': 'code-server 目录',
        'settings.csHomePh': '留空 = 自动查找（$DSH_VSCEDITOR_HOME → 工作区/.dsh-editor → ~/.dsh-editor）',
        'settings.currentInstance': '当前实例：{url} · 工作区：{ws}',
        'settings.unavailable': '⚠️ 设置服务不可用，以上改动仅本次运行有效',
        'settings.language': '界面语言',
        'host.workspace-switched': '工作区已切换：{cwd}',
        'host.ext-updated': '桌面 VS Code 的 DSH 扩展已更新到 v{v}，请在 VS Code 里 Reload Window 生效',
        'host.waiting-session': '等待第一个会话以确定工作区…',
        'host.codeserver-missing-win': '未找到 code-server（Windows 布局：code-server/node/node.exe + code-server/runtime/…/entry.js；查找过 配置的 codeServerHome、$DSH_VSCEDITOR_HOME、<工作区>/.dsh-editor、~/.dsh-editor）。请运行 scripts/install-code-server.ps1 安装；{hint}',
        'host.codeserver-missing-unix': '未找到 code-server（查找过 配置的 codeServerHome、$DSH_VSCEDITOR_HOME、<工作区>/.dsh-editor、~/.dsh-editor）。请运行 scripts/install-code-server.sh 安装；{hint}',
        'host.codeserver-hint': '不装 code-server 也可以改用「本机 VS Code」模式（设置 → 插件配置 → 编辑器后端），跟随/锁定体验一致',
        'host.bridge-write-failed': 'bridge.json 写入失败：{err}',
        'host.settings-ns-failed': '设置命名空间注册失败：{err}',
        'host.install-done': 'code-server 安装完成，正在启动…',
        'st.installing': '安装 code-server 中',
        'btn.installCs': '⬇ 一键安装 code-server',
        'btn.installing': '⏳ 正在安装{p}…（查看进度）',
        'empty.installHint': '自动从 code-server 官方 release 下载并安装到 ~/.dsh-editor（约 80MB，仅首次需要）',
        'settings.installHint': '自动下载官方 code-server 到 ~/.dsh-editor（约 80MB）',
        'iwz.title': '安装 code-server',
        'iwz.step1': '下载并安装 code-server（自动匹配系统架构，约 80MB）',
        'iwz.step2': '启动内嵌编辑器',
        'iwz.step3': '等待桥扩展连接',
        'iwz.dlUrl': '下载地址：',
        'iwz.dlDest': '安装到：',
        'iwz.starting': '正在启动安装…',
        'iwz.downloading': '下载中（网络慢时可能需要几分钟）…',
        'iwz.cancelling': '正在取消…',
        'iwz.cancelled': '已取消',
        'iwz.cancelledInfo': '已取消安装（已下载的临时文件已自动清理）',
        'iwz.scriptFailed': '安装脚本失败',
        'iwz.installedTo': '已安装到 ~/.dsh-editor',
        'iwz.started': '已启动',
        'iwz.ready': '编辑器已就绪',
        'iwz.step3Guide': '差最后一步：关闭本弹窗，点击对话界面上方的「编辑器」标签页；页面加载后扩展会自动完成握手',
        'iwz.okDone': '安装完成，编辑器已就绪。此弹窗可直接关闭。',
        'iwz.okGuide': '安装完成！点「完成」关闭弹窗，然后点击对话界面上方的「编辑器」标签页即可开始使用。',
        'iwz.startFailed': '启动失败，详见下方错误',
        'iwz.timeout': '等待超时（15 分钟）',
        'iwz.timeoutDetail': '超时：安装可能仍在后台进行，可稍后回到编辑器标签页查看状态',
        'iwz.logTail': '安装日志尾部：',
        'iwz.manualHint': '可改用命令行手动安装：',
        'iwz.manualWin': '（Windows 用 PowerShell 运行同目录的 install-code-server.ps1）',
        'iwz.error': '错误：',
        'iwz.cancelInstall': '取消安装',
        'iwz.background': '后台继续',
        'iwz.done': '完成',
        'iwz.retry': '重试',
        'iwz.close': '关闭',
      },
      en: {
        'lang.auto': 'Auto (follow DSH UI language)',
        'st.loading': 'Loading',
        'st.bridgeUnmounted': 'Bridge not mounted',
        'st.waitingTrust': 'Waiting for workspace trust',
        'st.localConnected': 'Local VS Code connected',
        'st.waitingExt': 'Waiting for extension',
        'st.extNotInstalled': 'Extension not installed',
        'st.noVscode': 'VS Code not detected',
        'st.extConnected': 'Extension connected',
        'st.noCodeserver': 'code-server not installed',
        'st.notRunning': 'Not running',
        'tab.editor': 'Editor',
        'tab.title': 'Editor · {status}',
        'vs.local': 'Local VS Code',
        'vs.embedded': 'Embedded editor',
        'tb.coverTitle': 'Toggle whether the editor covers the chat box below (turn off to chat with the AI while watching the editor)',
        'tb.showChat': '💬 Show chat',
        'tb.hideChat': '💬 Hide chat',
        'tb.followTitle': 'Follow mode: read-only, automatically locates and shows DSH changes as red/green diffs; turn off to edit (files held by DSH stay locked)',
        'tb.follow': 'Follow DSH edits',
        'tb.openWindow': 'Open in new window',
        'tb.restart': 'Restart',
        'empty.bridgeUnmounted': 'Editor bridge not mounted: the plugin is disabled, or DSH has not been restarted with the plugin',
        'empty.starting': 'code-server started but not ready yet',
        'empty.notRunning': 'code-server not running',
        'empty.noCsHint': 'No code-server? Switch to the "Local VS Code" mode — follow mode and file locking work the same.',
        'empty.switchLocal': 'Switch to local VS Code →',
        'empty.tryStart': 'Try to start',
        'wiz.title': 'Connect local VS Code',
        'wiz.step1': 'Detect local VS Code',
        'wiz.step2': 'Check / install bridge extension',
        'wiz.step3': 'Wait for extension connection',
        'wiz.debugLog': 'Debug log (copy it when reporting issues):<br>extension side <code>~/.dsh-editor/bridge-ext.log</code>',
        'wiz.error': 'Error: ',
        'wiz.cancel': 'Cancel',
        'wiz.ok': 'OK',
        'wiz.retry': 'Retry',
        'wiz.close': 'Close',
        'wiz.noLocalVscode': 'Local VS Code not detected',
        'wiz.noVscodeHint': 'VS Code not detected: set the VS Code path manually under "Settings → Plugin config" and retry',
        'wiz.updatingOld': 'Found old version v{v}, updating…',
        'wiz.installing': 'Not installed, installing…',
        'wiz.manualCopy': 'Automatic install failed; copy manually: {from} → {to}',
        'wiz.installFailed': 'Install failed: {err}',
        'wiz.unknownError': 'Unknown error',
        'wiz.installedOk': 'Installed v{v}',
        'wiz.installedReload': 'Installed v{v} (Reload Window if VS Code is already open)',
        'wiz.openWorkspaceHint': 'Open the DSH workspace in VS Code and trust it; if the extension was just installed/updated, Reload Window',
        'wiz.connectedWindow': 'Connected window: {w}',
        'wiz.connected': 'Connected',
        'wiz.trustRestricted': 'Connected, but VS Code is in restricted mode: trust the workspace in the VS Code trust prompt (or Command Palette → Manage Workspace Trust) to continue automatically',
        'wiz.waitingExtDetail': 'Waiting for the extension… make sure VS Code has the {ws} workspace open and trusted (Reload Window if needed)',
        'wiz.timeout': 'No extension connection within 120 s',
        'wiz.extNotConnected': 'Extension not connected: make sure it is enabled, the window was reloaded, and the workspace is open and trusted',
        'local.vscodeNotDetected': 'Not detected (set the path in settings)',
        'local.dshExt': 'DSH extension',
        'local.workspace': 'Workspace',
        'local.waitingSession': 'Waiting for a session',
        'local.connectedWindow': 'Connected window',
        'local.connectedWinValue': '{ws} · ext v{v}',
        'local.extLatest': 'Installed v{v} (latest)',
        'local.extNew': 'Installed v{v} (v{newer} available)',
        'ext.notInstalled': 'Not installed',
        'local.trustWarning': '⚠️ VS Code is in restricted mode: trust the workspace in VS Code (Command Palette → Manage Workspace Trust) to enable edit sync',
        'local.installDone': 'Install finished: Reload Window in VS Code (or restart VS Code) to activate the extension',
        'local.installManual': 'Automatic install failed: {err}. Copy {from} to {to} manually',
        'local.installFailed': 'Install failed: {err}',
        'btn.updateExt': 'Update extension',
        'btn.installExt': 'Install extension in local VS Code',
        'btn.redetect': 'Detect again',
        'btn.wizard': 'Connection wizard',
        'local.hint': 'In local mode, open the current workspace ({ws}) in desktop VS Code; the extension handshakes with DSH automatically.',
        'settings.name': 'Embedded VS Code editor',
        'settings.desc': 'Embedded code-server editor: follow edits, auto-start, port and workspace.',
        'settings.collapse': 'Collapse settings',
        'settings.expand': 'Expand settings',
        'settings.aria': '{action}: {name}',
        'settings.backend': 'Editor backend',
        'settings.backendEmbedded': 'Embedded code-server',
        'settings.vscodePath': 'VS Code path',
        'settings.vscodePathPh': 'Empty = auto-detect (common paths → which/where/mdfind)',
        'settings.detectedPrefix': 'Detected: {cli}{ver}',
        'settings.extLatest': ' · ext v{v} (latest)',
        'settings.extUpdate': ' · ext v{v} (upgradable to v{newer})',
        'settings.extNone': ' · extension not installed',
        'settings.followHint': 'Shows a red/green diff and jumps to the changed lines when files are edited',
        'settings.followWs': 'Only follow workspace files',
        'settings.followWsHint': 'When on, changes outside the workspace are only listed under Recent, without a diff popup',
        'settings.autoStart': 'Auto-start code-server',
        'settings.autoStartHint': 'When off, start it manually from the "Editor" tab',
        'settings.port': 'Port',
        'settings.portHint': '0 = random (18200–18900); changes restart the editor',
        'settings.csHome': 'code-server directory',
        'settings.csHomePh': 'Empty = auto-detect ($DSH_VSCEDITOR_HOME → workspace/.dsh-editor → ~/.dsh-editor)',
        'settings.currentInstance': 'Current instance: {url} · workspace: {ws}',
        'settings.unavailable': '⚠️ Settings service unavailable; these changes apply to this run only',
        'settings.language': 'UI language',
        'host.workspace-switched': 'Workspace switched: {cwd}',
        'host.ext-updated': 'The DSH extension in desktop VS Code was updated to v{v}; Reload Window in VS Code to apply it',
        'host.waiting-session': 'Waiting for the first session to determine the workspace…',
        'host.codeserver-missing-win': 'code-server not found (Windows layout: code-server/node/node.exe + code-server/runtime/…/entry.js; looked in the configured codeServerHome, $DSH_VSCEDITOR_HOME, <workspace>/.dsh-editor, ~/.dsh-editor). Run scripts/install-code-server.ps1 to install; {hint}',
        'host.codeserver-missing-unix': 'code-server not found (looked in the configured codeServerHome, $DSH_VSCEDITOR_HOME, <workspace>/.dsh-editor, ~/.dsh-editor). Run scripts/install-code-server.sh to install; {hint}',
        'host.codeserver-hint': 'No code-server? Switch to the "Local VS Code" backend (Settings → Plugin config → Editor backend) — follow mode and locking work the same',
        'host.bridge-write-failed': 'Failed to write bridge.json: {err}',
        'host.settings-ns-failed': 'Failed to register the settings namespace: {err}',
        'host.install-done': 'code-server installed, starting…',
        'st.installing': 'Installing code-server',
        'btn.installCs': '⬇ Install code-server',
        'btn.installing': '⏳ Installing{p}… (view progress)',
        'empty.installHint': 'Downloads the official code-server release to ~/.dsh-editor (~80MB, first time only)',
        'settings.installHint': 'Downloads the official code-server to ~/.dsh-editor (~80MB)',
        'iwz.title': 'Install code-server',
        'iwz.step1': 'Download and install code-server (auto-detects platform, ~80MB)',
        'iwz.step2': 'Start the embedded editor',
        'iwz.step3': 'Wait for bridge extension connection',
        'iwz.dlUrl': 'Download URL: ',
        'iwz.dlDest': 'Install to: ',
        'iwz.starting': 'Starting installation…',
        'iwz.downloading': 'Downloading (may take a few minutes on slow networks)…',
        'iwz.cancelling': 'Cancelling…',
        'iwz.cancelled': 'Cancelled',
        'iwz.cancelledInfo': 'Installation cancelled (partial downloads were cleaned up automatically)',
        'iwz.scriptFailed': 'Install script failed',
        'iwz.installedTo': 'Installed to ~/.dsh-editor',
        'iwz.started': 'Started',
        'iwz.ready': 'Editor is ready',
        'iwz.step3Guide': 'One last step: close this dialog and click the "Editor" tab above the conversation view; the extension handshakes automatically once the page loads',
        'iwz.okDone': 'Installation complete — the editor is ready. You can close this dialog.',
        'iwz.okGuide': 'Installation complete! Click "Done" to close, then open the "Editor" tab above the conversation view to start using it.',
        'iwz.startFailed': 'Failed to start — see the error below',
        'iwz.timeout': 'Timed out (15 minutes)',
        'iwz.timeoutDetail': 'Timed out: the installation may still be running in the background; check the Editor tab status later',
        'iwz.logTail': 'Install log tail:',
        'iwz.manualHint': 'Or install manually from the command line:',
        'iwz.manualWin': '(On Windows, run install-code-server.ps1 in the same directory with PowerShell)',
        'iwz.error': 'Error: ',
        'iwz.cancelInstall': 'Cancel install',
        'iwz.background': 'Run in background',
        'iwz.done': 'Done',
        'iwz.retry': 'Retry',
        'iwz.close': 'Close',
      },
      'pt-BR': {
        'lang.auto': 'Automático (segue o idioma do DSH)',
        'st.loading': 'Carregando',
        'st.bridgeUnmounted': 'Ponte não montada',
        'st.waitingTrust': 'Aguardando confiança do workspace',
        'st.localConnected': 'VS Code local conectado',
        'st.waitingExt': 'Aguardando a extensão',
        'st.extNotInstalled': 'Extensão não instalada',
        'st.noVscode': 'VS Code não detectado',
        'st.extConnected': 'Extensão conectada',
        'st.noCodeserver': 'code-server não instalado',
        'st.notRunning': 'Não está em execução',
        'tab.editor': 'Editor',
        'tab.title': 'Editor · {status}',
        'vs.local': 'VS Code local',
        'vs.embedded': 'Editor integrado',
        'tb.coverTitle': 'Alterna se o editor cobre a caixa de conversa abaixo (desative para conversar com a IA enquanto vê o editor)',
        'tb.showChat': '💬 Mostrar conversa',
        'tb.hideChat': '💬 Ocultar conversa',
        'tb.followTitle': 'Modo seguir: somente leitura, localiza e mostra automaticamente as mudanças do DSH como diff vermelho/verde; desative para editar (arquivos em uso pelo DSH continuam bloqueados)',
        'tb.follow': 'Seguir edições do DSH',
        'tb.openWindow': 'Abrir em nova janela',
        'tb.restart': 'Reiniciar',
        'empty.bridgeUnmounted': 'Ponte do editor não montada: o plugin está desabilitado ou o DSH não foi reiniciado com o plugin',
        'empty.starting': 'code-server iniciado, mas ainda não está pronto',
        'empty.notRunning': 'code-server não está em execução',
        'empty.noCsHint': 'Sem code-server? Mude para o modo «VS Code local» — seguir e bloqueio de arquivos funcionam igual.',
        'empty.switchLocal': 'Usar VS Code local →',
        'empty.tryStart': 'Tentar iniciar',
        'wiz.title': 'Conectar VS Code local',
        'wiz.step1': 'Detectar VS Code local',
        'wiz.step2': 'Verificar / instalar extensão ponte',
        'wiz.step3': 'Aguardar conexão da extensão',
        'wiz.debugLog': 'Registro de depuração (copie ao reportar problemas):<br>lado da extensão <code>~/.dsh-editor/bridge-ext.log</code>',
        'wiz.error': 'Erro: ',
        'wiz.cancel': 'Cancelar',
        'wiz.ok': 'OK',
        'wiz.retry': 'Tentar de novo',
        'wiz.close': 'Fechar',
        'wiz.noLocalVscode': 'VS Code local não detectado',
        'wiz.noVscodeHint': 'VS Code não detectado: informe o caminho do VS Code em «Configurações → Plugins» e tente de novo',
        'wiz.updatingOld': 'Versão antiga v{v} encontrada, atualizando…',
        'wiz.installing': 'Não instalada, instalando…',
        'wiz.manualCopy': 'Falha na instalação automática; copie manualmente: {from} → {to}',
        'wiz.installFailed': 'Falha na instalação: {err}',
        'wiz.unknownError': 'Erro desconhecido',
        'wiz.installedOk': 'Instalada v{v}',
        'wiz.installedReload': 'Instalada v{v} (faça Reload Window se o VS Code já estiver aberto)',
        'wiz.openWorkspaceHint': 'Abra o workspace atual do DSH no VS Code e confie nele; se a extensão acabou de ser instalada/atualizada, faça Reload Window',
        'wiz.connectedWindow': 'Janela conectada: {w}',
        'wiz.connected': 'Conectado',
        'wiz.trustRestricted': 'Conectado, mas o VS Code está em modo restrito: confie no workspace na notificação do VS Code (ou Paleta de Comandos → Gerenciar Confiança do Workspace) para continuar automaticamente',
        'wiz.waitingExtDetail': 'Aguardando a extensão… confirme que o VS Code tem o workspace {ws} aberto e confiável (faça Reload Window se necessário)',
        'wiz.timeout': 'Sem conexão da extensão em 120 s',
        'wiz.extNotConnected': 'Extensão não conectada: confirme que ela está habilitada, que a janela foi recarregada e que o workspace está aberto e confiável',
        'local.vscodeNotDetected': 'Não detectado (informe o caminho nas configurações)',
        'local.dshExt': 'Extensão DSH',
        'local.workspace': 'Workspace',
        'local.waitingSession': 'Aguardando uma sessão',
        'local.connectedWindow': 'Janela conectada',
        'local.connectedWinValue': '{ws} · ext v{v}',
        'local.extLatest': 'Instalada v{v} (mais recente)',
        'local.extNew': 'Instalada v{v} (há v{newer} mais recente)',
        'ext.notInstalled': 'Não instalada',
        'local.trustWarning': '⚠️ VS Code em modo restrito: confie no workspace no VS Code (Paleta de Comandos → Gerenciar Confiança do Workspace) para sincronizar edições',
        'local.installDone': 'Instalação concluída: faça Reload Window no VS Code (ou reinicie o VS Code) para ativar a extensão',
        'local.installManual': 'Falha na instalação automática: {err}. Copie {from} para {to} manualmente',
        'local.installFailed': 'Falha na instalação: {err}',
        'btn.updateExt': 'Atualizar extensão',
        'btn.installExt': 'Instalar extensão no VS Code local',
        'btn.redetect': 'Detectar de novo',
        'btn.wizard': 'Assistente de conexão',
        'local.hint': 'No modo local, abra o workspace atual ({ws}) no VS Code desktop; a extensão faz o handshake com o DSH automaticamente.',
        'settings.name': 'Editor VS Code integrado',
        'settings.desc': 'Editor code-server integrado: seguir edições, início automático, porta e workspace.',
        'settings.collapse': 'Recolher configurações',
        'settings.expand': 'Expandir configurações',
        'settings.aria': '{action}: {name}',
        'settings.backend': 'Backend do editor',
        'settings.backendEmbedded': 'code-server integrado',
        'settings.vscodePath': 'Caminho do VS Code',
        'settings.vscodePathPh': 'Vazio = detecção automática (caminhos comuns → which/where/mdfind)',
        'settings.detectedPrefix': 'Detectado: {cli}{ver}',
        'settings.extLatest': ' · ext v{v} (mais recente)',
        'settings.extUpdate': ' · ext v{v} (atualizável para v{newer})',
        'settings.extNone': ' · extensão não instalada',
        'settings.followHint': 'Mostra um diff vermelho/verde e salta para as linhas alteradas quando os arquivos mudam',
        'settings.followWs': 'Seguir apenas arquivos do workspace',
        'settings.followWsHint': 'Quando ativo, mudanças fora do workspace só entram na lista de recentes, sem diff',
        'settings.autoStart': 'Iniciar code-server automaticamente',
        'settings.autoStartHint': 'Quando desativado, inicie manualmente na aba «Editor»',
        'settings.port': 'Porta',
        'settings.portHint': '0 = aleatória (18200–18900); mudanças reiniciam o editor',
        'settings.csHome': 'Diretório do code-server',
        'settings.csHomePh': 'Vazio = busca automática ($DSH_VSCEDITOR_HOME → workspace/.dsh-editor → ~/.dsh-editor)',
        'settings.currentInstance': 'Instância atual: {url} · workspace: {ws}',
        'settings.unavailable': '⚠️ Serviço de configurações indisponível; estas mudanças valem só para esta execução',
        'settings.language': 'Idioma da interface',
        'host.workspace-switched': 'Workspace alterado: {cwd}',
        'host.ext-updated': 'A extensão DSH do VS Code desktop foi atualizada para v{v}; faça Reload Window no VS Code para aplicar',
        'host.waiting-session': 'Aguardando a primeira sessão para determinar o workspace…',
        'host.codeserver-missing-win': 'code-server não encontrado (layout do Windows: code-server/node/node.exe + code-server/runtime/…/entry.js; procurado em codeServerHome configurado, $DSH_VSCEDITOR_HOME, <workspace>/.dsh-editor, ~/.dsh-editor). Execute scripts/install-code-server.ps1 para instalar; {hint}',
        'host.codeserver-missing-unix': 'code-server não encontrado (procurado em codeServerHome configurado, $DSH_VSCEDITOR_HOME, <workspace>/.dsh-editor, ~/.dsh-editor). Execute scripts/install-code-server.sh para instalar; {hint}',
        'host.codeserver-hint': 'Sem code-server? Mude para o backend «VS Code local» (Configurações → Plugins → Backend do editor) — seguir e bloquear funcionam igual',
        'host.bridge-write-failed': 'Falha ao gravar bridge.json: {err}',
        'host.settings-ns-failed': 'Falha ao registrar o namespace de configurações: {err}',
        'host.install-done': 'code-server instalado, iniciando…',
        'st.installing': 'Instalando code-server',
        'btn.installCs': '⬇ Instalar code-server',
        'btn.installing': '⏳ Instalando{p}… (ver progresso)',
        'empty.installHint': 'Baixa o release oficial do code-server para ~/.dsh-editor (~80MB, apenas na primeira vez)',
        'settings.installHint': 'Baixa o code-server oficial para ~/.dsh-editor (~80MB)',
        'iwz.title': 'Instalar code-server',
        'iwz.step1': 'Baixar e instalar o code-server (detecta a plataforma automaticamente, ~80MB)',
        'iwz.step2': 'Iniciar o editor integrado',
        'iwz.step3': 'Aguardar conexão da extensão de ponte',
        'iwz.dlUrl': 'URL de download: ',
        'iwz.dlDest': 'Instalar em: ',
        'iwz.starting': 'Iniciando a instalação…',
        'iwz.downloading': 'Baixando (pode levar alguns minutos em redes lentas)…',
        'iwz.cancelling': 'Cancelando…',
        'iwz.cancelled': 'Cancelado',
        'iwz.cancelledInfo': 'Instalação cancelada (downloads parciais foram limpos automaticamente)',
        'iwz.scriptFailed': 'O script de instalação falhou',
        'iwz.installedTo': 'Instalado em ~/.dsh-editor',
        'iwz.started': 'Iniciado',
        'iwz.ready': 'Editor pronto',
        'iwz.step3Guide': 'Último passo: feche este diálogo e clique na aba «Editor» acima da conversa; a extensão faz o handshake automaticamente quando a página carrega',
        'iwz.okDone': 'Instalação concluída, o editor está pronto. Você pode fechar este diálogo.',
        'iwz.okGuide': 'Instalação concluída! Clique em «Concluir» para fechar e abra a aba «Editor» acima da conversa para começar a usar.',
        'iwz.startFailed': 'Falha ao iniciar, veja o erro abaixo',
        'iwz.timeout': 'Tempo esgotado (15 minutos)',
        'iwz.timeoutDetail': 'Tempo esgotado: a instalação pode ainda estar em segundo plano; verifique o status na aba Editor mais tarde',
        'iwz.logTail': 'Final do log de instalação:',
        'iwz.manualHint': 'Ou instale manualmente pela linha de comando:',
        'iwz.manualWin': '(No Windows, execute install-code-server.ps1 no mesmo diretório com PowerShell)',
        'iwz.error': 'Erro: ',
        'iwz.cancelInstall': 'Cancelar instalação',
        'iwz.background': 'Continuar em segundo plano',
        'iwz.done': 'Concluir',
        'iwz.retry': 'Tentar novamente',
        'iwz.close': 'Fechar',
      },
      es: {
        'lang.auto': 'Automático (según el idioma de DSH)',
        'st.loading': 'Cargando',
        'st.bridgeUnmounted': 'Puente no montado',
        'st.waitingTrust': 'Esperando confianza del workspace',
        'st.localConnected': 'VS Code local conectado',
        'st.waitingExt': 'Esperando la extensión',
        'st.extNotInstalled': 'Extensión no instalada',
        'st.noVscode': 'VS Code no detectado',
        'st.extConnected': 'Extensión conectada',
        'st.noCodeserver': 'code-server no instalado',
        'st.notRunning': 'No está en ejecución',
        'tab.editor': 'Editor',
        'tab.title': 'Editor · {status}',
        'vs.local': 'VS Code local',
        'vs.embedded': 'Editor incrustado',
        'tb.coverTitle': 'Alterna si el editor cubre el cuadro de chat inferior (desactívalo para chatear con la IA mientras ves el editor)',
        'tb.showChat': '💬 Mostrar chat',
        'tb.hideChat': '💬 Ocultar chat',
        'tb.followTitle': 'Modo seguir: solo lectura, localiza y muestra automáticamente los cambios de DSH como diff rojo/verde; desactívalo para editar (los archivos ocupados por DSH siguen bloqueados)',
        'tb.follow': 'Seguir ediciones de DSH',
        'tb.openWindow': 'Abrir en ventana nueva',
        'tb.restart': 'Reiniciar',
        'empty.bridgeUnmounted': 'Puente del editor no montado: el plugin está deshabilitado o DSH no se ha reiniciado con el plugin',
        'empty.starting': 'code-server iniciado pero aún no está listo',
        'empty.notRunning': 'code-server no está en ejecución',
        'empty.noCsHint': '¿Sin code-server? Cambia al modo «VS Code local» — seguir y el bloqueo de archivos funcionan igual.',
        'empty.switchLocal': 'Usar VS Code local →',
        'empty.tryStart': 'Intentar iniciar',
        'wiz.title': 'Conectar VS Code local',
        'wiz.step1': 'Detectar VS Code local',
        'wiz.step2': 'Comprobar / instalar la extensión puente',
        'wiz.step3': 'Esperar conexión de la extensión',
        'wiz.debugLog': 'Registro de depuración (cópielo al reportar problemas):<br>lado de la extensión <code>~/.dsh-editor/bridge-ext.log</code>',
        'wiz.error': 'Error: ',
        'wiz.cancel': 'Cancelar',
        'wiz.ok': 'Aceptar',
        'wiz.retry': 'Reintentar',
        'wiz.close': 'Cerrar',
        'wiz.noLocalVscode': 'VS Code local no detectado',
        'wiz.noVscodeHint': 'VS Code no detectado: indica la ruta de VS Code en «Configuración → Plugins» y vuelve a intentarlo',
        'wiz.updatingOld': 'Versión antigua v{v} encontrada, actualizando…',
        'wiz.installing': 'No instalada, instalando…',
        'wiz.manualCopy': 'Falló la instalación automática; copia manualmente: {from} → {to}',
        'wiz.installFailed': 'Falló la instalación: {err}',
        'wiz.unknownError': 'Error desconocido',
        'wiz.installedOk': 'Instalada v{v}',
        'wiz.installedReload': 'Instalada v{v} (haz Reload Window si VS Code ya está abierto)',
        'wiz.openWorkspaceHint': 'Abre el workspace actual de DSH en VS Code y confía en él; si la extensión acaba de instalarse/actualizarse, haz Reload Window',
        'wiz.connectedWindow': 'Ventana conectada: {w}',
        'wiz.connected': 'Conectado',
        'wiz.trustRestricted': 'Conectado, pero VS Code está en modo restringido: confía en el workspace en el aviso de VS Code (o Paleta de Comandos → Gestionar confianza del workspace) para continuar automáticamente',
        'wiz.waitingExtDetail': 'Esperando la extensión… confirma que VS Code tiene abierto el workspace {ws} y de confianza (haz Reload Window si es necesario)',
        'wiz.timeout': 'Sin conexión de la extensión en 120 s',
        'wiz.extNotConnected': 'Extensión no conectada: confirma que está habilitada, que la ventana se recargó y que el workspace está abierto y es de confianza',
        'local.vscodeNotDetected': 'No detectado (indica la ruta en la configuración)',
        'local.dshExt': 'Extensión DSH',
        'local.workspace': 'Workspace',
        'local.waitingSession': 'Esperando una sesión',
        'local.connectedWindow': 'Ventana conectada',
        'local.connectedWinValue': '{ws} · ext v{v}',
        'local.extLatest': 'Instalada v{v} (más reciente)',
        'local.extNew': 'Instalada v{v} (hay v{newer} más reciente)',
        'ext.notInstalled': 'No instalada',
        'local.trustWarning': '⚠️ VS Code en modo restringido: confía en el workspace en VS Code (Paleta de Comandos → Gestionar confianza del workspace) para sincronizar ediciones',
        'local.installDone': 'Instalación completada: haz Reload Window en VS Code (o reinicia VS Code) para activar la extensión',
        'local.installManual': 'Falló la instalación automática: {err}. Copia {from} en {to} manualmente',
        'local.installFailed': 'Falló la instalación: {err}',
        'btn.updateExt': 'Actualizar extensión',
        'btn.installExt': 'Instalar extensión en VS Code local',
        'btn.redetect': 'Detectar de nuevo',
        'btn.wizard': 'Asistente de conexión',
        'local.hint': 'En modo local, abre el workspace actual ({ws}) en el VS Code de escritorio; la extensión hace el handshake con DSH automáticamente.',
        'settings.name': 'Editor VS Code incrustado',
        'settings.desc': 'Editor code-server incrustado: seguir ediciones, inicio automático, puerto y workspace.',
        'settings.collapse': 'Plegar configuración',
        'settings.expand': 'Desplegar configuración',
        'settings.aria': '{action}: {name}',
        'settings.backend': 'Backend del editor',
        'settings.backendEmbedded': 'code-server incrustado',
        'settings.vscodePath': 'Ruta de VS Code',
        'settings.vscodePathPh': 'Vacío = detección automática (rutas comunes → which/where/mdfind)',
        'settings.detectedPrefix': 'Detectado: {cli}{ver}',
        'settings.extLatest': ' · ext v{v} (más reciente)',
        'settings.extUpdate': ' · ext v{v} (actualizable a v{newer})',
        'settings.extNone': ' · extensión no instalada',
        'settings.followHint': 'Muestra un diff rojo/verde y salta a las líneas modificadas cuando cambian los archivos',
        'settings.followWs': 'Seguir solo archivos del workspace',
        'settings.followWsHint': 'Al activarlo, los cambios fuera del workspace solo se registran en la lista de recientes, sin diff',
        'settings.autoStart': 'Iniciar code-server automáticamente',
        'settings.autoStartHint': 'Desactivado, hay que iniciarlo manualmente en la pestaña «Editor»',
        'settings.port': 'Puerto',
        'settings.portHint': '0 = aleatorio (18200–18900); los cambios reinician el editor',
        'settings.csHome': 'Directorio de code-server',
        'settings.csHomePh': 'Vacío = búsqueda automática ($DSH_VSCEDITOR_HOME → workspace/.dsh-editor → ~/.dsh-editor)',
        'settings.currentInstance': 'Instancia actual: {url} · workspace: {ws}',
        'settings.unavailable': '⚠️ Servicio de configuración no disponible; estos cambios solo valen para esta ejecución',
        'settings.language': 'Idioma de la interfaz',
        'host.workspace-switched': 'Workspace cambiado: {cwd}',
        'host.ext-updated': 'La extensión DSH del VS Code de escritorio se actualizó a v{v}; haz Reload Window en VS Code para aplicarla',
        'host.waiting-session': 'Esperando la primera sesión para determinar el workspace…',
        'host.codeserver-missing-win': 'No se encontró code-server (disposición de Windows: code-server/node/node.exe + code-server/runtime/…/entry.js; se buscó en codeServerHome configurado, $DSH_VSCEDITOR_HOME, <workspace>/.dsh-editor, ~/.dsh-editor). Ejecuta scripts/install-code-server.ps1 para instalarlo; {hint}',
        'host.codeserver-missing-unix': 'No se encontró code-server (se buscó en codeServerHome configurado, $DSH_VSCEDITOR_HOME, <workspace>/.dsh-editor, ~/.dsh-editor). Ejecuta scripts/install-code-server.sh para instalarlo; {hint}',
        'host.codeserver-hint': '¿Sin code-server? Cambia al backend «VS Code local» (Configuración → Plugins → Backend del editor) — seguir y bloquear funcionan igual',
        'host.bridge-write-failed': 'Error al escribir bridge.json: {err}',
        'host.settings-ns-failed': 'Error al registrar el espacio de nombres de configuración: {err}',
        'host.install-done': 'code-server instalado, iniciando…',
        'st.installing': 'Instalando code-server',
        'btn.installCs': '⬇ Instalar code-server',
        'btn.installing': '⏳ Instalando{p}… (ver progreso)',
        'empty.installHint': 'Descarga el release oficial de code-server a ~/.dsh-editor (~80MB, solo la primera vez)',
        'settings.installHint': 'Descarga el code-server oficial a ~/.dsh-editor (~80MB)',
        'iwz.title': 'Instalar code-server',
        'iwz.step1': 'Descargar e instalar code-server (detecta la plataforma automáticamente, ~80MB)',
        'iwz.step2': 'Iniciar el editor integrado',
        'iwz.step3': 'Esperar la conexión de la extensión puente',
        'iwz.dlUrl': 'URL de descarga: ',
        'iwz.dlDest': 'Instalar en: ',
        'iwz.starting': 'Iniciando la instalación…',
        'iwz.downloading': 'Descargando (puede tardar unos minutos en redes lentas)…',
        'iwz.cancelling': 'Cancelando…',
        'iwz.cancelled': 'Cancelado',
        'iwz.cancelledInfo': 'Instalación cancelada (las descargas parciales se limpiaron automáticamente)',
        'iwz.scriptFailed': 'El script de instalación falló',
        'iwz.installedTo': 'Instalado en ~/.dsh-editor',
        'iwz.started': 'Iniciado',
        'iwz.ready': 'Editor listo',
        'iwz.step3Guide': 'Último paso: cierra este diálogo y haz clic en la pestaña «Editor» sobre la conversación; la extensión hace el handshake automáticamente cuando la página carga',
        'iwz.okDone': 'Instalación completada, el editor está listo. Puedes cerrar este diálogo.',
        'iwz.okGuide': '¡Instalación completada! Haz clic en «Listo» para cerrar y abre la pestaña «Editor» sobre la conversación para empezar a usarlo.',
        'iwz.startFailed': 'Error al iniciar, consulta el error abajo',
        'iwz.timeout': 'Tiempo agotado (15 minutos)',
        'iwz.timeoutDetail': 'Tiempo agotado: la instalación puede seguir en segundo plano; revisa el estado en la pestaña Editor más tarde',
        'iwz.logTail': 'Final del log de instalación:',
        'iwz.manualHint': 'O instálalo manualmente desde la línea de comandos:',
        'iwz.manualWin': '(En Windows, ejecuta install-code-server.ps1 en el mismo directorio con PowerShell)',
        'iwz.error': 'Error: ',
        'iwz.cancelInstall': 'Cancelar instalación',
        'iwz.background': 'Seguir en segundo plano',
        'iwz.done': 'Listo',
        'iwz.retry': 'Reintentar',
        'iwz.close': 'Cerrar',
      },
    }

    // DSH 自身的界面语言（zh/en），由 ctx.locale 服务实时同步；auto 模式下
    // 优先于浏览器语言，这样切换 DSH 语言时插件界面立刻跟随。
    var dshLocale = ''

    function browserLang() {
      var n = String((typeof navigator !== 'undefined' && (navigator.language || navigator.userLanguage)) || 'en').toLowerCase()
      if (n.indexOf('zh') === 0) return 'zh'
      if (n.indexOf('pt') === 0) return 'pt-BR'
      if (n.indexOf('es') === 0) return 'es'
      return 'en'
    }

    function langOf(st) {
      var cfg = st && st.config
      if (cfg && LANG_IDS[cfg.language]) return cfg.language
      if (dshLocale && LANG_IDS[dshLocale]) return dshLocale
      return browserLang()
    }

    function fmt(s, params) {
      if (!params) return s
      return s.replace(/\{(\w+)\}/g, function (m, k) {
        return Object.prototype.hasOwnProperty.call(params, k) ? String(params[k]) : m
      })
    }

    function t(lang, key, params) {
      var d = L10N[lang] || L10N.en
      var s = d && d[key] !== undefined ? d[key] : (L10N.en[key] !== undefined ? L10N.en[key] : (L10N.zh[key] !== undefined ? L10N.zh[key] : key))
      return fmt(s, params)
    }

    function paren(lang, s) {
      if (!s) return ''
      return lang === 'zh' ? '（' + s + '）' : ' (' + s + ')'
    }

    function missingCodeServer(st) {
      if (!st) return false
      if (st.lastErrorCode === 'codeserver-missing-win' || st.lastErrorCode === 'codeserver-missing-unix') return true
      return !!(st.lastError && st.lastError.indexOf('未找到 code-server') >= 0)
    }

    function hostText(st, codeField, rawField, lang) {
      if (!st) return ''
      var code = st[codeField]
      if (code) {
        // host 发的参数字段是 lastErrorParams/noticeParams（不含 'Code'）
        var params = Object.assign({}, st[codeField.replace(/Code$/, 'Params')] || {}, { hint: t(lang, 'host.codeserver-hint') })
        return t(lang, 'host.' + code, params)
      }
      return st[rawField] || ''
    }

    // 最近一次成功拉到的状态，供无组件上下文的地方（如设置卡片的 label thunk）
    // 解析语言时使用。
    var lastSt = null

    function fetchState() {
      return fetch(STATE_URL, { cache: 'no-store' }).then(function (r) {
        if (!r.ok) throw new Error('http ' + r.status)
        return r.json()
      }).then(function (s) { lastSt = s; return s })
    }
    function postAction(body) {
      return fetch(ACTION_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then(function (r) { return r.json() }).catch(function () { return null })
    }
    function useEditorState() {
      var st = React.useState(null)
      React.useEffect(function () {
        var alive = true
        var tick = function () { fetchState().then(function (s) { if (alive) st[1](s) }).catch(function () { if (alive) st[1]({ failed: true }) }) }
        tick()
        var id = setInterval(tick, 2500)
        return function () { alive = false; clearInterval(id) }
      }, [])
      return st[0]
    }

    function dot(color) {
      return React.createElement('span', { className: 'dsh-vsced-dot', style: { background: color } })
    }
    function statusOf(st) {
      var lang = langOf(st)
      if (!st) return { color: '#888', text: t(lang, 'st.loading') }
      if (st.failed) return { color: '#f85149', text: t(lang, 'st.bridgeUnmounted') }
      if (st.backend === 'local' || (st.config && st.config.editorBackend === 'local')) {
        if (st.extConnected) {
          if (st.extReady && st.extReady.trusted === false) return { color: '#d29922', text: t(lang, 'st.waitingTrust') }
          return { color: '#3fb950', text: t(lang, 'st.localConnected') }
        }
        if (st.desktop && st.desktop.extInstalled) return { color: '#d29922', text: t(lang, 'st.waitingExt') }
        if (st.desktop && st.desktop.cli) return { color: '#f85149', text: t(lang, 'st.extNotInstalled') }
        return { color: '#f85149', text: t(lang, 'st.noVscode') }
      }
      if (st.extConnected) return { color: '#3fb950', text: t(lang, 'st.extConnected') }
      if (st.install && st.install.phase === 'running') return { color: '#d29922', text: t(lang, 'st.installing') + (st.install.progress ? ' ' + st.install.progress : '') }
      if (st.running) return { color: '#d29922', text: t(lang, 'st.waitingExt') }
      if (missingCodeServer(st)) return { color: '#f85149', text: t(lang, 'st.noCodeserver') }
      return { color: '#f85149', text: t(lang, 'st.notRunning') }
    }

    // ---- persistent code-server iframe (survives tab switches) ----
    // The shell unmounts inactive tab views, and a detached iframe loses its
    // browsing context — that was the "new session on every click" bug. So the
    // plugin owns the iframe: it stays attached to <body> forever and is only
    // hidden/shown + positioned over a placeholder the view renders.
    var frame = null
    var frameUrl = ''
    var anchorEl = null
    var anchorOn = false

    function ensureFrame(url) {
      if (!frame) {
        frame = document.createElement('iframe')
        frame.className = 'dsh-vsced-frame-float'
        frame.style.display = 'none'
        document.body.appendChild(frame)
      }
      if (url && url !== frameUrl) { frameUrl = url; frame.src = url }
    }
    function syncFrame() {
      if (!frame) return
      if (!anchorOn || !anchorEl || !frameUrl || !document.body.contains(anchorEl)) {
        if (frame.style.display !== 'none') frame.style.display = 'none'
        return
      }
      var r = anchorEl.getBoundingClientRect()
      if (r.width < 20 || r.height < 20) { frame.style.display = 'none'; return }
      if (frame.style.display !== 'block') frame.style.display = 'block'
      var css = r.top + 'px,' + r.left + 'px,' + r.width + 'px,' + r.height + 'px'
      if (frame.__lastCss !== css) {
        frame.__lastCss = css
        frame.style.top = r.top + 'px'
        frame.style.left = r.left + 'px'
        frame.style.width = r.width + 'px'
        frame.style.height = r.height + 'px'
      }
    }

    // ---- 本机 VS Code 连接向导 ----
    // 与常驻 iframe 同理：shell 会卸载非激活标签页的 React 树，弹窗放里面
    // 会被销毁，所以向导用命令式 DOM 挂在 body 上，切标签页也不中断。
    // 流程：探测 VS Code → 检查/安装桥扩展 → 等待扩展连接（最长 120s）。
    // 失败时给出扩展日志文件位置（~/.dsh-editor/bridge-ext.log）方便排查。
    var wizardEl = null

    function openWizard(initialSt) {
      if (wizardEl) return
      var lang = langOf(initialSt)
      var steps = [
        { label: t(lang, 'wiz.step1'), status: 'pending', detail: '' },
        { label: t(lang, 'wiz.step2'), status: 'pending', detail: '' },
        { label: t(lang, 'wiz.step3'), status: 'pending', detail: '' },
      ]
      var phase = 'running' // running | ok | fail
      var failInfo = ''

      var backdrop = document.createElement('div')
      backdrop.className = 'dsh-vsced-wiz-backdrop'
      var panel = document.createElement('div')
      panel.className = 'dsh-vsced-wiz'
      backdrop.appendChild(panel)
      document.body.appendChild(backdrop)
      wizardEl = backdrop

      function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;') }
      function icon(st) {
        if (st === 'running') return '<span class="dsh-vsced-spin">◌</span>'
        if (st === 'ok') return '<span style="color:#3fb950">✓</span>'
        if (st === 'fail') return '<span style="color:#f85149">✗</span>'
        return '<span style="color:#666">○</span>'
      }
      function render() {
        var html = '<div class="dsh-vsced-wiz-title">' + esc(t(lang, 'wiz.title')) + '</div>'
        for (var i = 0; i < steps.length; i++) {
          var s = steps[i]
          html += '<div class="dsh-vsced-wiz-step"><span class="dsh-vsced-wiz-icon">' + icon(s.status) + '</span><div><div>' +
            esc(s.label) + '</div>' +
            (s.detail ? '<div class="dsh-vsced-wiz-detail">' + esc(s.detail) + '</div>' : '') + '</div></div>'
        }
        if (phase === 'fail') {
          html += '<div class="dsh-vsced-wiz-log">' + t(lang, 'wiz.debugLog') +
            (failInfo ? '<br>' + esc(t(lang, 'wiz.error')) + esc(failInfo) : '') + '</div>'
        }
        html += '<div class="dsh-vsced-wiz-btns">'
        if (phase === 'running') html += '<button class="dsh-vsced-btn" data-act="close">' + esc(t(lang, 'wiz.cancel')) + '</button>'
        else if (phase === 'ok') html += '<button class="dsh-vsced-btn" data-act="close">' + esc(t(lang, 'wiz.ok')) + '</button>'
        else html += '<button class="dsh-vsced-btn" data-act="retry">' + esc(t(lang, 'wiz.retry')) + '</button><button class="dsh-vsced-btn" data-act="close">' + esc(t(lang, 'wiz.close')) + '</button>'
        html += '</div>'
        panel.innerHTML = html
      }
      function close() { if (wizardEl) { wizardEl.remove(); wizardEl = null } }
      backdrop.addEventListener('click', function (e) {
        var act = e.target && e.target.getAttribute && e.target.getAttribute('data-act')
        if (act === 'close') close()
        else if (act === 'retry') {
          phase = 'running'
          failInfo = ''
          for (var i = 0; i < steps.length; i++) { steps[i].status = 'pending'; steps[i].detail = '' }
          render()
          run()
        } else if (e.target === backdrop && phase !== 'running') close()
      })
      function setStep(i, status, detail) {
        steps[i].status = status
        if (detail !== undefined) steps[i].detail = detail
        if (wizardEl) render()
      }

      async function run() {
        // 1. 探测本机 VS Code
        setStep(0, 'running')
        var r = await postAction({ action: 'detect-vscode' })
        var d = r && r.desktop
        if (!d || !d.cli) {
          phase = 'fail'
          failInfo = (r && r.error) || t(lang, 'wiz.noLocalVscode')
          setStep(0, 'fail', t(lang, 'wiz.noVscodeHint'))
          return
        }
        setStep(0, 'ok', d.cli + paren(lang, d.version))
        // 2. 检查 / 安装桥扩展
        if (d.extInstalled && d.extUpToDate) {
          setStep(1, 'ok', t(lang, 'wiz.installedOk', { v: d.extVersion }))
        } else {
          setStep(1, 'running', d.extInstalled ? t(lang, 'wiz.updatingOld', { v: d.extVersion }) : t(lang, 'wiz.installing'))
          var ir = await postAction({ action: 'install-extension' })
          if (!ir || !ir.ok) {
            phase = 'fail'
            failInfo = (ir && ir.error) || t(lang, 'wiz.unknownError')
            setStep(1, 'fail', ir && ir.manual
              ? t(lang, 'wiz.manualCopy', { from: ir.manual.from, to: ir.manual.to })
              : t(lang, 'wiz.installFailed', { err: failInfo }))
            return
          }
          setStep(1, 'ok', t(lang, 'wiz.installedReload', { v: ir.version }))
        }
        // 3. 等待扩展连接（轮询，最长 120s）
        setStep(2, 'running', t(lang, 'wiz.openWorkspaceHint'))
        var deadline = Date.now() + 120000
        while (Date.now() < deadline) {
          if (!wizardEl) return // 用户取消
          var st = await fetchState().catch(function () { return null })
          if (st) lang = langOf(st)
          if (st && st.extConnected && !(st.extReady && st.extReady.trusted === false)) {
            phase = 'ok'
            var w = st.extReady && st.extReady.workspace
            setStep(2, 'ok', w ? t(lang, 'wiz.connectedWindow', { w: w }) : t(lang, 'wiz.connected'))
            return
          }
          if (st && st.extConnected && st.extReady && st.extReady.trusted === false) {
            setStep(2, 'running', t(lang, 'wiz.trustRestricted'))
          } else if (st && st.workspace) {
            setStep(2, 'running', t(lang, 'wiz.waitingExtDetail', { ws: st.workspace }))
          }
          await new Promise(function (res) { setTimeout(res, 1500) })
        }
        phase = 'fail'
        failInfo = t(lang, 'wiz.timeout')
        setStep(2, 'fail', t(lang, 'wiz.extNotConnected'))
      }
      render()
      run()
    }

    // ---- code-server 一键安装向导 ----
    // 与连接向导同款弹窗：host 端后台跑 scripts/install-code-server.*，
    // 这里每 1.5s 轮询 state.install 渲染进度。失败时给出手动命令兜底。
    var installWizEl = null

    function openInstallWizard(initialSt) {
      if (installWizEl) return
      var lang = langOf(initialSt)
      var steps = [
        { label: t(lang, 'iwz.step1'), status: 'pending', detail: '' },
        { label: t(lang, 'iwz.step2'), status: 'pending', detail: '' },
        { label: t(lang, 'iwz.step3'), status: 'pending', detail: '' },
      ]
      var phase = 'running' // running | ok | fail
      var failInfo = ''
      var failLog = []
      var okNote = ''
      var pkgRoot = ''
      var dlUrl = ''
      var dlDest = ''
      var cancelRequested = false
      var started = false

      var backdrop = document.createElement('div')
      backdrop.className = 'dsh-vsced-wiz-backdrop'
      var panel = document.createElement('div')
      panel.className = 'dsh-vsced-wiz'
      backdrop.appendChild(panel)
      document.body.appendChild(backdrop)
      installWizEl = backdrop

      function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;') }
      function icon(st) {
        if (st === 'running') return '<span class="dsh-vsced-spin">◌</span>'
        if (st === 'ok') return '<span style="color:#3fb950">✓</span>'
        if (st === 'fail') return '<span style="color:#f85149">✗</span>'
        return '<span style="color:#666">○</span>'
      }
      function render() {
        var html = '<div class="dsh-vsced-wiz-title">' + esc(t(lang, 'iwz.title')) + '</div>'
        if (dlDest || dlUrl) {
          html += '<div class="dsh-vsced-wiz-detail" style="margin:0 0 6px 24px">'
          if (dlUrl) html += esc(t(lang, 'iwz.dlUrl')) + esc(dlUrl) + '<br>'
          if (dlDest) html += esc(t(lang, 'iwz.dlDest')) + esc(dlDest)
          html += '</div>'
        }
        for (var i = 0; i < steps.length; i++) {
          var s = steps[i]
          html += '<div class="dsh-vsced-wiz-step"><span class="dsh-vsced-wiz-icon">' + icon(s.status) + '</span><div><div>' +
            esc(s.label) + '</div>' +
            (s.detail ? '<div class="dsh-vsced-wiz-detail">' + esc(s.detail) + '</div>' : '') + '</div></div>'
        }
        if (phase === 'fail') {
          html += '<div class="dsh-vsced-wiz-log">'
          if (failInfo) html += esc(t(lang, 'iwz.error')) + esc(failInfo) + '<br>'
          if (failLog.length) html += esc(t(lang, 'iwz.logTail')) + '<br>' + failLog.map(esc).join('<br>') + '<br>'
          if (pkgRoot) {
            html += esc(t(lang, 'iwz.manualHint')) + '<br><code>sh "' + esc(pkgRoot) + '/scripts/install-code-server.sh" ~/.dsh-editor</code>' +
              '<br>' + esc(t(lang, 'iwz.manualWin'))
          }
          html += '</div>'
        }
        if (phase === 'ok' && okNote) {
          html += '<div class="dsh-vsced-wiz-log">' + esc(okNote) + '</div>'
        }
        html += '<div class="dsh-vsced-wiz-btns">'
        if (phase === 'running') html += '<button class="dsh-vsced-btn" data-act="cancel">' + esc(t(lang, 'iwz.cancelInstall')) + '</button><button class="dsh-vsced-btn" data-act="close">' + esc(t(lang, 'iwz.background')) + '</button>'
        else if (phase === 'ok') html += '<button class="dsh-vsced-btn" data-act="close">' + esc(t(lang, 'iwz.done')) + '</button>'
        else html += '<button class="dsh-vsced-btn" data-act="retry">' + esc(t(lang, 'iwz.retry')) + '</button><button class="dsh-vsced-btn" data-act="close">' + esc(t(lang, 'iwz.close')) + '</button>'
        html += '</div>'
        panel.innerHTML = html
      }
      function close() { if (installWizEl) { installWizEl.remove(); installWizEl = null } }
      backdrop.addEventListener('click', function (e) {
        var act = e.target && e.target.getAttribute && e.target.getAttribute('data-act')
        if (act === 'close') close()
        else if (act === 'cancel') {
          if (!cancelRequested) {
            cancelRequested = true
            postAction({ action: 'cancel-install-codeserver' })
            setStep(0, 'running', t(lang, 'iwz.cancelling'))
          }
        }
        else if (act === 'retry') {
          phase = 'running'
          failInfo = ''
          failLog = []
          started = false
          cancelRequested = false
          for (var i = 0; i < steps.length; i++) { steps[i].status = 'pending'; steps[i].detail = '' }
          render()
          run()
        } else if (e.target === backdrop && phase !== 'running') close()
      })
      function setStep(i, status, detail) {
        steps[i].status = status
        if (detail !== undefined) steps[i].detail = detail
        if (installWizEl) render()
      }
      function sleep(ms) { return new Promise(function (res) { setTimeout(res, ms) }) }

      async function run() {
        if (!started) {
          started = true
          setStep(0, 'running', t(lang, 'iwz.starting'))
          await postAction({ action: 'install-codeserver' })
        }
        var deadline = Date.now() + 15 * 60 * 1000 // 下载可能很慢，给 15 分钟
        while (Date.now() < deadline) {
          if (!installWizEl) return // 用户关了弹窗（安装在 host 后台继续）
          var st = await fetchState().catch(function () { return null })
          if (!st || st.failed) { await sleep(1500); continue }
          lang = langOf(st)
          if (st.pkgRoot) pkgRoot = st.pkgRoot
          var ins = st.install
          if (ins) {
            if (ins.url) dlUrl = ins.url
            if (ins.dest) dlDest = ins.dest
          }
          if (ins && ins.phase === 'cancelled') {
            phase = 'fail'
            failInfo = t(lang, 'iwz.cancelledInfo')
            failLog = ins.log || []
            setStep(0, 'fail', t(lang, 'iwz.cancelled'))
            return
          }
          if (!ins || ins.phase === 'running') {
            var last = ins && ins.log && ins.log.length ? ins.log[ins.log.length - 1] : ''
            var prog = ins && ins.progress ? ins.progress : ''
            setStep(0, 'running', cancelRequested
              ? t(lang, 'iwz.cancelling')
              : (prog ? prog + ' · ' : '') + (last || t(lang, 'iwz.downloading')))
          } else if (ins.phase === 'error') {
            phase = 'fail'
            failInfo = ins.error || t(lang, 'iwz.scriptFailed')
            failLog = ins.log || []
            setStep(0, 'fail', ins.error || t(lang, 'iwz.scriptFailed'))
            return
          } else if (ins.phase === 'done') {
            setStep(0, 'ok', t(lang, 'iwz.installedTo'))
            if (st.running) {
              setStep(1, 'ok', st.url || t(lang, 'iwz.started'))
              if (st.extConnected) {
                phase = 'ok'
                okNote = t(lang, 'iwz.okDone')
                setStep(2, 'ok', t(lang, 'iwz.ready'))
                return
              }
              // 桥扩展只在 code-server 页面（编辑器标签页的 iframe）加载时
              // 才启动握手；用户不点过去就一直等不到。所以到这一步直接转
              // 「完成」状态并给出明确指引，同时继续轮询——真连上了就把
              // 第三步打勾。
              phase = 'ok'
              okNote = t(lang, 'iwz.okGuide')
              setStep(2, 'running', t(lang, 'iwz.step3Guide'))
            } else if (st.lastError) {
              phase = 'fail'
              failInfo = st.lastError
              setStep(1, 'fail', t(lang, 'iwz.startFailed'))
              return
            } else {
              setStep(1, 'running', t(lang, 'iwz.starting'))
            }
          }
          await sleep(1500)
        }
        if (phase === 'ok') return // 已进入「待用户点编辑器标签页」状态，超时不算失败
        phase = 'fail'
        failInfo = t(lang, 'iwz.timeout')
        setStep(2, 'fail', t(lang, 'iwz.timeoutDetail'))
      }
      render()
      run()
    }

    // Tab label: resolveSlotLabel passes the label function's return value
    // straight into the tab button's children, so returning a React element
    // gives the tab a real (colored, self-updating) status dot instead of
    // text glyphs. The tab strip is always mounted, so this component is
    // also the always-on poller for editor state.
    function TabLabel() {
      var st = useEditorState()
      var lang = langOf(st)
      var status = statusOf(st)
      return React.createElement('span', { className: 'dsh-vsced-tab', title: t(lang, 'tab.title', { status: status.text }) },
        t(lang, 'tab.editor'),
        dot(status.color)
      )
    }

    // 本机 VS Code 模式：编辑器标签页没有 iframe 可嵌，换成状态卡片——
    // 连接状态、VS Code 探测结果、扩展安装/更新入口、排错与手动兜底指引。
    function LocalPanel(props) {
      var st = props.st
      var lang = langOf(st)
      var d = (st && st.desktop) || {}
      var status = statusOf(st)
      var msgState = React.useState('')
      var msg = msgState[0]
      var setMsg = msgState[1]
      function row(label, value) {
        return React.createElement('div', { className: 'row', key: label },
          React.createElement('span', { style: { color: '#999', minWidth: '88px' } }, label),
          React.createElement('span', null, value)
        )
      }
      var children = []
      children.push(React.createElement('div', { className: 'row', key: 'st' }, dot(status.color), React.createElement('strong', null, status.text)))
      children.push(row('VS Code', d.cli ? (d.cli + paren(lang, d.version)) : t(lang, 'local.vscodeNotDetected')))
      children.push(row(t(lang, 'local.dshExt'), d.extInstalled
        ? (d.extUpToDate ? t(lang, 'local.extLatest', { v: d.extVersion }) : t(lang, 'local.extNew', { v: d.extVersion, newer: d.bundledExtVersion }))
        : t(lang, 'ext.notInstalled')))
      children.push(row(t(lang, 'local.workspace'), (st && st.workspace) || t(lang, 'local.waitingSession')))
      if (st && st.extReady && st.extReady.mode === 'desktop') {
        children.push(row(t(lang, 'local.connectedWindow'), t(lang, 'local.connectedWinValue', { ws: st.extReady.workspace || '-', v: st.extReady.version || '?' })))
      }
      if (st && st.extConnected && st.extReady && st.extReady.trusted === false) {
        children.push(React.createElement('div', { className: 'hint', key: 'trust', style: { color: '#d29922' } },
          t(lang, 'local.trustWarning')))
      }
      var btns = []
      if (d.cli && (!d.extInstalled || !d.extUpToDate)) {
        btns.push(React.createElement('button', {
          className: 'dsh-vsced-btn', key: 'ins',
          onClick: function () {
            postAction({ action: 'install-extension' }).then(function (r) {
              if (r && r.ok) setMsg(t(lang, 'local.installDone'))
              else if (r && r.manual) setMsg(t(lang, 'local.installManual', { err: r.error || '', from: r.manual.from, to: r.manual.to }))
              else setMsg(t(lang, 'local.installFailed', { err: (r && r.error) || t(lang, 'wiz.unknownError') }))
            })
          },
        }, d.extInstalled ? t(lang, 'btn.updateExt') : t(lang, 'btn.installExt')))
      }
      btns.push(React.createElement('button', {
        className: 'dsh-vsced-btn', key: 'det',
        onClick: function () { postAction({ action: 'detect-vscode' }) },
      }, t(lang, 'btn.redetect')))
      btns.push(React.createElement('button', {
        className: 'dsh-vsced-btn', key: 'wiz',
        onClick: function () { openWizard(st) },
      }, t(lang, 'btn.wizard')))
      children.push(React.createElement('div', { className: 'row', key: 'btns' }, btns))
      if (msg) children.push(React.createElement('div', { className: 'hint', key: 'msg', style: { color: '#d29922' } }, msg))
      var notice = hostText(st, 'noticeCode', 'notice', lang)
      if (notice) children.push(React.createElement('div', { className: 'hint', key: 'nt', style: { color: '#d29922' } }, notice))
      var lastError = hostText(st, 'lastErrorCode', 'lastError', lang)
      if (lastError) children.push(React.createElement('pre', { key: 'err', style: { maxWidth: '100%', overflow: 'auto', fontSize: 11, color: '#f85149', whiteSpace: 'pre-wrap', margin: 0 } }, lastError))
      children.push(React.createElement('div', { className: 'hint', key: 'hint' },
        t(lang, 'local.hint', { ws: (st && st.workspace) || '…' })))
      return React.createElement('div', { className: 'dsh-vsced-empty', style: { alignItems: 'flex-start', textAlign: 'left', gap: '8px' } }, children)
    }

    function EditorView() {
      var st = useEditorState()
      var lang = langOf(st)
      // cover=true 时遮住下方对话框（全屏看代码）；关掉就能边聊边看编辑器。
      var coverState = React.useState(true)
      var cover = coverState[0]
      var setCover = coverState[1]
      React.useEffect(function () {
        if (cover) document.body.classList.add('dsh-vsced-active')
        else document.body.classList.remove('dsh-vsced-active')
        return function () { document.body.classList.remove('dsh-vsced-active') }
      }, [cover])
      var running = !!(st && st.running)
      var url = st && st.url
      var status = statusOf(st)
      var isLocal = !!(st && (st.backend === 'local' || (st.config && st.config.editorBackend === 'local')))
      // code-server 未安装：除了一键安装引导，也保留本机 VS Code 替代路径。
      var missingCs = missingCodeServer(st)
      var installing = !!(st && st.install && st.install.phase === 'running')

      // The placeholder the persistent frame overlays. Ref + unmount cleanup
      // are what hide the frame when this tab view disappears.
      function anchorRef(el) {
        anchorEl = el
        anchorOn = !!el
        syncFrame()
      }
      React.useEffect(function () {
        return function () { anchorOn = false; anchorEl = null; syncFrame() }
      }, [])
      React.useEffect(function () {
        if (running && url) ensureFrame(url)
        syncFrame()
      })

      var children = []
      children.push(React.createElement('div', { className: 'dsh-vsced-toolbar', key: 'tb' },
        dot(status.color),
        React.createElement('strong', null, isLocal ? t(lang, 'vs.local') : t(lang, 'vs.embedded')),
        React.createElement('span', { style: { color: '#999' } }, status.text),
        React.createElement('span', { className: 'sp' }),
        React.createElement('button', {
          className: 'dsh-vsced-btn',
          title: t(lang, 'tb.coverTitle'),
          onClick: function () { setCover(!cover) },
        }, cover ? t(lang, 'tb.showChat') : t(lang, 'tb.hideChat')),
        React.createElement('label', { title: t(lang, 'tb.followTitle') },
          React.createElement('input', {
            type: 'checkbox',
            checked: !!(st && st.follow),
            onChange: function (e) { postAction({ action: 'set-follow', enabled: e.target.checked }) },
          }),
          t(lang, 'tb.follow')
        ),
        !isLocal && url ? React.createElement('a', { className: 'dsh-vsced-btn', href: url, target: '_blank', rel: 'noreferrer' }, t(lang, 'tb.openWindow')) : null,
        !isLocal ? React.createElement('button', { className: 'dsh-vsced-btn', onClick: function () { postAction({ action: 'restart' }) } }, t(lang, 'tb.restart')) : null
      ))
      if (isLocal) {
        children.push(React.createElement(LocalPanel, { st: st, key: 'lp' }))
      } else if (running && url) {
        children.push(React.createElement('div', { className: 'dsh-vsced-anchor', key: 'fr', ref: anchorRef }))
      } else {
        var notice = hostText(st, 'noticeCode', 'notice', lang)
        var lastError = hostText(st, 'lastErrorCode', 'lastError', lang)
        children.push(React.createElement('div', { className: 'dsh-vsced-empty', key: 'em' },
          React.createElement('div', null, st && st.failed ? t(lang, 'empty.bridgeUnmounted') : running ? t(lang, 'empty.starting') : t(lang, 'empty.notRunning')),
          notice ? React.createElement('div', { style: { color: '#d29922' } }, notice) : null,
          lastError ? React.createElement('pre', { style: { maxWidth: '100%', overflow: 'auto', fontSize: 11, color: '#f85149', whiteSpace: 'pre-wrap' } }, lastError) : null,
          missingCs || installing ? React.createElement('button', {
            className: 'dsh-vsced-btn',
            style: { fontWeight: 600 },
            onClick: function () { openInstallWizard(st) },
          }, installing ? t(lang, 'btn.installing', { p: st.install.progress ? ' ' + st.install.progress : '' }) : t(lang, 'btn.installCs')) : null,
          missingCs ? React.createElement('div', { className: 'hint' }, t(lang, 'empty.installHint')) : null,
          missingCs ? React.createElement('div', { className: 'hint' }, t(lang, 'empty.noCsHint')) : null,
          missingCs ? React.createElement('button', {
            className: 'dsh-vsced-btn',
            onClick: function () { postAction({ action: 'set-backend', backend: 'local' }).then(function () { openWizard(st) }) },
          }, t(lang, 'empty.switchLocal')) : null,
          st && st.failed ? null : React.createElement('button', { className: 'dsh-vsced-btn', onClick: function () { postAction({ action: 'start' }) } }, t(lang, 'empty.tryStart'))
        ))
      }
      return React.createElement('div', { className: 'dsh-vsced-view' }, children)
    }

    function enterBlur(e) { if (e.key === 'Enter') e.target.blur() }

    // 设置 → 插件 → 插件配置 里的插件卡片。读写都走自己的 /__dsh-vsceditor/*
    // 端点；host 端写入 settings 命名空间持久化（设置服务缺席时仅本次运行有效）。
    // 结构对齐官方 PluginCard：默认折叠的头部按钮（标题+描述+状态+箭头），
    // 展开后才渲染配置项。
    function chevron(open) {
      return React.createElement('span', { className: 'dsh-vsced-chevron' + (open ? ' dsh-vsced-chevron-open' : ''), 'aria-hidden': 'true' },
        React.createElement('svg', { width: 14, height: 14, viewBox: '0 0 14 14', fill: 'none' },
          React.createElement('path', { d: 'M3.5 5.25L7 8.75L10.5 5.25', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' })
        )
      )
    }

    function SettingsCard() {
      var st = useEditorState()
      var lang = langOf(st)
      var openState = React.useState(false)
      var open = openState[0]
      var setOpen = openState[1]
      var cfg = (st && st.config) || {}
      var status = statusOf(st)
      function save(patch) { postAction({ action: 'set-config', patch: patch }) }
      function savePort(ev) {
        var n = parseInt(ev.target.value, 10)
        if (!(n >= 0 && n <= 65535)) { ev.target.value = String(cfg.port != null ? cfg.port : 0); return }
        if (n !== cfg.port) save({ port: n })
      }
      function saveHome(ev) {
        var v = ev.target.value.trim()
        if (v !== (cfg.codeServerHome || '')) save({ codeServerHome: v })
      }
      var detectedPrefix = cfg.editorBackend === 'local' && st && st.desktop && st.desktop.cli
        ? t(lang, 'settings.detectedPrefix', { cli: st.desktop.cli, ver: paren(lang, st.desktop.version) })
        : ''
      var extPart = ''
      if (cfg.editorBackend === 'local' && st && st.desktop && st.desktop.cli) {
        if (st.desktop.extInstalled) {
          extPart = st.desktop.extUpToDate
            ? t(lang, 'settings.extLatest', { v: st.desktop.extVersion })
            : t(lang, 'settings.extUpdate', { v: st.desktop.extVersion, newer: st.desktop.bundledExtVersion })
        } else {
          extPart = t(lang, 'settings.extNone')
        }
      }

      var lastError = hostText(st, 'lastErrorCode', 'lastError', lang)

      return React.createElement('li', { className: 'dsh-vsced-card' + (open ? ' dsh-vsced-card-open' : '') },
        React.createElement('button', {
          type: 'button',
          className: 'dsh-vsced-cardhead',
          'aria-expanded': open,
          'aria-label': t(lang, 'settings.aria', { action: t(lang, open ? 'settings.collapse' : 'settings.expand'), name: t(lang, 'settings.name') }),
          onClick: function () { setOpen(!open) },
        },
          React.createElement('span', { className: 'dsh-vsced-headtext' },
            React.createElement('span', { className: 'dsh-vsced-name' }, dot(status.color), t(lang, 'settings.name')),
            React.createElement('span', { className: 'dsh-vsced-desc' }, t(lang, 'settings.desc'))
          ),
          React.createElement('span', { className: 'dsh-vsced-status' }, status.text),
          chevron(open)
        ),
        !open ? null : React.createElement('div', { className: 'dsh-vsced-cardbody' },
          React.createElement('div', { className: 'row' },
            React.createElement('span', null, t(lang, 'settings.language')),
            React.createElement('select', {
              value: cfg.language || 'auto',
              onChange: function (e) { save({ language: e.target.value }) },
            }, LANG_OPTIONS.map(function (opt) {
              return React.createElement('option', { key: opt.id, value: opt.id }, opt.key ? t(lang, opt.key) : opt.label)
            }))
          ),
          React.createElement('div', { className: 'row' },
            React.createElement('span', null, t(lang, 'settings.backend')),
            React.createElement('label', { className: 'row', style: { gap: '4px' } },
              React.createElement('input', {
                type: 'radio', name: 'dsh-vsced-backend',
                checked: (cfg.editorBackend || 'embedded') === 'embedded',
                onChange: function () { save({ editorBackend: 'embedded' }) },
              }),
              t(lang, 'settings.backendEmbedded')
            ),
            React.createElement('label', { className: 'row', style: { gap: '4px' } },
              React.createElement('input', {
                type: 'radio', name: 'dsh-vsced-backend',
                checked: cfg.editorBackend === 'local',
                onChange: function () { save({ editorBackend: 'local' }); openWizard(st) },
              }),
              t(lang, 'vs.local')
            )
          ),
          cfg.editorBackend === 'local' ? React.createElement('div', { className: 'row' },
            React.createElement('span', null, t(lang, 'settings.vscodePath')),
            React.createElement('input', {
              key: 'v' + (cfg.vscodePath || ''),
              type: 'text',
              defaultValue: cfg.vscodePath || '',
              placeholder: t(lang, 'settings.vscodePathPh'),
              style: { flex: 1, minWidth: '220px' },
              onBlur: function (ev) { var v = ev.target.value.trim(); if (v !== (cfg.vscodePath || '')) save({ vscodePath: v }) },
              onKeyDown: enterBlur,
            })
          ) : null,
          cfg.editorBackend === 'local' && st && st.desktop ? React.createElement('div', { className: 'hint' },
            st.desktop.cli
              ? (detectedPrefix + extPart)
              : t(lang, 'wiz.noLocalVscode')
          ) : null,
          React.createElement('label', { className: 'row' },
            React.createElement('input', {
              type: 'checkbox',
              checked: !!cfg.follow,
              onChange: function (e) { save({ follow: e.target.checked }) },
            }),
            t(lang, 'tb.follow'),
            React.createElement('span', { className: 'hint' }, t(lang, 'settings.followHint'))
          ),
          React.createElement('label', { className: 'row' },
            React.createElement('input', {
              type: 'checkbox',
              checked: !!cfg.followWorkspaceOnly,
              onChange: function (e) { save({ followWorkspaceOnly: e.target.checked }) },
            }),
            t(lang, 'settings.followWs'),
            React.createElement('span', { className: 'hint' }, t(lang, 'settings.followWsHint'))
          ),
          cfg.editorBackend === 'local' ? null : React.createElement('label', { className: 'row' },
            React.createElement('input', {
              type: 'checkbox',
              checked: !!cfg.autoStart,
              onChange: function (e) { save({ autoStart: e.target.checked }) },
            }),
            t(lang, 'settings.autoStart'),
            React.createElement('span', { className: 'hint' }, t(lang, 'settings.autoStartHint'))
          ),
          cfg.editorBackend === 'local' ? null : React.createElement('div', { className: 'row' },
            React.createElement('span', null, t(lang, 'settings.port')),
            React.createElement('input', {
              key: 'p' + String(cfg.port),
              type: 'number', min: 0, max: 65535,
              defaultValue: String(cfg.port != null ? cfg.port : 0),
              style: { width: '90px' },
              onBlur: savePort, onKeyDown: enterBlur,
            }),
            React.createElement('span', { className: 'hint' }, t(lang, 'settings.portHint'))
          ),
          cfg.editorBackend === 'local' ? null : React.createElement('div', { className: 'row' },
            React.createElement('span', null, t(lang, 'settings.csHome')),
            React.createElement('input', {
              key: 'h' + (cfg.codeServerHome || ''),
              type: 'text',
              defaultValue: cfg.codeServerHome || '',
              placeholder: t(lang, 'settings.csHomePh'),
              style: { flex: 1, minWidth: '220px' },
              onBlur: saveHome, onKeyDown: enterBlur,
            })
          ),
          cfg.editorBackend === 'local' ? null : (st && (st.install && st.install.phase === 'running' || missingCodeServer(st)))
            ? React.createElement('div', { className: 'row' },
              React.createElement('button', {
                className: 'dsh-vsced-btn',
                onClick: function () { openInstallWizard(st) },
              }, st.install && st.install.phase === 'running' ? t(lang, 'btn.installing', { p: st.install.progress ? ' ' + st.install.progress : '' }) : t(lang, 'btn.installCs')),
              React.createElement('span', { className: 'hint' }, t(lang, 'settings.installHint'))
            )
            : null,
          st && st.running && st.url
            ? React.createElement('div', { className: 'hint' }, t(lang, 'settings.currentInstance', { url: st.url, ws: st.workspace || '-' }))
            : null,
          st && st.settingsAvailable === false
            ? React.createElement('div', { className: 'hint' }, t(lang, 'settings.unavailable'))
            : null,
          lastError
            ? React.createElement('div', { className: 'hint', style: { color: '#f85149' } }, lastError)
            : null
        )
      )
    }

    function apply(ctx) {
      ctx.effect(function () {
        var el = document.createElement('style')
        el.textContent = CSS
        document.head.appendChild(el)
        return function () { el.remove() }
      }, 'dsh-vsceditor: styles')

      ctx.effect(function () {
        var id = setInterval(syncFrame, 400)
        window.addEventListener('resize', syncFrame)
        return function () {
          clearInterval(id)
          window.removeEventListener('resize', syncFrame)
          if (frame) { frame.remove(); frame = null }
          if (wizardEl) { wizardEl.remove(); wizardEl = null }
          if (installWizEl) { installWizEl.remove(); installWizEl = null }
        }
      }, 'dsh-vsceditor: frame')

      // 跟随 DSH 界面语言：读 ctx.locale 当前值并订阅后续切换。所有组件
      // 本来就在 2.5s 轮询重渲染，langOf 读取该变量即可自动生效。
      ctx.effect(function () {
        var loc = ctx.get('locale')
        if (!loc || typeof loc.getLocale !== 'function') return undefined
        try { dshLocale = (loc.getLocale() || {}).active || '' } catch (e) {}
        if (typeof loc.subscribe !== 'function') return undefined
        return loc.subscribe(function () {
          try { dshLocale = (loc.getLocale() || {}).active || '' } catch (e) {}
        })
      }, 'dsh-vsceditor: locale')

      ctx.slots.inject('conversation.view', function () {
        ctx.slots.register(
          { name: 'conversation.view', id: 'dsh-vsceditor', label: function () { return React.createElement(TabLabel) }, order: 100 },
          function () { return React.createElement(EditorView) }
        )
      })

      // 设置 → 插件 → 插件配置 卡片：key 必须与 host 端注册的 settings
      // 命名空间一致，配置区只会派发 host 实际 serve 的命名空间。
      // label 用 thunk：设置区通过 resolveSlotLabel 解析并在语言切换时重渲。
      ctx.slots.inject('settings.plugin.item', function () {
        ctx.slots.register(
          { name: 'settings.plugin.item', id: 'dsh-vsceditor', key: 'dsh-vsceditor', order: 100, label: function () { return t(langOf(lastSt), 'settings.name') } },
          function () { return React.createElement(SettingsCard) }
        )
      })
    }

    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  }
})
