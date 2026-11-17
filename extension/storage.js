// Where the Board's files live, behind ONE small interface so the page code calls one API (C46).
//
//   store = { kind: 'host' | 'folder', max, call(type, args) -> Promise, name? }
//
// `call` takes the same requests and gives the same answers (and the same error codes) whichever path is behind it,
// so board.js and the canvas bundle never ask which one they have. The requests are the ones the native host
// (host/board-host.js) documents: ping, list, read, write, create, watch, trash, untrash, rename, search, and model
// (read-only chunks of a .glb or .gltf).
//
//   - host:   the native-messaging helper. The preferred path: atomic writes, hard-link and symlink guards, real
//             file events, and it can reach ~/Spaces from outside the browser's sandbox.
//   - folder: a folder he picks once (File System Access API: showDirectoryPicker, handle kept in IndexedDB,
//             permission asked again on load). No helper to install. Same conflict rules: a save carries the hash
//             it loaded and is refused, with their text and hash, when the file is no longer those bytes; a new
//             file never replaces one. What a browser cannot give: an exclusive create or a rename-over, so the
//             check-then-write window is a few milliseconds wider than the host's (checked again just before the
//             write is committed), and changes are found by polling once a second, not by file events.
//
// Layout of the picked folder is the host's: <folder>/<space>/<name>.md|.canvas, one folder level below that, trash
// in <folder>/.trash/<space>/. Classic script (no modules): it runs in the Board page and in node tests.

(function (g) {
  'use strict';

  const FOLDER_MAX = 8 * 1024 * 1024; // the browser has no 1 MB message to fit; a note this big is a mistake anyway
  const MAX_LIST = 500;
  const MAX_HITS = 200;
  const KIND = /\.(md|canvas)$/i;
  const MODEL = /\.(glb|gltf)$/i; // 3D models: read-only (op `model`), never listed or written
  const MAX_MODEL = 24 * 1024 * 1024;
  const MODEL_CHUNK = 512 * 1024;
  const kindOf = (name) => (/\.canvas$/i.test(name) ? 'canvas' : 'md');
  const TS_SUFFIX = / (\d{8}T\d{6}-\d{3}Z)$/;
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const encoder = new TextEncoder();

  function fail(code, message, extra) {
    return Object.assign(new Error(message || code), { code }, extra || {});
  }

  function checkName(name, what, typed) {
    // eslint-disable-next-line no-control-regex
    if (typeof name !== 'string' || !name || name.length > 200 || /[\x00-\x1f\x7f/\\:]/.test(name) || name === '.' || name === '..' || name.startsWith('.') || name !== name.trim()) {
      throw fail('bad-name', `${what} name is not allowed`);
    }
    if (typed && !KIND.test(name)) throw fail('bad-type', 'only .md and .canvas files');
    return name;
  }

  function checkModelName(name) {
    checkName(name, 'file', false);
    if (!MODEL.test(name)) throw fail('bad-type', 'only .glb and .gltf models');
    return name;
  }

  // base64 of some bytes (in blocks, so a big chunk does not overflow the argument limit)
  function base64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return g.btoa(s);
  }

  // "glb" when the first bytes are "glTF", "gltf" when they are "{" (after an optional BOM and spaces), else null
  function sniffModel(bytes) {
    if (bytes.length >= 12 && bytes[0] === 0x67 && bytes[1] === 0x6c && bytes[2] === 0x54 && bytes[3] === 0x46) return 'glb';
    const head = new TextDecoder('utf-8').decode(bytes.subarray(0, 64)).replace(/^\uFEFF/, '').trimStart();
    return head.startsWith('{') ? 'gltf' : null;
  }

  async function sha(bytes) {
    const d = new Uint8Array(await g.crypto.subtle.digest('SHA-256', bytes));
    let s = '';
    for (const b of d) s += b.toString(16).padStart(2, '0');
    return s;
  }

  function titleOf(text, file) {
    const m = kindOf(file) === 'md' ? text.match(/^#[ \t]+(.+?)[ \t#]*$/m) : null;
    return (m ? m[1] : file.replace(KIND, '')).trim();
  }

  const stamp = (t) => new Date(t).toISOString().replace(/[-:]/g, '').replace('.', '-'); // 20261116T121314-123Z
  const readmeFirst = (a, b) => /^readme\.md$/i.test(b.file) - /^readme\.md$/i.test(a.file) || a.file.localeCompare(b.file);
  const megatabFirst = (a, b) => /^megatab\.md$/i.test(b.file) - /^megatab\.md$/i.test(a.file) || a.file.localeCompare(b.file);
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function canvasTexts(text) {
    let v;
    try {
      v = JSON.parse(text);
    } catch {
      return [];
    }
    const out = [];
    for (const n of Array.isArray(v?.nodes) ? v.nodes : []) {
      if (!n || typeof n !== 'object') continue;
      for (const k of ['text', 'file', 'url', 'label']) if (typeof n[k] === 'string' && n[k]) out.push({ id: typeof n.id === 'string' ? n.id : null, text: n[k] });
    }
    return out;
  }

  const missing = (e) => e && (e.name === 'NotFoundError' || e.code === 'ENOENT');
  const nap = (ms) => new Promise((r) => setTimeout(r, ms));

  // The bytes of a file handle. A File the browser handed out is a snapshot: if the file is written to before the
  // bytes are read, the read fails with NotReadableError. That is "someone is writing it right now", not "it
  // cannot be read": ask for a fresh File and read again.
  async function bytesFromHandle(fh, file) {
    let f = file;
    for (let i = 0; ; i++) {
      try {
        if (!f) f = await fh.getFile();
        return { file: f, bytes: new Uint8Array(await f.arrayBuffer()) };
      } catch (e) {
        if (e.name !== 'NotReadableError' || i >= 4) throw e;
        f = null;
        await nap(25);
      }
    }
  }

  // ------------------------------------------------------------------ the picked folder

  function createFolderStorage(root, { pollMs = 1000 } = {}) {
    const max = FOLDER_MAX;
    let chain = Promise.resolve(); // one request at a time, in order, like the host's single port
    let watcher = null;
    const seen = new Map(); // "dir/name" -> { sig, entry }: a file that did not change is not read again

    const dirOf = async (space, folder, create) => {
      let d = root;
      for (const part of folder === undefined || folder === null ? [space] : [space, folder]) {
        try {
          d = await d.getDirectoryHandle(part, { create: !!create });
        } catch (e) {
          if (missing(e)) return null;
          throw fail('io', e.message);
        }
      }
      return d;
    };

    async function peek(dir, name) {
      let fh;
      try {
        fh = await dir.getFileHandle(name);
      } catch (e) {
        if (missing(e)) return null;
        if (e.name === 'TypeMismatchError') throw fail('not-file', 'not a regular file');
        throw fail('io', e.message);
      }
      return { fh, file: await fh.getFile() };
    }

    // The bytes of a file; null when missing. `cap`: bigger than that is "too-large" without reading it
    async function bytesOf(dir, name, cap = max) {
      const p = await peek(dir, name);
      if (!p) return null;
      if (p.file.size > cap) throw fail('too-large', `over ${Math.round(cap / 1024)} KB`);
      try {
        const r = await bytesFromHandle(p.fh, p.file);
        return { bytes: r.bytes, mtime: Math.round(r.file.lastModified), size: r.bytes.length };
      } catch (e) {
        throw fail('io', e.message || 'cannot read');
      }
    }

    const decode = (bytes) => {
      try {
        return decoder.decode(bytes);
      } catch {
        throw fail('not-utf8', 'the file is not valid UTF-8');
      }
    };

    // Names of the notes and canvases directly inside a folder, with size and mtime (no reading)
    async function names(dir) {
      const out = [];
      for await (const [name, h] of dir.entries()) {
        if (h.kind !== 'file' || name.startsWith('.') || !KIND.test(name)) continue;
        try {
          const f = await h.getFile();
          out.push({ name, size: f.size, mtime: Math.round(f.lastModified), fh: h, f });
        } catch {
          /* removed meanwhile */
        }
      }
      return out;
    }

    async function folderNames(dir) {
      const out = [];
      for await (const [name, h] of dir.entries()) {
        if (h.kind !== 'directory' || name.startsWith('.')) continue;
        try {
          out.push(checkName(name, 'folder', false));
        } catch {
          /* a name we would refuse is not listed */
        }
      }
      return out.sort((a, b) => a.localeCompare(b));
    }

    async function scan(dir, key, folder, budget) {
      const files = [];
      let big = 0;
      for (const n of await names(dir)) {
        if (budget.left <= 0) {
          big++;
          continue;
        }
        budget.left--;
        let f;
        try {
          f = await n.fh.getFile(); // looked at now, read at once: the shortest possible time for a writer to get in between
        } catch {
          continue; // removed meanwhile
        }
        const sig = `${f.size}:${Math.round(f.lastModified)}`;
        const ck = `${key}/${n.name}`;
        const hit = seen.get(ck);
        if (hit && hit.sig === sig) {
          files.push(hit.entry);
          continue;
        }
        let entry = { file: n.name, kind: kindOf(n.name), title: n.name.replace(KIND, ''), mtime: Math.round(f.lastModified), size: 0, hash: null, path: '' };
        if (folder !== undefined) entry.folder = folder;
        try {
          if (f.size > max) throw fail('too-large');
          const r = await bytesFromHandle(n.fh, f);
          const text = decode(r.bytes);
          entry = { ...entry, mtime: Math.round(r.file.lastModified), size: r.bytes.length, hash: await sha(r.bytes), title: titleOf(text, n.name) };
        } catch (e) {
          if (e.code === 'too-large' || e.code === 'not-utf8') {
            entry.unreadable = e.code;
          } else {
            files.push({ ...entry, unreadable: 'io' }); // a glitch: shown, not remembered, looked at again next time
            continue;
          }
        }
        seen.set(ck, { sig, entry });
        files.push(entry);
      }
      return { files, big };
    }

    async function list(space) {
      checkName(space, 'space', false);
      const dir = await dirOf(space);
      const budget = { left: MAX_LIST };
      if (!dir) return { space, dir: root.name, files: [], folders: [], more: 0, max };
      const top = await scan(dir, space, undefined, budget);
      top.files.sort(readmeFirst);
      let big = top.big;
      const folders = [];
      for (const f of await folderNames(dir)) {
        let d;
        try {
          d = await dir.getDirectoryHandle(f);
        } catch {
          continue;
        }
        const r = await scan(d, `${space}/${f}`, f, budget);
        big += r.big;
        r.files.sort(megatabFirst);
        folders.push({ folder: f, path: '', files: r.files });
      }
      return { space, dir: root.name, files: top.files, folders, more: big, max };
    }

    async function read(space, file, { folder } = {}) {
      checkName(space, 'space', false);
      checkName(file, 'file', true);
      if (folder !== undefined && folder !== null) checkName(folder, 'folder', false);
      const dir = await dirOf(space, folder);
      if (!dir && folder !== undefined && folder !== null && (await dirOf(space))) throw fail('no-folder', `no folder ${folder} in ${space}`);
      const r = dir ? await bytesOf(dir, file) : null;
      if (!r) throw fail('gone', `${file} does not exist`);
      return { text: decode(r.bytes), hash: await sha(r.bytes), mtime: r.mtime, size: r.size };
    }

    // What a conflict tells the caller, as the host does: their text when it can be shown, always their hash
    async function conflictOf(dir, file, reason) {
      let cur;
      try {
        cur = await bytesOf(dir, file, 64 * 1024 * 1024);
      } catch (e) {
        return { theirs: null, reason: e.code === 'too-large' ? 'too-large' : 'io' };
      }
      if (!cur) return { theirs: null, reason: 'gone', gone: true };
      const hash = await sha(cur.bytes);
      let theirs = null;
      if (cur.size <= max) {
        try {
          theirs = { text: decode(cur.bytes), hash, mtime: cur.mtime };
        } catch {
          theirs = null;
        }
      }
      return { theirs, reason: reason || (cur.size > max ? 'too-large' : theirs ? 'changed' : 'not-utf8'), hash, size: cur.size };
    }

    async function write(space, file, text, base, { folder } = {}) {
      checkName(space, 'space', false);
      checkName(file, 'file', true);
      if (folder !== undefined && folder !== null) checkName(folder, 'folder', false);
      if (typeof text !== 'string') throw fail('bad-text', 'text must be a string');
      const bytes = encoder.encode(text);
      if (decoder.decode(bytes) !== text) throw fail('bad-text', 'text is not valid Unicode');
      if (bytes.length > max) throw fail('too-large', `over ${Math.round(max / 1024)} KB`);
      if (kindOf(file) === 'canvas') {
        let v;
        try {
          v = JSON.parse(text);
        } catch {
          throw fail('bad-text', 'a .canvas must be JSON');
        }
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw fail('bad-text', 'a .canvas must be a JSON object');
      }
      if (base !== null && !(typeof base === 'string' && /^[0-9a-f]{64}$/.test(base))) throw fail('bad-base', 'base must be a hash or null');
      const sub = folder !== undefined && folder !== null;
      const dir = await dirOf(space, folder, base === null && !sub); // a new file may start its space, never a mega tab folder
      if (!dir) {
        if (sub && (await dirOf(space))) throw fail('no-folder', `no folder ${folder} in ${space}`);
        throw fail('conflict', 'gone', { theirs: null, reason: 'gone', gone: true });
      }

      // What is there must be what the caller loaded. `own`: a new file, and the empty one the browser made for it
      // when its handle was taken is ours, not a rival.
      const check = async (own) => {
        let cur;
        try {
          cur = await bytesOf(dir, file, 64 * 1024 * 1024);
        } catch (e) {
          if (e.code === 'too-large') return { ...(await conflictOf(dir, file)), reason: 'too-large' };
          throw e;
        }
        if (base === null) {
          if (!cur || (own && cur.size === 0)) return null;
          const c = await conflictOf(dir, file);
          return { ...c, reason: c.theirs ? 'exists' : c.reason };
        }
        if (!cur) return { theirs: null, reason: 'gone', gone: true };
        if ((await sha(cur.bytes)) !== base) return conflictOf(dir, file);
        return null;
      };
      const first = await check();
      if (first) throw fail('conflict', first.reason, first);

      let fh;
      try {
        fh = await dir.getFileHandle(file, { create: true });
      } catch (e) {
        throw fail('io', e.message);
      }
      // A new file starts as an empty one; if this write does not happen, that placeholder does not stay behind
      const unplace = async () => {
        if (base !== null) return;
        try {
          if ((await (await dir.getFileHandle(file)).getFile()).size === 0) await dir.removeEntry(file);
        } catch {
          /* already gone */
        }
      };
      let w;
      try {
        w = await fh.createWritable(); // written to a swap file; the real file changes when it is closed
        await w.write(bytes);
        // The last look before the commit: an outside write that landed meanwhile is not overwritten
        const last = await check(true);
        if (last) {
          await w.abort().catch(() => {});
          await unplace();
          throw fail('conflict', last.reason, last);
        }
        await w.close();
      } catch (e) {
        if (e.code === 'conflict') throw e;
        try {
          await w?.abort();
        } catch {
          /* already closed */
        }
        await unplace();
        throw fail('io', e.message || 'cannot write');
      }
      const f = await (await dir.getFileHandle(file)).getFile();
      return { hash: await sha(bytes), mtime: Math.round(f.lastModified), size: bytes.length };
    }

    const create = (space, file, text, o) => write(space, file, text, null, o);

    // ---------------------------------------------------------- models (read only)

    // The same answer as the host's `model`: one chunk of a .glb or .gltf, { size, mtime, offset, length, data, done }
    async function model(space, file, { folder, offset } = {}) {
      checkName(space, 'space', false);
      checkModelName(file);
      if (folder !== undefined && folder !== null) checkName(folder, 'folder', false);
      const at = offset === undefined || offset === null ? 0 : offset;
      if (!Number.isInteger(at) || at < 0) throw fail('bad-offset', 'offset must be a whole number of bytes, 0 or more');
      const dir = await dirOf(space, folder);
      if (!dir && folder !== undefined && folder !== null && (await dirOf(space))) throw fail('no-folder', `no folder ${folder} in ${space}`);
      const p = dir ? await peek(dir, file) : null;
      if (!p) throw fail('gone', `${file} does not exist`);
      if (p.file.size > MAX_MODEL) throw fail('too-large', `a model is at most ${MAX_MODEL / 1048576} MB`);
      if (at > p.file.size) throw fail('bad-offset', 'offset is past the end of the file');
      let bytes;
      try {
        bytes = new Uint8Array(await p.file.slice(at, Math.min(p.file.size, at + MODEL_CHUNK)).arrayBuffer());
      } catch (e) {
        throw fail('io', e.message || 'cannot read');
      }
      if (at === 0) {
        const want = /\.glb$/i.test(file) ? 'glb' : 'gltf';
        if (sniffModel(bytes) !== want) throw fail('bad-model', `this is not a ${want === 'glb' ? 'binary glTF (.glb)' : 'glTF text (.gltf)'} file`);
      }
      return { size: p.file.size, mtime: Math.round(p.file.lastModified), offset: at, length: bytes.length, data: base64(bytes), done: at + bytes.length >= p.file.size };
    }

    // ---------------------------------------------------------- trash, untrash, rename

    async function trashDirOf(space, folder, create) {
      let d = root;
      for (const part of ['.trash', space, ...(folder ? [folder] : [])]) {
        try {
          d = await d.getDirectoryHandle(part, { create });
        } catch (e) {
          if (missing(e)) return null;
          throw fail('io', e.message);
        }
      }
      return d;
    }

    // Copies bytes to a name that must not exist yet, then removes the source. Never replaces anything.
    async function moveNew(srcDir, srcName, dstDir, dstName) {
      const src = await bytesOf(srcDir, srcName, 64 * 1024 * 1024);
      if (!src) throw fail('gone', `${srcName} does not exist`);
      if (await peek(dstDir, dstName)) throw fail('exists', 'that name is taken');
      const fh = await dstDir.getFileHandle(dstName, { create: true });
      const w = await fh.createWritable();
      await w.write(src.bytes);
      await w.close();
      const back = new Uint8Array(await (await fh.getFile()).arrayBuffer());
      if ((await sha(back)) !== (await sha(src.bytes))) throw fail('io', 'the copy differs; the original was not removed');
      await srcDir.removeEntry(srcName);
    }

    async function trash(space, file, { folder } = {}) {
      checkName(space, 'space', false);
      checkName(file, 'file', true);
      if (folder !== undefined && folder !== null) checkName(folder, 'folder', false);
      const dir = await dirOf(space, folder);
      if (!dir || !(await peek(dir, file))) throw fail('gone', `${file} does not exist`);
      const tdir = await trashDirOf(space, folder, true);
      let at = Date.now();
      for (;;) {
        const name = `${file} ${stamp(at)}`;
        try {
          await moveNew(dir, file, tdir, name);
          return { trashId: folder ? `${folder}/${name}` : name, file, ...(folder ? { folder } : {}), trashed: `.trash/${space}/${folder ? folder + '/' : ''}${name}` };
        } catch (e) {
          if (e.code !== 'exists') throw e;
          at++;
        }
      }
    }

    async function untrash(space, id, { to } = {}) {
      checkName(space, 'space', false);
      if (typeof id !== 'string') throw fail('bad-name', 'id is not a trash id');
      const parts = id.split('/');
      if (parts.length > 2) throw fail('bad-name', 'not a trash id');
      const folder = parts.length === 2 ? checkName(parts[0], 'folder', false) : undefined;
      const stored = parts[parts.length - 1];
      const m = stored.match(TS_SUFFIX);
      if (!m) throw fail('bad-name', 'not a trash id');
      const original = checkName(stored.slice(0, m.index), 'file', true);
      const name = to === undefined || to === null ? original : checkName(to, 'file', true);
      if (kindOf(name) !== kindOf(original)) throw fail('bad-type', 'a note stays a note and a canvas a canvas');
      const tdir = await trashDirOf(space, folder, false);
      if (!tdir) throw fail('gone', 'nothing in the trash by that name');
      const dir = await dirOf(space, folder, true);
      await moveNew(tdir, stored, dir, name);
      return { file: name, ...(folder ? { folder } : {}) };
    }

    async function rename(space, file, to, { folder } = {}) {
      checkName(space, 'space', false);
      checkName(file, 'file', true);
      checkName(to, 'file', true);
      if (folder !== undefined && folder !== null) checkName(folder, 'folder', false);
      if (kindOf(file) !== kindOf(to)) throw fail('bad-type', 'a note stays a note and a canvas a canvas');
      if (to === file) throw fail('exists', 'that is already its name');
      const dir = await dirOf(space, folder);
      if (!dir || !(await peek(dir, file))) throw fail('gone', `${file} does not exist`);
      const caseOnly = to.toLowerCase() === file.toLowerCase();
      if (!caseOnly || (await peek(dir, to)) === null) {
        await moveNew(dir, file, dir, to);
      } else {
        // a case-only change on a folder that ignores case: through a temporary name
        const tmp = `${file} ${stamp(Date.now())}.renaming`;
        await moveNew(dir, file, dir, tmp);
        await moveNew(dir, tmp, dir, to);
      }
      const out = { file: to, ...(folder ? { folder } : {}) };
      const r = await bytesOf(dir, to).catch(() => null);
      if (r) Object.assign(out, { hash: await sha(r.bytes), mtime: r.mtime, size: r.size });
      return out;
    }

    // ---------------------------------------------------------- search

    async function search(space, q) {
      checkName(space, 'space', false);
      if (typeof q !== 'string' || !q.trim() || q.length > 200) throw fail('bad-query', 'a search needs 1 to 200 characters');
      const re = new RegExp(escapeRe(q.trim()), 'iu');
      const hits = [];
      let scanned = 0;
      let more = false;
      const dir = await dirOf(space);
      const walk = async (d, folder) => {
        const list = (await names(d)).sort((a, b) => (folder === undefined ? readmeFirst({ file: a.name }, { file: b.name }) : megatabFirst({ file: a.name }, { file: b.name })));
        for (const n of list) {
          if (scanned >= MAX_LIST) return;
          scanned++;
          let text;
          try {
            if (n.size > max) continue;
            text = decode((await bytesFromHandle(n.fh)).bytes);
          } catch {
            continue;
          }
          const file = n.name;
          const title = titleOf(text, file);
          const inTitle = re.test(title) || re.test(file.replace(KIND, ''));
          let line = null;
          let index = null;
          let snippet = null;
          let node;
          let body = text;
          if (kindOf(file) === 'canvas') {
            body = '';
            for (const t of canvasTexts(text)) {
              if (re.test(t.text)) {
                body = t.text;
                node = t.id ?? undefined;
                break;
              }
            }
          }
          const m = body ? re.exec(body) : null;
          if (m) {
            index = m.index;
            line = kindOf(file) === 'md' ? body.slice(0, m.index).split('\n').length : null;
            snippet = body.slice(Math.max(0, m.index - 40), m.index + m[0].length + 60).replace(/\s+/g, ' ').trim();
          }
          if (!inTitle && !m) continue;
          if (hits.length >= MAX_HITS) {
            more = true;
            return;
          }
          hits.push({ ...(folder !== undefined ? { folder } : {}), file, kind: kindOf(file), title, inTitle, line, index, snippet, ...(node ? { node } : {}) });
        }
      };
      if (dir) {
        await walk(dir, undefined);
        for (const f of await folderNames(dir)) {
          if (scanned >= MAX_LIST || more) break;
          try {
            await walk(await dir.getDirectoryHandle(f), f);
          } catch {
            /* vanished meanwhile */
          }
        }
      }
      return { space, q: q.trim(), hits, scanned, more };
    }

    // ---------------------------------------------------------- watch (a look once a second)

    async function signature(space) {
      const dir = await dirOf(space);
      if (!dir) return 'none';
      const parts = [];
      for (const n of await names(dir)) parts.push(`${n.name}:${n.size}:${n.mtime}`);
      for (const f of await folderNames(dir)) {
        parts.push(`${f}/`);
        try {
          for (const n of await names(await dir.getDirectoryHandle(f))) parts.push(`${f}/${n.name}:${n.size}:${n.mtime}`);
        } catch {
          /* vanished meanwhile */
        }
      }
      return parts.sort().join('|');
    }

    function unwatch() {
      if (watcher) clearInterval(watcher.timer);
      watcher = null;
    }

    async function watch(space) {
      checkName(space, 'space', false);
      unwatch();
      const w = { space, last: await signature(space).catch(() => 'error'), busy: false };
      w.timer = setInterval(async () => {
        if (watcher !== w || w.busy) return;
        w.busy = true;
        try {
          const sig = await signature(space).catch(() => 'error');
          if (sig === w.last || watcher !== w) return;
          w.last = sig;
          const answer = await list(space);
          // A file that was being written when it was looked at is listed as a glitch: the same look is made again
          // next time, so the page is never left with the glitch as the last word
          if ([...answer.files, ...answer.folders.flatMap((g) => g.files)].some((e) => e.unreadable === 'io')) w.last = 'again';
          store.onPush?.({ type: 'changed', space, ...answer });
        } catch (e) {
          store.onPush?.({ type: 'changed', space, error: e.code || 'io', message: e.message });
        } finally {
          w.busy = false;
        }
      }, pollMs);
      watcher = w;
      return {};
    }

    const handlers = {
      ping: async () => ({ max, ops: ['ping', 'list', 'read', 'write', 'create', 'watch', 'trash', 'untrash', 'rename', 'search', 'model'] }),
      list: (m) => list(m.space),
      read: (m) => read(m.space, m.file, { folder: m.folder }),
      write: (m) => write(m.space, m.file, m.text, m.base === undefined ? null : m.base, { folder: m.folder }),
      create: (m) => create(m.space, m.file, m.text ?? '', { folder: m.folder }),
      watch: (m) => watch(m.space),
      trash: (m) => trash(m.space, m.file, { folder: m.folder }),
      untrash: (m) => untrash(m.space, m.trashId, { to: m.to }),
      rename: (m) => rename(m.space, m.file, m.to, { folder: m.folder }),
      search: (m) => search(m.space, m.q),
      model: (m) => model(m.space, m.file, { folder: m.folder, offset: m.offset }),
    };

    const store = {
      kind: 'folder',
      name: root.name,
      max,
      onPush: null, // (msg) set by the page: { type: 'changed', ... } like the host's pushes
      call(type, args = {}) {
        const run = chain.then(() => {
          if (!Object.hasOwn(handlers, type)) throw fail('bad-request', 'unknown request');
          return handlers[type](args);
        });
        chain = run.catch(() => {});
        return run;
      },
      close: unwatch,
    };
    return store;
  }

  // ------------------------------------------------------------------ the native host

  // A port to the native-messaging host, speaking the same `call` as the folder. `onPush(msg)` gets the host's
  // pushes; `onGone(why)` says the port closed (why: Chrome's message, e.g. "Specified native messaging host not found").
  function createHostStorage({ name, connect, onPush, onGone }) {
    let port = null;
    let nextId = 0;
    const pending = new Map();
    const store = {
      kind: 'host',
      max: 0, // set from the host's ping, never written here
      get connected() {
        return !!port;
      },
      open() {
        const p = connect();
        port = p;
        p.onMessage.addListener((msg) => {
          if (msg && msg.id && pending.has(msg.id)) {
            const q = pending.get(msg.id);
            pending.delete(msg.id);
            if (msg.error) q.reject(Object.assign(new Error(msg.message || msg.error), { code: msg.error, theirs: msg.theirs, reason: msg.reason, hash: msg.hash, size: msg.size, gone: msg.gone }));
            else q.resolve(msg);
          } else if (msg && msg.type === 'changed') onPush?.(msg);
        });
        p.onDisconnect.addListener(() => {
          const why = (g.chrome && g.chrome.runtime && g.chrome.runtime.lastError && g.chrome.runtime.lastError.message) || '';
          if (port === p) port = null;
          for (const { reject } of pending.values()) reject(Object.assign(new Error('host gone'), { code: 'offline' }));
          pending.clear();
          onGone?.(why);
        });
        return p;
      },
      call(type, args = {}) {
        return new Promise((resolve, reject) => {
          if (!port) return reject(Object.assign(new Error('The Board host is not connected'), { code: 'offline' }));
          const id = ++nextId;
          pending.set(id, { resolve, reject });
          try {
            port.postMessage({ id, type, ...args });
          } catch (e) {
            pending.delete(id);
            reject(Object.assign(e, { code: 'offline' }));
          }
        });
      },
      close() {
        try {
          port?.disconnect();
        } catch {
          /* already closed */
        }
        port = null;
      },
    };
    void name;
    return store;
  }

  // ------------------------------------------------------------------ the picked folder, kept between visits

  const DB = 'megatabs-board';
  const KEY = 'root';
  const idb = () =>
    new Promise((resolve, reject) => {
      const r = g.indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  const tx = async (mode, fn) => {
    const db = await idb();
    try {
      return await new Promise((resolve, reject) => {
        const t = db.transaction('kv', mode);
        const q = fn(t.objectStore('kv'));
        t.oncomplete = () => resolve(q && q.result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      });
    } finally {
      db.close();
    }
  };
  const folderKeep = {
    save: (handle) => tx('readwrite', (s) => s.put(handle, KEY)),
    load: () => tx('readonly', (s) => s.get(KEY)).then((h) => h || null),
    forget: () => tx('readwrite', (s) => s.delete(KEY)),
    // 'granted' | 'prompt' | 'denied': asked without a prompt
    permission: async (h) => (h.queryPermission ? h.queryPermission({ mode: 'readwrite' }) : 'granted'),
    // Needs a click: the browser only shows its prompt for a user action
    ask: async (h) => (h.requestPermission ? h.requestPermission({ mode: 'readwrite' }) : 'granted'),
    pick: () => g.showDirectoryPicker({ id: 'megatabs-spaces', mode: 'readwrite' }),
  };

  const api = { createFolderStorage, createHostStorage, folderKeep, FOLDER_MAX };
  g.MegatabsStorage = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
