'use strict';
// Which message keys the extension's code asks for, found by reading the source (no browser). A key counts as
// used when its name is a quoted string inside the argument list of tr(...), plural(...), trNodes(...), t(...) or
// chrome.i18n.getMessage(...) (this also finds both keys of a ternary and a key map written inside the call), when
// it is named in a `// i18n-keys: a b c` comment (a table of keys the call below it picks from), in data-i18n*
// attributes of a page, or as __MSG_key__ in the manifest.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EXT = path.join(ROOT, 'extension');
const CANVAS_SRC = path.join(ROOT, 'canvas', 'src');

// Pages and scripts of the old popup and the export/import page. Nothing in the product opens them any more (the
// toolbar icon opens the side panel; there is no default_popup), so the texts only they ask for are not translated:
// Chrome shows them in English if they are ever reached.
const LEGACY_FILES = ['popup.js', 'popup.html', 'transfer.js', 'transfer.html', 'ui.js'];
// Not translated beyond English and German: messages thrown for a call no page of ours makes (a bad choice sent by hand
// to the background page), and the field-level diagnostics of the import check
const TECHNICAL_KEYS = [
  'unloadInvalid', 'importModeUnknown', 'importReplaceUnconfirmed', 'earlierGone', 'autoBackupInvalid',
  // What the import check says about one field of a file that is not an export (it names JSON fields: id, collapsed, groups).
  // Shown in Settings only for a damaged file; Chrome falls back to English where a language lacks them.
  'exNotText', 'exTooLong', 'exNotList', 'exBadUrl', 'exJavascript', 'exOwnPage', 'exBadVersion', 'exNewerVersion', 'exNotObject',
  'exBadColor', 'exBadId', 'exDupId', 'exEmptyId', 'exDupGroupId', 'exBadGroupColor', 'exBadCollapsed', 'exUnknownGroup',
  'exWherePinned', 'exWhereWs', 'exWhereWsNamed', 'exWhereGroup', 'exWhereTab',
];

const sourceFiles = () => [
  ...fs.readdirSync(EXT).filter((f) => /\.(js|html)$/.test(f)).map((f) => path.join(EXT, f)),
  path.join(EXT, 'manifest.json'),
  ...fs.readdirSync(CANVAS_SRC).filter((f) => /\.(jsx|mjs)$/.test(f)).map((f) => path.join(CANVAS_SRC, f)),
];

// text between the parentheses that open at `start` (the index of "(")
function argsAt(src, start) {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return src.slice(start + 1, i);
  }
  return src.slice(start + 1);
}

// Map key -> Set of file names (relative to the repo) that ask for it
function usedKeys(known) {
  const used = new Map();
  const add = (k, f) => {
    if (!known.has(k)) return;
    if (!used.has(k)) used.set(k, new Set());
    used.get(k).add(path.relative(ROOT, f));
  };
  for (const f of sourceFiles()) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/(?<![\w$])(?:tr|plural|trNodes|t|getMessage)\(/g)) {
      const args = argsAt(src, m.index + m[0].length - 1);
      for (const [, k] of args.matchAll(/'([A-Za-z][A-Za-z0-9]*)'/g)) add(k, f);
    }
    for (const [, list] of src.matchAll(/i18n-keys:\s*([A-Za-z0-9_ ]+)/g)) for (const k of list.trim().split(/\s+/)) add(k, f);
    for (const [, k] of src.matchAll(/data-i18n(?:-title|-label|-placeholder)?="([^"]+)"/g)) add(k, f);
    for (const [, k] of src.matchAll(/__MSG_(\w+)__/g)) add(k, f);
  }
  return used;
}

const baseOf = (k) => k.replace(/_(zero|one|two|few|many|other)$/, '');

// The keys a translator must cover: used by a file that is not legacy, minus the technical ones. Plural keys are
// given as their base name (the forms a language needs depend on the language).
function liveKeys(en) {
  const bases = new Set(Object.keys(en).filter((k) => /_other$/.test(k)).map(baseOf));
  const known = new Set([...Object.keys(en).filter((k) => !/_(zero|one|two|few|many|other)$/.test(k) || !bases.has(baseOf(k))), ...bases]);
  const used = usedKeys(known);
  const live = [...used].filter(([k, files]) => !TECHNICAL_KEYS.includes(k) && [...files].some((f) => !LEGACY_FILES.includes(path.basename(f))));
  return { live: live.map(([k]) => k).sort(), plural: [...bases].filter((b) => used.has(b)).sort(), used, known };
}

module.exports = { ROOT, EXT, CANVAS_SRC, LEGACY_FILES, TECHNICAL_KEYS, sourceFiles, usedKeys, liveKeys, baseOf };
