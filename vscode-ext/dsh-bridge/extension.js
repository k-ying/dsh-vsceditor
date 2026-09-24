// dsh-bridge — connects a VS Code instance to a DeepSeek Harness host.
// Two modes, auto-detected from the environment (one codebase, no user choice):
//   embedded: launched by dsh-vsceditor as a code-server child process; bridge
//             coordinates arrive through DSH_BRIDGE_* env vars.
//   desktop:  installed into the user's own VS Code; env vars cannot be
//             injected into an already-running app, so it reads
//             ~/.dsh-editor/bridge.json ({events, rpc, token, workspace})
//             written by the host, and only serves while this window's
//             workspace matches the DSH session workspace.
// Transport: SSE (host -> extension) + HTTP POST (extension -> host).
// Message shapes are modeled on ACP session/update semantics:
//   host -> ext:  hello | follow | edit | lock | unlock | reveal
//   ext  -> host: ready | ack | set-follow | log
const vscode = require('vscode');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
// Windows-safe path handling (see paths.js for why each helper exists).
const { sameFsPath, resolveEditPath, baseName, encodePath, fsKey, canonicalizeUnder } = require('./paths');
// Debug log is opt-in: set DSH_BRIDGE_DEBUG to a non-empty value, or flip the
// plugin's `bridgeDebug` setting (the host pushes it over SSE as a `debug`
// frame), to append traces to /tmp/dsh-bridge-debug.log. Runtime-toggleable on
// purpose: diagnosing a diff that never opened must not require restarting DSH
// (and desktop VS Code windows are not spawned by us, so no env can reach them).
let DEBUG = !!process.env.DSH_BRIDGE_DEBUG;
function dbg(msg) {
  if (!DEBUG) return;
  try { fs.appendFileSync('/tmp/dsh-bridge-debug.log', new Date().toISOString() + ' [pid ' + process.pid + '] ' + msg + '\n'); } catch (e) {}
}

const L10N = {
  zh: {
    'ext.promptWs': 'DSH 桥接：本窗口未打开工作区 {ws}',
    'ext.openWs': '打开该工作区',
    'ext.logWaitingTrust': '工作区未信任（受限模式），等待用户信任…',
    'ext.promptTrust': 'DSH 桥接：当前工作区处于受限模式，信任后才会同步 DSH 的编辑。',
    'ext.manageTrust': '管理工作区信任',
    'diff.title': 'DSH: {base} ⟵ 修改前 | 当前 ⟶',
    'log.wsUnset': '(未设置)',
    'st.waitingDsh': '等待 DSH',
    'log.wsMismatch': '工作区不匹配：DSH={dsh} 本窗口={mine}',
    'log.noFolder': '(无文件夹)',
    'st.wsMismatch': '工作区不匹配',
    'st.waitingWs': '等待工作区',
    'log.sseHandshakeFail': 'SSE 握手失败：HTTP {code}',
    'log.sseConnected': 'SSE 已连接 {target}{suffix}',
    'log.restrictedSuffix': '（受限模式：仅上报状态）',
    'st.restricted': '受限模式',
    'log.sseEnded': 'SSE 流结束（对端关闭），将重连',
    'log.sseError': 'SSE 流错误：{err}',
    'log.sseConnectFail': 'SSE 连接失败：{err}',
    'sb.follow': '跟随',
    'sb.edit': '编辑',
    'sb.tipConnected': 'DSH Bridge 已连接（{mode}）· 点击切换跟随/重连',
    'sb.modeFollow': '跟随模式：只读+diff',
    'sb.modeEdit': '编辑模式：锁定 DSH 占用文件',
    'sb.tipDisconnected': 'DSH Bridge 未连接，点击打开菜单',
    'msg.revertFollow': 'DSH 跟随模式为只读：你的修改已回退（在 DSH 面板关闭跟随后可编辑）',
    'msg.revertLocked': '该文件正在被 DSH 编辑：你的修改已回退',
    'msg.reqFollowOff': '已请求关闭跟随（host 确认后生效）',
    'msg.reqFollowOn': '已请求开启跟随（host 确认后生效）',
    'menu.follow': '跟随模式',
    'menu.followOnDesc': '当前：开（只读 + 自动弹 diff），点击关闭',
    'menu.followOffDesc': '当前：关，点击开启',
    'menu.reconnect': '重新连接 DSH',
    'menu.connected': '已连接',
    'menu.disconnected': '未连接',
    'log.trustGranted': '已获得工作区信任',
  },
  en: {
    'ext.promptWs': 'DSH Bridge: this window does not have workspace {ws} open',
    'ext.openWs': 'Open this workspace',
    'ext.logWaitingTrust': 'Workspace not trusted (restricted mode), waiting for trust…',
    'ext.promptTrust': 'DSH Bridge: current workspace is in restricted mode; edits will sync after it is trusted.',
    'ext.manageTrust': 'Manage Workspace Trust',
    'diff.title': 'DSH: {base} ⟵ before | current ⟶',
    'log.wsUnset': '(unset)',
    'st.waitingDsh': 'Waiting for DSH',
    'log.wsMismatch': 'Workspace mismatch: DSH={dsh} local={mine}',
    'log.noFolder': '(no folder)',
    'st.wsMismatch': 'Workspace mismatch',
    'st.waitingWs': 'Waiting for workspace',
    'log.sseHandshakeFail': 'SSE handshake failed: HTTP {code}',
    'log.sseConnected': 'SSE connected {target}{suffix}',
    'log.restrictedSuffix': ' (restricted mode: status reporting only)',
    'st.restricted': 'Restricted mode',
    'log.sseEnded': 'SSE stream ended (closed by remote), will reconnect',
    'log.sseError': 'SSE stream error: {err}',
    'log.sseConnectFail': 'SSE connection failed: {err}',
    'sb.follow': 'Follow',
    'sb.edit': 'Edit',
    'sb.tipConnected': 'DSH Bridge connected ({mode}) · click to toggle follow/reconnect',
    'sb.modeFollow': 'follow mode: read-only + diff',
    'sb.modeEdit': 'edit mode: DSH-locked files stay locked',
    'sb.tipDisconnected': 'DSH Bridge not connected, click to open menu',
    'msg.revertFollow': 'DSH follow mode is read-only: your changes have been reverted (turn off follow mode in DSH panel to edit)',
    'msg.revertLocked': 'This file is being edited by DSH: your changes have been reverted',
    'msg.reqFollowOff': 'Requested follow mode off (takes effect after host confirms)',
    'msg.reqFollowOn': 'Requested follow mode on (takes effect after host confirms)',
    'menu.follow': 'Follow mode',
    'menu.followOnDesc': 'Current: On (read-only + auto diff popup), click to turn off',
    'menu.followOffDesc': 'Current: Off, click to turn on',
    'menu.reconnect': 'Reconnect to DSH',
    'menu.connected': 'Connected',
    'menu.disconnected': 'Not connected',
    'log.trustGranted': 'Workspace trust granted',
  },
  'pt-BR': {
    'ext.promptWs': 'DSH Bridge: este workspace {ws} não está aberto nesta janela',
    'ext.openWs': 'Abrir este workspace',
    'ext.logWaitingTrust': 'Workspace não confiável (modo restrito), aguardando confiança…',
    'ext.promptTrust': 'DSH Bridge: o workspace atual está em modo restrito; as edições serão sincronizadas após confiar nele.',
    'ext.manageTrust': 'Gerenciar confiança do workspace',
    'diff.title': 'DSH: {base} ⟵ antes | atual ⟶',
    'log.wsUnset': '(não definido)',
    'st.waitingDsh': 'Aguardando DSH',
    'log.wsMismatch': 'Incompatibilidade de workspace: DSH={dsh} local={mine}',
    'log.noFolder': '(sem pasta)',
    'st.wsMismatch': 'Workspace incompatível',
    'st.waitingWs': 'Aguardando workspace',
    'log.sseHandshakeFail': 'Falha no handshake SSE: HTTP {code}',
    'log.sseConnected': 'SSE conectado {target}{suffix}',
    'log.restrictedSuffix': ' (modo restrito: somente relato de status)',
    'st.restricted': 'Modo restrito',
    'log.sseEnded': 'Fluxo SSE finalizado (fechado pelo remoto), reconectando',
    'log.sseError': 'Erro no fluxo SSE: {err}',
    'log.sseConnectFail': 'Falha na conexão SSE: {err}',
    'sb.follow': 'Seguir',
    'sb.edit': 'Editar',
    'sb.tipConnected': 'DSH Bridge conectado ({mode}) · clique para alternar seguir/reconectar',
    'sb.modeFollow': 'modo seguir: somente leitura + diff',
    'sb.modeEdit': 'modo edição: arquivos ocupados pelo DSH ficam bloqueados',
    'sb.tipDisconnected': 'DSH Bridge não conectado, clique para abrir o menu',
    'msg.revertFollow': 'O modo seguir do DSH é somente leitura: suas alterações foram revertidas (desative o modo seguir no painel do DSH para editar)',
    'msg.revertLocked': 'Este arquivo está sendo editado pelo DSH: suas alterações foram revertidas',
    'msg.reqFollowOff': 'Solicitado desativar modo seguir (efetivado após confirmação do host)',
    'msg.reqFollowOn': 'Solicitado ativar modo seguir (efetivado após confirmação do host)',
    'menu.follow': 'Modo seguir',
    'menu.followOnDesc': 'Atual: Ativo (somente leitura + diff automático), clique para desativar',
    'menu.followOffDesc': 'Atual: Inativo, clique para ativar',
    'menu.reconnect': 'Reconectar ao DSH',
    'menu.connected': 'Conectado',
    'menu.disconnected': 'Desconectado',
    'log.trustGranted': 'Confiança do workspace concedida',
  },
  es: {
    'ext.promptWs': 'DSH Bridge: este espacio de trabajo {ws} no está abierto en esta ventana',
    'ext.openWs': 'Abrir este espacio de trabajo',
    'ext.logWaitingTrust': 'Espacio de trabajo no confiable (modo restringido), esperando confianza…',
    'ext.promptTrust': 'DSH Bridge: el espacio de trabajo actual está en modo restringido; las ediciones se sincronizarán tras confiar en él.',
    'ext.manageTrust': 'Gestionar confianza del espacio de trabajo',
    'diff.title': 'DSH: {base} ⟵ antes | actual ⟶',
    'log.wsUnset': '(no establecido)',
    'st.waitingDsh': 'Esperando DSH',
    'log.wsMismatch': 'Discrepancia de workspace: DSH={dsh} local={mine}',
    'log.noFolder': '(sin carpeta)',
    'st.wsMismatch': 'Workspace no coincidente',
    'st.waitingWs': 'Esperando workspace',
    'log.sseHandshakeFail': 'Fallo de handshake SSE: HTTP {code}',
    'log.sseConnected': 'SSE conectado {target}{suffix}',
    'log.restrictedSuffix': ' (modo restringido: solo reporte de estado)',
    'st.restricted': 'Modo restringido',
    'log.sseEnded': 'Flujo SSE finalizado (cerrado por el remoto), reconectando',
    'log.sseError': 'Error en el flujo SSE: {err}',
    'log.sseConnectFail': 'Fallo de conexión SSE: {err}',
    'sb.follow': 'Seguir',
    'sb.edit': 'Editar',
    'sb.tipConnected': 'DSH Bridge conectado ({mode}) · clic para alternar seguir/reconectar',
    'sb.modeFollow': 'modo seguir: solo lectura + diff',
    'sb.modeEdit': 'modo edición: los archivos ocupados por DSH quedan bloqueados',
    'sb.tipDisconnected': 'DSH Bridge no conectado, clic para abrir el menú',
    'msg.revertFollow': 'El modo seguir de DSH es de solo lectura: tus cambios se han revertido (desactiva el modo seguir en el panel de DSH para editar)',
    'msg.revertLocked': 'Este archivo está siendo editado por DSH: tus cambios se han revertido',
    'msg.reqFollowOff': 'Solicitado desactivar modo seguir (efectivo tras confirmación del host)',
    'msg.reqFollowOn': 'Solicitado activar modo seguir (efectivo tras confirmación del host)',
    'menu.follow': 'Modo seguir',
    'menu.followOnDesc': 'Actual: Activo (solo lectura + diff automático), clic para desactivar',
    'menu.followOffDesc': 'Actual: Inactivo, clic para activar',
    'menu.reconnect': 'Reconectar a DSH',
    'menu.connected': 'Conectado',
    'menu.disconnected': 'No conectado',
    'log.trustGranted': 'Confianza del espacio de trabajo concedida',
  },
};

function extLang() {
  const n = String((vscode.env && vscode.env.language) || 'en').toLowerCase();
  if (n.startsWith('zh')) return 'zh';
  if (n.startsWith('pt')) return 'pt-BR';
  if (n.startsWith('es')) return 'es';
  return 'en';
}

function t(key, params) {
  const lang = extLang();
  const d = L10N[lang] || L10N.en;
  let s = d && d[key] !== undefined ? d[key] : (L10N.en[key] !== undefined ? L10N.en[key] : (L10N.zh[key] !== undefined ? L10N.zh[key] : key));
  if (params) {
    s = s.replace(/\{(\w+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(params, k) ? String(params[k]) : m));
  }
  return s;
}

const state = {
  follow: true,
  locked: new Set(),
  connected: false,
  sseReq: null,
  reconnectTimer: null,
  lastKnown: new Map(), // fsPath -> last authoritative text (disk / DSH edit)
  reverting: new Set(),
  statusBar: null,
};

const EXT_VERSION = (function () {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version || '0.0.0'; }
  catch (e) { return '0.0.0'; }
})();
const BRIDGE_FILE = path.join(os.homedir(), '.dsh-editor', 'bridge.json');
// 桌面模式排障日志（DSH 侧的连接向导失败时指引用户拷贝此文件）。容量封顶 64KB。
const EXT_LOG_FILE = path.join(os.homedir(), '.dsh-editor', 'bridge-ext.log');
function fileLog(msg) {
  try {
    try { if (fs.statSync(EXT_LOG_FILE).size > 65536) fs.writeFileSync(EXT_LOG_FILE, ''); } catch (e) {}
    fs.appendFileSync(EXT_LOG_FILE, new Date().toISOString() + ' [pid ' + process.pid + '] ' + msg + '\n');
  } catch (e) {}
}

// Current bridge coordinates. mode: 'embedded' | 'desktop' | 'none'.
const bridge = { mode: 'none', events: '', rpc: '', token: '', workspace: '' };

function envBridge() {
  if (!process.env.DSH_BRIDGE_EVENTS && !process.env.DSH_BRIDGE_URL) return null;
  const base = process.env.DSH_BRIDGE_URL || '';
  return {
    mode: 'embedded',
    events: process.env.DSH_BRIDGE_EVENTS || (base + '/__dsh-editor/events'),
    rpc: process.env.DSH_BRIDGE_RPC || (base + '/__dsh-editor/rpc'),
    token: process.env.DSH_BRIDGE_TOKEN || '',
    workspace: '',
  };
}
function fileBridge() {
  try {
    const j = JSON.parse(fs.readFileSync(BRIDGE_FILE, 'utf8'));
    if (j && typeof j.events === 'string' && typeof j.rpc === 'string' && typeof j.token === 'string') {
      return { mode: 'desktop', events: j.events, rpc: j.rpc, token: j.token, workspace: typeof j.workspace === 'string' ? j.workspace : '' };
    }
  } catch (e) {}
  return null;
}
function resolveBridge() {
  const b = envBridge() || fileBridge();
  if (b) { bridge.mode = b.mode; bridge.events = b.events; bridge.rpc = b.rpc; bridge.token = b.token; bridge.workspace = b.workspace; }
  else bridge.mode = 'none';
  return bridge.mode !== 'none';
}

// Desktop mode serves only the window whose workspace matches the DSH session
// workspace; other VS Code windows stay idle (no cross-window event leaks).
//
// The comparison must be filesystem-aware: on Windows the drive letter's case
// is arbitrary (`E:\proj` from VS Code vs `e:\proj` from a shell/DSH cwd), and a
// plain `===` treated them as different directories — the extension then never
// connected at all (issue #4). sameFsPath also normalizes separators and a
// trailing separator.
function workspaceMatches() {
  if (bridge.mode !== 'desktop') return true;
  if (!bridge.workspace) return false;
  const folders = vscode.workspace.workspaceFolders || [];
  return folders.some((f) => sameFsPath(f.uri.fsPath, bridge.workspace));
}
let promptedFor = '';
function maybePromptWorkspace() {
  if (!bridge.workspace || promptedFor === bridge.workspace) return;
  promptedFor = bridge.workspace;
  const ws = bridge.workspace;
  vscode.window.showInformationMessage(t('ext.promptWs', { ws: ws }), t('ext.openWs')).then((pick) => {
    if (pick) vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(ws), false);
  });
}

// 受限模式（Workspace Trust）：扩展声明了 limited 支持，未信任时仍能激活，
// 保持连接并向 DSH 上报 trusted:false，但不接收 edit/reveal；信任后自动恢复。
function isTrusted() { return bridge.mode !== 'desktop' || vscode.workspace.isTrusted; }
let trustPrompted = false;
function maybePromptTrust() {
  if (trustPrompted || vscode.workspace.isTrusted) return;
  trustPrompted = true;
  log(t('ext.logWaitingTrust'));
  vscode.window.showWarningMessage(t('ext.promptTrust'), t('ext.manageTrust')).then((pick) => {
    if (pick) vscode.commands.executeCommand('workbench.trust.manage');
  });
}

function log(msg) {
  console.log('[dsh-bridge] ' + msg);
  fileLog(msg);
  post({ type: 'log', message: String(msg) });
}

// ---------- extension -> host ----------
function post(msg) {
  try {
    if (!bridge.rpc) return;
    const u = new URL(bridge.rpc);
    if (u.protocol.indexOf('http') !== 0) return;
    u.search = (u.search ? u.search + '&' : '?') + 'token=' + encodeURIComponent(bridge.token);
    const body = JSON.stringify(msg);
    const req = http.request({
      method: 'POST',
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      timeout: 5000,
    }, (res) => { res.resume(); });
    req.on('error', () => {});
    req.on('timeout', () => req.destroy());
    req.end(body);
  } catch (e) { /* never throw from telemetry */ }
}

// ---------- virtual diff documents ----------
// Both sides of the follow diff are served from these providers rather than from
// a real `file:` URI. The left side is this turn's baseline (oldText); the right
// side is the post-edit content the host read back from disk (newText).
//
// The right side used to be `vscode.Uri.file(fsPath)`, which reads through VS
// Code's TextDocument: when the file was ALREADY open as a normal tab, the diff
// showed the stale in-memory text on both sides and the edit looked like it had
// never been applied (issue #6). A virtual document takes its content from the
// host's disk read instead, so it is correct by construction. It also avoids the
// only other way to force a refresh — reverting the document — which would
// destroy unsaved user edits.
class VirtualDocProvider {
  constructor(label, uriOf) {
    this._label = label;
    this._uriOf = uriOf;
    this._emitter = new vscode.EventEmitter();
    this.onDidChange = this._emitter.event;
    this._contents = new Map(); // key(fsPath) -> text
  }
  set(fsPath, text) {
    this._contents.set(fsPath, text);
    // Fire on every set so an ALREADY OPEN diff refreshes in place and becomes
    // the running per-turn diff, instead of having to be closed and reopened.
    this._emitter.fire(this._uriOf(fsPath));
  }
  provideTextDocumentContent(uri) {
    const key = decodeURIComponent(uri.query || '');
    const hit = this._contents.has(key);
    dbg(this._label + ' provider called, key=' + key + ' hit=' + hit);
    return hit ? this._contents.get(key) : '';
  }
  clear() { this._contents.clear(); }
}
function snapUri(fsPath) {
  return vscode.Uri.parse('dsh-snap://snapshot' + encodePath(fsPath) + '?' + encodeURIComponent(fsPath));
}
function nowUri(fsPath) {
  return vscode.Uri.parse('dsh-now://current' + encodePath(fsPath) + '?' + encodeURIComponent(fsPath));
}
const snapshots = new VirtualDocProvider('snap', snapUri);
const currents = new VirtualDocProvider('now', nowUri);

// The root a workspace-relative agent path should be resolved against. Desktop
// mode knows it from bridge.json; embedded mode does not (the host always sends
// absolute paths there), so fall back to the first workspace folder rather than
// guessing from process.cwd().
function workspaceRootHint() {
  if (bridge.workspace) return bridge.workspace;
  const folders = vscode.workspace.workspaceFolders || [];
  return folders.length ? folders[0].uri.fsPath : '';
}
// Normalize an incoming path once, at every entry point, so lock/edit/unlock
// keys and the diff URIs all agree.
function normPath(p) {
  const resolved = resolveEditPath(p, workspaceRootHint());
  if (!resolved) return '';
  // Prefer VS Code's own casing for anything inside a workspace folder, so the
  // same file always yields the same string no matter how a frame spelled it.
  return canonicalizeUnder(resolved, workspaceFolderPaths());
}
function workspaceFolderPaths() {
  return (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath).filter(Boolean);
}
function editPathOf(msg) {
  return normPath(msg && msg.path);
}
// Storage key for state.locked / state.lastKnown. Those two are pure lookup
// containers, so they can be keyed by a case-folded form where the filesystem is
// case-insensitive — which matters because VS Code reports `doc.uri.fsPath` with
// its own drive-letter casing while frames arrive with the host's. Without this,
// a locked file would silently stop being protected on Windows, and revert
// protection would look up a key that was stored under a different spelling.
function pathKeyOf(p) {
  const resolved = normPath(p);
  return resolved ? fsKey(resolved) : undefined;
}

// ---------- host -> ext message handlers ----------
// 去重：同一份编辑帧在 30s 窗口内只处理一次。SSE 重连、多路径投递都不应
// 让同一个 diff 反复弹出抢走用户当前页签。
let lastEditKey = '';
let lastEditAt = 0;
function editKeyOf(fsPath, newText) {
  const t = typeof newText === 'string' ? newText : '';
  let h = 0;
  for (let i = 0; i < t.length; i += 97) h = (h * 31 + t.charCodeAt(i)) | 0;
  return fsPath + '|' + t.length + '|' + h;
}
// 打开（或聚焦）某文件的 DSH diff 标签；firstLine >= 0 时定位到首个改动行。
// preview:false → 固定标签页：一轮改多个文件时各自的 diff 并存，不再互相
// 顶掉（默认 preview 标签会被下一个 preview 替换）。相同的 left/right 再调
// 一次只会聚焦已有标签而不会开重复页。
async function openDiff(fsPath, firstLine) {
  const left = snapUri(fsPath);
  // Right side is a virtual document fed by the host's disk read, NOT
  // vscode.Uri.file() — see the VirtualDocProvider comment (issue #6).
  const right = nowUri(fsPath);
  const base = baseName(fsPath) || fsPath;
  dbg('calling vscode.diff, windowFocused=' + vscode.window.state.focused + ' visibleEditors=' + vscode.window.visibleTextEditors.length);
  const diffDone = vscode.commands.executeCommand('vscode.diff', left, right, t('diff.title', { base: base }), { preview: false });
  const raced = await Promise.race([
    diffDone.then((r) => ({ ok: true, r: r })).catch((e) => ({ ok: false, e: e })),
    new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 6000)),
  ]);
  // The outcome is reported back to the host in the ack: a 6s timeout does not
  // throw (the promise may still resolve), but it is NOT the same as "opened",
  // and without this distinction the host cannot tell whether the diff ever
  // reached the screen.
  let outcome;
  if (raced && raced.timeout) { dbg('diff TIMEOUT after 6s (promise still pending) for ' + base); outcome = { opened: false, timeout: true }; }
  else if (raced && raced.ok) { dbg('diff opened for ' + base); outcome = { opened: true, timeout: false }; }
  else { dbg('diff REJECTED for ' + base + ': ' + (raced && raced.e && raced.e.message)); throw raced.e; }
  diffDone.catch(() => {});
  if (typeof firstLine === 'number' && firstLine >= 0) {
    setTimeout(() => {
      const ed = vscode.window.activeTextEditor;
      if (ed) {
        const line = Math.min(firstLine, Math.max(0, ed.document.lineCount - 1));
        const pos = new vscode.Position(line, 0);
        try {
          ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
          ed.selection = new vscode.Selection(pos, pos);
        } catch (e) {}
      }
    }, 450);
  }
  return outcome;
}

async function onEdit(msg) {
  // Resolve once, here, so the snapshot key, the diff URIs, the dedup key and
  // the ack all refer to the same absolute path even when an agent handed the
  // tool a workspace-relative one (issue #5).
  const fsPath = editPathOf(msg);
  if (!fsPath) return;
  dbg('onEdit start, follow=' + state.follow);
  // 轮次级累计基线：快照只在「该文件本轮还没有基线」时建立（左边 = DSH 本轮
  // 动手前），右边用 host 回读的磁盘内容，两侧都由扩展提供，diff 标签原地变成
  // 本轮累计 diff。基线不随标签关闭而重置——关掉标签后本轮再改该文件会带着原
  // 基线重开 diff；只有 host 广播 turn（新一轮对话产生首次编辑）时才清空
  // （见 resetTurnDiffs）。
  // 内嵌模式页面刷新后扩展宿主重建、快照 Map 清空，但 VS Code 会恢复之前固定
  // 的 diff 标签——此时左侧会变成空白，靠重放帧里的 oldText 重新填充。
  if (!snapshots._contents.has(fsPath)) {
    snapshots.set(fsPath, typeof msg.oldText === 'string' ? msg.oldText : '');
  }
  const newText = typeof msg.newText === 'string' ? msg.newText : state.lastKnown.get(pathKeyOf(fsPath));
  if (typeof newText === 'string') {
    state.lastKnown.set(pathKeyOf(fsPath), newText);
    currents.set(fsPath, newText);
  }
  const key = editKeyOf(fsPath, msg.newText);
  if (key === lastEditKey && Date.now() - lastEditAt < 30000) {
    dbg('onEdit dedup skip for ' + fsPath);
    post({ type: 'ack', kind: 'edit', path: fsPath, follow: state.follow, dedup: true });
    return;
  }
  lastEditKey = key;
  lastEditAt = Date.now();
  if (!state.follow) { post({ type: 'ack', kind: 'edit', path: fsPath, follow: false }); return; }
  try {
    const outcome = await openDiff(fsPath, typeof msg.firstLine === 'number' ? msg.firstLine : -1);
    post({
      type: 'ack', kind: 'edit', path: fsPath, follow: true,
      opened: !!(outcome && outcome.opened), timeout: !!(outcome && outcome.timeout),
    });
  } catch (e) {
    dbg('diff FAILED for ' + fsPath + ': ' + (e && e.message) + ' ' + (e && e.stack));
    log('diff failed for ' + fsPath + ': ' + (e && e.message));
    post({ type: 'ack', kind: 'edit-error', path: fsPath, error: String(e && e.message) });
  }
}

async function onReveal(msg) {
  const fsPath = editPathOf(msg);
  if (!fsPath) return;
  dbg('onReveal start: ' + fsPath);
  try {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fsPath));
    const ed = await vscode.window.showTextDocument(doc, { preview: true });
    if (typeof msg.line === 'number' && msg.line >= 0) {
      const line = Math.min(msg.line, Math.max(0, doc.lineCount - 1));
      const pos = new vscode.Position(line, 0);
      ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      ed.selection = new vscode.Selection(pos, pos);
    }
  } catch (e) {
    log('reveal failed: ' + (e && e.message));
  }
}

// 新一轮对话开始产生编辑（host 广播 turn）：关掉本轮之前所有 DSH diff 标签、
// 清空全部基线快照，新一轮只显示新一轮的累计变化。清空去重键，让新一轮第一
// 帧即使内容巧合相同也能正常弹出。
function resetTurnDiffs() {
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input;
      // Both sides are virtual now (dsh-snap left / dsh-now right), so match on
      // either rather than only the left one.
      if (input instanceof vscode.TabInputTextDiff &&
          ((input.original && input.original.scheme === 'dsh-snap') ||
           (input.modified && input.modified.scheme === 'dsh-now'))) {
        try { vscode.window.tabGroups.close(tab); } catch (e) {}
      }
    }
  }
  snapshots.clear();
  currents.clear();
  lastEditKey = '';
}

function handleMessage(msg) {
  if (!msg || typeof msg.type !== 'string') return;
  // 受限模式下只维护状态，不执行任何编辑/跳转/清场指令。
  if (!isTrusted() && (msg.type === 'edit' || msg.type === 'reveal' || msg.type === 'turn')) return;
  dbg('recv: ' + msg.type + (msg.path ? ' ' + msg.path : ''));
  switch (msg.type) {
    case 'hello':
      state.follow = !!msg.follow;
      state.locked = new Set((Array.isArray(msg.locked) ? msg.locked : []).map(pathKeyOf).filter(Boolean));
      // Only override when the host actually states it, so an env-enabled trace
      // is not silently switched off by an older host that omits the field.
      if (typeof msg.debug === 'boolean') DEBUG = msg.debug;
      updateStatus();
      break;
    case 'debug': {
      // Runtime tracing toggle: no DSH restart, and it reaches desktop VS Code
      // windows too (we do not spawn those, so no env var can).
      // dbg() is itself a no-op while tracing is off, so the "disabled"
      // transition has to be written BEFORE the flag drops; assigning first
      // only ever works for enabling.
      const wasOn = DEBUG;
      const on = !!msg.enabled;
      if (wasOn) dbg('debug tracing ' + (on ? 'enabled' : 'disabled'));
      DEBUG = on;
      if (!wasOn && on) dbg('debug tracing enabled');
      break;
    }
    case 'follow':
      state.follow = !!msg.enabled;
      updateStatus();
      break;
    case 'lock': {
      const k = pathKeyOf(msg.path);
      if (k) state.locked.add(k);
      break;
    }
    case 'unlock': {
      const k = pathKeyOf(msg.path);
      if (k) state.locked.delete(k);
      break;
    }
    case 'edit':
      onEdit(msg);
      break;
    case 'turn':
      resetTurnDiffs();
      break;
    case 'reveal':
      onReveal(msg);
      break;
  }
}

// ---------- SSE client ----------
let lastLoggedMode = '';
function connectSSE() {
  resolveBridge();
  if (bridge.mode !== lastLoggedMode) {
    lastLoggedMode = bridge.mode;
    log('mode=' + bridge.mode + (bridge.mode === 'desktop' ? ' workspace=' + (bridge.workspace || t('log.wsUnset')) : ''));
  }
  if (bridge.mode === 'none') { setStatus(false, t('st.waitingDsh')); scheduleReconnect(); return; }
  if (!workspaceMatches()) {
    const mine = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath).join(',');
    log(t('log.wsMismatch', { dsh: bridge.workspace, mine: mine || t('log.noFolder') }));
    setStatus(false, bridge.workspace ? t('st.wsMismatch') : t('st.waitingWs'));
    maybePromptWorkspace();
    scheduleReconnect(); // bridge.json may appear / change later
    return;
  }
  const target = bridge.events;
  if (state.sseReq) { try { state.sseReq.destroy(); } catch (e) {} state.sseReq = null; }
  const u = new URL(target);
  u.search = (u.search ? u.search + '&' : '?') + 'token=' + encodeURIComponent(bridge.token);
  // 只有内嵌模式（code-server，每次开编辑器页签都是全新的扩展宿主）才请求
  // 重放最后一次编辑；桌面 VS Code 任何重连都不应再把旧 diff 弹出来抢焦点。
  if (bridge.mode === 'embedded') u.search += '&replay=1';
  const req = http.get({
    hostname: u.hostname,
    port: u.port,
    path: u.pathname + u.search,
    headers: { accept: 'text/event-stream' },
  }, (res) => {
    if (res.statusCode !== 200) {
      setStatus(false, 'HTTP ' + res.statusCode);
      log(t('log.sseHandshakeFail', { code: res.statusCode }));
      res.resume();
      scheduleReconnect();
      return;
    }
    state.connected = true;
    updateStatus();
    log(t('log.sseConnected', { target: target, suffix: isTrusted() ? '' : t('log.restrictedSuffix') }));
    if (!isTrusted()) { setStatus(true, t('st.restricted')); maybePromptTrust(); }
    post({
      type: 'ready',
      version: EXT_VERSION,
      mode: bridge.mode,
      trusted: vscode.workspace.isTrusted,
      workspace: (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath).join(','),
    });
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of frame.split('\n')) {
          if (line.startsWith('data:')) {
            try { handleMessage(JSON.parse(line.slice(5).trim())); } catch (e) {}
          }
        }
      }
    });
    res.on('end', () => { state.connected = false; updateStatus(); log(t('log.sseEnded')); scheduleReconnect(); });
    res.on('error', (e) => { state.connected = false; updateStatus(); log(t('log.sseError', { err: (e && e.message ? e.message : String(e)) })); scheduleReconnect(); });
  });
  req.on('error', (e) => {
    state.connected = false;
    updateStatus();
    log(t('log.sseConnectFail', { err: (e && e.message ? e.message : String(e)) }));
    scheduleReconnect();
  });
  state.sseReq = req;
}

function scheduleReconnect() {
  if (state.reconnectTimer) return;
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    connectSSE();
  }, 2500);
}

// ---------- status ----------
function setStatus(connected, note) {
  state.connected = connected;
  updateStatus(note);
}
function updateStatus(note) {
  if (!state.statusBar) return;
  const conn = state.connected ? '$(plug) DSH' : '$(debug-disconnect) DSH';
  const mode = state.follow ? t('sb.follow') : t('sb.edit');
  state.statusBar.text = conn + ' · ' + mode + (note ? ' · ' + note : '');
  state.statusBar.tooltip = state.connected
    ? t('sb.tipConnected', { mode: state.follow ? t('sb.modeFollow') : t('sb.modeEdit') })
    : t('sb.tipDisconnected');
}

// ---------- edit protection ----------
function isProtected(fsPath) {
  // Keyed lookup, not `has(fsPath)`: on Windows the frame's spelling and
  // doc.uri.fsPath's spelling can differ in drive-letter case (see pathKeyOf).
  return state.follow || state.locked.has(pathKeyOf(fsPath));
}
function revertDocument(doc) {
  const fsPath = doc.uri.fsPath;
  if (state.reverting.has(fsPath)) return;
  const known = state.lastKnown.get(pathKeyOf(fsPath));
  if (typeof known !== 'string') return;
  if (doc.getText() === known) return;
  state.reverting.add(fsPath);
  const full = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
  const we = new vscode.WorkspaceEdit();
  we.replace(doc.uri, full, known);
  vscode.workspace.applyEdit(we).then((ok) => {
    state.reverting.delete(fsPath);
    if (ok) {
      vscode.window.setStatusBarMessage(
        state.follow ? t('msg.revertFollow') : t('msg.revertLocked'), 4000);
    }
  });
}

function activate(context) {
  dbg('activate, bridge=' + (process.env.DSH_BRIDGE_EVENTS || '(none)'));
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider('dsh-snap', snapshots),
    // Right side of the follow diff: served from the host's disk read so an
    // already-open tab cannot supply a stale TextDocument cache (issue #6).
    vscode.workspace.registerTextDocumentContentProvider('dsh-now', currents)
  );

  state.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  state.statusBar.command = 'dsh-bridge.menu';
  state.statusBar.show();
  context.subscriptions.push(state.statusBar);

  context.subscriptions.push(vscode.commands.registerCommand('dsh-bridge.reconnect', () => {
    connectSSE();
  }));

  // 反向切换跟随：POST 给 host 走统一配置写入，host 广播 follow 后
  // 所有端（含本扩展）同步，状态栏文字随之更新。
  context.subscriptions.push(vscode.commands.registerCommand('dsh-bridge.toggleFollow', () => {
    post({ type: 'set-follow', enabled: !state.follow });
    vscode.window.setStatusBarMessage(
      state.follow ? t('msg.reqFollowOff') : t('msg.reqFollowOn'), 2000);
  }));

  // 状态栏点击菜单：切换跟随 / 重新连接。
  context.subscriptions.push(vscode.commands.registerCommand('dsh-bridge.menu', async () => {
    const pick = await vscode.window.showQuickPick([
      {
        id: 'follow',
        label: (state.follow ? '$(check) ' : '$(close) ') + t('menu.follow'),
        description: state.follow ? t('menu.followOnDesc') : t('menu.followOffDesc'),
      },
      { id: 'reconnect', label: '$(debug-restart) ' + t('menu.reconnect'), description: state.connected ? t('menu.connected') : t('menu.disconnected') },
    ]);
    if (!pick) return;
    if (pick.id === 'follow') vscode.commands.executeCommand('dsh-bridge.toggleFollow');
    else connectSSE();
  }));

  // Track authoritative content; revert edits on protected docs.
  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument((doc) => {
    if (doc.uri.scheme === 'file') state.lastKnown.set(pathKeyOf(doc.uri.fsPath), doc.getText());
  }));

  // 基线生命周期是轮次级的：关掉 diff 标签不再删快照（本轮再改该文件会带原
  // 基线重开标签）；整轮基线由 host 的 turn 广播统一清（见 resetTurnDiffs）。
  // 点开带有本轮 diff 基线的文件（资源管理器 / 快速打开）→ 自动切到该文件的
  // 本轮 diff 标签，而不是停留在普通编辑器视图：本轮 diff 在下一轮对话产生
  // 新编辑前始终是「活的」。仅跟随模式；激活的本身就是 diff 标签时跳过，
  // 防止 openDiff 自己触发的事件造成递归。
  let autoDiffTimer = null;
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor((ed) => {
    if (!state.follow || !ed || ed.document.uri.scheme !== 'file') return;
    const fsPath = ed.document.uri.fsPath;
    if (!snapshots._contents.has(fsPath)) return;
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    if (tab && tab.input instanceof vscode.TabInputTextDiff) return;
    if (autoDiffTimer) clearTimeout(autoDiffTimer);
    autoDiffTimer = setTimeout(() => {
      autoDiffTimer = null;
      if (state.follow && snapshots._contents.has(fsPath)) openDiff(fsPath, -1).catch(() => {});
    }, 150);
  }));
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument((doc) => {
    if (doc.uri.scheme === 'file') state.lastKnown.set(pathKeyOf(doc.uri.fsPath), doc.getText());
  }));
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((e) => {
    const doc = e.document;
    if (doc.uri.scheme !== 'file' || !e.contentChanges.length) return;
    if (state.reverting.has(doc.uri.fsPath)) return;
    if (isProtected(doc.uri.fsPath)) {
      revertDocument(doc);
    } else {
      state.lastKnown.set(pathKeyOf(doc.uri.fsPath), doc.getText());
    }
  }));

  // Workspace change re-evaluates the desktop-mode gate (and any new window
  // opened via the "打开该工作区" prompt reconnects on its own).
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
    if (bridge.mode === 'desktop') connectSSE();
  }));
  // 信任授予后重连：重发 ready（trusted:true），恢复接收编辑同步。
  context.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(() => {
    log(t('log.trustGranted'));
    trustPrompted = false;
    connectSSE();
  }));

  updateStatus();
  connectSSE();
}

function deactivate() {
  if (state.sseReq) { try { state.sseReq.destroy(); } catch (e) {} }
  if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
}

module.exports = {
  activate,
  deactivate,
  // Offline simulation surface: test/windows-sim.mjs requires this module with a
  // stubbed `vscode` and a forced win32 platform, so the Windows desktop reports
  // (issues #4/#5/#6) can be reproduced on any machine. Unused at runtime.
  __test: { handleMessage, workspaceMatches, openDiff, normPath, pathKeyOf, isProtected, snapshots, currents, state, bridge },
};
