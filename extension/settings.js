// Mega tabs settings: Edge reveal (on or off, and the side), the automatic backup file, export and import.
// background.js answers { ok, result } or { ok: false, error }; edge.js answers on the `mega` port.
const $ = (id) => document.getElementById(id);
let origins = null;   // the host permission Edge reveal needs, as edge.js names it

const send = (msg) =>
  chrome.runtime.sendMessage(msg).then((r) => {
    if (!r?.ok) throw new Error(r?.error || tr('noAnswer'));
    return r.result;
  });

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

const say = (id, text) => { $(id).textContent = text; };
const side = () => document.querySelector('input[name="side"]:checked')?.value || 'left';

// ---------------------------------------------------------------- Edge reveal

function showEdge(s) {
  origins = s.origins;
  $('edge-on').checked = s.on;
  for (const r of document.querySelectorAll('input[name="side"]')) r.checked = r.value === s.side;
  say('edge-note', s.on ? tr(s.side === 'right' ? 'edgeOnRight' : 'edgeOnLeft') : '');
}

async function loadEdge() {
  showEdge(await mega('edgeState'));
}

// Chrome shows its permission question only for a click, so the request is the first thing the click does
$('edge-on').addEventListener('change', (e) => {
  const on = e.target.checked;
  if (on && !origins) { e.target.checked = false; return; }   // not read yet
  const ask = on ? chrome.permissions.request({ origins }) : Promise.resolve(true);
  ask
    .then((granted) => {
      if (!granted) throw new Error(tr('edgeDenied'));
      return mega('setEdge', { on, side: side() });
    })
    .then(showEdge)
    .catch(async (err) => {
      await loadEdge().catch(() => {});   // the box shows what is true
      say('edge-note', String(err.message || err));
    });
});

for (const r of document.querySelectorAll('input[name="side"]')) {
  r.addEventListener('change', () => {
    // The side is kept even while it is off; pages follow it without a reload
    mega('setEdge', { on: $('edge-on').checked, side: side() }).then(showEdge).catch((err) => say('edge-note', String(err.message || err)));
  });
}

// ---------------------------------------------------------------- Backup

const autoLabel = (d) => tr(!d ? 'backupNever' : d === 1 ? 'backupDaily' : 'backupWeekly');
const when = (t) => new Date(t).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });

function showAuto(a) {
  const sel = $('auto');
  sel.replaceChildren(...a.choices.map((d) => Object.assign(document.createElement('option'), { value: String(d), textContent: autoLabel(d) })));
  sel.value = String(a.days);
  const lines = [];
  if (a.days) lines.push(tr('backupKept', a.keep, a.dir));
  if (a.last?.state === 'complete') lines.push(tr('backupLast', when(a.last.at)));
  if (a.error) lines.push(a.error.message);
  say('auto-note', lines.join(' '));
}

$('auto').addEventListener('change', (e) => {
  say('auto-note', tr('backupSaving'));
  send({ type: 'autoBackup', days: Number(e.target.value) }).then(showAuto).catch((err) => say('auto-note', String(err.message || err)));
});

// ---------------------------------------------------------------- Export and import

$('export').addEventListener('click', async () => {
  try {
    const data = await send({ type: 'export' });
    const blob = new Blob([JSON.stringify(data, null, 2) + '\n'], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `mega-tabs-${data.exported.slice(0, 10)}.json`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    const tabs = data.workspaces.reduce((n, w) => n + w.tabs.length, 0);
    say('data-note', tr('exportSaved', a.download, plural(data.workspaces.length, 'megaTabs'), plural(tabs, 'tabs')));
  } catch (e) {
    say('data-note', tr('exportFail', String(e.message || e)));
  }
});

$('import').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const r = await send({ type: 'import', text: await file.text(), mode: 'merge' });
    say('data-note', r.created || r.added
      ? tr('importAdded', plural(r.created, 'megaTabs'), plural(r.added, 'tabs'), file.name)
      : tr('importNothing', file.name));
  } catch (err) {
    say('data-note', tr('importFail', String(err.message || err).replace(/^Error: /, '')));
  }
});

// ---------------------------------------------------------------- Start

(async () => {
  localize();
  await Promise.all([
    loadEdge().catch((e) => say('edge-note', String(e.message || e))),
    send({ type: 'autoBackupState' }).then(showAuto).catch((e) => say('auto-note', String(e.message || e))),
  ]);
  // After the extension reloads itself in development, this page's connection is gone: reload it.
  setInterval(() => { if (!chrome.runtime?.id) location.reload(); }, 1000);
})();
