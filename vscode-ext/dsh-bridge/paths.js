'use strict';

// Windows-safe path helpers for the bridge extension.
//
// Why this module exists: the bridge used to treat paths as opaque strings and
// compare them with `===`, which is wrong on Windows in three ways that produced
// three separate bug reports (workspace never matched when only the drive-letter
// case differed; workspace-relative agent paths turned into `\Tdata\x.lua`;
// `split('/')` silently failed to split a `\`-separated win32 path).
//
// Every function takes an optional `platform` so the win32 branch can be
// exercised from a POSIX test runner. It defaults to `process.platform`, which
// is what production uses. `path.win32` / `path.posix` are used explicitly
// instead of the platform-bound default `path` export for the same reason:
// overriding `process.platform` in a test does NOT change what `path` resolves
// to, but it does change what these helpers pick.

const path = require('path');

function platformOf(platform) {
  return platform || process.platform;
}

// The path implementation for the platform we are reasoning ABOUT (not the one
// we are running on).
function pathFor(platform) {
  return platformOf(platform) === 'win32' ? path.win32 : path.posix;
}

function isWin(platform) {
  return platformOf(platform) === 'win32';
}

// Windows filesystems are case-insensitive, so `E:\proj` and `e:\proj` are the
// same directory — which is exactly what issue #4 was. POSIX is left strict on
// purpose: Linux is case-sensitive, and macOS (case-insensitive APFS in
// practice, but case-sensitive volumes exist) has never been reported.
function isCaseInsensitiveFs(platform) {
  return isWin(platform);
}

// Drop trailing separators without destroying a bare drive root: `C:\` must stay
// `C:\`, while `C:\proj\` becomes `C:\proj`.
function stripTrailingSeparators(p) {
  let out = String(p || '');
  while (out.length > 1 && (out.endsWith('/') || out.endsWith('\\'))) {
    if (/^[a-zA-Z]:[\\/]$/.test(out)) break;
    out = out.slice(0, -1);
  }
  return out;
}

// Canonical comparison key for a filesystem path: normalized separators, no
// trailing separator, and case-folded where the filesystem is insensitive.
function fsKey(p, platform) {
  let out = stripTrailingSeparators(pathFor(platform).normalize(String(p || '')));
  if (isCaseInsensitiveFs(platform)) out = out.toLowerCase();
  return out;
}

function sameFsPath(a, b, platform) {
  if (typeof a !== 'string' || typeof b !== 'string' || a === '' || b === '') return false;
  return fsKey(a, platform) === fsKey(b, platform);
}

// Agents sometimes hand the write/edit tool a workspace-relative path. Resolve
// it against a known root; when no root is known, return the path normalized but
// still relative rather than inventing an absolute path from process.cwd() — a
// wrong absolute path fails confusingly instead of visibly.
function resolveEditPath(p, root, platform) {
  if (typeof p !== 'string' || p === '') return '';
  const P = pathFor(platform);
  if (P.isAbsolute(p)) return P.normalize(p);
  if (typeof root !== 'string' || root === '') return P.normalize(p);
  return P.resolve(root, p);
}

// basename that understands BOTH separators: a win32 path can legally arrive
// even when the extension host runs elsewhere. `split('/')` returns the whole
// string for `E:\a\b.lua`, which is how the diff tab title ended up showing a
// full path instead of a file name.
function baseName(p) {
  const parts = String(p || '').split(/[\\/]+/).filter((s) => s !== '');
  return parts.length ? parts[parts.length - 1] : String(p || '');
}

// Rewrites `p` into the casing of a workspace root it lives under (or equals).
// VS Code reports `doc.uri.fsPath` in the folder's casing while a frame may carry
// a different drive-letter case; agreeing with VS Code is what keeps ONE diff tab
// per file (two spellings used to key two entries into the snapshot/current maps)
// and makes exact-string lookups such as `locked.has(doc.uri.fsPath)` work.
// Paths outside every root are returned unchanged — they have no canonical form.
function canonicalizeUnder(p, roots, platform) {
  const sep = pathFor(platform).sep;
  const key = fsKey(p, platform);
  for (const root of (roots || [])) {
    if (typeof root !== 'string' || root === '') continue;
    const base = stripTrailingSeparators(pathFor(platform).normalize(root));
    const rkey = fsKey(base, platform);
    if (key === rkey) return base;
    // Keys differ from p only by case and separator, so offsets line up.
    if (key.startsWith(rkey + sep)) return base + String(p).slice(base.length);
  }
  return p;
}

// URI pathname for the virtual diff documents: '/'-joined, per-segment encoded.
// Splitting on both separators keeps a win32 path from collapsing into one
// percent-encoded blob.
function encodePath(p) {
  return '/' + String(p || '').split(/[\\/]+/).map(encodeURIComponent).join('/');
}

module.exports = {
  pathFor,
  isWin,
  isCaseInsensitiveFs,
  stripTrailingSeparators,
  fsKey,
  sameFsPath,
  resolveEditPath,
  baseName,
  encodePath,
  canonicalizeUnder,
};
