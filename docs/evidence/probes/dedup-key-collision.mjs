// Prove the onEdit dedup key collision.
// editKeyOf is copied verbatim from vscode-ext/dsh-bridge/extension.js:408-413.

function editKeyOf(fsPath, newText) {
  const t = typeof newText === 'string' ? newText : '';
  let h = 0;
  for (let i = 0; i < t.length; i += 97) h = (h * 31 + t.charCodeAt(i)) | 0;
  return fsPath + '|' + t.length + '|' + h;
}

const p = 'c:\\Users\\apple\\ai\\wintest\\cache-test.txt';
const samples = ['5-15', '15-25', '15-30', '15-40', '15-50'];

console.log('fsPath =', p);
console.log('');
for (const s of samples) {
  console.log(JSON.stringify(s).padEnd(10), '->', editKeyOf(p, s));
}

console.log('');
console.log('hash loop step is i += 97, so for any string shorter than 97 chars');
console.log('the loop body runs ONCE and h collapses to t.charCodeAt(0).');
console.log('Same length + same first character  =>  guaranteed key collision.');
console.log('');
console.log('collisions actually observed in this session:');
console.log('  editKeyOf(p,"15-40") === editKeyOf(p,"15-50") ?', editKeyOf(p, '15-40') === editKeyOf(p, '15-50'), '  <- the 2nd same-turn edit');
console.log('  editKeyOf(p,"5-15")  === editKeyOf(p,"15-25") ?', editKeyOf(p, '5-15') === editKeyOf(p, '15-25'));

// How common is this in practice? A realistic C-style edit:
console.log('');
console.log('a realistic example on a normal source line:');
const a = 'local M = {}';
const b = 'local N = {}';
console.log('  ', JSON.stringify(a), 'vs', JSON.stringify(b), '->', editKeyOf(p, a) === editKeyOf(p, b) ? 'COLLIDE' : 'distinct');
const c = 'M.mode = "before"';
const d = 'M.mode = "after"';
console.log('  ', JSON.stringify(c), 'vs', JSON.stringify(d), '->', editKeyOf(p, c) === editKeyOf(p, d) ? 'COLLIDE' : 'distinct');
const e = 'x = 1';
const f = 'x = 2';
console.log('  ', JSON.stringify(e), 'vs', JSON.stringify(f), '->', editKeyOf(p, e) === editKeyOf(p, f) ? 'COLLIDE' : 'distinct');

// Sanity: does it ever separate short strings? Only the 1st char and length matter.
console.log('');
console.log('distinct only when first char or length differs:');
const g = '15-40';
const h2 = '25-40';
console.log('  ', JSON.stringify(g), 'vs', JSON.stringify(h2), '->', editKeyOf(p, g) === editKeyOf(p, h2) ? 'COLLIDE' : 'distinct (first char differs)');
const i3 = '15-400';
console.log('  ', JSON.stringify(g), 'vs', JSON.stringify(i3), '->', editKeyOf(p, g) === editKeyOf(p, i3) ? 'COLLIDE' : 'distinct (length differs)');

// ---------------------------------------------------- platform independence
// editKeyOf uses ONLY: String.length, String.prototype.charCodeAt, number
// arithmetic, and string concatenation. It never touches `path`, `fs`,
// `process.platform`, separators or drive letters. ECMAScript specifies
// charCodeAt as UTF-16 code units, identical on every platform.
console.log('');
console.log('=== PLATFORM INDEPENDENCE ===');
const posixFsPath = '/Users/dev/proj/wintest/cache-test.txt';
const winFsPath = 'c:\\Users\\apple\\ai\\wintest\\cache-test.txt';
console.log('fsPath only PREFIXES the key; the collision lives entirely in (length, h).');
for (const [label, fp] of [['win32 fsPath', winFsPath], ['posix fsPath', posixFsPath]]) {
  const k1 = editKeyOf(fp, '15-40');
  const k2 = editKeyOf(fp, '15-50');
  console.log('  ' + label.padEnd(14) + ' "15-40" vs "15-50" -> ' + (k1 === k2 ? 'COLLIDE' : 'distinct'));
}
console.log('');
console.log('=> the defect reproduces identically with a POSIX path, and the function');
console.log('   contains no platform-conditional code. Platform-independent.');
