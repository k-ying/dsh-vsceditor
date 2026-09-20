// control-trust-smoke.mjs — verifies the /state + /action trust fence:
//   unit: isTrustedControlRequest matrix (rebinding / cross-site / mutation /
//         socket origin / declared trusted hosts) + parseTrustedHosts
//   unit: ackRecord normalization (the panel's only evidence a diff opened)
//   unit: config invariants (schema keys == CONFIG_DEFAULTS keys)
//   integration: real HTTP requests against apply()'s registered routes
// (autoStart:false so no code-server is spawned)

import { createServer, request as httpRequest } from "node:http";
import { createRequire } from "node:module";

const plugin = createRequire(import.meta.url)("../lib/host.js");

const failed = [];
let checks = 0;
function check(cond, label) { checks++; if (!cond) failed.push(label); }

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

// ── unit: ack normalization ──
// The extension acks every edit frame; before this the host dropped the ack,
// so "did the diff actually open?" had no answer on the panel side.
const ack = plugin.ackRecord;
const ackOk = ack({ kind: "edit", path: "/w/a.md", follow: true, opened: true, timeout: false }, 1234);
check(ackOk.kind === "edit" && ackOk.path === "/w/a.md" && ackOk.opened === true && ackOk.timeout === false,
  "ack: a diff that opened is recorded as opened");
check(ackOk.at === 1234, "ack: injected clock is used (deterministic)");
const ackTimeout = ack({ kind: "edit", path: "/w/a.md", opened: false, timeout: true });
check(ackTimeout.opened === false && ackTimeout.timeout === true,
  "ack: 6s timeout recorded as NOT opened (acked must not read as shown)");
const ackDedup = ack({ kind: "edit", path: "/w/a.md", follow: true, dedup: true });
check(ackDedup.dedup === true && ackDedup.opened === false, "ack: dedup frame recorded, not counted as opened");
check(ack({ kind: "edit", path: "/w/a.md", follow: false }).follow === false, "ack: follow-off frame recorded as follow=false");
const ackErr = ack({ kind: "edit-error", path: "/w/a.md", error: "boom" });
check(ackErr.kind === "edit-error" && ackErr.error === "boom", "ack: edit-error keeps the message");
const ackEmpty = ack({});
check(ackEmpty.opened === false && ackEmpty.timeout === false && ackEmpty.follow === true,
  "ack: empty payload defaults to a benign, non-opened record");
check(ack(null).kind === "" && ack(undefined).path === "", "ack: null/undefined tolerated");
check(typeof ack({}).at === "number", "ack: timestamp defaults to now");

// ── unit: config invariants ──
// The control route's write whitelist iterates CONFIG_DEFAULTS, so a key that
// exists only in the schema is silently unwritable (and a key only in the
// defaults never reaches the settings card).
const schemaKeys = Object.keys(plugin.configSchema.dict).sort();
const defaultKeys = Object.keys(plugin.CONFIG_DEFAULTS).sort();
check(JSON.stringify(schemaKeys) === JSON.stringify(defaultKeys),
  `schema keys == CONFIG_DEFAULTS keys (schema=[${schemaKeys.join(",")}] defaults=[${defaultKeys.join(",")}])`);
// There are three key lists (CONFIG_DEFAULTS, configSchema.dict, and the
// literal object normalizeConfig returns). A key missing from the third is
// silently dropped from every read path: the setting saves and never takes
// effect. Assert normalization emits exactly the declared key set.
const normalizedKeys = Object.keys(plugin.configSchema({})).sort();
check(JSON.stringify(normalizedKeys) === JSON.stringify(defaultKeys),
  `normalizeConfig emits every declared key (normalized=[${normalizedKeys.join(",")}] defaults=[${defaultKeys.join(",")}])`);
check(plugin.CONFIG_DEFAULTS.bridgeDebug === false, "bridgeDebug defaults to off");
check(plugin.configSchema({}).bridgeDebug === false, "bridgeDebug falls back to the default");
check(plugin.configSchema({ bridgeDebug: true }).bridgeDebug === true, "bridgeDebug round-trips through the schema");
let bridgeDebugRejected = false;
try { plugin.configSchema({ bridgeDebug: "yes" }); } catch (e) { bridgeDebugRejected = true; }
check(bridgeDebugRejected, "bridgeDebug rejects a non-boolean");

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
console.log(`CONTROL TRUST SMOKE PASSED (${checks} checks)`);
