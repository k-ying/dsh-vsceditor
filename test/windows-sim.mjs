// windows-sim.mjs — reproduces the Windows desktop-mode reports (issues #4/#5/#6)
// on any machine, by forcing win32 path semantics and loading the REAL extension
// against a stubbed `vscode`.
//
// Why this exists: all three reports are Windows + `editorBackend: local`, which
// is exactly the combination a macOS/Linux contributor cannot run. The causes are
// three different mistakes about paths, so instead of re-implementing the logic
// here (which would only test the test), this harness:
//   * overrides process.platform to win32 — paths.js picks path.win32 from it,
//   * bakes a win32 workspace into a stubbed VS Code,
//   * requires vscode-ext/dsh-bridge/extension.js unmodified with that stub,
//   * drives handleMessage() with the paths from the reports.
//
// What it can and cannot prove: path semantics, the URI scheme handed to
// vscode.diff, and provider content are all reproduced faithfully. Actual VS Code
// rendering (a real diff tab, a real TextDocument cache, the tab title) still
// needs a Windows/desktop pass — see docs/windows-path-issues.md.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Module, { createRequire } from "node:module";

const failed = [];
let checks = 0;
function check(cond, label) { checks++; if (!cond) failed.push(label); }
function eq(actual, expected, label) {
  checks++;
  if (actual !== expected) failed.push(`${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

// ── isolate side effects: the extension writes its log under os.homedir() ──
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-win-sim-"));
process.env.HOME = tmpHome;
delete process.env.DSH_BRIDGE_DEBUG;
delete process.env.DSH_BRIDGE_EVENTS;

// ── force win32 ──
// paths.js reads process.platform; the platform-bound default `path` export does
// NOT follow it, which is the whole reason paths.js resolves path.win32 itself.
const realPlatform = process.platform;
Object.defineProperty(process, "platform", { value: "win32", configurable: true });

// ── stub `vscode` ──
class StubEventEmitter {
  constructor() {
    this._listeners = new Set();
    this.event = (fn) => { this._listeners.add(fn); return { dispose: () => this._listeners.delete(fn) }; };
  }
  fire(v) { for (const fn of Array.from(this._listeners)) { try { fn(v); } catch (e) {} } }
  dispose() { this._listeners.clear(); }
}

const diffCalls = [];
const providers = {};
const fileUriCalls = [];

const vscodeStub = {
  EventEmitter: StubEventEmitter,
  env: { language: "en" },
  Uri: {
    parse(s) {
      const m = /^([a-zA-Z][\w+.-]*):\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?/.exec(s) || [];
      return { scheme: m[1] || "", authority: m[2] || "", path: m[3] || "", query: m[4] || "", toString: () => s };
    },
    file(p) { fileUriCalls.push(p); return { scheme: "file", fsPath: p, path: p, toString: () => "file://" + p }; },
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
    // The Windows desktop case from the reports: VS Code reports a capitalised
    // drive letter, DSH's cwd used a lower-case one.
    workspaceFolders: [{ uri: { scheme: "file", fsPath: "E:\\projects\\demo", toString: () => "file:///E:/projects/demo" } }],
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
const P = require("../vscode-ext/dsh-bridge/paths.js");
const host = require("../lib/host.js");

const T = ext.__test;
const SETTLE = () => new Promise((r) => setTimeout(r, 80));

// Bring up the real activate(): this is what registers the two virtual-document
// providers, and a missing 'dsh-now' registration would silently break every
// diff, so it is checked rather than assumed. activate() also calls connectSSE(),
// which re-resolves the bridge from the (empty) temp home and parks at mode
// 'none' — so the windows below are configured AFTER activate.
ext.activate({ subscriptions: [] });
check(!!providers["dsh-snap"] && !!providers["dsh-now"],
      "#6 activate registers BOTH virtual schemes (dsh-snap left, dsh-now right)");

// ═══════════════════════════════════════════════════════════════════════
// #4 — workspace matching must survive a drive-letter case difference
// ═══════════════════════════════════════════════════════════════════════
T.bridge.mode = "desktop";
T.bridge.workspace = "e:\\projects\\demo"; // DSH cwd spelling
check(T.workspaceMatches() === true, "#4 workspaceMatches: lower-case drive from DSH matches upper-case VS Code folder");
T.bridge.workspace = "E:\\projects\\demo\\"; // trailing separator
check(T.workspaceMatches() === true, "#4 workspaceMatches: trailing separator ignored");
T.bridge.workspace = "e:/projects/demo"; // forward slashes
check(T.workspaceMatches() === true, "#4 workspaceMatches: separator style ignored");
T.bridge.workspace = "e:\\projects\\other";
check(T.workspaceMatches() === false, "#4 workspaceMatches: a genuinely different folder still rejected");
T.bridge.workspace = "e:\\projects\\demo";
// POSIX stays case-sensitive: the window below really is a different path there.
check(P.sameFsPath("/srv/Proj", "/srv/proj", "linux") === false, "#4 sameFsPath stays case-sensitive on linux");
check(P.sameFsPath("E:\\Proj", "e:\\proj", "win32") === true, "#4 sameFsPath is case-insensitive on win32");
check(T.workspaceMatches() === true, "#4 workspaceMatches restored for the edit scenarios");

// ═══════════════════════════════════════════════════════════════════════
// #5 — a workspace-relative agent path must become an absolute one
// ═══════════════════════════════════════════════════════════════════════
eq(P.resolveEditPath("Tdata\\config.lua", "E:\\projects\\demo", "win32"),
   "E:\\projects\\demo\\Tdata\\config.lua", "#5 paths.resolveEditPath: relative resolved against the workspace root");
eq(P.resolveEditPath("E:\\projects\\demo\\Tdata\\config.lua", "X:\\elsewhere", "win32"),
   "E:\\projects\\demo\\Tdata\\config.lua", "#5 paths.resolveEditPath: absolute left alone");
// No root must NOT invent an absolute path (a wrong absolute path fails confusingly).
eq(P.resolveEditPath("Tdata\\config.lua", "", "win32"), "Tdata\\config.lua", "#5 paths.resolveEditPath: no root stays relative");

// The host half is where the relative path actually entered the system.
eq(host.resolveEditPath("Tdata\\config.lua", "E:\\projects\\demo", "win32"),
   "E:\\projects\\demo\\Tdata\\config.lua", "#5 host.resolveEditPath: agent-relative path resolved (win32)");
eq(host.resolveEditPath("Tdata/config.lua", "/home/u/proj", "posix"),
   "/home/u/proj/Tdata/config.lua", "#5 host.resolveEditPath: agent-relative path resolved (posix)");
eq(host.resolveEditPath("E:\\projects\\demo\\a.lua", "X:\\other", "win32"),
   "E:\\projects\\demo\\a.lua", "#5 host.resolveEditPath: absolute untouched");
eq(host.resolveEditPath("", "/root", "posix"), undefined, "#5 host.resolveEditPath: empty -> undefined");
eq(host.resolveEditPath(null, "/root", "posix"), undefined, "#5 host.resolveEditPath: non-string -> undefined");

// followWorkspaceOnly containment: the old prefix test was case-sensitive, so a
// file inside the workspace was skipped as "outside" when the drive case differed.
check(host.isInsideOrEqualPath("E:\\projects\\demo\\Tdata\\x.lua", "e:\\projects\\demo", "win32") === true,
      "#5 followWorkspaceOnly: file inside the workspace recognized despite drive-letter case");
check(host.isInsideOrEqualPath("e:/projects/demo/Tdata/x.lua", "E:\\projects\\demo\\", "win32") === true,
      "#5 followWorkspaceOnly: separator style and root trailing separator tolerated");
check(host.isInsideOrEqualPath("E:\\projects\\demo", "e:\\projects\\demo", "win32") === true,
      "#5 followWorkspaceOnly: the root itself counts as inside");
check(host.isInsideOrEqualPath("E:\\projects\\demo2\\x.lua", "e:\\projects\\demo", "win32") === false,
      "#5 followWorkspaceOnly: a sibling directory sharing the prefix is NOT inside");
check(host.isInsideOrEqualPath("/srv/Proj/a.lua", "/srv/proj", "linux") === false,
      "#5 followWorkspaceOnly: case-sensitive on linux");
check(host.isInsideOrEqualPath("/srv/proj/sub/a.lua", "/srv/proj", "posix") === true,
      "#5 followWorkspaceOnly: posix containment still works");

// The old symptom was literally `\Tdata\x.lua`; appending the root is what fixes
// it, so assert the mangled shape is gone.
check(host.resolveEditPath("Tdata\\config.lua", "E:\\projects\\demo", "win32").startsWith("E:\\"),
      "#5 resolved path carries a drive letter (was `\\Tdata\\...`)");

// Same-family bugs found while fixing #5: split('/') never splits a win32 path.
eq(P.baseName("E:\\projects\\demo\\Tdata\\帮派任务配置表.lua"), "帮派任务配置表.lua", "#5 baseName: backslash basename");
eq(P.baseName("/home/u/proj/a.lua"), "a.lua", "#5 baseName: posix basename");
check(P.encodePath("E:\\projects\\demo\\Tdata\\config.lua").split("/").length === 6,
      "#5 encodePath: win32 path keeps its segments (was one %5C blob)");
eq(P.stripTrailingSeparators("C:\\"), "C:\\", "#5 drive root not stripped to `C:`");
eq(P.stripTrailingSeparators("E:\\projects\\demo\\\\"), "E:\\projects\\demo", "#5 redundant separators stripped");

// Canonicalization is what keeps one diff entry per file: both spellings of the
// same file must collapse onto VS Code's own casing.
eq(P.canonicalizeUnder("e:\\projects\\demo\\Tdata\\x.lua", ["E:\\projects\\demo"], "win32"),
   "E:\\projects\\demo\\Tdata\\x.lua", "#5 canonicalizeUnder adopts the workspace folder's drive casing");
eq(P.canonicalizeUnder("e:/projects/demo", ["E:\\projects\\demo"], "win32"),
   "E:\\projects\\demo", "#5 canonicalizeUnder rewrites the root itself");
eq(P.canonicalizeUnder("D:\\elsewhere\\x.lua", ["E:\\projects\\demo"], "win32"),
   "D:\\elsewhere\\x.lua", "#5 canonicalizeUnder leaves paths outside every root alone");
eq(P.canonicalizeUnder("/srv/proj/a.lua", ["/srv/other"], "linux"), "/srv/proj/a.lua",
   "#5 canonicalizeUnder is a no-op outside the roots on posix");

// ═══════════════════════════════════════════════════════════════════════
// #5 (extension half) — lock keys agree whether spelled relative or absolute
// ═══════════════════════════════════════════════════════════════════════
T.state.locked.clear();
T.handleMessage({ type: "lock", path: "Tdata\\config.lua" });
check(T.state.locked.has(T.pathKeyOf("E:\\projects\\demo\\Tdata\\config.lua")),
      "#5 lock: relative frame locks the file, matched through VS Code's drive-letter casing");
T.handleMessage({ type: "unlock", path: "E:\\projects\\demo\\Tdata\\config.lua" });
check(T.state.locked.size === 0, "#5 unlock: absolute frame released the same key (no orphan lock)");
T.handleMessage({ type: "hello", follow: true, locked: ["Tdata\\config.lua", "E:\\projects\\demo\\other.lua"] });
check(T.state.locked.has(T.pathKeyOf("e:/projects/demo/Tdata/config.lua")) && T.state.locked.has(T.pathKeyOf("E:\\projects\\demo\\other.lua")),
      "#5 hello: locked list normalized (mixed spellings)");
T.state.locked.clear();

// The consequence that actually bites a user: `isProtected` is called with
// doc.uri.fsPath (VS Code's casing), so a lock recorded from a frame must still
// match. This is the defect the first run of this harness caught.
T.state.follow = false;
T.handleMessage({ type: "lock", path: "Tdata\\config.lua" });
check(T.isProtected("E:\\projects\\demo\\Tdata\\config.lua") === true,
      "#5 protection: locked file is still protected under VS Code's casing");
check(T.isProtected("e:/projects/demo/Tdata/config.lua") === true,
      "#5 protection: and under a forward-slash spelling");
T.handleMessage({ type: "unlock", path: "e:\\PROJECTS\\DEMO\\tdata\\config.lua" });
check(T.isProtected("E:\\projects\\demo\\Tdata\\config.lua") === false,
      "#5 protection: unlock releases it from any spelling");
T.state.follow = true;
T.state.locked.clear();

// ═══════════════════════════════════════════════════════════════════════
// #6 — the diff's right side must not come from a `file:` TextDocument
// ═══════════════════════════════════════════════════════════════════════
diffCalls.length = 0;
fileUriCalls.length = 0;
T.handleMessage({ type: "edit", path: "Tdata\\config.lua", oldText: "5-15", newText: "15-25", firstLine: 0 });
await SETTLE();

eq(diffCalls.length, 1, "#6 exactly one vscode.diff call");
if (diffCalls.length === 1) {
  const [left, right, title] = diffCalls[0];
  eq(left.scheme, "dsh-snap", "#6 left side is the dsh-snap baseline");
  eq(right.scheme, "dsh-now", "#6 right side is a virtual dsh-now document (NOT file:)");
  check(right.scheme !== "file", "#6 right side no longer routes through vscode.Uri.file()");
  check(String(title).indexOf("config.lua") !== -1, "#6 diff title carries the file NAME");
  check(String(title).indexOf("\\") === -1, "#6 diff title does not leak the whole win32 path");
}

// Content is served from the providers, keyed by the extension's own resolution
// of the frame's path (T.normPath is that same code path).
const key = T.normPath("Tdata\\config.lua");
eq(providers["dsh-snap"].provideTextDocumentContent({ query: encodeURIComponent(key) }), "5-15",
   "#6 left provider returns the pre-edit baseline");
eq(providers["dsh-now"].provideTextDocumentContent({ query: encodeURIComponent(key) }), "15-25",
   "#6 right provider returns the host's post-edit disk read");
check(fileUriCalls.length === 0, "#6 no file: URI was ever built for the diff (the stale-cache path is gone)");

// The reported symptom: content on disk is 15-25 while an already-open tab still
// holds 5-15. The right side must show 15-25 regardless of any open document.
const staleTabText = "5-15";
check(providers["dsh-now"].provideTextDocumentContent({ query: encodeURIComponent(key) }) !== staleTabText,
      "#6 right side differs from a stale open-tab cache");

// Re-edit the same file within the turn: baseline stays, right side advances, and
// the already-open diff is refreshed in place via the provider event.
let refreshed = 0;
providers["dsh-now"].onDidChange(() => { refreshed++; });
T.handleMessage({ type: "edit", path: "E:\\projects\\demo\\Tdata\\config.lua", oldText: "5-15", newText: "15-30" });
await SETTLE();
eq(providers["dsh-snap"].provideTextDocumentContent({ query: encodeURIComponent(key) }), "5-15",
   "#6 turn baseline preserved across a second edit (cumulative diff)");
eq(providers["dsh-now"].provideTextDocumentContent({ query: encodeURIComponent(key) }), "15-30",
   "#6 right side advanced with the disk content");
check(refreshed > 0, "#6 an open diff is refreshed in place, not left stale");

// A new turn clears both sides, so the next turn shows only its own changes.
T.handleMessage({ type: "turn" });
eq(providers["dsh-now"].provideTextDocumentContent({ query: encodeURIComponent(key) }), "",
   "#6 turn reset clears the right side");
eq(providers["dsh-snap"].provideTextDocumentContent({ query: encodeURIComponent(key) }), "",
   "#6 turn reset clears the left side");

// ═══════════════════════════════════════════════════════════════════════
Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
ext.deactivate();
try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch (e) {}

if (failed.length > 0) {
  for (const item of failed) console.log("FAIL:", item);
  console.log("WINDOWS SIM FAILED");
  process.exit(1);
}
console.log(`WINDOWS SIM PASSED (${checks} checks)`);
process.exit(0);
