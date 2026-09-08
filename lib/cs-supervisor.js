'use strict'
/**
 * cs-supervisor — dsh-vsceditor 的 code-server 看门狗包装进程。
 *
 * 为什么存在：host 插件（lib/host.js）的清理回调只在 DSH 正常退出时执行；
 * DSH 崩溃 / 被强杀 / Studio 升级重启时，直接 spawn 的 code-server 会变孤儿
 * （PPID=1）永久残留。本进程作为中间层解决这个生命周期缺口：
 *
 *  1. 拉起 code-server 为前台子进程（posix 下 detached 成独立进程组）；
 *  2. 每 WATCH_MS ping 一次 host 插件状态端点；连续 MAX_FAIL 次不通视为
 *     DSH 已死 → 杀掉整棵子进程树后退出（默认 5s × 12 ≈ 60s 宽限）；
 *  3. 收到 SIGTERM/SIGINT/SIGHUP 时级联转发给子进程树（插件正常停止路径）；
 *  4. 子进程退出 → 以相同退出码退出，host 的崩溃重试逻辑不受影响。
 *
 * 用法：node cs-supervisor.js --url <stateUrl> -- <child argv...>
 * 无依赖、不读写磁盘；stdio 继承自父进程，宿主插件照常收集日志。
 */
const { spawn } = require('node:child_process')
const http = require('node:http')

function parseArgs(argv) {
  let stateUrl = ''
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--url' && i + 1 < argv.length) { stateUrl = argv[i + 1]; i++ }
    else if (argv[i] === '--') return { stateUrl, childArgv: argv.slice(i + 1) }
  }
  return { stateUrl, childArgv: [] }
}

const { stateUrl, childArgv } = parseArgs(process.argv.slice(2))
if (!childArgv.length) {
  console.error('[cs-supervisor] no child command given')
  process.exit(2)
}

const WATCH_MS = Math.max(200, parseInt(process.env.DSH_VSCED_WATCH_MS || '5000', 10) || 5000)
const MAX_FAIL = Math.max(1, parseInt(process.env.DSH_VSCED_WATCH_MAX || '12', 10) || 12)

let child
let stopping = false
let exited = false

function killTree(sig) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  try {
    if (process.platform === 'win32') {
      // Windows 无进程组信号；taskkill /T 杀整棵树（对控制台进程本就是强制的）
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).on('error', () => {})
    } else {
      process.kill(-child.pid, sig) // 负 pid = 整个进程组
    }
  } catch (e) {
    try { child.kill(sig) } catch (e2) {}
  }
}

function shutdown(sig) {
  if (stopping) return
  stopping = true
  if (sig === 'heartbeat') {
    // 死因落 stderr：宿主插件收集子进程输出，code-server 消失时能在
    // lastError 里看到是看门狗判死还是 code-server 自己崩的。
    console.error('[cs-supervisor] host unreachable (' + MAX_FAIL + ' failed heartbeats), killing code-server tree and exiting')
  }
  killTree('SIGTERM')
  // 子进程 3s 内不退 → 补 SIGKILL；再兜底自杀，绝不留看门狗孤儿
  setTimeout(() => { killTree('SIGKILL') }, 3000).unref()
  setTimeout(() => { process.exit(0) }, 6000).unref()
}

child = spawn(childArgv[0], childArgv.slice(1), {
  stdio: 'inherit',
  detached: process.platform !== 'win32',
  env: process.env,
})
child.on('error', (e) => {
  console.error('[cs-supervisor] spawn failed: ' + (e && e.message ? e.message : e))
  process.exit(1)
})
child.on('exit', (code, signal) => {
  if (exited) return
  exited = true
  // 主动停止（信号转发 / 心跳判死）时以 0 退出，避免宿主误判为崩溃；
  // 其余情况透传退出码，host 的崩溃重试逻辑照常工作。
  if (stopping) process.exit(0)
  process.exit(code !== null ? code : 1)
})

for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(sig, () => shutdown('signal'))
}

// ---------- 心跳：DSH 死了就殉葬 ----------
// 状态端点由宿主插件在同一个 DSH 进程内提供，进程活则端点活；DSH 崩溃 /
// 强杀 / 被新版本替换后，连续失败即判定宿主死亡。端点无需鉴权（只读快照）。
let fails = 0
function ping() {
  if (stopping || exited) return
  let done = false
  const fail = () => {
    if (done) return
    done = true
    fails++
    if (fails >= MAX_FAIL) shutdown('heartbeat')
  }
  try {
    const req = http.get(stateUrl, { timeout: Math.min(3000, WATCH_MS) }, (res) => {
      res.resume()
      if (done) return
      done = true
      fails = res.statusCode === 200 ? 0 : fails + 1
      if (fails >= MAX_FAIL) shutdown('heartbeat')
    })
    req.on('timeout', () => { req.destroy(); fail() })
    req.on('error', fail)
  } catch (e) {
    fail()
  }
}
if (stateUrl) {
  setInterval(ping, WATCH_MS).unref()
  // 首轮不等满一个周期：宿主端口在拉起我们之前就已监听，立即探一次。
  setTimeout(ping, 1000).unref()
}
