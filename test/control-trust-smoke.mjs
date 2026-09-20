// control-trust-smoke.mjs — verifies the /state + /action trust fence:
//   unit: isTrustedControlRequest matrix (rebinding / cross-site / mutation)
//   integration: real HTTP requests against apply()'s registered routes
// (autoStart:false so no code-server is spawned)

import { createServer, request as httpRequest } from "node:http";
import { createRequire } from "node:module";

const plugin = createRequire(import.meta.url)("../lib/host.js");

const failed = [];
function check(cond, label) { if (!cond) failed.push(label); }

// ── unit: gate matrix ──
const gate = plugin.isTrustedControlRequest;
const req = (headers) => ({ headers });

check(gate(req({ host: "127.0.0.1:3080" })) === true, "loopback GET (no origin) allowed");
check(gate(req({ host: "localhost:3080" })) === true, "localhost GET allowed");
check(gate(req({ host: "[::1]:3080" })) === true, "IPv6 loopback GET allowed");
check(gate(req({ host: "192.168.1.5:3080", origin: "http://192.168.1.5:3080" })) === true, "LAN IP literal + matching origin allowed");
check(gate(req({ host: "127.0.0.1:3080" }), true) === false, "POST without Origin rejected (non-browser local script)");
check(gate(req({ host: "127.0.0.1:3080", origin: "http://127.0.0.1:3080" }), true) === true, "POST with matching Origin allowed");
check(gate(req({ host: "evil.example:3080", origin: "http://evil.example:3080" })) === false, "DNS-rebinding domain Host rejected (even with matching Origin)");
check(gate(req({ host: "evil.example:3080" })) === false, "domain Host without Origin rejected");
check(gate(req({ host: "127.0.0.1:3080", "sec-fetch-site": "cross-site" })) === false, "sec-fetch-site cross-site rejected");
check(gate(req({ host: "127.0.0.1:3080", origin: "http://evil.example" })) === false, "mismatched Origin rejected");
check(gate(req({})) === false, "missing Host rejected");
check(gate(req({ host: "deadbeef:3080" })) === false, "bare hex word is not an IP literal");

// ── integration: drive the real routes ──
const routes = [];
let dispose = null;
const ctx = {
  webServer: { port: 3999, register(route) { routes.push(route); return () => {}; } },
  subprocess: { async resolveExecutable() { throw new Error("nope"); }, spawn() { throw new Error("nope"); } },
  timer: { interval() { return () => {}; }, timeout() { return () => {}; } },
  timeout(fn) { fn(); return () => {}; },  interval() { return () => {}; },
  agents: undefined,
  on() { return () => {}; },
  effect(fn) { const d = fn(); dispose = typeof d === "function" ? d : () => {}; return () => {}; },
  inject(names, cb) { /* settings not available in mock */ },
};

await plugin.apply(ctx, { autoStart: false, follow: false });

const stateRoute = routes.find((r) => r.path.endsWith("/state") || r.path === "/__dsh-vsceditor/state");
const actionRoute = routes.find((r) => r.path === "/__dsh-vsceditor/action");
check(stateRoute !== undefined, "state route registered");
check(actionRoute !== undefined, "action route registered");

const server = createServer((req, res) => {
  const route = req.url.startsWith("/__dsh-vsceditor/action") ? actionRoute : stateRoute;
  route.handler(req, res);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

function call(path, headers, body) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method: body === undefined ? "GET" : "POST", headers }, (res) => {
      let data = "";
      res.on("data", (c) => data += c);
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    if (body !== undefined) req.end(body); else req.end();
  });
}

const rebindingState = await call("/__dsh-vsceditor/state", { host: "evil.example:3080" });
check(rebindingState.status === 403, `rebinding Host on /state -> 403 (got ${rebindingState.status})`);
const okState = await call("/__dsh-vsceditor/state", { host: `127.0.0.1:${port}` });
check(okState.status === 200, `loopback /state -> 200 (got ${okState.status})`);
const noOriginAction = await call("/__dsh-vsceditor/action", { host: `127.0.0.1:${port}`, "content-type": "application/json" }, JSON.stringify({ action: "set-follow", enabled: true }));
check(noOriginAction.status === 403, `POST /action without Origin -> 403 (got ${noOriginAction.status})`);
const crossOriginAction = await call("/__dsh-vsceditor/action", { host: `127.0.0.1:${port}`, origin: "http://evil.example", "content-type": "application/json" }, JSON.stringify({ action: "set-follow", enabled: true }));
check(crossOriginAction.status === 403, `POST /action with mismatched Origin -> 403 (got ${crossOriginAction.status})`);
const okAction = await call("/__dsh-vsceditor/action", { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, "content-type": "application/json" }, JSON.stringify({ action: "set-follow", enabled: true }));
check(okAction.status === 200, `POST /action same-origin -> 200 (got ${okAction.status}: ${okAction.body.slice(0, 80)})`);

server.close();
if (dispose) dispose();

if (failed.length > 0) {
  for (const item of failed) console.log("FAIL:", item);
  console.log("CONTROL TRUST SMOKE FAILED");
  process.exit(1);
}
console.log("CONTROL TRUST SMOKE PASSED");
