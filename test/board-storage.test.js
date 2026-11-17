'use strict';
// The Board's one storage interface (extension/storage.js), two paths behind it: the native host's core and a
// picked folder (File System Access API). The SAME scenarios run on both, so "same conflict rules" is a fact, not a
// hope. The folder path runs here on a fake directory handle backed by a real temp folder (same methods the browser's
// handle has); the real browser API is exercised in board-next.chromium.test.js (on the origin-private file system,
// because a picker dialog cannot be driven).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createCore, HostError, MAX_FILE, MAX_MODEL, MODEL_CHUNK } = require('../host/core');
const { createFolderStorage } = require('../extension/storage.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- a directory handle like the browser's, on a real folder
const notFound = () => Object.assign(new Error('not found'), { name: 'NotFoundError' });
const mismatch = () => Object.assign(new Error('type mismatch'), { name: 'TypeMismatchError' });
function fileHandle(abs, name) {
  return {
    kind: 'file',
    name,
    async getFile() {
      const st = await fsp.stat(abs).catch(() => {
        throw notFound();
      });
      // the bytes are read when asked for, as the browser does: a big file is only looked at (its size) until it is read
      const bytes = async (a = 0, b = st.size) => {
        const buf = await fsp.readFile(abs);
        return buf.buffer.slice(buf.byteOffset + a, buf.byteOffset + Math.min(b, buf.byteLength));
      };
      return { size: st.size, lastModified: st.mtimeMs, arrayBuffer: () => bytes(), slice: (a, b) => ({ arrayBuffer: () => bytes(a, b) }) };
    },
    async createWritable() {
      const chunks = [];
      return {
        write: async (b) => void chunks.push(Buffer.from(b)),
        close: async () => fsp.writeFile(abs, Buffer.concat(chunks)),
        abort: async () => {},
      };
    },
  };
}
function dirHandle(abs, name) {
  return {
    kind: 'directory',
    name,
    async getDirectoryHandle(n, { create } = {}) {
      const p = path.join(abs, n);
      const st = await fsp.stat(p).catch(() => null);
      if (!st) {
        if (!create) throw notFound();
        await fsp.mkdir(p);
      } else if (!st.isDirectory()) throw mismatch();
      return dirHandle(p, n);
    },
    async getFileHandle(n, { create } = {}) {
      const p = path.join(abs, n);
      const st = await fsp.stat(p).catch(() => null);
      if (!st) {
        if (!create) throw notFound();
        await fsp.writeFile(p, ''); // like the browser: taking a handle with create makes an empty file
      } else if (st.isDirectory()) throw mismatch();
      return fileHandle(p, n);
    },
    async removeEntry(n) {
      await fsp.rm(path.join(abs, n));
    },
    async *entries() {
      for (const e of await fsp.readdir(abs, { withFileTypes: true })) yield [e.name, e.isDirectory() ? dirHandle(path.join(abs, e.name), e.name) : fileHandle(path.join(abs, e.name), e.name)];
    },
  };
}

// ---- the two adapters: a root folder and a `call(type, args)` over it
function hostPath(root) {
  const core = createCore({ root });
  const fnOf = {
    ping: () => ({ max: core.MAX_FILE }),
    list: (a) => core.list(a.space),
    read: (a) => core.read(a.space, a.file, { folder: a.folder }),
    write: (a) => core.write(a.space, a.file, a.text, a.base === undefined ? null : a.base, { folder: a.folder }),
    create: (a) => core.create(a.space, a.file, a.text ?? '', { folder: a.folder }),
    trash: (a) => core.trash(a.space, a.file, { folder: a.folder }),
    untrash: (a) => core.untrash(a.space, a.trashId, { to: a.to }),
    rename: (a) => core.rename(a.space, a.file, a.to, { folder: a.folder }),
    search: (a) => core.search(a.space, a.q),
    model: (a) => core.model(a.space, a.file, { folder: a.folder, offset: a.offset }),
  };
  return {
    name: 'host',
    max: core.MAX_FILE,
    async call(type, a = {}) {
      try {
        return fnOf[type](a);
      } catch (e) {
        if (!(e instanceof HostError)) throw e;
        throw Object.assign(new Error(e.message), { code: e.code, theirs: e.extra?.theirs, reason: e.extra?.reason, hash: e.extra?.hash, size: e.extra?.size, gone: e.extra?.gone });
      }
    },
    close() {},
  };
}
function folderPath(root) {
  const s = createFolderStorage(dirHandle(root, path.basename(root)), { pollMs: 40 });
  return { name: 'folder', max: s.max, call: (t, a) => s.call(t, a), store: s, close: () => s.close() };
}

function setup(make) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'megatabs-storage-')));
  fs.mkdirSync(path.join(root, 'Me', 'Reading'), { recursive: true });
  const p = make(root);
  return { ...p, root, dir: path.join(root, 'Me'), done: () => (p.close(), fs.rmSync(root, { recursive: true, force: true })) };
}

for (const make of [hostPath, folderPath]) {
  const label = make === hostPath ? 'host' : 'folder';
  const S = (fn) => async () => {
    const x = setup(make);
    try {
      await fn(x);
    } finally {
      x.done();
    }
  };
  const fail = async (p, code, extra) => {
    try {
      await p;
    } catch (e) {
      assert.equal(e.code, code, `${e.code}: ${e.message}`);
      if (extra) extra(e);
      return e;
    }
    assert.fail(`expected an error ${code}`);
  };

  test(`[${label}] ping says the cap; list shows notes (README first), canvases, and one folder level with MEGATAB.md first; two levels down are not listed`, S(async (x) => {
    fs.writeFileSync(path.join(x.dir, 'zeta.md'), '# Zeta\n');
    fs.writeFileSync(path.join(x.dir, 'README.md'), '# Read me\n');
    fs.writeFileSync(path.join(x.dir, 'Board.canvas'), '{"nodes":[],"edges":[]}');
    fs.writeFileSync(path.join(x.dir, 'ignored.txt'), 'x');
    fs.writeFileSync(path.join(x.dir, 'Reading', 'zz.md'), '# ZZ\n');
    fs.writeFileSync(path.join(x.dir, 'Reading', 'MEGATAB.md'), 'How it works.\n');
    fs.mkdirSync(path.join(x.dir, 'Reading', 'deeper'));
    fs.writeFileSync(path.join(x.dir, 'Reading', 'deeper', 'hidden.md'), '# no\n');
    const p = await x.call('ping');
    assert.equal(p.max, x.max);
    assert.ok(p.max >= 480 * 1024);
    const r = await x.call('list', { space: 'Me' });
    assert.deepEqual(r.files.map((f) => f.file), ['README.md', 'Board.canvas', 'zeta.md'].sort((a, b) => (a === 'README.md' ? -1 : b === 'README.md' ? 1 : a.localeCompare(b))));
    assert.deepEqual(r.files.map((f) => f.kind), r.files.map((f) => (f.file.endsWith('.canvas') ? 'canvas' : 'md')));
    assert.equal(r.files.find((f) => f.file === 'README.md').title, 'Read me');
    assert.deepEqual(r.folders.map((g) => [g.folder, g.files.map((f) => f.file)]), [['Reading', ['MEGATAB.md', 'zz.md']]]);
    assert.equal(r.max, x.max);
    assert.match(r.files[0].hash, /^[0-9a-f]{64}$/);
  }));

  test(`[${label}] a save is byte-exact (BOM, CRLF, no final newline) and its hash is the sha-256 of the bytes`, S(async (x) => {
    const crypto = require('node:crypto');
    for (const [name, text] of [['bom.md', '﻿# Bom\n'], ['crlf.md', '# W\r\n\r\ntext\r\n'], ['noeol.md', 'no final newline'], ['uni.md', '# Ünï\n😀\n']]) {
      const w = await x.call('create', { space: 'Me', file: name, text });
      assert.equal(fs.readFileSync(path.join(x.dir, name), 'utf8'), text);
      assert.equal(w.hash, crypto.createHash('sha256').update(text).digest('hex'));
      assert.equal((await x.call('read', { space: 'Me', file: name })).text, text);
    }
  }));

  test(`[${label}] conflict: a save whose base is stale writes nothing and returns their text, hash and size; "Keep mine" saves with that hash`, S(async (x) => {
    const a = await x.call('create', { space: 'Me', file: 'n.md', text: 'one' });
    fs.writeFileSync(path.join(x.dir, 'n.md'), 'two (outside)');
    const e = await fail(x.call('write', { space: 'Me', file: 'n.md', text: 'mine', base: a.hash }), 'conflict');
    assert.equal(e.reason, 'changed');
    assert.equal(e.theirs.text, 'two (outside)');
    assert.equal(e.hash, e.theirs.hash);
    assert.equal(e.size, 13);
    assert.equal(fs.readFileSync(path.join(x.dir, 'n.md'), 'utf8'), 'two (outside)', 'nothing was written');
    await x.call('write', { space: 'Me', file: 'n.md', text: 'mine', base: e.hash });
    assert.equal(fs.readFileSync(path.join(x.dir, 'n.md'), 'utf8'), 'mine');
  }));

  test(`[${label}] conflict: a file too big or not UTF-8 comes back with its hash and no text, and Keep mine works with the hash (REVIEW #9)`, S(async (x) => {
    const a = await x.call('create', { space: 'Me', file: 'n.md', text: 'one' });
    fs.writeFileSync(path.join(x.dir, 'n.md'), Buffer.from([0xff, 0xfe, 0x41, 0x80]));
    const e = await fail(x.call('write', { space: 'Me', file: 'n.md', text: 'mine', base: a.hash }), 'conflict');
    assert.equal(e.theirs, null);
    assert.equal(e.reason, 'not-utf8');
    assert.match(e.hash, /^[0-9a-f]{64}$/);
    await x.call('write', { space: 'Me', file: 'n.md', text: 'mine', base: e.hash });
    assert.equal(fs.readFileSync(path.join(x.dir, 'n.md'), 'utf8'), 'mine');
    // over the cap the storage itself reported
    fs.writeFileSync(path.join(x.dir, 'big.md'), Buffer.alloc(x.max + 1000, 0x61));
    const g = await x.call('create', { space: 'Me', file: 'g.md', text: 'x' });
    fs.copyFileSync(path.join(x.dir, 'big.md'), path.join(x.dir, 'g.md'));
    const e2 = await fail(x.call('write', { space: 'Me', file: 'g.md', text: 'mine', base: g.hash }), 'conflict');
    assert.equal(e2.reason, 'too-large');
    assert.equal(e2.theirs, null);
    assert.equal(e2.size, x.max + 1000);
  }));

  test(`[${label}] create never replaces; a save of a deleted file is a "gone" conflict; a file that must not exist says "exists"`, S(async (x) => {
    await x.call('create', { space: 'Me', file: 'a.md', text: 'first' });
    const e = await fail(x.call('create', { space: 'Me', file: 'a.md', text: 'second' }), 'conflict');
    assert.equal(e.reason, 'exists');
    assert.equal(fs.readFileSync(path.join(x.dir, 'a.md'), 'utf8'), 'first');
    const b = await x.call('create', { space: 'Me', file: 'b.md', text: 'b' });
    fs.rmSync(path.join(x.dir, 'b.md'));
    const g = await fail(x.call('write', { space: 'Me', file: 'b.md', text: 'mine', base: b.hash }), 'conflict');
    assert.equal(g.reason, 'gone');
    assert.equal(g.gone, true);
    assert.ok(!fs.existsSync(path.join(x.dir, 'b.md')), 'a deleted file is not made again unasked');
    // a failed create leaves no empty placeholder behind
    await fail(x.call('create', { space: 'Me', file: 'c.canvas', text: 'not json' }), 'bad-text');
    assert.ok(!fs.existsSync(path.join(x.dir, 'c.canvas')));
  }));

  test(`[${label}] names and types: ../ . : and hidden names, other extensions, a canvas that is not an object, over the cap`, S(async (x) => {
    for (const file of ['../x.md', '.hidden.md', 'a:b.md', 'a/b.md', '', ' padded.md']) await fail(x.call('create', { space: 'Me', file, text: 'x' }), 'bad-name');
    await fail(x.call('create', { space: 'Me', file: 'x.txt', text: 'x' }), 'bad-type');
    await fail(x.call('create', { space: 'Me', file: 'x.canvas', text: '[]' }), 'bad-text');
    await fail(x.call('create', { space: 'Me', file: 'big.md', text: 'a'.repeat(x.max + 1) }), 'too-large');
    await fail(x.call('write', { space: 'Me', file: 'x.md', text: 'x', base: 'not a hash' }), 'bad-base');
    await fail(x.call('create', { space: '../out', file: 'x.md', text: 'x' }), 'bad-name');
    assert.deepEqual(fs.readdirSync(x.dir).sort(), ['Reading']);
  }));

  test(`[${label}] files in a mega tab folder: read, write, conflict and create work one level down`, S(async (x) => {
    const w = await x.call('write', { space: 'Me', folder: 'Reading', file: 'MEGATAB.md', text: 'how', base: null });
    assert.equal(fs.readFileSync(path.join(x.dir, 'Reading', 'MEGATAB.md'), 'utf8'), 'how');
    assert.equal((await x.call('read', { space: 'Me', folder: 'Reading', file: 'MEGATAB.md' })).hash, w.hash);
    fs.writeFileSync(path.join(x.dir, 'Reading', 'MEGATAB.md'), 'theirs');
    await fail(x.call('write', { space: 'Me', folder: 'Reading', file: 'MEGATAB.md', text: 'mine', base: w.hash }), 'conflict');
    await fail(x.call('read', { space: 'Me', folder: 'Nope', file: 'x.md' }), 'no-folder');
    await fail(x.call('create', { space: 'Me', folder: 'Nope', file: 'x.md', text: 'x' }), 'no-folder');
    assert.ok(!fs.existsSync(path.join(x.dir, 'Nope')), 'a mega tab folder is never made by a save');
  }));

  test(`[${label}] trash moves to .trash/<space>/<name> <timestamp> (never deletes), untrash brings the bytes back, a taken name is refused, \`to\` restores under another`, S(async (x) => {
    const bytes = '﻿# Keep\r\nme';
    await x.call('create', { space: 'Me', file: 'Keep.md', text: bytes });
    const t = await x.call('trash', { space: 'Me', file: 'Keep.md' });
    assert.match(t.trashId, /^Keep\.md \d{8}T\d{6}-\d{3}Z$/);
    assert.ok(!fs.existsSync(path.join(x.dir, 'Keep.md')));
    assert.equal(fs.readFileSync(path.join(x.root, '.trash', 'Me', t.trashId), 'utf8'), bytes, 'the trashed bytes are the file');
    await x.call('create', { space: 'Me', file: 'Keep.md', text: 'new one' });
    await fail(x.call('untrash', { space: 'Me', trashId: t.trashId }), 'exists');
    assert.equal(fs.readFileSync(path.join(x.dir, 'Keep.md'), 'utf8'), 'new one');
    assert.ok(fs.existsSync(path.join(x.root, '.trash', 'Me', t.trashId)), 'still in the trash');
    const back = await x.call('untrash', { space: 'Me', trashId: t.trashId, to: 'Keep (restored).md' });
    assert.equal(back.file, 'Keep (restored).md');
    assert.equal(fs.readFileSync(path.join(x.dir, 'Keep (restored).md'), 'utf8'), bytes, 'byte for byte');
    // inside a mega tab folder
    await x.call('create', { space: 'Me', folder: 'Reading', file: 'in.md', text: 'x' });
    const u = await x.call('trash', { space: 'Me', folder: 'Reading', file: 'in.md' });
    assert.match(u.trashId, /^Reading\/in\.md \d{8}T/);
    const w = await x.call('untrash', { space: 'Me', trashId: u.trashId });
    assert.deepEqual([w.file, w.folder], ['in.md', 'Reading']);
    await fail(x.call('trash', { space: 'Me', file: 'nope.md' }), 'gone');
  }));

  test(`[${label}] rename never replaces: a taken name is refused and nothing moves; the hash follows; a note stays a note`, S(async (x) => {
    const a = await x.call('create', { space: 'Me', file: 'a.md', text: 'A' });
    await x.call('create', { space: 'Me', file: 'b.md', text: 'B' });
    await fail(x.call('rename', { space: 'Me', file: 'a.md', to: 'b.md' }), 'exists');
    assert.equal(fs.readFileSync(path.join(x.dir, 'a.md'), 'utf8'), 'A');
    assert.equal(fs.readFileSync(path.join(x.dir, 'b.md'), 'utf8'), 'B');
    const r = await x.call('rename', { space: 'Me', file: 'a.md', to: 'c.md' });
    assert.equal(r.file, 'c.md');
    assert.equal(r.hash, a.hash);
    assert.ok(!fs.existsSync(path.join(x.dir, 'a.md')));
    await fail(x.call('rename', { space: 'Me', file: 'c.md', to: 'c.canvas' }), 'bad-type');
    await fail(x.call('rename', { space: 'Me', file: 'zzz.md', to: 'y.md' }), 'gone');
  }));

  test(`[${label}] search finds notes by title, file name and body, a canvas by its card, in the top level and one folder down; shape and order match`, S(async (x) => {
    fs.writeFileSync(path.join(x.dir, 'README.md'), '# Space\n\nthe quick brown fox\n');
    fs.writeFileSync(path.join(x.dir, 'Foxtrot.md'), 'nothing\n');
    fs.writeFileSync(path.join(x.dir, 'Board.canvas'), JSON.stringify({ nodes: [{ id: 'n1', type: 'text', text: 'a card about the FOX', x: 0, y: 0, width: 9, height: 9 }], edges: [] }));
    fs.writeFileSync(path.join(x.dir, 'Reading', 'MEGATAB.md'), 'a fox in a folder\n');
    const r = await x.call('search', { space: 'Me', q: 'fox' });
    assert.deepEqual(r.hits.map((h) => [h.folder ?? null, h.file, h.kind]), [[null, 'README.md', 'md'], [null, 'Board.canvas', 'canvas'], [null, 'Foxtrot.md', 'md'], ['Reading', 'MEGATAB.md', 'md']]);
    const hit = r.hits[0];
    assert.equal(hit.line, 3);
    assert.match(hit.snippet, /quick brown fox/);
    assert.equal(r.hits[1].node, 'n1');
    assert.equal(r.hits[2].inTitle, true);
    await fail(x.call('search', { space: 'Me', q: '   ' }), 'bad-query');
  }));

  test(`[${label}] search over 500 notes answers quickly`, S(async (x) => {
    for (let i = 0; i < 500; i++) fs.writeFileSync(path.join(x.dir, `note ${String(i).padStart(3, '0')}.md`), `# Note ${i}\n\n${'lorem ipsum dolor sit amet '.repeat(20)}\nneedle-${i}\n`);
    await x.call('list', { space: 'Me' }); // a first look, as the page has had before he types
    const t0 = performance.now();
    const r = await x.call('search', { space: 'Me', q: 'needle-417' });
    const ms = performance.now() - t0;
    assert.equal(r.hits.length, 1);
    assert.equal(r.hits[0].file, 'note 417.md');
    // the host answers in about 100 ms; the folder reads every file through the browser's API, so it gets more room here
    // (the page's own timing for the host path is in board-next.chromium.test.js); both well under a second even when the
    // other test files run beside this one
    assert.ok(ms < (label === 'host' ? 400 : 1200), `${Math.round(ms)} ms`);
  }));

  test(`[${label}] model (C52): a .glb or .gltf is read in chunks, byte for byte, top level and one folder down; it is read only: never listed, written, created, renamed or trashed`, S(async (x) => {
    const glb = fs.readFileSync(path.join(__dirname, 'fixtures', 'vase.glb'));
    const gltf = fs.readFileSync(path.join(__dirname, 'fixtures', 'vase.gltf'));
    fs.writeFileSync(path.join(x.dir, 'vase.glb'), glb);
    fs.writeFileSync(path.join(x.dir, 'Reading', 'vase.gltf'), gltf);
    const big = Buffer.concat([glb.subarray(0, 12), Buffer.alloc(MODEL_CHUNK * 2 + 777, 7)]); // 3 chunks, the first 12 bytes look like a glb
    fs.writeFileSync(path.join(x.dir, 'big.glb'), big);
    const readAll = async (args) => {
      const parts = [];
      let offset = 0;
      let sizes = null;
      for (;;) {
        const r = await x.call('model', { space: 'Me', ...args, offset });
        if (sizes) assert.deepEqual([r.size, r.mtime], sizes, 'size and mtime are the same in every chunk');
        sizes = [r.size, r.mtime];
        assert.equal(r.offset, offset);
        assert.ok(r.length <= MODEL_CHUNK && Buffer.from(r.data, 'base64').length === r.length);
        parts.push(Buffer.from(r.data, 'base64'));
        offset += r.length;
        if (r.done) return { bytes: Buffer.concat(parts), chunks: parts.length, size: r.size };
      }
    };
    const a = await readAll({ file: 'vase.glb' });
    assert.ok(a.bytes.equals(glb), 'the .glb comes back byte for byte');
    assert.equal(a.chunks, 1);
    const b = await readAll({ file: 'vase.gltf', folder: 'Reading' });
    assert.ok(b.bytes.equals(gltf), 'the .gltf in a mega tab folder comes back byte for byte');
    const c = await readAll({ file: 'big.glb' });
    assert.ok(c.bytes.equals(big) && c.chunks === 3, 'a model over one chunk comes in several and joins to the same bytes');
    // read only: the file list never shows a model, and no write op touches one
    const l = await x.call('list', { space: 'Me' });
    assert.deepEqual([...l.files, ...l.folders.flatMap((f) => f.files)].map((f) => f.file).sort(), []);
    await fail(x.call('write', { space: 'Me', file: 'vase.glb', text: 'x', base: null }), 'bad-type');
    await fail(x.call('create', { space: 'Me', file: 'new.glb', text: 'x' }), 'bad-type');
    await fail(x.call('rename', { space: 'Me', file: 'vase.glb', to: 'other.glb' }), 'bad-type');
    await fail(x.call('trash', { space: 'Me', file: 'vase.glb' }), 'bad-type');
    await fail(x.call('rename', { space: 'Me', file: 'a.md', to: 'a.glb' }), 'bad-type');
    assert.ok(fs.readFileSync(path.join(x.dir, 'vase.glb')).equals(glb), 'still the same bytes after every refused write');
    assert.deepEqual(fs.readdirSync(x.dir).sort(), ['Reading', 'big.glb', 'vase.glb']);
  }));

  test(`[${label}] model (C52): the path rules of notes apply; other types, a name that is not a plain name, a file that is not what its name says, a missing file, a bad offset, and a model over the size cap are refused`, S(async (x) => {
    const glb = fs.readFileSync(path.join(__dirname, 'fixtures', 'vase.glb'));
    fs.writeFileSync(path.join(x.dir, 'vase.glb'), glb);
    fs.writeFileSync(path.join(x.root, 'secret.glb'), glb);
    fs.writeFileSync(path.join(x.dir, 'note.txt'), 'x');
    fs.writeFileSync(path.join(x.dir, 'fake.glb'), 'this is a text file, not a glb');
    fs.writeFileSync(path.join(x.dir, 'fake.gltf'), Buffer.from(glb)); // a glb under a .gltf name
    fs.mkdirSync(path.join(x.dir, 'Reading', 'deeper'));
    fs.writeFileSync(path.join(x.dir, 'Reading', 'deeper', 'deep.glb'), glb);
    for (const bad of ['../secret.glb', '..', 'a/b.glb', 'sub\\a.glb', '', '.hidden.glb', ' a.glb', 'a\0.glb', 'a:b.glb']) await fail(x.call('model', { space: 'Me', file: bad }), 'bad-name');
    for (const bad of ['note.txt', 'vase.glb.txt', 'vase', 'a.md', 'a.canvas', 'vase.glbx']) await fail(x.call('model', { space: 'Me', file: bad }), 'bad-type');
    await fail(x.call('model', { space: '../Me', file: 'vase.glb' }), 'bad-name');
    await fail(x.call('model', { space: 'Me', folder: '..', file: 'vase.glb' }), 'bad-name');
    await fail(x.call('model', { space: 'Me', folder: 'Reading/deeper', file: 'deep.glb' }), 'bad-name'); // two levels down is out of reach
    await fail(x.call('model', { space: 'Me', file: 'fake.glb' }), 'bad-model');
    await fail(x.call('model', { space: 'Me', file: 'fake.gltf' }), 'bad-model');
    await fail(x.call('model', { space: 'Me', file: 'nope.glb' }), 'gone');
    await fail(x.call('model', { space: 'Me', folder: 'Nope', file: 'vase.glb' }), 'no-folder');
    for (const off of [-1, 1.5, '0', NaN]) await fail(x.call('model', { space: 'Me', file: 'vase.glb', offset: off }), 'bad-offset');
    await fail(x.call('model', { space: 'Me', file: 'vase.glb', offset: glb.length + 1 }), 'bad-offset');
    const end = await x.call('model', { space: 'Me', file: 'vase.glb', offset: glb.length });
    assert.deepEqual([end.length, end.data, end.done], [0, '', true], 'asking at the very end is an empty, finished answer');
    fs.writeFileSync(path.join(x.dir, 'huge.glb'), glb.subarray(0, 12));
    fs.truncateSync(path.join(x.dir, 'huge.glb'), MAX_MODEL + 1); // a sparse file one byte over the cap: no real I/O
    await fail(x.call('model', { space: 'Me', file: 'huge.glb' }), 'too-large');
  }));
}

test('[folder] a space that does not exist yet lists as empty, and the first note makes its folder', async () => {
  const x = setup(folderPath);
  try {
    const r = await x.call('list', { space: 'Fresh' });
    assert.deepEqual([r.files, r.folders], [[], []]);
    await x.call('create', { space: 'Fresh', file: 'First.md', text: '# First\n' });
    assert.equal(fs.readFileSync(path.join(x.root, 'Fresh', 'First.md'), 'utf8'), '# First\n');
    assert.deepEqual((await x.call('list', { space: 'Fresh' })).files.map((f) => f.file), ['First.md']);
  } finally {
    x.done();
  }
});

test('[folder] watch: an outside change is pushed within 2 s as the same { type: "changed", ...list } the host sends, and his own save too', async () => {
  const x = setup(folderPath);
  try {
    const pushes = [];
    x.store.onPush = (m) => pushes.push(m);
    await x.call('watch', { space: 'Me' });
    await sleep(150);
    assert.equal(pushes.length, 0, 'nothing changed, nothing pushed');
    const t0 = Date.now();
    fs.writeFileSync(path.join(x.dir, 'outside.md'), '# Outside\n');
    while (!pushes.length && Date.now() - t0 < 2000) await sleep(20);
    assert.equal(pushes.length, 1);
    assert.deepEqual([pushes[0].type, pushes[0].space], ['changed', 'Me']);
    assert.deepEqual(pushes[0].files.map((f) => f.file), ['outside.md']);
    assert.ok(Date.now() - t0 < 1000);
    const w = await x.call('create', { space: 'Me', file: 'mine.md', text: 'mine' });
    await sleep(200);
    assert.equal(pushes.length, 2);
    assert.equal(pushes[1].files.find((f) => f.file === 'mine.md').hash, w.hash, 'his own save comes back with the hash he has');
  } finally {
    x.done();
  }
});

test('[folder] requests run in order: a write and a read sent together see each other', async () => {
  const x = setup(folderPath);
  try {
    const [a, b] = await Promise.all([x.call('create', { space: 'Me', file: 'o.md', text: 'ordered' }), x.call('read', { space: 'Me', file: 'o.md' })]);
    assert.equal(b.hash, a.hash);
    await fail2(x.call('nonsense', {}), 'bad-request');
  } finally {
    x.done();
  }
  async function fail2(p, code) {
    await assert.rejects(p, (e) => e.code === code);
  }
});

test('the host and the folder agree on every code and every field name the page reads', () => {
  // the fields board.js and the canvas bundle read from an error
  const src = fs.readFileSync(path.join(__dirname, '..', 'extension', 'storage.js'), 'utf8');
  for (const field of ['theirs', 'reason', 'hash', 'size', 'gone']) assert.ok(src.includes(field), field);
  assert.ok(MAX_FILE >= 480 * 1024);
  assert.doesNotMatch(src, /\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon/, 'no network in the storage code');
});
