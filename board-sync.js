'use strict';
// Plain .md files in ~/Spaces/<space>/ are the Board's source of truth; the Board reads and writes
// them through its native-messaging host (host/board-host.js), not through copies made here.
// What this makes: every ~/Spaces/<space>/<mega tab>/MEGATAB.md goes into extension/board-data/
// megatabs.json (urls + how-it-works text), which the extension turns into mega tabs, opened
// URLs and the panel's workflow text. It also writes the BUILD stamp (code changes only).
//
//   node board-sync.js            sync once (seeds ~/Spaces/Me/README.md if the folder is missing)
//   node board-sync.js --watch    keep running; sync a moment after any change under ~/Spaces
//   --from <dir>  --to <extension dir>   other places, for tests
//
// Nothing is ever deleted or overwritten under ~/Spaces. The command line (not sync() itself)
// writes two starters there: the seed README, only when ~/Spaces/Me does not exist, and the
// four Me MEGATAB.md files, and the Me Board.canvas, each once (see seedMegaTabs, seedCanvas).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { stamp } = require('./stamp');

const SEED = `# Me

This is the Board: the .md files in this folder show up in the Board of the space "Me".
Press E in the Board to type in a file; edits made anywhere else (Cursor is fine) show up there within a second or two.
`;

function seed(from) {
  const dir = path.join(from, 'Me');
  if (fs.existsSync(dir)) return false;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), SEED, { flag: 'wx' });
  return true;
}

// ---------------------------------------------------------------- Mega tabs from plain files
//
// ~/Spaces/<space>/<mega tab>/MEGATAB.md:
//
//   ---
//   urls:
//     - https://example.com
//   ---
//   Two or three plain sentences on how this workflow works.
//
// Only web addresses (http, https) are kept. `urls: [a, b]` on one line works too.

function webUrl(s) {
  const v = s.trim().replace(/^(['"])(.*)\1$/, '$2').trim();
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:' ? v : null;
  } catch {
    return null;
  }
}

function parseMegaTab(text) {
  const src = text.replace(/\r\n?/g, '\n').replace(/^﻿/, '');
  const m = src.match(/^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)([\s\S]*)$/);
  const front = m ? m[1] : '';
  const body = (m ? m[2] : src).trim();
  const urls = [];
  const add = (s) => {
    const u = webUrl(s);
    if (u && !urls.includes(u)) urls.push(u);
  };
  const lines = front.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const k = lines[i].match(/^urls[ \t]*:[ \t]*(.*)$/);
    if (!k) continue;
    const rest = k[1].trim();
    if (rest.startsWith('[')) {
      for (const part of rest.replace(/^\[|\]\s*$/g, '').split(',')) add(part);
    } else {
      for (let j = i + 1; j < lines.length; j++) {
        const item = lines[j].match(/^[ \t]*-[ \t]+(.+?)[ \t]*(?:#.*)?$/);
        if (!item) {
          if (lines[j].trim() === '') continue;
          break;
        }
        add(item[1]);
      }
    }
  }
  return { urls, body };
}

// Every <space>/<mega tab>/MEGATAB.md, sorted so the output bytes only change when a file does
function readMegaTabs(from) {
  const out = [];
  for (const sp of fs.readdirSync(from, { withFileTypes: true })) {
    if (!sp.isDirectory() || sp.name.startsWith('.')) continue;
    for (const mt of fs.readdirSync(path.join(from, sp.name), { withFileTypes: true })) {
      if (!mt.isDirectory() || mt.name.startsWith('.')) continue;
      const file = path.join(from, sp.name, mt.name, 'MEGATAB.md');
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
      out.push({ space: sp.name.trim(), mega: mt.name.trim(), ...parseMegaTab(fs.readFileSync(file, 'utf8')) });
    }
  }
  return out.sort((a, b) => a.space.localeCompare(b.space) || a.mega.localeCompare(b.mega));
}

// The starter mega tabs written once into a new example space. Neutral pages only: each address is
// an example domain or a Wikipedia page, so a first run never opens anything personal.
const EXAMPLE_MEGAS = {
  Reading: {
    urls: ['https://en.wikipedia.org/wiki/Main_Page'],
    body: 'Articles and pages you want to read. Open one, jot a note on the Board, then close the tab. Start with what you saved last time.',
  },
  Drafts: {
    urls: ['https://example.com/'],
    body: 'Work in progress: outlines, posts and anything half written. Keep the pages you need open here and the rest out of sight.',
  },
  Archive: {
    urls: ['https://example.org/'],
    body: 'Pages you are done with for now but may want again. Add a link to this file to keep it here.',
  },
  Writing: {
    urls: ['https://en.wikipedia.org/wiki/Writing', 'https://example.com/'],
    body: 'Where the writing happens: the draft, a reference page and your notes. Edit this file to change which pages open here.',
  },
};
const SEED_MARK = '.megatabs-seeded';

// Writes ~/Spaces/Me/<mega tab>/MEGATAB.md for the four starter mega tabs, once. A file that
// exists is never touched (flag 'wx'), and once the marker is there nothing is written again,
// so a mega tab he deletes is not brought back. Never deletes anything.
function seedMegaTabs(from) {
  const space = path.join(from, 'Me');
  if (!fs.existsSync(space) || fs.existsSync(path.join(space, SEED_MARK))) return [];
  const made = [];
  for (const [mega, { urls, body }] of Object.entries(EXAMPLE_MEGAS)) {
    const dir = path.join(space, mega);
    const file = path.join(dir, 'MEGATAB.md');
    if (fs.existsSync(file)) continue;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, `---\nurls:\n${urls.map((u) => `  - ${u}`).join('\n')}\n---\n${body}\n`, { flag: 'wx' });
    made.push(mega);
  }
  fs.writeFileSync(path.join(space, SEED_MARK), 'The four starter mega tabs were written once; delete this file to allow it again.\n', { flag: 'wx' });
  return made;
}

// ~/Spaces/Me/Board.canvas (JSON Canvas 1.0) for the Board's Canvas room: an intro card, README.md
// and the four MEGATAB.md files as file cards. Written only when the file does not exist (flag 'wx') and
// the marker is not there, so a canvas he deletes is not brought back; an existing file is never touched.
const CANVAS_MARK = '.megatabs-canvas-seeded';
function canvasSeed() {
  const megas = Object.keys(EXAMPLE_MEGAS);
  const nodes = [
    { id: 'megas', type: 'group', x: -30, y: 190, width: 1190, height: 150, label: 'Mega tabs' },
    { id: 'intro', type: 'text', x: 0, y: 0, width: 320, height: 130, text: '# Me\n\nOne place to think with the AI. Drag cards, connect them, draw with the pen (P). Files here open in Notes.' },
    { id: 'readme', type: 'file', x: 380, y: 29, width: 260, height: 72, file: 'README.md' },
    ...megas.map((m, i) => ({ id: `mega-${i}`, type: 'file', x: i * 290, y: 232, width: 260, height: 72, file: `${m}/MEGATAB.md` })),
  ];
  const edges = [
    { id: 'intro-readme', fromNode: 'intro', toNode: 'readme', fromSide: 'right', toSide: 'left' },
    ...megas.map((m, i) => ({ id: `intro-mega-${i}`, fromNode: 'intro', toNode: `mega-${i}`, fromSide: 'bottom', toSide: 'top' })),
  ];
  return JSON.stringify({ nodes, edges }, null, '\t');
}
function seedCanvas(from) {
  const space = path.join(from, 'Me');
  if (!fs.existsSync(space) || fs.existsSync(path.join(space, CANVAS_MARK))) return false;
  const file = path.join(space, 'Board.canvas');
  if (fs.existsSync(file)) return false;
  fs.writeFileSync(file, canvasSeed(), { flag: 'wx' });
  fs.writeFileSync(path.join(space, CANVAS_MARK), 'Board.canvas was written once; delete this file to allow it again.\n', { flag: 'wx' });
  return true;
}

// The Board no longer reads copies: its host (host/board-host.js) lists, reads, writes and watches
// ~/Spaces/<space>/*.md live. All that is generated here is megatabs.json, and extension/board-data/
// is left out of BUILD (stamp.js), so no .md change reloads the extension or the Board page.
function sync({ from = path.join(os.homedir(), 'Spaces'), to = path.join(__dirname, 'extension') } = {}) {
  const seeded = seed(from);
  const out = path.join(to, 'board-data');
  const wanted = new Map(); // relative path under board-data -> content
  // Only for the report line: how many spaces and top-level .md files the Board will list
  let spaces = 0;
  let files = 0;
  for (const d of fs.readdirSync(from, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name.startsWith('.')) continue;
    spaces++;
    files += fs.readdirSync(path.join(from, d.name), { withFileTypes: true }).filter((f) => f.isFile() && !f.name.startsWith('.') && /\.md$/i.test(f.name)).length;
  }
  // Mega tabs: the extension reads this to make mega tabs, open their URLs and show their text
  const megatabs = readMegaTabs(from);
  wanted.set('megatabs.json', JSON.stringify({ megatabs }, null, 2) + '\n');

  // Write what changed, remove what is gone (this includes the .md copies and index.json that
  // older versions wrote here); untouched files keep their bytes. Only extension/board-data/ is touched.
  fs.mkdirSync(out, { recursive: true });
  const have = fs
    .readdirSync(out, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.relative(out, path.join(e.parentPath, e.name)));
  for (const rel of have) if (!wanted.has(rel)) fs.rmSync(path.join(out, rel));
  for (const [rel, text] of wanted) {
    const file = path.join(out, rel);
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  for (const d of fs.readdirSync(out, { withFileTypes: true })) {
    if (d.isDirectory() && !fs.readdirSync(path.join(out, d.name)).length) fs.rmdirSync(path.join(out, d.name));
  }
  const built = stamp(to);
  return { seeded, spaces, files, megatabs: megatabs.length, build: built.value, changed: built.changed };
}

if (require.main === module) {
  const arg = (n) => {
    const i = process.argv.indexOf(n);
    return i > 0 ? path.resolve(process.argv[i + 1]) : undefined;
  };
  const opts = { from: arg('--from'), to: arg('--to') };
  const run = () => {
    const starters = seedMegaTabs(opts.from || path.join(os.homedir(), 'Spaces'));
    const canvas = seedCanvas(opts.from || path.join(os.homedir(), 'Spaces'));
    const r = sync(opts);
    console.log(
      `board: ${r.spaces} space(s), ${r.files} file(s), ${r.megatabs} mega tab(s)${r.seeded ? ', seeded Me/README.md' : ''}` +
        `${starters.length ? ', seeded mega tabs ' + starters.join(', ') : ''}${canvas ? ', seeded Me/Board.canvas' : ''}, BUILD ${r.build}${r.changed ? ' (updated)' : ''}`,
    );
  };
  run();
  if (process.argv.includes('--watch')) {
    const dir = opts.from || path.join(os.homedir(), 'Spaces');
    let t;
    fs.watch(dir, { recursive: true }, () => {
      clearTimeout(t);
      t = setTimeout(run, 300);
    });
  }
}

module.exports = { sync, parseMegaTab, readMegaTabs, seedMegaTabs, seedCanvas, canvasSeed, EXAMPLE_MEGAS };
