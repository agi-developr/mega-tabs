'use strict';
// The whole of what the Board host may do: list, read, write, create, rename, trash and search the .md and
// .canvas files that sit inside ~/Spaces/<space>/ (and one folder level below that), make and rename space
// folders, and read or set a space's cover image. Nothing else under ~/Spaces, nothing outside it.
//
// Rules (each is a test in test/host.test.js):
//   - <space>, <folder> and <file> are single names: no "/", "\", "..", control characters or leading dot;
//     <file> ends in .md (Notes) or .canvas (Canvas, JSON Canvas 1.0). Anything else is refused
//     before the disk is touched. A .canvas is also refused on write unless its text is a JSON object.
//   - Reach: ~/Spaces/<space>/<file> and ~/Spaces/<space>/<folder>/<file>. Two levels down is out of reach.
//   - A space or folder that is a symlink is refused; so is a file that is a symlink or has more
//     than one hard link (a symlink or hard link could lead out of ~/Spaces). Files are opened with
//     O_NOFOLLOW. ~/Spaces itself may be a symlink (its real path is the root).
//   - A save carries the hash of the bytes the Board loaded (`base`). If the file on disk has other
//     bytes now, nothing is written and the file's current hash (and its text, when it can be shown)
//     comes back ("conflict"). The caller may then save again with that hash as the base ("Keep mine").
//   - A save is atomic: the bytes go to a hidden temp file in the same folder, are synced, and
//     replace the file in one rename. The file that was there is first moved aside in one step and
//     compared with `base`, so an outside write cannot slip in between the check and the replace
//     (REVIEW-0.9.0 #10). A new file is linked into place, so it never replaces one that appeared a
//     moment earlier.
//   - Text is UTF-8 and kept byte for byte (BOM, blank lines, a missing final newline). A file that
//     is not valid UTF-8, or is over MAX_FILE, cannot be read or shown; it is replaced only by a save
//     that names its exact hash.
//   - Nothing is ever deleted: trash moves a file to ~/Spaces/.trash/<space>/[<folder>/]<name> <timestamp>
//     and untrash moves it back. Rename, untrash, mkspace and renamespace never replace anything.
//   - Models: a .glb or .gltf in the same two places can be READ (op `model`), as raw bytes in chunks, never
//     written, listed, renamed or trashed. Same name, symlink and hard link rules; at most MAX_MODEL bytes; the first
//     bytes must look like the format the name claims.
// No network, no child processes: only node:fs, node:path, node:crypto.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Raw bytes of a note or canvas. 480 KB so that its JSON-escaped text (a canvas escapes every tab,
// newline and quote, up to twice its size) still fits Chrome's 1 MB limit for a host answer.
const MAX_FILE = 480 * 1024;
const MAX_ESCAPED = 985000; // the text as it travels inside a JSON answer; the rest of an answer is under 1 KB
const MAX_PEEK = 32 * 1024 * 1024; // the biggest file we will read just to hash it and say "this is what is there"
const MAX_LIST = 500;
const MAX_HITS = 200;
const MAX_COVER = 700 * 1024; // base64 of this plus the answer around it stays under 1 MB
const KIND = /\.(md|canvas)$/i; // the two file types the Board may touch
const kindOf = (name) => (/\.canvas$/i.test(name) ? 'canvas' : 'md');
const MODEL = /\.(glb|gltf)$/i; // 3D models: read-only (op `model`), never listed or written
const MAX_MODEL = 24 * 1024 * 1024; // the biggest model we will serve
const MODEL_CHUNK = 512 * 1024; // raw bytes per answer: 683 KB as base64, which with the answer around it stays under 1 MB
const COVER_NAME = /^cover\.(png|jpe?g|webp)$/i;
const COVER_RANK = ['png', 'jpg', 'jpeg', 'webp'];
const TS_SUFFIX = / (\d{8}T\d{6}-\d{3}Z)$/;
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }); // ignoreBOM: keep a BOM in the text

class HostError extends Error {
  constructor(code, message, extra) {
    super(message || code);
    this.code = code;
    this.extra = extra;
  }
}

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const fitsReply = (text) => Buffer.byteLength(JSON.stringify(text)) <= MAX_ESCAPED;

// First "# heading" of a note, else its name without the extension (a canvas has no heading)
function titleOf(text, file) {
  const m = kindOf(file) === 'md' ? text.match(/^#[ \t]+(.+?)[ \t#]*$/m) : null;
  return (m ? m[1] : file.replace(KIND, '')).trim();
}

function checkName(name, what, typed) {
  if (typeof name !== 'string' || !name || name.length > 200) throw new HostError('bad-name', `${what} name is empty or too long`);
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f/\\:]/.test(name) || name === '.' || name === '..' || name.startsWith('.') || name !== name.trim()) {
    throw new HostError('bad-name', `${what} name is not allowed: ${JSON.stringify(name)}`);
  }
  if (typed && !KIND.test(name)) throw new HostError('bad-type', 'only .md and .canvas files');
  return name;
}

function checkModelName(name) {
  checkName(name, 'file', false);
  if (!MODEL.test(name)) throw new HostError('bad-type', 'only .glb and .gltf models');
  return name;
}

// The model kind of some first bytes: a binary glTF starts with "glTF", a glTF text with "{" (after an optional BOM and spaces)
function sniffModel(buf) {
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'glTF') return 'glb';
  const head = buf.subarray(0, 64).toString('utf8').replace(/^\uFEFF/, '').trimStart();
  return head.startsWith('{') ? 'gltf' : null;
}

// The picture kind of some bytes by their first bytes, never by the name or the declared type
function sniffImage(buf) {
  if (buf.length > 12 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: 'png' };
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  return null;
}

const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace('.', '-'); // 20261116T160533-123Z
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The words a canvas shows, for search: card text, file card paths, link urls, group labels
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

function createCore({ root }) {
  const realRoot = () => {
    try {
      return fs.realpathSync(root);
    } catch {
      throw new HostError('no-root', 'the Spaces folder does not exist');
    }
  };

  function spaceDir(space) {
    checkName(space, 'space', false);
    const dir = path.join(realRoot(), space);
    let st;
    try {
      st = fs.lstatSync(dir);
    } catch {
      throw new HostError('no-space', `no folder ${space} in Spaces`);
    }
    if (st.isSymbolicLink()) throw new HostError('symlink', 'a space folder that is a symlink is refused');
    if (!st.isDirectory()) throw new HostError('no-space', `${space} is not a folder`);
    return dir;
  }

  // The folder files live in: the space itself, or one folder inside it
  function placeDir(space, folder) {
    const sd = spaceDir(space);
    if (folder === undefined || folder === null) return sd;
    checkName(folder, 'folder', false);
    const dir = path.join(sd, folder);
    let st;
    try {
      st = fs.lstatSync(dir);
    } catch {
      throw new HostError('no-folder', `no folder ${folder} in ${space}`);
    }
    if (st.isSymbolicLink()) throw new HostError('symlink', 'a folder that is a symlink is refused');
    if (!st.isDirectory()) throw new HostError('no-folder', `${folder} is not a folder`);
    return dir;
  }

  // The bytes of an existing regular file, or null when it is missing. Never follows a symlink.
  function readBytes(abs, cap = MAX_FILE) {
    let fd;
    try {
      fd = fs.openSync(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      if (e.code === 'ELOOP') throw new HostError('symlink', 'a symlink is refused');
      throw new HostError('io', e.code || 'cannot open');
    }
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile()) throw new HostError('not-file', 'not a regular file');
      if (st.nlink > 1) throw new HostError('hardlink', 'a file with several hard links is refused');
      if (st.size > cap) throw new HostError('too-large', `over ${cap / 1024} KB`);
      const buf = Buffer.alloc(st.size);
      let n = 0;
      while (n < st.size) {
        const r = fs.readSync(fd, buf, n, st.size - n, n);
        if (!r) break;
        n += r;
      }
      return { buf: buf.subarray(0, n), mode: st.mode & 0o7777, mtime: Math.round(st.mtimeMs), ino: st.ino };
    } finally {
      fs.closeSync(fd);
    }
  }

  function decode(buf) {
    try {
      return decoder.decode(buf);
    } catch {
      throw new HostError('not-utf8', 'the file is not valid UTF-8');
    }
  }

  // A name that is not taken yet, reserved by creating it empty (exclusive). The caller then renames the
  // real thing over this empty placeholder, which is one atomic step that cannot replace anything of value.
  function claim(abs) {
    try {
      fs.closeSync(fs.openSync(abs, 'wx', 0o600));
    } catch (e) {
      if (e.code === 'EEXIST') throw new HostError('exists', 'that name is taken');
      throw new HostError('io', e.code || 'cannot create');
    }
  }
  // Moves src to a dst that must not exist, never replacing anything
  function moveNew(src, dst) {
    claim(dst);
    try {
      fs.renameSync(src, dst);
    } catch (e) {
      fs.rmSync(dst, { force: true }); // our own empty placeholder
      throw new HostError('io', e.code || 'cannot move');
    }
  }
  function ensureDir(abs) {
    let st = null;
    try {
      st = fs.lstatSync(abs);
    } catch {
      /* not there yet */
    }
    if (st) {
      if (st.isSymbolicLink() || !st.isDirectory()) throw new HostError('io', 'the trash folder is not a plain folder');
      return;
    }
    try {
      fs.mkdirSync(abs, { mode: 0o700 });
    } catch (e) {
      if (e.code !== 'EEXIST') throw new HostError('io', e.code || 'cannot create folder');
    }
  }

  // The notes and canvases directly inside dir, as list entries
  function scan(dir, folder, budget) {
    const files = [];
    let big = 0;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isFile() || e.name.startsWith('.') || !KIND.test(e.name)) continue; // a symlink entry is not isFile()
      if (budget.left <= 0) {
        big++;
        continue;
      }
      budget.left--;
      let entry = { file: e.name, kind: kindOf(e.name), title: e.name.replace(KIND, ''), mtime: 0, size: 0, hash: null, path: path.join(dir, e.name) };
      if (folder !== undefined) entry.folder = folder;
      try {
        const r = readBytes(path.join(dir, e.name));
        if (r) {
          const text = decode(r.buf);
          if (!fitsReply(text)) throw new HostError('too-large', 'answer would be over 1 MB');
          entry = { ...entry, mtime: r.mtime, size: r.buf.length, hash: sha(r.buf), title: titleOf(text, e.name) };
        }
      } catch (err) {
        entry.unreadable = err.code || 'io'; // listed, cannot be opened (too large, not UTF-8, hard link)
      }
      files.push(entry);
    }
    return { files, big };
  }
  const readmeFirst = (a, b) => /^readme\.md$/i.test(b.file) - /^readme\.md$/i.test(a.file) || a.file.localeCompare(b.file);
  const megatabFirst = (a, b) => /^megatab\.md$/i.test(b.file) - /^megatab\.md$/i.test(a.file) || a.file.localeCompare(b.file);

  // The one-level folders of a space: real folders, not hidden, not symlinks
  function folderNames(dir) {
    const names = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      try {
        names.push(checkName(e.name, 'folder', false));
      } catch {
        /* a name we would refuse is not listed */
      }
    }
    return names.sort((a, b) => a.localeCompare(b));
  }

  // files: the space's own notes (README first); folders: [{ folder, path, files }] one level down (MEGATAB.md first)
  function list(space) {
    const dir = spaceDir(space);
    const budget = { left: MAX_LIST };
    const top = scan(dir, undefined, budget);
    top.files.sort(readmeFirst);
    let big = top.big;
    const folders = [];
    for (const name of folderNames(dir)) {
      const fdir = path.join(dir, name);
      let r;
      try {
        r = scan(fdir, name, budget);
      } catch {
        continue; // vanished or unreadable meanwhile
      }
      big += r.big;
      r.files.sort(megatabFirst);
      folders.push({ folder: name, path: fdir, files: r.files });
    }
    return { space, dir, files: top.files, folders, more: big, max: MAX_FILE };
  }

  function read(space, file, { folder } = {}) {
    const dir = placeDir(space, folder);
    checkName(file, 'file', true);
    const r = readBytes(path.join(dir, file));
    if (!r) throw new HostError('gone', `${file} does not exist`);
    const text = decode(r.buf);
    if (!fitsReply(text)) throw new HostError('too-large', 'answer would be over 1 MB');
    return { text, hash: sha(r.buf), mtime: r.mtime, size: r.buf.length };
  }

  // base: hash of the bytes the caller loaded, or null to say "this file must not exist yet"
  function write(space, file, text, base, { folder } = {}) {
    const dir = placeDir(space, folder);
    checkName(file, 'file', true);
    if (typeof text !== 'string') throw new HostError('bad-text', 'text must be a string');
    const buf = Buffer.from(text, 'utf8');
    if (buf.toString('utf8') !== text) throw new HostError('bad-text', 'text is not valid Unicode');
    if (buf.length > MAX_FILE) throw new HostError('too-large', `over ${MAX_FILE / 1024} KB`);
    if (!fitsReply(text)) throw new HostError('too-large', 'too large to read back in one answer');
    if (kindOf(file) === 'canvas') {
      // A canvas the other readers (Obsidian, ...) could not open is refused here, never written
      let v;
      try {
        v = JSON.parse(text);
      } catch {
        throw new HostError('bad-text', 'a .canvas must be JSON');
      }
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new HostError('bad-text', 'a .canvas must be a JSON object');
    }
    if (base !== null && !(typeof base === 'string' && /^[0-9a-f]{64}$/.test(base))) throw new HostError('bad-base', 'base must be a hash or null');
    const abs = path.join(dir, file);

    // What a conflict tells the caller: their text when it can be shown, and always the hash of what is
    // on disk, so that "Keep mine" works even when the bytes are too big or not UTF-8 (REVIEW-0.9.0 #9)
    const asTheirs = (cur) => {
      if (cur.buf.length > MAX_FILE) return null;
      try {
        const t = decode(cur.buf);
        return fitsReply(t) ? { text: t, hash: sha(cur.buf), mtime: cur.mtime } : null;
      } catch {
        return null;
      }
    };
    const conflictOf = (cur, reason) => {
      const theirs = asTheirs(cur);
      const r = reason || (cur.buf.length > MAX_FILE ? 'too-large' : theirs ? 'changed' : 'not-utf8');
      return { conflict: true, theirs, reason: r, hash: sha(cur.buf), size: cur.buf.length };
    };

    // Compares what is on disk with what the caller loaded; returns what to tell the caller on a mismatch
    const mismatch = () => {
      let cur;
      try {
        cur = readBytes(abs, MAX_PEEK);
      } catch (e) {
        if (e.code === 'too-large') return { conflict: true, theirs: null, reason: 'too-large' }; // too big even to hash
        throw e;
      }
      if (base === null) {
        if (!cur) return null;
        const c = conflictOf(cur);
        return { ...c, reason: c.theirs ? 'exists' : c.reason };
      }
      if (!cur) return { conflict: true, gone: true, theirs: null, reason: 'gone' };
      if (sha(cur.buf) !== base) return conflictOf(cur);
      return { cur };
    };

    const first = mismatch();
    if (first?.conflict) throw new HostError('conflict', first.reason, first);
    const mode = first?.cur?.mode ?? 0o644;

    const tag = `${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
    const tmp = path.join(dir, `.${file}.${tag}.tmp`);
    const held = path.join(dir, `.${file}.${tag}.held`);
    let fd;
    try {
      fd = fs.openSync(tmp, 'wx', 0o600);
      let n = 0;
      while (n < buf.length) n += fs.writeSync(fd, buf, n, buf.length - n);
      fs.fchmodSync(fd, mode);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      if (base === null) {
        fs.linkSync(tmp, abs); // exclusive: fails if the name appeared meanwhile
      } else {
        // Take the file out of the way in one step, so that what we compare is exactly what we replace.
        // An outside write that lands before this step is in `held` and is caught; one that lands after
        // it finds no file and makes a new one, which the link below refuses to replace.
        try {
          fs.renameSync(abs, held);
        } catch (e) {
          if (e.code === 'ENOENT') throw new HostError('conflict', 'gone', { conflict: true, gone: true, theirs: null, reason: 'gone' });
          throw e;
        }
        let verified = false; // held holds exactly the bytes named by base
        try {
          let cur;
          try {
            cur = readBytes(held, MAX_PEEK);
          } catch (e) {
            // a symlink or hard link swapped in meanwhile, or too big to hash: put it back, write nothing
            throw new HostError('conflict', e.code, { conflict: true, theirs: null, reason: e.code });
          }
          if (!cur || sha(cur.buf) !== base) {
            const c = cur ? conflictOf(cur) : { conflict: true, theirs: null, reason: 'gone' };
            throw new HostError('conflict', c.reason, c);
          }
          verified = true;
          try {
            fs.linkSync(tmp, abs);
          } catch (e) {
            if (e.code !== 'EEXIST') throw e;
            // someone made a new file under this name in the last instant: theirs stays, ours is not written
            const now = readBytes(abs, MAX_PEEK);
            throw new HostError('conflict', 'changed', now ? conflictOf(now, 'changed') : { conflict: true, theirs: null, reason: 'changed' });
          }
        } finally {
          if (verified) {
            fs.rmSync(held, { force: true }); // the bytes we compared and replaced (their hash is `base`); the caller has the newer text
          } else {
            // Not our write: put what was there back under its name. If the name is taken again, keep it
            // as a hidden copy rather than lose it.
            try {
              fs.linkSync(held, abs);
              fs.rmSync(held, { force: true });
            } catch {
              try {
                fs.renameSync(held, path.join(dir, `.${file}.${stamp(Date.now())}.kept`));
              } catch {
                /* left as .held */
              }
            }
          }
        }
      }
    } catch (e) {
      if (e.code === 'EEXIST') {
        const m = mismatch();
        throw new HostError('conflict', 'exists', m?.conflict ? m : { conflict: true, theirs: null, reason: 'exists' });
      }
      if (e instanceof HostError) throw e;
      throw new HostError('io', e.code || 'cannot write');
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      fs.rmSync(tmp, { force: true }); // after a link it is the second name
    }
    const st = fs.statSync(abs);
    return { hash: sha(buf), mtime: Math.round(st.mtimeMs), size: buf.length };
  }

  // New note: never replaces a file
  function create(space, file, text, { folder } = {}) {
    return write(space, file, text, null, { folder });
  }

  // Cheap fingerprint of the space's .md and .canvas files and its folders' ones, for the watcher
  function signature(space) {
    const dir = spaceDir(space);
    const parts = [];
    const add = (d, prefix) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (!e.isFile() || e.name.startsWith('.') || !KIND.test(e.name)) continue;
        try {
          const st = fs.lstatSync(path.join(d, e.name));
          parts.push(`${prefix}${e.name}:${st.size}:${st.mtimeMs}:${st.ino}`);
        } catch {
          /* removed meanwhile: the next look sees it */
        }
      }
    };
    add(dir, '');
    for (const f of folderNames(dir)) {
      parts.push(`${f}/`);
      try {
        add(path.join(dir, f), `${f}/`);
      } catch {
        /* vanished meanwhile */
      }
    }
    return parts.sort().join('|');
  }

  // A space name that is allowed, whether or not its folder exists yet (watching waits for a folder)
  const validSpace = (space) => checkName(space, 'space', false);

  // ---------------------------------------------------------------- spaces and covers

  const coverFile = (dir) => {
    const found = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && COVER_NAME.test(e.name));
    found.sort((a, b) => COVER_RANK.indexOf(a.name.split('.').pop().toLowerCase()) - COVER_RANK.indexOf(b.name.split('.').pop().toLowerCase()));
    return found.map((e) => e.name);
  };

  // Every space folder in ~/Spaces: name, how many notes it holds at its top level, its cover file name
  function spaces() {
    const rr = realRoot();
    const out = [];
    for (const e of fs.readdirSync(rr, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue; // a symlinked space is not isDirectory(); .trash is hidden
      try {
        checkName(e.name, 'space', false);
      } catch {
        continue;
      }
      const dir = path.join(rr, e.name);
      let notes = 0;
      let cover = null;
      try {
        for (const f of fs.readdirSync(dir, { withFileTypes: true })) if (f.isFile() && !f.name.startsWith('.') && KIND.test(f.name)) notes++;
        cover = coverFile(dir)[0] || null;
      } catch {
        /* unreadable: listed with nothing in it */
      }
      out.push({ name: e.name, notes, cover });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return { root: rr, spaces: out };
  }

  // New space folder; never replaces or reuses an existing one
  function mkspace(space) {
    checkName(space, 'space', false);
    const dir = path.join(realRoot(), space);
    try {
      fs.mkdirSync(dir, { mode: 0o755 });
    } catch (e) {
      if (e.code === 'EEXIST') throw new HostError('exists', 'that name is taken');
      throw new HostError('io', e.code || 'cannot create');
    }
    return { space, dir };
  }

  // Renames a space folder, or changes nothing. A case-only change of the same folder is allowed.
  function renamespace(space, to) {
    const from = spaceDir(space);
    checkName(to, 'space', false);
    const dest = path.join(realRoot(), to);
    if (to === space) throw new HostError('exists', 'that is already its name');
    let st = null;
    try {
      st = fs.lstatSync(dest);
    } catch {
      /* free */
    }
    try {
      if (st) {
        const f = fs.lstatSync(from);
        if (st.ino !== f.ino || st.dev !== f.dev) throw new HostError('exists', 'that name is taken');
        fs.renameSync(from, dest); // the same folder under a name that differs only in case
      } else {
        try {
          fs.mkdirSync(dest, { mode: 0o755 }); // reserves the name; the rename replaces only this empty folder
        } catch (e) {
          if (e.code === 'EEXIST') throw new HostError('exists', 'that name is taken');
          throw e;
        }
        try {
          fs.renameSync(from, dest);
        } catch (e) {
          fs.rmdirSync(dest); // our own empty reservation
          throw e;
        }
      }
    } catch (e) {
      if (e instanceof HostError) throw e;
      throw new HostError('io', e.code || 'cannot rename');
    }
    return { space: to, dir: dest };
  }

  // The space's cover as a data: URL, or { cover: null } (with a reason when a file is there but not usable)
  function cover(space) {
    const dir = spaceDir(space);
    const names = coverFile(dir);
    if (!names.length) return { cover: null };
    const file = names[0];
    let r;
    try {
      r = readBytes(path.join(dir, file), MAX_COVER);
    } catch (e) {
      return { cover: null, file, reason: e.code || 'io' }; // too-large, symlink, hardlink
    }
    if (!r) return { cover: null };
    const kind = sniffImage(r.buf);
    const ext = file.split('.').pop().toLowerCase();
    const same = kind && (kind.ext === ext || (kind.ext === 'jpg' && ext === 'jpeg'));
    if (!same) return { cover: null, file, reason: 'bad-image' };
    return { cover: { file, mime: kind.mime, size: r.buf.length, hash: sha(r.buf), data: `data:${kind.mime};base64,${r.buf.toString('base64')}` } };
  }

  // Sets the cover from a data: URL (png, jpeg or webp, at most MAX_COVER bytes). What was the cover goes
  // to the trash, not away.
  function putcover(space, data) {
    const dir = spaceDir(space);
    const m = typeof data === 'string' && data.length < MAX_COVER * 2 && data.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
    if (!m) throw new HostError('bad-image', 'a png, jpeg or webp data: URL is needed');
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > MAX_COVER) throw new HostError('too-large', `a cover is at most ${MAX_COVER / 1024} KB`);
    const kind = sniffImage(buf);
    if (!kind || kind.mime !== `image/${m[1]}`) throw new HostError('bad-image', 'the bytes are not the image type they say');
    const name = `cover.${kind.ext}`;
    const abs = path.join(dir, name);
    const tmp = path.join(dir, `.${name}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
    let fd;
    try {
      fd = fs.openSync(tmp, 'wx', 0o600);
      let n = 0;
      while (n < buf.length) n += fs.writeSync(fd, buf, n, buf.length - n);
      fs.fchmodSync(fd, 0o644);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      const tdir = trashDir(space);
      for (const old of coverFile(dir)) {
        const from = path.join(dir, old);
        const st = fs.lstatSync(from);
        if (st.isSymbolicLink() || !st.isFile()) throw new HostError('symlink', 'a cover that is a symlink is refused');
        let at = Date.now();
        for (;;) {
          const dest = path.join(tdir, `${old} ${stamp(at)}`);
          if (old === name) {
            try {
              fs.linkSync(from, dest); // the new file replaces this name below; the old bytes stay in the trash
              break;
            } catch (e) {
              if (e.code !== 'EEXIST') throw e;
              at++;
            }
          } else {
            try {
              moveNew(from, dest);
              break;
            } catch (e) {
              if (e.code !== 'exists') throw e;
              at++;
            }
          }
        }
      }
      fs.renameSync(tmp, abs);
    } catch (e) {
      if (e instanceof HostError) throw e;
      throw new HostError('io', e.code || 'cannot write');
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      fs.rmSync(tmp, { force: true });
    }
    return { file: name, size: buf.length, hash: sha(buf) };
  }

  // ---------------------------------------------------------------- trash, untrash, rename

  const trashDir = (space, folder) => {
    const t = path.join(realRoot(), '.trash');
    ensureDir(t);
    const s = path.join(t, space);
    ensureDir(s);
    if (folder === undefined || folder === null) return s;
    const f = path.join(s, folder);
    ensureDir(f);
    return f;
  };

  // The plain file a name points at, for moving: never a symlink, never several hard links
  function plainFile(abs, file) {
    let st;
    try {
      st = fs.lstatSync(abs);
    } catch {
      throw new HostError('gone', `${file} does not exist`);
    }
    if (st.isSymbolicLink()) throw new HostError('symlink', 'a symlink is refused');
    if (!st.isFile()) throw new HostError('not-file', 'not a regular file');
    if (st.nlink > 1) throw new HostError('hardlink', 'a file with several hard links is refused');
    return st;
  }

  // Moves a note or canvas to ~/Spaces/.trash/<space>/[<folder>/]<name> <timestamp>. Never deletes.
  // Answers with the `trashId` that untrash needs: "[<folder>/]<name> <timestamp>" (not `id`: that is the message id).
  function trash(space, file, { folder } = {}) {
    const dir = placeDir(space, folder);
    checkName(file, 'file', true);
    const abs = path.join(dir, file);
    plainFile(abs, file);
    const tdir = trashDir(space, folder);
    let at = Date.now();
    for (;;) {
      const name = `${file} ${stamp(at)}`;
      try {
        moveNew(abs, path.join(tdir, name));
        return { trashId: folder ? `${folder}/${name}` : name, file, ...(folder ? { folder } : {}), trashed: path.join(tdir, name) };
      } catch (e) {
        if (e.code !== 'exists') throw e;
        at++; // two in the same millisecond
      }
    }
  }

  // Brings a trashed file back under its name (or `to`), never over a file that is there
  function untrash(space, id, { to } = {}) {
    if (typeof id !== 'string') throw new HostError('bad-name', 'id is not a trash id');
    const parts = id.split('/');
    if (parts.length > 2) throw new HostError('bad-name', 'not a trash id');
    const folder = parts.length === 2 ? checkName(parts[0], 'folder', false) : undefined;
    const stored = parts[parts.length - 1];
    const m = stored.match(TS_SUFFIX);
    if (!m) throw new HostError('bad-name', 'not a trash id');
    const original = checkName(stored.slice(0, m.index), 'file', true);
    const name = to === undefined || to === null ? original : checkName(to, 'file', true);
    if (kindOf(name) !== kindOf(original)) throw new HostError('bad-type', 'a note stays a note and a canvas a canvas');
    const dir = placeDir(space, folder);
    const tdir = path.join(realRoot(), '.trash', space, ...(folder ? [folder] : []));
    const src = path.join(tdir, stored);
    plainFile(src, stored);
    moveNew(src, path.join(dir, name));
    return { file: name, ...(folder ? { folder } : {}) };
  }

  // Renames a note or canvas inside its folder. A name that is taken is refused and nothing moves.
  function rename(space, file, to, { folder } = {}) {
    const dir = placeDir(space, folder);
    checkName(file, 'file', true);
    checkName(to, 'file', true);
    if (kindOf(file) !== kindOf(to)) throw new HostError('bad-type', 'a note stays a note and a canvas a canvas');
    const from = path.join(dir, file);
    const dest = path.join(dir, to);
    if (to === file) throw new HostError('exists', 'that is already its name');
    const st = plainFile(from, file);
    let other = null;
    try {
      other = fs.lstatSync(dest);
    } catch {
      /* free */
    }
    try {
      if (other) {
        if (other.ino !== st.ino || other.dev !== st.dev) throw new HostError('exists', 'that name is taken');
        fs.renameSync(from, dest); // the same file under a name that differs only in case
      } else {
        moveNew(from, dest);
      }
    } catch (e) {
      if (e instanceof HostError) throw e;
      throw new HostError('io', e.code || 'cannot rename');
    }
    const out = { file: to, ...(folder ? { folder } : {}) };
    try {
      const r = readBytes(dest);
      if (r) Object.assign(out, { hash: sha(r.buf), mtime: r.mtime, size: r.buf.length });
    } catch {
      /* renamed; its hash is not known (too large, not UTF-8) */
    }
    return out;
  }

  // ---------------------------------------------------------------- search

  // Notes and canvases whose title, name or text hold `q` (case-insensitive), top level first, then each folder.
  // A hit: { folder?, file, kind, title, inTitle, line, index, snippet, node? }. line/index/snippet point at the
  // first match in the text; a canvas hit carries the id of the card that matched.
  function search(space, q) {
    const dir = spaceDir(space);
    if (typeof q !== 'string' || !q.trim() || q.length > 200) throw new HostError('bad-query', 'a search needs 1 to 200 characters');
    const re = new RegExp(escapeRe(q.trim()), 'iu');
    const hits = [];
    let scanned = 0;
    let more = false;
    const walk = (d, folder) => {
      const names = fs
        .readdirSync(d, { withFileTypes: true })
        .filter((e) => e.isFile() && !e.name.startsWith('.') && KIND.test(e.name))
        .map((e) => e.name)
        .sort(folder === undefined ? (a, b) => readmeFirst({ file: a }, { file: b }) : (a, b) => megatabFirst({ file: a }, { file: b }));
      for (const file of names) {
        if (scanned >= MAX_LIST) return;
        scanned++;
        let text;
        try {
          const r = readBytes(path.join(d, file));
          if (!r) continue;
          text = decode(r.buf);
        } catch {
          continue; // cannot be opened, so cannot be searched
        }
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
    walk(dir, undefined);
    for (const f of folderNames(dir)) {
      if (scanned >= MAX_LIST || more) break;
      try {
        walk(path.join(dir, f), f);
      } catch {
        /* vanished meanwhile */
      }
    }
    return { space, q: q.trim(), hits, scanned, more };
  }

  // A model's bytes, one chunk at a time: { size, mtime, offset, length, data (base64), done }. Read only: nothing here
  // writes, creates or moves a file. The caller asks offset 0, then offset + length, until `done`; `size` and `mtime` must
  // be the same in every answer (else the file changed meanwhile and it starts again).
  function model(space, file, { folder, offset } = {}) {
    const dir = placeDir(space, folder);
    checkModelName(file);
    const at = offset === undefined || offset === null ? 0 : offset;
    if (!Number.isInteger(at) || at < 0) throw new HostError('bad-offset', 'offset must be a whole number of bytes, 0 or more');
    let fd;
    try {
      fd = fs.openSync(path.join(dir, file), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    } catch (e) {
      if (e.code === 'ENOENT') throw new HostError('gone', `${file} does not exist`);
      if (e.code === 'ELOOP') throw new HostError('symlink', 'a symlink is refused');
      throw new HostError('io', e.code || 'cannot open');
    }
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile()) throw new HostError('not-file', 'not a regular file');
      if (st.nlink > 1) throw new HostError('hardlink', 'a file with several hard links is refused');
      if (st.size > MAX_MODEL) throw new HostError('too-large', `a model is at most ${MAX_MODEL / 1048576} MB`);
      if (at > st.size) throw new HostError('bad-offset', 'offset is past the end of the file');
      const buf = Buffer.alloc(Math.min(MODEL_CHUNK, st.size - at));
      let n = 0;
      while (n < buf.length) {
        const r = fs.readSync(fd, buf, n, buf.length - n, at + n);
        if (!r) break;
        n += r;
      }
      const got = buf.subarray(0, n);
      if (at === 0) {
        const kind = sniffModel(got);
        const want = /\.glb$/i.test(file) ? 'glb' : 'gltf';
        if (kind !== want) throw new HostError('bad-model', `this is not a ${want === 'glb' ? 'binary glTF (.glb)' : 'glTF text (.gltf)'} file`);
      }
      return { size: st.size, mtime: Math.round(st.mtimeMs), offset: at, length: n, data: got.toString('base64'), done: at + n >= st.size };
    } finally {
      fs.closeSync(fd);
    }
  }

  return { list, read, write, create, signature, model, spaceDir, validSpace, spaces, mkspace, renamespace, cover, putcover, trash, untrash, rename, search, MAX_FILE };
}

module.exports = { createCore, HostError, titleOf, sha, kindOf, MAX_FILE, MAX_COVER, MAX_MODEL, MODEL_CHUNK };
