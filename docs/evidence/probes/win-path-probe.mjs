// Real-Windows probe for the fix/windows-paths helpers in paths.js.
//
// Purpose: test/windows-sim.mjs INJECTS platform='win32' and stubs the filesystem.
// This probe does the opposite: it calls the REAL paths.js with the DEFAULT
// platform (process.platform === 'win32' on this box) and cross-checks every
// case-insensitivity assumption against the REAL NTFS.
//
// This targets one of the four gaps docs/windows-verification.md section 7 says
// the simulation cannot cover:
//   "Windows 文件系统的大小写不敏感是否与我们的假设一致"

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const SRC = 'C:/Users/apple/ai/work/dsh-vsceditor-fix-windows-paths/vscode-ext/dsh-bridge/paths.js';
const SRC_HOST = 'C:/Users/apple/ai/work/dsh-vsceditor-fix-windows-paths/lib/host.js';
const P = require(SRC);

let pass = 0, fail = 0;
const rows = [];
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? pass++ : fail++;
  rows.push({ ok, label, actual, expected });
}

const BASE = 'C:\\Users\\apple\\ai\\work\\probe';
const ROOT = path.join(BASE, 'ProjCase');

// ---------------------------------------------------------------- setup
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(path.join(ROOT, 'Tdata'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'Tdata', 'config.lua'), '5-15\n');

console.log('=== ENVIRONMENT ===');
console.log('process.platform   :', process.platform);
console.log('path.sep           :', JSON.stringify(path.sep));
console.log('path (default impl):', path === path.win32 ? 'path.win32 (bound)' : 'NOT win32');
console.log('real dir created   :', ROOT);

// ------------------------------------------------- GAP: real FS casing
// What casing does the OS itself report for a directory we created with mixed case?
const nativeReal = fs.realpathSync.native(ROOT);
const jsReal = fs.realpathSync(ROOT);
console.log('\n=== REAL FILESYSTEM CASING (what the OS reports) ===');
console.log('created as         :', ROOT);
console.log('realpathSync.native:', nativeReal);
console.log('realpathSync       :', jsReal);

// Does the real FS actually resolve a differently-cased path to the same file?
// This is the physical guarantee behind isCaseInsensitiveFs() === true.
const lowerSpelled = ROOT.toLowerCase();
let lowerStatOk = false, lowerIsSameFile = false;
try {
  lowerStatOk = fs.statSync(lowerSpelled).isDirectory();
  const a = fs.statSync(ROOT);
  const b = fs.statSync(lowerSpelled);
  // Same file iff same identity. On Windows Node exposes birthtimeMs/ino; compare dev+ino.
  lowerIsSameFile = (a.dev === b.dev && a.ino === b.ino && a.ino !== 0);
} catch (e) {
  console.log('lowercase stat threw:', e.code);
}
console.log('statSync(lowercase):', lowerStatOk ? 'OK (dir found)' : 'FAILED');
console.log('same dev+ino       :', lowerIsSameFile);
check('real NTFS resolves lowercase-spelled dir', lowerStatOk, true);
check('real NTFS lowercase path = same file identity', lowerIsSameFile, true);

// Drive-letter case on the REAL fs: C: vs c:
let driveLowerOk = false;
try { driveLowerOk = fs.statSync('c:\\Users\\apple\\ai\\work\\probe').isDirectory(); } catch { }
console.log('statSync("c:\\...")  :', driveLowerOk ? 'OK' : 'FAILED');
check('real NTFS resolves lowercase drive letter', driveLowerOk, true);

// ------------------------------------------- sameFsPath / fsKey (#4 core)
console.log('\n=== #4 : sameFsPath / fsKey ===');
check('sameFsPath drive-case', P.sameFsPath('E:\\projects\\demo', 'e:\\projects\\demo'), true);
check('sameFsPath sep-mix', P.sameFsPath('E:\\projects\\demo', 'E:/projects/demo'), true);
check('sameFsPath trailing sep', P.sameFsPath('E:\\projects\\demo\\', 'e:\\projects\\demo'), true);
check('sameFsPath real mixed-case dir', P.sameFsPath(ROOT, lowerSpelled), true);
check('sameFsPath genuinely different', P.sameFsPath('E:\\projects\\demo', 'E:\\projects\\demo2'), false);
check('sameFsPath empty', P.sameFsPath('', 'E:\\a'), false);
check('fsKey lowercases', P.fsKey('E:\\Projects\\Demo'), 'e:\\projects\\demo');

// --------------------------------------- resolveEditPath (#5 relative path)
console.log('\n=== #5 : resolveEditPath ===');
const rel = P.resolveEditPath('Tdata\\config.lua', 'e:\\projects\\demo');
check('relative + root -> absolute', rel, 'e:\\projects\\demo\\Tdata\\config.lua');
check('result is absolute', path.win32.isAbsolute(rel), true);
check('result keeps drive letter', /^[a-zA-Z]:\\/.test(rel), true);
check('already-absolute passthrough', P.resolveEditPath('E:\\a\\b.lua', 'C:\\x'), 'E:\\a\\b.lua');
check('no root -> stays relative', path.win32.isAbsolute(P.resolveEditPath('Tdata\\c.lua', '')), false);
check('empty -> empty', P.resolveEditPath('', 'E:\\a'), '');
// The real resolution against the real tree:
const realRel = P.resolveEditPath('Tdata\\config.lua', ROOT);
console.log('real resolve       :', realRel);
check('real relative resolves to existing file', fs.existsSync(realRel), true);

// ------------------------------------------------------- baseName (#5 title)
console.log('\n=== #5 : baseName (diff tab title) ===');
check('win32 backslash path', P.baseName('E:\\Tdata\\config.lua'), 'config.lua');
check('posix slash path', P.baseName('E:/Tdata/config.lua'), 'config.lua');
check('mixed separators', P.baseName('E:\\Tdata/config.lua'), 'config.lua');
check('bare name', P.baseName('config.lua'), 'config.lua');

// ---------------------------------------------------------- encodePath (URI)
console.log('\n=== virtual-doc URI pathname ===');
check('encodePath win32', P.encodePath('E:\\Tdata\\config.lua'), '/E%3A/Tdata/config.lua');
// Observation (benign): a BARE drive root keeps a trailing slash because encodePath
// does not drop empty split segments. Only ever called on document fsPaths, never
// on a root, so this is cosmetic - recorded rather than asserted as "correct".
console.log('encodePath("C:\\\\") ->', JSON.stringify(P.encodePath('C:\\')), '(trailing slash; bare-root input only, not reachable in the diff flow)');
// The whole point of dsh-now:// is that both sides are readable URIs, not fs paths.
const snapUri = 'dsh-snap://snapshot' + P.encodePath('E:\\Tdata\\config.lua');
const nowUri = 'dsh-now://current' + P.encodePath('E:\\Tdata\\config.lua');
console.log('left  :', snapUri);
console.log('right :', nowUri);
check('left scheme', snapUri.startsWith('dsh-snap://'), true);
check('right scheme', nowUri.startsWith('dsh-now://'), true);
check('right URI parses as URL', (() => { try { return new URL(nowUri).protocol === 'dsh-now:'; } catch { return false; } })(), true);

// ----------------------------------------- canonicalizeUnder (real casing)
console.log('\n=== canonicalizeUnder (agrees with VS Code folder casing) ===');
const canon = P.canonicalizeUnder(ROOT.toLowerCase(), [ROOT]);
console.log('input  (lowercase):', ROOT.toLowerCase());
console.log('root   (mixed)    :', ROOT);
console.log('output            :', canon);
check('canonicalize restores real casing', canon, ROOT);
check('canonicalize keeps tail', P.canonicalizeUnder(ROOT.toLowerCase() + '\\Tdata\\config.lua', [ROOT]),
  ROOT + '\\Tdata\\config.lua');
check('canonicalize exact-equal root', P.canonicalizeUnder(ROOT.toLowerCase(), [ROOT]), ROOT);
check('outside every root unchanged', P.canonicalizeUnder('Z:\\elsewhere\\x', [ROOT]), 'Z:\\elsewhere\\x');
check('empty roots unchanged', P.canonicalizeUnder(ROOT, []), ROOT);

// ------------------------------------------ stripTrailingSeparators / roots
console.log('\n=== drive-root handling ===');
check('strip keeps "C:\\"', P.stripTrailingSeparators('C:\\'), 'C:\\');
check('strip keeps "c:/"', P.stripTrailingSeparators('c:/'), 'c:/');
check('strip drops "C:\\proj\\"', P.stripTrailingSeparators('C:\\proj\\'), 'C:\\proj');
check('fsKey("C:\\") stays drive root', P.fsKey('C:\\'), 'c:\\');

// ---------------------------------------------- the ORIGINAL bug, replayed
console.log('\n=== original bug replayed with the OLD semantics ===');
const folderFsPath = 'e:\\projects\\demo';   // what VS Code reports (folder casing)
const frameWorkspace = 'E:\\projects\\demo'; // what the SSE frame carried
console.log('old  (===)      :', folderFsPath === frameWorkspace, '  <- mismatch: extension never connects (#4)');
console.log('new  (sameFsPath):', P.sameFsPath(folderFsPath, frameWorkspace), '  <- matches');
check('old === was broken', folderFsPath === frameWorkspace, false);
check('new sameFsPath fixes it', P.sameFsPath(folderFsPath, frameWorkspace), true);

const oldTitle = 'E:\\Tdata\\config.lua'.split('/').pop();
console.log('old title (split("/")):', JSON.stringify(oldTitle), '<- full path leaked (#5)');
check('old title was the whole path', oldTitle, 'E:\\Tdata\\config.lua');
check('new baseName is the file name', P.baseName('E:\\Tdata\\config.lua'), 'config.lua');

// ===================== host.js helpers (source-extracted) =====================
// host.js ends with `module.exports = plugin`, so these two pure helpers are NOT
// reachable through require(). Extract them verbatim from this pinned revision
// and evaluate them in isolation. What makes this worth doing here: their
// `platform === undefined` branch is PRODUCTION behaviour on Windows, and the
// offline smoke test always passes an explicit platform, so the default branch
// only ever runs on a real win32 box like this one.
console.log('\n=== host.js : resolveEditPath / isInsideOrEqualPath (followWorkspaceOnly) ===');

const hostSrc = fs.readFileSync(SRC_HOST, 'utf8');
function extractFn(name) {
  const start = hostSrc.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('not found in host.js: ' + name);
  let depth = 0, seen = false;
  for (let j = hostSrc.indexOf('{', start); j < hostSrc.length; j++) {
    if (hostSrc[j] === '{') { depth++; seen = true; }
    else if (hostSrc[j] === '}') { depth--; if (seen && depth === 0) return hostSrc.slice(start, j + 1); }
  }
  throw new Error('unbalanced braces: ' + name);
}
const hostMod = { exports: {} };
new Function('module', 'exports', 'require',
  "const path = require('node:path');\n" +
  extractFn('resolveEditPath') + '\n' +
  extractFn('isInsideOrEqualPath') + '\n' +
  'module.exports = { resolveEditPath, isInsideOrEqualPath };'
)(hostMod, hostMod.exports, require);
const H = hostMod.exports;

// host.resolveEditPath: unlike paths.js it falls back to process.cwd() (documented).
check('host: relative + root', H.resolveEditPath('Tdata\\config.lua', 'e:\\projects\\demo'),
  'e:\\projects\\demo\\Tdata\\config.lua');
check('host: absolute passthrough', H.resolveEditPath('E:\\a\\b.lua', 'C:\\x'), 'E:\\a\\b.lua');
check('host: no root -> absolute (cwd fallback)', path.win32.isAbsolute(H.resolveEditPath('Tdata\\c.lua', undefined)), true);
check('host: empty -> undefined', H.resolveEditPath('', 'E:\\a'), undefined);

// isInsideOrEqualPath with NO platform arg === production path on this machine.
check('host: inside, same case', H.isInsideOrEqualPath('E:\\projects\\demo\\a.lua', 'E:\\projects\\demo'), true);
check('host: inside, drive case differs', H.isInsideOrEqualPath('E:\\projects\\demo\\a.lua', 'e:\\projects\\demo'), true);
check('host: inside, whole path case differs', H.isInsideOrEqualPath('E:\\PROJECTS\\DEMO\\A.LUA', 'e:\\projects\\demo'), true);
check('host: inside, root has trailing sep', H.isInsideOrEqualPath('E:\\projects\\demo\\a.lua', 'E:\\projects\\demo\\'), true);
check('host: equal', H.isInsideOrEqualPath('E:\\projects\\demo', 'E:\\projects\\demo'), true);
check('host: equal, drive case differs', H.isInsideOrEqualPath('e:\\PROJECTS\\DEMO', 'E:\\projects\\demo'), true);
// The subtle one: a naive startsWith() would call demo2 "inside" demo.
check('host: sibling "demo2" is outside "demo"', H.isInsideOrEqualPath('E:\\projects\\demo2\\a.lua', 'E:\\projects\\demo'), false);
check('host: other drive is outside', H.isInsideOrEqualPath('D:\\projects\\demo\\a.lua', 'E:\\projects\\demo'), false);
check('host: empty args -> false', H.isInsideOrEqualPath('', 'E:\\a'), false);

// Replay the ORIGINAL host bug: case-sensitive prefix compare silently skipped
// in-workspace files, so `followWorkspaceOnly` dropped real edits.
const oldInside = (p, root) => p === root || p.startsWith(root + path.win32.sep);
const oldVerdict = oldInside('E:\\projects\\demo\\a.lua', 'e:\\projects\\demo');
console.log('old case-sensitive prefix :', oldVerdict, ' <- in-workspace file treated as OUTSIDE, edit silently skipped');
console.log('new isInsideOrEqualPath   :', H.isInsideOrEqualPath('E:\\projects\\demo\\a.lua', 'e:\\projects\\demo'));
check('old host check was broken', oldVerdict, false);
check('new host check fixes it', H.isInsideOrEqualPath('E:\\projects\\demo\\a.lua', 'e:\\projects\\demo'), true);

// ------------------------------------------------- cleanup + summary
fs.rmSync(ROOT, { recursive: true, force: true });

console.log('\n=== SUMMARY ===');
for (const r of rows) if (!r.ok) console.log('FAIL', r.label, '\n  actual  :', JSON.stringify(r.actual), '\n  expected:', JSON.stringify(r.expected));
console.log(`WIN PATH PROBE: ${pass} passed, ${fail} failed, ${rows.length} total`);
process.exit(fail ? 1 : 0);
