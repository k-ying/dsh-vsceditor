// control-trust-smoke.mjs — verifies the /state + /action trust fence:
//   unit: isTrustedControlRequest matrix (rebinding / cross-site / mutation /
//         socket origin / declared trusted hosts) + parseTrustedHosts
//   integration: real HTTP requests against apply()'s registered routes
// (autoStart:false so no code-server is spawned)

import { createServer, request as httpRequest } from "node:http";
import { createRequire } from "node:module";

const plugin = createRequire(import.meta.url)("../lib/host.js");

const failed = [];
function check(cond, label) { if (!cond) failed.push(label); }

// ── unit: gate matrix ──
const gate = plugin.isTrustedControlRequest;
const parse = plugin.parseTrustedHosts;
// A browser on this machine: loopback socket, reached over 127.0.0.1.
const LOCAL_SOCKET = { remoteAddress: "127.0.0.1", localAddress: "127.0.0.1" };
const req = (headers, socket = LOCAL_SOCKET) => ({ headers, socket });

check(gate(req({ host: "127.0.0.1:3080" })) === true, "loopback GET (no origin) allowed");
check(gate(req({ host: "localhost:3080" })) === true, "localhost GET allowed");
check(gate(req({ host: "[::1]:3080" })) === true, "IPv6 loopback GET allowed");
check(gate(req({ host: "[::ffff:7f00:1]:3080" })) === true, "IPv4-mapped IPv6 loopback allowed (bracketed form)");
check(gate(req({ host: "127.0.0.1:3080" }, { remoteAddress: "::1", localAddress: "::1" })) === true, "IPv6 loopback socket allowed");
check(gate(req({ host: "192.168.1.5:3080", origin: "http://192.168.1.5:3080" },
  { remoteAddress: "127.0.0.1", localAddress: "192.168.1.5" })) === true, "same-machine LAN-IP access (loopback socket, host == local address) allowed");
check(gate(req({ host: "127.0.0.1:3080" }), true) === false, "POST without Origin rejected (non-browser local script)");
check(gate(req({ host: "127.0.0.1:3080", origin: "http://127.0.0.1:3080" }), true) === true, "POST with matching Origin allowed");
check(gate(req({ host: "evil.example:3080", origin: "http://evil.example:3080" })) === false, "DNS-rebinding domain Host rejected (even with matching Origin)");
check(gate(req({ host: "evil.example:3080" })) === false, "domain Host without Origin rejected");
check(gate(req({ host: "127.0.0.1:3080", "sec-fetch-site": "cross-site" })) === false, "sec-fetch-site cross-site rejected");
check(gate(req({ host: "127.0.0.1:3080", origin: "http://evil.example" })) === false, "mismatched Origin rejected");
check(gate(req({})) === false, "missing Host rejected");
check(gate(req({ host: "deadbeef:3080" })) === false, "bare hex word is not an IP literal");

// A LAN peer can forge Host and Origin — only a declared authority may speak
// for a non-loopback socket, and a forged loopback Host must not pass.
const LAN_SOCKET = { remoteAddress: "192.168.1.9", localAddress: "192.168.1.5" };
check(gate(req({ host: "127.0.0.1:3080", origin: "http://127.0.0.1:3080" }, LAN_SOCKET)) === false,
  "remote socket forging a loopback Host rejected");
check(gate(req({ host: "192.168.1.5:3080", origin: "http://192.168.1.5:3080" }, LAN_SOCKET)) === false,
  "remote socket with an undeclared LAN Host rejected");
check(gate(req({ host: "dsh.example.com:3080", origin: "http://dsh.example.com:3080" }, LAN_SOCKET), false, ["dsh.example.com"]) === true,
  "remote socket with a declared trusted host allowed");
check(gate(req({ host: "dsh.example.com:3080", origin: "http://dsh.example.com:3080" }), false, ["dsh.example.com"]) === true,
  "declared trusted host allowed from loopback");
check(gate(req({ host: "dsh.example.com:3080", origin: "http://dsh.example.com:3080" }, LAN_SOCKET), false, ["other.example.com"]) === false,
  "remote socket with an unrelated declared host rejected");
check(gate(req({ host: "dsh.example.com:3080", origin: "http://dsh.example.com:3080" }), false, ["dsh.example.com:9999"]) === false,
  "trusted entry with a different explicit port rejected");
check(gate(req({ host: "dsh.example.com:9999", origin: "http://dsh.example.com:9999" }), false, ["dsh.example.com:9999"]) === true,
  "trusted entry with a matching explicit port allowed");

// trustedHosts parsing: bare authorities only.
check(JSON.stringify(parse("")) === "[]", "empty trustedHosts parses to []");
check(JSON.stringify(parse("dsh.example.com, 192.168.1.5:61430")) === JSON.stringify(["dsh.example.com", "192.168.1.5:61430"]),
  "comma separated trustedHosts parsed");
check(JSON.stringify(parse("a.example.com a.example.com")) === JSON.stringify(["a.example.com"]), "duplicate entries collapse");
check(JSON.stringify(parse(["a.example.com", "b.example.com"])) === JSON.stringify(["a.example.com", "b.example.com"]),
  "array trustedHosts (composition config) accepted");
for (const bad of ["*", "*.example.com", "https://dsh.example.com", "dsh.example.com/path", "user@dsh.example.com"]) {
  let threw = false;
  try { parse(bad); } catch (e) { threw = true; }
  check(threw, `trustedHosts rejects ${JSON.stringify(bad)}`);
}

// ── integration: drive the real routes ──
const routes = [];
let dispose = null;
const ctx = {
  webServer: { port: 3999, register(route) { routes.push(route); return () => {}; } },
  subprocess: { async resolveExecutable() { throw new Error("nope"); }, spawn() { throw new Error("nope"); } },
  timer: { interval() { return () => {}; }, timeout() { return () => {}; } },
  timeout(fn) { fn(); return () => {}; },  interval() { return () => {}; },
  agents: undefined,
  get() { return undefined; },
  on() { return () => {}; },
  effect(fn) { const d = fn(); dispose = typeof d === "function" ? d : () => {}; return () => {}; },
  inject(names, cb) { /* settings not available in mock */ },
};

await plugin.apply(ctx, { autoStart: false, follow: false, trustedHosts: "dsh.example.com" });

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
const trustedState = await call("/__dsh-vsceditor/state", { host: "dsh.example.com" });
check(trustedState.status === 200, `declared trusted Host on /state -> 200 (got ${trustedState.status})`);
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
