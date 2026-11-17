// Mega tabs side panel: our own calm UI on top of the upstream workspace engine.
// A workspace named "Me · Reading" is mega tab "Reading" in space "Me".
// One space is shown at a time; a switcher at the top changes it. Spaces, covers and renaming go
// through the `mega` port (megatabs.js); everything else uses background.js's existing messages
// (state/create/update/show/delete/reorder).

const SEP = ' · ';
const GENERAL = 'General';   // the key of the group for mega tabs named without a space; shown through tr('generalSpace')
const spaceLabel = (name) => (name === GENERAL ? tr('generalSpace') : name);
const root = document.getElementById('spaces');
let windowId = null;
let state = null;
let busy = false;
let editing = null;   // { space, wsId|null } while a name input is open
let confirmClose = null;
let error = '';
let menu = null;      // the space switcher while it is open: { renaming: space|null, adding: boolean }
let viewPick = null;  // a space chosen from the switcher that has no mega tab yet (it is shown empty)
let lastCurrent;      // the mega tab that was shown at the last refresh
let info = null;      // what the host knows: { spaces: [{ name, megas, folder }], files: boolean }
let introSeen = true; // the first-run hint is gone after the first switch
let drag = null;      // a mega tab row being dragged
let justDragged = false;

// background.js answers { ok, result } or { ok: false, error }
const send = (msg) =>
  chrome.runtime.sendMessage(msg).then((r) => {
    if (!r?.ok) throw new Error(r?.error || tr('noAnswer'));
    return r.result;
  });

// megatabs.js answers one request on a port named "mega"
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

// Names the upstream engine gives on its own ("Workspace 1", "Default", "Recovered") are not
// shown as names: such a workspace is listed under "Open windows" by its active tab's title.
const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// The engine writes these names in the language it ran in; the English forms are matched too, so a browser whose
// language changed later still lists such a workspace under "Open windows".
const DEFAULT_NAME = new RegExp('^(' + [
  esc(chrome.i18n.getMessage('workspaceN', ['@@N@@'])).replace('@@N@@', '\\d+'),
  esc(chrome.i18n.getMessage('workspaceName')),
  esc(chrome.i18n.getMessage('defaultWorkspace')),
  esc(chrome.i18n.getMessage('recoveredWorkspace')),
  'Workspace \\d+', 'Workspace', 'Default', 'Recovered', // i18n-ok: engine-made names, matched as data
].join('|') + ')$');
const isDefaultName = (name) => DEFAULT_NAME.test(name.trim());
let titles = {};   // wsId -> title of that workspace's active tab

// "How this works" text per mega tab, from ~/Spaces/<space>/<mega tab>/MEGATAB.md (board-sync.js
// copies it into board-data/megatabs.json). Shown as plain, short text: markdown marks and headings removed.
let how = new Map();   // "Space · Mega tab" -> text
const plainText = (md) => String(md || '')
  .replace(/^[ \t]*#{1,6}[ \t].*$/gm, '')   // heading lines: the text under them is the point
  .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
  .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/^[ \t]*[#>\-*+]+[ \t]*/gm, '')
  .replace(/[*`]/g, '')
  .replace(/\s*\n\s*/g, ' ')
  .trim();
async function loadHow() {
  try {
    const r = await fetch(chrome.runtime.getURL('board-data/megatabs.json'), { cache: 'no-store' });
    const list = r.ok ? (await r.json()).megatabs : [];
    how = new Map((Array.isArray(list) ? list : []).map((m) => [`${m.space}${SEP}${m.mega}`, plainText(m.body)]).filter(([, t]) => t));
  } catch {
    how = new Map();
  }
}

function split(name) {
  const i = name.indexOf(SEP);
  return i < 0 ? { space: GENERAL, mega: name } : { space: name.slice(0, i).trim(), mega: name.slice(i + SEP.length).trim() };
}

// wsId -> title of the active tab: in the window showing the workspace, or, for a workspace
// parked in a stash window, its first real tab.
async function loadTitles() {
  const stashUrl = chrome.runtime.getURL('stash.html');
  const { windowWs = {} } = await chrome.storage.session.get('windowWs');
  const byWindow = new Map();
  for (const t of await chrome.tabs.query({})) {
    if (!byWindow.has(t.windowId)) byWindow.set(t.windowId, []);
    byWindow.get(t.windowId).push(t);
  }
  const out = {};
  for (const [winId, tabs] of byWindow) {
    const marker = tabs.find((t) => (t.url || t.pendingUrl || '').startsWith(stashUrl));
    const real = tabs.filter((t) => t !== marker && !t.pinned);
    // A real page beats an empty new-tab page; in the shown window the active tab wins.
    const page = (t) => !/^chrome:\/\/(newtab|new-tab-page)\//.test(t.url || t.pendingUrl || '');
    const pick = (!marker && real.find((t) => t.active && page(t))) || real.find(page) || real[0];
    const wsId = marker ? (marker.url || marker.pendingUrl).split('#')[1] : windowWs[winId];
    if (wsId && !(wsId in out)) out[wsId] = pick ? pick.title || pick.url || '' : '';
  }
  return out;
}

// What the host knows (folders under ~/Spaces); without it the panel still works from workspace names
async function loadInfo() {
  try {
    info = await mega('spaces');
  } catch {
    info = { spaces: [], files: false };
  }
}

async function refresh() {
  if (busy || drag?.on) return;
  try {
    state = await send({ type: 'state', windowId });
    titles = await loadTitles();
    await loadHow();
    introSeen = !!(await chrome.storage.local.get('megaIntroSeen')).megaIntroSeen;
    // A switch (from here, a key or the menu) ends a space picked in the switcher: the panel follows the window
    if (lastCurrent !== undefined && state.current !== lastCurrent) viewPick = null;
    lastCurrent = state.current;
  } catch (e) {
    error = String(e?.message || e);
  }
  render();
}

async function act(fn) {
  if (busy) return;
  busy = true;
  document.body.classList.add('busy');
  let failed = '';
  error = '';
  try { await fn(); } catch (e) { failed = String(e?.message || e); }
  busy = false;
  document.body.classList.remove('busy');
  await refresh();
  // refresh clears the line; a failure of this action stays on screen
  if (failed) { error = failed; render(); }
}

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

// onCancel: what to do when the input is left empty or with Esc (default: draw again)
function nameInput(placeholder, initial, onDone, onCancel) {
  const input = el('input', { class: 'inline', placeholder, 'aria-label': placeholder });
  input.value = initial || '';
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    editing = null;
    const v = input.value.trim();
    if (save && v) onDone(v);
    else if (onCancel) onCancel();
    else render();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  Promise.resolve().then(() => { input.focus(); input.select(); });
  return input;
}

async function createMega(space, mega) {
  const full = space === GENERAL ? mega : `${space}${SEP}${mega}`;
  await act(() => send({ type: 'create', name: full }));
}

// The full order of workspaces with this space's mega tabs in a new order: they keep the places they had
function orderWith(spaceIds, ids) {
  const mine = new Set(spaceIds);
  let i = 0;
  return state.workspaces.map((w) => (mine.has(w.id) ? ids[i++] : w.id));
}

function moveMega(spaceIds, id, to) {
  const rest = spaceIds.filter((x) => x !== id);
  rest.splice(Math.max(0, Math.min(to, rest.length)), 0, id);
  if (rest.every((x, i) => x === spaceIds[i])) return Promise.resolve();
  return act(() => send({ type: 'reorder', ids: orderWith(spaceIds, rest) }));
}

// One row: a div holding the name button (switches, F2 renames, Alt+Up/Down moves) and a close button.
// The row itself takes the mouse: click switches, double click renames, a drag moves it.
function megaRow(ws, space, mega, label, spaceIds) {
  if (editing?.wsId === ws.id) {
    return nameInput(tr('name'), mega, (v) => act(() => send({
      type: 'update', wsId: ws.id, patch: { name: space === GENERAL ? v : `${space}${SEP}${v}` },
    })));
  }
  const isCurrent = ws.id === state.current;
  const closing = confirmClose === ws.id;
  const switchHere = () => { if (!isCurrent && !justDragged) act(() => send({ type: 'show', windowId, wsId: ws.id })); };
  const rename = () => { editing = { space, wsId: ws.id }; render(); };
  const index = spaceIds ? spaceIds.indexOf(ws.id) : -1;
  return el('div', {
    class: 'mega' + (isCurrent ? ' current' : ''),
    'data-id': spaceIds ? ws.id : null,
    title: tr('switchToMega', label),
    onclick: switchHere,
    ondblclick: rename,
  },
    el('button', {
      class: 'name', type: 'button', 'aria-current': isCurrent ? 'true' : null,
      onkeydown: (e) => {
        if (e.key === 'F2') { e.preventDefault(); rename(); }
        if (index >= 0 && e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
          e.preventDefault();
          moveMega(spaceIds, ws.id, index + (e.key === 'ArrowUp' ? -1 : 1)).then(() => root.querySelector(`.mega[data-id="${ws.id}"] .name`)?.focus());
        }
      },
    }, label),
    el('span', { class: 'count' }, ws.count ? String(ws.count) : ''),
    state.workspaces.length > 1 ? el('button', {
      class: 'icon close', type: 'button',
      title: closing ? tr('closeMegaAsk') : tr('closeMega'),
      'aria-label': closing ? tr('closeMegaAskLabel', label) : tr('closeMegaLabel', label),
      onclick: (e) => {
        e.stopPropagation();
        if (!closing) { confirmClose = ws.id; render(); setTimeout(() => { if (confirmClose === ws.id) { confirmClose = null; render(); } }, 3000); return; }
        confirmClose = null;
        act(() => send({ type: 'delete', wsId: ws.id }));
      },
    }, closing ? tr('closeQuestion') : '×') : null,
  );
}

// ---------------------------------------------------------------- Dragging a row (pointer events: no HTML5 drag)

document.addEventListener('pointermove', (e) => {
  if (!drag) return;
  if (!drag.on) {
    if (Math.abs(e.clientY - drag.y) < 6) return;
    drag.on = true;
    drag.row.classList.add('dragging');
    document.body.classList.add('sorting');
  }
  const rows = [...drag.box.querySelectorAll('.mega[data-id]')];
  let to = rows.length;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i].getBoundingClientRect();
    if (e.clientY < r.top + r.height / 2) { to = i; break; }
  }
  drag.to = to;
  rows.forEach((r, i) => {
    r.classList.toggle('drop-before', i === to && r !== drag.row);
    r.classList.toggle('drop-after', to === rows.length && i === rows.length - 1 && r !== drag.row);
  });
});
document.addEventListener('pointerup', () => {
  const d = drag;
  drag = null;
  document.body.classList.remove('sorting');
  if (!d) return;
  d.row.classList.remove('dragging');
  d.box.querySelectorAll('.drop-before, .drop-after').forEach((r) => r.classList.remove('drop-before', 'drop-after'));
  if (!d.on) return;
  justDragged = true;
  setTimeout(() => { justDragged = false; }, 0);
  const rows = [...d.box.querySelectorAll('.mega[data-id]')].map((r) => r.dataset.id);
  const from = rows.indexOf(d.id);
  moveMega(rows, d.id, d.to > from ? d.to - 1 : d.to).finally(() => refresh());
});
document.addEventListener('pointercancel', () => {
  if (drag?.on) refresh();
  drag = null;
  document.body.classList.remove('sorting');
});

function sortable(box) {
  box.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('.close, input')) return;
    const row = e.target.closest('.mega[data-id]');
    if (row) drag = { row, box, id: row.dataset.id, y: e.clientY, on: false, to: 0 };
  });
}

// ---------------------------------------------------------------- Pages of the extension

// An extension page (the Board of a space, the Spaces home) is a tab in this window; an open one is brought forward.
async function openPage(file, query = '', hash = '') {
  const url = chrome.runtime.getURL(file + query);
  const tabs = await chrome.tabs.query({ windowId });
  const open = tabs.find((t) => (t.url || t.pendingUrl || '').split('#')[0] === url);
  if (open) {
    await chrome.tabs.update(open.id, { active: true, ...(hash ? { url: url + hash } : {}) });
  } else {
    await chrome.tabs.create({ windowId, url: url + hash, active: true });
  }
}
const openBoard = (space) => openPage('board.html', '?space=' + encodeURIComponent(space));
const openHome = (hash) => openPage('home.html', '', hash);

// ---------------------------------------------------------------- Spaces

function groups() {
  const spaces = new Map();
  const open = [];   // default-named workspaces, shown by their window's tab title
  for (const ws of state.workspaces) {
    if (isDefaultName(ws.name)) { open.push(ws); continue; }
    const { space, mega } = split(ws.name);
    if (!spaces.has(space)) spaces.set(space, []);
    spaces.get(space).push({ ws, mega });
  }
  return { spaces, open };
}

// Every space the panel can name: those with mega tabs, then folders with none, then a picked empty one
function spaceNames(spaces) {
  const names = [...spaces.keys()];
  for (const s of info?.spaces || []) if (!names.includes(s.name)) names.push(s.name);
  if (viewPick && !names.includes(viewPick)) names.push(viewPick);
  return names;
}

// The space shown: one picked that is still empty, else the window's, else the first
function viewedSpace(spaces, names) {
  if (viewPick && names.includes(viewPick)) return viewPick;
  const cur = state.workspaces.find((w) => w.id === state.current);
  if (cur && !isDefaultName(cur.name)) return split(cur.name).space;
  return names[0] || null;
}

async function pickSpace(name, view, spaces) {
  menu = null;
  if (name === view) return render();
  if (!spaces.get(name)?.length) { viewPick = name; return render(); }
  viewPick = null;
  await act(() => mega('switchSpace', { windowId, space: name }));
}

async function newSpace(name) {
  menu = null;
  viewPick = null;
  await act(async () => {
    const r = await mega('newSpace', { windowId, name });
    if (r?.files === false && info) info.files = false;
  });
}

async function renameSpace(from, to) {
  menu = { renaming: null, adding: false };
  await act(async () => {
    const r = await mega('renameSpace', { space: from, to });
    if (viewPick === from) viewPick = r.space;
    if (r?.files === false && info) info.files = false;
    await loadInfo();
  });
}

function menuEl(names, view, spaces) {
  const m = el('div', { class: 'menu', 'aria-label': tr('spaces') });
  for (const name of names) {
    if (menu.renaming === name) {
      m.append(nameInput(tr('spaceName'), name, (v) => renameSpace(name, v), () => { menu.renaming = null; render(); }));
      continue;
    }
    const n = spaces.get(name)?.length || 0;
    m.append(el('button', {
      class: 'item' + (name === view ? ' current' : ''), type: 'button', 'aria-current': name === view ? 'true' : null,
      title: tr('showSpace', spaceLabel(name)),
      onclick: () => pickSpace(name, view, spaces),
      ondblclick: () => { menu.renaming = name; render(); },
      onkeydown: (e) => { if (e.key === 'F2') { e.preventDefault(); menu.renaming = name; render(); } },
    },
      el('span', { class: 'tick', 'aria-hidden': 'true' }, name === view ? '✓' : ''),
      el('span', { class: 'label' }, spaceLabel(name)),
      n ? el('span', { class: 'count' }, String(n)) : null));
  }
  m.append(el('div', { class: 'rule', role: 'separator' }));
  if (menu.adding) {
    m.append(nameInput(tr('newSpaceName'), '', newSpace, () => { menu.adding = false; render(); }));
  } else {
    m.append(el('button', { class: 'item', type: 'button', onclick: () => { menu.adding = true; render(); } },
      el('span', { class: 'tick', 'aria-hidden': 'true' }), el('span', { class: 'label' }, tr('newSpaceItem'))));
  }
  m.append(el('button', { class: 'item', type: 'button', onclick: () => { menu = null; render(); openHome(); } },
    el('span', { class: 'tick', 'aria-hidden': 'true' }), el('span', { class: 'label' }, tr('allSpaces'))));
  return m;
}

function closeMenu(focus) {
  if (!menu) return;
  menu = null;
  render();
  if (focus) root.querySelector('.switcher')?.focus();
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && menu && !e.target.closest?.('input.inline')) closeMenu(true);
  if (menu && (e.key === 'ArrowDown' || e.key === 'ArrowUp') && !e.altKey) {
    const items = [...root.querySelectorAll('.switcher, .menu .item')];
    const i = items.indexOf(document.activeElement);
    if (i >= 0) {
      e.preventDefault();
      items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
    }
  }
});
document.addEventListener('pointerdown', (e) => {
  if (menu && !e.target.closest('.menu, .switcher')) closeMenu(false);
});

function spaceSection(view, megas, names, spaces) {
  const head = el('div', { class: 'space-head' },
    el('button', {
      class: 'switcher', type: 'button', 'aria-expanded': String(!!menu), title: tr('switchSpace'),
      onclick: () => {
        if (menu) return closeMenu(true);
        menu = { renaming: null, adding: false };
        render();
        root.querySelector('.menu .item.current, .menu .item')?.focus();
        const before = JSON.stringify(info);
        loadInfo().then(() => { if (menu && JSON.stringify(info) !== before) render(); });
      },
    }, el('span', {}, spaceLabel(view)), el('span', { class: 'chev', 'aria-hidden': 'true' }, '⌄')),
    el('div', { class: 'tools' },
      el('button', { class: 'quiet board', type: 'button', title: tr('boardOpen', spaceLabel(view)), onclick: () => openBoard(view) }, tr('board')),
      el('button', { class: 'quiet settings', type: 'button', title: tr('settingsOpen'), onclick: () => openPage('settings.html') }, tr('settingsPage'))));
  const box = el('section', { class: 'space' }, head);
  if (menu) box.append(menuEl(names, view, spaces));

  const spaceIds = megas.map((m) => m.ws.id);
  for (const { ws, mega } of megas) {
    box.append(megaRow(ws, view, mega, mega, spaceIds));
    // The current mega tab's workflow text, quiet and short, under its row
    const text = ws.id === state.current && editing?.wsId !== ws.id ? how.get(ws.name) : '';
    if (text) box.append(el('div', { class: 'how', title: text }, text));
  }
  sortable(box);

  const adding = editing && editing.space === view && editing.wsId === null;
  if (adding) box.append(nameInput(tr('newMegaName'), '', (v) => createMega(view, v)));
  else if (!megas.length) {
    box.append(el('p', { class: 'empty' }, tr('noMegas') + ' ',
      el('button', { class: 'quiet add', type: 'button', onclick: () => { editing = { space: view, wsId: null }; render(); } }, tr('newMega'))));
  } else {
    box.append(el('button', { class: 'quiet add', type: 'button', onclick: () => { editing = { space: view, wsId: null }; render(); } }, tr('newMega')));
  }
  return box;
}

// A name is being typed: a redraw would take it away
const typing = () => !!editing || !!(menu && (menu.renaming || menu.adding));

// Where the keyboard focus is, so a redraw does not lose it
function focusKey() {
  const a = document.activeElement;
  if (!a || !root.contains(a) || a.tagName === 'INPUT') return null;
  if (a.classList.contains('switcher')) return '.switcher';
  const row = a.closest('.mega[data-id]');
  if (row) return `.mega[data-id="${row.dataset.id}"] .${a.classList.contains('close') ? 'close' : 'name'}`;
  const item = a.closest('.menu .item');
  if (item) return { item: item.querySelector('.label').textContent };
  if (a.classList.contains('add')) return '.add';
  return null;
}
function restoreFocus(key) {
  if (!key) return;
  const n = typeof key === 'string'
    ? root.querySelector(key)
    : [...root.querySelectorAll('.menu .item')].find((i) => i.querySelector('.label').textContent === key.item);
  n?.focus();
}

function render() {
  const key = focusKey();
  root.replaceChildren();
  if (!state) return;
  const { spaces, open } = groups();
  const names = spaceNames(spaces);
  const view = viewedSpace(spaces, names);

  if (view) {
    root.append(spaceSection(view, spaces.get(view) || [], names, spaces));
  } else {
    root.append(el('section', { class: 'space' },
      el('div', { class: 'space-head' }, el('span', {}, tr('spaces'))),
      el('p', { class: 'empty' }, tr('noSpaces') + ' ',
        el('button', { class: 'quiet add', type: 'button', onclick: () => { menu = { renaming: null, adding: true }; render(); } }, tr('newSpace')))));
    if (menu) root.firstChild.append(menuEl(names, view, spaces));
  }
  if (open.length) {
    const box = el('section', { class: 'space open' }, el('div', { class: 'space-head' }, el('span', {}, tr('openWindows'))));
    for (const ws of open) box.append(megaRow(ws, GENERAL, '', titles[ws.id] || tr('emptyWindow'), null));
    root.append(box);
  }
  if (state.deleted?.length) {
    root.append(el('button', { class: 'quiet', type: 'button', onclick: () => act(() => send({ type: 'undoDelete' })) }, tr('undoClose')));
  }
  if (!introSeen && view) {
    root.append(el('p', { class: 'dim intro' }, tr('intro')));
  }
  if (info && info.files === false) {
    root.append(el('p', { class: 'dim files-off' }, tr('filesOffLead') + ' ',
      el('button', { class: 'quiet', type: 'button', onclick: () => openHome('#setup') }, tr('setUp'))));
  }
  if (error) root.append(el('div', { class: 'error', role: 'alert' }, error));
  restoreFocus(key);
}

(async () => {
  localize();
  // The browser window this panel belongs to. A test opens the page elsewhere and says which with ?window=.
  windowId = Number(new URLSearchParams(location.search).get('window')) || (await chrome.windows.getCurrent()).id;
  // Stay current: storage changes on every switch/create/delete; tab counts change with tabs.
  chrome.storage.onChanged.addListener(() => { if (!typing()) refresh(); });
  for (const ev of [chrome.tabs.onCreated, chrome.tabs.onRemoved, chrome.windows.onFocusChanged]) {
    ev.addListener(() => { if (!typing()) refresh(); });
  }
  // Window titles change as pages load; refresh quietly after they settle.
  let titleTimer;
  chrome.tabs.onUpdated.addListener((_id, change) => {
    if (!change.title) return;
    clearTimeout(titleTimer);
    titleTimer = setTimeout(() => { if (!typing()) refresh(); }, 400);
  });
  await send({ type: 'seed' }).catch(() => {});   // first run only: the Me starter space
  await Promise.all([refresh(), loadInfo()]);
  render();
  // After the extension reloads itself in development, this page's connection is gone: reload it.
  setInterval(() => { if (!chrome.runtime?.id) location.reload(); }, 1000);
})();
