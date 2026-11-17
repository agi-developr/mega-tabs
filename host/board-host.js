#!/usr/bin/env node
'use strict';
// Native-messaging host for the Board and the panel: lets our extension (and only it) list, read, write, create, rename,
// trash, search and watch the .md and .canvas files in ~/Spaces/<space>/ and one folder level below, make and rename
// space folders, and read or set a space's cover. Chrome starts it when a page connects and
// ends it when the page closes. No network, no port, no files outside ~/Spaces (see core.js).
//
// Protocol: Chrome's native messaging, JSON in both directions, each message framed by a 4-byte
// native-endian length. Requests carry an `id` and a `type`. `folder` is optional everywhere it appears: one folder
// inside the space (a mega tab's folder). Files are .md or .canvas names; `hash` is the sha-256 hex of a file's bytes.
//   ping {}                                -> { max, ops: [names] }        max = biggest file in bytes
//   list {space}                           -> { space, dir, max, more, files: [F], folders: [{ folder, path, files: [F] }] }
//        F = { file, kind: 'md'|'canvas', title, mtime, size, hash, path, folder?, unreadable? }
//   read {space, folder?, file}            -> { text, hash, mtime, size }
//   write {space, folder?, file, text, base}   -> { hash, mtime, size }   base = hash loaded, or null for a new file
//        error 'conflict' -> { reason: 'changed'|'exists'|'gone'|'too-large'|'not-utf8', theirs: {text,hash,mtime}|null, hash?, size?, gone? }
//        `hash` is the hash of what is on disk even when `theirs` is null: save again with base = hash to keep yours
//   create {space, folder?, file, text}    -> { hash, mtime, size }   or error 'conflict' when the name is taken
//   watch {space}                          -> {}, then pushes { type: 'changed', space, ...list } on any change
//   spaces {}                              -> { root, spaces: [{ name, notes, cover: 'cover.png'|null }] }
//   mkspace {space}                        -> { space, dir }              error 'exists' when the folder is there
//   renamespace {space, to}                -> { space: to, dir }          error 'exists' when `to` is taken, 'no-space' when there is no folder
//   cover {space}                          -> { cover: null, reason? } or { cover: { file, mime, size, hash, data: 'data:image/..;base64,..' } }
//   putcover {space, data}                 -> { file, size, hash }        data = data: URL, png/jpeg/webp, at most 700 KB; the old cover goes to the trash
//   model {space, folder?, file, offset?}  -> { size, mtime, offset, length, data: 'base64', done }   READ-ONLY bytes of a .glb or .gltf, 512 KB per answer (ask offset + length until done); at most 24 MB; nothing is ever written
//   trash {space, folder?, file}           -> { trashId, file, folder?, trashed }   moves to ~/Spaces/.trash/<space>/[<folder>/]<name> <timestamp>
//   untrash {space, trashId, to?}          -> { file, folder? }           trashId from trash (`id` is the message id); error 'exists' when the name is taken (then pass `to`)
//   rename {space, folder?, file, to}      -> { file, folder?, hash?, mtime?, size? }   error 'exists' when `to` is taken
//   search {space, q}                      -> { space, q, hits: [{ folder?, file, kind, title, inTitle, line, index, snippet, node? }], scanned, more }
// Answers carry the same `id` and either `ok: true` or `error` (a short code) plus `message`.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { createCore, HostError } = require('./core');

const { allowedOrigin, startedBy } = require('./origin');
const MAX_IN = 2 * 1024 * 1024; // a save is at most ~1 MB escaped and a cover ~1 MB as base64; anything bigger is not from our extension
const MAX_OUT = 1000 * 1000; // Chrome refuses host messages over 1 MB
const POLL_MS = 1000;

function start({ root, stdin = process.stdin, stdout = process.stdout, exit = process.exit } = {}) {
  const core = createCore({ root });
  const little = os.endianness() === 'LE';
  const send = (obj) => {
    let body = Buffer.from(JSON.stringify(obj), 'utf8');
    if (body.length > MAX_OUT) {
      // A conflict stays a conflict (without their text) so that "Keep mine" still works with the hash
      const conflict = obj.error === 'conflict';
      body = Buffer.from(JSON.stringify(conflict ? { id: obj.id, error: 'conflict', message: obj.message, reason: 'too-large', theirs: null, hash: obj.hash } : { id: obj.id, error: 'too-large', message: 'answer over 1 MB' }), 'utf8');
    }
    const head = Buffer.alloc(4);
    if (little) head.writeUInt32LE(body.length);
    else head.writeUInt32BE(body.length);
    stdout.write(Buffer.concat([head, body]));
  };

  let watcher = null; // { space, fs watcher, timer, last }
  const unwatch = () => {
    if (!watcher) return;
    clearInterval(watcher.timer);
    try {
      watcher.fsw?.close();
    } catch {
      /* already closed */
    }
    watcher = null;
  };
  const check = (w) => {
    if (watcher !== w) return;
    let sig;
    try {
      sig = core.signature(w.space);
    } catch (e) {
      sig = `error:${e.code}`;
    }
    if (sig === w.last) return;
    w.last = sig;
    arm(w);
    try {
      send({ type: 'changed', space: w.space, ...core.list(w.space) });
    } catch (e) {
      send({ type: 'changed', space: w.space, error: e.code || 'io', message: e.message });
    }
  };
  // Looks at the folder on every file event and once a second. A folder that does not exist yet is
  // waited for; the first look after it appears is a push with its files.
  function arm(w) {
    if (w.fsw) return;
    let dir;
    try {
      dir = core.spaceDir(w.space);
    } catch {
      return; // no folder yet
    }
    try {
      let t;
      w.fsw = fs.watch(dir, () => {
        clearTimeout(t);
        t = setTimeout(() => check(w), 40); // a save is several events; look once
      });
      w.fsw.on('error', () => {}); // the interval still looks
    } catch {
      /* no fs events: the interval is enough */
    }
  }
  function watch(space) {
    core.validSpace(space); // refuses a bad space name before anything is watched
    unwatch();
    let last;
    try {
      last = core.signature(space);
    } catch (e) {
      last = `error:${e.code}`;
    }
    const w = { space, last };
    watcher = w;
    arm(w);
    w.timer = setInterval(() => check(w), POLL_MS);
  }

  const handlers = {
    list: (m) => core.list(m.space),
    read: (m) => core.read(m.space, m.file, { folder: m.folder }),
    write: (m) => core.write(m.space, m.file, m.text, m.base === undefined ? null : m.base, { folder: m.folder }),
    create: (m) => core.create(m.space, m.file, m.text ?? '', { folder: m.folder }),
    watch: (m) => (watch(m.space), {}),
    spaces: () => core.spaces(),
    mkspace: (m) => core.mkspace(m.space),
    renamespace: (m) => core.renamespace(m.space, m.to),
    cover: (m) => core.cover(m.space),
    putcover: (m) => core.putcover(m.space, m.data),
    model: (m) => core.model(m.space, m.file, { folder: m.folder, offset: m.offset }),
    trash: (m) => core.trash(m.space, m.file, { folder: m.folder }),
    untrash: (m) => core.untrash(m.space, m.trashId, { to: m.to }),
    rename: (m) => core.rename(m.space, m.file, m.to, { folder: m.folder }),
    search: (m) => core.search(m.space, m.q),
    ping: () => ({ max: core.MAX_FILE, ops: Object.keys(handlers) }),
  };

  function handle(msg) {
    const id = msg && typeof msg === 'object' ? msg.id : undefined;
    try {
      const h = msg && Object.hasOwn(handlers, msg.type) ? handlers[msg.type] : null;
      if (!h) throw new HostError('bad-request', 'unknown request');
      send({ ...h(msg), id, ok: true }); // id and ok last: an answer's own fields can never replace them
    } catch (e) {
      if (e instanceof HostError) send({ id, error: e.code, message: e.message, ...(e.code === 'conflict' ? { theirs: e.extra?.theirs ?? null, reason: e.extra?.reason, hash: e.extra?.hash, size: e.extra?.size, gone: e.extra?.gone } : {}) });
      else send({ id, error: 'internal', message: String(e?.message || e) });
    }
  }

  let buf = Buffer.alloc(0);
  stdin.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (buf.length < 4) return;
      const len = little ? buf.readUInt32LE(0) : buf.readUInt32BE(0);
      if (len > MAX_IN) return exit(3);
      if (buf.length < 4 + len) return;
      const body = buf.subarray(4, 4 + len);
      buf = buf.subarray(4 + len);
      let msg;
      try {
        msg = JSON.parse(body.toString('utf8'));
      } catch {
        send({ error: 'bad-request', message: 'not JSON' });
        continue;
      }
      handle(msg);
    }
  });
  const end = () => {
    unwatch();
    exit(0);
  };
  stdin.on('end', end);
  stdin.on('close', end);
  return { handle, send, unwatch };
}

if (require.main === module) {
  // Chrome passes the origin of the page that connected as an argument. Its manifest already limits
  // who can start this host to the one extension it was installed for; this is the second lock. The
  // allowed origin comes from the launcher (--origin, see install-host.js and origin.js), never from a constant.
  if (!startedBy(process.argv, allowedOrigin(process.argv))) {
    process.stderr.write('board-host: not started by the megatabs extension\n');
    process.exit(2);
  }
  const i = process.argv.indexOf('--root');
  start({ root: i > 0 ? path.resolve(process.argv[i + 1]) : path.join(os.homedir(), 'Spaces') });
}

module.exports = { start };
