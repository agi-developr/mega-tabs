// Canvas room of the Board: shows one .canvas file (JSON Canvas 1.0) of the space with React Flow.
// Loaded after board.js and sharing its page scope (call, space, files, canvases, current, room, el,
// render, ...). The canvas itself is vendor/canvas.js, built from canvas/ (see canvas/build.js); it is
// loaded the first time this room is opened, so Notes does not pay for it. Reading, saving, merging an
// outside edit and the pen are all in that bundle (canvas/src/session.mjs); this file only mounts it
// and passes it what the page knows. No network: the bundle talks to the host through `call` only.

let canvasHandle = null; // { session, disk, touch, flush, focusNode, unsafe, destroy } of the open canvas
let canvasFile = ''; // key of the open canvas (Folder/name.canvas when it sits in a mega tab folder)
let canvasToken = 0; // a newer open cancels an older one that is still mounting
let canvasBundle = null;
let threeBundle = null;
const models = new Map(); // "Folder/name.glb" -> Promise<{ bytes, key }>: a model is read once per open canvas

// The 3D bundle (three.js, 3d-force-graph, vendor/canvas3d.js): loaded the first time a card shows a model or the 3D
// view is switched on, never for a canvas that has neither
function loadThreeBundle() {
  threeBundle ??= new Promise((resolve, reject) => {
    if (globalThis.MegatabsThree) return resolve(globalThis.MegatabsThree);
    const s = document.createElement('script');
    s.src = 'vendor/canvas3d.js';
    s.onload = () => (globalThis.MegatabsThree ? resolve(globalThis.MegatabsThree) : reject(new Error('vendor/canvas3d.js did not start')));
    s.onerror = () => {
      threeBundle = null;
      reject(new Error('vendor/canvas3d.js did not load'));
    };
    document.head.append(s);
  });
  return threeBundle;
}

// The bytes of a .glb or .gltf of this space ("name.glb" or "Folder/name.glb"), through the storage's read-only `model`
// request in chunks. `key` changes when the file does (size and time), so a re-read model is parsed again.
function readModel(name) {
  if (!models.has(name)) {
    const parts = String(name).split('/');
    const p = (async () => {
      if (parts.length > 2 || parts.some((x) => !x)) throw Object.assign(new Error('a model must sit in the space folder or one folder down'), { code: 'bad-name' });
      const where = parts.length === 2 ? { folder: parts[0], file: parts[1] } : { file: parts[0] };
      for (let attempt = 0; attempt < 3; attempt++) {
        const chunks = [];
        let offset = 0;
        let stamp = null;
        let changed = false;
        for (;;) {
          const r = await call('model', { space, ...where, offset });
          const now = `${r.size}:${r.mtime}`;
          if (stamp && stamp !== now) {
            changed = true; // the file was replaced between two chunks: start again
            break;
          }
          stamp = now;
          const bin = atob(r.data);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          chunks.push(bytes);
          offset += bytes.length;
          if (r.done || !bytes.length) break;
        }
        if (changed) continue;
        const all = new Uint8Array(offset);
        let at = 0;
        for (const c of chunks) {
          all.set(c, at);
          at += c.length;
        }
        return { bytes: all.buffer, key: `${space}/${name}:${stamp}` };
      }
      throw Object.assign(new Error('the model keeps changing while it is read'), { code: 'busy' });
    })();
    models.set(name, p);
    p.catch(() => models.delete(name)); // a failure is asked again next time
  }
  return models.get(name);
}

function loadCanvasBundle() {
  canvasBundle ??= new Promise((resolve, reject) => {
    if (globalThis.MegatabsCanvas) return resolve();
    const s = document.createElement('script');
    s.src = 'vendor/canvas.js';
    s.onload = () => resolve();
    s.onerror = () => {
      canvasBundle = null;
      reject(new Error('vendor/canvas.js did not load'));
    };
    document.head.append(s);
  });
  return canvasBundle;
}

const emptyCanvasNote = () => {
  if (store?.kind === 'folder') return tr('emptyCanvasFolder');
  return folder ? tr('emptyCanvasDir', space) : tr('noFolderCanvas', space);
};

function canvasNote(text) {
  canvasEl.replaceChildren(el('div', { class: 'note' }, text));
}

// What the cards on the canvas get from this page
function canvasHost(f) {
  return {
    call,
    t: tr, // the page's texts (chrome.i18n): the bundle never carries its own
    space,
    file: f.file,
    folder: f.folder,
    max: () => maxBytes, // the storage's own cap (its ping/list `max`), never a number written here
    drafts: canvasDrafts,
    render: (md) => render(md),
    noteTitle: (name) => find(name)?.title ?? null,
    openNote: (name) => showNote(name),
    openCanvas: (name) => openCanvas(name, true),
    readModel,
    three: loadThreeBundle,
    cursorHref: (name) => (spaceDir && store?.kind === 'host' ? 'cursor://file' + encodeURI(`${spaceDir}/${name}`) : ''),
    // "Drop it" on a canvas deleted from outside: the room lets it go and shows another
    dropped: () => dropCanvas(),
  };
}

async function dropCanvas() {
  const h = canvasHandle;
  if (!h) return;
  h.session.drop();
  const gone = canvasFile;
  await leaveCanvas();
  current = '';
  await refreshList();
  const rest = canvases.filter((c) => c.key !== gone);
  if (rest.length) openCanvas(rest[0].key, true);
  else canvasNote(tr('removedFromFolder', gone));
}

// Shows the room: the canvas named by the address, else the first one
function showCanvasRoom(file) {
  docEl.hidden = true;
  canvasEl.hidden = false;
  if (canvasHandle) return canvasChanged(); // reconnected to the host: look at the open canvas again
  if (!folder || !canvases.length) return canvasNote(emptyCanvasNote());
  const want = file || decodeURIComponent(location.hash.slice(1));
  return openCanvas(find(want, canvases) ? want : canvases[0].key, true);
}

async function leaveCanvas() {
  canvasToken++;
  models.clear();
  const h = canvasHandle;
  canvasHandle = null;
  canvasFile = '';
  if (h) {
    await h.flush().catch(() => {}); // what is unsaved is written first
    h.destroy();
  }
  canvasEl.replaceChildren();
}

async function openCanvas(key, remember, opts = {}) {
  const f = find(key, canvases);
  if (!f) return;
  if (canvasHandle && canvasFile === key) {
    if (opts.node) canvasHandle.focusNode(opts.node);
    return;
  }
  await leaveCanvas();
  const token = canvasToken;
  current = key;
  if (remember) {
    history.replaceState(null, '', '#' + encodeURIComponent(key));
    rememberOpen(key);
  }
  drawList();
  if (f.unreadable) {
    canvasEl.replaceChildren(el('div', { class: 'doc-bar' }, el('span', {}, f.key), f.path ? el('a', { href: 'cursor://file' + encodeURI(f.path), title: tr('openCursorTitle') }, tr('openCursor')) : null),
      el('div', { class: 'note' }, tr(f.path ? 'cannotOpenCanvasCursor' : 'cannotOpenCanvas', f.unreadable)));
    return;
  }
  const host = el('div', { class: 'canvas-host' });
  canvasEl.replaceChildren(host);
  let handle;
  try {
    await loadCanvasBundle();
    await mirror.pull(`canvas-draft:${space}/${key}`); // unsaved changes of a closed tab come back
    handle = await globalThis.MegatabsCanvas.mount(host, canvasHost(f));
  } catch (e) {
    if (token === canvasToken) canvasNote(e.code === 'offline' ? tr('waitingStorage') : tr('couldNotOpen', key, e.message));
    return;
  }
  if (token !== canvasToken) {
    handle.destroy(); // another canvas was picked, or the room was left, meanwhile
    return;
  }
  canvasHandle = handle;
  canvasFile = key;
  canvasChanged(); // the file may have changed while it was being read
  if (opts.node) setTimeout(() => handle.focusNode(opts.node), 200); // a search hit: the card that matched, in view
}

// The host's list changed (it also pushes when his own save lands): file cards re-read their notes, and
// the session looks at the open file
function canvasChanged() {
  if (!canvasHandle) {
    if (!current && canvases.length) showCanvasRoom();
    else if (!canvases.length) canvasNote(emptyCanvasNote());
    return;
  }
  if (renaming && renaming === canvasFile) return; // his own rename moves the open canvas itself
  canvasHandle.touch();
  const f = find(canvasFile, canvases);
  // A canvas the list marks unreadable is still there: only a missing one is "deleted"
  canvasHandle.disk(f).catch(() => {});
}

function flushCanvas() {
  canvasHandle?.flush().catch(() => {});
}
