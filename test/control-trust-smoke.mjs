// control-trust-smoke.mjs — verifies the /state + /action trust fence:
//   unit: isTrustedControlRequest matrix (rebinding / cross-site / mutation /
//         socket origin / declared trusted hosts) + parseTrustedHosts
//   unit: ackRecord normalization (the panel's only evidence a diff opened)
//   unit: config invariants (schema keys == CONFIG_DEFAULTS keys)
//   unit: manifest invariants (peer range admits every supported dsh build;
//         the client registers both the legacy and the 0.2+ settings slot)
//   unit: dsh-generation adapters (deployment trusted hosts come from
//         `webRuntime`; the plugin finds its own configurable profile entry)
//   integration: real HTTP requests against apply()'s registered routes
// (autoStart:false so no code-server is spawned)

import { readFileSync } from "node:fs";
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

// ── unit: manifest invariants ──
// dsh refuses to load a plugin whose `@deepseek-ai/dsh-*` peerDependencies do not
// admit the RUNNING version: dsh-app-boot evaluates every such entry with
// `semver.satisfies(runtimeVersion, range, { includePrerelease: true })` and
// reports "Plugin X is incompatible with dsh Y" (install rejected). With
// `includePrerelease`, that reduces to plain precedence comparison — the helpers
// below implement exactly that so the suite stays dependency-free.
// Regression: the range used to stop at `<0.2.0-0`, so every dsh 0.2.x build
// (including the 0.2.1-alpha.1 that ships with the desktop shell) was refused.
function parseVersion(text) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(text);
  if (!m) throw new Error(`unparsable version: ${text}`);
  return { parts: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split(".") : [] };
}
function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) if (a.parts[i] !== b.parts[i]) return a.parts[i] < b.parts[i] ? -1 : 1;
  if (a.pre.length === 0 || b.pre.length === 0) return a.pre.length === b.pre.length ? 0 : a.pre.length === 0 ? 1 : -1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i], y = b.pre[i];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const numericX = /^\d+$/.test(x), numericY = /^\d+$/.test(y);
    if (numericX && numericY) { if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1; }
    else if (numericX !== numericY) return numericX ? -1 : 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
function admits(range, version) {
  const v = parseVersion(version);
  return range.split("||").some((clause) => clause.trim().split(/\s+/).every((term) => {
    const m = /^(>=|<=|>|<|=)?(.+)$/.exec(term);
    const c = compareVersions(v, parseVersion(m[2]));
    return m[1] === ">=" ? c >= 0 : m[1] === ">" ? c > 0 : m[1] === "<=" ? c <= 0 : m[1] === "<" ? c < 0 : c === 0;
  }));
}
const declaredPeerRange = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
  .peerDependencies["@deepseek-ai/dsh-client-runtime"];
for (const supported of ["0.1.5-rc.1", "0.2.0-0", "0.2.0-rc.2", "0.2.1-alpha.1", "0.2.99"]) {
  check(admits(declaredPeerRange, supported), `peer range admits dsh ${supported} (range=${declaredPeerRange})`);
}
for (const unsupported of ["0.3.0-0", "0.3.0"]) {
  check(!admits(declaredPeerRange, unsupported), `peer range still rejects dsh ${unsupported}`);
}

// A client contribution aimed at a slot the host no longer declares is silently
// invisible (no error, no UI): 0.2.1 replaced `settings.plugin.item` with
// `settings.plugins.tab`. `slots.inject` on an undeclared slot just waits, so
// both registrations must stay — dropping either one breaks a shell generation.
const clientSource = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
check(clientSource.includes("inject('settings.plugins.tab'"), "client registers the 0.2+ settings tab slot");
check(clientSource.includes("inject('settings.plugin.item'"), "client keeps the legacy settings card slot");

// ── unit: dsh-generation adapters ──
// Both of these were SILENT failures in the field, which is why they are pinned
// here by name rather than by behaviour-of-the-whole-plugin.
// 1. The deployment's trusted-host list lives on the `webRuntime` service
//    (dsh-web-app provides { lanAddresses, trustedHosts }). The plugin used to
//    read `connection`, where the field has never existed — so the advertised
//    "union with DSH's own trustedHosts" was a no-op on every version.
const runtimeCtx = (value) => ({ get: (key) => (key === "webRuntime" ? value : undefined) });
check(plugin.deploymentTrustedHosts(runtimeCtx({ trustedHosts: ["a.example.com", " b.example.com "] })).join(",") === "a.example.com,b.example.com",
  "deploymentTrustedHosts reads webRuntime and trims entries");
check(plugin.deploymentTrustedHosts({ get: (key) => (key === "connection" ? { trustedHosts: ["wrong.example.com"] } : undefined) }).length === 0,
  "deploymentTrustedHosts does not read `connection` (the field is not there)");
check(plugin.deploymentTrustedHosts(runtimeCtx({})).length === 0, "deploymentTrustedHosts tolerates a service without the field");
check(plugin.deploymentTrustedHosts(runtimeCtx({ trustedHosts: "nope" })).length === 0, "deploymentTrustedHosts ignores a non-array list");
check(plugin.deploymentTrustedHosts({ get: () => { throw new Error("boom"); } }).length === 0, "deploymentTrustedHosts never throws");
check(plugin.deploymentTrustedHosts(undefined).length === 0, "deploymentTrustedHosts tolerates a missing ctx");

// 2. On dsh 0.2.x the settings namespace is gone, so the plugin persists through
//    its own profile entry — which it has to find among every configurable row.
const ownRows = [
  { options: { id: "include:other", name: "other-plugin" } },
  { options: { id: "include:vsceditor", name: "dsh-vsceditor" } },
];
check(plugin.pickOwnEntry(ownRows, "dsh-vsceditor") === ownRows[1], "pickOwnEntry matches the row by module name");
check(plugin.pickOwnEntry([{ options: { id: "include:vsceditor" } }], "dsh-vsceditor").options.id === "include:vsceditor",
  "pickOwnEntry falls back to the row id's final segment (namespaced + shortened)");
check(plugin.pickOwnEntry([{ options: { id: "vsceditor-fork" } }, { options: { id: "include:vsceditor" } }], "dsh-vsceditor").options.id === "include:vsceditor",
  "pickOwnEntry does not claim an unrelated id that merely contains the name");
check(plugin.pickOwnEntry([{ options: { name: "dsh-vsceditor" } }, { options: { id: "include:vsceditor" } }], "dsh-vsceditor").options.name === "dsh-vsceditor",
  "pickOwnEntry prefers the exact module name over the id fallback");
check(plugin.pickOwnEntry(ownRows, "absent-plugin") === undefined, "pickOwnEntry returns undefined when the plugin has no row");
check(plugin.pickOwnEntry(undefined, "dsh-vsceditor") === undefined, "pickOwnEntry tolerates a missing entry list");
check(plugin.configSchema.meta !== undefined && typeof plugin.configSchema.toJSON === "function",
  "the hand-rolled schema keeps the schemastery-compatible surface dsh reads");

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
