// Measure how long the bridge SSE stream actually stays open.
//
// Context: C:\tmp\dsh-bridge-debug.log shows `recv: hello` every ~2.5s, and
// bridge-ext.log shows an endless "SSE 流错误：aborted" -> "SSE 已连接" loop.
// 2.5s is exactly extension.js's scheduleReconnect() delay, which implies the
// stream is torn down almost immediately after it opens. This script connects
// as a second SSE client and times the connection lifetime directly.

import fs from 'node:fs';
import http from 'node:http';

const bridge = JSON.parse(fs.readFileSync(process.env.USERPROFILE + '\\.dsh-editor\\bridge.json', 'utf8'));
const u = new URL(bridge.events);
u.search = (u.search ? u.search + '&' : '?') + 'token=' + encodeURIComponent(bridge.token);

console.log('events   :', bridge.events);
console.log('workspace:', bridge.workspace);
console.log('connecting...\n');

const t0 = Date.now();
const el = () => String(Date.now() - t0).padStart(6) + 'ms';

const req = http.get(
  { hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers: { accept: 'text/event-stream' } },
  (res) => {
    console.log(el(), 'HTTP', res.statusCode, res.headers['content-type']);
    if (res.statusCode !== 200) { res.resume(); return; }
    let frames = 0;
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      for (const line of chunk.split('\n')) {
        if (line.startsWith('data:')) {
          frames++;
          let kind = '?';
          try { kind = JSON.parse(line.slice(5).trim()).type; } catch {}
          console.log(el(), 'FRAME', kind);
        }
      }
    });
    res.on('end', () => console.log(el(), '*** stream ENDED after', Date.now() - t0, 'ms |', frames, 'data frames'));
    res.on('error', (e) => console.log(el(), '*** stream ERROR:', e.message, '|', frames, 'data frames'));
  }
);
req.on('error', (e) => console.log(el(), '*** request ERROR:', e.message));

setTimeout(() => {
  console.log('\n--- 30s elapsed; still open means the server holds streams fine ---');
  req.destroy();
  process.exit(0);
}, 30000);
