// Board: two rooms on the plain files of one space (?space=Name). Notes reads and edits the .md
// files: a calm list on the left (the space's own notes, then one quiet group per mega tab folder), the
// selected file on the right, shown rendered; "Edit" (or E) turns the same pane into an editor of the same
// text, "Done" (or Esc) goes back. Canvas (canvas-room.js) shows the .canvas files as a React Flow board.
// The files are ~/Spaces/<space>/*.md and *.canvas themselves (and one folder level below), listed, read,
// saved, renamed, trashed, searched and watched through ONE storage interface (storage.js): the native
// helper when it is installed, else a folder he picks once. A save by him or by Claude Code never reloads
// this page or the extension.
//
// Reused, not written here: marked (MIT) renders markdown, DOMPurify (Apache-2.0/MPL-2.0) cleans it,
// OverType (MIT) is the editor. It edits the raw text (a textarea under a styled layer), so the file
// is never rebuilt from a document model. No network: remote images are dropped, no request is made.

const HOST = 'com.megatabs.board';
const SAVE_MS = 500; // quiet time after typing before the file is saved
const UNDO_MS = 10000; // how long "Deleted · Undo" stays

const space = new URLSearchParams(location.search).get('space') || '';
const listEl = document.getElementById('files');
const docEl = document.getElementById('doc');
const bannerEl = document.getElementById('banner');
const alertEl = document.getElementById('alert');
const toastEl = document.getElementById('toast');
const whereEl = document.getElementById('where');
const searchEl = document.getElementById('search');
const newBtn = document.getElementById('new');
let files = [];     // [{ key, file, folder?, kind, title, mtime, size, hash, path, unreadable? }]: the .md files of this space and its folders
let canvases = [];  // the same for its .canvas files
let groups = [];    // the names of the one-level folders, in order
let spaceDir = '';  // the folder's absolute path, as the host reports it ('' for a picked folder)
let folder = true;  // false when ~/Spaces/<space> does not exist
let maxBytes = 0;   // the biggest file the storage takes: read from its ping/list, never written here
let store = null;   // the storage in use: the native host or the picked folder (storage.js)
let fromLast = false; // the room was taken from "the file last open here", not from the address
let room = roomOf(decodeURIComponent(location.hash.slice(1))); // 'notes' or 'canvas'
let current = '';   // key of the file shown (in the room that is open)
let doc = null;     // the open note, see openFile()
let renaming = ''; // key of the file being renamed: its change pushes are not read as "removed"
const canvasEl = document.getElementById('canvas');
const roomBtns = { notes: document.getElementById('room-notes'), canvas: document.getElementById('room-canvas') };
const keyOf = (f) => (f.folder ? `${f.folder}/${f.file}` : f.file);
const find = (key, list = files) => list.find((x) => x.key === key);
// What a request about one file carries: the space, its folder (when it sits in one) and its name
const ref = (f) => ({ space, ...(f.folder ? { folder: f.folder } : {}), file: f.file });
const extOf = (name) => (/\.canvas$/i.test(name) ? '.canvas' : '.md');
const plainName = (name) => name.replace(/\.(md|canvas)$/i, '');

// The address hash is the open file's key (Folder/name.md); a name ending in .canvas means the Canvas room
function roomOf(hash) {
  return /\.canvas$/i.test(hash) || hash === ':canvas' ? 'canvas' : 'notes';
}

// The storage lists both kinds of file; each room keeps its own
function setFiles(r) {
  const all = [...(r.files || []), ...(r.folders || []).flatMap((g) => g.files || [])];
  for (const f of all) f.key = keyOf(f);
  groups = (r.folders || []).map((g) => g.folder);
  files = all.filter((f) => f.kind !== 'canvas');
  canvases = all.filter((f) => f.kind === 'canvas');
  if (r.dir) spaceDir = r.dir;
  if (r.max) maxBytes = r.max;
}

localize();
document.title = space ? tr('boardTitle', space) : tr('board');
document.getElementById('space-name').textContent = space || tr('board');

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'class') n.className = v;
    else n.setAttribute(k, v);
  }
  for (const k of kids) if (k != null) n.append(k);
  return n;
}

// ---------------------------------------------------------------- Storage connection

let retry = null;
let hostStore = null;

// One request to whichever storage is in use; the canvas bundle calls this too
function call(type, args = {}) {
  if (!store) return Promise.reject(Object.assign(new Error('The Board storage is not connected'), { code: 'offline' }));
  return store.call(type, args);
}

function onPush(msg) {
  if (msg && msg.type === 'changed' && msg.space === space) onChanged(msg).catch(() => {});
}

// A dim line at the top; `kids` are text and buttons
function banner(...kids) {
  bannerEl.hidden = !kids.length;
  bannerEl.replaceChildren(...kids);
}

// A refused save is said once, plainly, where he is looking: not a dim word in a corner
function alertBar(text, ...actions) {
  alertEl.hidden = !text;
  alertEl.replaceChildren(...(text ? [el('span', {}, text), ...actions] : []));
}

function openSetup() {
  window.open(chrome.runtime.getURL('home.html#setup'), '_blank');
}

// Files are off: the one line, with the ways out (C26, C46). The same line asked for again is not redrawn.
let lastOff = '';
function filesOff(why, ...extra) {
  const sig = JSON.stringify([why, extra.map((e) => e.id)]);
  if (sig === lastOff && !bannerEl.hidden) return;
  lastOff = sig;
  banner(
    el('div', { class: 'off' }, tr('filesOffLead') + ' ', el('button', { class: 'quiet', id: 'setup', type: 'button', onclick: openSetup }, tr('setUp')), ...extra),
    why ? el('div', { class: 'why' }, why) : null,
  );
}

function chooseButton() {
  return el('button', { class: 'quiet', id: 'choose-folder', type: 'button', onclick: chooseFolder }, tr('chooseFolder'));
}

async function chooseFolder() {
  let handle;
  try {
    handle = await MegatabsStorage.folderKeep.pick();
  } catch {
    return; // closed the picker
  }
  try {
    await MegatabsStorage.folderKeep.save(handle);
  } catch { /* the folder works this visit; it is asked for again next time */ }
  location.reload(); // a clean start on the new folder: nothing of the old one stays on screen
}

// The native helper first. If it is not installed, the folder he picked before, if any
function connect() {
  clearTimeout(retry);
  const s = MegatabsStorage.createHostStorage({
    connect: () => chrome.runtime.connectNative(HOST),
    onPush,
    onGone: (why) => {
      if (hostStore !== s) return;
      if (store === s) store = null;
      hostStore = null;
      if (/not found/i.test(why)) return hostMissing(tr('hostMissing', installCommand()));
      if (/forbidden/i.test(why)) filesOff(tr('hostForbidden', installCommand()), chooseButton());
      else banner(el('div', { class: 'off' }, tr('hostStopped')));
      retry = setTimeout(connect, 2000);
    },
  });
  hostStore = s;
  try {
    s.open();
  } catch (e) {
    hostStore = null;
    hostMissing(tr('hostUnreachable', e.message));
    return;
  }
  begin(s).catch(() => {}); // a failure here is the disconnect above
}

// No host: offer the folder path; keep looking for the host (it may be installed meanwhile)
async function hostMissing(why) {
  if (store?.kind === 'folder') return; // already working in his folder
  let handle = null;
  try {
    handle = await MegatabsStorage.folderKeep.load();
  } catch { /* no IndexedDB: no remembered folder */ }
  if (handle) {
    let p = 'prompt';
    try {
      p = await MegatabsStorage.folderKeep.permission(handle);
    } catch { /* ask again below */ }
    if (p === 'granted') return useFolder(handle);
    filesOff(why, el('button', { class: 'quiet', id: 'allow-folder', type: 'button', onclick: async () => {
      let r = 'denied';
      try {
        r = await MegatabsStorage.folderKeep.ask(handle);
      } catch { /* denied */ }
      if (r === 'granted') await useFolder(handle);
    } }, tr('allowFolder', handle.name)), chooseButton());
  } else {
    filesOff(why, chooseButton());
  }
  retry = setTimeout(connect, 5000);
}

async function useFolder(handle) {
  clearTimeout(retry);
  hostStore?.close?.();
  hostStore = null;
  const s = MegatabsStorage.createFolderStorage(handle);
  s.onPush = onPush;
  await begin(s);
}

// A storage is connected: read its cap, watch the space, show the files
async function begin(s) {
  store = s;
  const p = await call('ping');
  s.max = maxBytes = p.max || s.max || 0;
  await call('watch', { space }); // also fine for a folder that is not there yet: the host waits for it
  lastOff = '';
  banner();
  drawWhere();
  await refreshList();
  if (room === 'canvas') {
    if (fromLast && !canvases.length && files.length) {
      fromLast = false;
      return switchRoom('notes');
    }
    return showCanvasRoom();
  }
  if (!doc && (!folder || !files.length)) return note(emptyNote());
  if (doc) afterList(); // reconnected: look at the open file again
  else openFirst();
}

// Where the files are, when it is not the helper: his folder, and how to change it
function drawWhere() {
  whereEl.hidden = store?.kind !== 'folder';
  if (store?.kind !== 'folder') return;
  whereEl.replaceChildren(el('span', {}, tr('folderLabel', store.name)), ' ', el('button', { class: 'quiet', type: 'button', id: 'change-folder', onclick: chooseFolder }, tr('change')));
}

// ---------------------------------------------------------------- Text helpers

// The editor (a textarea) works in "\n". A file with CRLF line endings throughout is edited as such and
// saved back with CRLF; a file with mixed or lone-CR endings is not edited here (null).
function eolOf(raw) {
  if (!/\r/.test(raw)) return '\n';
  return /\r(?!\n)/.test(raw) || /(^|[^\r])\n/.test(raw) ? null : '\r\n';
}
const toEditor = (d, raw) => (d.eol === '\r\n' ? raw.replace(/\r\n/g, '\n') : raw);
const toDisk = (d, text) => (d.eol === '\r\n' ? text.replace(/\n/g, '\r\n') : text);
const dirty = (d) => d.text !== d.baseText;
// What is on disk, as the page keeps it: the bytes' text (raw), the same in editor form (text), their hash
function diskOf(d, raw, hash, mtime) {
  return { hash, raw, text: toEditor({ eol: eolOf(raw) ?? d.eol }, raw), mtime };
}

// An unsaved draft survives a reload of this page (a code change reloads the extension) in the tab's sessionStorage,
// and a closed tab or a browser restart in the profile's local storage (a mirror, read back when the file is
// opened again): text typed while the host is away or a conflict is open is never lost with the tab (REVIEW-0.9.0 #7).
const draftKey = (key) => `board-draft:${space}/${key}`;
const mirror = {
  set(k, v) {
    try {
      chrome.storage.local.set({ [k]: v });
    } catch { /* the tab's own copy remains */ }
  },
  remove(k) {
    try {
      chrome.storage.local.remove(k);
    } catch { /* nothing to remove */ }
  },
  // Brings the mirror's copy into this tab when the tab has none (a tab that was closed and opened again)
  async pull(k) {
    try {
      const v = (await chrome.storage.local.get(k))[k];
      if (typeof v === 'string' && sessionStorage.getItem(k) === null) sessionStorage.setItem(k, v);
    } catch { /* no mirror */ }
  },
};
const drafts = {
  get: (k) => sessionStorage.getItem(k),
  set(k, v) {
    sessionStorage.setItem(k, v);
    mirror.set(k, v);
  },
  remove(k) {
    sessionStorage.removeItem(k);
    mirror.remove(k);
  },
};
function saveDraft(d) {
  try {
    if (dirty(d)) drafts.set(draftKey(d.key), JSON.stringify({ text: d.text, base: d.base, baseText: d.baseText, eol: d.eol }));
    else drafts.remove(draftKey(d.key));
  } catch { /* storage full or off: the file itself is still saved */ }
}
async function loadDraft(key) {
  await mirror.pull(draftKey(key));
  try {
    return JSON.parse(drafts.get(draftKey(key)) || 'null');
  } catch {
    return null;
  }
}
function moveDraft(from, to) {
  try {
    const v = drafts.get(draftKey(from));
    if (v !== null) {
      drafts.set(draftKey(to), v);
      drafts.remove(draftKey(from));
    }
  } catch { /* nothing to move */ }
}
// The same kind of draft for a canvas lives in the canvas session; the bundle gets this store
const canvasDrafts = drafts;

// ---------------------------------------------------------------- Rendering (read view)

// Links and images in rendered markdown: web links open in a new tab, links to a sibling .md
// file open it here, everything that would load something from the network is dropped.
const LOADERS = ['video', 'audio', 'source', 'picture', 'track', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'frame', 'frameset'];
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  // Anything that could fetch a resource is dropped: srcset and poster on any tag, the old background attribute,
  // and every input that is not a (task list) checkbox (type=image loads its src) (REVIEW-0.9.0 #3)
  for (const a of ['srcset', 'poster', 'background', 'ping', 'data', 'dynsrc', 'lowsrc']) node.removeAttribute?.(a);
  if (node.tagName === 'INPUT' && (node.getAttribute('type') || '').toLowerCase() !== 'checkbox') node.remove();
  if (node.tagName === 'IMG') {
    const src = node.getAttribute('src') || '';
    if (!/^data:image\//i.test(src)) {
      node.removeAttribute('src');
      node.className = 'img-off';
    }
  }
  if (/^(image|use|feimage)$/i.test(node.tagName || '')) {
    // SVG pictures fetch their href as well: only a same-document reference is kept
    for (const a of ['href', 'xlink:href']) if (node.getAttribute?.(a) && !/^#/.test(node.getAttribute(a))) node.removeAttribute(a);
  }
  if (node.tagName === 'A') {
    const href = node.getAttribute('href') || '';
    if (/^https?:/i.test(href)) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    } else if (/^[^:/?#]+\.md$/i.test(href.split('#')[0]) || /^[^:/?#]+\/[^:/?#]+\.md$/i.test(href.split('#')[0])) {
      // A link name with a stray % (100%.md) is shown as written, never an error (REVIEW-0.9.0 #8)
      let name = href.split('#')[0];
      try {
        name = decodeURIComponent(name);
      } catch { /* shown as written */ }
      node.setAttribute('data-md', name);
    }
  }
});

function render(md) {
  const html = marked.parse(md, { gfm: true });
  return DOMPurify.sanitize(html, { FORBID_TAGS: ['style', 'form', 'button', 'textarea', 'select', ...LOADERS], FORBID_ATTR: ['style', 'srcset', 'poster', 'background'] });
}

const when = (ms) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
// The name shown for a file: MEGATAB.md is the mega tab's "How it works"
const shownTitle = (f) => (f.folder && /^megatab\.md$/i.test(f.file) ? tr('howItWorks') : f.title);

// ---------------------------------------------------------------- The list: groups, search results, row actions

let query = '';      // what is typed in the search box
let hits = null;     // the storage's answer for it, or null when not searching
let searchAsked = '';
let searchBusy = false;

function metaOf(f) {
  if (f.unreadable) return tr('cannotOpenMeta', f.unreadable);
  return shownTitle(f) === plainName(f.file) || shownTitle(f) === tr('howItWorks') ? when(f.mtime) : `${f.file} · ${when(f.mtime)}`;
}

let renameFor = null; // { key, text, msg }: the row whose name is a field; it survives redraws of the list

function row(f, inCanvas, extra) {
  if (renameFor?.key === f.key) return renameRow(f);
  // The file already open is not opened again by a click on it (that would drop him out of the editor); a search hit still opens, to show the match
  const open = () => {
    if (f.key === current && !extra?.q && (inCanvas ? canvasHandle : doc)) return;
    return inCanvas ? openCanvas(f.key, true, extra) : openFile(f.key, true, extra);
  };
  const main = el('button', {
    class: 'file' + (f.key === current ? ' current' : ''),
    type: 'button',
    title: f.key,
    // A double-click renames. The first click opens the file and redraws the list, so the second click lands on a
    // new button: its click count (detail) says it is the second.
    onclick: (e) => (e.detail >= 2 ? startRename(f) : open()),
    ondblclick: () => startRename(f),
  },
    el('span', { class: 'title' }, shownTitle(f)),
    el('span', { class: 'meta' }, extra?.snippet || metaOf(f)));
  const wrap = el('div', { class: 'row' }, main,
    el('span', { class: 'row-acts' },
      el('button', { class: 'row-act', type: 'button', 'aria-label': tr('renameLabel', f.key), title: tr('renameTitle'), onclick: () => startRename(f) }, tr('rename')),
      el('button', { class: 'row-act', type: 'button', 'aria-label': tr('deleteLabel', f.key), title: tr('deleteTitle'), onclick: () => doDelete(f) }, tr('delete'))));
  return wrap;
}

function drawList() {
  // A redraw (a push from the host, a file opening) must not take the typing cursor out of a name being edited
  const typingIn = listEl.querySelector('input.rename');
  const hadFocus = !!typingIn && document.activeElement === typingIn;
  const caret = hadFocus ? [typingIn.selectionStart, typingIn.selectionEnd] : null;
  listEl.replaceChildren();
  const inCanvas = room === 'canvas';
  const all = inCanvas ? canvases : files;
  if (hits) {
    const shown = hits.filter((h) => (h.kind === 'canvas') === inCanvas);
    if (!shown.length) listEl.append(el('div', { class: 'none', id: 'no-hits' }, tr('noMatches')));
    for (const h of shown) {
      const f = find(keyOf(h), all);
      if (f) listEl.append(row(f, inCanvas, { q: query.trim(), line: h.line, node: h.node, snippet: h.snippet && !h.inTitle ? h.snippet : null }));
    }
  } else {
    for (const f of all.filter((x) => !x.folder)) listEl.append(row(f, inCanvas));
    for (const g of groups) {
      const inGroup = all.filter((x) => x.folder === g);
      if (!inGroup.length) continue;
      listEl.append(el('div', { class: 'group-head', role: 'presentation' }, g));
      for (const f of inGroup) listEl.append(row(f, inCanvas));
    }
  }
  newBtn.disabled = !folder;
  newBtn.textContent = tr(inCanvas ? 'newCanvas' : 'newNote');
  newBtn.title = tr(inCanvas ? 'newCanvasTitle' : 'newNoteTitle');
  for (const [name, b] of Object.entries(roomBtns)) {
    b.setAttribute('aria-selected', String(name === room));
  }
  if (hadFocus) {
    const n = listEl.querySelector('input.rename');
    n?.focus();
    n?.setSelectionRange(caret[0], caret[1]);
  }
}

const emptyNote = () => {
  if (store?.kind === 'folder') return tr('emptyNotesFolder');
  return folder ? tr('emptyNotesDir', space) : tr('noFolderNotes', space);
};

function note(text) {
  docEl.replaceChildren(el('div', { class: 'note' }, text));
}

// Search over the space's notes and canvases (C28): the storage looks at titles and bodies. One question runs at a
// time; while it runs, the newest typed text waits and is asked next, so the list always ends on what is in the box.
function runSearch() {
  query = searchEl.value;
  if (!query.trim()) {
    hits = null;
    searchAsked = '';
    drawList();
    return;
  }
  if (searchBusy) return;
  searchBusy = true;
  (async () => {
    try {
      while (query.trim() && searchAsked !== query.trim()) {
        const q = query.trim();
        let r;
        try {
          r = await call('search', { space, q });
        } catch {
          hits = [];
          drawList();
          return;
        }
        searchAsked = q;
        if (query.trim() === q) {
          hits = r.hits;
          drawList();
        }
      }
    } finally {
      searchBusy = false;
    }
  })();
}
searchEl.addEventListener('input', runSearch);
searchEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  e.stopPropagation();
  if (searchEl.value) {
    e.preventDefault();
    searchEl.value = '';
    runSearch();
  }
});

// Brings the first match of the search to the middle of the pane, drawn with the page's own highlight
function showMatch(q) {
  if (!q) return;
  CSS.highlights?.clear();
  const root = docEl.querySelector('.md, .editor');
  if (!root) return;
  const needle = q.toLowerCase();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const i = n.data.toLowerCase().indexOf(needle);
    if (i < 0) continue;
    const range = new Range();
    range.setStart(n, i);
    range.setEnd(n, i + q.length);
    if (window.Highlight) CSS.highlights.set('board-hit', new Highlight(range));
    const box = range.getBoundingClientRect();
    const pane = docEl.getBoundingClientRect();
    docEl.scrollTop += box.top - pane.top - pane.height / 2 + box.height / 2;
    return;
  }
}

// The document pane: the bar (name, status, Edit/Done, Open in Cursor), a conflict line when one is
// pending, and the rendered text or the editor.
function draw() {
  const d = doc;
  if (!d) return;
  const f = find(d.key);
  const y = docEl.scrollTop;
  destroyEditor(d);
  d.statusEl = el('span', { class: 'status' }, d.status || '');
  const bar = el('div', { class: 'doc-bar' },
    el('span', { class: 'bar-left' }, el('span', {}, `${d.key} · ${when(d.mtime)}`), d.statusEl),
    el('span', { class: 'bar-right' },
      el('button', {
        id: 'mode',
        class: 'quiet',
        type: 'button',
        title: d.mode === 'edit' ? tr('backToReading') : tr('typeInFile'),
        onclick: () => (d.mode === 'edit' ? finishEdit() : startEdit()),
      }, d.mode === 'edit' ? tr('done') : tr('edit')),
      f?.path ? el('a', { href: 'cursor://file' + encodeURI(f.path), title: tr('openCursorTitle') }, tr('openCursor')) : null));
  docEl.replaceChildren(bar);
  if (d.conflict) docEl.append(conflictBar(d));
  if (d.mode === 'edit') {
    d.editorEl = el('div', { class: 'editor' });
    docEl.append(d.editorEl);
    mountEditor(d);
  } else {
    const body = el('div', { class: 'md' });
    body.innerHTML = render(d.text);
    docEl.append(body);
  }
  docEl.scrollTop = y;
}

function setStatus(text) {
  if (!doc) return;
  doc.status = text;
  if (doc.statusEl) doc.statusEl.textContent = text;
}

// ---------------------------------------------------------------- Editor

const THEME = {
  name: 'board',
  colors: Object.fromEntries([
    ...['bgPrimary', 'bgSecondary', 'toolbarBg'].map((k) => [k, 'transparent']),
    ...['text', 'textPrimary', 'h1', 'h2', 'h3', 'strong', 'em', 'link', 'code', 'cursor', 'primary', 'toolbarIcon'].map((k) => [k, 'var(--fg)']),
    ...['textSecondary', 'del', 'blockquote', 'hr', 'syntaxMarker', 'syntax', 'listMarker', 'rawLine', 'placeholder'].map((k) => [k, 'var(--dim)']),
    ...['codeBg', 'hoverBg', 'toolbarHover', 'toolbarActive'].map((k) => [k, 'var(--hover)']),
    ['border', 'var(--line)'],
    ['selection', 'color-mix(in srgb, var(--fg) 16%, transparent)'],
  ]),
  previewColors: { text: 'var(--fg)', h1: 'inherit', h2: 'inherit', h3: 'inherit', strong: 'inherit', em: 'inherit', link: 'var(--fg)', code: 'var(--fg)', codeBg: 'var(--hover)', blockquote: 'var(--dim)', hr: 'var(--dim)', bg: 'transparent' },
};

function mountEditor(d) {
  const [ed] = new OverType(d.editorEl, {
    value: d.text,
    theme: THEME,
    fontSize: '14px',
    lineHeight: 1.65,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    padding: '0px',
    autoResize: true,
    minHeight: '60vh',
    placeholder: tr('typeHere'),
    onChange: (v) => onType(d, v),
  });
  d.editor = ed;
  ed.textarea.setAttribute('aria-label', tr('textOf', d.key));
  ed.textarea.addEventListener('blur', () => save(d));
}

function destroyEditor(d) {
  if (!d.editor) return;
  try {
    d.editor.destroy();
  } catch { /* already gone with its page */ }
  d.editor = null;
  d.editorEl = null;
}

function onType(d, v) {
  if (doc !== d || d.mode !== 'edit' || v === d.text) return;
  d.text = v;
  saveDraft(d);
  if (d.conflict) return; // nothing is written while he has to choose
  clearTimeout(d.timer);
  if (dirty(d)) {
    setStatus(tr('statusUnsaved'));
    d.timer = setTimeout(() => save(d), SAVE_MS);
  } else setStatus('');
}

function startEdit() {
  const d = doc;
  if (!d || d.mode === 'edit') return;
  if (d.eol === null) return setStatus(tr('mixedEol'));
  d.mode = 'edit';
  draw();
  d.editor?.focus();
}

async function finishEdit() {
  const d = doc;
  if (!d || d.mode !== 'edit') return;
  for (let i = 0; i < 3 && doc === d && !d.conflict && dirty(d); i++) await save(d);
  if (doc !== d || d.conflict || dirty(d)) return; // a conflict or a failed save keeps him in the editor
  d.mode = 'read';
  draw();
}

// Writes the editor text to the file if it differs from what the file had. A call while a save is
// running returns that save, so "Done" right after the editor lost focus waits for it.
function save(d) {
  clearTimeout(d.timer);
  if (d.saving) return d.saving;
  if (d.mode !== 'edit' || d.conflict || !dirty(d)) return Promise.resolve();
  d.saving = doSave(d).finally(() => {
    d.saving = null;
  });
  return d.saving;
}

async function doSave(d) {
  if (doc === d) setStatus(tr('statusSaving'));
  const text = d.text;
  try {
    const r = await call('write', { ...ref(d), text: toDisk(d, text), base: d.base });
    d.ioRetries = 0;
    d.base = r.hash;
    d.baseText = text;
    d.disk = { hash: r.hash, text, raw: toDisk(d, text) };
    d.mtime = r.mtime;
    saveDraft(d);
    if (doc === d) {
      setStatus(dirty(d) ? tr('statusUnsaved') : tr('statusSaved'));
      alertBar('');
    }
  } catch (e) {
    if (e.code === 'conflict') {
      d.disk = e.theirs ? diskOf(d, e.theirs.text, e.theirs.hash, e.theirs.mtime) : null;
      // `hash` is what is on disk even when it cannot be shown (too big, not UTF-8): "Keep mine" saves against it
      d.conflict = { reason: e.reason || 'changed', hash: e.hash ?? null };
      d.status = tr('statusUnsaved'); // his text is still only in the page
      if (doc === d) draw();
      return;
    }
    if (e.code === 'io' && (d.ioRetries = (d.ioRetries || 0) + 1) <= 3) {
      if (doc === d) setStatus(tr('statusUnsaved'));
      d.timer = setTimeout(() => save(d), 700); // a writer was busy with the file: once more shortly
      return;
    }
    if (doc === d) {
      setStatus(tr('notSavedWhy', e.code === 'offline' ? tr('hostNotConnected') : e.message));
      if (e.code !== 'offline') alertBar(e.code === 'too-large' ? tr('notSavedTooLarge', Math.round(maxBytes / 1024)) : tr('notSaved', e.message));
    }
    return;
  }
  // More was typed while the write ran
  if (doc === d && d.mode === 'edit' && !d.conflict && dirty(d)) d.timer = setTimeout(() => save(d), SAVE_MS);
}

// ---------------------------------------------------------------- Changed on disk

// i18n-keys: conflictGone conflictTooLarge conflictNotText conflictChanged
const CONFLICT_TEXT = {
  gone: 'conflictGone',
  'too-large': 'conflictTooLarge',
  'not-utf8': 'conflictNotText',
};

function conflictBar(d) {
  const theirs = d.disk;
  const gone = d.conflict.reason === 'gone';
  const bar = el('div', { class: 'conflict', id: 'conflict', role: 'group', 'aria-label': tr('changedOnDisk') });
  bar.append(el('span', {}, tr(CONFLICT_TEXT[d.conflict.reason] || 'conflictChanged')));
  if (theirs) bar.append(el('button', { class: 'quiet', id: 'load-theirs', type: 'button', onclick: () => loadTheirs(d) }, tr('loadTheirs')));
  bar.append(el('button', { class: 'quiet', id: 'keep-mine', type: 'button', onclick: () => keepMine(d) }, tr('keepMine')));
  if (gone) bar.append(el('button', { class: 'quiet', id: 'drop', type: 'button', onclick: () => dropDoc(d) }, tr('dropIt')));
  if (theirs) bar.append(el('details', { class: 'theirs' }, el('summary', {}, tr('seeTheirs')), el('pre', {}, theirs.text)));
  return bar;
}

// Their text replaces mine
function loadTheirs(d) {
  if (!d.disk) return;
  d.eol = eolOf(d.disk.raw);
  d.base = d.disk.hash;
  d.baseText = d.text = d.disk.text;
  d.conflict = null;
  if (d.eol === null) d.mode = 'read'; // their line endings are mixed: shown, not edited here
  saveDraft(d);
  d.status = '';
  draw();
}

// My text stays; the next save replaces theirs on purpose. The base is their hash: the one in their text, or,
// when their file is too big or not text to be shown, the hash the storage sent with the conflict (REVIEW-0.9.0 #9).
function keepMine(d) {
  d.base = d.disk ? d.disk.hash : d.conflict?.hash ?? null;
  d.baseText = d.disk ? d.disk.text : null; // never equal to his text: the save has to happen
  d.conflict = null;
  d.status = tr('statusUnsaved');
  draw();
  save(d);
}

function dropDoc(d) {
  try { drafts.remove(draftKey(d.key)); } catch { /* nothing to remove */ }
  destroyEditor(d);
  doc = null;
  current = '';
  refreshList().then(() => openFirst());
}

// The file on disk is not what this page last knew: adopt it if there is nothing unsaved, else ask
function reconcile(d) {
  if (!d.disk) {
    if (!dirty(d)) {
      destroyEditor(d);
      doc = null;
      note(tr('removedFromFolder', d.key));
      return;
    }
    d.conflict = { reason: 'gone', hash: null };
    return draw();
  }
  if (d.disk.hash === d.base) {
    if (d.conflict) {
      d.conflict = null;
      draw();
    }
    return;
  }
  if (!dirty(d)) {
    // Nothing unsaved: show the new text, keeping scroll and, in the editor, the cursor
    const ta = d.editor?.textarea;
    const sel = ta ? [ta.selectionStart, ta.selectionEnd] : null;
    d.eol = eolOf(d.disk.raw);
    d.base = d.disk.hash;
    d.baseText = d.text = d.disk.text;
    d.conflict = null;
    d.status = '';
    saveDraft(d);
    if (d.eol === null) d.mode = 'read';
    if (d.mode === 'edit' && d.editor) {
      d.editor.setValue(d.text);
      if (sel) ta.setSelectionRange(Math.min(sel[0], d.text.length), Math.min(sel[1], d.text.length));
    } else draw();
    return;
  }
  d.conflict = { reason: 'changed', hash: d.disk.hash }; // unsaved text is kept as it is
  draw();
}

async function readDisk(d) {
  for (let i = 0; ; i++) {
    try {
      const r = await call('read', ref(d));
      return diskOf(d, r.text, r.hash, r.mtime);
    } catch (e) {
      if (e.code === 'offline') throw e;
      // "io": the file was being written (a picked folder reports that as an error); look again before calling it gone
      if (e.code === 'io' && i < 3) {
        await new Promise((r) => setTimeout(r, 120));
        continue;
      }
      if (e.code === 'io') throw e;
      return null; // gone, or no longer readable here
    }
  }
}

async function onChanged(msg) {
  folder = !msg.error;
  setFiles(msg.error ? {} : msg);
  drawList();
  if (query.trim()) {
    searchAsked = '';
    runSearch(); // the hits follow the files
  }
  return afterList();
}

// The list is fresh: look at the open file (or canvas) again
async function afterList() {
  if (room === 'canvas') return canvasChanged();
  const d = doc;
  if (!d) {
    if (files.length && !current) openFirst();
    else if (!files.length) note(emptyNote());
    return;
  }
  if (renaming === d.key) return; // his own rename is in progress; it moves the open file itself
  if (d.reading) {
    d.again = true; // a change arrived while reading: look once more when done
    return;
  }
  d.reading = true;
  try {
    do {
      d.again = false;
      const f = find(d.key);
      if (f && d.disk && f.hash === d.disk.hash) continue; // no change in this file (his own save comes back this way)
      if ((f?.unreadable === 'too-large' || f?.unreadable === 'not-utf8') && dirty(d) && !d.conflict) {
        // On disk now but too big or not text: a save finds out why, and says so with the hash "Keep mine" needs
        await save(d);
        continue;
      }
      if (f?.unreadable === 'io') continue; // a glitch while a writer was busy: the next look says
      const disk = f && !f.unreadable ? await readDisk(d) : null;
      if (doc !== d) return;
      if (disk && disk.hash === d.disk?.hash) continue;
      d.disk = disk;
      if (disk) d.mtime = disk.mtime;
      reconcile(d);
    } while (d.again && doc === d);
  } finally {
    d.reading = false;
  }
}

// ---------------------------------------------------------------- Opening files

// What was open last in this space comes back next time (C34)
const lastKey = `boardLast:${space}`;
function rememberOpen(key) {
  try {
    chrome.storage.local.set({ [lastKey]: key });
  } catch { /* storage unavailable: the address still names it */ }
}

async function openFile(key, remember, opts = {}) {
  const f = find(key);
  if (!f) return;
  if (doc) {
    clearTimeout(doc.timer);
    await save(doc).catch(() => {}); // an unsaved draft is also kept in this tab's storage
  }
  current = key;
  doc = null;
  if (remember) {
    history.replaceState(null, '', '#' + encodeURIComponent(key));
    rememberOpen(key);
  }
  drawList();
  if (f.unreadable) {
    docEl.replaceChildren(el('div', { class: 'doc-bar' }, el('span', {}, f.key), f.path ? el('a', { href: 'cursor://file' + encodeURI(f.path), title: tr('openCursorTitle') }, tr('openCursor')) : null),
      el('div', { class: 'note' }, tr(f.path ? 'cannotOpenNoteCursor' : 'cannotOpenNote', f.unreadable)));
    return;
  }
  let r;
  try {
    r = await call('read', ref(f));
  } catch (e) {
    if (current === key) note(e.code === 'offline' ? tr('waitingStorage') : tr('couldNotRead', key, e.message));
    return;
  }
  if (current !== key) return; // another file was picked meanwhile
  const eol = eolOf(r.text);
  const text = toEditor({ eol }, r.text);
  const d = { key, file: f.file, folder: f.folder, eol, base: r.hash, baseText: text, text, disk: { hash: r.hash, text, raw: r.text }, mtime: r.mtime, mode: 'read', conflict: null, status: '' };
  doc = d;
  // A draft left by a reload of this page comes back as unsaved text in the editor
  const dr = await loadDraft(key);
  if (current !== key || doc !== d) return; // another file was picked while the draft was fetched
  if (dr && dr.text === d.text) saveDraft(d); // already on disk: the draft is stale, drop it
  if (dr && typeof dr.text === 'string' && dr.text !== d.text && dr.eol !== null) {
    d.eol = dr.eol;
    d.text = dr.text;
    d.base = dr.base;
    d.baseText = dr.baseText;
    d.mode = 'edit';
    d.status = tr('statusUnsaved');
    reconcile(d);
    if (!d.conflict) {
      draw();
      d.timer = setTimeout(() => save(d), SAVE_MS);
    }
    return;
  }
  draw();
  docEl.scrollTop = 0;
  if (opts.q) showMatch(opts.q);
}

function openFirst() {
  if (!files.length) return;
  const want = decodeURIComponent(location.hash.slice(1));
  openFile(find(want) ? want : files[0].key, false);
}

async function refreshList() {
  try {
    const r = await call('list', { space });
    folder = true;
    setFiles(r);
  } catch (e) {
    if (e.code === 'offline') throw e;
    folder = false;
    setFiles({});
  }
  drawList();
}

// ---------------------------------------------------------------- New note

newBtn.addEventListener('click', () => {
  if (document.getElementById('new-name')) return;
  const inCanvas = room === 'canvas';
  const label = tr(inCanvas ? 'canvasName' : 'noteName');
  const input = el('input', { id: 'new-name', class: 'inline', placeholder: label, 'aria-label': label, maxlength: '120' });
  const msg = el('div', { class: 'error', id: 'new-msg' });
  const wrap = el('div', { class: 'new-wrap' }, input, msg);
  listEl.before(wrap);
  input.focus();
  const close = () => wrap.remove();
  input.addEventListener('keydown', async (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      return close();
    }
    if (e.key !== 'Enter' || e.isComposing) return;
    const name = input.value.trim().replace(inCanvas ? /\.canvas$/i : /\.md$/i, '').trim();
    if (!name) return close();
    const file = name + (inCanvas ? '.canvas' : '.md');
    try {
      await call('create', { space, file, text: inCanvas ? '{\n\t"nodes": [],\n\t"edges": []\n}' : `# ${name}\n\n` });
    } catch (err) {
      msg.textContent = err.code === 'conflict' ? tr('nameTaken') : err.code === 'bad-name' ? tr('nameBad') : tr('notCreated', err.message);
      return;
    }
    close();
    await refreshList();
    if (inCanvas) return openCanvas(file, true);
    await openFile(file, true);
    startEdit();
    const ta = doc?.editor?.textarea;
    if (ta) ta.setSelectionRange(ta.value.length, ta.value.length);
  });
});

// ---------------------------------------------------------------- Rename (C29)

// Double-click a name, or its Rename button: the name becomes a field. An existing name is refused and nothing moves.
// The field lives in `renameFor`, not in the row, so a redraw of the list (a file opening, a push from the host)
// does not take it away.
function startRename(f) {
  if (renameFor?.key === f.key) return;
  renameFor = { key: f.key, text: plainName(f.file), msg: '' };
  drawList();
  focusRename(true);
}

function focusRename(select) {
  const i = listEl.querySelector('input.rename');
  if (!i) return;
  i.focus();
  if (select) i.select();
}

function renameRow(f) {
  const input = el('input', { class: 'inline rename', 'aria-label': tr('renameNewName', f.key), maxlength: '120', value: renameFor.text });
  const msg = el('div', { class: 'error', role: 'status' }, renameFor.msg);
  const close = () => {
    renameFor = null;
    drawList();
  };
  input.addEventListener('input', () => {
    if (renameFor) renameFor.text = input.value;
  });
  input.addEventListener('blur', () => setTimeout(() => {
    if (input.isConnected && renameFor && document.activeElement !== input) close(); // clicked elsewhere
  }, 150));
  input.addEventListener('keydown', async (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      return close();
    }
    if (e.key !== 'Enter' || e.isComposing) return;
    const base = input.value.trim().replace(/\.(md|canvas)$/i, '').trim();
    if (!base) return close();
    const to = base + extOf(f.file);
    if (to === f.file) return close();
    const err = await doRename(f, to);
    if (renameFor) {
      if (err) {
        renameFor.msg = err;
        drawList();
        focusRename(false);
      } else close();
    }
  });
  return el('div', { class: 'row' }, el('div', { class: 'new-wrap' }, input, msg));
}

// Returns a message when it did not happen. The open file and its draft follow the rename.
async function doRename(f, to) {
  const isOpenNote = doc && doc.key === f.key;
  const isOpenCanvas = room === 'canvas' && canvasFile === f.key;
  if (isOpenNote && doc.conflict) return tr('resolveFirst');
  if (isOpenNote) {
    clearTimeout(doc.timer);
    await save(doc).catch(() => {});
    if (doc.conflict || dirty(doc)) return tr('notSavedYetRename');
  }
  if (isOpenCanvas) await canvasHandle?.flush().catch(() => {});
  renaming = f.key;
  try {
    await call('rename', { ...ref(f), to });
  } catch (e) {
    renaming = '';
    if (e.code === 'exists') return tr('nameTaken');
    if (e.code === 'bad-name') return tr('nameBad');
    if (e.code === 'gone') return tr('fileGone');
    return tr('notRenamed', e.message);
  }
  const newKey = (f.folder ? f.folder + '/' : '') + to;
  moveDraft(f.key, newKey);
  try {
    await refreshList();
    if (isOpenNote) {
      doc.key = newKey;
      doc.file = to;
      current = newKey;
      history.replaceState(null, '', '#' + encodeURIComponent(newKey));
      rememberOpen(newKey);
      drawList();
      draw();
    } else if (isOpenCanvas) {
      await leaveCanvas();
      renaming = '';
      await openCanvas(newKey, true);
    } else if (current === f.key) current = newKey;
    if (!isOpenNote && !isOpenCanvas) drawList();
  } finally {
    renaming = '';
  }
  return '';
}

// ---------------------------------------------------------------- Delete and Undo (C27)

function toast(text, undo) {
  const item = el('div', { class: 'toast-item' }, el('span', {}, text));
  let timer;
  const gone = () => {
    clearTimeout(timer);
    item.remove();
    toastEl.hidden = !toastEl.children.length;
  };
  if (undo) {
    item.append(el('button', { class: 'quiet', type: 'button', onclick: async () => {
      gone();
      await undo();
    } }, tr('undo')));
  }
  toastEl.append(item);
  toastEl.hidden = false;
  timer = setTimeout(gone, UNDO_MS);
}

// Moves the file to ~/Spaces/.trash/<space>/[<folder>/]<name> <timestamp> (never deletes it); "Undo" brings it back
async function doDelete(f) {
  const isOpenNote = doc && doc.key === f.key;
  const isOpenCanvas = room === 'canvas' && canvasFile === f.key;
  if (isOpenNote && doc.conflict) return alertBar(tr('resolveFirstDelete'));
  if (isOpenNote) {
    clearTimeout(doc.timer);
    await save(doc).catch(() => {});
    if (doc.conflict || dirty(doc)) return alertBar(tr('notSavedYetDelete'));
  }
  if (isOpenCanvas) await canvasHandle?.flush().catch(() => {});
  let r;
  try {
    r = await call('trash', ref(f));
  } catch (e) {
    return alertBar(tr('notDeleted', e.message));
  }
  const title = shownTitle(f);
  if (isOpenNote) {
    destroyEditor(doc);
    try { drafts.remove(draftKey(f.key)); } catch { /* nothing to remove */ }
    doc = null;
    current = '';
  }
  if (isOpenCanvas) {
    await leaveCanvas();
    current = '';
  }
  await refreshList();
  if (room === 'canvas') {
    if (isOpenCanvas) canvases.length ? openCanvas(canvases[0].key, true) : canvasNote(emptyCanvasNote());
  } else if (isOpenNote) {
    files.length ? openFile(files[0].key, true) : note(emptyNote());
  }
  toast(tr('deletedToast', title), async () => {
    let back;
    try {
      back = await call('untrash', { space, trashId: r.trashId });
    } catch (e) {
      if (e.code !== 'exists') return alertBar(tr('notRestored', e.message));
      // The name was taken meanwhile: it comes back under another name, never over the new file
      try {
        back = await call('untrash', { space, trashId: r.trashId, to: `${plainName(f.file)} (restored)${extOf(f.file)}` });
      } catch (e2) {
        return alertBar(tr('notRestored', e2.message));
      }
    }
    await refreshList();
    const k = (back.folder ? back.folder + '/' : '') + back.file;
    if (extOf(back.file) === '.canvas') {
      if (room === 'canvas') openCanvas(k, true);
    } else if (room === 'notes') openFile(k, true);
  });
}

// ---------------------------------------------------------------- Rooms

// Leaves the open room (what is unsaved is written first) and shows the other one. For Notes, `file`
// is the note to open; for Canvas, the canvas.
async function switchRoom(to, file) {
  if (to !== room) {
    if (room === 'notes') {
      if (doc) {
        clearTimeout(doc.timer);
        await save(doc).catch(() => {}); // an unsaved draft is also kept in this tab's storage
        destroyEditor(doc);
        doc = null;
      }
      docEl.hidden = true;
    } else {
      await leaveCanvas();
      canvasEl.hidden = true;
    }
    room = to;
    current = '';
    history.replaceState(null, '', to === 'canvas' ? '#:canvas' : '#');
    if (query.trim()) {
      searchAsked = '';
      runSearch();
    }
    drawList();
  }
  if (to === 'canvas') return showCanvasRoom(file);
  docEl.hidden = false;
  canvasEl.hidden = true;
  if (file) return openFile(file, true);
  if (!files.length) return note(emptyNote());
  openFirst();
}

roomBtns.notes.addEventListener('click', () => switchRoom('notes'));
roomBtns.canvas.addEventListener('click', () => switchRoom('canvas'));

// A file card on a canvas that points at a note of this space opens it in Notes
function showNote(file) {
  if (find(file)) switchRoom('notes', file);
}

// ---------------------------------------------------------------- Keys, links, lifecycle

const typing = (t) => t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 's' && doc?.mode === 'edit') {
      e.preventDefault();
      save(doc);
    }
    return;
  }
  if (e.key === 'Escape' && doc?.mode === 'edit') {
    e.preventDefault();
    finishEdit();
  } else if ((e.key === 'e' || e.key === 'E') && doc?.mode === 'read' && !typing(e.target) && !e.isComposing) {
    e.preventDefault();
    startEdit();
  }
});

docEl.addEventListener('click', (e) => {
  const a = e.target.closest?.('a[data-md]');
  if (!a) return;
  e.preventDefault();
  const name = a.getAttribute('data-md');
  // A link inside a mega tab folder's note is relative to that folder; one at the top is relative to the space
  const key = doc?.folder && find(`${doc.folder}/${name}`) ? `${doc.folder}/${name}` : name;
  openFile(key, true);
});

// Leaving the tab saves what is typed
document.addEventListener('visibilitychange', () => {
  if (document.hidden && doc) save(doc);
  if (document.hidden) flushCanvas();
});

// After a (code) reload of the extension this page's connection is gone: reload it. An unsaved draft
// is kept in this tab's storage and comes back in the editor.
setInterval(() => {
  if (!chrome.runtime?.id) {
    location.reload();
  }
}, 1000);

// The file last open in this space comes back when the address names none (C34)
async function boot() {
  if (!location.hash.slice(1)) {
    try {
      const got = (await chrome.storage.local.get(lastKey))[lastKey];
      if (typeof got === 'string' && got) {
        history.replaceState(null, '', '#' + encodeURIComponent(got));
        room = roomOf(got);
        fromLast = true;
      }
    } catch { /* no storage: the first note opens */ }
  }
  connect();
}

boot();
