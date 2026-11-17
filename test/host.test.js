'use strict';
// The Board host (host/core.js, host/board-host.js) and its installer (install-host.js), tested without
// a browser. The "fake browser" here is a test that starts the host like Chrome does and speaks the
// native-messaging protocol over its stdio. Everything runs on temp folders; the real ~/Spaces and the
// real Chrome profile are never touched.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { createCore, HostError, sha, MAX_FILE, MODEL_CHUNK } = require('../host/core');
const { allowedOrigin, startedBy, idFromKey, idFromManifest, originOf } = require('../host/origin');
const { install, uninstall, extensionId, HOST_NAME } = require('../install-host');

const ROOT = path.join(__dirname, '..');
const KEY_ID = idFromManifest(path.join(ROOT, 'extension')); // the id of the key in extension/manifest.json; null in a copy that pins none
const OTHER_ID = 'ponmlkjihgfedcbaponmlkjihgfedcba';
const EXT_ID = KEY_ID || 'abcdefghijklmnopabcdefghijklmnop';
const ALLOWED_ORIGIN = originOf(EXT_ID);
const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const rm = (...d) => d.forEach((x) => fs.rmSync(x, { recursive: true, force: true }));

// A temp ~/Spaces with a space "Me"
function spaces() {
  const root = tmp('megatabs-host-');
  fs.mkdirSync(path.join(root, 'Me'));
  return root;
}
const code = (fn) => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof HostError, `not a HostError: ${e.stack}`);
    return e.code;
  }
  return 'no error';
};
const leftovers = (dir) => fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'));

test('the extension id: the default is the one from the manifest key; --id overrides it; a bad id or a copy with no key is an error', () => {
  if (KEY_ID) assert.equal(extensionId(), KEY_ID);
  assert.equal(extensionId(undefined, OTHER_ID), OTHER_ID);
  assert.throws(() => extensionId(undefined, 'nope'), /32 letters/);
  assert.throws(() => extensionId(undefined, EXT_ID.toUpperCase()), /32 letters/);
  const noKey = tmp('megatabs-nokey-');
  try {
    const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'extension', 'manifest.json'), 'utf8'));
    delete m.key;
    fs.writeFileSync(path.join(noKey, 'manifest.json'), JSON.stringify(m));
    assert.throws(() => extensionId(noKey), /pins no extension id/);
    assert.equal(extensionId(noKey, OTHER_ID), OTHER_ID, 'a copy with no key takes --id');
    assert.equal(allowedOrigin(['node', 'host'], noKey), null, 'no --origin and no key: nobody is allowed');
  } finally {
    rm(noKey);
  }
  const { key } = JSON.parse(fs.readFileSync(path.join(ROOT, 'extension', 'manifest.json'), 'utf8'));
  if (key) assert.equal(idFromKey(key), KEY_ID);
});

test('allowed origin: --origin names it, the key id is the fallback, and only a well-formed origin that Chrome also passed starts the host', () => {
  const a = ALLOWED_ORIGIN;
  const b = `chrome-extension://${OTHER_ID}/`;
  assert.equal(allowedOrigin(['node', 'h', '--origin', b, b]), b);
  if (KEY_ID) assert.equal(allowedOrigin(['node', 'h', a]), a, 'no --origin: the id of the key next to this checkout');
  for (const bad of ['', 'https://evil.test/', `chrome-extension://${OTHER_ID}`, 'chrome-extension://*/', `chrome-extension://${OTHER_ID.toUpperCase()}/`]) {
    assert.equal(allowedOrigin(['node', 'h', '--origin', bad, bad]), null, `--origin ${JSON.stringify(bad)}`);
  }
  assert.equal(allowedOrigin(['node', 'h', '--origin']), null);
  assert.equal(startedBy(['node', 'h', '--origin', b, b], b), true);
  assert.equal(startedBy(['node', 'h', '--root', '/x', '--origin', b, b], b), true);
  assert.equal(startedBy(['node', 'h', '--origin', b], b), false, 'the --origin value alone is not Chrome saying who started it');
  assert.equal(startedBy(['node', 'h', '--origin', b, a], b), false, 'another extension started it');
  assert.equal(startedBy(['node', 'h'], null), false);
});

test('path rules: only single .md names in a single space name; everything else is refused before the disk is touched', () => {
  const root = spaces();
  try {
    const c = createCore({ root });
    fs.writeFileSync(path.join(root, 'Me', 'a.md'), '# A\n');
    fs.writeFileSync(path.join(root, 'secret.md'), 'outside the space\n');
    for (const bad of ['../secret.md', '..', '.', 'a/b.md', 'sub\\a.md', '/etc/passwd', '', '.hidden.md', 'a\0.md', ' a.md', 'a.md ', 'x'.repeat(300) + '.md', 'a:b.md']) {
      assert.equal(code(() => c.read('Me', bad)), 'bad-name', `read ${JSON.stringify(bad)}`);
      assert.equal(code(() => c.write('Me', bad, 'x', null)), 'bad-name', `write ${JSON.stringify(bad)}`);
      assert.equal(code(() => c.create('Me', bad, 'x')), 'bad-name', `create ${JSON.stringify(bad)}`);
    }
    for (const bad of ['../Me', '..', '.', 'a/b', '', '.hidden', '/tmp']) {
      assert.equal(code(() => c.list(bad)), 'bad-name', `list space ${JSON.stringify(bad)}`);
      assert.equal(code(() => c.read(bad, 'a.md')), 'bad-name');
    }
    for (const bad of ['a.txt', 'a.md.txt', 'a', 'MEGATAB', 'a.markdown', 'a.json']) {
      assert.equal(code(() => c.read('Me', bad)), 'bad-type', `read ${bad}`);
      assert.equal(code(() => c.write('Me', bad, 'x', null)), 'bad-type');
      assert.equal(code(() => c.create('Me', bad, 'x')), 'bad-type');
    }
    assert.equal(code(() => c.read(7, 'a.md')), 'bad-name');
    assert.equal(code(() => c.read('Me', null)), 'bad-name');
    assert.equal(code(() => c.list('Nowhere')), 'no-space');
    assert.equal(fs.readFileSync(path.join(root, 'secret.md'), 'utf8'), 'outside the space\n');
    assert.deepEqual(fs.readdirSync(path.join(root, 'Me')), ['a.md'], 'nothing was created');
    assert.equal(c.read('Me', 'A.MD'.toLowerCase()).text, '# A\n');
  } finally {
    rm(root);
  }
});

test('symlinks: a link out of the folder is never read, written or listed; a linked space folder is refused; a linked Spaces root works', () => {
  const root = spaces();
  const outside = tmp('megatabs-outside-');
  try {
    const c = createCore({ root });
    fs.writeFileSync(path.join(outside, 'target.md'), 'outside\n');
    fs.writeFileSync(path.join(root, 'Me', 'real.md'), 'real\n');
    fs.symlinkSync(path.join(outside, 'target.md'), path.join(root, 'Me', 'link.md'));
    fs.symlinkSync(path.join(root, 'Me', 'real.md'), path.join(root, 'Me', 'inner.md')); // inside the folder, still refused
    fs.symlinkSync(path.join(outside, 'target.md'), path.join(root, 'Me', 'dangling-to-existing.md'));
    assert.equal(code(() => c.read('Me', 'link.md')), 'symlink');
    assert.equal(code(() => c.read('Me', 'inner.md')), 'symlink');
    assert.equal(code(() => c.write('Me', 'link.md', 'pwn', sha(Buffer.from('outside\n')))), 'symlink');
    assert.equal(code(() => c.create('Me', 'link.md', 'pwn')), 'symlink', 'a link occupying the name is never replaced by a create');
    assert.equal(fs.readFileSync(path.join(outside, 'target.md'), 'utf8'), 'outside\n', 'the file the link points to is untouched');
    assert.ok(fs.lstatSync(path.join(root, 'Me', 'link.md')).isSymbolicLink(), 'the link itself is untouched');
    assert.deepEqual(c.list('Me').files.map((f) => f.file), ['real.md'], 'links are not listed');
    // A space folder that is a symlink
    fs.symlinkSync(outside, path.join(root, 'Linked'));
    assert.equal(code(() => c.list('Linked')), 'symlink');
    assert.equal(code(() => c.read('Linked', 'target.md')), 'symlink');
    assert.equal(code(() => c.create('Linked', 'new.md', 'x')), 'symlink');
    assert.ok(!fs.existsSync(path.join(outside, 'new.md')));
    // Hard link: refused too (it can lead anywhere)
    fs.linkSync(path.join(outside, 'target.md'), path.join(root, 'Me', 'hard.md'));
    assert.equal(code(() => c.read('Me', 'hard.md')), 'hardlink');
    // ~/Spaces itself a symlink (iCloud-style setups): fine, its real path is the root
    const via = tmp('megatabs-via-');
    fs.rmSync(via, { recursive: true });
    fs.symlinkSync(root, via);
    try {
      assert.equal(createCore({ root: via }).read('Me', 'real.md').text, 'real\n');
    } finally {
      fs.rmSync(via);
    }
  } finally {
    rm(root, outside);
  }
});

test('list shows only top-level .md files when there are no canvases (no folders, other extensions, hidden files, MEGATAB.md in a mega tab folder); README first', () => {
  const root = spaces();
  try {
    const d = path.join(root, 'Me');
    fs.mkdirSync(path.join(d, 'Reading'));
    fs.writeFileSync(path.join(d, 'Reading', 'MEGATAB.md'), 'mega\n');
    fs.writeFileSync(path.join(d, 'b.md'), '# Bee\n');
    fs.writeFileSync(path.join(d, 'README.md'), 'no heading\n');
    fs.writeFileSync(path.join(d, 'a.MD'), '#   Aye  #\n');
    fs.writeFileSync(path.join(d, 'x.txt'), 'x');
    fs.writeFileSync(path.join(d, '.h.md'), 'h');
    fs.writeFileSync(path.join(d, 'folder.md.d'), 'x');
    fs.writeFileSync(path.join(d, 'bad.md'), Buffer.from([0xff, 0xfe, 0x41]));
    const c = createCore({ root });
    const l = c.list('Me');
    assert.deepEqual(l.files.map((f) => [f.file, f.title]), [['README.md', 'README'], ['a.MD', 'Aye'], ['b.md', 'Bee'], ['bad.md', 'bad']]);
    assert.equal(l.files[3].unreadable, 'not-utf8');
    assert.equal(l.files[0].hash, sha(Buffer.from('no heading\n')));
    assert.equal(l.files[0].path, path.join(d, 'README.md'));
    assert.equal(code(() => c.read('Me', 'Reading/MEGATAB.md')), 'bad-name', 'a file in a mega tab folder is out of reach');
    assert.equal(code(() => c.read('Me', 'bad.md')), 'not-utf8');
  } finally {
    rm(root);
  }
});

test('save is byte-exact: BOM, CRLF, front matter, blank lines, no final newline, emoji; a non-UTF-8 file is refused, not altered', () => {
  const root = spaces();
  try {
    const c = createCore({ root });
    const abs = path.join(root, 'Me', 'n.md');
    const texts = [
      '---\ntitle: x\nurls:\n  - https://a.test\n---\n\n\nBody with trailing spaces   \n\n\n',
      '﻿# BOM first\r\nCRLF line\r\n',
      'no final newline, emoji 🚀 and umlaut ä',
      '',
      '\n',
    ];
    c.create('Me', 'n.md', texts[0]);
    assert.deepEqual(fs.readFileSync(abs), Buffer.from(texts[0], 'utf8'));
    let base = c.read('Me', 'n.md').hash;
    for (const t of texts.slice(1)) {
      const r = c.write('Me', 'n.md', t, base);
      assert.deepEqual(fs.readFileSync(abs), Buffer.from(t, 'utf8'), `bytes of ${JSON.stringify(t)}`);
      assert.equal(r.hash, sha(Buffer.from(t, 'utf8')));
      const back = c.read('Me', 'n.md');
      assert.equal(back.text, t, 'what is read is what was written, BOM included');
      assert.equal(back.hash, r.hash);
      base = r.hash;
    }
    // Saving what was loaded changes no byte
    const before = fs.readFileSync(abs);
    c.write('Me', 'n.md', c.read('Me', 'n.md').text, base);
    assert.deepEqual(fs.readFileSync(abs), before);
    // Not UTF-8 on disk: never rewritten
    const bad = Buffer.from([0x23, 0x20, 0xe9, 0x0a]);
    fs.writeFileSync(path.join(root, 'Me', 'latin.md'), bad);
    assert.equal(code(() => c.read('Me', 'latin.md')), 'not-utf8');
    assert.equal(code(() => c.write('Me', 'latin.md', '# new\n', null)), 'conflict', 'a save that does not name its exact bytes comes back as a conflict');
    assert.equal(code(() => c.write('Me', 'latin.md', '# new\n', 'f'.repeat(64))), 'conflict');
    assert.deepEqual(fs.readFileSync(path.join(root, 'Me', 'latin.md')), bad, 'never altered unless the caller names the exact hash');
    // A lone surrogate cannot be written as UTF-8 faithfully: refused
    assert.equal(code(() => c.write('Me', 'n.md', 'a\ud800b', base)), 'bad-text');
    assert.equal(code(() => c.write('Me', 'n.md', 5, base)), 'bad-text');
    // Size cap
    assert.equal(code(() => c.write('Me', 'n.md', 'x'.repeat(MAX_FILE + 1), base)), 'too-large');
    assert.equal(c.write('Me', 'n.md', 'x'.repeat(MAX_FILE), base).size, MAX_FILE);
  } finally {
    rm(root);
  }
});

test('save is atomic: the file is replaced (new inode), no temp file is left, the mode is kept, and a failed save leaves the original', () => {
  const root = spaces();
  const dir = path.join(root, 'Me');
  try {
    const c = createCore({ root });
    const abs = path.join(dir, 'a.md');
    fs.writeFileSync(abs, 'one\n');
    fs.chmodSync(abs, 0o640);
    const ino = fs.statSync(abs).ino;
    const r = c.write('Me', 'a.md', 'two\n', sha(Buffer.from('one\n')));
    assert.notEqual(fs.statSync(abs).ino, ino, 'replaced by rename, not rewritten in place');
    assert.equal(fs.statSync(abs).mode & 0o777, 0o640, 'permissions kept');
    assert.deepEqual(leftovers(dir), []);
    assert.deepEqual(fs.readdirSync(dir), ['a.md'], 'no stray files, not even hidden ones');
    assert.equal(r.hash, sha(Buffer.from('two\n')));
    // A new file gets the usual 0644-ish mode (umask applies to nothing here: chmod is explicit)
    c.create('Me', 'new.md', 'n\n');
    assert.equal(fs.statSync(path.join(dir, 'new.md')).mode & 0o777, 0o644);
    // Failure: the folder cannot be written to. The original stays, no temp file is left.
    fs.chmodSync(dir, 0o500);
    try {
      assert.equal(code(() => c.write('Me', 'a.md', 'three\n', r.hash)), 'io');
      assert.equal(code(() => c.create('Me', 'brand-new.md', 'x')), 'io');
    } finally {
      fs.chmodSync(dir, 0o700);
    }
    assert.equal(fs.readFileSync(abs, 'utf8'), 'two\n');
    assert.deepEqual(leftovers(dir), []);
    assert.ok(!fs.existsSync(path.join(dir, 'brand-new.md')));
  } finally {
    fs.chmodSync(dir, 0o700);
    rm(root);
  }
});

test('conflict: a save whose base is stale writes nothing and returns their text; the right base writes; create never replaces', () => {
  const root = spaces();
  try {
    const c = createCore({ root });
    const abs = path.join(root, 'Me', 'a.md');
    c.create('Me', 'a.md', 'v1\n');
    const loaded = c.read('Me', 'a.md');
    // Someone else (Claude Code, Cursor) saves in the meantime
    fs.writeFileSync(abs, 'v2 from outside\n');
    let err;
    try {
      c.write('Me', 'a.md', 'v1 mine\n', loaded.hash);
    } catch (e) {
      err = e;
    }
    assert.equal(err?.code, 'conflict');
    assert.equal(err.extra.reason, 'changed');
    assert.equal(err.extra.theirs.text, 'v2 from outside\n');
    assert.equal(err.extra.theirs.hash, sha(Buffer.from('v2 from outside\n')));
    assert.equal(fs.readFileSync(abs, 'utf8'), 'v2 from outside\n', 'theirs is untouched');
    assert.deepEqual(leftovers(path.join(root, 'Me')), []);
    // "Keep mine": the caller takes their hash as the new base, then the save goes through
    c.write('Me', 'a.md', 'v1 mine\n', err.extra.theirs.hash);
    assert.equal(fs.readFileSync(abs, 'utf8'), 'v1 mine\n');
    // Deleted meanwhile: refused, not silently re-created
    const h = sha(Buffer.from('v1 mine\n'));
    fs.rmSync(abs);
    assert.equal(code(() => c.write('Me', 'a.md', 'x', h)), 'conflict');
    assert.ok(!fs.existsSync(abs));
    // base null means "this must not exist": create refuses an existing name, whatever the case of the text
    fs.writeFileSync(abs, 'taken\n');
    assert.equal(code(() => c.create('Me', 'a.md', 'new\n')), 'conflict');
    assert.equal(code(() => c.write('Me', 'a.md', 'new\n', null)), 'conflict');
    assert.equal(fs.readFileSync(abs, 'utf8'), 'taken\n');
    assert.equal(code(() => c.write('Me', 'a.md', 'x', 'not-a-hash')), 'bad-base');
    assert.equal(code(() => c.write('Me', 'a.md', 'x', 'A'.repeat(64))), 'bad-base');
  } finally {
    rm(root);
  }
});

test('a missing Spaces folder is an error, never created', () => {
  const parent = tmp('megatabs-noroot-');
  try {
    const root = path.join(parent, 'Spaces');
    const c = createCore({ root });
    assert.equal(code(() => c.list('Me')), 'no-root');
    assert.equal(code(() => c.create('Me', 'a.md', 'x')), 'no-root');
    assert.deepEqual(fs.readdirSync(parent), []);
  } finally {
    rm(parent);
  }
});

test('signature changes on an outside write, a new file and a removal, not on a non-.md file', () => {
  const root = spaces();
  try {
    const c = createCore({ root });
    const d = path.join(root, 'Me');
    fs.writeFileSync(path.join(d, 'a.md'), 'a\n');
    const s0 = c.signature('Me');
    assert.equal(c.signature('Me'), s0);
    fs.writeFileSync(path.join(d, 'x.txt'), 'x');
    assert.equal(c.signature('Me'), s0);
    fs.appendFileSync(path.join(d, 'a.md'), 'more\n');
    const s1 = c.signature('Me');
    assert.notEqual(s1, s0);
    fs.writeFileSync(path.join(d, 'b.md'), 'b\n');
    const s2 = c.signature('Me');
    assert.notEqual(s2, s1);
    fs.rmSync(path.join(d, 'b.md'));
    assert.notEqual(c.signature('Me'), s2);
  } finally {
    rm(root);
  }
});

// ---------------------------------------------------------------- the host process, driven like Chrome drives it

// origin: what Chrome passes (the calling page's origin); allow: what the launcher names with --origin (null: no launcher)
function startHost(root, { origin = ALLOWED_ORIGIN, allow = ALLOWED_ORIGIN, args = [] } = {}) {
  const proc = spawn(process.execPath, [path.join(ROOT, 'host', 'board-host.js'), ...(origin ? [origin] : []), ...(allow ? ['--origin', allow] : []), '--root', root, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = Buffer.alloc(0);
  const inbox = [];
  const waiters = [];
  let stderr = '';
  proc.stderr.on('data', (d) => (stderr += d));
  proc.stdout.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32LE(0)) {
      const len = buf.readUInt32LE(0);
      const msg = JSON.parse(buf.subarray(4, 4 + len).toString('utf8'));
      buf = buf.subarray(4 + len);
      const w = waiters.findIndex((x) => x.match(msg));
      if (w >= 0) waiters.splice(w, 1)[0].resolve(msg);
      else inbox.push(msg);
    }
  });
  const exited = new Promise((r) => proc.once('exit', (code, sig) => r({ code, sig })));
  const frame = (obj) => {
    const body = Buffer.from(JSON.stringify(obj));
    const head = Buffer.alloc(4);
    head.writeUInt32LE(body.length);
    return Buffer.concat([head, body]);
  };
  const next = (match, ms = 5000) =>
    new Promise((resolve, reject) => {
      const i = inbox.findIndex(match);
      if (i >= 0) return resolve(inbox.splice(i, 1)[0]);
      const w = { match, resolve };
      waiters.push(w);
      setTimeout(() => {
        const k = waiters.indexOf(w);
        if (k >= 0) {
          waiters.splice(k, 1);
          reject(new Error(`no message within ${ms} ms (stderr: ${stderr})`));
        }
      }, ms);
    });
  let id = 0;
  const call = (type, args = {}) => {
    const my = ++id;
    proc.stdin.write(frame({ id: my, type, ...args }));
    return next((m) => m.id === my);
  };
  return { proc, call, next, exited, frame, stderr: () => stderr, close: () => proc.stdin.end() };
}

test('host process: list, read, write, create and conflict over the native-messaging protocol', async () => {
  const root = spaces();
  const h = startHost(root);
  try {
    fs.writeFileSync(path.join(root, 'Me', 'a.md'), '# Alpha\n');
    const l = await h.call('list', { space: 'Me' });
    assert.equal(l.ok, true);
    assert.deepEqual(l.files.map((f) => f.title), ['Alpha']);
    const r = await h.call('read', { space: 'Me', file: 'a.md' });
    assert.deepEqual([r.ok, r.text, r.hash], [true, '# Alpha\n', sha(Buffer.from('# Alpha\n'))]);
    const w = await h.call('write', { space: 'Me', file: 'a.md', text: '# Alpha 2\n', base: r.hash });
    assert.equal(w.ok, true);
    assert.equal(fs.readFileSync(path.join(root, 'Me', 'a.md'), 'utf8'), '# Alpha 2\n');
    const stale = await h.call('write', { space: 'Me', file: 'a.md', text: 'mine\n', base: r.hash });
    assert.equal(stale.error, 'conflict');
    assert.equal(stale.theirs.text, '# Alpha 2\n');
    assert.equal(fs.readFileSync(path.join(root, 'Me', 'a.md'), 'utf8'), '# Alpha 2\n');
    const c1 = await h.call('create', { space: 'Me', file: 'new.md', text: '# New\n' });
    assert.equal(c1.ok, true);
    const c2 = await h.call('create', { space: 'Me', file: 'new.md', text: 'again\n' });
    assert.equal(c2.error, 'conflict');
    assert.equal(fs.readFileSync(path.join(root, 'Me', 'new.md'), 'utf8'), '# New\n');
    // Refusals come back as answers, the host stays up
    assert.equal((await h.call('read', { space: 'Me', file: '../x.md' })).error, 'bad-name');
    assert.equal((await h.call('read', { space: 'Me', file: 'x.txt' })).error, 'bad-type');
    assert.equal((await h.call('delete', { space: 'Me', file: 'a.md' })).error, 'bad-request');
    assert.equal((await h.call('constructor', {})).error, 'bad-request');
    assert.equal((await h.call('ping')).ok, true);
    // Garbage that is not JSON gets an error answer too
    const junk = Buffer.from('{nope');
    const head = Buffer.alloc(4);
    head.writeUInt32LE(junk.length);
    h.proc.stdin.write(Buffer.concat([head, junk]));
    assert.equal((await h.next((m) => m.error === 'bad-request')).error, 'bad-request');
    assert.equal((await h.call('ping')).ok, true);
  } finally {
    h.proc.kill();
    rm(root);
  }
});

test('host process: watch pushes a change within 2 s for an outside write, a new file and a removal; the host exits when the page goes', async () => {
  const root = spaces();
  const h = startHost(root);
  try {
    const d = path.join(root, 'Me');
    fs.writeFileSync(path.join(d, 'a.md'), '# A\n');
    assert.equal((await h.call('watch', { space: 'Me' })).ok, true);
    const t0 = Date.now();
    fs.appendFileSync(path.join(d, 'a.md'), 'echo >> from outside\n');
    const m1 = await h.next((m) => m.type === 'changed', 2000);
    assert.ok(Date.now() - t0 < 2000);
    assert.equal(m1.space, 'Me');
    assert.equal(m1.files[0].hash, sha(Buffer.from('# A\necho >> from outside\n')));
    fs.writeFileSync(path.join(d, 'b.md'), '# B\n');
    const m2 = await h.next((m) => m.type === 'changed', 2000);
    assert.deepEqual(m2.files.map((f) => f.file), ['a.md', 'b.md']);
    fs.rmSync(path.join(d, 'b.md'));
    const m3 = await h.next((m) => m.type === 'changed', 2000);
    assert.deepEqual(m3.files.map((f) => f.file), ['a.md']);
    // A file that is not .md changes nothing the Board shows
    fs.writeFileSync(path.join(d, 'x.txt'), 'x');
    await assert.rejects(h.next((m) => m.type === 'changed', 1500));
    // Watching a bad space is refused
    assert.equal((await h.call('watch', { space: '../x' })).error, 'bad-name');
    h.close();
    const ex = await Promise.race([h.exited, new Promise((r) => setTimeout(() => r(null), 3000))]);
    assert.ok(ex && ex.code === 0, `the host exits when its input closes: ${JSON.stringify(ex)}`);
  } finally {
    h.proc.kill();
    rm(root);
  }
});

test('host process: refuses to run unless started with our extension origin, or with a request that is far too big', async () => {
  const root = spaces();
  try {
    for (const origin of [null, `chrome-extension://${OTHER_ID}/`, ALLOWED_ORIGIN.slice(0, -1), 'https://evil.test/']) {
      const h = startHost(root, { origin });
      const ex = await h.exited;
      assert.equal(ex.code, 2, `origin ${origin}`);
      assert.match(h.stderr(), /not started by the megatabs extension/);
    }
    // The launcher's --origin names the one extension: it starts the host, and every other origin is refused
    const b = `chrome-extension://${OTHER_ID}/`;
    const named = startHost(root, { origin: b, allow: b });
    await named.call('ping');
    named.proc.stdin.end();
    await named.exited;
    for (const [origin, allow] of [[ALLOWED_ORIGIN, b], [b, ALLOWED_ORIGIN], [b, 'chrome-extension://*/'], [null, b]]) {
      const h = startHost(root, { origin, allow });
      assert.equal((await h.exited).code, 2, `origin ${origin} with --origin ${allow}`);
    }
    if (KEY_ID) {
      // A launcher from before --origin existed: the id of the key next to this checkout is the one allowed
      const old = startHost(root, { allow: null });
      await old.call('ping');
      old.proc.stdin.end();
      await old.exited;
      assert.equal((await startHost(root, { origin: b, allow: null }).exited).code, 2);
    }
    const h = startHost(root);
    await h.call('ping');
    const head = Buffer.alloc(4);
    head.writeUInt32LE(50 * 1024 * 1024);
    h.proc.stdin.write(head);
    assert.equal((await h.exited).code, 3, 'a 50 MB request makes it exit');
  } finally {
    rm(root);
  }
});

test('no network anywhere in the host or the installer: only fs, path, os and crypto are used', () => {
  const files = ['host/core.js', 'host/board-host.js', 'host/origin.js', 'install-host.js'].map((f) => path.join(ROOT, f));
  const allowed = new Set(['node:fs', 'node:path', 'node:os', 'node:crypto', './core', './origin', './host/origin']);
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const [, mod] of src.matchAll(/require\('([^']+)'\)/g)) assert.ok(allowed.has(mod), `${path.basename(f)} requires ${mod}`);
    assert.doesNotMatch(src, /\b(fetch|XMLHttpRequest|WebSocket)\b|child_process|node:(net|http|https|dgram|dns|tls)/, path.basename(f));
  }
  // The Board page (extension side) makes no request either: it talks to the host only
  const board = fs.readFileSync(path.join(ROOT, 'extension', 'board.js'), 'utf8');
  assert.match(board, /connectNative\(HOST\)/);
  assert.doesNotMatch(board.replace(/\/\/.*$/gm, ''), /\bfetch\(|XMLHttpRequest|WebSocket/);
});

// ---------------------------------------------------------------- .canvas files

test('canvas: .canvas files are listed with their kind, read and written byte for byte, atomically; the path rules are the same as for .md', () => {
  const root = spaces();
  try {
    const d = path.join(root, 'Me');
    const c = createCore({ root });
    fs.writeFileSync(path.join(d, 'b.md'), '# Bee\n');
    const first = '{\n\t"nodes": [],\n\t"edges": []\n}';
    c.create('Me', 'Board.canvas', first);
    assert.deepEqual(fs.readFileSync(path.join(d, 'Board.canvas')), Buffer.from(first));
    fs.writeFileSync(path.join(d, 'Other.CANVAS'), '{}');
    fs.mkdirSync(path.join(d, 'sub.canvas'));
    fs.writeFileSync(path.join(d, '.hidden.canvas'), '{}');
    fs.writeFileSync(path.join(d, 'x.json'), '{}');
    const l = c.list('Me');
    assert.deepEqual(l.files.map((f) => [f.file, f.kind, f.title]), [['b.md', 'md', 'Bee'], ['Board.canvas', 'canvas', 'Board'], ['Other.CANVAS', 'canvas', 'Other']]);
    assert.equal(l.files[1].hash, sha(Buffer.from(first)));
    // Written back as text, atomically: new inode, no temp file, the mode kept
    const ino = fs.statSync(path.join(d, 'Board.canvas')).ino;
    const next = '{"nodes":[{"id":"a","type":"text","text":"é 🚀","x":0,"y":0,"width":1,"height":1}],"edges":[]}';
    const r = c.write('Me', 'Board.canvas', next, c.read('Me', 'Board.canvas').hash);
    assert.equal(fs.readFileSync(path.join(d, 'Board.canvas'), 'utf8'), next);
    assert.notEqual(fs.statSync(path.join(d, 'Board.canvas')).ino, ino);
    assert.equal(r.hash, sha(Buffer.from(next)));
    assert.deepEqual(leftovers(d), []);
    // A stale base is a conflict that carries their text; create never replaces
    assert.equal(code(() => c.write('Me', 'Board.canvas', '{}', sha(Buffer.from(first)))), 'conflict');
    assert.equal(code(() => c.create('Me', 'Board.canvas', '{}')), 'conflict');
    assert.equal(fs.readFileSync(path.join(d, 'Board.canvas'), 'utf8'), next);
    // The names are checked as before
    for (const bad of ['../Board.canvas', 'a/b.canvas', '.x.canvas', ' a.canvas', 'a\0.canvas']) {
      assert.equal(code(() => c.read('Me', bad)), 'bad-name', bad);
      assert.equal(code(() => c.create('Me', bad, '{}')), 'bad-name', bad);
    }
    for (const bad of ['a.canvas.txt', 'a.json', 'a.excalidraw', 'canvas']) assert.equal(code(() => c.read('Me', bad)), 'bad-type', bad);
    assert.equal(code(() => c.read('Me', 'sub.canvas')), 'not-file');
  } finally {
    rm(root);
  }
});

test('canvas: a .canvas that is not a JSON object is refused on write (the other readers could not open it); a canvas file may not be a symlink or leave the folder', () => {
  const root = spaces();
  const outside = tmp('megatabs-outside-');
  try {
    const d = path.join(root, 'Me');
    const c = createCore({ root });
    for (const bad of ['', 'not json', '[]', '"x"', '3', 'null', '{"nodes": ']) {
      assert.equal(code(() => c.create('Me', 'x.canvas', bad)), 'bad-text', JSON.stringify(bad));
    }
    assert.ok(!fs.existsSync(path.join(d, 'x.canvas')), 'nothing was written');
    // A note is not checked this way
    c.create('Me', 'x.md', 'not json');
    fs.writeFileSync(path.join(outside, 'secret.canvas'), '{"secret":true}');
    fs.symlinkSync(path.join(outside, 'secret.canvas'), path.join(d, 'link.canvas'));
    assert.deepEqual(c.list('Me').files.map((f) => f.file), ['x.md'], 'a symlinked canvas is not even listed');
    assert.equal(code(() => c.read('Me', 'link.canvas')), 'symlink');
    assert.equal(code(() => c.write('Me', 'link.canvas', '{}', sha(Buffer.from('{"secret":true}')))), 'symlink');
    assert.equal(fs.readFileSync(path.join(outside, 'secret.canvas'), 'utf8'), '{"secret":true}');
    // Over the size cap
    assert.equal(code(() => c.create('Me', 'big.canvas', JSON.stringify({ pad: 'x'.repeat(MAX_FILE + 1024) }))), 'too-large');
  } finally {
    rm(root, outside);
  }
});

test('canvas: the watcher fingerprint changes when a .canvas is written, added or removed', () => {
  const root = spaces();
  try {
    const c = createCore({ root });
    const d = path.join(root, 'Me');
    c.create('Me', 'a.canvas', '{}');
    const s0 = c.signature('Me');
    fs.writeFileSync(path.join(d, 'a.canvas'), '{"nodes":[]}');
    const s1 = c.signature('Me');
    assert.notEqual(s1, s0);
    fs.writeFileSync(path.join(d, 'b.canvas'), '{}');
    assert.notEqual(c.signature('Me'), s1);
  } finally {
    rm(root);
  }
});

test('host process: a .canvas is listed, written with a base hash, and an outside write to it is pushed within 2 s', async () => {
  const root = spaces();
  const h = startHost(root);
  try {
    const d = path.join(root, 'Me');
    fs.writeFileSync(path.join(d, 'Board.canvas'), '{"nodes":[],"edges":[]}');
    const l = await h.call('list', { space: 'Me' });
    assert.deepEqual(l.files.map((f) => [f.file, f.kind]), [['Board.canvas', 'canvas']]);
    const r = await h.call('read', { space: 'Me', file: 'Board.canvas' });
    const w = await h.call('write', { space: 'Me', file: 'Board.canvas', text: '{"nodes":[],"edges":[],"x-strokes":[]}', base: r.hash });
    assert.equal(w.ok, true);
    assert.equal((await h.call('write', { space: 'Me', file: 'Board.canvas', text: 'nope', base: w.hash })).error, 'bad-text');
    assert.equal((await h.call('write', { space: 'Me', file: 'Board.canvas', text: '{}', base: r.hash })).error, 'conflict');
    assert.equal((await h.call('read', { space: 'Me', file: 'x.json' })).error, 'bad-type');
    assert.equal((await h.call('watch', { space: 'Me' })).ok, true);
    const t0 = Date.now();
    fs.writeFileSync(path.join(d, 'Board.canvas'), '{"nodes":[{"id":"a","type":"text","text":"AI","x":0,"y":0,"width":1,"height":1}],"edges":[]}');
    const m = await h.next((x) => x.type === 'changed', 2000);
    assert.ok(Date.now() - t0 < 2000);
    assert.equal(m.files[0].kind, 'canvas');
    assert.equal(m.files[0].hash, sha(Buffer.from('{"nodes":[{"id":"a","type":"text","text":"AI","x":0,"y":0,"width":1,"height":1}],"edges":[]}')));
    h.close();
  } finally {
    h.proc.kill();
    rm(root);
  }
});

// ---------------------------------------------------------------- installer

test('installer: writes the manifest for exactly our extension id and a launcher that starts the host; uninstall removes both', async () => {
  const manifestDir = tmp('megatabs-nmh-');
  const wrapperDir = path.join(tmp('megatabs-wrap-'), 'Megatabs');
  const root = spaces();
  try {
    const before = fs.readdirSync(manifestDir);
    const r = install({ manifestDir, wrapperDir, spaces: root, id: EXT_ID });
    // The manifest read back from disk
    const m = JSON.parse(fs.readFileSync(path.join(manifestDir, `${HOST_NAME}.json`), 'utf8'));
    assert.equal(m.name, HOST_NAME);
    assert.equal(m.type, 'stdio');
    assert.deepEqual(m.allowed_origins, [`chrome-extension://${EXT_ID}/`], 'one extension id, no wildcard');
    assert.ok(path.isAbsolute(m.path));
    assert.equal(m.path, r.wrapper);
    assert.ok(fs.statSync(m.path).mode & 0o100, 'launcher is executable');
    assert.deepEqual(fs.readdirSync(manifestDir).sort(), [...before, `${HOST_NAME}.json`].sort(), 'only the manifest was added there');
    assert.deepEqual(fs.readdirSync(wrapperDir), ['board-host'], 'only the launcher was added there');
    assert.match(fs.readFileSync(m.path, 'utf8'), new RegExp(`^#!/bin/sh\\nexec '.*node' '.*host/board-host\\.js' --root '.*' --origin '${ALLOWED_ORIGIN}' "\\$@"\\n$`));
    // Started the way Chrome starts it: path from the manifest, origin as the one argument, a bare PATH
    const proc = spawn(m.path, [m.allowed_origins[0]], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin' } });
    const body = Buffer.from(JSON.stringify({ id: 1, type: 'list', space: 'Me' }));
    const head = Buffer.alloc(4);
    head.writeUInt32LE(body.length);
    proc.stdin.write(Buffer.concat([head, body]));
    const answer = await new Promise((resolve, reject) => {
      let b = Buffer.alloc(0);
      proc.stdout.on('data', (d) => {
        b = Buffer.concat([b, d]);
        if (b.length >= 4 && b.length >= 4 + b.readUInt32LE(0)) resolve(JSON.parse(b.subarray(4, 4 + b.readUInt32LE(0)).toString('utf8')));
      });
      setTimeout(() => reject(new Error('launcher gave no answer')), 5000);
    });
    proc.stdin.end();
    assert.equal(answer.ok, true);
    assert.equal(answer.dir, path.join(root, 'Me'), 'the launcher pins the folder it serves');
    // --id: the manifest and the launcher name that extension instead, and the launcher's host refuses the default id
    install({ manifestDir, wrapperDir, spaces: root, id: OTHER_ID });
    const m2 = JSON.parse(fs.readFileSync(path.join(manifestDir, `${HOST_NAME}.json`), 'utf8'));
    assert.deepEqual(m2.allowed_origins, [`chrome-extension://${OTHER_ID}/`]);
    for (const [origin, code] of [[m2.allowed_origins[0], null], [ALLOWED_ORIGIN, 2]]) {
      const p2 = spawn(m2.path, [origin], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin' } });
      if (code === null) {
        p2.stdin.end();
        assert.equal((await new Promise((r) => p2.once('exit', r))), 0, 'the id it was installed for starts it');
      } else assert.equal((await new Promise((r) => p2.once('exit', r))), code, 'the default id is refused once --id named another');
    }
    assert.throws(() => install({ manifestDir, wrapperDir, spaces: root, id: 'short' }), /32 letters/);
    // Install twice: same result, no duplicates
    install({ manifestDir, wrapperDir, spaces: root, id: EXT_ID });
    assert.deepEqual(fs.readdirSync(manifestDir).sort(), [...before, `${HOST_NAME}.json`].sort());
    if (KEY_ID) {
      install({ manifestDir, wrapperDir, spaces: root }); // no --id: this checkout's own id
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(manifestDir, `${HOST_NAME}.json`), 'utf8')).allowed_origins, [ALLOWED_ORIGIN]);
    }
    // Uninstall removes exactly those two files (and the launcher folder when empty), nothing else
    fs.writeFileSync(path.join(manifestDir, 'com.other.host.json'), '{}');
    const u = uninstall({ manifestDir, wrapperDir });
    assert.equal(u.removed.length, 2);
    assert.deepEqual(fs.readdirSync(manifestDir).sort(), [...before, 'com.other.host.json'].sort());
    assert.ok(!fs.existsSync(wrapperDir));
    assert.deepEqual(uninstall({ manifestDir, wrapperDir }).removed, [], 'a second uninstall has nothing to do');
    // The command line does the same
    const cli = (...a) => execFileSync(process.execPath, [path.join(ROOT, 'install-host.js'), ...a, '--manifest-dir', manifestDir, '--wrapper-dir', wrapperDir], { encoding: 'utf8' });
    if (KEY_ID) assert.match(cli('--spaces', root), new RegExp(`installed for extension ${KEY_ID}`), 'no --id: the key id');
    assert.match(cli('--id', EXT_ID, '--spaces', root), new RegExp(`installed for extension ${EXT_ID}`));
    assert.match(cli('--check'), new RegExp(`manifest present[\\s\\S]*launcher present[\\s\\S]*allows: ${ALLOWED_ORIGIN}`));
    const withId = execFileSync(process.execPath, [path.join(ROOT, 'install-host.js'), '--id', OTHER_ID, '--manifest-dir', manifestDir, '--wrapper-dir', wrapperDir, '--spaces', root], { encoding: 'utf8' });
    assert.match(withId, new RegExp(`installed for extension ${OTHER_ID}`));
    const bad = require('node:child_process').spawnSync(process.execPath, [path.join(ROOT, 'install-host.js'), '--id', 'nope', '--manifest-dir', manifestDir, '--wrapper-dir', wrapperDir], { encoding: 'utf8' });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /32 letters/);
    execFileSync(process.execPath, [path.join(ROOT, 'install-host.js'), '--uninstall', '--manifest-dir', manifestDir, '--wrapper-dir', wrapperDir]);
    assert.ok(!fs.existsSync(path.join(manifestDir, `${HOST_NAME}.json`)));
  } finally {
    rm(manifestDir, path.dirname(wrapperDir), root);
  }
});

test('manifest asks for nativeMessaging and the Board connects to the host the installer names', () => {
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'extension', 'manifest.json'), 'utf8'));
  assert.ok(m.permissions.includes('nativeMessaging'));
  assert.match(fs.readFileSync(path.join(ROOT, 'extension', 'board.js'), 'utf8'), new RegExp(`const HOST = '${HOST_NAME.replace(/\./g, '\\.')}'`));
});

// ---------------------------------------------------------------- slice 1: review fixes (REVIEW-0.9.0 #1, #9, #10)

// A canvas as the pen makes it: tab-indented JSON, every number of every point on its own line
function penCanvas(strokes, points = 57) {
  const out = [];
  for (let s = 0; s < strokes; s++) {
    out.push({ id: `s${s}`, points: Array.from({ length: points }, (_, i) => [Math.round((s * 7 + i * 3.1) * 10) / 10, Math.round((s * 5 + Math.sin(i) * 40) * 10) / 10]), width: 3 });
  }
  return JSON.stringify({ nodes: [], edges: [], 'x-strokes': out }, null, '\t');
}

test('REVIEW #1: a canvas with heavy pen use (over the old 256 KB cap) saves and reads back byte for byte', () => {
  const root = spaces();
  try {
    const c = createCore({ root });
    const text = penCanvas(200);
    assert.ok(Buffer.byteLength(text) > 256 * 1024, `fixture is over the old cap: ${Buffer.byteLength(text)}`);
    assert.ok(Buffer.byteLength(text) < MAX_FILE);
    const w = c.create('Me', 'Board.canvas', text);
    assert.equal(w.size, Buffer.byteLength(text));
    const r = c.read('Me', 'Board.canvas');
    assert.equal(r.text, text);
    // ... and another stroke on top of it
    const more = penCanvas(201);
    assert.equal(c.write('Me', 'Board.canvas', more, r.hash).hash, sha(Buffer.from(more)));
    // The cap itself: one byte over is refused, the file is the same as before
    assert.equal(code(() => c.write('Me', 'Board.canvas', JSON.stringify({ pad: 'x'.repeat(MAX_FILE) }), sha(Buffer.from(more)))), 'too-large');
    assert.equal(fs.readFileSync(path.join(root, 'Me', 'Board.canvas'), 'utf8'), more);
    assert.ok(c.list('Me').max >= 480 * 1024, 'list tells the page the cap');
  } finally {
    rm(root);
  }
});

test('REVIEW #1: a file at the cap whose text doubles when escaped (tabs and newlines) is written and read back over the host process', async () => {
  const root = spaces();
  const h = startHost(root);
  try {
    const head = '{"nodes":[],"edges":[]}';
    const text = head + '\n\t'.repeat(Math.floor((MAX_FILE - head.length) / 2)) + ' '.repeat((MAX_FILE - head.length) % 2);
    assert.equal(Buffer.byteLength(text), MAX_FILE);
    const w = await h.call('create', { space: 'Me', file: 'Fat.canvas', text });
    assert.equal(w.ok, true, JSON.stringify(w).slice(0, 200)); // a request of about 1 MB: the old host exited on it
    const r = await h.call('read', { space: 'Me', file: 'Fat.canvas' });
    assert.equal(r.ok, true, JSON.stringify(r).slice(0, 200)); // an answer under Chrome's 1 MB
    assert.equal(r.text, text);
    // Text that would not fit an answer once escaped is refused on write, not stored unreadable
    const ctl = '\u0001'.repeat(200 * 1024); // each one travels as 6 bytes
    assert.equal((await h.call('create', { space: 'Me', file: 'ctl.md', text: ctl })).error, 'too-large');
    assert.equal((await h.call('ping')).ok, true, 'the host is still up');
  } finally {
    h.proc.kill();
    rm(root);
  }
});

test('REVIEW #9: "Keep mine" works when the disk copy is over the cap or not UTF-8: the conflict carries its hash, saving again with that hash replaces it', () => {
  const root = spaces();
  try {
    const c = createCore({ root });
    const abs = path.join(root, 'Me', 'a.md');
    c.create('Me', 'a.md', 'v1\n');
    const loaded = c.read('Me', 'a.md');
    for (const theirs of [Buffer.alloc(MAX_FILE + 1000, 0x61), Buffer.from([0x23, 0x20, 0xe9, 0x0a])]) {
      fs.writeFileSync(abs, theirs);
      let err;
      try {
        c.write('Me', 'a.md', 'mine\n', loaded.hash);
      } catch (e) {
        err = e;
      }
      assert.equal(err?.code, 'conflict');
      assert.equal(err.extra.theirs, null, 'their bytes cannot be shown');
      assert.match(err.extra.reason, /^(too-large|not-utf8)$/);
      assert.equal(err.extra.hash, sha(theirs), 'but their hash is in the answer');
      assert.deepEqual(fs.readFileSync(abs), theirs, 'nothing was written');
      // Create over it says the same, with the same hash
      let err2;
      try {
        c.create('Me', 'a.md', 'mine\n');
      } catch (e) {
        err2 = e;
      }
      assert.equal(err2.extra.hash, sha(theirs));
      // Keep mine
      const r = c.write('Me', 'a.md', 'mine\n', err.extra.hash);
      assert.equal(r.hash, sha(Buffer.from('mine\n')));
      assert.equal(fs.readFileSync(abs, 'utf8'), 'mine\n');
      c.write('Me', 'a.md', 'v1\n', r.hash);
      loaded.hash = sha(Buffer.from('v1\n'));
    }
    assert.deepEqual(leftovers(path.join(root, 'Me')), []);
    assert.deepEqual(fs.readdirSync(path.join(root, 'Me')), ['a.md'], 'no stray hidden files');
  } finally {
    rm(root);
  }
});

test('REVIEW #9: over the host process the conflict answer carries hash, size and reason even when theirs is null', async () => {
  const root = spaces();
  const h = startHost(root);
  try {
    const abs = path.join(root, 'Me', 'a.md');
    const w = await h.call('create', { space: 'Me', file: 'a.md', text: 'v1\n' });
    const big = Buffer.alloc(MAX_FILE + 5, 0x62);
    fs.writeFileSync(abs, big);
    const bad = await h.call('write', { space: 'Me', file: 'a.md', text: 'mine\n', base: w.hash });
    assert.deepEqual([bad.error, bad.theirs, bad.reason, bad.hash, bad.size], ['conflict', null, 'too-large', sha(big), big.length]);
    const keep = await h.call('write', { space: 'Me', file: 'a.md', text: 'mine\n', base: bad.hash });
    assert.equal(keep.ok, true);
    assert.equal(fs.readFileSync(abs, 'utf8'), 'mine\n');
  } finally {
    h.proc.kill();
    rm(root);
  }
});

test('REVIEW #10: an outside write that lands right before the replace is caught, not overwritten', () => {
  const root = spaces();
  const dir = path.join(root, 'Me');
  const real = { rename: fs.renameSync, link: fs.linkSync };
  try {
    const c = createCore({ root });
    const abs = path.join(dir, 'a.md');
    c.create('Me', 'a.md', 'v1\n');
    const loaded = c.read('Me', 'a.md');
    // The outside write lands on the first rename the save makes inside the folder: the instant that was
    // unguarded before (after the last check, before the replace)
    let fired = false;
    fs.renameSync = (a, b) => {
      if (!fired && String(a).startsWith(dir)) {
        fired = true;
        fs.writeFileSync(abs, 'v2 from outside, a moment before\n');
      }
      return real.rename(a, b);
    };
    let err;
    try {
      c.write('Me', 'a.md', 'v1 mine\n', loaded.hash);
    } catch (e) {
      err = e;
    } finally {
      fs.renameSync = real.rename;
    }
    assert.ok(fired);
    assert.equal(err?.code, 'conflict', 'the save was refused');
    assert.equal(err.extra.theirs.text, 'v2 from outside, a moment before\n');
    assert.equal(fs.readFileSync(abs, 'utf8'), 'v2 from outside, a moment before\n', 'their write is still the file');
    assert.deepEqual(fs.readdirSync(dir), ['a.md'], 'no hidden leftovers');

    // A file made under the name in the instant after the compare is not replaced either
    const h2 = c.read('Me', 'a.md').hash;
    let fired2 = false;
    fs.linkSync = (a, b) => {
      if (!fired2 && b === abs) {
        fired2 = true;
        fs.writeFileSync(abs, 'v3 from outside, a moment later\n');
      }
      return real.link(a, b);
    };
    let err2;
    try {
      c.write('Me', 'a.md', 'v2 mine\n', h2);
    } catch (e) {
      err2 = e;
    } finally {
      fs.linkSync = real.link;
    }
    assert.ok(fired2);
    assert.equal(err2?.code, 'conflict');
    assert.equal(fs.readFileSync(abs, 'utf8'), 'v3 from outside, a moment later\n');
    assert.deepEqual(fs.readdirSync(dir), ['a.md'], 'no hidden leftovers');
    // And with nothing in the way it still saves
    c.write('Me', 'a.md', 'ok\n', c.read('Me', 'a.md').hash);
    assert.equal(fs.readFileSync(abs, 'utf8'), 'ok\n');
  } finally {
    fs.renameSync = real.rename;
    fs.linkSync = real.link;
    rm(root);
  }
});

// ---------------------------------------------------------------- slice 1: one-level folders (C44 host part)

test('one level: list holds the top-level notes and one group per folder (MEGATAB.md first); two levels down, hidden and symlinked folders are out of reach', () => {
  const root = spaces();
  const outside = tmp('megatabs-outside-');
  try {
    const d = path.join(root, 'Me');
    const c = createCore({ root });
    fs.writeFileSync(path.join(d, 'README.md'), '# Home\n');
    fs.mkdirSync(path.join(d, 'Reading'));
    fs.writeFileSync(path.join(d, 'Reading', 'a-notes.md'), '# Notes\n');
    fs.writeFileSync(path.join(d, 'Reading', 'MEGATAB.md'), '# How it works\n');
    fs.writeFileSync(path.join(d, 'Reading', 'Pipeline.canvas'), '{}');
    fs.mkdirSync(path.join(d, 'Reading', 'deeper'));
    fs.writeFileSync(path.join(d, 'Reading', 'deeper', 'deep.md'), 'two levels down\n');
    fs.mkdirSync(path.join(d, 'Archive'));
    fs.mkdirSync(path.join(d, '.hiddenfolder'));
    fs.writeFileSync(path.join(d, '.hiddenfolder', 'h.md'), 'h\n');
    fs.writeFileSync(path.join(outside, 'o.md'), 'outside\n');
    fs.symlinkSync(outside, path.join(d, 'Linked'));
    const l = c.list('Me');
    assert.deepEqual(l.files.map((f) => f.file), ['README.md']);
    assert.deepEqual(l.folders.map((f) => f.folder), ['Archive', 'Reading']);
    assert.deepEqual(l.folders[1].files.map((f) => [f.file, f.folder, f.kind]), [['MEGATAB.md', 'Reading', 'md'], ['a-notes.md', 'Reading', 'md'], ['Pipeline.canvas', 'Reading', 'canvas']]);
    assert.equal(l.folders[1].files[0].path, path.join(d, 'Reading', 'MEGATAB.md'));
    assert.equal(l.folders[1].files[0].title, 'How it works');
    assert.deepEqual(l.folders[0].files, []);
    assert.ok(!JSON.stringify(l).includes('deep.md') && !JSON.stringify(l).includes('o.md') && !JSON.stringify(l).includes('h.md'));
    // read, write, create inside a folder: same rules as at the top
    const r = c.read('Me', 'MEGATAB.md', { folder: 'Reading' });
    assert.equal(r.text, '# How it works\n');
    const w = c.write('Me', 'MEGATAB.md', '# How it works 2\n', r.hash, { folder: 'Reading' });
    assert.equal(fs.readFileSync(path.join(d, 'Reading', 'MEGATAB.md'), 'utf8'), '# How it works 2\n');
    assert.equal(code(() => c.write('Me', 'MEGATAB.md', 'x', r.hash, { folder: 'Reading' })), 'conflict');
    c.create('Me', 'new.md', '# n\n', { folder: 'Archive' });
    assert.equal(code(() => c.create('Me', 'new.md', 'again', { folder: 'Archive' })), 'conflict');
    assert.equal(w.size, Buffer.byteLength('# How it works 2\n'));
    assert.deepEqual(leftovers(path.join(d, 'Reading')), []);
    // out of reach
    for (const bad of ['deeper/deep.md', '../README.md', 'Reading/MEGATAB.md']) assert.equal(code(() => c.read('Me', bad, { folder: 'Reading' })), 'bad-name', bad);
    for (const folder of ['Reading/deeper', '..', '.', '.hiddenfolder', '', ' x', 'a\\b']) assert.equal(code(() => c.read('Me', 'MEGATAB.md', { folder })), 'bad-name', JSON.stringify(folder));
    assert.equal(code(() => c.read('Me', 'deep.md', { folder: 'deeper' })), 'no-folder', 'a folder is looked for in the space only');
    assert.equal(code(() => c.read('Me', 'o.md', { folder: 'Linked' })), 'symlink');
    assert.equal(code(() => c.create('Me', 'x.md', 'x', { folder: 'Linked' })), 'symlink');
    assert.equal(code(() => c.create('Me', 'x.md', 'x', { folder: 'Nowhere' })), 'no-folder');
    assert.ok(!fs.existsSync(path.join(d, 'Nowhere')), 'a folder is never made by a save');
    assert.deepEqual(fs.readdirSync(outside), ['o.md']);
    // the watcher fingerprint sees a change inside a folder and a new folder
    const s0 = c.signature('Me');
    fs.appendFileSync(path.join(d, 'Reading', 'MEGATAB.md'), 'more\n');
    const s1 = c.signature('Me');
    assert.notEqual(s1, s0);
    fs.mkdirSync(path.join(d, 'Writing'));
    assert.notEqual(c.signature('Me'), s1);
    fs.writeFileSync(path.join(d, 'Reading', 'deeper', 'more.md'), 'x');
    const s2 = c.signature('Me');
    fs.writeFileSync(path.join(d, 'Reading', 'deeper', 'more2.md'), 'x');
    assert.equal(c.signature('Me'), s2, 'two levels down is not watched');
  } finally {
    rm(root, outside);
  }
});

// ---------------------------------------------------------------- slice 1: spaces and covers (C39-C41 host parts)

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('IHDR-and-the-rest-of-a-picture')]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('JFIF-and-the-rest-of-a-picture')]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([30, 0, 0, 0]), Buffer.from('WEBPVP8 and the rest')]);
const dataUrl = (buf, mime) => `data:${mime};base64,${buf.toString('base64')}`;

test('spaces lists the folders of ~/Spaces (not hidden ones, files or symlinks) with note counts and cover names', () => {
  const root = spaces();
  const outside = tmp('megatabs-outside-');
  try {
    const c = createCore({ root });
    fs.mkdirSync(path.join(root, 'Satellite'));
    fs.writeFileSync(path.join(root, 'Me', 'a.md'), 'a');
    fs.writeFileSync(path.join(root, 'Me', 'b.canvas'), '{}');
    fs.writeFileSync(path.join(root, 'Me', 'x.txt'), 'x');
    fs.writeFileSync(path.join(root, 'Me', 'cover.jpg'), JPG);
    fs.mkdirSync(path.join(root, '.trash'));
    fs.writeFileSync(path.join(root, 'loose.md'), 'a file in ~/Spaces is not a space');
    fs.symlinkSync(outside, path.join(root, 'Linked'));
    assert.deepEqual(c.spaces().spaces, [{ name: 'Me', notes: 2, cover: 'cover.jpg' }, { name: 'Satellite', notes: 0, cover: null }]);
    assert.equal(c.spaces().root, root);
  } finally {
    rm(root, outside);
  }
});

test('mkspace makes a folder and never replaces or reuses one; renamespace never replaces and changes nothing when refused', () => {
  const root = spaces();
  try {
    const c = createCore({ root });
    fs.writeFileSync(path.join(root, 'Me', 'keep.md'), 'keep');
    assert.deepEqual(c.mkspace('Satellite'), { space: 'Satellite', dir: path.join(root, 'Satellite') });
    assert.ok(fs.statSync(path.join(root, 'Satellite')).isDirectory());
    assert.equal(code(() => c.mkspace('Satellite')), 'exists');
    assert.equal(code(() => c.mkspace('Me')), 'exists');
    assert.equal(code(() => c.mkspace('me')), 'exists', 'a case-insensitive disk counts the same name');
    for (const bad of ['', '.trash', '..', 'a/b', ' x', 'x\0', 'a:b']) assert.equal(code(() => c.mkspace(bad)), 'bad-name', JSON.stringify(bad));
    assert.deepEqual(fs.readdirSync(path.join(root, 'Me')), ['keep.md'], 'an existing space was not touched');
    // renamespace refuses: taken name, same name, bad names, missing space; nothing moves
    assert.equal(code(() => c.renamespace('Me', 'Satellite')), 'exists');
    assert.equal(code(() => c.renamespace('Me', 'Me')), 'exists');
    assert.equal(code(() => c.renamespace('Me', '../out')), 'bad-name');
    assert.equal(code(() => c.renamespace('Me', '.trash')), 'bad-name');
    assert.equal(code(() => c.renamespace('Nowhere', 'Other')), 'no-space');
    assert.deepEqual(fs.readdirSync(root).sort(), ['Me', 'Satellite']);
    assert.deepEqual(fs.readdirSync(path.join(root, 'Satellite')), [], 'the free-space folder is untouched');
    // renames: contents go with it, bytes unchanged
    const ino = fs.statSync(path.join(root, 'Me')).ino;
    assert.deepEqual(c.renamespace('Me', 'Gardens'), { space: 'Gardens', dir: path.join(root, 'Gardens') });
    assert.deepEqual(fs.readdirSync(root).sort(), ['Gardens', 'Satellite']);
    assert.equal(fs.statSync(path.join(root, 'Gardens')).ino, ino);
    assert.equal(fs.readFileSync(path.join(root, 'Gardens', 'keep.md'), 'utf8'), 'keep');
    // a case-only change of the same folder works
    assert.equal(c.renamespace('Gardens', 'gardens').space, 'gardens');
    assert.ok(fs.readdirSync(root).includes('gardens'));
    assert.equal(c.list('gardens').files[0].file, 'keep.md');
  } finally {
    rm(root);
  }
});

test('cover: a png, jpg or webp up to 700 KB comes back as a data: URL; none gives null; a big, fake or linked one is not used', () => {
  const root = spaces();
  const outside = tmp('megatabs-outside-');
  try {
    const c = createCore({ root });
    const d = path.join(root, 'Me');
    assert.deepEqual(c.cover('Me'), { cover: null });
    for (const [name, buf, mime] of [['cover.png', PNG, 'image/png'], ['cover.jpg', JPG, 'image/jpeg'], ['cover.jpeg', JPG, 'image/jpeg'], ['cover.webp', WEBP, 'image/webp']]) {
      fs.writeFileSync(path.join(d, name), buf);
      const r = c.cover('Me');
      assert.deepEqual(r.cover, { file: name, mime, size: buf.length, hash: sha(buf), data: dataUrl(buf, mime) }, name);
      fs.rmSync(path.join(d, name));
    }
    fs.writeFileSync(path.join(d, 'cover.png'), Buffer.concat([PNG, Buffer.alloc(700 * 1024)]));
    assert.deepEqual([c.cover('Me').cover, c.cover('Me').reason], [null, 'too-large']);
    fs.writeFileSync(path.join(d, 'cover.png'), Buffer.concat([PNG, Buffer.alloc(700 * 1024 - PNG.length)]));
    assert.equal(c.cover('Me').cover.size, 700 * 1024, 'exactly 700 KB is fine');
    assert.ok(JSON.stringify(c.cover('Me')).length < 1000 * 1000, 'and its answer fits Chrome 1 MB');
    fs.writeFileSync(path.join(d, 'cover.png'), '<svg onload=alert(1)>');
    assert.deepEqual([c.cover('Me').cover, c.cover('Me').reason], [null, 'bad-image'], 'the bytes decide, not the name');
    fs.rmSync(path.join(d, 'cover.png'));
    fs.writeFileSync(path.join(outside, 'x.png'), PNG);
    fs.symlinkSync(path.join(outside, 'x.png'), path.join(d, 'cover.png'));
    assert.equal(c.cover('Me').cover, null, 'a symlink is not a cover');
    assert.equal(code(() => c.cover('Nowhere')), 'no-space');
  } finally {
    rm(root, outside);
  }
});

test('putcover writes cover.<ext> atomically, checks the bytes, and sends what it replaces to the trash', () => {
  const root = spaces();
  try {
    const c = createCore({ root });
    const d = path.join(root, 'Me');
    assert.deepEqual(c.putcover('Me', dataUrl(PNG, 'image/png')), { file: 'cover.png', size: PNG.length, hash: sha(PNG) });
    assert.deepEqual(fs.readFileSync(path.join(d, 'cover.png')), PNG);
    assert.equal(fs.statSync(path.join(d, 'cover.png')).mode & 0o777, 0o644);
    // a second png replaces it; the first one is in the trash
    const PNG2 = Buffer.concat([PNG, Buffer.from('-second')]);
    c.putcover('Me', dataUrl(PNG2, 'image/png'));
    assert.deepEqual(fs.readFileSync(path.join(d, 'cover.png')), PNG2);
    // a jpeg: the png leaves the folder (to the trash), the space has one cover
    c.putcover('Me', dataUrl(JPG, 'image/jpeg'));
    assert.deepEqual(fs.readdirSync(d).sort(), ['cover.jpg']);
    const trashed = fs.readdirSync(path.join(root, '.trash', 'Me'));
    assert.equal(trashed.length, 2, `${trashed}`);
    const bytes = trashed.map((n) => fs.readFileSync(path.join(root, '.trash', 'Me', n)).toString('latin1')).sort();
    assert.deepEqual(bytes, [PNG, PNG2].map((b) => b.toString('latin1')).sort());
    assert.ok(trashed.every((n) => /^cover\.png \d{8}T\d{6}-\d{3}Z$/.test(n)));
    assert.equal(c.cover('Me').cover.file, 'cover.jpg');
    // refused: wrong type, lying type, over 700 KB, not a data URL, bad space; nothing changes
    for (const bad of [dataUrl(Buffer.from('plain text'), 'image/png'), dataUrl(JPG, 'image/png'), dataUrl(PNG, 'image/gif'), 'https://x.test/a.png', 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', 7, '']) {
      assert.equal(code(() => c.putcover('Me', bad)), 'bad-image', String(bad).slice(0, 40));
    }
    assert.equal(code(() => c.putcover('Me', dataUrl(Buffer.concat([PNG, Buffer.alloc(700 * 1024)]), 'image/png'))), 'too-large');
    assert.equal(code(() => c.putcover('Nowhere', dataUrl(PNG, 'image/png'))), 'no-space');
    assert.deepEqual(fs.readdirSync(d).sort(), ['cover.jpg']);
    assert.deepEqual(leftovers(d), []);
  } finally {
    rm(root);
  }
});

// ---------------------------------------------------------------- slice 1: trash, untrash, rename (C27, C29)

test('trash moves a note to ~/Spaces/.trash/<space>/<name> <timestamp> and never unlinks; untrash brings it back byte for byte', () => {
  const root = spaces();
  try {
    const c = createCore({ root });
    const d = path.join(root, 'Me');
    const bytes = Buffer.from('﻿# Keep me\r\nbytes 🚀\n\n\nno final newline');
    fs.writeFileSync(path.join(d, 'Drafts.md'), bytes);
    fs.chmodSync(path.join(d, 'Drafts.md'), 0o640);
    const ino = fs.statSync(path.join(d, 'Drafts.md')).ino;
    const t = c.trash('Me', 'Drafts.md');
    assert.match(t.trashId, /^Drafts\.md \d{8}T\d{6}-\d{3}Z$/);
    assert.equal(t.trashed, path.join(root, '.trash', 'Me', t.trashId));
    assert.ok(!fs.existsSync(path.join(d, 'Drafts.md')));
    assert.deepEqual(fs.readFileSync(t.trashed), bytes);
    assert.equal(fs.statSync(t.trashed).ino, ino, 'the same file moved: nothing was copied or deleted');
    assert.deepEqual(c.list('Me').files, [], 'the trash is not listed');
    assert.deepEqual(c.spaces().spaces.map((s) => s.name), ['Me'], '.trash is not a space');
    const u = c.untrash('Me', t.trashId);
    assert.deepEqual(u, { file: 'Drafts.md' });
    assert.deepEqual(fs.readFileSync(path.join(d, 'Drafts.md')), bytes);
    assert.equal(fs.statSync(path.join(d, 'Drafts.md')).ino, ino);
    assert.equal(fs.statSync(path.join(d, 'Drafts.md')).mode & 0o777, 0o640);
    assert.deepEqual(fs.readdirSync(path.join(root, '.trash', 'Me')), []);
    // a canvas, and two trashes of the same name in one millisecond both survive
    for (let i = 0; i < 3; i++) {
      fs.writeFileSync(path.join(d, 'B.canvas'), `{"v":${i}}`);
      c.trash('Me', 'B.canvas');
    }
    const kept = fs.readdirSync(path.join(root, '.trash', 'Me')).map((n) => fs.readFileSync(path.join(root, '.trash', 'Me', n), 'utf8')).sort();
    assert.deepEqual(kept, ['{"v":0}', '{"v":1}', '{"v":2}']);
    // refusals
    for (const bad of ['../a.md', 'a/b.md', '.x.md', '']) assert.equal(code(() => c.trash('Me', bad)), 'bad-name', bad);
    assert.equal(code(() => c.trash('Me', 'x.txt')), 'bad-type');
    assert.equal(code(() => c.trash('Me', 'nope.md')), 'gone');
    assert.equal(code(() => c.trash('Nowhere', 'a.md')), 'no-space');
    assert.equal(code(() => c.untrash('Me', '../../etc/passwd')), 'bad-name');
    assert.equal(code(() => c.untrash('Me', 'a/b/c.md 20261116T160533-123Z')), 'bad-name');
    assert.equal(code(() => c.untrash('Me', 'no timestamp.md')), 'bad-name');
    assert.equal(code(() => c.untrash('Me', 'x.txt 20261116T160533-123Z')), 'bad-type');
    assert.equal(code(() => c.untrash('Me', 'ghost.md 20261116T160533-123Z')), 'gone');
    assert.equal(code(() => c.untrash('Me', 5)), 'bad-name');
  } finally {
    rm(root);
  }
});

test('untrash never overwrites: a name taken meanwhile is refused with the file still in the trash, and `to` brings it back under another name', () => {
  const root = spaces();
  try {
    const c = createCore({ root });
    const d = path.join(root, 'Me');
    fs.writeFileSync(path.join(d, 'a.md'), 'old\n');
    const t = c.trash('Me', 'a.md');
    fs.writeFileSync(path.join(d, 'a.md'), 'new, made meanwhile\n');
    assert.equal(code(() => c.untrash('Me', t.trashId)), 'exists');
    assert.equal(fs.readFileSync(path.join(d, 'a.md'), 'utf8'), 'new, made meanwhile\n');
    assert.equal(fs.readFileSync(t.trashed, 'utf8'), 'old\n');
    assert.equal(code(() => c.untrash('Me', t.trashId, { to: 'b.canvas' })), 'bad-type');
    assert.deepEqual(c.untrash('Me', t.trashId, { to: 'a (restored).md' }), { file: 'a (restored).md' });
    assert.equal(fs.readFileSync(path.join(d, 'a (restored).md'), 'utf8'), 'old\n');
    assert.deepEqual(leftovers(d), []);
    assert.deepEqual(fs.readdirSync(d).sort(), ['a (restored).md', 'a.md']);
  } finally {
    rm(root);
  }
});

test('trash and untrash work inside a folder, keep the folder in the trash path, and refuse symlinks and hard links', () => {
  const root = spaces();
  const outside = tmp('megatabs-outside-');
  try {
    const c = createCore({ root });
    const d = path.join(root, 'Me');
    fs.mkdirSync(path.join(d, 'Reading'));
    fs.writeFileSync(path.join(d, 'Reading', 'n.md'), 'in a folder\n');
    const t = c.trash('Me', 'n.md', { folder: 'Reading' });
    assert.match(t.trashId, /^Reading\/n\.md \d{8}T\d{6}-\d{3}Z$/);
    assert.equal(t.folder, 'Reading');
    assert.equal(fs.readFileSync(path.join(root, '.trash', 'Me', 'Reading', t.trashId.split('/')[1]), 'utf8'), 'in a folder\n');
    assert.deepEqual(c.untrash('Me', t.trashId), { file: 'n.md', folder: 'Reading' });
    assert.equal(fs.readFileSync(path.join(d, 'Reading', 'n.md'), 'utf8'), 'in a folder\n');
    // a symlink and a hard-linked file are not moved
    fs.writeFileSync(path.join(outside, 'o.md'), 'outside\n');
    fs.symlinkSync(path.join(outside, 'o.md'), path.join(d, 'link.md'));
    assert.equal(code(() => c.trash('Me', 'link.md')), 'symlink');
    fs.linkSync(path.join(outside, 'o.md'), path.join(d, 'hard.md'));
    assert.equal(code(() => c.trash('Me', 'hard.md')), 'hardlink');
    assert.equal(code(() => c.rename('Me', 'link.md', 'x.md')), 'symlink');
    assert.deepEqual(fs.readdirSync(outside), ['o.md']);
    assert.equal(fs.readFileSync(path.join(outside, 'o.md'), 'utf8'), 'outside\n');
    // a trash folder that is a symlink is refused: nothing leaves ~/Spaces through it
    fs.rmSync(path.join(root, '.trash'), { recursive: true });
    fs.symlinkSync(outside, path.join(root, '.trash'));
    fs.writeFileSync(path.join(d, 'z.md'), 'z\n');
    assert.equal(code(() => c.trash('Me', 'z.md')), 'io');
    assert.ok(fs.existsSync(path.join(d, 'z.md')));
    assert.deepEqual(fs.readdirSync(outside).sort(), ['o.md']);
  } finally {
    rm(root, outside);
  }
});

test('rename never replaces: a taken name is refused and nothing moves; the open file keeps its bytes and hash; a case-only change works', () => {
  const root = spaces();
  try {
    const c = createCore({ root });
    const d = path.join(root, 'Me');
    c.create('Me', 'a.md', '# A\n');
    c.create('Me', 'b.md', '# B\n');
    c.create('Me', 'Board.canvas', '{}');
    const before = c.read('Me', 'a.md');
    const ino = fs.statSync(path.join(d, 'a.md')).ino;
    assert.equal(code(() => c.rename('Me', 'a.md', 'b.md')), 'exists');
    assert.equal(code(() => c.rename('Me', 'a.md', 'a.md')), 'exists');
    assert.equal(fs.readFileSync(path.join(d, 'b.md'), 'utf8'), '# B\n', 'the taken name was not touched');
    assert.deepEqual(fs.readdirSync(d).sort(), ['Board.canvas', 'a.md', 'b.md']);
    const r = c.rename('Me', 'a.md', 'Alpha beta.md');
    assert.deepEqual([r.file, r.hash, r.size], ['Alpha beta.md', before.hash, before.size]);
    assert.equal(fs.statSync(path.join(d, 'Alpha beta.md')).ino, ino);
    assert.ok(!fs.existsSync(path.join(d, 'a.md')));
    assert.equal(c.rename('Me', 'b.md', 'B.md').file, 'B.md');
    assert.deepEqual(fs.readdirSync(d).sort(), ['Alpha beta.md', 'B.md', 'Board.canvas']);
    assert.deepEqual(leftovers(d), []);
    // the saved name is the new one: a save with the old base goes through under the new name
    assert.equal(c.write('Me', 'Alpha beta.md', '# A2\n', before.hash).size, 5);
    // names and kinds are checked; a missing file is refused
    for (const bad of ['../x.md', 'a/b.md', '.x.md', '', 'x\0.md']) assert.equal(code(() => c.rename('Me', 'B.md', bad)), 'bad-name', JSON.stringify(bad));
    assert.equal(code(() => c.rename('Me', 'B.md', 'x.txt')), 'bad-type');
    assert.equal(code(() => c.rename('Me', 'B.md', 'x.canvas')), 'bad-type', 'a note stays a note');
    assert.equal(code(() => c.rename('Me', 'Board.canvas', 'x.md')), 'bad-type');
    assert.equal(code(() => c.rename('Me', 'nope.md', 'x.md')), 'gone');
    assert.equal(code(() => c.rename('Me', '../x.md', 'y.md')), 'bad-name');
    // inside a folder
    fs.mkdirSync(path.join(d, 'Reading'));
    c.create('Me', 'n.md', 'n', { folder: 'Reading' });
    c.create('Me', 'm.md', 'm', { folder: 'Reading' });
    assert.equal(code(() => c.rename('Me', 'n.md', 'm.md', { folder: 'Reading' })), 'exists');
    assert.deepEqual(c.rename('Me', 'n.md', 'N2.md', { folder: 'Reading' }).folder, 'Reading');
    assert.equal(c.rename('Me', 'B.md', 'n.md').file, 'n.md', 'the same name in another folder is a different name');
  } finally {
    rm(root);
  }
});

// ---------------------------------------------------------------- slice 1: search (C28 host part)

test('search finds notes by title, file name and body, case-insensitively, in the top level and one folder down, with line, snippet and the card of a canvas', () => {
  const root = spaces();
  try {
    const c = createCore({ root });
    const d = path.join(root, 'Me');
    fs.writeFileSync(path.join(d, 'README.md'), '# Home\nthe quick brown Fox\njumps\n');
    fs.writeFileSync(path.join(d, 'Foxtrot.md'), '# Dance\nnothing here\n');
    fs.writeFileSync(path.join(d, 'other.md'), '# Other\nnothing\n');
    fs.writeFileSync(path.join(d, 'Board.canvas'), JSON.stringify({ nodes: [{ id: 'n1', type: 'text', text: 'a card with FOX inside', x: 0, y: 0, width: 1, height: 1 }, { id: 'n2', type: 'text', text: 'width', x: 0, y: 0, width: 1, height: 1 }], edges: [] }));
    fs.mkdirSync(path.join(d, 'Reading'));
    fs.writeFileSync(path.join(d, 'Reading', 'MEGATAB.md'), '# How it works\n\n\nfox in a folder, line 4\n');
    fs.mkdirSync(path.join(d, 'Reading', 'deeper'));
    fs.writeFileSync(path.join(d, 'Reading', 'deeper', 'x.md'), 'fox two levels down\n');
    fs.writeFileSync(path.join(d, 'bad.md'), Buffer.from([0xff, 0x66, 0x6f, 0x78]));
    fs.writeFileSync(path.join(d, 'note.txt'), 'fox in a txt');
    const r = c.search('Me', 'fox');
    assert.deepEqual(r.hits.map((h) => [h.folder, h.file]), [[undefined, 'README.md'], [undefined, 'Board.canvas'], [undefined, 'Foxtrot.md'], ['Reading', 'MEGATAB.md']]);
    const [readme, canvas, fox, mega] = r.hits;
    assert.deepEqual([readme.inTitle, readme.line, readme.index, readme.snippet], [false, 2, '# Home\nthe quick brown '.length, '# Home the quick brown Fox jumps']);
    assert.deepEqual([canvas.kind, canvas.node, canvas.line, canvas.snippet], ['canvas', 'n1', null, 'a card with FOX inside']);
    assert.deepEqual([fox.inTitle, fox.line, fox.title], [true, null, 'Dance']);
    assert.deepEqual([mega.line, mega.title, mega.kind], [4, 'How it works', 'md']);
    assert.equal(r.more, false);
    // title only, no match in body; a canvas key is not searched
    assert.deepEqual(c.search('Me', 'dance').hits.map((h) => h.file), ['Foxtrot.md']);
    assert.deepEqual(c.search('Me', 'height').hits, [], 'JSON keys are not text');
    assert.deepEqual(c.search('Me', 'width').hits.map((h) => h.node), ['n2']);
    // regex characters are plain characters
    fs.writeFileSync(path.join(d, 'rx.md'), 'a.b (c) [d] * + ?\n');
    assert.deepEqual(c.search('Me', '(c) [d]').hits.map((h) => h.file), ['rx.md']);
    assert.deepEqual(c.search('Me', 'a.b').hits.map((h) => h.file), ['rx.md']);
    assert.deepEqual(c.search('Me', 'a?b').hits, []);
    // a bad query or space
    for (const q of ['', '   ', 'x'.repeat(201), 5, null]) assert.equal(code(() => c.search('Me', q)), 'bad-query');
    assert.equal(code(() => c.search('Nowhere', 'x')), 'no-space');
    assert.equal(code(() => c.search('../x', 'x')), 'bad-name');
  } finally {
    rm(root);
  }
});

test('search over 500 files answers well under 200 ms', () => {
  const root = spaces();
  try {
    const c = createCore({ root });
    const d = path.join(root, 'Me');
    for (let i = 0; i < 500; i++) fs.writeFileSync(path.join(d, `note ${String(i).padStart(3, '0')}.md`), `# Note ${i}\n${'lorem ipsum dolor sit amet '.repeat(200)}\nneedle-${i % 50}\n`);
    c.search('Me', 'warm up');
    const t0 = process.hrtime.bigint();
    const r = c.search('Me', 'needle-7');
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.equal(r.hits.length, 10);
    assert.equal(r.scanned, 500);
    assert.ok(ms < 200, `${ms.toFixed(1)} ms`);
  } finally {
    rm(root);
  }
});

// ---------------------------------------------------------------- slice 1: the new ops over the host process

test('host process: every new op answers with its documented shape, errors come back as answers, and ping lists the ops', async () => {
  const root = spaces();
  const h = startHost(root);
  try {
    const d = path.join(root, 'Me');
    const p = await h.call('ping');
    assert.equal(p.max, MAX_FILE);
    assert.deepEqual([...p.ops].sort(), ['cover', 'create', 'list', 'mkspace', 'model', 'ping', 'putcover', 'read', 'rename', 'renamespace', 'search', 'spaces', 'trash', 'untrash', 'watch', 'write']);
    assert.deepEqual((await h.call('spaces')).spaces, [{ name: 'Me', notes: 0, cover: null }]);
    const mk = await h.call('mkspace', { space: 'Satellite' });
    assert.deepEqual([mk.ok, mk.space], [true, 'Satellite']);
    assert.equal((await h.call('mkspace', { space: 'Satellite' })).error, 'exists');
    assert.equal((await h.call('renamespace', { space: 'Satellite', to: 'Me' })).error, 'exists');
    assert.deepEqual([(await h.call('renamespace', { space: 'Satellite', to: 'Sat' })).space], ['Sat']);
    assert.equal((await h.call('putcover', { space: 'Sat', data: dataUrl(PNG, 'image/png') })).file, 'cover.png');
    assert.equal((await h.call('cover', { space: 'Sat' })).cover.data, dataUrl(PNG, 'image/png'));
    assert.deepEqual((await h.call('cover', { space: 'Me' })).cover, null);
    fs.mkdirSync(path.join(d, 'Reading'));
    const c1 = await h.call('create', { space: 'Me', folder: 'Reading', file: 'MEGATAB.md', text: '# How it works\nfindme\n' });
    assert.equal(c1.ok, true);
    const l = await h.call('list', { space: 'Me' });
    assert.deepEqual([l.files, l.folders.map((f) => [f.folder, f.files.map((x) => x.file)])], [[], [['Reading', ['MEGATAB.md']]]]);
    assert.equal((await h.call('read', { space: 'Me', folder: 'Reading', file: 'MEGATAB.md' })).text, '# How it works\nfindme\n');
    const s = await h.call('search', { space: 'Me', q: 'FINDME' });
    assert.deepEqual(s.hits.map((x) => [x.folder, x.file, x.line]), [['Reading', 'MEGATAB.md', 2]]);
    const rn = await h.call('rename', { space: 'Me', folder: 'Reading', file: 'MEGATAB.md', to: 'Start.md' });
    assert.deepEqual([rn.ok, rn.file, rn.folder, rn.hash], [true, 'Start.md', 'Reading', c1.hash]);
    assert.equal((await h.call('rename', { space: 'Me', folder: 'Reading', file: 'nope.md', to: 'x.md' })).error, 'gone');
    const tr = await h.call('trash', { space: 'Me', folder: 'Reading', file: 'Start.md' });
    assert.deepEqual([tr.ok, tr.file, tr.folder], [true, 'Start.md', 'Reading']);
    assert.ok(!fs.existsSync(path.join(d, 'Reading', 'Start.md')));
    const un = await h.call('untrash', { space: 'Me', trashId: tr.trashId });
    assert.deepEqual([un.ok, un.file, un.folder], [true, 'Start.md', 'Reading']);
    assert.equal(fs.readFileSync(path.join(d, 'Reading', 'Start.md'), 'utf8'), '# How it works\nfindme\n');
    assert.equal((await h.call('untrash', { space: 'Me', trashId: tr.trashId })).error, 'gone');
    assert.equal((await h.call('trash', { space: 'Me', file: '../x.md' })).error, 'bad-name');
    assert.equal((await h.call('putcover', { space: 'Sat', data: 'nope' })).error, 'bad-image');
    assert.equal((await h.call('search', { space: 'Me', q: '' })).error, 'bad-query');
    // watch pushes a change inside a folder, with the folders in the push
    assert.equal((await h.call('watch', { space: 'Me' })).ok, true);
    fs.writeFileSync(path.join(d, 'Reading', 'Start.md'), 'edited outside\n');
    const m = await h.next((x) => x.type === 'changed', 2500);
    assert.equal(m.folders[0].files[0].file, 'Start.md');
    h.close();
  } finally {
    h.proc.kill();
    rm(root);
  }
});

test('model (C52): a symlinked or hard-linked model, and one in a symlinked folder, are never read; a model changed between chunks is told apart by size and mtime', () => {
  const root = spaces();
  const outside = tmp('megatabs-outside-');
  try {
    const c = createCore({ root });
    const glb = fs.readFileSync(path.join(__dirname, 'fixtures', 'vase.glb'));
    fs.writeFileSync(path.join(outside, 'target.glb'), glb);
    fs.writeFileSync(path.join(root, 'Me', 'real.glb'), glb);
    fs.symlinkSync(path.join(outside, 'target.glb'), path.join(root, 'Me', 'link.glb'));
    fs.symlinkSync(path.join(root, 'Me', 'real.glb'), path.join(root, 'Me', 'inner.glb'));
    fs.linkSync(path.join(outside, 'target.glb'), path.join(root, 'Me', 'hard.glb'));
    assert.equal(code(() => c.model('Me', 'link.glb')), 'symlink');
    assert.equal(code(() => c.model('Me', 'inner.glb')), 'symlink');
    assert.equal(code(() => c.model('Me', 'hard.glb')), 'hardlink');
    fs.symlinkSync(outside, path.join(root, 'Me', 'Linked'));
    assert.equal(code(() => c.model('Me', 'target.glb', { folder: 'Linked' })), 'symlink');
    fs.symlinkSync(outside, path.join(root, 'Elsewhere'));
    assert.equal(code(() => c.model('Elsewhere', 'target.glb')), 'symlink');
    assert.equal(c.model('Me', 'real.glb').size, glb.length);
    // the file is replaced by another model: the same request now answers with a different size
    const a = c.model('Me', 'real.glb');
    fs.writeFileSync(path.join(root, 'Me', 'real.glb'), Buffer.concat([glb, Buffer.alloc(4)]));
    const b = c.model('Me', 'real.glb');
    assert.notEqual(a.size, b.size);
    assert.ok(fs.readFileSync(path.join(outside, 'target.glb')).equals(glb), 'what the links point to is untouched');
  } finally {
    rm(root, outside);
  }
});

test('host process: model answers in chunks with the documented shape; a bad one is an answer, not a crash', async () => {
  const root = spaces();
  const h = startHost(root);
  try {
    const glb = fs.readFileSync(path.join(__dirname, 'fixtures', 'vase.glb'));
    fs.writeFileSync(path.join(root, 'Me', 'vase.glb'), glb);
    const r = await h.call('model', { space: 'Me', file: 'vase.glb' });
    assert.deepEqual([r.ok, r.size, r.offset, r.length, r.done], [true, glb.length, 0, glb.length, true]);
    assert.ok(Buffer.from(r.data, 'base64').equals(glb));
    assert.equal(typeof r.mtime, 'number');
    assert.equal((await h.call('model', { space: 'Me', file: 'nope.glb' })).error, 'gone');
    assert.equal((await h.call('model', { space: 'Me', file: '../x.glb' })).error, 'bad-name');
    assert.equal((await h.call('model', { space: 'Me', file: 'vase.glb', offset: -5 })).error, 'bad-offset');
    // the biggest chunk plus its JSON envelope stays under Chrome's 1 MB limit for a host message
    fs.writeFileSync(path.join(root, 'Me', 'big.glb'), Buffer.concat([glb.subarray(0, 12), Buffer.alloc(2 * 1024 * 1024, 255)]));
    const big = await h.call('model', { space: 'Me', file: 'big.glb' });
    assert.equal(big.ok, true);
    assert.equal(big.length, MODEL_CHUNK);
    assert.ok(Buffer.byteLength(JSON.stringify(big)) < 1000 * 1000, 'under 1 MB with the envelope');
    h.close();
  } finally {
    h.proc.kill();
    rm(root);
  }
});
