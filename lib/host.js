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
const SUPERVISOR = path.join(PKG_ROOT, 'lib', 'cs-supervisor.js')

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
  trustedHosts: '',
  // 扩展侧追踪开关：host 通过 SSE 的 `debug` 帧即时下发，扩展无需重启即可开始
  // 写 /tmp/dsh-bridge-debug.log。桌面 VS Code 窗口不是本插件拉起的（环境变量
  // 到不了那里），所以只能走帧。
  bridgeDebug: false,
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
    'cfg.port': '监听端口；0 = 随机（10000–65000）；改动自动重启编辑器',
    'cfg.codeServerHome': '手动指定 code-server 安装目录；留空自动查找',
    'cfg.editorBackend': '编辑器后端：embedded = 内嵌 code-server；local = 连接本机桌面版 VS Code；off = 关闭（不连接任何后端，不占用内存）',
    'cfg.vscodePath': '手动指定本机 VS Code 路径（code CLI 或 .app/Code.exe）；留空自动探测',
    'cfg.language': '插件界面语言；auto = 跟随浏览器/DSH 界面语言',
    'cfg.trustedHosts': '信任的主机（逗号分隔的裸 host 或 host:port）：经反向代理/自定义域名访问 DSH 时在此声明；不声明则控制接口只接受本机回环访问。留空 = 仅回环',
    'cfg.bridgeDebug': '扩展侧调试追踪：开启后扩展把「打开 diff」的过程写入 /tmp/dsh-bridge-debug.log（即时生效，无需重启 DSH）',
    'notice.diffFailed': '扩展打开 diff 失败：{base} —— {error}（详见 ~/.dsh-editor/bridge-ext.log）',
    'err.object': 'dsh-vsceditor 配置必须是对象',
    'err.follow': 'follow 必须是布尔值',
    'err.followWorkspaceOnly': 'followWorkspaceOnly 必须是布尔值',
    'err.bridgeDebug': 'bridgeDebug 必须是布尔值',
    'err.autoStart': 'autoStart 必须是布尔值',
    'err.port': 'port 必须是 0-65535 的整数（0 = 随机端口）',
    'err.codeServerHome': 'codeServerHome 必须是字符串',
    'err.editorBackend': 'editorBackend 必须是 embedded、local 或 off',
    'err.vscodePath': 'vscodePath 必须是字符串',
    'err.language': 'language 必须是 auto、zh、en、pt-BR 或 es',
    'err.trustedHosts': 'trustedHosts 必须是逗号分隔的裸主机名（host 或 host:port）；不支持通配符、协议或路径',
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
    'cfg.port': 'Listen port; 0 = random (10000–65000); changes restart the editor automatically',
    'cfg.codeServerHome': 'code-server install directory; leave empty for auto-detection',
    'cfg.editorBackend': 'Editor backend: embedded = built-in code-server; local = connect to the local desktop VS Code; off = closed (no backend, no memory footprint)',
    'cfg.vscodePath': 'Local VS Code path (code CLI or .app/Code.exe); leave empty for auto-detection',
    'cfg.language': 'Plugin UI language; auto = follow the browser language',
    'cfg.trustedHosts': 'Trusted hosts (comma separated bare host or host:port): declare the hostname you use to reach DSH through a reverse proxy or custom domain; without it the control routes accept loopback only. Empty = loopback only',
    'cfg.bridgeDebug': 'Extension debug tracing: when on, the extension appends the diff-open trace to /tmp/dsh-bridge-debug.log (takes effect immediately, no DSH restart)',
    'notice.diffFailed': 'The extension failed to open the diff for {base} — {error} (see ~/.dsh-editor/bridge-ext.log)',
    'err.object': 'dsh-vsceditor config must be an object',
    'err.follow': 'follow must be a boolean',
    'err.followWorkspaceOnly': 'followWorkspaceOnly must be a boolean',
    'err.bridgeDebug': 'bridgeDebug must be a boolean',
    'err.autoStart': 'autoStart must be a boolean',
    'err.port': 'port must be an integer between 0 and 65535 (0 = random port)',
    'err.codeServerHome': 'codeServerHome must be a string',
    'err.editorBackend': 'editorBackend must be "embedded", "local" or "off"',
    'err.vscodePath': 'vscodePath must be a string',
    'err.language': 'language must be one of: auto, zh, en, pt-BR, es',
    'err.trustedHosts': 'trustedHosts must be a comma separated list of bare authorities (host or host:port); wildcards, schemes and paths are not supported',
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
    'cfg.port': 'Porta de escuta; 0 = aleatória (10000–65000); alterações reiniciam o editor',
    'cfg.codeServerHome': 'Diretório de instalação do code-server; deixe vazio para busca automática',
    'cfg.editorBackend': 'Backend do editor: embedded = code-server integrado; local = conectar ao VS Code desktop local; off = desligado (sem backend, sem uso de memória)',
    'cfg.vscodePath': 'Caminho do VS Code local (CLI code ou .app/Code.exe); deixe vazio para detectar automaticamente',
    'cfg.language': 'Idioma da interface do plugin; auto = segue o idioma do navegador',
    'cfg.trustedHosts': 'Hosts confiáveis (host ou host:port, separados por vírgula): declare o hostname usado para acessar o DSH por proxy reverso ou domínio próprio; sem isso as rotas de controle aceitam apenas loopback. Vazio = apenas loopback',
    'cfg.bridgeDebug': 'Rastreamento de depuração da extensão: quando ativado, a extensão grava o rastro de abertura de diff em /tmp/dsh-bridge-debug.log (efeito imediato, sem reiniciar o DSH)',
    'notice.diffFailed': 'A extensão não conseguiu abrir o diff de {base} — {error} (veja ~/.dsh-editor/bridge-ext.log)',
    'err.object': 'A configuração do dsh-vsceditor deve ser um objeto',
    'err.follow': 'follow deve ser um booleano',
    'err.followWorkspaceOnly': 'followWorkspaceOnly deve ser um booleano',
    'err.bridgeDebug': 'bridgeDebug deve ser um booleano',
    'err.autoStart': 'autoStart deve ser um booleano',
    'err.port': 'port deve ser um inteiro entre 0 e 65535 (0 = porta aleatória)',
    'err.codeServerHome': 'codeServerHome deve ser uma string',
    'err.editorBackend': 'editorBackend deve ser "embedded", "local" ou "off"',
    'err.vscodePath': 'vscodePath deve ser uma string',
    'err.language': 'language deve ser auto, zh, en, pt-BR ou es',
    'err.trustedHosts': 'trustedHosts deve ser uma lista separada por vírgulas de autoridades simples (host ou host:port); curingas, esquemas e caminhos não são aceitos',
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
    'cfg.port': 'Puerto de escucha; 0 = aleatorio (10000–65000); los cambios reinician el editor',
    'cfg.codeServerHome': 'Directorio de instalación de code-server; déjalo vacío para detectarlo automáticamente',
    'cfg.editorBackend': 'Backend del editor: embedded = code-server integrado; local = conectar al VS Code de escritorio local; off = apagado (sin backend, sin uso de memoria)',
    'cfg.vscodePath': 'Ruta del VS Code local (CLI code o .app/Code.exe); déjalo vacío para detectarlo automáticamente',
    'cfg.language': 'Idioma de la interfaz del plugin; auto = sigue el idioma del navegador',
    'cfg.trustedHosts': 'Hosts de confianza (host o host:port, separados por comas): declara el hostname con el que accedes a DSH mediante proxy inverso o dominio propio; sin esto las rutas de control solo aceptan loopback. Vacío = solo loopback',
    'cfg.bridgeDebug': 'Traza de depuración de la extensión: al activarla, la extensión escribe el rastro de apertura de diff en /tmp/dsh-bridge-debug.log (efecto inmediato, sin reiniciar DSH)',
    'notice.diffFailed': 'La extensión no pudo abrir el diff de {base} — {error} (ver ~/.dsh-editor/bridge-ext.log)',
    'err.object': 'La configuración de dsh-vsceditor debe ser un objeto',
    'err.follow': 'follow debe ser un booleano',
    'err.followWorkspaceOnly': 'followWorkspaceOnly debe ser un booleano',
    'err.bridgeDebug': 'bridgeDebug debe ser un booleano',
    'err.autoStart': 'autoStart debe ser un booleano',
    'err.port': 'port debe ser un entero entre 0 y 65535 (0 = puerto aleatorio)',
    'err.codeServerHome': 'codeServerHome debe ser una cadena de texto',
    'err.editorBackend': 'editorBackend debe ser "embedded", "local" u "off"',
    'err.vscodePath': 'vscodePath debe ser una cadena de texto',
    'err.language': 'language debe ser auto, zh, en, pt-BR o es',
    'err.trustedHosts': 'trustedHosts debe ser una lista separada por comas de autoridades simples (host o host:port); no se admiten comodines, esquemas ni rutas',
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
    editorBackend: c.editorBackend === 'local' || c.editorBackend === 'off' ? c.editorBackend : 'embedded',
    vscodePath: typeof c.vscodePath === 'string' ? c.vscodePath : CONFIG_DEFAULTS.vscodePath,
    language: c.language === 'auto' || LANG_IDS[c.language] ? c.language : CONFIG_DEFAULTS.language,
    // Stored as the typed string so settings.yaml stays human-editable; a
    // composition may hand us an array instead.
    trustedHosts: typeof c.trustedHosts === 'string'
      ? c.trustedHosts
      : (Array.isArray(c.trustedHosts) ? c.trustedHosts.join(', ') : CONFIG_DEFAULTS.trustedHosts),
    // 注意：这是第三个键清单（另两处是 CONFIG_DEFAULTS 与 configSchema.dict）。
    // 漏在这里 = 该键被 normalizeConfig 静默丢弃、设置永不生效；测试里有一条
    // 不变量专门盯这个（Object.keys(configSchema({})) 必须等于 CONFIG_DEFAULTS）。
    bridgeDebug: typeof c.bridgeDebug === 'boolean' ? c.bridgeDebug : CONFIG_DEFAULTS.bridgeDebug,
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
  if (value.editorBackend !== undefined && value.editorBackend !== 'embedded' && value.editorBackend !== 'local' && value.editorBackend !== 'off') throw new TypeError(hostT('err.editorBackend'))
  if (value.vscodePath !== undefined && typeof value.vscodePath !== 'string') throw new TypeError(hostT('err.vscodePath'))
  if (value.language !== undefined && value.language !== 'auto' && !LANG_IDS[value.language]) throw new TypeError(hostT('err.language'))
  if (value.trustedHosts !== undefined) parseTrustedHosts(value.trustedHosts)
  if (value.bridgeDebug !== undefined && typeof value.bridgeDebug !== 'boolean') throw new TypeError(hostT('err.bridgeDebug'))
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
  trustedHosts: { type: 'string', meta: { default: CONFIG_DEFAULTS.trustedHosts, get description() { return hostT('cfg.trustedHosts') } } },
  bridgeDebug: { type: 'boolean', meta: { default: CONFIG_DEFAULTS.bridgeDebug, get description() { return hostT('cfg.bridgeDebug') } } },
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


// ---------- control-plane request fence ----------
// /state and /action previously had NO validation: any web page could
// cross-site POST set-config {vscodePath} + detect-vscode and have the host
// execute that binary (CSRF -> command execution), and /state leaked config.
// Two kinds of attacker have to be stopped:
//   - a web page (cross-site fetch / DNS rebinding): it cannot forge Host or
//     Origin, so the Host/Origin rules bind it
//   - a non-browser client on this machine or on the LAN: it CAN forge both,
//     so the socket address is the only honest signal — a request that did not
//     arrive over a loopback socket may only speak for an authority the
//     deployment explicitly declared trusted (`trustedHosts`)
// Rules:
//   - Host must be loopback-named, be the address this request actually
//     arrived on, or be a declared trusted authority
//   - a non-loopback socket requires a declared trusted authority
//   - sec-fetch-site: cross-site rejected
//   - Origin, when present, must match Host
//   - state-changing POSTs additionally require an Origin at all (browsers
//     always send one; non-browser local scripts do not)

// Strip IPv6 brackets and case, so a URL hostname and a socket address compare.
function normalizeAddress(value) {
  if (typeof value !== 'string') return ''
  let s = value.trim().toLowerCase()
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1)
  return s
}

// Canonicalize IPv4-mapped IPv6 to dotted IPv4. `new URL()` reports
// [::ffff:127.0.0.1] as the hex-pair form `[::ffff:7f00:1]`, so the bracketed
// IPv6 form has to be understood here or non-loopback IPv6 gets a false 403.
function addressKey(value) {
  const s = normalizeAddress(value)
  const dotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(s)
  if (dotted) return dotted[1]
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(s)
  if (hex) {
    const hi = parseInt(hex[1], 16)
    const lo = parseInt(hex[2], 16)
    return [(hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255].join('.')
  }
  return s
}

// Loopback by name or by address: localhost, ::1, or any 127.0.0.0/8 address
// in either its dotted or IPv4-mapped form.
function isLoopbackName(value) {
  const key = addressKey(value)
  if (key === 'localhost' || key.endsWith('.localhost')) return true
  if (key === '::1') return true
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(key)
  return m !== null && m[1] === '127' && m.slice(1).every((p) => Number(p) <= 255)
}

// DSH core's trustedHosts shape: an entry with an explicit port matches that
// exact authority; a port-less entry matches the hostname on any port. Both
// sides go through WHATWG normalization, so case and a redundant `:80` never
// decide trust.
function isTrustedAuthority(hostUrl, trustedHosts) {
  for (const entry of trustedHosts) {
    let entryUrl
    try { entryUrl = new URL('http://' + entry) } catch (e) { continue }
    if (entryUrl.hostname === '') continue
    const hit = entryUrl.port !== '' ? entryUrl.host === hostUrl.host : entryUrl.hostname === hostUrl.hostname
    if (hit) return true
  }
  return false
}

// `trustedHosts` setting: comma/whitespace separated bare authorities
// (`host` or `host:port`), or an array when set from a composition. Wildcards,
// schemes and paths are rejected rather than silently ignored.
function isBareAuthority(entry) {
  if (entry.indexOf('*') !== -1) return false
  try {
    const u = new URL('http://' + entry)
    return u.hostname !== '' && u.username === '' && u.password === '' && u.pathname === '/' && u.search === '' && u.hash === ''
  } catch (e) { return false }
}

function parseTrustedHosts(raw) {
  const list = Array.isArray(raw) ? raw : String(raw === undefined || raw === null ? '' : raw).split(/[\s,]+/)
  const out = []
  for (const item of list) {
    const entry = String(item === undefined || item === null ? '' : item).trim()
    if (entry === '') continue
    if (!isBareAuthority(entry)) throw new TypeError(hostT('err.trustedHosts'))
    if (out.indexOf(entry) === -1) out.push(entry)
  }
  return out
}

function isTrustedControlRequest(req, mutation, trustedHosts) {
  const headers = (req && req.headers) || {}
  const host = headers.host
  if (typeof host !== 'string' || host === '') return false
  let hostUrl
  try { hostUrl = new URL('http://' + host) } catch (e) { return false }
  const socket = (req && req.socket) || {}
  const declared = isTrustedAuthority(hostUrl, trustedHosts || [])
  const fromLoopback = isLoopbackName(socket.remoteAddress)
  // Same-machine access through the machine's own LAN address or hostname
  // still passes: the loopback socket proves the client is local, so the name
  // it used cannot have been rebound by a remote page.
  const arrivedOn = fromLoopback && addressKey(hostUrl.hostname) === addressKey(socket.localAddress)
  if (!isLoopbackName(hostUrl.hostname) && !declared && !arrivedOn) return false
  if (!fromLoopback && !declared) return false
  if (headers['sec-fetch-site'] === 'cross-site') return false
  const origin = headers.origin
  if (origin === undefined) return !mutation
  try { return new URL(origin).host === hostUrl.host } catch (e) { return false }
}

// Normalizes an extension `ack` into the record the panel reads. Pure, so the
// smoke test can cover the matrix without a browser or a live extension host.
// opened/timeout matter: a 6s vscode.diff timeout neither throws nor proves the
// diff reached the screen, so "acked" must not be read as "shown".
function ackRecord(msg, now) {
  const src = msg || {}
  return {
    kind: typeof src.kind === 'string' ? src.kind : '',
    path: typeof src.path === 'string' ? src.path : '',
    follow: src.follow !== false,
    opened: src.opened === true,
    timeout: src.timeout === true,
    dedup: src.dedup === true,
    error: src.error ? String(src.error) : '',
    at: typeof now === 'number' ? now : Date.now(),
  }
}

// Resolves the `file_path` an agent handed a write/edit tool call. Agents
// sometimes pass a workspace-relative path (`Tdata\config.lua`); it used to flow
// through verbatim, so the desktop extension called vscode.Uri.file() on a
// relative path and VS Code resolved it against the process drive, producing
// tabs like `\Tdata\config.lua` (issue #5). Resolving here also keeps the
// lock / snapshot / recent keys identical when the same file is spelled
// relatively once and absolutely the next time. Pure, so the smoke test covers
// it without a live agent.
function resolveEditPath(p, root, platform) {
  if (typeof p !== 'string' || p === '') return undefined
  // `platform` exists so the offline simulation test can exercise win32 path
  // semantics on a POSIX runner. Production never passes it, so the host keeps
  // using the path implementation of the machine it actually runs on.
  const P = platform === 'win32' ? path.win32 : (platform === 'posix' ? path.posix : path)
  let out = p
  if (!P.isAbsolute(out)) out = P.resolve(root || process.cwd(), out)
  return P.normalize(out)
}

// Containment test for `followWorkspaceOnly`. The prefix comparison it replaces
// was case-sensitive and built `root + sep` blindly, so on Windows a file that
// IS inside the workspace was treated as outside (and silently skipped) whenever
// the drive letter's case differed from the session root — the same mistake as
// issues #4/#5, in the host instead of the extension. Also tolerates a trailing
// separator on the root. Pure, so the smoke test covers it.
function isInsideOrEqualPath(p, root, platform) {
  if (typeof p !== 'string' || typeof root !== 'string' || p === '' || root === '') return false
  const win = platform === 'win32' || (platform === undefined && process.platform === 'win32')
  const P = platform === 'win32' ? path.win32 : (platform === 'posix' ? path.posix : path)
  const fold = (s) => {
    let n = P.normalize(s)
    if (n.length > 1) n = n.replace(/[\\/]+$/, '')
    return win ? n.toLowerCase() : n
  }
  const a = fold(p)
  const b = fold(root)
  return a === b || a.startsWith(b + P.sep)
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
      // 轮次级 diff 状态：current = 最近一个对话轮次号（来自 agent/inbox/claimed），
      // pending = 新一轮已开启但尚未产生编辑（旧 diff 保留到新一轮首次编辑才清），
      // turnEdits = 本轮被改文件 → 该文件本轮基线（本轮首次编辑前的内容），
      // 供内嵌窗口刷新/重开时完整重放本轮全部 diff。
      turn: { current: -1, pending: false },
      turnEdits: new Map(),
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
      lastAck: undefined,
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
    // Full unprivileged range: a narrow fixed band made the --auth none
    // code-server trivially discoverable by localhost port scans.
    const randomPort = 10000 + Math.floor(Math.random() * 55000)
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
      if (prev.bridgeDebug !== next.bridgeDebug) {
        // 即时生效：扩展收到帧就打开/关闭追踪，不需要重启 code-server 或 DSH。
        broadcast({ type: 'debug', enabled: !!next.bridgeDebug })
      }
      if (prev.editorBackend !== next.editorBackend) {
        if (next.editorBackend === 'local') enterLocalMode()
        else if (next.editorBackend === 'off') enterOffMode()
        else exitLocalMode()
        return
      }
      const envChanged = prev.port !== next.port || prev.codeServerHome !== next.codeServerHome
      if (envChanged && state.running) restartServer()
      if (next.editorBackend === 'embedded' && !prev.autoStart && next.autoStart && !state.running) { adoptFromExisting(); startServer() }
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
        lastAck: state.lastAck,
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
      if (!args || typeof args !== 'object' || typeof args.file_path !== 'string' || args.file_path.length === 0) return undefined
      return resolveEditPath(args.file_path, state.workspaceRoot)
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
        // 新一轮对话的首次编辑：此刻才清掉上一轮的 diff（基线 + 已开标签），
        // 新一轮只显示本轮的累计变化。新一轮如果没有编辑，旧 diff 原样保留。
        if (state.turn.pending) {
          state.turn.pending = false
          state.turnEdits.clear()
          state.lastEdit = undefined
          broadcast({ type: 'turn' })
        }
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
          if (!isInsideOrEqualPath(p, state.workspaceRoot)) return
        }
        const msg = { type: 'edit', path: p, oldText, newText, firstLine: st.firstLine }
        state.lastEdit = msg
        // 记录本轮基线（本轮首次触碰该文件时的 oldText），供重放整轮 diff。
        if (!state.turnEdits.has(p)) state.turnEdits.set(p, oldText)
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
      // 关闭态只记录工作区（重新打开时直接使用），不拉起任何进程。
      if (currentConfig.editorBackend === 'off') return
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
          res.write('data: ' + JSON.stringify({ type: 'hello', follow: state.follow, locked: Object.keys(state.locked), workspace: state.workspaceRoot, debug: !!currentConfig.bridgeDebug }) + '\n\n')
          // Every code-server window is a fresh extension host (each click on
          // the editor tab spawns one), so embedded clients opt in with
          // ?replay=1 to immediately restore this turn's diffs. Desktop
          // VS Code windows must NOT get the replay: any reconnect (network
          // blip, proxy hiccup) would otherwise force diffs open again and
          // yank the user out of whatever tab they are on.
          if (state.follow && /[?&]replay=1/.test(req.url || '')) {
            if (state.turnEdits.size > 0) {
              // 重放本轮全部改动：每帧带本轮基线 + 当前磁盘内容，扩展侧据此
              // 重建快照并重开 diff 标签。异步逐文件读取，按首次编辑顺序发送。
              const entries = Array.from(state.turnEdits.entries())
              ;(async () => {
                for (const pair of entries) {
                  try {
                    const cur = await readFileSafe(pair[0])
                    if (cur === undefined || cur === pair[1]) continue
                    const st = diffStats(pair[1], cur)
                    res.write('data: ' + JSON.stringify({ type: 'edit', path: pair[0], oldText: pair[1], newText: cur, firstLine: st.firstLine }) + '\n\n')
                  } catch (e) {}
                }
              })()
            } else if (state.lastEdit) {
              res.write('data: ' + JSON.stringify(state.lastEdit) + '\n\n')
            }
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
            // 扩展对每个 edit 帧回报 ack：opened/timeout 是「diff 到底弹没弹」的
            // 唯一凭据。此前 ack 被直接丢弃，diff 打不开在面板侧完全不可见。
            if (msg && msg.type === 'ack') {
              state.lastAck = ackRecord(msg)
              const base = state.lastAck.path ? state.lastAck.path.split('/').pop() : ''
              // 只有扩展明确报错才提示；6s 超时不算失败（promise 仍可能兑现），
              // 只记进 lastAck，避免把一个常见现象做成噪音告警。
              if (msg.kind === 'edit-error') setNotice('notice.diffFailed', { base: base, error: state.lastAck.error || 'unknown' })
              else if (state.noticeCode === 'notice.diffFailed') clearNotice()
            }
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
    // Authorities the control fence accepts in addition to loopback: the
    // deployment's own `trustedHosts` (DSH core exposes the list on the
    // `connection` service) plus this plugin's setting, unioned so a host the
    // operator already declared for DSH does not have to be declared twice.
    function controlTrustedHosts() {
      const list = []
      try {
        const conn = ctx.get('connection')
        if (conn && Array.isArray(conn.trustedHosts)) {
          for (const entry of conn.trustedHosts) {
            if (typeof entry === 'string' && entry.trim() !== '') list.push(entry.trim())
          }
        }
      } catch (e) {}
      try {
        for (const entry of parseTrustedHosts(currentConfig.trustedHosts)) {
          if (list.indexOf(entry) === -1) list.push(entry)
        }
      } catch (e) {}
      return list
    }

    disposers.push(webServer.register({
      kind: 'exact',
      path: CONTROL_STATE,
      handler(req, res) {
        if (!isTrustedControlRequest(req, false, controlTrustedHosts())) { res.writeHead(403); res.end(); return }
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
        if (!isTrustedControlRequest(req, true, controlTrustedHosts())) { res.writeHead(403); res.end(); return }
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
              // Only known config keys may be written through the control
              // route; nothing else can smuggle extra fields into settings.
              const filtered = {}
              for (const key of Object.keys(CONFIG_DEFAULTS)) {
                if (Object.prototype.hasOwnProperty.call(msg.patch, key)) filtered[key] = msg.patch[key]
              }
              writeConfig(filtered)
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

    // 轮次边界：用户消息被领取 = 新一轮对话开始。只标记 pending，不清状态——
    // 旧 diff 要等这一轮真正产生首次编辑时才消失（见 handleEdited）。
    // 同轮内的 steering 消息 turn 号不变，不会误触发。跨会话守卫：别的
    // 工作区的会话翻轮次不影响本编辑器。
    ctx.on('agent/inbox/claimed', (payload) => {
      try {
        const turn = payload && payload.turn
        if (typeof turn !== 'number') return
        const cwd = cwdOf(payload && payload.agent)
        if (state.workspaceRoot && cwd && cwd !== state.workspaceRoot) return
        if (turn !== state.turn.current) {
          state.turn.current = turn
          state.turn.pending = true
        }
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
        fs.writeFileSync(tmp, payload, { mode: 0o600 })
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
    // off = 关闭态：不连接任何后端。停掉 code-server（terminate 看门狗，它
    // 级联杀掉整棵 code-server 进程树，不留孤儿）、摘掉 bridge.json 让本机
    // 扩展断开。此后所有拉起路径都被 startServer 顶部的 off 守卫挡住——
    // 自动启动、崩溃重试、重启定时器、安装完成拉起全部失效，不会重复启动。
    function enterOffMode() {
      state.retries = 0
      clearLastError()
      clearNotice()
      removeBridgeFile()
      stopServer()
    }
    function exitLocalMode() {
      removeBridgeFile()
      // 切回内嵌是用户的显式操作（含 关闭 → 打开），无论 autoStart 如何都
      // 立即拉起；autoStart 只管 DSH 启动时的行为。startServer 内部对
      // 非 embedded 后端有守卫，这里无需再判。
      adoptFromExisting()
      startServer()
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

    // ---------- 孤儿编辑器收割 ----------
    // DSH 崩溃 / 被强杀 / Studio 升级替换进程时，旧 code-server（及旧看门狗）
    // 会变孤儿（PPID=1）永久残留——历史上一次升级能留下十几个。启动时扫进程表，
    // 把祖先已死且带本插件签名（我们的 code-server 目录 + 我们的
    // extensions-dir，避免误伤用户自己装的 code-server）的进程回收：先 TERM
    // 看门狗（它的信号处理会级联杀掉 code-server 子树）、再 TERM 其余，5s 后
    // 还活着的补 SIGKILL。祖先活着的实例（PPID≠1，包括本实例自己的）绝不动。
    // Windows 无可靠的 PPID=1 孤儿语义（pid 复用），靠看门狗心跳兜底，不做收割。
    function reapOrphanedEditors() {
      if (process.platform !== 'darwin' && process.platform !== 'linux') return
      runCmd(['ps', '-eo', 'pid=,ppid=,command='], 8000).then((out) => {
        const sup = []
        const rest = []
        for (const line of out.split('\n')) {
          const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
          if (!m || m[2].trim() !== '1') continue
          const cmd = m[3]
          if (cmd.indexOf('.dsh-editor/code-server') === -1) continue
          if (cmd.indexOf('dsh-vsceditor/vscode-ext') === -1) continue
          const pid = Number(m[1])
          if (!pid || pid === process.pid) continue
          ;(cmd.indexOf('cs-supervisor.js') !== -1 ? sup : rest).push(pid)
        }
        const victims = sup.concat(rest)
        if (victims.length === 0) return
        console.log('[dsh-vsceditor] reaping orphaned editor pids: ' + victims.join(','))
        for (const pid of victims) { try { process.kill(pid, 'SIGTERM') } catch (e) {} }
        ctx.timeout(() => {
          for (const pid of victims) {
            let alive = true
            try { process.kill(pid, 0) } catch (e) { alive = false }
            if (alive) { try { process.kill(pid, 'SIGKILL') } catch (e) {} }
          }
        }, 5000)
      })
    }

    // ---------- code-server process ----------
    function startServer() {
      // off 守卫：所有拉起路径（自动启动、崩溃重试、重启定时器、安装完成、
      // 手动开始）都汇聚于此，关闭态一律不启动，杜绝重复拉起。
      if (currentConfig.editorBackend !== 'embedded') return
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
        // 不直接 spawn code-server，而是 spawn 看门狗（lib/cs-supervisor.js）由它
        // 拉起 code-server 进程组：DSH 崩溃/强杀时清理回调不会执行，看门狗靠
        // 心跳发现宿主死亡后杀整棵子树陪葬，杜绝孤儿 code-server 残留。
        const nodeBin = (function () {
          if (found.entryJs) return found.nodeExe
          const n = path.join(found.base, 'code-server', 'lib', 'node')
          try { if (fs.statSync(n).isFile()) return n } catch (e) {}
          return process.execPath
        })()
        const childArgv = found.entryJs
          ? [found.nodeExe, found.entryJs].concat(flags)
          : [found.bin].concat(flags)
        const stateUrl = 'http://127.0.0.1:' + webServer.port + CONTROL_STATE
        const proc = subprocess.spawn({
          argv: [nodeBin, SUPERVISOR, '--url', stateUrl, '--'].concat(childArgv),
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
        const startedAt = Date.now()
        proc.done.then((out) => {
          state.running = false
          if (state.proc === proc) state.proc = undefined
          // 主动停止（切到本机/关闭模式、插件卸载）不算错误，不往 lastError 写噪音。
          if (state.stopping || currentConfig.editorBackend !== 'embedded') return
          let tail = ''
          try { if (proc.collected && proc.collected.stderr) tail = proc.collected.stderr.readFrom(0).text } catch (e) {}
          try { if (!tail && proc.collected && proc.collected.stdout) tail = proc.collected.stdout.readFrom(0).text } catch (e) {}
          setLastError('', {}, 'code-server exited: code=' + out.exitCode + ' signal=' + out.signal + (tail ? ' | ' + tail.slice(-600) : ''))
          // 稳定运行超过 30s 后的退出不算崩溃循环（比如看门狗误杀、系统维护），
          // 重置重试计数；只有 30s 内连续夭折才消耗 4 次重试额度。
          if (Date.now() - startedAt > 30000) state.retries = 0
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
    reapOrphanedEditors()
    // 覆盖启动顺序竞态：新实例的首次收割跑完时，旧实例可能还没死透（其子
    // 进程 PPID 尚未变成 1，不匹配孤儿规则），30s 后再收一次；此后每 30min
    // 低频巡检，兜住运行期间宿主异常死亡留下的残留。
    ctx.timeout(() => reapOrphanedEditors(), 30000)
    ctx.interval(() => reapOrphanedEditors(), 30 * 60 * 1000)
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

plugin.isTrustedControlRequest = isTrustedControlRequest
plugin.parseTrustedHosts = parseTrustedHosts
plugin.ackRecord = ackRecord
plugin.resolveEditPath = resolveEditPath
plugin.isInsideOrEqualPath = isInsideOrEqualPath
// Exported for the smoke test's invariant: every schema key must also exist in
// CONFIG_DEFAULTS, because the control route's write whitelist iterates the
// latter — a key added to only one of them would be silently unwritable.
plugin.CONFIG_DEFAULTS = CONFIG_DEFAULTS
plugin.configSchema = configSchema
module.exports = plugin
