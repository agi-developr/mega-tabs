// Spaces home: one tile per space (workspace name prefixes plus folders under ~/Spaces), with a cover
// image or a letter. A click switches to that space and closes this tab; the last tile makes a new space
// from a typed name; a double click renames; an image dropped on a tile becomes its cover. Everything
// goes through the `mega` port (megatabs.js). No request leaves the extension: covers arrive from the
// host as data: URLs.

const COVER_MAX = 700 * 1024;
const tilesEl = document.getElementById('tiles');
const noteEl = document.getElementById('note');
const offEl = document.getElementById('files-off');
const setupEl = document.getElementById('setup');
let windowId = null;
let tabId = null;
let spaces = [];       // [{ name, megas, folder }]
let current = null;    // the space this window shows
let files = null;      // null until the host has been asked
const covers = new Map(); // space -> data: URL, or null
let renaming = null;
let adding = false;
let busy = false;

const mega = (type, args = {}) =>
  new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: 'mega' });
    let done = false;
    port.onMessage.addListener((m) => {
      done = true;
      port.disconnect();
      if (m?.ok) resolve(m.result);
      else reject(Object.assign(new Error(m?.error || tr('noAnswer')), { code: m?.code }));
    });
    port.onDisconnect.addListener(() => { if (!done) reject(new Error(tr('noAnswer'))); });
    port.postMessage({ id: 1, type, ...args });
  });

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'class') n.className = v;
    else n.setAttribute(k, v);
  }
  for (const k of kids) if (k != null) n.append(k);
  return n;
}

function say(text) {
  noteEl.hidden = !text;
  noteEl.textContent = text || '';
}

function showFiles() {
  offEl.hidden = files !== false;
  setupEl.hidden = !(files === false && location.hash === '#setup');
}

async function load() {
  const r = await mega('spaces', { windowId }).catch(() => null);
  if (!r) return;
  spaces = r.spaces;
  current = r.current;
  files = r.files;
  showFiles();
  render();
  // Covers come one by one, after the tiles are on screen
  for (const s of spaces) {
    if (covers.has(s.name)) continue;
    mega('cover', { space: s.name }).then((c) => {
      covers.set(s.name, c.cover || null);
      if (c.files === false) { files = false; showFiles(); }
      render();
    }).catch(() => covers.set(s.name, null));
  }
}

const letterOf = (name) => [...name.trim()][0]?.toUpperCase() || '?';

async function open(space) {
  if (busy) return;
  busy = true;
  say('');
  try {
    await mega('switchSpace', { windowId, space, closeTab: tabId });   // closes this tab when it is done
  } catch (e) {
    say(e.message);
  }
  busy = false;
}

async function create(name) {
  adding = false;
  if (busy) return;
  busy = true;
  say('');
  try {
    const r = await mega('newSpace', { windowId, name, closeTab: tabId });
    if (r?.files === false) { files = false; showFiles(); }
  } catch (e) {
    say(e.message);
    render();
  }
  busy = false;
}

async function rename(from, to) {
  renaming = null;
  say('');
  try {
    const r = await mega('renameSpace', { space: from, to });
    if (covers.has(from)) { covers.set(r.space, covers.get(from)); covers.delete(from); }
    if (r?.files === false) { files = false; showFiles(); }
  } catch (e) {
    say(e.message);
  }
  await load();
}

// An image dropped on a tile: saved as the space's cover through the host (at most 700 KB)
async function dropCover(space, file) {
  const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[file?.type];
  if (!ext) return say(tr('coverType'));
  if (file.size > COVER_MAX) return say(tr('coverBig'));
  // base64 of the file's bytes, in chunks the string functions can take
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const data = btoa(bin);
  say('');
  try {
    const r = await mega('putCover', { space, data: `data:${file.type};base64,${data}` });
    if (r.files === false) { files = false; showFiles(); return say(tr('coverNotSaved')); }
    covers.set(space, r.cover || null);
  } catch (e) {
    say(e.message);
  }
  render();
}

function nameInput(placeholder, initial, onDone, onCancel) {
  const input = el('input', { class: 'inline', placeholder, 'aria-label': placeholder });
  input.value = initial || '';
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (save && v) onDone(v);
    else { onCancel(); render(); }
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  Promise.resolve().then(() => { input.focus(); input.select(); });
  return input;
}

function tile(s) {
  if (renaming === s.name) {
    return el('div', { class: 'tile' },
      el('span', { class: 'cover' }, el('span', { class: 'letter', 'aria-hidden': 'true' }, letterOf(s.name))),
      el('span', { class: 'label' }, nameInput(tr('spaceName'), s.name, (v) => rename(s.name, v), () => { renaming = null; })));
  }
  const cover = covers.get(s.name);
  const t = el('button', {
    class: 'tile' + (s.name === current ? ' current' : ''), type: 'button', 'data-space': s.name,
    'aria-current': s.name === current ? 'true' : null,
    // the name comes from the visible text (name and count); the count in words is the description
    'aria-description': s.megas ? plural(s.megas, 'megaTabs') : null,
    title: tr('tileOpen', s.name),
    onclick: () => open(s.name),
    ondblclick: () => { renaming = s.name; render(); },
    onkeydown: (e) => { if (e.key === 'F2') { e.preventDefault(); renaming = s.name; render(); } },
    ondragover: (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); t.classList.add('drop'); } },
    ondragleave: () => t.classList.remove('drop'),
    ondrop: (e) => { e.preventDefault(); t.classList.remove('drop'); dropCover(s.name, e.dataTransfer?.files?.[0]); },
  },
    el('span', { class: 'cover' }, cover ? el('img', { src: cover, alt: '' }) : el('span', { class: 'letter', 'aria-hidden': 'true' }, letterOf(s.name))),
    el('span', { class: 'label' },
      el('span', { class: 'name' }, s.name), ' ',
      s.megas ? el('span', { class: 'count' }, String(s.megas)) : null));
  return t;
}

function render() {
  const key = document.activeElement?.dataset?.space;
  tilesEl.replaceChildren(...spaces.map(tile));
  if (adding) {
    tilesEl.append(el('div', { class: 'tile new' },
      el('span', { class: 'cover' }, nameInput(tr('newSpaceName'), '', create, () => { adding = false; })),
      el('span', { class: 'label' }, tr('tileTypeName'))));
  } else {
    tilesEl.append(el('button', {
      class: 'tile new', type: 'button', 'aria-label': tr('tileLabel', tr('newSpaceAria'), tr('tileNewHint')), title: tr('tileNewTitle'),
      onclick: () => { adding = true; render(); },
    },
      el('span', { class: 'cover' }, el('span', { class: 'letter', 'aria-hidden': 'true' }, '+')),
      el('span', { class: 'label' }, tr('tileNewHint'))));
  }
  if (key) tilesEl.querySelector(`[data-space="${CSS.escape(key)}"]`)?.focus();
}

document.getElementById('open-setup').addEventListener('click', () => {
  location.hash = '#setup';
  showFiles();
});
document.getElementById('retry').addEventListener('click', async () => {
  const note = document.getElementById('retry-note');
  note.textContent = tr('retryChecking');
  await load();
  note.textContent = files ? tr('retryOn') : tr('retryOff');
  if (files) setupEl.hidden = true;
});
window.addEventListener('hashchange', showFiles);

(async () => {
  localize();
  document.getElementById('setup-text').replaceChildren(...trNodes('homeSetupText', el('code', {}, '~/Spaces'), el('code', {}, installCommand())));
  windowId = Number(new URLSearchParams(location.search).get('window')) || (await chrome.windows.getCurrent()).id;
  tabId = (await chrome.tabs.getCurrent())?.id ?? null;
  render();
  await load();
  // New or renamed mega tabs change the tiles
  let timer;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.workspaces) return;
    clearTimeout(timer);
    timer = setTimeout(() => { if (!renaming && !adding) load(); }, 300);
  });
  setInterval(() => { if (!chrome.runtime?.id) location.reload(); }, 1000);
})();
