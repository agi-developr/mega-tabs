// Mega tabs: Edge reveal, the service worker side. Loaded by megatabs.js (importScripts), after the
// `mega` port exists.
//
// Edge reveal is opt-in. With it on, a small script (edge-content.js) runs in web pages and shows a
// mini switcher when the pointer rests at the screen edge. It needs the optional host permission
// `<all_urls>` and a registered content script:
//
//   off  -> no content script is registered and no host permission is held (both are removed together)
//   on   -> the permission is held (the Settings page asks for it from a click) and the script is
//           registered, so every page loaded from now on has it; open tabs get it right away
//
// The setting lives in storage.local `megaEdge` = { on, side }. The script in each page watches that key,
// so turning it off, or changing the side, takes effect in open tabs without a reload.

const EDGE_KEY = 'megaEdge';
const EDGE_SCRIPT_ID = 'megatabs-edge';
const EDGE_FILE = 'edge-content.js';
// The host permission Edge reveal asks for: whatever the manifest lists as optional (`<all_urls>`). The
// Settings page asks for exactly this list (edgeState gives it), so the manifest is its one home.
const EDGE_ORIGINS = chrome.runtime.getManifest?.().optional_host_permissions ?? [];
const EDGE_MATCHES = ['http://*/*', 'https://*/*'];
// background.js refuses a message from any other origin than this one
const EDGE_OWN_ORIGIN = chrome.runtime.getURL('').replace(/\/$/, '');

async function edgeSetting() {
  const { megaEdge } = await chrome.storage.local.get(EDGE_KEY);
  return { on: !!megaEdge?.on, side: megaEdge?.side === 'right' ? 'right' : 'left' };
}

function edgeHasPermission() {
  return chrome.permissions.contains({ origins: EDGE_ORIGINS });
}
const edgeRegistered = async () => (await chrome.scripting.getRegisteredContentScripts({ ids: [EDGE_SCRIPT_ID] })).length > 0;

async function edgeRegister() {
  if (await edgeRegistered()) return;
  await chrome.scripting.registerContentScripts([{
    id: EDGE_SCRIPT_ID,
    js: [EDGE_FILE],
    matches: EDGE_MATCHES,
    runAt: 'document_idle',
    persistAcrossSessions: true,
  }]);
}

async function edgeUnregister() {
  if (await edgeRegistered()) await chrome.scripting.unregisterContentScripts({ ids: [EDGE_SCRIPT_ID] });
}

// Pages that are open now: the registered script only reaches pages loaded after it. The script guards
// against running twice. A tab that cannot be reached (discarded, a page that is gone) is skipped; it gets
// the script when it loads.
async function edgeInjectOpenTabs() {
  const tabs = await chrome.tabs.query({ url: EDGE_MATCHES }).catch(() => []);
  for (const t of tabs) {
    if (t.discarded || t.id === undefined) continue;
    await chrome.scripting.executeScript({ target: { tabId: t.id }, files: [EDGE_FILE] }).catch(() => {});
  }
}

// Brings the registration in line with the setting and the permission held. Runs at every worker start
// and when the permission is removed (from chrome://extensions), so the three never disagree: a setting
// that is on without its permission is turned off, and a script is never registered while off.
async function edgeSync() {
  const set = await edgeSetting();
  const held = await edgeHasPermission();
  if (set.on && !held) {
    await chrome.storage.local.set({ [EDGE_KEY]: { on: false, side: set.side } });
    return edgeUnregister();
  }
  if (set.on) return edgeRegister();
  await edgeUnregister();
  if (held) await chrome.permissions.remove({ origins: EDGE_ORIGINS });
}

// { on, side }. on: true needs the permission already held (the page asks for it from a click: Chrome only
// shows that question for a user gesture). Own pages only (not in MEGA_PUBLIC).
async function edgeSet(m) {
  const side = m.side === 'right' ? 'right' : 'left';
  const on = !!m.on;
  if (on && !(await edgeHasPermission())) {
    throw Object.assign(new Error('Edge reveal needs permission to run on web pages'), { code: 'no-permission' });
  }
  if (on) {
    await edgeRegister();
    await chrome.storage.local.set({ [EDGE_KEY]: { on, side } });
    await edgeInjectOpenTabs();
  } else {
    // First the setting, so scripts in open pages remove themselves; then the script and the permission
    await chrome.storage.local.set({ [EDGE_KEY]: { on, side } });
    await edgeUnregister();
    if (await edgeHasPermission()) await chrome.permissions.remove({ origins: EDGE_ORIGINS });
  }
  return edgeState();
}

async function edgeState() {
  const set = await edgeSetting();
  return { ...set, origins: EDGE_ORIGINS, permission: await edgeHasPermission(), registered: await edgeRegistered() };
}

// What the switcher in a page may know: the mega tabs of one space and which is shown. Not the other
// spaces, tab counts, titles or addresses.
async function edgeView(windowId) {
  const st = await stateFor(windowId);
  const named = st.workspaces.filter((w) => !megaIsDefaultName(w.name)).map((w) => ({ id: w.id, ...megaSplit(w.name) }));
  const cur = named.find((w) => w.id === st.current);
  const space = cur ? cur.space : named[0]?.space ?? null;
  return {
    space,
    megas: named.filter((w) => w.space === space).map((w) => ({ id: w.id, name: w.mega, current: w.id === st.current })),
  };
}

// Must run in the same turn as the click that asked: sidePanel.open() works only as the first thing after a
// user gesture, and nothing may be awaited before it.
function edgeOpenPanel(windowId) {
  if (!chrome.sidePanel?.open) throw new Error('This Chrome cannot open the side panel from a page');
  return chrome.sidePanel.open({ windowId }).then(() => ({ opened: true }));
}

Object.assign(MEGA_OPS, {
  openPanel: (m) => edgeOpenPanel(m.windowId),
  edgeState: () => edgeState(),
  setEdge: (m) => edgeSet(m),
});

if (chrome.permissions?.onRemoved?.addListener) {
  chrome.permissions.onRemoved.addListener(() => edgeSync().catch((e) => console.warn('[megatabs] edge not synced', e)));
}
if (chrome.scripting?.getRegisteredContentScripts) {
  edgeSync().catch((e) => console.warn('[megatabs] edge not synced', e));
}
