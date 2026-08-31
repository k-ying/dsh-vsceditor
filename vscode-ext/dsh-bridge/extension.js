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
// Debug log is opt-in: set DSH_BRIDGE_DEBUG to a non-empty value to append
// traces to /tmp/dsh-bridge-debug.log.
const DEBUG = !!process.env.DSH_BRIDGE_DEBUG;
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
function normFs(p) { return String(p || '').replace(/[\\/]+$/, ''); }
function workspaceMatches() {
  if (bridge.mode !== 'desktop') return true;
  if (!bridge.workspace) return false;
  const folders = vscode.workspace.workspaceFolders || [];
  return folders.some((f) => normFs(f.uri.fsPath) === normFs(bridge.workspace));
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

// ---------- snapshot (diff left side) ----------
class SnapshotProvider {
  constructor() {
    this._emitter = new vscode.EventEmitter();
    this.onDidChange = this._emitter.event;
    this._contents = new Map(); // key(fsPath) -> oldText
  }
  set(fsPath, text) {
    this._contents.set(fsPath, text);
    this._emitter.fire(snapUri(fsPath));
  }
  provideTextDocumentContent(uri) {
    const key = decodeURIComponent(uri.query || '');
    dbg('provider called, key=' + key + ' hit=' + this._contents.has(key));
    return this._contents.get(key) ?? '';
  }
}
function snapUri(fsPath) {
  return vscode.Uri.parse('dsh-snap://snapshot' + encodePath(fsPath) + '?' + encodeURIComponent(fsPath));
}
function encodePath(p) { return '/' + p.split('/').map(encodeURIComponent).join('/'); }
const snapshots = new SnapshotProvider();

// ---------- host -> ext message handlers ----------
// 去重：同一份编辑帧在 30s 窗口内只处理一次。SSE 重连、多路径投递都不应
// 让同一个 diff 反复弹出抢走用户当前页签。
let lastEditKey = '';
let lastEditAt = 0;
function editKeyOf(msg) {
  const t = typeof msg.newText === 'string' ? msg.newText : '';
  let h = 0;
  for (let i = 0; i < t.length; i += 97) h = (h * 31 + t.charCodeAt(i)) | 0;
  return msg.path + '|' + t.length + '|' + h;
}
async function onEdit(msg) {
  const fsPath = msg.path;
  dbg('onEdit start, follow=' + state.follow);
  snapshots.set(fsPath, typeof msg.oldText === 'string' ? msg.oldText : '');
  state.lastKnown.set(fsPath, typeof msg.newText === 'string' ? msg.newText : state.lastKnown.get(fsPath));
  const key = editKeyOf(msg);
  if (key === lastEditKey && Date.now() - lastEditAt < 30000) {
    dbg('onEdit dedup skip for ' + fsPath);
    post({ type: 'ack', kind: 'edit', path: fsPath, follow: state.follow, dedup: true });
    return;
  }
  lastEditKey = key;
  lastEditAt = Date.now();
  if (!state.follow) { post({ type: 'ack', kind: 'edit', path: fsPath, follow: false }); return; }
  try {
    const left = snapUri(fsPath);
    const right = vscode.Uri.file(fsPath);
    const base = fsPath.split('/').pop() || fsPath;
    dbg('calling vscode.diff, windowFocused=' + vscode.window.state.focused + ' visibleEditors=' + vscode.window.visibleTextEditors.length);
    const diffDone = vscode.commands.executeCommand('vscode.diff', left, right, t('diff.title', { base: base }));
    const raced = await Promise.race([
      diffDone.then((r) => ({ ok: true, r: r })).catch((e) => ({ ok: false, e: e })),
      new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 6000)),
    ]);
    if (raced && raced.timeout) { dbg('diff TIMEOUT after 6s (promise still pending) for ' + base); }
    else if (raced && raced.ok) { dbg('diff opened for ' + base); }
    else { dbg('diff REJECTED for ' + base + ': ' + (raced && raced.e && raced.e.message)); throw raced.e; }
    diffDone.catch(() => {});
    setTimeout(() => {
      const ed = vscode.window.activeTextEditor;
      if (ed && typeof msg.firstLine === 'number' && msg.firstLine >= 0) {
        const line = Math.min(msg.firstLine, Math.max(0, ed.document.lineCount - 1));
        const pos = new vscode.Position(line, 0);
        try {
          ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
          ed.selection = new vscode.Selection(pos, pos);
        } catch (e) {}
      }
    }, 450);
    post({ type: 'ack', kind: 'edit', path: fsPath, follow: true });
  } catch (e) {
    dbg('diff FAILED for ' + fsPath + ': ' + (e && e.message) + ' ' + (e && e.stack));
    log('diff failed for ' + fsPath + ': ' + (e && e.message));
    post({ type: 'ack', kind: 'edit-error', path: fsPath, error: String(e && e.message) });
  }
}

async function onReveal(msg) {
  dbg('onReveal start: ' + msg.path);
  try {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(msg.path));
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

function handleMessage(msg) {
  if (!msg || typeof msg.type !== 'string') return;
  // 受限模式下只维护状态，不执行任何编辑/跳转指令。
  if (!isTrusted() && (msg.type === 'edit' || msg.type === 'reveal')) return;
  dbg('recv: ' + msg.type + (msg.path ? ' ' + msg.path : ''));
  switch (msg.type) {
    case 'hello':
      state.follow = !!msg.follow;
      state.locked = new Set(Array.isArray(msg.locked) ? msg.locked : []);
      updateStatus();
      break;
    case 'follow':
      state.follow = !!msg.enabled;
      updateStatus();
      break;
    case 'lock':
      if (msg.path) state.locked.add(msg.path);
      break;
    case 'unlock':
      if (msg.path) state.locked.delete(msg.path);
      break;
    case 'edit':
      onEdit(msg);
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
  return state.follow || state.locked.has(fsPath);
}
function revertDocument(doc) {
  const fsPath = doc.uri.fsPath;
  if (state.reverting.has(fsPath)) return;
  const known = state.lastKnown.get(fsPath);
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
    vscode.workspace.registerTextDocumentContentProvider('dsh-snap', snapshots)
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
    if (doc.uri.scheme === 'file') state.lastKnown.set(doc.uri.fsPath, doc.getText());
  }));
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument((doc) => {
    if (doc.uri.scheme === 'file') state.lastKnown.set(doc.uri.fsPath, doc.getText());
  }));
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((e) => {
    const doc = e.document;
    if (doc.uri.scheme !== 'file' || !e.contentChanges.length) return;
    if (state.reverting.has(doc.uri.fsPath)) return;
    if (isProtected(doc.uri.fsPath)) {
      revertDocument(doc);
    } else {
      state.lastKnown.set(doc.uri.fsPath, doc.getText());
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

module.exports = { activate, deactivate };
