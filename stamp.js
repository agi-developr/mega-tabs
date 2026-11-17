'use strict';
// Writes extension/BUILD: a hash of every other file under extension/. The extension polls
// that file and reloads itself when it changes (extension/megatabs.js), so after an edit
// run `node stamp.js` once, or leave `node stamp.js --watch` running.
// BUILD covers code only: extension/board-data/ (generated from his .md files by board-sync.js)
// is left out, so saving a .md file, his or an AI's, never reloads the extension or the Board.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_EXT = path.join(__dirname, 'extension');

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? files(p) : [p];
  });
}

function stamp(EXT = DEFAULT_EXT) {
  const h = crypto.createHash('sha256');
  for (const f of files(EXT).sort()) {
    if (path.basename(f) === 'BUILD' || path.relative(EXT, f).split(path.sep)[0] === 'board-data') continue;
    h.update(path.relative(EXT, f)).update(fs.readFileSync(f));
  }
  const value = h.digest('hex').slice(0, 16);
  const file = path.join(EXT, 'BUILD');
  const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '';
  if (old !== value) fs.writeFileSync(file, value + '\n');
  return { value, changed: old !== value };
}

if (require.main === module) {
  const r = stamp();
  console.log(`BUILD ${r.value}${r.changed ? ' (updated)' : ''}`);
  if (process.argv.includes('--watch')) {
    let t;
    fs.watch(DEFAULT_EXT, { recursive: true }, (_, name) => {
      if (name && (path.basename(name) === 'BUILD' || name.split(path.sep)[0] === 'board-data')) return;
      clearTimeout(t);
      t = setTimeout(() => console.log(`BUILD ${stamp().value}`), 150);
    });
  }
}

module.exports = { stamp };
