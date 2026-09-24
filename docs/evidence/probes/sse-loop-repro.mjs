// Minimal, platform-independent reproducer for the bridge SSE reconnect loop.
//
// This is NOT a Windows test. It contains no platform API, no path handling and
// no VS Code — just Node's http client/server. If the loop reproduces here, the
// defect cannot be Windows-specific.
//
// The client half replicates connectSSE()/scheduleReconnect() from
// vscode-ext/dsh-bridge/extension.js (lines 593-672) faithfully:
//   - connectSSE() destroys any existing request before opening a new one (:609)
//   - res 'end'/'error' and req 'error' all call scheduleReconnect()  (:654-662)
//   - scheduleReconnect() is a 2500ms setTimeout with a single-flight guard (:666-672)
// The server half replicates the host's SSE route: hold the response open, send
// one `hello` frame, never end (lib/host.js:801-838).

import http from 'node:http';

// ---------------------------------------------------------------- server
const clients = new Set();
const server = http.createServer((req, res) => {
  if (!req.url.startsWith('/events')) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  res.write(': dsh-vsceditor\n\n');
  clients.add(res);
  res.write('data: ' + JSON.stringify({ type: 'hello' }) + '\n\n');
  req.on('close', () => clients.delete(res));
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
console.log('SSE server on 127.0.0.1:' + port + '  (node ' + process.version + ', ' + process.platform + ')');
console.log('');

// ---------------------------------------------------------------- client
function makeClient(label) {
  const state = { sseReq: null, reconnectTimer: null, connected: false };
  let connects = 0;
  const events = [];

  function scheduleReconnect() {
    if (state.reconnectTimer) return;
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      connectSSE();
    }, 2500);
  }

  function connectSSE() {
    if (state.sseReq) { try { state.sseReq.destroy(); } catch (e) {} state.sseReq = null; }
    const req = http.get(
      { hostname: '127.0.0.1', port, path: '/events', headers: { accept: 'text/event-stream' } },
      (res) => {
        if (res.statusCode !== 200) { res.resume(); scheduleReconnect(); return; }
        connects++;
        state.connected = true;
        events.push({ at: Date.now(), kind: 'connected' });
        res.setEncoding('utf8');
        res.on('data', () => {});
        res.on('end', () => { state.connected = false; events.push({ at: Date.now(), kind: 'end' }); scheduleReconnect(); });
        res.on('error', (e) => { state.connected = false; events.push({ at: Date.now(), kind: 'error:' + e.message }); scheduleReconnect(); });
      }
    );
    req.on('error', (e) => { state.connected = false; events.push({ at: Date.now(), kind: 'reqerr:' + e.message }); scheduleReconnect(); });
    state.sseReq = req;
  }

  return { label, connectSSE, state, get connects() { return connects; }, events };
}

async function scenario(label, startCalls, ms) {
  const c = makeClient(label);
  const t0 = Date.now();
  for (let i = 0; i < startCalls; i++) c.connectSSE();
  await new Promise((r) => setTimeout(r, ms));
  const elapsed = Date.now() - t0;
  console.log('--- ' + label + ' ---');
  console.log('  connectSSE() calls at startup : ' + startCalls);
  console.log('  over ' + (elapsed / 1000).toFixed(1) + 's, connections established : ' + c.connects);
  const kinds = c.events.map((e) => e.kind);
  console.log('  event sequence                : ' + (kinds.length > 12 ? kinds.slice(0, 12).join(' -> ') + ' -> ...' : kinds.join(' -> ')));
  const looped = c.connects > 2;
  console.log('  verdict                       : ' + (looped ? '*** RECONNECT LOOP ***' : 'stable (no loop)'));
  console.log('  timer pending at exit         : ' + (c.state.reconnectTimer ? 'yes (still looping)' : 'no'));
  console.log('');
  if (c.state.reconnectTimer) clearTimeout(c.state.reconnectTimer);
  if (c.state.sseReq) try { c.state.sseReq.destroy(); } catch (e) {}
  return looped;
}

// Baseline: a single connect must be stable (server holds streams open).
const loopA = await scenario('SCENARIO 1: connectSSE() called ONCE', 1, 9000);
// The bug: a second connect while the first stream is live.
const loopB = await scenario('SCENARIO 2: connectSSE() called TWICE', 2, 13000);

console.log('=== CONCLUSION ===');
console.log('single connect loops      : ' + loopA);
console.log('double connect loops      : ' + loopB);
console.log('');
console.log('The server never ends the stream in either scenario, and this file uses');
console.log('no platform-specific API. So the loop is a pure client-side bookkeeping');
console.log('bug: connectSSE() destroying a LIVE stream fires res "error (aborted)",');
console.log('whose handler schedules the next reconnect -> self-sustaining 2.5s cycle.');

server.close();
process.exit(loopB && !loopA ? 0 : 1);
