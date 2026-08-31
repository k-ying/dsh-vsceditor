'use strict'
/**
 * dsh-vsceditor — Host half (host-plane composition plugin, mounted once per
 * process through the dsh profile bundle stack).
 *
 * Manages one code-server (full VSCode) process and bridges DSH file edits
 * into it over SSE + POST using ACP-session/update-style messages
 * (edit {path, oldText, newText, firstLine}, lock/unlock/follow/reveal). The
 * bundled dsh-bridge VSCode extension (vscode-ext/dsh-bridge) receives those
 * messages and opens native red/green diff views.
 *
 * Runs unscoped on purpose: scoped tool events admit unscoped listeners
 * (events flow up the scope chain), so one instance observes every session's
 * write/edit calls. The editor workspace follows whichever session's agent is
 * actively editing; a divergent workspace triggers a code-server restart on
 * the new folder.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')

const PKG_ROOT = path.resolve(__dirname, '..')
const EXT_DIR = path.join(PKG_ROOT, 'vscode-ext')
const EXT_SRC_DIR = path.join(EXT_DIR, 'dsh-bridge')
const EXT_INSTALL_ROOT = path.join(os.homedir(), '.vscode', 'extensions')
const BRIDGE_DIR = path.join(os.homedir(), '.dsh-editor')
const BRIDGE_FILE = path.join(BRIDGE_DIR, 'bridge.json')
const BRIDGE_EXT_LOG = path.join(BRIDGE_DIR, 'bridge-ext.log')
const BUNDLED_EXT_VERSION = (function () {
  try { return JSON.parse(fs.readFileSync(path.join(EXT_SRC_DIR, 'package.json'), 'utf8')).version || '0.0.0' } catch (e) { return '0.0.0' }
})()
const CONTROL_STATE = '/__dsh-vsceditor/state'
const CONTROL_ACTION = '/__dsh-vsceditor/action'

// ---------- configuration ----------
// Served as settings namespace "dsh-vsceditor" so 设置 → 插件 → 插件配置
// dispatches this plugin's card (the tab only dispatches namespaces the Host
// serves). The schema is a plain callable — schemastery-compatible in shape —
// so this plugin needs no @deepseek-ai/* dependency.
const SETTINGS_NS = 'dsh-vsceditor'
const LANG_IDS = { zh: 1, en: 1, 'pt-BR': 1, es: 1 }
const CONFIG_DEFAULTS = {
  follow: true,
  followWorkspaceOnly: false,
  autoStart: true,
  port: 0,
  codeServerHome: '',
  editorBackend: 'embedded',
  vscodePath: '',
  language: 'auto',
}

let currentLanguage = 'auto'
let browserLang = ''

function resolveHostLang() {
  if (currentLanguage && currentLanguage !== 'auto' && LANG_IDS[currentLanguage]) return currentLanguage
  if (browserLang && LANG_IDS[browserLang]) return browserLang
  return 'zh'
}

const HOST_L10N = {
  zh: {
    'cfg.meta': '内嵌 VSCode 编辑器（code-server）',
    'cfg.follow': '跟随 DSH 编辑：改文件时自动弹出 diff 并定位改动行',
    'cfg.followWorkspaceOnly': '仅跟随工作区内文件：开启后工作区外的改动只记录到最近列表，不弹 diff',
    'cfg.autoStart': 'DSH 启动后自动拉起 code-server',
    'cfg.port': '监听端口；0 = 随机（18200–18900）；改动自动重启编辑器',
    'cfg.codeServerHome': '手动指定 code-server 安装目录；留空自动查找',
    'cfg.editorBackend': '编辑器后端：embedded = 内嵌 code-server；local = 连接本机桌面版 VS Code',
    'cfg.vscodePath': '手动指定本机 VS Code 路径（code CLI 或 .app/Code.exe）；留空自动探测',
    'cfg.language': '插件界面语言；auto = 跟随浏览器/DSH 界面语言',
    'err.object': 'dsh-vsceditor 配置必须是对象',
    'err.follow': 'follow 必须是布尔值',
    'err.followWorkspaceOnly': 'followWorkspaceOnly 必须是布尔值',
    'err.autoStart': 'autoStart 必须是布尔值',
    'err.port': 'port 必须是 0-65535 的整数（0 = 随机端口）',
    'err.codeServerHome': 'codeServerHome 必须是字符串',
    'err.editorBackend': 'editorBackend 必须是 embedded 或 local',
    'err.vscodePath': 'vscodePath 必须是字符串',
    'err.language': 'language 必须是 auto、zh、en、pt-BR 或 es',
    'workspace-switched': '工作区已切换：{cwd}',
    'ext-updated': '桌面 VS Code 的 DSH 扩展已更新到 v{v}，请在 VS Code 里 Reload Window 生效',
    'waiting-session': '等待第一个会话以确定工作区…',
    'codeserver-missing-win': '未找到 code-server（Windows 布局：code-server/node/node.exe + code-server/runtime/…/entry.js；查找过 配置的 codeServerHome、$DSH_VSCEDITOR_HOME、<工作区>/.dsh-editor、~/.dsh-editor）。请运行 scripts/install-code-server.ps1 安装；{hint}',
    'codeserver-missing-unix': '未找到 code-server（查找过 配置的 codeServerHome、$DSH_VSCEDITOR_HOME、<工作区>/.dsh-editor、~/.dsh-editor）。请运行 scripts/install-code-server.sh 安装；{hint}',
    'codeserver-hint': '不装 code-server 也可以改用「本机 VS Code」模式（设置 → 插件配置 → 编辑器后端），跟随/锁定体验一致',
    'bridge-write-failed': 'bridge.json 写入失败：{err}',
    'settings-ns-failed': '设置命名空间注册失败：{err}',
    'install-done': 'code-server 安装完成，正在启动…',
  },
  en: {
    'cfg.meta': 'Embedded VS Code editor (code-server)',
    'cfg.follow': 'Follow DSH edits: auto-show a diff and jump to changed lines when files change',
    'cfg.followWorkspaceOnly': 'Only follow workspace files: changes outside the workspace are only recorded in the recent list, no diff popup',
    'cfg.autoStart': 'Start code-server automatically when DSH starts',
    'cfg.port': 'Listen port; 0 = random (18200–18900); changes restart the editor automatically',
    'cfg.codeServerHome': 'code-server install directory; leave empty for auto-detection',
    'cfg.editorBackend': 'Editor backend: embedded = built-in code-server; local = connect to the local desktop VS Code',
    'cfg.vscodePath': 'Local VS Code path (code CLI or .app/Code.exe); leave empty for auto-detection',
    'cfg.language': 'Plugin UI language; auto = follow the browser language',
    'err.object': 'dsh-vsceditor config must be an object',
    'err.follow': 'follow must be a boolean',
    'err.followWorkspaceOnly': 'followWorkspaceOnly must be a boolean',
    'err.autoStart': 'autoStart must be a boolean',
    'err.port': 'port must be an integer between 0 and 65535 (0 = random port)',
    'err.codeServerHome': 'codeServerHome must be a string',
    'err.editorBackend': 'editorBackend must be "embedded" or "local"',
    'err.vscodePath': 'vscodePath must be a string',
    'err.language': 'language must be one of: auto, zh, en, pt-BR, es',
    'workspace-switched': 'Workspace switched: {cwd}',
    'ext-updated': 'The DSH extension in desktop VS Code was updated to v{v}; Reload Window in VS Code to apply it',
    'waiting-session': 'Waiting for the first session to determine the workspace…',
    'codeserver-missing-win': 'code-server not found (Windows layout: code-server/node/node.exe + code-server/runtime/…/entry.js; looked in the configured codeServerHome, $DSH_VSCEDITOR_HOME, <workspace>/.dsh-editor, ~/.dsh-editor). Run scripts/install-code-server.ps1 to install; {hint}',
    'codeserver-missing-unix': 'code-server not found (looked in the configured codeServerHome, $DSH_VSCEDITOR_HOME, <workspace>/.dsh-editor, ~/.dsh-editor). Run scripts/install-code-server.sh to install; {hint}',
    'codeserver-hint': 'No code-server? Switch to the "Local VS Code" backend (Settings → Plugin config → Editor backend) — follow mode and locking work the same',
    'bridge-write-failed': 'Failed to write bridge.json: {err}',
    'settings-ns-failed': 'Failed to register the settings namespace: {err}',
    'install-done': 'code-server installed, starting…',
  },
  'pt-BR': {
    'cfg.meta': 'Editor VS Code integrado (code-server)',
    'cfg.follow': 'Seguir edições do DSH: mostra um diff automaticamente e salta para as linhas alteradas quando os arquivos mudam',
    'cfg.followWorkspaceOnly': 'Seguir apenas arquivos do workspace: alterações fora do workspace ficam só na lista de recentes, sem diff',
    'cfg.autoStart': 'Iniciar o code-server automaticamente junto com o DSH',
    'cfg.port': 'Porta de escuta; 0 = aleatória (18200–18900); alterações reiniciam o editor',
    'cfg.codeServerHome': 'Diretório de instalação do code-server; deixe vazio para busca automática',
    'cfg.editorBackend': 'Backend do editor: embedded = code-server integrado; local = conectar ao VS Code desktop local',
    'cfg.vscodePath': 'Caminho do VS Code local (CLI code ou .app/Code.exe); deixe vazio para detectar automaticamente',
    'cfg.language': 'Idioma da interface do plugin; auto = segue o idioma do navegador',
    'err.object': 'A configuração do dsh-vsceditor deve ser um objeto',
    'err.follow': 'follow deve ser um booleano',
    'err.followWorkspaceOnly': 'followWorkspaceOnly deve ser um booleano',
    'err.autoStart': 'autoStart deve ser um booleano',
    'err.port': 'port deve ser um inteiro entre 0 e 65535 (0 = porta aleatória)',
    'err.codeServerHome': 'codeServerHome deve ser uma string',
    'err.editorBackend': 'editorBackend deve ser "embedded" ou "local"',
    'err.vscodePath': 'vscodePath deve ser uma string',
    'err.language': 'language deve ser auto, zh, en, pt-BR ou es',
    'workspace-switched': 'Workspace alterado: {cwd}',
    'ext-updated': 'A extensão DSH no VS Code desktop foi atualizada para v{v}; faça Reload Window no VS Code para aplicar',
    'waiting-session': 'Aguardando a primeira sessão para determinar o workspace…',
    'codeserver-missing-win': 'code-server não encontrado (layout do Windows: code-server/node/node.exe + code-server/runtime/…/entry.js; procurado em codeServerHome configurado, $DSH_VSCEDITOR_HOME, <workspace>/.dsh-editor, ~/.dsh-editor). Execute scripts/install-code-server.ps1 para instalar; {hint}',
    'codeserver-missing-unix': 'code-server não encontrado (procurado em codeServerHome configurado, $DSH_VSCEDITOR_HOME, <workspace>/.dsh-editor, ~/.dsh-editor). Execute scripts/install-code-server.sh para instalar; {hint}',
    'codeserver-hint': 'Sem code-server? Mude para o modo «VS Code local» (Configurações → Plugins → Backend do editor) — seguir e bloquear funcionam igual',
    'bridge-write-failed': 'Falha ao gravar bridge.json: {err}',
    'settings-ns-failed': 'Falha ao registrar o namespace de configurações: {err}',
    'install-done': 'code-server instalado, iniciando…',
  },
  es: {
    'cfg.meta': 'Editor VS Code incrustado (code-server)',
    'cfg.follow': 'Seguir ediciones de DSH: muestra automáticamente un diff y salta a las líneas modificadas cuando cambian los archivos',
    'cfg.followWorkspaceOnly': 'Seguir solo archivos del workspace: los cambios fuera del workspace solo se registran en la lista de recientes, sin diff',
    'cfg.autoStart': 'Iniciar code-server automáticamente al arrancar DSH',
    'cfg.port': 'Puerto de escucha; 0 = aleatorio (18200–18900); los cambios reinician el editor',
    'cfg.codeServerHome': 'Directorio de instalación de code-server; déjalo vacío para detectarlo automáticamente',
    'cfg.editorBackend': 'Backend del editor: embedded = code-server integrado; local = conectar al VS Code de escritorio local',
    'cfg.vscodePath': 'Ruta del VS Code local (CLI code o .app/Code.exe); déjalo vacío para detectarlo automáticamente',
    'cfg.language': 'Idioma de la interfaz del plugin; auto = sigue el idioma del navegador',
    'err.object': 'La configuración de dsh-vsceditor debe ser un objeto',
    'err.follow': 'follow debe ser un booleano',
    'err.followWorkspaceOnly': 'followWorkspaceOnly debe ser un booleano',
    'err.autoStart': 'autoStart debe ser un booleano',
    'err.port': 'port debe ser un entero entre 0 y 65535 (0 = puerto aleatorio)',
    'err.codeServerHome': 'codeServerHome debe ser una cadena de texto',
    'err.editorBackend': 'editorBackend debe ser "embedded" o "local"',
    'err.vscodePath': 'vscodePath debe ser una cadena de texto',
    'err.language': 'language debe ser auto, zh, en, pt-BR o es',
    'workspace-switched': 'Workspace cambiado: {cwd}',
    'ext-updated': 'La extensión DSH del VS Code de escritorio se actualizó a v{v}; recarga la ventana (Reload Window) en VS Code para aplicarla',
    'waiting-session': 'Esperando la primera sesión para determinar el workspace…',
    'codeserver-missing-win': 'No se encontró code-server (disposición de Windows: code-server/node/node.exe + code-server/runtime/…/entry.js; se buscó en codeServerHome configurado, $DSH_VSCEDITOR_HOME, <workspace>/.dsh-editor, ~/.dsh-editor). Ejecuta scripts/install-code-server.ps1 para instalarlo; {hint}',
    'codeserver-missing-unix': 'No se encontró code-server (se buscó en codeServerHome configurado, $DSH_VSCEDITOR_HOME, <workspace>/.dsh-editor, ~/.dsh-editor). Ejecuta scripts/install-code-server.sh para instalarlo; {hint}',
    'codeserver-hint': '¿Sin code-server? Cambia al modo «VS Code local» (Configuración → Plugins → Backend del editor); seguir y bloquear funcionan igual',
    'bridge-write-failed': 'Error al escribir bridge.json: {err}',
    'settings-ns-failed': 'Error al registrar el espacio de nombres de configuración: {err}',
    'install-done': 'code-server instalado, iniciando…',
  },
}

function hostT(key, params) {
  const lang = resolveHostLang()
  const d = HOST_L10N[lang] || HOST_L10N.en
  let s = d && d[key] !== undefined ? d[key] : (HOST_L10N.en[key] !== undefined ? HOST_L10N.en[key] : (HOST_L10N.zh[key] !== undefined ? HOST_L10N.zh[key] : key))
  if (params) {
    s = s.replace(/\{(\w+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(params, k) ? String(params[k]) : m))
  }
  return s
}

function captureBrowserLang(req) {
  try {
    const al = req && req.headers && (req.headers['accept-language'] || '')
    if (!al) return
    const first = String(al).split(',')[0].toLowerCase().trim()
    if (first.startsWith('zh')) browserLang = 'zh'
    else if (first.startsWith('pt')) browserLang = 'pt-BR'
    else if (first.startsWith('es')) browserLang = 'es'
    else if (first.startsWith('en')) browserLang = 'en'
  } catch (e) {}
}

function normalizeConfig(raw) {
  const c = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  return {
    follow: typeof c.follow === 'boolean' ? c.follow : CONFIG_DEFAULTS.follow,
    followWorkspaceOnly: typeof c.followWorkspaceOnly === 'boolean' ? c.followWorkspaceOnly : CONFIG_DEFAULTS.followWorkspaceOnly,
    autoStart: typeof c.autoStart === 'boolean' ? c.autoStart : CONFIG_DEFAULTS.autoStart,
    port: Number.isInteger(c.port) && c.port >= 0 && c.port <= 65535 ? c.port : CONFIG_DEFAULTS.port,
    codeServerHome: typeof c.codeServerHome === 'string' ? c.codeServerHome : CONFIG_DEFAULTS.codeServerHome,
    editorBackend: c.editorBackend === 'local' ? 'local' : 'embedded',
    vscodePath: typeof c.vscodePath === 'string' ? c.vscodePath : CONFIG_DEFAULTS.vscodePath,
    language: c.language === 'auto' || LANG_IDS[c.language] ? c.language : CONFIG_DEFAULTS.language,
  }
}

// Callable settings schema: fn(value) -> resolved value, throwing on invalid.
// Strict on present-but-mistyped fields so bad writes through settings.update
// are rejected instead of silently coerced.
function configSchema(value) {
  if (value === undefined || value === null) return normalizeConfig({})
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError(hostT('err.object'))
  if (value.follow !== undefined && typeof value.follow !== 'boolean') throw new TypeError(hostT('err.follow'))
  if (value.followWorkspaceOnly !== undefined && typeof value.followWorkspaceOnly !== 'boolean') throw new TypeError(hostT('err.followWorkspaceOnly'))
  if (value.autoStart !== undefined && typeof value.autoStart !== 'boolean') throw new TypeError(hostT('err.autoStart'))
  if (value.port !== undefined && !(Number.isInteger(value.port) && value.port >= 0 && value.port <= 65535)) throw new TypeError(hostT('err.port'))
  if (value.codeServerHome !== undefined && typeof value.codeServerHome !== 'string') throw new TypeError(hostT('err.codeServerHome'))
  if (value.editorBackend !== undefined && value.editorBackend !== 'embedded' && value.editorBackend !== 'local') throw new TypeError(hostT('err.editorBackend'))
  if (value.vscodePath !== undefined && typeof value.vscodePath !== 'string') throw new TypeError(hostT('err.vscodePath'))
  if (value.language !== undefined && value.language !== 'auto' && !LANG_IDS[value.language]) throw new TypeError(hostT('err.language'))
  return normalizeConfig(value)
}

// The settings registry needs more than a callable: describe() serializes
// schema.toJSON() for the browser mirror, and the secret-redaction walk reads
// type/dict/meta straight off the schema object. A bare function without
// these breaks describe() for EVERY namespace (the 插件配置 tab then renders
// blank), so keep this schemastery-compatible in shape.
configSchema.type = 'object'
configSchema.dict = {
  follow: { type: 'boolean', meta: { default: CONFIG_DEFAULTS.follow, get description() { return hostT('cfg.follow') } } },
  followWorkspaceOnly: { type: 'boolean', meta: { default: CONFIG_DEFAULTS.followWorkspaceOnly, get description() { return hostT('cfg.followWorkspaceOnly') } } },
  autoStart: { type: 'boolean', meta: { default: CONFIG_DEFAULTS.autoStart, get description() { return hostT('cfg.autoStart') } } },
  port: { type: 'number', meta: { default: CONFIG_DEFAULTS.port, get description() { return hostT('cfg.port') } } },
  codeServerHome: { type: 'string', meta: { default: CONFIG_DEFAULTS.codeServerHome, get description() { return hostT('cfg.codeServerHome') } } },
  editorBackend: { type: 'string', meta: { default: CONFIG_DEFAULTS.editorBackend, get description() { return hostT('cfg.editorBackend') } } },
  vscodePath: { type: 'string', meta: { default: CONFIG_DEFAULTS.vscodePath, get description() { return hostT('cfg.vscodePath') } } },
  language: { type: 'string', meta: { default: CONFIG_DEFAULTS.language, get description() { return hostT('cfg.language') } } },
}
configSchema.meta = { get description() { return hostT('cfg.meta') } }
configSchema.toJSON = function () {
  const dict = {}
  for (const k in configSchema.dict) {
    const entry = configSchema.dict[k]
    dict[k] = { type: entry.type, meta: { default: entry.meta.default, description: entry.meta.description } }
  }
  return { type: configSchema.type, dict: dict, meta: { description: configSchema.meta.description } }
}

function findCodeServer(cwd, home) {
  const candidates = [
    home || '',
    process.env.DSH_VSCEDITOR_HOME || '',
    cwd ? path.join(cwd, '.dsh-editor') : '',
    path.join(os.homedir(), '.dsh-editor'),
  ].filter(Boolean)
  for (const base of candidates) {
    if (process.platform === 'win32') {
      // Windows 没有官方独立包；约定 scripts/install-code-server.ps1 的布局：
      // code-server/node/node.exe + code-server/runtime/node_modules/code-server/out/node/entry.js
      const entryJs = path.join(base, 'code-server', 'runtime', 'node_modules', 'code-server', 'out', 'node', 'entry.js')
      const nodeExe = path.join(base, 'code-server', 'node', 'node.exe')
      try {
        if (fs.statSync(entryJs).isFile() && fs.statSync(nodeExe).isFile()) return { nodeExe, entryJs, base }
      } catch (e) { /* keep looking */ }
    } else {
      const bin = path.join(base, 'code-server', 'bin', 'code-server')
      try {
        if (fs.statSync(bin).isFile()) return { bin, base }
      } catch (e) { /* keep looking */ }
    }
  }
  return undefined
}

// Per-workspace runtime data (user-data / config) lives OUTSIDE the
// workspace, under the global ~/.dsh-editor/workspaces/<hash>-<slug>/ —
// same model VS Code itself uses (user-level data dir keyed per
// workspace). Keeping caches out of the project dir means nothing extra
// shows up in the user's repo (no dotfolder to ignore or commit).
// Back-compat: workspaces that already have a legacy <ws>/.dsh-editor/
// user-data keep using it, so existing editor state is preserved.
function workspaceDataBase(root) {
  const legacy = path.join(root, '.dsh-editor')
  try {
    if (fs.statSync(path.join(legacy, 'user-data')).isDirectory()) return legacy
  } catch (e) { /* fresh workspace → global location */ }
  const hash = crypto.createHash('sha256').update(root).digest('hex').slice(0, 8)
  const slug = root.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(-60) || 'root'
  return path.join(BRIDGE_DIR, 'workspaces', hash + '-' + slug)
}

function readBody(req, limit, cb) {
  let body = ''
  req.on('data', (c) => {
    body += c
    if (body.length > limit) req.destroy()
  })
  req.on('end', () => cb(body))
}

function sendJson(res, value) {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' })
  res.end(JSON.stringify(value))
}

function cwdOf(agent) {
  try {
    const session = agent && agent.session
    const header = session && session.header
    if (header && typeof header.cwd === 'string' && header.cwd) return header.cwd
    const meta = session && session.meta
    return meta && typeof meta.cwd === 'string' && meta.cwd ? meta.cwd : undefined
  } catch (e) {
    return undefined
  }
}

const plugin = {
  name: 'dsh-vsceditor',
  inject: ['webServer', 'subprocess', 'timer', 'agents'],
  apply(ctx, config) {
    const webServer = ctx.webServer
    const subprocess = ctx.subprocess

    const SFX = Math.random().toString(36).slice(2, 8)
    const EVENTS_PATH = '/__dsh-vsceditor-' + SFX + '/events'
    const RPC_PATH = '/__dsh-vsceditor-' + SFX + '/rpc'
    const token = 'vsced-' + Math.random().toString(36).slice(2) + Date.now().toString(36)

    const state = {
      workspaceRoot: '',
      proc: undefined,
      running: false,
      port: 0,
      follow: true,
      locked: Object.create(null),
      pendingBefore: Object.create(null),
      snapshots: Object.create(null),
      recent: [],
      sse: new Set(),
      lastEdit: undefined,
      lastError: '',
      lastErrorCode: '',
      lastErrorParams: {},
      notice: '',
      noticeCode: '',
      noticeParams: {},
      retries: 0,
      stopping: false,
      restartTimer: undefined,
      extReady: undefined,
      desktop: undefined,
      install: undefined,
    }

    const disposers = []

    // ---------- live configuration ----------
    // entryConfig is the composition-row base layer; once the settings service
    // accepts our namespace, the resolved section (base + user layer) becomes
    // authoritative and user edits apply live through the scope watcher.
    const entryConfig = normalizeConfig(config)
    let currentConfig = entryConfig
    currentLanguage = currentConfig.language
    let settingsScope
    const randomPort = 18200 + Math.floor(Math.random() * 700)
    function desiredPort() { return currentConfig.port > 0 ? currentConfig.port : randomPort }
    state.follow = currentConfig.follow

    function setNotice(code, params) {
      state.noticeCode = code || ''
      state.noticeParams = params || {}
      state.notice = code ? hostT(code, params) : ''
    }
    function clearNotice() {
      state.noticeCode = ''
      state.noticeParams = {}
      state.notice = ''
    }
    function setLastError(code, params, raw) {
      state.lastErrorCode = code || ''
      state.lastErrorParams = params || {}
      state.lastError = code ? hostT(code, Object.assign({}, params, { hint: hostT('codeserver-hint') })) : (raw || '')
    }
    function clearLastError() {
      state.lastErrorCode = ''
      state.lastErrorParams = {}
      state.lastError = ''
    }

    function onConfigChanged(prev, next) {
      if (prev.language !== next.language) {
        currentLanguage = next.language
      }
      if (prev.follow !== next.follow) {
        state.follow = next.follow
        broadcast({ type: 'follow', enabled: next.follow })
      }
      if (prev.editorBackend !== next.editorBackend) {
        if (next.editorBackend === 'local') enterLocalMode()
        else exitLocalMode()
        return
      }
      const envChanged = prev.port !== next.port || prev.codeServerHome !== next.codeServerHome
      if (envChanged && state.running) restartServer()
      if (next.editorBackend !== 'local' && !prev.autoStart && next.autoStart && !state.running) { adoptFromExisting(); startServer() }
    }

    // One write path for every config source (settings card, panel checkbox).
    // With the settings service this persists to the user layer; without it
    // the change stays in memory for this run.
    function writeConfig(patch) {
      if (settingsScope) return settingsScope.update(patch)
      const prev = currentConfig
      currentConfig = configSchema(Object.assign({}, currentConfig, patch))
      onConfigChanged(prev, currentConfig)
      return Promise.resolve()
    }

    // ---------- shared helpers ----------
    function checkToken(req) {
      const m = /[?&]token=([^&]*)/.exec(req.url || '')
      return m !== null && decodeURIComponent(m[1]) === token
    }

    function broadcast(msg) {
      const frame = 'data: ' + JSON.stringify(msg) + '\n\n'
      for (const res of state.sse) {
        try { res.write(frame) } catch (e) {}
      }
    }

    function snapshot() {
      return {
        running: state.running,
        url: 'http://127.0.0.1:' + (state.port || desiredPort()) + '/',
        follow: state.follow,
        locked: Object.keys(state.locked),
        recent: state.recent.slice(0, 20),
        extConnected: state.sse.size > 0,
        extReady: state.extReady,
        backend: currentConfig.editorBackend,
        desktop: state.desktop,
        install: state.install,
        pkgRoot: PKG_ROOT,
        extLog: BRIDGE_EXT_LOG,
        lastError: state.lastErrorCode ? hostT(state.lastErrorCode, Object.assign({}, state.lastErrorParams, { hint: hostT('codeserver-hint') })) : state.lastError,
        lastErrorCode: state.lastErrorCode,
        lastErrorParams: state.lastErrorParams,
        notice: state.noticeCode ? hostT(state.noticeCode, state.noticeParams) : state.notice,
        noticeCode: state.noticeCode,
        noticeParams: state.noticeParams,
        workspace: state.workspaceRoot,
        config: currentConfig,
        settingsAvailable: settingsScope !== undefined,
      }
    }

    function diffStats(oldText, newText) {
      const a = oldText.split('\n')
      const b = newText.split('\n')
      const min = Math.min(a.length, b.length)
      let i = 0
      while (i < min && a[i] === b[i]) i++
      let j = 0
      while (j < min - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++
      return { firstLine: i, added: Math.max(0, b.length - i - j), removed: Math.max(0, a.length - i - j) }
    }

    function editPathOf(exec) {
      if (!exec || (exec.name !== 'write' && exec.name !== 'edit')) return undefined
      const args = exec.arguments
      if (args && typeof args === 'object' && typeof args.file_path === 'string' && args.file_path.length > 0) return args.file_path
      return undefined
    }

    async function readFileSafe(p) {
      try { return await fs.promises.readFile(p, 'utf8') } catch (e) { return undefined }
    }

    function captureBefore(p) {
      readFileSafe(p).then((text) => {
        if (text !== undefined) state.pendingBefore[p] = text
      })
    }

    function handleEdited(p) {
      readFileSafe(p).then((newText) => {
        if (newText === undefined) return
        let oldText = ''
        if (Object.prototype.hasOwnProperty.call(state.pendingBefore, p)) oldText = state.pendingBefore[p]
        else if (Object.prototype.hasOwnProperty.call(state.snapshots, p)) oldText = state.snapshots[p]
        delete state.pendingBefore[p]
        if (newText === oldText) { state.snapshots[p] = newText; return }
        const st = diffStats(oldText, newText)
        state.snapshots[p] = newText
        state.recent.unshift({ path: p, at: Date.now(), added: st.added, removed: st.removed })
        if (state.recent.length > 50) state.recent.length = 50
        // followWorkspaceOnly：区外改动照常记录 recent，但不弹 diff、
        // 不更新 lastEdit（避免新窗口重放时也弹区外文件）。
        if (currentConfig.followWorkspaceOnly && state.workspaceRoot) {
          const root = state.workspaceRoot
          if (p !== root && p.indexOf(root + path.sep) !== 0) return
        }
        const msg = { type: 'edit', path: p, oldText, newText, firstLine: st.firstLine }
        state.lastEdit = msg
        broadcast(msg)
      })
    }

    // ---------- workspace follows the active editor agent ----------
    function adoptWorkspace(cwd) {
      if (!cwd || cwd === state.workspaceRoot) return
      const first = !state.workspaceRoot
      state.workspaceRoot = cwd
      if (currentConfig.editorBackend === 'local') {
        // Desktop extension re-gates on the new workspace via bridge.json.
        writeBridgeFile()
        return
      }
      if (first) {
        if (currentConfig.autoStart) startServer()
      } else {
        setNotice('workspace-switched', { cwd })
        restartServer()
      }
    }

    // Boot-order race: sessions may resume before this plugin mounts, so
    // 'agent/created' can be missed entirely. Sweep the live agent registry
    // instead of relying on the event alone.
    function adoptFromExisting() {
      if (state.workspaceRoot) return
      try {
        const agents = ctx.agents
        if (!agents) return
        const running = []
        const rest = []
        for (const a of agents.list()) {
          try {
            if (a && a.status === 'running') running.push(a)
            else rest.push(a)
          } catch (e) { rest.push(a) }
        }
        for (const a of running.concat(rest)) {
          const cwd = cwdOf(a)
          if (cwd) { adoptWorkspace(cwd); return }
        }
      } catch (e) {}
    }

    // ---------- extension bridge routes (unique per boot) ----------
    disposers.push(webServer.register({
      kind: 'exact',
      path: EVENTS_PATH,
      handler(req, res) {
        if (!checkToken(req)) { res.statusCode = 403; res.end('forbidden'); return }
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' })
        res.write(': dsh-vsceditor\n\n')
        state.sse.add(res)
        try {
          res.write('data: ' + JSON.stringify({ type: 'hello', follow: state.follow, locked: Object.keys(state.locked), workspace: state.workspaceRoot }) + '\n\n')
          // Every code-server window is a fresh extension host (each click on
          // the editor tab spawns one), so embedded clients opt in with
          // ?replay=1 to immediately show the most recent DSH change. Desktop
          // VS Code windows must NOT get the replay: any reconnect (network
          // blip, proxy hiccup) would otherwise force the last diff open
          // again and yank the user out of whatever tab they are on.
          if (state.lastEdit && state.follow && /[?&]replay=1/.test(req.url || '')) {
            res.write('data: ' + JSON.stringify(state.lastEdit) + '\n\n')
          }
        } catch (e) {}
        req.on('close', () => { state.sse.delete(res) })
      },
    }))

    disposers.push(webServer.register({
      kind: 'exact',
      path: RPC_PATH,
      handler(req, res) {
        if (!checkToken(req)) { res.statusCode = 403; res.end('forbidden'); return }
        readBody(req, 65536, (body) => {
          try {
            const msg = JSON.parse(body || '{}')
            if (msg && msg.type === 'log') console.log('[dsh-bridge-ext]', msg.message)
            if (msg && msg.type === 'ready') {
              state.extReady = { mode: msg.mode || 'embedded', version: msg.version || '', workspace: msg.workspace || '', trusted: msg.trusted !== false, at: Date.now() }
              // 扩展已在新版本上就绪 → 清掉「已更新，请 Reload Window」的残留提示，
              // 否则面板会一直显示一条已经过期的更新同步信息。
              if (state.extReady.version === BUNDLED_EXT_VERSION && state.noticeCode === 'ext-updated') clearNotice()
            }
            // 扩展侧（状态栏菜单）反向切换跟随；走统一的写配置路径，
            // 变更经 onConfigChanged 广播回所有 SSE 客户端。
            if (msg && msg.type === 'set-follow') writeConfig({ follow: !!msg.enabled })
          } catch (e) {}
          res.statusCode = 204
          res.end()
        })
      },
    }))

    // ---------- control routes used by the web panel ----------
    disposers.push(webServer.register({
      kind: 'exact',
      path: CONTROL_STATE,
      handler(req, res) {
        captureBrowserLang(req)
        adoptFromExisting()
        // 本机模式的探测全部后台跑（单飞），状态接口永远立即返回缓存，
        // 否则每次 2.5s 轮询都会被秒级的 code CLI 调用卡住。
        if (currentConfig.editorBackend === 'local') refreshDesktop(false)
        sendJson(res, snapshot())
      },
    }))
    disposers.push(webServer.register({
      kind: 'exact',
      path: CONTROL_ACTION,
      handler(req, res) {
        captureBrowserLang(req)
        readBody(req, 65536, (body) => {
          try {
            const msg = JSON.parse(body || '{}')
            if (msg.action === 'set-follow') {
              writeConfig({ follow: !!msg.enabled })
                .then(() => sendJson(res, { ok: true, config: currentConfig, persisted: settingsScope !== undefined }))
                .catch((e) => sendJson(res, { ok: false, error: String(e && e.message ? e.message : e) }))
              return
            }
            if (msg.action === 'set-config' && msg.patch && typeof msg.patch === 'object' && !Array.isArray(msg.patch)) {
              writeConfig(msg.patch)
                .then(() => sendJson(res, { ok: true, config: currentConfig, persisted: settingsScope !== undefined }))
                .catch((e) => sendJson(res, { ok: false, error: String(e && e.message ? e.message : e) }))
              return
            }
            if (msg.action === 'set-backend') {
              writeConfig({ editorBackend: msg.backend === 'local' ? 'local' : 'embedded' })
                .then(() => sendJson(res, { ok: true, config: currentConfig, persisted: settingsScope !== undefined }))
                .catch((e) => sendJson(res, { ok: false, error: String(e && e.message ? e.message : e) }))
              return
            }
            if (msg.action === 'detect-vscode') {
              refreshDesktop(true)
                .then((d) => sendJson(res, { ok: true, desktop: d }))
                .catch((e) => sendJson(res, { ok: false, error: String(e && e.message ? e.message : e) }))
              return
            }
            if (msg.action === 'install-extension') {
              const r = installDesktopExtension()
              sendJson(res, r)
              return
            }
            if (msg.action === 'install-codeserver') {
              startInstall()
              sendJson(res, { ok: true, install: state.install })
              return
            }
            if (msg.action === 'cancel-install-codeserver') {
              sendJson(res, { ok: true, cancelled: cancelInstall() })
              return
            }
            if (msg.action === 'reveal' && typeof msg.path === 'string') {
              broadcast({ type: 'reveal', path: msg.path, line: typeof msg.line === 'number' ? msg.line : 0 })
            } else if (msg.action === 'restart') {
              restartServer()
            } else if (msg.action === 'start') {
              adoptFromExisting()
              startServer()
            }
            sendJson(res, { ok: true })
          } catch (e) {
            sendJson(res, { ok: false, error: String(e && e.message ? e.message : e) })
          }
        })
      },
    }))

    // ---------- edit tracking across every session (unscoped listener) ----------
    ctx.on('agent/created', (payload) => {
      try {
        const cwd = cwdOf(payload && payload.agent)
        if (cwd) adoptWorkspace(cwd)
      } catch (e) {}
    })

    ctx.on('tools/pre-execute', (exec, next) => {
      try {
        adoptWorkspace(cwdOf(exec && exec.agent) || state.workspaceRoot)
        const p = editPathOf(exec)
        if (p !== undefined) {
          state.locked[p] = true
          broadcast({ type: 'lock', path: p })
          captureBefore(p)
        }
      } catch (e) {}
      return next()
    })

    ctx.on('tools/result', (exec, result) => {
      try {
        const p = editPathOf(exec)
        if (p === undefined) return
        delete state.locked[p]
        broadcast({ type: 'unlock', path: p })
        if (result && result.isError) return
        handleEdited(p)
      } catch (e) {}
    })

    // ---------- desktop VS Code (local backend) ----------
    // bridge.json is the rendezvous for the desktop extension: env vars cannot
    // be injected into an already-running app, so the host drops coordinates
    // (events/rpc URLs, token, workspace) here and the extension polls it.
    function writeBridgeFile() {
      if (currentConfig.editorBackend !== 'local') return
      try {
        fs.mkdirSync(BRIDGE_DIR, { recursive: true })
        const payload = JSON.stringify({
          version: 1,
          events: 'http://127.0.0.1:' + webServer.port + EVENTS_PATH,
          rpc: 'http://127.0.0.1:' + webServer.port + RPC_PATH,
          token: token,
          workspace: state.workspaceRoot,
          updatedAt: Date.now(),
        })
        const tmp = BRIDGE_FILE + '.tmp'
        fs.writeFileSync(tmp, payload)
        fs.renameSync(tmp, BRIDGE_FILE)
      } catch (e) {
        setLastError('bridge-write-failed', { err: (e && e.message ? e.message : String(e)) })
      }
    }
    function removeBridgeFile() { try { fs.unlinkSync(BRIDGE_FILE) } catch (e) {} }

    function stopServer() {
      const p = state.proc
      state.proc = undefined
      state.running = false
      if (p) { try { p.terminate() } catch (e) {} }
    }

    function runCmd(argv, timeoutMs) {
      return new Promise((resolve) => {
        let proc
        try {
          proc = subprocess.spawn({ argv, stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 16384 } } })
        } catch (e) { resolve(''); return }
        let done = false
        const finish = (text) => { if (!done) { done = true; resolve(text) } }
        proc.done.then((out) => {
          let text = ''
          try { if (out.exitCode === 0 && proc.collected && proc.collected.stdout) text = proc.collected.stdout.readFrom(0).text } catch (e) {}
          finish(text)
        }).catch(() => finish(''))
        ctx.timeout(() => { try { proc.terminate() } catch (e) {} finish('') }, timeoutMs || 6000)
      })
    }

    // Desktop VS Code detection: manual override > platform well-known paths
    // > platform search (which/where/mdfind). Runs strictly in the background
    // (single-flight via refreshDesktop): the code CLI is an Electron shim
    // whose --version / --list-extensions calls take seconds, so the state
    // endpoint never awaits this. Force mode (manual 重新检测 / install) runs
    // the full CLI path; background refreshes use instant filesystem checks.
    const detectCache = { at: 0, result: undefined }
    function cliCandidates() {
      const list = []
      const manual = currentConfig.vscodePath.trim()
      if (manual) {
        list.push(manual)
        if (manual.endsWith('.app')) list.push(path.join(manual, 'Contents', 'Resources', 'app', 'bin', 'code'))
      }
      if (process.platform === 'darwin') {
        list.push('/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code')
        list.push(path.join(os.homedir(), 'Applications', 'Visual Studio Code.app', 'Contents', 'Resources', 'app', 'bin', 'code'))
      } else if (process.platform === 'win32') {
        const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
        list.push(path.join(local, 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd'))
        list.push('C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd')
      } else {
        list.push('/usr/bin/code', '/usr/share/code/bin/code', '/snap/bin/code')
      }
      return list
    }
    async function detectVSCode(force) {
      const prev = detectCache.result
      if (!force && prev !== undefined && Date.now() - detectCache.at < 15000) return prev
      const result = { cli: '', version: '', extInstalled: false, extVersion: '', bundledExtVersion: BUNDLED_EXT_VERSION, extUpToDate: false }
      let cli = ''
      for (const c of cliCandidates()) {
        try { if (fs.statSync(c).isFile()) { cli = c; break } } catch (e) {}
      }
      if (!cli && (force || !prev)) {
        let out = ''
        if (process.platform === 'darwin') {
          out = await runCmd(['mdfind', 'kMDItemCFBundleIdentifier == com.microsoft.VSCode'], 8000)
          const app = (out.split('\n')[0] || '').trim()
          if (app.endsWith('.app')) {
            const p = path.join(app, 'Contents', 'Resources', 'app', 'bin', 'code')
            try { if (fs.statSync(p).isFile()) cli = p } catch (e) {}
          }
        }
        if (!cli) {
          out = await runCmd(process.platform === 'win32' ? ['where', 'code'] : ['which', 'code'], 5000)
          const p = (out.split('\n')[0] || '').trim()
          if (p) { try { if (fs.statSync(p).isFile()) cli = p } catch (e) {} }
        }
      }
      result.cli = cli
      if (cli) {
        // Version: reuse the cached one while the CLI path is unchanged.
        if (prev && prev.cli === cli && prev.version && !force) result.version = prev.version
        else {
          const vout = await runCmd([cli, '--version'], 8000)
          result.version = (vout.split('\n')[0] || '').trim()
        }
        // Extension detection: force mode prefers the authoritative CLI;
        // background refreshes use the instant directory scan.
        if (force) {
          const lout = await runCmd([cli, '--list-extensions', '--show-versions'], 10000)
          const m = /^dsh\.dsh-bridge@(.+)$/m.exec(lout)
          if (m) {
            result.extInstalled = true
            result.extVersion = m[1].trim()
          }
        }
      }
      if (!result.extInstalled) {
        try {
          const stablePkg = path.join(EXT_INSTALL_ROOT, 'dsh.dsh-bridge', 'package.json')
          const v = JSON.parse(fs.readFileSync(stablePkg, 'utf8')).version
          result.extInstalled = true
          result.extVersion = typeof v === 'string' && v ? v : '?'
        } catch (e) {
          // 兼容旧版带版本号的目录名（dsh.dsh-bridge-<version>）
          try {
            const dirs = fs.readdirSync(EXT_INSTALL_ROOT).filter((d) => d.indexOf('dsh.dsh-bridge-') === 0)
            if (dirs.length > 0) {
              result.extInstalled = true
              result.extVersion = dirs.map((d) => d.slice('dsh.dsh-bridge-'.length)).sort().pop()
            }
          } catch (e2) {}
        }
      }
      result.extUpToDate = result.extInstalled && result.extVersion === BUNDLED_EXT_VERSION
      detectCache.at = Date.now()
      detectCache.result = result
      return result
    }

    // Single-flight background refresh: concurrent state polls share one
    // in-flight detection instead of piling up Electron CLI spawns.
    let detectInflight = undefined
    function refreshDesktop(force) {
      if (detectInflight) return detectInflight
      detectInflight = detectVSCode(force)
        .then((d) => { state.desktop = d; detectInflight = undefined; return d })
        .catch(() => { detectInflight = undefined; return state.desktop })
      return detectInflight
    }

    // Copy the bundled extension into ~/.vscode/extensions/dsh.dsh-bridge
    // (home dir, no privilege needed on any platform). The directory name is
    // deliberately version-free: updating in place avoids the "invalid
    // extension" ghost VS Code shows when a previously scanned versioned
    // directory (dsh.dsh-bridge-<v>) disappears. Legacy versioned dirs from
    // earlier installer versions are cleaned up here.
    function installDesktopExtension() {
      const dest = path.join(EXT_INSTALL_ROOT, 'dsh.dsh-bridge')
      try {
        fs.mkdirSync(EXT_INSTALL_ROOT, { recursive: true })
        fs.rmSync(dest, { recursive: true, force: true })
        fs.cpSync(EXT_SRC_DIR, dest, { recursive: true })
        for (const d of fs.readdirSync(EXT_INSTALL_ROOT)) {
          if (d.indexOf('dsh.dsh-bridge-') === 0) {
            try { fs.rmSync(path.join(EXT_INSTALL_ROOT, d), { recursive: true, force: true }) } catch (e) {}
          }
        }
        detectCache.at = 0
        return { ok: true, needsReload: true, version: BUNDLED_EXT_VERSION }
      } catch (e) {
        return {
          ok: false,
          error: e && e.message ? e.message : String(e),
          manual: { from: EXT_SRC_DIR, to: dest },
        }
      }
    }

    // Keep the desktop copy in lockstep with the plugin: on entering local
    // mode, silently re-install when the installed copy is stale.
    async function ensureDesktopExtSynced() {
      const d = await detectVSCode(true)
      if (d.cli && d.extInstalled && !d.extUpToDate) {
        const r = installDesktopExtension()
        if (r.ok) setNotice('ext-updated', { v: BUNDLED_EXT_VERSION })
      }
    }

    function enterLocalMode() {
      stopServer()
      clearLastError()
      writeBridgeFile()
      refreshDesktop(true)
      ensureDesktopExtSynced()
    }
    function exitLocalMode() {
      removeBridgeFile()
      if (currentConfig.autoStart) { adoptFromExisting(); startServer() }
    }

    // ---------- one-click code-server install ----------
    // Runs the bundled install script (scripts/install-code-server.sh on
    // macOS/Linux, .ps1 on Windows) into ~/.dsh-editor — one of the bases
    // findCodeServer already searches. The download is tens of MB and can
    // take minutes, so the action returns immediately and the web panel
    // polls progress through state.install (phase/log/progress/error).
    // The script's curl runs with --progress-bar, whose "##### 42.3%"
    // stderr updates we parse into state.install.progress.
    const CS_VERSION = process.env.DSH_VSCEDITOR_VERSION || '4.133.0'
    let installProc = undefined
    function csDownloadUrl() {
      let pkg = ''
      if (process.platform === 'darwin') pkg = process.arch === 'arm64' ? 'macos-arm64' : 'macos-amd64'
      else if (process.platform === 'linux') {
        if (process.arch === 'x64') pkg = 'linux-amd64'
        else if (process.arch === 'arm64') pkg = 'linux-arm64'
        else if (process.arch === 'arm') pkg = 'linux-armhf'
      }
      return pkg ? 'https://github.com/coder/code-server/releases/download/v' + CS_VERSION + '/code-server-' + CS_VERSION + '-' + pkg + '.tar.gz' : ''
    }
    function startInstall() {
      if (state.install && state.install.phase === 'running') return
      const isWin = process.platform === 'win32'
      const script = path.join(PKG_ROOT, 'scripts', isWin ? 'install-code-server.ps1' : 'install-code-server.sh')
      const argv = isWin
        ? ['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Dest', BRIDGE_DIR]
        : ['sh', script, BRIDGE_DIR]
      state.install = {
        phase: 'running',
        log: [],
        progress: '',
        url: isWin ? '' : csDownloadUrl(),
        dest: path.join(BRIDGE_DIR, 'code-server'),
        startedAt: Date.now(),
        error: '',
        cancelRequested: false,
      }
      let proc
      try {
        proc = subprocess.spawn({
          argv,
          // stderr 要装得下整个下载过程的进度条刷新（\r 逐帧追加），
          // 慢网络下小缓冲可能不够。
          stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 1048576 } },
          graceMs: 3000,
        })
      } catch (e) {
        state.install.phase = 'error'
        state.install.error = 'spawn failed: ' + (e && e.message ? e.message : String(e))
        return
      }
      installProc = proc
      let stopped = false
      const readOut = () => {
        try {
          if (proc.collected && proc.collected.stdout) {
            const text = proc.collected.stdout.readFrom(0).text
            const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
            if (lines.length > 0) state.install.log = lines.slice(-12)
          }
        } catch (e) {}
        try {
          if (proc.collected && proc.collected.stderr) {
            const et = proc.collected.stderr.readFrom(0).text
            const ms = et.match(/(\d{1,3}(?:\.\d+)?)%/g)
            if (ms && ms.length > 0) state.install.progress = ms[ms.length - 1]
          }
        } catch (e) {}
      }
      const pump = () => {
        if (stopped) return
        readOut()
        ctx.timeout(pump, 1000)
      }
      pump()
      proc.done.then((out) => {
        stopped = true
        if (installProc === proc) installProc = undefined
        readOut()
        if (state.install.cancelRequested) {
          state.install.phase = 'cancelled'
          state.install.error = ''
        } else if (out.exitCode === 0) {
          state.install.phase = 'done'
          clearLastError()
          setNotice('install-done')
          adoptFromExisting()
          startServer()
        } else {
          let tail = ''
          try { if (proc.collected && proc.collected.stderr) tail = proc.collected.stderr.readFrom(0).text } catch (e) {}
          state.install.phase = 'error'
          state.install.error = '安装脚本退出码 ' + out.exitCode + (tail ? ' | ' + tail.trim().slice(-400) : '')
        }
      }).catch((err) => {
        stopped = true
        if (installProc === proc) installProc = undefined
        if (state.install.cancelRequested) {
          state.install.phase = 'cancelled'
          state.install.error = ''
        } else {
          state.install.phase = 'error'
          state.install.error = String(err && err.message ? err.message : err)
        }
      })
    }
    function cancelInstall() {
      if (!state.install || state.install.phase !== 'running') return false
      state.install.cancelRequested = true
      const p = installProc
      if (p) { try { p.terminate() } catch (e) {} }
      return true
    }

    // ---------- code-server process ----------
    function startServer() {
      if (currentConfig.editorBackend === 'local') return
      if (state.proc !== undefined || state.stopping) return
      if (!state.workspaceRoot) {
        setNotice('waiting-session')
        return
      }
      const found = findCodeServer(state.workspaceRoot, currentConfig.codeServerHome)
      if (!found) {
        setLastError(process.platform === 'win32' ? 'codeserver-missing-win' : 'codeserver-missing-unix')
        return
      }
      const port = desiredPort()
      state.port = port
      const dataBase = workspaceDataBase(state.workspaceRoot)
      try {
        fs.mkdirSync(path.join(dataBase, 'user-data'), { recursive: true })
        fs.mkdirSync(path.join(dataBase, 'config'), { recursive: true })
      } catch (e) { /* code-server will surface its own error */ }
      try {
        const flags = [
          '--bind-addr', '127.0.0.1:' + port,
          '--auth', 'none',
          '--disable-telemetry',
          '--disable-update-check',
          '--disable-workspace-trust',
          '--extensions-dir', EXT_DIR,
          '--user-data-dir', path.join(dataBase, 'user-data'),
          state.workspaceRoot,
        ]
        const bridgeEnv = {
          DSH_BRIDGE_URL: 'http://127.0.0.1:' + webServer.port,
          DSH_BRIDGE_EVENTS: 'http://127.0.0.1:' + webServer.port + EVENTS_PATH,
          DSH_BRIDGE_RPC: 'http://127.0.0.1:' + webServer.port + RPC_PATH,
          DSH_BRIDGE_TOKEN: token,
        }
        const proc = subprocess.spawn({
          argv: found.entryJs ? [found.nodeExe, found.entryJs].concat(flags) : [found.bin].concat(flags),
          cwd: state.workspaceRoot,
          stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } },
          graceMs: 3000,
          env: process.platform === 'win32'
            ? bridgeEnv
            : Object.assign({
                XDG_CONFIG_HOME: path.join(dataBase, 'config'),
                XDG_DATA_HOME: path.join(dataBase, 'user-data'),
              }, bridgeEnv),
        })
        state.proc = proc
        state.running = true
        clearLastError()
        proc.done.then((out) => {
          state.running = false
          if (state.proc === proc) state.proc = undefined
          // 主动停止（切到本机模式 / 插件卸载）不算错误，不往 lastError 写噪音。
          if (state.stopping || currentConfig.editorBackend === 'local') return
          let tail = ''
          try { if (proc.collected && proc.collected.stderr) tail = proc.collected.stderr.readFrom(0).text } catch (e) {}
          try { if (!tail && proc.collected && proc.collected.stdout) tail = proc.collected.stdout.readFrom(0).text } catch (e) {}
          setLastError('', {}, 'code-server exited: code=' + out.exitCode + ' signal=' + out.signal + (tail ? ' | ' + tail.slice(-600) : ''))
          if (!state.stopping && state.retries < 4) {
            state.retries += 1
            ctx.timeout(() => startServer(), 2000)
          }
        }).catch((err) => {
          state.running = false
          if (state.proc === proc) state.proc = undefined
          setLastError('', {}, String(err))
        })
      } catch (e) {
        setLastError('', {}, 'spawn failed: ' + (e && e.message ? e.message : String(e)))
      }
    }

    function restartServer() {
      state.retries = 0
      const p = state.proc
      state.proc = undefined
      state.running = false
      if (p) { try { p.terminate() } catch (e) {} }
      if (state.restartTimer !== undefined) return
      state.restartTimer = ctx.timeout(() => {
        state.restartTimer = undefined
        startServer()
      }, 1200)
    }

    // ---------- settings namespace (设置 → 插件 → 插件配置) ----------
    // Serve SETTINGS_NS so the configurable-plugins tab dispatches our card.
    // When the service is already up this runs synchronously, so the stored
    // user layer is applied before the auto-start below.
    ctx.inject(['settings'], (sctx) => {
      let scope
      try {
        scope = sctx.settings.register(SETTINGS_NS, configSchema, { base: entryConfig })
      } catch (e) {
        setLastError('settings-ns-failed', { err: (e && e.message ? e.message : e) })
        return
      }
      settingsScope = scope
      const prev = currentConfig
      currentConfig = scope.get()
      onConfigChanged(prev, currentConfig)
      scope.watch(() => {
        const p = currentConfig
        currentConfig = scope.get()
        onConfigChanged(p, currentConfig)
      })
    })

    // Adopt a workspace immediately from sessions that already exist (the
    // common case right after a DSH restart: sessions resume before/without
    // any 'agent/created' firing). Retry briefly while sessions finish
    // resuming so the editor comes up on its own.
    adoptFromExisting()
    ctx.timeout(() => adoptFromExisting(), 3000)
    ctx.timeout(() => adoptFromExisting(), 10000)

    // Local backend boot: publish bridge.json and sync the desktop extension.
    if (currentConfig.editorBackend === 'local') enterLocalMode()

    // ---------- lifecycle ----------
    ctx.interval(() => {
      for (const res of state.sse) { try { res.write(': ping\n\n') } catch (e) {} }
      // 本机模式：后台低频刷新探测缓存（文件系统检查为主，不起 CLI）。
      if (currentConfig.editorBackend === 'local') refreshDesktop(false)
    }, 25000)

    ctx.effect(() => {
      return () => {
        state.stopping = true
        for (const d of disposers) { try { d() } catch (e) {} }
        removeBridgeFile()
        if (installProc) { try { installProc.terminate() } catch (e) {} installProc = undefined }
        const p = state.proc
        state.proc = undefined
        state.running = false
        if (p) { try { p.terminate() } catch (e) {} }
      }
    }, 'dsh-vsceditor')
  },
}

module.exports = plugin
