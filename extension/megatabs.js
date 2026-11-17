// Mega tabs: first-run seed and development auto-reload.
// Loaded by background.js after the upstream engine; uses its createWs/getConfig/serial.

// ---------------------------------------------------------------- First-run seed

const SEED_SPACE = 'Me'; // i18n-ok: seed data (a space name and mega tab names written into his own data), not interface text
const SEED_MEGAS = ['Reading', 'Drafts', 'Archive', 'Writing']; // i18n-ok: same

// The panel's `seed` message: first-run starter space, then the files (applyMegaTabs).
async function seedMegaTabs() {
  const seeded = await seedOnce();
  await applyMegaTabs().catch((e) => console.warn('[megatabs] files not applied', e));
  return seeded;
}

// Creates the starter space once, when the side panel is first opened. The flag is set in
// the same serial step, so two panels opening at once cannot seed twice; names that
// already exist are never created again and no existing workspace is touched.
function seedOnce() {
  return serial(async () => {
    const { megaSeeded } = await chrome.storage.local.get('megaSeeded');
    if (megaSeeded) return false;
    const have = new Set((await getConfig()).workspaces.map((w) => w.name));
    for (const mega of SEED_MEGAS) {
      const name = `${SEED_SPACE} · ${mega}`;
      if (!have.has(name)) await createWs(name);
    }
    await chrome.storage.local.set({ megaSeeded: true });
    return true;
  });
}

// ---------------------------------------------------------------- Mega tabs from plain files

// board-sync.js copies ~/Spaces/<space>/<mega tab>/MEGATAB.md into board-data/megatabs.json:
// { megatabs: [{ space, mega, urls: [...], body }] }. This makes the mega tab when it is
// missing and opens the URLs it lacks as tabs in it (shown, stashed, or saved for its next
// switch). It never closes, moves or reloads a tab. A URL is opened once: it is remembered
// in `megaOpened` (workspace id -> keys), so a tab he closes by hand stays closed and a
// repeated run adds nothing.
const MEGA_FILE = 'board-data/megatabs.json';
const MEGA_SEP = ' · ';

async function readMegaFiles() {
  if (typeof fetch !== 'function') return [];
  try {
    const r = await fetch(chrome.runtime.getURL(MEGA_FILE), { cache: 'no-store' });
    if (!r.ok) return [];
    const j = await r.json();
    return Array.isArray(j.megatabs) ? j.megatabs : [];
  } catch {
    return [];
  }
}

// Same address with or without a trailing slash or #fragment counts as one
function megaKey(u) {
  try {
    const x = new URL(u);
    x.hash = '';
    return x.href.replace(/\/$/, '');
  } catch {
    return String(u);
  }
}

const megaWebUrl = (u) => typeof u === 'string' && /^https?:\/\//i.test(u.trim());

// list: the parsed files (tests pass their own); without it the file is read.
async function applyMegaTabs(list) {
  const files = (list || (await readMegaFiles())).filter(
    (m) => m && typeof m.space === 'string' && typeof m.mega === 'string' && m.space.trim() && m.mega.trim(),
  );
  if (!files.length) return { made: 0, opened: 0 };
  return userAction(async () => {
    let made = 0;
    let opened = 0;
    const cfg = await getConfig();
    const byName = new Map(cfg.workspaces.map((w) => [w.name, w]));
    const { megaOpened = {} } = await chrome.storage.local.get('megaOpened');
    const { backup } = await getBackup();
    let backupDirty = false;
    try {
      for (const m of files) {
        const name = wsName(`${m.space.trim()}${MEGA_SEP}${m.mega.trim()}`);
        let ws = byName.get(name);
        if (!ws) {
          ws = await createWs(name);
          byName.set(name, ws);
          made++;
        }
        const urls = (Array.isArray(m.urls) ? m.urls : []).filter(megaWebUrl).map((u) => u.trim());
        if (!urls.length) continue;
        // What the mega tab holds now: tabs in its window or stash window, or, with no window, its saved tabs
        const s = await sess();
        const { stash, mains } = await scan();
        const { sw, showing } = windowsOf(ws.id, s, stash, mains);
        const have = new Set();
        for (const w of showing) for (const t of movableTabsOf(w)) have.add(megaKey(urlOf(t) || ''));
        if (sw) for (const t of stashTabsOf(sw)) have.add(megaKey(urlOf(t) || ''));
        if (!sw && !showing.length) for (const e of savedOf(backup[ws.id])) have.add(megaKey(e.url));
        const done = new Set(megaOpened[ws.id] || []);
        for (const url of urls) {
          const key = megaKey(url);
          if (done.has(key)) continue;
          if (!have.has(key)) {
            if (showing.length) await openTab({ windowId: showing[0].id, url });
            else if (sw) await openTab({ windowId: sw.id, url });
            else {
              const b = (backup[ws.id] ||= { stash: [], shown: [] });
              (b.stash ||= []).push({ url, title: '' });
              backupDirty = true;
            }
            have.add(key);
            opened++;
          }
          done.add(key);
          megaOpened[ws.id] = [...done];
        }
      }
    } finally {
      // Also after a failure part-way: what was opened stays remembered, so it is never opened twice
      if (backupDirty) await chrome.storage.local.set({ backup });
      const live = new Set((await getConfig()).workspaces.map((w) => w.id));
      for (const id of Object.keys(megaOpened)) if (!live.has(id)) delete megaOpened[id];
      await chrome.storage.local.set({ megaOpened });
    }
    return { made, opened };
  });
}

// After a reload or a browser start, once the engine's own startup steps have run
if (typeof fetch === 'function' && typeof setTimeout === 'function') {
  setTimeout(() => applyMegaTabs().catch((e) => console.warn('[megatabs] files not applied', e)), 1500);
}

// A MEGATAB.md edit changes megatabs.json but never BUILD (stamp.js leaves board-data out, so no
// .md save reloads the extension or the Board page). The file is polled here instead: when its
// text differs from the last read, the files are applied again (idempotent, see above).
let megaSeen = null;
async function checkMegaFiles() {
  let text;
  try {
    const r = await fetch(chrome.runtime.getURL(MEGA_FILE), { cache: 'no-store' });
    text = r.ok ? await r.text() : '';
  } catch {
    return;
  }
  if (megaSeen === null) {
    megaSeen = text;
    return;
  }
  if (text === megaSeen) return;
  megaSeen = text;
  await applyMegaTabs().catch((e) => console.warn('[megatabs] files not applied', e));
}
if (typeof fetch === 'function' && typeof setInterval === 'function') {
  checkMegaFiles();
  setInterval(checkMegaFiles, 2000);
}

// ---------------------------------------------------------------- Option+W toggles the panel

// Open when closed, close when open. A panel is "open" when the browser lists a SIDE_PANEL
// context; it does not say which window (windowId is -1), so any listed panel counts.
// sidePanel.open() only works as the very first thing after the key press (the user gesture is
// lost across an await), so it is called before anything is awaited. If a panel was open
// already, that call changes nothing and the panel is then closed with sidePanel.close
// (Chrome 141+). Without close a panel cannot be closed from code: nothing is faked, the
// result says 'cannot-close'.
async function togglePanel(windowId) {
  const sp = chrome.sidePanel;
  if (!sp?.open) return 'unsupported';
  const before = chrome.runtime.getContexts ? chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] }) : Promise.resolve([]);
  let opening;
  try {
    opening = Promise.resolve(sp.open({ windowId })).then(() => null, (e) => e);
  } catch (e) {
    opening = Promise.resolve(e);
  }
  const wasOpen = (await before).length > 0;
  const failed = await opening;
  if (!wasOpen) {
    if (failed) throw failed;
    return 'opened';
  }
  if (!sp.close) return 'cannot-close';
  await sp.close({ windowId });
  return 'closed';
}

// ---------------------------------------------------------------- Development auto-reload

// An unpacked extension reads its files from disk on every reload. `BUILD` (written by
// stamp.js) changes whenever a file under extension/ does; when it differs from the stamp
// seen before, the extension reloads itself. A packed copy has no BUILD file, so nothing
// happens there. Tabs stay loaded: reloading the extension does not reload pages.
const BUILD_POLL_MS = 2000;

async function checkBuild() {
  let stamp;
  try {
    const r = await fetch(chrome.runtime.getURL('BUILD'), { cache: 'no-store' });
    if (!r.ok) return;
    stamp = (await r.text()).trim();
  } catch {
    return;
  }
  const { buildSeen } = await chrome.storage.local.get('buildSeen');
  if (buildSeen === stamp) return;
  await chrome.storage.local.set({ buildSeen: stamp });
  if (buildSeen !== undefined) chrome.runtime.reload();
}

// Only where fetch exists (a real service worker); the test fake has no fetch.
if (typeof fetch === 'function' && typeof setInterval === 'function') {
  checkBuild();
  setInterval(checkBuild, BUILD_POLL_MS);
}

// ---------------------------------------------------------------- Spaces

// A space is the part of a workspace name before " · ". The panel and the Spaces home page talk to
// this file over a runtime port named "mega" (one request, one answer: { id, type, ...args } ->
// { id, ok, result } or { id, ok: false, error }). Files (folders, covers) come from the Board's
// native host, one message per call; when the host or one of its ops is missing the answer says
// files: false and everything else keeps working.
const MEGA_HOST = 'com.megatabs.board';
const MEGA_HOST_MS = 8000;
const MEGA_GENERAL = 'General';
const MEGA_NAME_MAX = 64;

const megaEsc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Names the upstream engine gives on its own are not mega tabs of any space (see sidepanel.js)
function megaIsDefaultName(name) {
  const re = new RegExp('^(' + [
    megaEsc(tr('workspaceN', '@@N@@')).replace('@@N@@', '\\d+'),
    megaEsc(tr('workspaceName')),
    megaEsc(tr('defaultWorkspace')),
    megaEsc(tr('recoveredWorkspace')),
    'Workspace \\d+', 'Workspace', 'Default', 'Recovered', // i18n-ok: engine-made names, matched as data (see sidepanel.js)
  ].join('|') + ')$');
  return re.test(name.trim());
}

function megaSplit(name) {
  const i = name.indexOf(MEGA_SEP);
  return i < 0 ? { space: MEGA_GENERAL, mega: name } : { space: name.slice(0, i).trim(), mega: name.slice(i + MEGA_SEP.length).trim() };
}

// A space name becomes a folder name too: no slashes, no leading dot, no " · ", not empty
function megaCleanSpace(raw) {
  const name = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (!name) throw Object.assign(new Error(tr('errNameEmpty')), { code: 'bad-name' });
  if (name.length > MEGA_NAME_MAX) throw Object.assign(new Error(tr('errNameLong')), { code: 'bad-name' });
  if (/[\\/:*?"<>|\0]/.test(name) || name.startsWith('.') || name.includes(MEGA_SEP)) {
    throw Object.assign(new Error(tr('nameBad')), { code: 'bad-name' });
  }
  return name;
}

// ---- host

const megaHostGone = (e) => e?.code === 'offline' || e?.code === 'bad-request' || e?.code === 'unknown-op';

async function megaHost(type, args = {}) {
  if (typeof chrome.runtime.sendNativeMessage !== 'function') throw Object.assign(new Error('no native messaging'), { code: 'offline' });
  let timer;
  let r;
  try {
    r = await Promise.race([
      chrome.runtime.sendNativeMessage(MEGA_HOST, { type, ...args }),
      new Promise((_, no) => { timer = setTimeout(() => no(new Error(tr('errHost'))), MEGA_HOST_MS); }),
    ]);
  } catch (e) {
    throw Object.assign(new Error(String(e?.message || e)), { code: 'offline' });
  } finally {
    clearTimeout(timer);
  }
  if (!r || r.error) throw Object.assign(new Error(r?.message || r?.error || tr('errHost')), { code: r?.error || 'offline' });
  return r;
}

const megaImageUrl = (v) => (typeof v === 'string' && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(v) ? v : null);
function megaCoverOf(r) {
  for (const v of [r?.cover?.data, r?.cover]) {
    const u = megaImageUrl(v);
    if (u) return u;
  }
  return null;
}

// ---- reading

async function megaLastMega() {
  return (await chrome.storage.local.get('lastMega')).lastMega || {};
}

// The mega tabs of each space (default-named workspaces belong to none), then the folders the host knows
// windowId (optional): which space that window shows, as `current`
async function megaSpaces(windowId) {
  const cfg = await getConfig();
  const map = new Map();
  for (const ws of cfg.workspaces) {
    if (megaIsDefaultName(ws.name)) continue;
    const { space } = megaSplit(ws.name);
    if (!map.has(space)) map.set(space, { name: space, megas: 0, folder: false });
    map.get(space).megas++;
  }
  const shownId = windowId === undefined ? null : (await sess()).windowWs[windowId];
  const shown = cfg.workspaces.find((w) => w.id === shownId);
  const current = shown && !megaIsDefaultName(shown.name) ? megaSplit(shown.name).space : null;
  let files = true;
  try {
    const r = await megaHost('spaces');
    const list = (Array.isArray(r.spaces) ? r.spaces : [])
      .map((s) => (typeof s === 'string' ? s : s?.name ?? s?.space))
      .filter((n) => typeof n === 'string' && n && !n.startsWith('.'))
      .sort((a, b) => a.localeCompare(b));
    for (const n of list) {
      if (!map.has(n)) map.set(n, { name: n, megas: 0, folder: true });
      else map.get(n).folder = true;
    }
  } catch (e) {
    if (e.code !== 'no-root' && !megaHostGone(e)) throw e;   // no ~/Spaces yet: no folders
    files = !megaHostGone(e);
  }
  return { spaces: [...map.values()], files, current };
}

async function megaCover(space) {
  try {
    return { cover: megaCoverOf(await megaHost('cover', { space })), files: true };
  } catch (e) {
    return { cover: null, files: !megaHostGone(e) };
  }
}

const COVER_MAX = 700 * 1024;
// data: a data: URL of a png, jpeg or webp, at most 700 KB (the host checks the bytes too)
async function megaPutCover(space, data) {
  if (!megaImageUrl(data)) throw Object.assign(new Error(tr('coverType')), { code: 'bad-type' });
  if (data.length > Math.ceil((COVER_MAX * 4) / 3) + 64) throw Object.assign(new Error(tr('coverBig')), { code: 'too-large' });
  try {
    await megaHost('putcover', { space, data });
  } catch (e) {
    if (megaHostGone(e)) return { cover: null, files: false };
    throw e;
  }
  return megaCover(space);
}

// ---- switching

function megaPick(workspaces, space, lastMega) {
  const inSpace = workspaces.filter((w) => !megaIsDefaultName(w.name) && megaSplit(w.name).space === space);
  return inSpace.find((w) => w.id === lastMega[space]) || inSpace[0] || null;
}

// Shows the space's last used mega tab, else its first; a folder with no mega tab gets "<space> · Main".
// The Spaces home tab (closeTab) is closed after the switch: before it, the window could end up empty.
function megaSwitchSpace(windowId, space, closeTab) {
  return userAction(async () => {
    const cfg = await getConfig();
    let ws = megaPick(cfg.workspaces, space, await megaLastMega());
    if (!ws) ws = await createWs(wsName(`${space}${MEGA_SEP}Main`)); // i18n-ok: the name of the first mega tab of a space, data like the seed names
    if ((await sess()).windowWs[windowId] !== ws.id) await showWs(windowId, ws.id);
    if (closeTab) await chrome.tabs.remove(closeTab).catch(() => {});
    return { wsId: ws.id };
  });
}

// New space: its folder (never overwritten), a first mega tab "<name> · Main", and a switch to it.
// Without the host the mega tab is still made; files: false tells the page to say so.
async function megaNewSpace(windowId, raw, closeTab) {
  const name = megaCleanSpace(raw);
  let files = true;
  try {
    await megaHost('mkspace', { space: name });
  } catch (e) {
    if (megaHostGone(e)) files = false;
    else if (!/^(exists|conflict|taken)$/.test(e.code)) throw e;   // a folder that is already there is fine
  }
  const { wsId } = await megaSwitchSpace(windowId, name, closeTab);
  return { wsId, files, space: name };
}

// ---- rename

// Every "<old> · *" workspace and the folder change together, or nothing changes. The folder goes
// first: the host refuses a taken name, and only then are the workspaces renamed. No tab moves.
async function megaRenameSpace(from, raw) {
  const to = megaCleanSpace(raw);
  if (to === from) return { files: true, space: to };
  const taken = () => Object.assign(new Error(tr('nameTaken')), { code: 'taken' });
  const cfg = await getConfig();
  const mine = cfg.workspaces.filter((w) => !megaIsDefaultName(w.name) && megaSplit(w.name).space === from);
  if (cfg.workspaces.some((w) => !megaIsDefaultName(w.name) && megaSplit(w.name).space.toLowerCase() === to.toLowerCase() && megaSplit(w.name).space !== from)) throw taken();
  let files = true;
  let folderMoved = false;
  try {
    // A folder of that name may exist with no mega tab: taking its name would merge two spaces
    const known = (await megaHost('spaces')).spaces || [];
    if (known.some((s) => String(s?.name ?? s).toLowerCase() === to.toLowerCase() && String(s?.name ?? s) !== from)) throw taken();
    await megaHost('renamespace', { space: from, to });
    folderMoved = true;
  } catch (e) {
    if (megaHostGone(e)) files = false;
    else if (e.code === 'taken' || /^(exists|conflict)$/.test(e.code)) throw taken();
    else if (!/^(no-space|no-root|not-found)$/.test(e.code)) throw e;   // no folder yet: names only
  }
  try {
    await userAction(async () => {
      for (const ws of mine) await updateWs(ws.id, { name: `${to}${MEGA_SEP}${megaSplit(ws.name).mega}` });
      const lm = await megaLastMega();
      if (from in lm) {
        lm[to] = lm[from];
        delete lm[from];
        await chrome.storage.local.set({ lastMega: lm });
      }
    });
  } catch (e) {
    if (folderMoved) await megaHost('renamespace', { space: to, to: from }).catch(() => {});
    throw e;
  }
  return { files, space: to };
}

// ---- remembering the last mega tab of each space

// Every switch, by any route (panel, keys, menu), changes windowWs in storage.session. The mega tab
// now shown becomes its space's last used one; the first switch also ends the panel's first-run hint.
let megaNoteQueue = Promise.resolve();
function megaNoteSwitch(oldWs, newWs) {
  megaNoteQueue = megaNoteQueue.then(async () => {
    const { workspaces } = await getConfig();
    const byId = new Map(workspaces.map((w) => [w.id, w]));
    const lm = await megaLastMega();
    let dirty = false;
    let switched = false;
    for (const [win, id] of Object.entries(newWs || {})) {
      if ((oldWs || {})[win] === id) continue;
      if ((oldWs || {})[win] !== undefined) switched = true;
      const ws = byId.get(id);
      if (!ws || megaIsDefaultName(ws.name)) continue;
      const { space } = megaSplit(ws.name);
      if (lm[space] !== id) {
        lm[space] = id;
        dirty = true;
      }
    }
    if (dirty) await chrome.storage.local.set({ lastMega: lm });
    if (switched) await chrome.storage.local.set({ megaIntroSeen: true });
  }).catch((e) => console.warn('[megatabs] last mega tab not saved', e));
}
if (chrome.storage?.onChanged?.addListener) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes.windowWs) megaNoteSwitch(changes.windowWs.oldValue, changes.windowWs.newValue);
  });
}

// ---- the `mega` port

// What a page or script that is not ours may ask. Our own pages may ask everything below.
const MEGA_PUBLIC = new Set(['state', 'show', 'openPanel']);
const MEGA_OPS = {
  state: (m) => (m.fromPage ? edgeView(m.windowId) : stateFor(m.windowId)),   // a page sees only the current space (edge.js)
  show: (m) => userAction(() => showWs(m.windowId, m.wsId)),
  spaces: (m) => megaSpaces(m.windowId),
  cover: (m) => megaCover(m.space),
  putCover: (m) => megaPutCover(m.space, m.data),
  switchSpace: (m) => megaSwitchSpace(m.windowId, m.space, m.closeTab),
  newSpace: (m) => megaNewSpace(m.windowId, m.name, m.closeTab),
  renameSpace: (m) => megaRenameSpace(m.space, m.to),
};

if (chrome.runtime?.onConnect?.addListener) {
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'mega') return;
    const own = port.sender?.id === chrome.runtime.id && (!port.sender?.url || port.sender.url.startsWith(chrome.runtime.getURL('')));
    port.onMessage.addListener((m) => {
      const id = m?.id;
      const op = typeof m?.type === 'string' && Object.hasOwn(MEGA_OPS, m.type) ? MEGA_OPS[m.type] : null;
      const answer = (o) => { try { port.postMessage({ id, ...o }); } catch { /* the page is gone */ } };
      if (!op || (!own && !MEGA_PUBLIC.has(m.type))) return answer({ ok: false, error: 'not allowed' });
      // A page's script (edge-content.js) acts only on the window its own tab is in, whatever it sends
      const msg = own ? m : { ...m, windowId: port.sender?.tab?.windowId, fromPage: true };
      // Called in this very turn, not after an await: sidePanel.open() needs the click's user gesture
      let run;
      try {
        run = Promise.resolve(op(msg));
      } catch (e) {
        run = Promise.reject(e);
      }
      run.then(
        (result) => answer({ ok: true, result }),
        (e) => answer({ ok: false, error: String(e?.message || e), code: e?.code }),
      );
    });
  });
}

// Edge reveal (edge.js adds its ops to MEGA_OPS, so it loads after them)
importScripts('edge.js');
