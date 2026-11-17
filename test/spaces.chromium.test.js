'use strict';
// Panel and Spaces home in a real Chromium (slice 2 of docs/NEXT-SPEC.md): one space at a time with a
// switcher (C37), the last used mega tab per space (C38), tiles with covers and no request leaving the
// extension (C39), a new space from a typed name (C40), renaming (C41), drag to reorder (C30), keyboard
// reach and focus rings (C32), the empty space and the first-run line (C33), and "Files are off" when the
// host or one of its ops is missing (C26, panel and home part).
//
// The folder side is the Board's real host (host/board-host.js) on a temp folder standing in for ~/Spaces,
// installed for the TEST profile only (<profile>/NativeMessagingHosts). His real Chrome and his real
// ~/Spaces are never touched.
//
//   CHROME=<binary> node --test test/spaces.chromium.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { Chromium, waitFor, sleep } = require('./chromium');
const { install } = require('../install-host');

const bin = process.env.CHROME;
const SEED = ['Reading', 'Drafts', 'Archive', 'Writing'];
const DOCS = path.join(__dirname, '..', 'docs');
const LIGHT_BG = 'rgb(247, 247, 245)';
const DARK_BG = 'rgb(28, 28, 30)';

// ---------------------------------------------------------------- helpers

// A calm PNG: a soft blend between two tones, made with zlib alone
function png(w, h, top, bottom) {
  const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = table[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const stride = w * 3 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = (y / (h - 1)) * 0.8 + (x / (w - 1)) * 0.2;
      for (let c = 0; c < 3; c++) raw[y * stride + 1 + x * 3 + c] = Math.round(top[c] + (bottom[c] - top[c]) * k);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function startServer() {
  const hits = new Map();
  const server = http.createServer((req, res) => {
    const name = req.url.slice(1);
    if (name !== 'favicon.ico') hits.set(name, (hits.get(name) || 0) + 1);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(`<!doctype html><title>${name}</title><p>${name}</p>`);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, hits, base: `http://127.0.0.1:${server.address().port}/` })));
}

const evalIn = (b, s, expression) =>
  b.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, s).then((r) => {
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  });
const inPage = (b, url, expression) => b.withPage(url, (s) => evalIn(b, s, expression));

// A page of the extension found by the start of its address
async function withPrefix(b, prefix, fn) {
  const target = await waitFor(async () => {
    const { targetInfos } = await b.send('Target.getTargets');
    const x = targetInfos.find((i) => i.type === 'page' && i.url.startsWith(prefix));
    if (!x) throw new Error(`no page starting with ${prefix}`);
    return x;
  });
  const { sessionId } = await b.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  try {
    return await fn(sessionId);
  } finally {
    await b.send('Target.detachFromTarget', { sessionId }).catch(() => {});
  }
}

// root: a temp folder standing in for ~/Spaces. host: 'real' installs the Board host for this profile,
// 'none' installs nothing (Files are off).
async function launch({ root, host = 'real' } = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'megatabs-spaces-chromium-'));
  const b = new Chromium(bin, profile);
  if (host === 'real') install({ id: b.extId, manifestDir: path.join(profile, 'NativeMessagingHosts'), wrapperDir: path.join(profile, 'board-host'), spaces: root });
  await b.launch({ restore: 'newtab' });
  const win = await waitFor(async () => {
    const { windowWs } = await b.sw("return chrome.storage.session.get('windowWs');");
    const id = Object.keys(windowWs || {})[0];
    assert.ok(id, 'no main window assigned yet');
    return Number(id);
  });
  return { b, profile, win };
}

const cleanup = (b, profile, server, ...dirs) => async () => {
  await b.kill();
  server?.close();
  for (const d of [profile, ...dirs]) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
};

function makeRoot(spec) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'megatabs-spaces-root-')));
  for (const [name, files] of Object.entries(spec)) {
    fs.mkdirSync(path.join(root, name));
    for (const [f, data] of Object.entries(files)) fs.writeFileSync(path.join(root, name, f), data);
  }
  return root;
}

const mouse = (b, s, type, x, y) =>
  b.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 }, s);
const tapKey = async (b, s, k, code, vk, modifiers = 0) => {
  await b.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers }, s);
  await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers }, s);
};

// Walks a page with the Tab key. Every control must come in the order of the page, have a name, show a
// focus ring, and not sit inside another control.
async function tabWalk(b, url) {
  return b.withPage(url, async (s) => {
    await b.send('Emulation.setFocusEmulationEnabled', { enabled: true }, s);
    const NAME = "(e.getAttribute('aria-label') || e.textContent || e.getAttribute('placeholder') || e.title || '').trim()";
    const list = JSON.parse(await evalIn(b, s, `(() => {
      document.activeElement?.blur(); window.scrollTo(0, 0);
      const sel = 'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
      return JSON.stringify([...document.querySelectorAll(sel)].filter((e) => !e.disabled && e.getClientRects().length).map((e) => ({
        tag: e.tagName.toLowerCase(), name: ${NAME}, nested: !!e.parentElement.closest(sel),
      })));
    })()`));
    assert.ok(list.length > 3, `few controls: ${JSON.stringify(list)}`);
    const seen = [];
    for (let i = 0; i < list.length; i++) {
      await tapKey(b, s, 'Tab', 'Tab', 9);
      seen.push(JSON.parse(await evalIn(b, s, `(() => {
        const e = document.activeElement; const cs = getComputedStyle(e);
        return JSON.stringify({ tag: e.tagName.toLowerCase(), name: ${NAME}, ring: cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0 });
      })()`)));
    }
    assert.deepEqual(seen.map((x) => `${x.tag}:${x.name}`), list.map((x) => `${x.tag}:${x.name}`), 'Tab goes through the controls in the order of the page');
    for (const x of list) assert.ok(x.name, `a ${x.tag} has no name`);
    for (const x of list) assert.equal(x.nested, false, `${x.tag} "${x.name}" sits inside another control`);
    for (const x of seen) assert.ok(x.ring, `no focus ring on ${x.tag} "${x.name}"`);
    return list.length;
  });
}

async function shot(b, url, file, { scheme, width, height, scale = 1 }) {
  return b.withPage(url, async (s) => {
    await b.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false }, s);
    await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] }, s);
    await evalIn(b, s, 'document.activeElement?.blur(), true');
    await sleep(200);
    const bg = await evalIn(b, s, 'getComputedStyle(document.body).backgroundColor');
    const r = await b.send('Page.captureScreenshot', { format: 'png' }, s);
    await b.send('Emulation.setEmulatedMedia', { features: [] }, s);
    await b.send('Emulation.clearDeviceMetricsOverride', {}, s);
    fs.mkdirSync(DOCS, { recursive: true });
    fs.writeFileSync(path.join(DOCS, file), Buffer.from(r.data, 'base64'));
    return bg;
  });
}

// ---------------------------------------------------------------- panel

test('Panel: one space at a time, last mega tab, empty space, reorder, rename, new space, keyboard, screenshots', { skip: !bin && 'CHROME is not set', timeout: 600000 }, async (t) => {
  const { server, hits, base } = await startServer();
  const root = makeRoot({
    Me: { 'cover.png': png(480, 300, [226, 224, 216], [196, 200, 206]) },
    Satellite: { 'cover.png': png(480, 300, [198, 204, 212], [160, 170, 184]) },
    Others: {},
    Garden: {},
  });
  const { b, profile, win } = await launch({ root });
  t.after(cleanup(b, profile, server, root));

  const panelUrl = `chrome-extension://${b.extId}/sidepanel.html?window=${win}`;
  await b.sw('await chrome.windows.create({ url: args[0], type: "popup", width: 360, height: 640, focused: false });', panelUrl);
  await waitFor(() => inPage(b, panelUrl, 'document.readyState === "complete" || Promise.reject(new Error("loading"))'));
  const ui = (expr) => inPage(b, panelUrl, expr);
  const view = async () => JSON.parse(await ui(`JSON.stringify([...document.querySelectorAll('section.space:not(.open)')].map((s) => ({
    head: s.querySelector('.space-head span')?.textContent,
    rows: [...s.querySelectorAll('.mega')].map((r) => r.querySelector('.name').textContent),
    current: [...s.querySelectorAll('.mega.current .name')].map((r) => r.textContent),
    empty: s.querySelector('.empty')?.textContent || null,
  })))`));
  const names = () => b.sw("return (await chrome.storage.local.get('workspaces')).workspaces.map((w) => w.name);");
  const current = async () => (await view()).flatMap((s) => s.current)[0];
  const idle = () => waitFor(async () => assert.equal(await b.sw("return !!(await chrome.storage.session.get('pendingSwitch')).pendingSwitch;"), false));
  const openMenu = async () => {
    if (!(await ui("!!document.querySelector('.menu')"))) await ui("document.querySelector('.switcher').click(), true");
    await waitFor(async () => assert.equal(await ui("!!document.querySelector('.menu')"), true));
  };
  const menuLabels = async () => JSON.parse(await ui("JSON.stringify([...document.querySelectorAll('.menu .item .label')].map((n) => n.textContent))"));
  const item = (label) => `[...document.querySelectorAll('.menu .item')].find((i) => i.querySelector('.label').textContent === ${JSON.stringify(label)})`;
  const pickSpace = async (label, expectCurrent) => {
    await openMenu();
    await ui(`${item(label)}.click(), true`);
    await waitFor(async () => {
      const v = await view();
      assert.equal(v.length, 1, 'one space at a time');
      assert.equal(v[0].head, label);
      if (expectCurrent) assert.deepEqual(v[0].current, [expectCurrent]);
    });
    await idle();
  };
  const row = (name) => `[...document.querySelectorAll('section.space:not(.open) .mega')].find((r) => r.querySelector('.name').textContent === ${JSON.stringify(name)})`;
  const clickRow = async (name) => {
    await ui(`${row(name)}.click(), true`);
    await waitFor(async () => assert.equal(await current(), name));
    await idle();
  };
  const mainTabs = () => b.sw('return (await chrome.tabs.query({ windowId: args[0] })).map((t) => ({ url: t.url || t.pendingUrl, status: t.status }));', win);
  const openPage = async (name) => {
    await b.sw('await chrome.tabs.create({ windowId: args[0], url: args[1], active: true });', win, base + name);
    await waitFor(async () => assert.ok((await mainTabs()).some((x) => x.url === base + name && x.status === 'complete'), `${name} not loaded`));
  };
  const typeInto = (sel, text) => ui(`(() => { const i = document.querySelector(${JSON.stringify(sel)}); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); return true; })()`);
  const lastMega = () => b.sw("return (await chrome.storage.local.get('lastMega')).lastMega || {};");
  const idOf = (name) => b.sw("return (await chrome.storage.local.get('workspaces')).workspaces.find((w) => w.name === args[0])?.id;", name);

  await t.test('C37, C33: one space at a time with three spaces; the first-run line; the switcher lists spaces and folders', async () => {
    await waitFor(async () => assert.deepEqual((await view())[0]?.rows, SEED));
    for (const n of ['Satellite · Main', 'Satellite · Maps', 'Lab · Notes']) await b.action('(n) => createWs(n)', n);
    await waitFor(async () => assert.equal((await names()).filter((x) => x.includes(' · ')).length, 7));
    const v = await view();
    assert.equal(v.length, 1, 'one space section besides Open windows');
    assert.equal(v[0].head, 'Me');
    assert.deepEqual(v[0].rows, SEED, 'only its own mega tabs');
    assert.equal(await ui("!!document.querySelector('section.space.open')"), true, 'Open windows stays');
    assert.match(await ui('document.querySelector(".intro")?.textContent || ""'), /mega tab is a set of tabs/);
    assert.equal(await ui("!!document.querySelector('.files-off')"), false, 'the host is there: no Files are off line');
    await openMenu();
    await waitFor(async () => assert.deepEqual((await menuLabels()).slice(0, 5), ['Me', 'Satellite', 'Lab', 'Garden', 'Others']));   // folders arrive a moment after the panel opens
    assert.deepEqual((await menuLabels()).slice(5), ['New space…', 'All spaces']);
    await ui("document.querySelector('.switcher').click(), true");
  });

  await t.test('C38: switching space shows its last used mega tab, nothing reloads; the first switch ends the first-run line', async () => {
    await clickRow('Reading');
    await clickRow('Archive');
    assert.equal(await ui('document.querySelector(".intro")'), null, 'gone after the first switch');
    await openPage('m1');
    await pickSpace('Satellite', 'Main');   // never used: its first mega tab
    await clickRow('Maps');
    await openPage('s1');
    const before = new Map(hits);
    await pickSpace('Me', 'Archive');   // its last used one, not the first
    assert.equal((await lastMega()).Me, await idOf('Me · Archive'));
    assert.ok((await mainTabs()).some((x) => x.url === base + 'm1'), 'Archive shows its page');
    await pickSpace('Satellite', 'Maps');
    await pickSpace('Me', 'Archive');
    assert.deepEqual(new Map(hits), before, 'a page was fetched again');
    assert.deepEqual(b.errors, [], 'unhandled errors in the service worker');
  });

  await t.test('C33: a folder with no mega tab is shown empty; typing a name makes its first mega tab', async () => {
    await pickSpace('Others');
    const v = (await view())[0];
    assert.equal(v.empty, 'No mega tabs yet. + New mega tab');
    assert.ok(!(await names()).some((n) => n.startsWith('Others')), 'choosing it made nothing');
    await ui("document.querySelector('.empty .add').click(), true");
    await waitFor(async () => assert.equal(await ui("!!document.querySelector('input.inline')"), true));
    await typeInto('input.inline', 'Plan');
    await waitFor(async () => assert.deepEqual((await view())[0].rows, ['Plan']));
    assert.ok((await names()).includes('Others · Plan'));
    await pickSpace('Me', 'Archive');
  });

  await t.test('C30: dragging a mega tab row reorders the mega tabs, nothing reloads, the open mega tab stays', async () => {
    await clickRow('Archive');
    const before = new Map(hits);
    const origin = await inPage(b, base + 'm1', 'performance.timeOrigin');
    await b.withPage(panelUrl, async (s) => {
      const rect = async (name) => JSON.parse(await evalIn(b, s, `JSON.stringify((${row(name)}).getBoundingClientRect())`));
      const from = await rect('Writing');
      const top = await rect('Reading');
      const x = from.left + 40;
      await mouse(b, s, 'mousePressed', x, from.top + from.height / 2);
      for (let i = 1; i <= 8; i++) await mouse(b, s, 'mouseMoved', x, from.top + from.height / 2 + ((top.top + 2 - from.top - from.height / 2) * i) / 8);
      assert.equal(await evalIn(b, s, "!!document.querySelector('.mega.drop-before')"), true, 'a line shows where it lands');
      await mouse(b, s, 'mouseReleased', x, top.top + 2);
    });
    const order = ['Writing', 'Reading', 'Drafts', 'Archive'];
    await waitFor(async () => assert.deepEqual((await view())[0].rows, order));
    assert.deepEqual((await names()).filter((n) => n.startsWith('Me ·')), order.map((n) => `Me · ${n}`));
    assert.equal(await current(), 'Archive', 'the drag did not switch');
    assert.deepEqual(new Map(hits), before, 'a page was fetched again');
    assert.equal(await inPage(b, base + 'm1', 'performance.timeOrigin'), origin, 'the open page was not reloaded');
    // The same with the keyboard: Alt+Down on a name moves it one place down
    await b.withPage(panelUrl, async (s) => {
      await evalIn(b, s, `(${row('Writing')}).querySelector('.name').focus(), true`);
      await tapKey(b, s, 'ArrowDown', 'ArrowDown', 40, 1);
    });
    await waitFor(async () => assert.deepEqual((await view())[0].rows, ['Reading', 'Writing', 'Drafts', 'Archive']));
  });

  await t.test('C41: renaming a space renames its mega tabs and its folder together; a taken name changes nothing', async () => {
    const before = new Map(hits);
    const origin = await inPage(b, base + 'm1', 'performance.timeOrigin');
    const rename = async (from, to) => {
      await openMenu();
      await ui(`${item(from)}.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })), true`);
      await waitFor(async () => assert.equal(await ui("!!document.querySelector('.menu input.inline')"), true));
      await typeInto('.menu input.inline', to);
    };
    await pickSpace('Satellite', 'Maps');
    await rename('Satellite', 'Orbit');
    await waitFor(async () => assert.ok((await names()).includes('Orbit · Maps')));
    assert.deepEqual((await names()).filter((n) => n.includes(' · ')).filter((n) => /^(Satellite|Orbit)/.test(n)).sort(), ['Orbit · Main', 'Orbit · Maps']);
    assert.ok(fs.existsSync(path.join(root, 'Orbit', 'cover.png')) && !fs.existsSync(path.join(root, 'Satellite')), 'the folder moved with it');
    await waitFor(async () => assert.equal((await view())[0].head, 'Orbit'));
    const lm = await lastMega();
    assert.ok(lm.Orbit && !lm.Satellite, 'the last mega tab followed the name');
    // A name taken by another space (with mega tabs), and one taken by a bare folder
    const names1 = await names();
    for (const [from, taken] of [['Orbit', 'Me'], ['Orbit', 'Garden'], ['Lab', 'Garden']]) {
      await ui("(error = '', render(), true)");
      await rename(from, taken);
      await waitFor(async () => assert.match(await ui('document.querySelector(".error")?.textContent || ""'), /That name is taken/));
      assert.deepEqual(await names(), names1, `nothing renamed for ${taken}`);
      assert.ok(fs.existsSync(path.join(root, 'Orbit')) && fs.existsSync(path.join(root, 'Garden')));
    }
    assert.deepEqual(new Map(hits), before, 'a page was fetched again');
    assert.equal(await inPage(b, base + 's1', 'performance.timeOrigin') > 0, true);
    assert.equal(await inPage(b, base + 'm1', 'performance.timeOrigin'), origin, 'no tab reloaded');
  });

  await t.test('C40: a new space from a typed name makes its folder and "Name · Main", and switches to it', async () => {
    await openMenu();
    await ui(`${item('New space…')}.click(), true`);
    await waitFor(async () => assert.equal(await ui("!!document.querySelector('.menu input.inline')"), true));
    await typeInto('.menu input.inline', 'Zen');
    await waitFor(async () => {
      const v = await view();
      assert.equal(v[0].head, 'Zen', await ui('JSON.stringify([busy, error, menu, editing, viewPick, info])'));
      assert.deepEqual(v[0].current, ['Main']);
    });
    assert.ok(fs.statSync(path.join(root, 'Zen')).isDirectory());
    assert.ok((await names()).includes('Zen · Main'));
    assert.equal(await ui("!!document.querySelector('.files-off')"), false);
  });

  await t.test('screenshots: the panel with the switcher open, light and dark', async () => {
    await openMenu();
    const light = await shot(b, panelUrl, 'spaces-panel.png', { scheme: 'light', width: 360, height: 640, scale: 2 });
    const dark = await shot(b, panelUrl, 'spaces-panel-dark.png', { scheme: 'dark', width: 360, height: 640, scale: 2 });
    assert.equal(light, LIGHT_BG);
    assert.equal(dark, DARK_BG);
    await ui("document.querySelector('.switcher').click(), true");
    await shot(b, panelUrl, 'spaces-panel-closed.png', { scheme: 'light', width: 360, height: 640, scale: 2 });
  });

  await t.test('C32: Tab reaches every control in reading order, each has a name and a focus ring, none sits inside another', async () => {
    await pickSpace('Me', 'Archive');
    const n = await tabWalk(b, panelUrl);
    t.diagnostic(`panel: ${n} controls walked with the Tab key`);
  });

  await t.test('the new order is kept in storage and survives an extension reload (a full browser restart cannot be run here: the test browser does not come back on macOS, which is why test/chromium.test.js skips its restart steps there)', async () => {
    const order = (await names()).filter((n) => n.startsWith('Me ·'));
    const origin = await inPage(b, base + 'm1', 'performance.timeOrigin');
    b.sw('setTimeout(() => chrome.runtime.reload(), 50); return true;');
    await b.attachWorker();
    assert.deepEqual((await names()).filter((n) => n.startsWith('Me ·')), order);
    assert.equal(await inPage(b, base + 'm1', 'performance.timeOrigin') > 0, true);
    assert.deepEqual(order, ['Me · Reading', 'Me · Writing', 'Me · Drafts', 'Me · Archive'], 'Reading, Writing moved down by the key, as dragged');
    void origin;
  });
});

// ---------------------------------------------------------------- home

test('Spaces home: tiles with covers or letters, no request leaves the extension, a click switches and closes the tab, new space, rename, cover drop, keyboard, screenshots', { skip: !bin && 'CHROME is not set', timeout: 600000 }, async (t) => {
  const { server, hits, base } = await startServer();
  const coverA = png(480, 300, [226, 224, 216], [196, 200, 206]);
  const root = makeRoot({
    Me: { 'cover.png': coverA },
    Satellite: { 'cover.png': png(480, 300, [198, 204, 212], [160, 170, 184]) },
    Others: {},
    Garden: {},
  });
  const { b, profile, win } = await launch({ root });
  t.after(cleanup(b, profile, server, root));

  const homeUrl = `chrome-extension://${b.extId}/home.html?window=${win}`;
  const home = (expr) => inPage(b, homeUrl, expr);
  const tiles = async () => JSON.parse(await home(`JSON.stringify([...document.querySelectorAll('#tiles .tile:not(.new)')].map((t) => ({
    name: t.querySelector('.name')?.textContent, count: t.querySelector('.count')?.textContent || '',
    cover: t.querySelector('img')?.src.slice(0, 15) || '', letter: t.querySelector('.letter')?.textContent || '', current: t.classList.contains('current'),
  })))`));
  const tile = (name) => `[...document.querySelectorAll('#tiles .tile')].find((t) => t.querySelector('.name')?.textContent === ${JSON.stringify(name)})`;
  const openHome = async () => {
    await b.sw('await chrome.tabs.create({ windowId: args[0], url: args[1], active: true });', win, homeUrl);
    await waitFor(async () => assert.ok((await tiles()).length >= 3));
  };
  const homeTabs = () => b.sw('return (await chrome.tabs.query({})).filter((t) => (t.url || t.pendingUrl || "").startsWith(args[0])).length;', homeUrl.split('?')[0]);
  const shown = () => b.sw("const s = (await chrome.storage.session.get('windowWs')).windowWs; const w = (await chrome.storage.local.get('workspaces')).workspaces; return w.find((x) => x.id === s[args[0]])?.name;", win);
  const names = () => b.sw("return (await chrome.storage.local.get('workspaces')).workspaces.map((w) => w.name);");
  const idle = () => waitFor(async () => assert.equal(await b.sw("return !!(await chrome.storage.session.get('pendingSwitch')).pendingSwitch;"), false));

  // The window starts on a mega tab of Me with a real page in it
  await b.sw('return seedMegaTabs();');
  for (const n of ['Satellite · Main', 'Lab · Notes']) await b.action('(n) => createWs(n)', n);
  const first = await b.sw("return (await chrome.storage.local.get('workspaces')).workspaces.find((w) => w.name === 'Me · Reading')?.id;");
  await waitFor(async () => assert.ok(first));
  await b.action(`(id) => showWs(${win}, id)`, first);
  await idle();
  await b.sw('await chrome.tabs.create({ windowId: args[0], url: args[1], active: true });', win, base + 'p1');
  await waitFor(async () => assert.ok((await b.sw('return (await chrome.tabs.query({ windowId: args[0] })).some((t) => t.url === args[1] && t.status === "complete");', win, base + 'p1'))));

  await t.test('C39: one tile per space (mega tab names plus folders), covers as data: URLs or a letter, no request leaves the extension', async () => {
    await openHome();
    const urls = [];
    const orig = b.receive.bind(b);
    b.receive = (m) => { if (m.method === 'Network.requestWillBeSent') urls.push(m.params.request.url); orig(m); };
    await b.withPage(homeUrl, async (s) => {
      await b.send('Network.enable', {}, s);
      await b.send('Page.reload', {}, s);
    });
    b.receive = orig;
    await waitFor(async () => assert.ok((await tiles()).length >= 5 && (await tiles()).every((x) => x.name) && (await tiles()).filter((x) => x.cover).length === 2));
    const list = await tiles();
    assert.deepEqual(list.map((x) => x.name), ['Me', 'Satellite', 'Lab', 'Garden', 'Others']);
    assert.deepEqual(list.map((x) => x.count), ['4', '1', '1', '', '']);
    assert.deepEqual(list.map((x) => x.cover), ['data:image/png;', 'data:image/png;', '', '', '']);
    assert.deepEqual(list.map((x) => x.letter), ['', '', 'L', 'G', 'O']);
    assert.deepEqual(list.filter((x) => x.current).map((x) => x.name), ['Me']);
    assert.ok(urls.length > 0 && urls.every((u) => /^(chrome-extension:|data:)/.test(u)), `requests: ${urls.filter((u) => !/^(chrome-extension:|data:)/.test(u))}`);
    assert.equal(await home("!!document.querySelector('#files-off:not([hidden])')"), false, 'files are on');
  });

  await t.test('C26: a cover dropped on a tile is saved (png, jpg or webp, at most 700 KB); a bigger one is refused', async () => {
    const drop = (name, b64, type) => home(`(() => {
      const bytes = Uint8Array.from(atob(${JSON.stringify(b64)}), (c) => c.charCodeAt(0));
      const dt = new DataTransfer(); dt.items.add(new File([bytes], 'c', { type: ${JSON.stringify(type)} }));
      ${tile(name)}.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); return true; })()`);
    const cover = png(480, 300, [204, 210, 200], [168, 178, 166]);
    await drop('Garden', cover.toString('base64'), 'image/png');
    await waitFor(async () => assert.ok(fs.existsSync(path.join(root, 'Garden', 'cover.png'))));
    assert.deepEqual(fs.readFileSync(path.join(root, 'Garden', 'cover.png')), cover, 'saved byte for byte');
    await waitFor(async () => assert.equal((await tiles()).find((x) => x.name === 'Garden').cover, 'data:image/png;'));
    await drop('Others', Buffer.alloc(800 * 1024, 1).toString('base64'), 'image/png');
    await waitFor(async () => assert.match(await home('document.getElementById("note").textContent'), /over 700 KB/));
    assert.ok(!fs.existsSync(path.join(root, 'Others', 'cover.png')), 'nothing written');
    await drop('Others', Buffer.from('hello').toString('base64'), 'text/plain');
    await waitFor(async () => assert.match(await home('document.getElementById("note").textContent'), /png, jpg or webp/));
  });

  await t.test('C39: a tile click switches to the space and closes the home tab; nothing reloads', async () => {
    const before = new Map(hits);
    assert.equal(await shown(), 'Me · Reading');
    await home(`${tile('Satellite')}.click(), true`);
    await waitFor(async () => assert.equal(await shown(), 'Satellite · Main'));
    await waitFor(async () => assert.equal(await homeTabs(), 0));
    await idle();
    // The same through a folder with no mega tab: opening it makes "Others · Main"
    await openHome();
    await home(`${tile('Others')}.click(), true`);
    await waitFor(async () => assert.equal(await shown(), 'Others · Main'));
    await waitFor(async () => assert.equal(await homeTabs(), 0));
    // Back to Me: Reading shows its page again, never fetched twice
    await idle();
    await openHome();
    await home(`${tile('Me')}.click(), true`);
    await waitFor(async () => assert.equal(await shown(), 'Me · Reading'));
    await waitFor(async () => assert.equal(await homeTabs(), 0));
    await idle();
    assert.deepEqual(new Map(hits), before, 'a page was fetched again');
    assert.deepEqual(b.errors, [], 'unhandled errors in the service worker');
  });

  await t.test('C40: the last tile makes a space from a typed name: its folder and "Name · Main", then a switch', async () => {
    await openHome();
    await home("document.querySelector('#tiles .tile.new').click(), true");
    await waitFor(async () => assert.equal(await home("!!document.querySelector('#tiles .tile.new input')"), true));
    await home("(() => { const i = document.querySelector('#tiles .tile.new input'); i.value = 'Fresh'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); return true; })()");
    await waitFor(async () => assert.equal(await shown(), 'Fresh · Main'));
    await waitFor(async () => assert.equal(await homeTabs(), 0));
    assert.ok(fs.statSync(path.join(root, 'Fresh')).isDirectory());
    assert.ok((await names()).includes('Fresh · Main'));
  });

  await t.test('C41: a double click renames a space on the tile; a taken name is refused', async () => {
    await openHome();
    const rename = async (from, to) => {
      await home(`${tile(from)}.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })), true`);
      await waitFor(async () => assert.equal(await home("!!document.querySelector('#tiles input')"), true));
      await home(`(() => { const i = document.querySelector('#tiles input'); i.value = ${JSON.stringify(to)}; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); return true; })()`);
    };
    const before = await names();
    await rename('Lab', 'Me');
    await waitFor(async () => assert.match(await home('document.getElementById("note").textContent'), /That name is taken/));
    assert.deepEqual(await names(), before);
    await rename('Satellite', 'Orbit');
    await waitFor(async () => assert.ok((await tiles()).some((x) => x.name === 'Orbit')));
    assert.ok((await names()).includes('Orbit · Main') && !(await names()).includes('Satellite · Main'));
    assert.ok(fs.existsSync(path.join(root, 'Orbit', 'cover.png')) && !fs.existsSync(path.join(root, 'Satellite')));
    assert.equal((await tiles()).find((x) => x.name === 'Orbit').cover, 'data:image/png;', 'its cover came with it');
  });

  await t.test('C32: Tab reaches every control of the home page in reading order, each with a name and a focus ring', async () => {
    const n = await tabWalk(b, homeUrl);
    t.diagnostic(`home: ${n} controls walked with the Tab key`);
  });

  await t.test('screenshots: the home page, light and dark', async () => {
    const light = await shot(b, homeUrl, 'spaces-home.png', { scheme: 'light', width: 1200, height: 760 });
    const dark = await shot(b, homeUrl, 'spaces-home-dark.png', { scheme: 'dark', width: 1200, height: 760 });
    assert.equal(light, LIGHT_BG);
    assert.equal(dark, DARK_BG);
  });
});

// ---------------------------------------------------------------- Files are off

{
  const host = 'none';
  test(`C26 C40: with no host the panel and home say "Files are off", a new space still works, nothing claims "Saved"`, { skip: !bin && 'CHROME is not set', timeout: 300000 }, async (t) => {
    const { b, profile, win } = await launch({ root: os.tmpdir(), host });
    t.after(cleanup(b, profile));
    const panelUrl = `chrome-extension://${b.extId}/sidepanel.html?window=${win}`;
    await b.sw('await chrome.windows.create({ url: args[0], type: "popup", width: 360, height: 640, focused: false });', panelUrl);
    const ui = (expr) => inPage(b, panelUrl, expr);
    await waitFor(async () => assert.equal((await ui('document.querySelector(".files-off")?.textContent || ""')), 'Files are off: Set up'));
    assert.deepEqual(JSON.parse(await ui("JSON.stringify([...document.querySelectorAll('.mega .name')].map((n) => n.textContent))")).slice(0, 4), ['Reading', 'Drafts', 'Archive', 'Writing'], 'the rest keeps working');

    // A new space without the host: the mega tab is made and shown, the line stays
    await ui("document.querySelector('.switcher').click(), true");
    await ui("[...document.querySelectorAll('.menu .item')].find((i) => i.textContent.includes('New space')).click(), true");
    await waitFor(async () => assert.equal(await ui("!!document.querySelector('.menu input.inline')"), true));
    await ui("(() => { const i = document.querySelector('.menu input.inline'); i.value = 'Atlas'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); return true; })()");
    await waitFor(async () => assert.equal(await ui("document.querySelector('.space-head span')?.textContent"), 'Atlas'));
    assert.ok((await b.sw("return (await chrome.storage.local.get('workspaces')).workspaces.map((w) => w.name);")).includes('Atlas · Main'));
    assert.equal(await ui('document.querySelector(".files-off")?.textContent'), 'Files are off: Set up');

    // Set up opens the home page on its install step; Retry says it is still off
    await ui("document.querySelector('.files-off button').click(), true");
    await withPrefix(b, `chrome-extension://${b.extId}/home.html`, async (s) => {
      await waitFor(async () => assert.equal(await evalIn(b, s, "!document.getElementById('setup').hidden"), true));
      assert.match(await evalIn(b, s, "document.getElementById('setup').textContent"), /node install-host\.js/);
      await evalIn(b, s, "document.getElementById('retry').click(), true");
      await waitFor(async () => assert.match(await evalIn(b, s, "document.getElementById('retry-note').textContent"), /Still off/));
      assert.match(await evalIn(b, s, "document.getElementById('files-off').textContent"), /Files are off: Set up/);
      assert.ok(!/Saved/.test(await evalIn(b, s, 'document.body.innerText')), 'home never claims Saved');
      assert.deepEqual(JSON.parse(await evalIn(b, s, "JSON.stringify([...document.querySelectorAll('#tiles .tile:not(.new) .letter')].map((n) => n.textContent))")).slice(0, 1), ['M'], 'letter tiles');
    });
    assert.ok(!/Saved/.test(await ui('document.body.innerText')), 'the panel never claims Saved');
  });
}

test('C26: a host that lacks the ops gives the same line and the panel keeps working', { skip: !bin && 'CHROME is not set', timeout: 300000 }, async (t) => {
  const root = makeRoot({ Me: {} });
  const profile0 = fs.mkdtempSync(path.join(os.tmpdir(), 'megatabs-oldhost-'));
  const old = path.join(profile0, 'old-host.js');
  // The simplest older host: it answers every request with bad-request
  fs.writeFileSync(old, `
const l = Buffer.alloc(4);
let buf = Buffer.alloc(0);
process.stdin.on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32LE(0)) {
    const n = buf.readUInt32LE(0); const m = JSON.parse(buf.subarray(4, 4 + n).toString()); buf = buf.subarray(4 + n);
    const out = Buffer.from(JSON.stringify({ id: m.id, error: 'bad-request', message: 'unknown request' }));
    const h = Buffer.alloc(4); h.writeUInt32LE(out.length); process.stdout.write(Buffer.concat([h, out]));
  }
});
process.stdin.on('end', () => process.exit(0));
`);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'megatabs-spaces-chromium-'));
  const b = new Chromium(bin, profile);
  const wrapper = path.join(profile0, 'launcher');
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec '${process.execPath}' '${old}'\n`, { mode: 0o755 });
  fs.mkdirSync(path.join(profile, 'NativeMessagingHosts'), { recursive: true });
  fs.writeFileSync(path.join(profile, 'NativeMessagingHosts', 'com.megatabs.board.json'), JSON.stringify({
    name: 'com.megatabs.board', description: 'test: a host without the space ops', path: wrapper, type: 'stdio', allowed_origins: [`chrome-extension://${b.extId}/`],
  }));
  await b.launch({ restore: 'newtab' });
  t.after(cleanup(b, profile, null, root, profile0));
  const win = await waitFor(async () => {
    const { windowWs } = await b.sw("return chrome.storage.session.get('windowWs');");
    assert.ok(Object.keys(windowWs || {})[0]);
    return Number(Object.keys(windowWs)[0]);
  });
  const panelUrl = `chrome-extension://${b.extId}/sidepanel.html?window=${win}`;
  await b.sw('await chrome.windows.create({ url: args[0], type: "popup", width: 360, height: 640, focused: false });', panelUrl);
  await waitFor(async () => assert.equal(await inPage(b, panelUrl, 'document.querySelector(".files-off")?.textContent || ""'), 'Files are off: Set up'));
  assert.equal(await inPage(b, panelUrl, "document.querySelectorAll('.mega .name').length >= 4"), true);
});
