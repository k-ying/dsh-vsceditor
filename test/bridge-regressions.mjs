// bridge-regressions.mjs — regression coverage for the two defects found during
// the Windows real-machine verification (docs/windows-verification-report.md §5).
//
// Both defects PRE-EXISTED on main and are platform-independent; neither came
// from the Windows path fixes. They were untestable before because the code they
// live in was not reachable from a test — `connectSSE()` was not exported and the
// dedup key was computed by an unexported helper. This file drives the REAL
// extension (stubbed `vscode`, no platform forcing) and asserts:
//
//   A. connectSSE() superseding a LIVE stream must not schedule a reconnect.
//      Old behaviour: the superseded stream's `error: aborted` called
//      scheduleReconnect() -> 2500ms later connectSSE() destroyed the stream that
//      was then live -> `error: aborted` -> ... a self-sustaining 2.5s loop
//      (reproduced by docs/evidence/probes/sse-loop-repro.mjs and observed on the
//      Windows machine). This test needs a REAL http server: the loop only exists
//      because destroying a live response emits an `error` event.
//   B. The edit-frame dedup must compare the frame exactly. Old behaviour hashed
//      with `for (i = 0; i < t.length; i += 97)`, which runs the loop body ONCE for
//      any text shorter than 97 chars — so the key degenerated to
//      path + length + first character, and two DIFFERENT edits of equal length
//      and first character ("15-40" vs "15-50") were treated as one frame.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import Module, { createRequire } from "node:module";

const failed = [];
let checks = 0;
function check(cond, label) { checks++; if (!cond) failed.push(label); }
// A value that is safe to print: state.reconnectTimer is a Timeout object with
// circular internals, so JSON.stringify must not be handed arbitrary values.
function show(v) {
  if (typeof v === "string") return JSON.stringify(v);
  if (v === null || typeof v !== "object") return String(v);
  try { return JSON.stringify(v); } catch (e) { return Object.prototype.toString.call(v); }
}
function eq(actual, expected, label) {
  checks++;
  if (actual !== expected) failed.push(`${label} (expected ${show(expected)}, got ${show(actual)})`);
}

// ── isolate side effects: the extension logs under os.homedir() ──
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-bridge-reg-"));
process.env.HOME = tmpHome;
delete process.env.DSH_BRIDGE_DEBUG;
delete process.env.DSH_BRIDGE_EVENTS;
delete process.env.DSH_BRIDGE_URL;

// ── minimal `vscode` stub (same shape windows-sim.mjs uses) ──
class StubEventEmitter {
  constructor() {
    this._listeners = new Set();
    this.event = (fn) => { this._listeners.add(fn); return { dispose: () => this._listeners.delete(fn) }; };
  }
  fire(v) { for (const fn of Array.from(this._listeners)) { try { fn(v); } catch (e) {} } }
  dispose() { this._listeners.clear(); }
}

const diffCalls = [];
const providers = [];
const vscodeStub = {
  EventEmitter: StubEventEmitter,
  env: { language: "en" },
  Uri: {
    parse(s) {
      const m = /^([a-zA-Z][\w+.-]*):\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?/.exec(s) || [];
      return { scheme: m[1] || "", authority: m[2] || "", path: m[3] || "", query: m[4] || "", toString: () => s };
    },
    file: (p) => ({ scheme: "file", fsPath: p, path: p, toString: () => "file://" + p }),
  },
  Position: class { constructor(line, ch) { this.line = line; this.character = ch; } },
  Range: class { constructor(a, b) { this.start = a; this.end = b; } },
  Selection: class { constructor(a, b) { this.start = a; this.end = b; } },
  WorkspaceEdit: class { replace() {} },
  TextEditorRevealType: { InCenter: 0 },
  StatusBarAlignment: { Left: 1 },
  TabInputTextDiff: class {},
  commands: {
    executeCommand(cmd, ...args) { if (cmd === "vscode.diff") diffCalls.push(args); return Promise.resolve(); },
    registerCommand() { return { dispose() {} }; },
  },
  window: {
    state: { focused: true },
    visibleTextEditors: [],
    activeTextEditor: undefined,
    tabGroups: { all: [], close() {} },
    createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {}, text: "", tooltip: "" }),
    onDidChangeActiveTextEditor: () => ({ dispose() {} }),
    showInformationMessage: () => Promise.resolve(undefined),
    showWarningMessage: () => Promise.resolve(undefined),
    showQuickPick: () => Promise.resolve(undefined),
    showTextDocument: () => Promise.resolve({ revealRange() {}, selection: null }),
    setStatusBarMessage: () => {},
  },
  workspace: {
    // No folder on purpose: the dedup path below only needs an absolute path,
    // and leaving the list empty keeps this test platform-independent.
    workspaceFolders: [],
    isTrusted: true,
    registerTextDocumentContentProvider(scheme, provider) { providers[scheme] = provider; return { dispose() {} }; },
    onDidOpenTextDocument: () => ({ dispose() {} }),
    onDidChangeTextDocument: () => ({ dispose() {} }),
    onDidSaveTextDocument: () => ({ dispose() {} }),
    onDidGrantWorkspaceTrust: () => ({ dispose() {} }),
    onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
    applyEdit: () => Promise.resolve(true),
    openTextDocument: (uri) => Promise.resolve({ uri, getText: () => "", lineCount: 1, positionAt: () => ({}) }),
  },
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "vscode") return vscodeStub;
  return origLoad.call(this, request, parent, isMain);
};

const require = createRequire(import.meta.url);
const ext = require("../vscode-ext/dsh-bridge/extension.js");
const T = ext.__test;
const SETTLE = () => new Promise((r) => setTimeout(r, 80));

// activate() registers the virtual-document providers used by openDiff.
ext.activate({ subscriptions: [] });
// activate() also called connectSSE() with no bridge configured, so a discovery
// retry is already pending. Every phase below drives connections itself.
T.clearReconnectTimer();
check(!!providers["dsh-snap"] && !!providers["dsh-now"], "activate registers both virtual schemes");

// ═══════════════════════════════════════════════════════════════════════
// B — dedup must compare the frame exactly, not a sampled hash
// ═══════════════════════════════════════════════════════════════════════
// embedded mode: no workspace matching, and isTrusted() short-circuits to true,
// so edit frames are processed without a desktop window.
T.bridge.mode = "embedded";
const FILE = "/proj/cache.txt";

T.handleMessage({ type: "edit", path: FILE, oldText: "5-30", newText: "15-40" });
await SETTLE();
eq(diffCalls.length, 1, "B: the first edit frame opens a diff");

// The exact shape that used to collide: equal length, equal first character,
// different content. Old key was path|5|49 for both -> the second was skipped.
T.handleMessage({ type: "edit", path: FILE, oldText: "5-30", newText: "15-50" });
await SETTLE();
eq(diffCalls.length, 2, "B: a different frame of equal length and first character is NOT deduped");

// ...and a slightly longer one, to pin the "length made them distinct by luck" case.
T.handleMessage({ type: "edit", path: FILE, oldText: "5-30", newText: "15-500" });
await SETTLE();
eq(diffCalls.length, 3, "B: a longer frame is not deduped either");

// The true positive this dedup exists for must still hold: the SAME frame
// delivered twice (SSE reconnect, multi-path delivery) is skipped.
T.handleMessage({ type: "edit", path: FILE, oldText: "5-30", newText: "15-500" });
await SETTLE();
eq(diffCalls.length, 3, "B: an identical re-delivered frame IS deduped");

// A new turn makes the next frame new again even if its content repeats.
T.handleMessage({ type: "turn" });
T.handleMessage({ type: "edit", path: FILE, oldText: "5-30", newText: "15-500" });
await SETTLE();
eq(diffCalls.length, 4, "B: a turn boundary resets the dedup window");

// Unit level, on the helpers the handler uses. These are the pairs the old
// sampled hash conflated (each was printed as COLLIDE by
// docs/evidence/probes/dedup-key-collision.mjs).
T.rememberEditFrame("/proj/src.lua", "local M = {}");
check(T.isSameEditFrame("/proj/src.lua", "local M = {}") === true, "B: the identical frame is recognized");
check(T.isSameEditFrame("/proj/src.lua", "local N = {}") === false, "B: 'local M = {}' vs 'local N = {}' not conflated");
T.rememberEditFrame("/proj/src.lua", "x = 1");
check(T.isSameEditFrame("/proj/src.lua", "x = 2") === false, "B: 'x = 1' vs 'x = 2' not conflated");
check(T.isSameEditFrame("/proj/other.lua", "x = 1") === false, "B: same text on a different path is not conflated");
check(T.isSameEditFrame("/proj/src.lua", undefined) === false, "B: a frame without newText is never deduped");

// ═══════════════════════════════════════════════════════════════════════
// A — a superseded SSE stream must not schedule a reconnect
// ═══════════════════════════════════════════════════════════════════════
// Backoff bookkeeping first (no network): discovery retries keep the 2.5s floor
// because bridge.json appearing can only be noticed by polling, while repeated
// failures against a known endpoint back off.
T.state.reconnectDelay = 0;
T.scheduleReconnect(false);
eq(T.state.reconnectDelay, T.RECONNECT_MIN_MS * 2, "A: an endpoint failure starts backing off");
T.clearReconnectTimer();
T.scheduleReconnect(false);
eq(T.state.reconnectDelay, T.RECONNECT_MIN_MS * 4, "A: consecutive endpoint failures keep doubling");
T.clearReconnectTimer();
T.scheduleReconnect(true);
eq(T.state.reconnectDelay, 0, "A: discovery retries stay at the floor (no slow bridge.json pickup)");
T.clearReconnectTimer();
T.state.reconnectDelay = T.RECONNECT_MAX_MS * 4; // force past the cap
T.scheduleReconnect(false);
eq(T.state.reconnectDelay, T.RECONNECT_MAX_MS, "A: backoff is capped");
T.clearReconnectTimer();
T.state.reconnectDelay = 0;

// A server that holds every stream open and never ends it, like lib/host.js does.
let established = 0;
const clients = new Set();
const server = http.createServer((req, res) => {
  if (!req.url.startsWith("/events")) { res.writeHead(404); res.end(); return; }
  established++;
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  res.write(": dsh-vsceditor\n\n");
  clients.add(res);
  res.write("data: " + JSON.stringify({ type: "hello", follow: true, locked: [] }) + "\n\n");
  req.on("close", () => clients.delete(res));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

// envBridge() makes this mode 'embedded' with no workspace, so workspaceMatches()
// passes without a window; only the events URL matters here.
process.env.DSH_BRIDGE_EVENTS = `http://127.0.0.1:${port}/events`;
process.env.DSH_BRIDGE_TOKEN = "regression-token";

// Two connectSSE() calls back to back: exactly the shape produced by
// activate() + onDidGrantWorkspaceTrust() / onDidChangeWorkspaceFolders(), and the
// entry point of the loop. The second call must supersede the first cleanly.
T.connectSSE();
await SETTLE();
check(T.state.connected === true, "A: the first call establishes a live stream");
T.connectSSE();
await SETTLE();
eq(established, 2, "A: the second call establishes its own stream");
check(T.state.connected === true, "A: superseding leaves the new stream connected");

// With the loop present this window (2.5s apart) would add a 3rd connection at
// ~2.5s and a 4th at ~5s. 7s gives three chances to observe it.
await new Promise((r) => setTimeout(r, 7000));
eq(established, 2, "A: the superseded stream does NOT schedule a reconnect (no self-sustaining 2.5s loop)");
check(T.state.reconnectTimer === null, "A: no reconnect timer left pending");
check(T.state.connected === true, "A: still connected after 7s (the stream was not torn down)");

// ── teardown ──
try { if (T.state.sseReq) T.state.sseReq.destroy(); } catch (e) {}
ext.deactivate();
for (const res of clients) { try { res.end(); } catch (e) {} }
server.close();
try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch (e) {}

if (failed.length > 0) {
  for (const item of failed) console.log("FAIL:", item);
  console.log("BRIDGE REGRESSIONS FAILED");
  process.exit(1);
}
console.log(`BRIDGE REGRESSIONS PASSED (${checks} checks)`);
process.exit(0);
