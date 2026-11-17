'use strict';
// Edge reveal and Settings in a real Chromium (slice 4 of docs/NEXT-SPEC.md): Settings holds Edge reveal
// (off by default, the side), the auto-backup choice and Export/Import that round-trips (C35, C36); a
// pointer held still in the edge strip shows the mini switcher, a click switches, a real click on "Open
// panel" opens the side panel, and with Edge reveal off nothing is registered and no host permission is
// held (C42); a script in a web page may not ask background.js for anything, and the `mega` port gives it
// only state, show and openPanel (C43).
//
// Every click here is a real mouse event through the DevTools protocol (Input.dispatchMouseEvent), so the
// browser's own user-gesture rules apply: chrome.permissions.request() and sidePanel.open() both need one.
//
// What a test cannot do: answer Chrome's own question for `<all_urls>` ("Read and change all your data on all
// websites"). It is a native dialog, and the request stays pending (tried: a real click, a gesture from
// Runtime.evaluate, --headless=new, --test-type, --enable-automation, Enter and Space). So:
//   1. A browser with the shipped manifest shows what is checkable without the answer: off by default (nothing
//      registered, no host permission), and that the click on the box asks for exactly `<all_urls>` from inside
//      the click.
//   2. Everything that needs the permission to be held runs in a browser loading a COPY of extension/ whose
//      manifest also lists `http://127.0.0.1/*` (as host_permissions and as the optional one), so Chrome holds
//      it from the start. That copy cannot let go of it (Chrome: "You cannot remove required permissions"), so
//      the removal of a granted optional permission is never exercised by any test; the call reaching Chrome is.
//
//   CHROME=<binary> node --test test/edge.chromium.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { Chromium, waitFor, sleep } = require('./chromium');

const bin = process.env.CHROME;
const DOCS = path.join(__dirname, '..', 'docs');
const EXT_DIR = path.join(__dirname, '..', 'extension');
const LIGHT_BG = 'rgb(247, 247, 245)';
const DARK_BG = 'rgb(28, 28, 30)';

// ---------------------------------------------------------------- helpers

// A page that looks like an ordinary article, so the screenshots show the switcher over something real
function startServer() {
  const hits = new Map();
  const server = http.createServer((req, res) => {
    const name = req.url.slice(1) || 'index';
    if (name !== 'favicon.ico') hits.set(name, (hits.get(name) || 0) + 1);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(`<!doctype html><meta charset="utf-8"><title>${name}</title>
<style>body{margin:0;font:17px/1.6 Georgia,serif;color:#222;background:#fff}main{max-width:620px;margin:60px auto;padding:0 24px}
h1{font-size:34px;line-height:1.2;margin:0 0 18px}p{margin:0 0 18px;color:#444}nav{padding:14px 24px;border-bottom:1px solid #eee;font:14px system-ui;color:#888}
@media (prefers-color-scheme:dark){body{background:#151516;color:#ddd}p{color:#b8b8b8}nav{border-color:#2a2a2c}}</style>
<nav>example.test / ${name}</nav><main><h1>How a quiet desk works</h1>
<p>Most of the day is spent in a handful of places. A page that stays open for a week is part of the room, not a tab to hunt for.</p>
<p>Keeping each set of pages together, out of sight until it is needed, leaves the screen calm and the work where it was.</p>
<p>When the answer is a click away, nobody keeps twenty windows open just in case.</p></main>`);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, hits, base: `http://127.0.0.1:${server.address().port}/` })));
}

const evalIn = (b, s, expression, extra = {}) =>
  b.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, ...extra }, s).then((r) => {
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  });

// Sessions of pages, by the start of the address (a page is found fresh every time: ids change on reload)
async function attach(b, match) {
  const t = await waitFor(async () => {
    const { targetInfos } = await b.send('Target.getTargets');
    const x = targetInfos.find((i) => i.type === 'page' && match(i.url));
    if (!x) throw new Error('page not found');
    return x;
  });
  const { sessionId } = await b.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
  return { sessionId, targetId: t.targetId };
}
// A page this test opened itself (s.own) is closed too, so the next one is never found by mistake
const detach = async (b, s) => {
  await b.send('Target.detachFromTarget', { sessionId: s.sessionId }).catch(() => {});
  if (s.own) await b.send('Target.closeTarget', { targetId: s.targetId }).catch(() => {});
};

function extensionCopy() {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'megatabs-edge-ext-'));
  fs.cpSync(EXT_DIR, copy, { recursive: true, filter: (src) => path.basename(src) !== 'board-data' });
  const file = path.join(copy, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(m.optional_host_permissions, ['<all_urls>']);
  m.host_permissions = ['http://127.0.0.1/*'];
  m.optional_host_permissions = ['http://127.0.0.1/*'];
  fs.writeFileSync(file, JSON.stringify(m));
  process.on('exit', () => fs.rmSync(copy, { recursive: true, force: true }));
  return copy;
}

// loopback: the copy of the extension that holds http://127.0.0.1/* from the start (see the top)
async function launch({ loopback = false } = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'megatabs-edge-chromium-'));
  const b = loopback ? new Chromium(bin, profile, extensionCopy()) : new Chromium(bin, profile);
  b.contexts = [];
  const receive = b.receive.bind(b);
  b.receive = (msg) => {
    // The isolated worlds of content scripts, announced after Runtime.enable on a page
    if (msg.method === 'Runtime.executionContextCreated') b.contexts.push({ sessionId: msg.sessionId, ...msg.params.context });
    receive(msg);
  };
  await b.launch({ restore: 'newtab' });
  const win = await waitFor(async () => {
    const { windowWs } = await b.sw("return chrome.storage.session.get('windowWs');");
    const id = Object.keys(windowWs || {})[0];
    assert.ok(id, 'no main window assigned yet');
    return Number(id);
  });
  return { b, profile, win };
}

const cleanup = (b, profile, server) => async () => {
  await b.kill();
  server?.close();
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
};

const mouse = (b, s, type, x, y, extra = {}) =>
  b.send('Input.dispatchMouseEvent', { type, x, y, button: 'none', buttons: 0, ...extra }, s);
const click = async (b, s, x, y) => {
  await mouse(b, s, 'mouseMoved', x, y);
  await mouse(b, s, 'mousePressed', x, y, { button: 'left', buttons: 1, clickCount: 1 });
  await mouse(b, s, 'mouseReleased', x, y, { button: 'left', buttons: 0, clickCount: 1 });
};
const clickEl = async (b, s, selector) => {
  await b.send('Page.bringToFront', {}, s);   // a click on a page behind another window waits several seconds for its answer
  const r = JSON.parse(await evalIn(b, s, `(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 }); })()`));
  await click(b, s, r.x, r.y);
};

// The mini switcher is a closed shadow root: page scripts cannot see into it, the DevTools protocol can.
// null when it is not there; else its texts, the centre of each button and the panel's palette and side.
async function switcher(b, s) {
  // The panel can leave between one protocol call and the next: ask again
  for (let i = 0; ; i++) {
    try {
      return await switcherOnce(b, s);
    } catch (e) {
      if (i >= 3 || !/No node with given id|Could not find node|Cannot find context/.test(e.message)) throw e;
      await sleep(30);
    }
  }
}

async function switcherOnce(b, s) {
  const hosted = await evalIn(b, s, `!!document.documentElement.querySelector(':scope > div[style*="2147483647"]')`);
  if (!hosted) return null;
  const { root } = await b.send('DOM.getDocument', { depth: -1, pierce: true }, s);
  const find = (n, fn) => {
    if (fn(n)) return n;
    for (const c of [...(n.children || []), ...(n.shadowRoots || [])]) {
      const f = find(c, fn);
      if (f) return f;
    }
    return null;
  };
  const shadow = find(root, (n) => n.shadowRootType === 'closed');
  if (!shadow) return null;
  const all = (n, fn, out = []) => {
    if (fn(n)) out.push(n);
    for (const c of [...(n.children || []), ...(n.shadowRoots || [])]) all(c, fn, out);
    return out;
  };
  const attrs = (n) => Object.fromEntries((n.attributes || []).reduce((a, v, i, arr) => (i % 2 ? a : [...a, [v, arr[i + 1]]]), []));
  const textOf = (n) => (n.nodeType === 3 ? n.nodeValue : (n.children || []).map(textOf).join(''));
  const panel = find(shadow, (n) => n.nodeName === 'DIV' && /\bpanel\b/.test(attrs(n).class || ''));
  const style = async (n, expr) => {
    const { object } = await b.send('DOM.resolveNode', { nodeId: n.nodeId }, s);
    const r = await b.send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: `function() { return ${expr}; }`, returnByValue: true }, s);
    return r.result.value;
  };
  const buttons = [];
  for (const n of all(shadow, (x) => x.nodeName === 'BUTTON')) {
    const { model } = await b.send('DOM.getBoxModel', { nodeId: n.nodeId }, s);
    const q = model.content;
    buttons.push({
      text: textOf(n).trim(),
      current: attrs(n)['aria-current'] === 'true',
      x: (q[0] + q[2]) / 2,
      y: (q[1] + q[5]) / 2,
    });
  }
  return {
    head: textOf(find(shadow, (n) => /\bhead\b/.test(attrs(n).class || '')) || { children: [] }).trim(),
    buttons,
    side: /\bright\b/.test(attrs(panel).class) ? 'right' : 'left',
    bg: await style(panel, 'getComputedStyle(this).backgroundColor'),
    fg: await style(panel, 'getComputedStyle(this).color'),
    box: await style(panel, 'JSON.stringify(this.getBoundingClientRect())'),
  };
}

// Waits for the switcher to be there (or gone), and says how long after `since` it took
async function until(b, s, want, since, timeout = 3000) {
  for (;;) {
    const sw = await switcher(b, s);
    if (want ? sw : !sw) return { sw, ms: Date.now() - since };
    if (Date.now() - since > timeout) throw new Error(want ? 'the switcher never came' : 'the switcher never left');
    await sleep(15);
  }
}

// Runs code in the isolated world of the extension's content script in this page, where `chrome.runtime`
// is the script's own
async function inContentScript(b, s, expression) {
  await b.send('Runtime.enable', {}, s.sessionId);
  const ctx = await waitFor(async () => {
    const c = b.contexts.filter((x) => x.sessionId === s.sessionId && x.origin === `chrome-extension://${b.extId}` && x.auxData?.type === 'isolated').at(-1);
    if (!c) throw new Error('no content script in this page');
    return c;
  }, { timeout: 5000 });
  return evalIn(b, s.sessionId, expression, { contextId: ctx.id });
}

const stashIdsOf = (b) => b.sw('return (await chrome.storage.local.get("workspaces")).workspaces.map((w) => ({ id: w.id, name: w.name }));');

// ---------------------------------------------------------------- one browser, in order

test('Shipped manifest: Edge reveal is off by default and the box asks Chrome for <all_urls> from inside the click', { skip: !bin && 'CHROME is not set', timeout: 120000 }, async (t) => {
  const { b, profile } = await launch();
  t.after(cleanup(b, profile));
  const settingsUrl = `chrome-extension://${b.extId}/settings.html`;

  await t.test('manifest: no static content script, no host permission, the optional one is <all_urls>, Chrome 116 or newer, no unlimitedStorage', () => {
    const m = JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf8'));
    assert.equal(m.content_scripts, undefined, 'the script is registered at runtime, never in the manifest');
    assert.equal(m.host_permissions, undefined);
    assert.deepEqual(m.optional_host_permissions, ['<all_urls>'], 'the shipped manifest asks for <all_urls>, and only as an optional permission');
    assert.ok(m.permissions.includes('scripting'));
    assert.equal(m.permissions.includes('unlimitedStorage'), false);
    assert.ok(Number(m.minimum_chrome_version.split('.')[0]) >= 116, 'sidePanel.open() needs Chrome 116');
    assert.equal(m.version, '0.12.0');
    assert.equal(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'kwin', 'metadata.json'), 'utf8')).KPlugin.Version, '0.12.0');
    assert.equal(fs.readFileSync(path.join(EXT_DIR, 'background.js'), 'utf8').match(/importScripts\(([^)]*)\)/)[1].includes('edge'), false, "background.js's list stays as it is");
    assert.equal(fs.readFileSync(path.join(EXT_DIR, 'megatabs.js'), 'utf8').includes("importScripts('edge.js')"), true, 'edge.js is loaded by megatabs.js');
  });

  await t.test('C36, C42: off by default: nothing registered, no host permission held, no setting stored', async () => {
    assert.deepEqual(await b.sw('return (await chrome.scripting.getRegisteredContentScripts()).map((s) => s.id);'), []);
    assert.equal(await b.sw("return chrome.permissions.contains({ origins: ['<all_urls>'] });"), false);
    assert.deepEqual(await b.sw('return (await chrome.permissions.getAll()).origins || [];'), []);
    assert.equal(await b.sw("return (await chrome.storage.local.get('megaEdge')).megaEdge ?? null;"), null);
  });

  await t.test('C36: Settings shows it off, side left, and a real click on the box asks for exactly <all_urls>; until Chrome\'s question is answered nothing is registered', async () => {
    await b.sw('await chrome.windows.create({ url: args[0], type: "popup", width: 760, height: 900, focused: false });', settingsUrl);
    const s = await attach(b, (u) => u === settingsUrl);
    s.own = true;
    try {
      await waitFor(() => evalIn(b, s.sessionId, 'document.readyState === "complete" && !!document.getElementById("auto").options.length || Promise.reject(new Error("loading"))'));
      assert.equal(await evalIn(b, s.sessionId, 'document.getElementById("edge-on").checked'), false);
      assert.equal(await evalIn(b, s.sessionId, 'document.querySelector("input[name=side]:checked").value'), 'left');
      assert.equal(await evalIn(b, s.sessionId, 'document.getElementById("auto").value'), '0', 'automatic backup is never');
      await evalIn(b, s.sessionId, `window.__asked = []; const orig = chrome.permissions.request.bind(chrome.permissions);
        chrome.permissions.request = (r) => { __asked.push({ r, active: navigator.userActivation.isActive }); return orig(r); }; true`);
      await clickEl(b, s.sessionId, '#edge-on');
      await waitFor(async () => assert.equal(await evalIn(b, s.sessionId, 'window.__asked.length'), 1));
      assert.deepEqual(await evalIn(b, s.sessionId, 'window.__asked[0]'), { r: { origins: ['<all_urls>'] }, active: true }, 'asked for <all_urls>, inside the click');
      await sleep(800);
      assert.deepEqual(await b.sw('return (await chrome.scripting.getRegisteredContentScripts()).map((s) => s.id);'), [], 'asking registers nothing');
      assert.equal(await b.sw("return (await chrome.storage.local.get('megaEdge')).megaEdge ?? null;"), null, 'no setting stored before the answer');
    } finally {
      await detach(b, s);
    }
  });
});

test('Edge reveal and Settings: opt-in, the mini switcher, the guard on messages, export that comes back', { skip: !bin && 'CHROME is not set', timeout: 600000 }, async (t) => {
  const { server, hits, base } = await startServer();
  const { b, profile, win } = await launch({ loopback: true });
  t.after(cleanup(b, profile, server));

  const settingsUrl = `chrome-extension://${b.extId}/settings.html`;
  const registered = () => b.sw('return (await chrome.scripting.getRegisteredContentScripts()).map((s) => s.id);');
  const held = () => b.sw('return chrome.permissions.contains({ origins: chrome.runtime.getManifest().optional_host_permissions });');
  const hosts = () => b.sw('return (await chrome.permissions.getAll()).origins || [];');
  const setting = () => b.sw("return (await chrome.storage.local.get('megaEdge')).megaEdge ?? null;");
  const windowWs = () => b.sw('return (await chrome.storage.session.get("windowWs")).windowWs[args[0]];', win);
  const idle = () => waitFor(async () => assert.equal(await b.sw("return !!(await chrome.storage.session.get('pendingSwitch')).pendingSwitch;"), false));

  // The Settings page in a popup window of its own, so a mega tab switch cannot stash it
  const openSettings = async () => {
    await b.sw('await chrome.windows.create({ url: args[0], type: "popup", width: 760, height: 900, focused: false });', settingsUrl);
    const s = await attach(b, (u) => u === settingsUrl);
    s.own = true;
    await waitFor(() => evalIn(b, s.sessionId, 'document.readyState === "complete" && !!document.getElementById("auto").options.length || Promise.reject(new Error("loading"))'));
    return s;
  };
  const note = (s, id) => evalIn(b, s.sessionId, `document.getElementById(${JSON.stringify(id)}).textContent`);

  await t.test('C36, C42: off by default here too: nothing registered, no setting stored; Settings shows it off', async () => {
    assert.deepEqual(await registered(), []);
    assert.equal(await setting(), null);
    assert.equal(await held(), true, 'this copy of the extension holds http://127.0.0.1/* from the start (see the top of the file)');
    const s = await openSettings();
    try {
      assert.equal(await evalIn(b, s.sessionId, 'document.getElementById("edge-on").checked'), false);
      assert.equal(await evalIn(b, s.sessionId, 'document.querySelector("input[name=side]:checked").value'), 'left');
      assert.equal(await evalIn(b, s.sessionId, 'document.getElementById("auto").value'), '0', 'automatic backup is never');
    } finally {
      await detach(b, s);
    }
  });

  // Mega tabs to switch between: two in Me. The window shows an ordinary workspace.
  const mid = {};
  await b.action('(n) => createWs(n)', 'Me · Reading');
  await b.action('(n) => createWs(n)', 'Me · Archive');
  for (const w of await stashIdsOf(b)) mid[w.name] = w.id;
  await idle();

  // An ordinary page, open BEFORE Edge reveal is turned on: it must get the switcher without a reload
  await b.sw('await chrome.tabs.create({ windowId: args[0], url: args[1], active: true });', win, base + 'before');
  await waitFor(async () => assert.ok((await b.sw('return (await chrome.tabs.query({ windowId: args[0] })).some((t) => t.url === args[1] && t.status === "complete");', win, base + 'before'))));
  const pageUrl = base + 'before';

  await t.test('C36, C42: a real click on the Edge reveal box asks Chrome for the permission, registers the script and saves the setting; the page open already gets it', async () => {
    const s = await openSettings();
    try {
      const timeOrigin = await evalIn(b, s.sessionId, 'performance.timeOrigin');
      await clickEl(b, s.sessionId, '#edge-on');
      await waitFor(async () => assert.deepEqual(await registered(), ['megatabs-edge']));
      assert.equal(await held(), true);
      assert.deepEqual(await setting(), { on: true, side: 'left' });
      assert.equal(await evalIn(b, s.sessionId, 'document.getElementById("edge-on").checked'), true);
      assert.match(await note(s, 'edge-note'), /^On\. Rest the pointer at the left edge/);
      assert.equal(await evalIn(b, s.sessionId, 'performance.timeOrigin'), timeOrigin, 'no reload');
    } finally {
      await detach(b, s);
    }
    // The registered script matches web pages only
    const [cs] = await b.sw('return chrome.scripting.getRegisteredContentScripts();');
    assert.deepEqual(cs.matches, ['http://*/*', 'https://*/*']);
    assert.deepEqual(cs.js, ['edge-content.js']);
    assert.equal(cs.allFrames ?? false, false, 'top frame only');
  });

  await t.test('C42: a still pointer for 300 ms in the edge strip shows the switcher; moving resets the wait; not outside the strip', async () => {
    const s = await attach(b, (u) => u === pageUrl);
    try {
      await b.send('Page.bringToFront', {}, s.sessionId);
      await sleep(300);
      // Not outside the strip, however long it rests
      await mouse(b, s.sessionId, 'mouseMoved', 60, 300);
      await sleep(700);
      assert.equal(await switcher(b, s.sessionId), null, 'outside the 6 px strip: nothing');
      // A pointer in the strip, but moving: the wait starts again at every move
      await mouse(b, s.sessionId, 'mouseMoved', 1, 300);
      await sleep(200);
      await mouse(b, s.sessionId, 'mouseMoved', 3, 301);
      const t0 = Date.now();
      await sleep(150);
      assert.equal(await switcher(b, s.sessionId), null, '150 ms after the last move it is not there yet');
      const { sw, ms } = await until(b, s.sessionId, true, t0);
      assert.ok(ms >= 290, `it came ${ms} ms after the pointer came to rest, not 300`);
      assert.ok(ms < 1500, `it came after ${ms} ms`);
      assert.equal(sw.head, 'Me');
      assert.deepEqual(sw.buttons.map((x) => x.text), ['Reading', 'Archive', 'Open panel']);
      assert.equal(sw.side, 'left');
      assert.ok(JSON.parse(sw.box).x < 20, 'on the left edge');
    } finally {
      await detach(b, s);
    }
  });

  await t.test('C42: the pointer leaving for 400 ms or Esc takes it away; the panel palette in light and dark', async () => {
    const s = await attach(b, (u) => u === pageUrl);
    try {
      const sw = await switcher(b, s.sessionId);
      assert.ok(sw, 'still there from the last test');
      assert.equal(sw.bg, LIGHT_BG);
      assert.equal(sw.fg, 'rgb(43, 43, 43)');
      // Away: it waits a moment, then goes
      const away = Date.now();
      await mouse(b, s.sessionId, 'mouseMoved', 700, 500);
      await sleep(150);
      assert.ok(await switcher(b, s.sessionId), '150 ms after the pointer left it is still there');
      const gone = await until(b, s.sessionId, false, away);
      assert.ok(gone.ms >= 350 && gone.ms < 1500, `it left after ${gone.ms} ms`);
      // Dark
      await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] }, s.sessionId);
      await mouse(b, s.sessionId, 'mouseMoved', 2, 300);
      const dark = (await until(b, s.sessionId, true, Date.now())).sw;
      assert.equal(dark.bg, DARK_BG);
      assert.equal(dark.fg, 'rgb(232, 232, 230)');
      await b.send('Emulation.setEmulatedMedia', { features: [] }, s.sessionId);
      // Esc
      await b.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, s.sessionId);
      await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, s.sessionId);
      await until(b, s.sessionId, false, Date.now(), 1500);
    } finally {
      await detach(b, s);
    }
  });

  await t.test('screenshots of the mini switcher, light and dark, over an ordinary page', async () => {
    const s = await attach(b, (u) => u === pageUrl);
    try {
      fs.mkdirSync(DOCS, { recursive: true });
      for (const [scheme, file] of [['light', 'edge-switcher.png'], ['dark', 'edge-switcher-dark.png']]) {
        await b.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 700, deviceScaleFactor: 1, mobile: false }, s.sessionId);
        await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] }, s.sessionId);
        await mouse(b, s.sessionId, 'mouseMoved', 2, 350);
        await until(b, s.sessionId, true, Date.now());
        await sleep(250);   // the fade in
        const r = await b.send('Page.captureScreenshot', { format: 'png' }, s.sessionId);
        fs.writeFileSync(path.join(DOCS, file), Buffer.from(r.data, 'base64'));
        await mouse(b, s.sessionId, 'mouseMoved', 700, 500);
        await until(b, s.sessionId, false, Date.now());
      }
      await b.send('Emulation.setEmulatedMedia', { features: [] }, s.sessionId);
      await b.send('Emulation.clearDeviceMetricsOverride', {}, s.sessionId);
    } finally {
      await detach(b, s);
    }
  });

  await t.test('C42: Settings side change reaches the open page without a reload: the right edge now', async () => {
    const st = await openSettings();
    const s = await attach(b, (u) => u === pageUrl);
    try {
      const pageOrigin = await evalIn(b, s.sessionId, 'performance.timeOrigin');
      await clickEl(b, st.sessionId, 'input[name=side][value=right]');
      await waitFor(async () => assert.deepEqual(await setting(), { on: true, side: 'right' }));
      await waitFor(async () => assert.match(await note(st, 'edge-note'), /right edge/));
      const width = await evalIn(b, s.sessionId, 'document.documentElement.clientWidth');
      await b.send('Page.bringToFront', {}, s.sessionId);
      await mouse(b, s.sessionId, 'mouseMoved', 2, 300);
      await sleep(700);
      assert.equal(await switcher(b, s.sessionId), null, 'the left edge no longer does anything');
      await mouse(b, s.sessionId, 'mouseMoved', width - 2, 300);
      const { sw } = await until(b, s.sessionId, true, Date.now());
      assert.equal(sw.side, 'right');
      assert.ok(JSON.parse(sw.box).x + JSON.parse(sw.box).width > width - 20, 'on the right edge');
      assert.equal(await evalIn(b, s.sessionId, 'performance.timeOrigin'), pageOrigin, 'the page was not reloaded');
      // Back to the left for the rest
      await clickEl(b, st.sessionId, 'input[name=side][value=left]');
      await waitFor(async () => assert.deepEqual(await setting(), { on: true, side: 'left' }));
      await until(b, s.sessionId, false, Date.now());   // a changed side takes it away until the next rest
    } finally {
      await detach(b, s);
      await detach(b, st);
    }
  });

  await t.test('C42: a page opened after it was turned on has the script too; clicking a mega tab switches to it, nothing reloads', async () => {
    await b.sw('await chrome.tabs.create({ windowId: args[0], url: args[1], active: true });', win, base + 'after');
    await waitFor(async () => assert.ok((await b.sw('return (await chrome.tabs.query({ windowId: args[0] })).some((t) => t.url === args[1] && t.status === "complete");', win, base + 'after'))));
    const afterUrl = base + 'after';
    const s = await attach(b, (u) => u === afterUrl);
    try {
      await b.send('Page.bringToFront', {}, s.sessionId);
      await sleep(300);
      assert.ok(await inContentScript(b, s, 'window.__megatabsEdge === true'), 'the registered script ran in the new page');
      const before = { leads: hits.get('before'), after: hits.get('after') };
      const timeOrigin = await evalIn(b, s.sessionId, 'performance.timeOrigin');
      await mouse(b, s.sessionId, 'mouseMoved', 2, 300);
      const { sw } = await until(b, s.sessionId, true, Date.now());
      const leads = sw.buttons.find((x) => x.text === 'Reading');
      assert.ok(leads, 'Reading is listed');
      await click(b, s.sessionId, leads.x, leads.y);
      await waitFor(async () => assert.equal(await windowWs(), mid['Me · Reading']));
      await idle();
      assert.deepEqual({ leads: hits.get('before'), after: hits.get('after') }, before, 'no page was fetched again');
      // Both pages moved out with their mega tab; the window shows Reading, which has no tabs
      const urls = await b.sw('return (await chrome.tabs.query({ windowId: args[0] })).map((t) => t.url || t.pendingUrl);', win);
      assert.ok(!urls.includes(afterUrl), 'the page left with its mega tab');
      const alive = await b.sw('const t = await chrome.tabs.query({ url: args[0] }); return t.map((x) => ({ status: x.status, discarded: x.discarded }));', afterUrl);
      assert.deepEqual(alive, [{ status: 'complete', discarded: false }], 'still loaded in the stash window');
      assert.ok(timeOrigin);
    } finally {
      await detach(b, s);
    }
    // Back to the ordinary workspace for the next tests
    await b.sw('return userAction(() => showWs(args[0], args[1]));', win, await b.sw('return (await chrome.storage.local.get("workspaces")).workspaces[0].id;'));
    await idle();
  });

  await t.test('C43: a script in a web page is refused for every message type; the mega port gives it state, show and openPanel only', async () => {
    const s = await attach(b, (u) => u === pageUrl);
    try {
      await b.send('Page.bringToFront', {}, s.sessionId);
      const bg = fs.readFileSync(path.join(EXT_DIR, 'background.js'), 'utf8');
      const types = [...bg.slice(bg.indexOf('chrome.runtime.onMessage.addListener')).matchAll(/^\s+case '([a-zA-Z]+)':/gm)].map((m) => m[1]);
      assert.ok(types.length > 20 && types.includes('delete') && types.includes('import'), `message types found: ${types}`);
      const before = (await stashIdsOf(b)).length;
      const evil = JSON.parse(await inContentScript(b, s, `(async () => JSON.stringify(await Promise.all(${JSON.stringify(types)}.map(async (type) => [type, await chrome.runtime.sendMessage({ type, wsId: 'x', windowId: 1, name: 'evil', text: '{}', mode: 'replace', confirmed: true, ids: [], patch: {} })]))))()`));
      for (const [type, reply] of evil) assert.deepEqual(reply, { ok: false, error: 'not allowed' }, `${type} from a web page`);
      assert.equal((await stashIdsOf(b)).length, before, 'no workspace was created or deleted');
      assert.equal(await b.sw('return (await chrome.storage.local.get("deleted")).deleted === undefined;'), true);
      // An extension page is not affected by the guard
      const own = await openSettings();
      try {
        assert.equal(await evalIn(b, own.sessionId, 'chrome.runtime.sendMessage({ type: "autoBackupState" }).then((r) => r.ok)'), true);
      } finally {
        await detach(b, own);
      }
      // The port: only three types, the rest named "not allowed"
      const port = (type, args = {}) => `new Promise((ok) => { const p = chrome.runtime.connect({ name: 'mega' }); p.onMessage.addListener((m) => { p.disconnect(); ok(m); }); p.onDisconnect.addListener(() => ok({ gone: true })); p.postMessage({ id: 7, type: ${JSON.stringify(type)}, ...${JSON.stringify(args)} }); })`;
      for (const type of ['spaces', 'cover', 'putCover', 'switchSpace', 'newSpace', 'renameSpace', 'setEdge', 'edgeState', 'delete', 'import', 'nope']) {
        const r = await inContentScript(b, s, port(type, { space: 'Me', name: 'evil', on: true, wsId: 'x', data: 'x', to: 'evil' }));
        assert.deepEqual(r, { id: 7, ok: false, error: 'not allowed' }, `${type} over the port from a web page`);
      }
      assert.deepEqual((await stashIdsOf(b)).length, before);
      assert.equal(await held(), true, 'setEdge from a page did not touch the permission');
      // state: only the current space's mega tabs, no counts, titles or addresses, and for its own window
      const st = await inContentScript(b, s, port('state', { windowId: 999999 }));
      assert.equal(st.ok, true);
      assert.deepEqual(Object.keys(st.result).sort(), ['megas', 'space']);
      assert.equal(st.result.space, 'Me');
      assert.deepEqual(st.result.megas.map((m) => [m.name, m.current]), [['Reading', false], ['Archive', false]]);
      assert.deepEqual(Object.keys(st.result.megas[0]).sort(), ['current', 'id', 'name']);
      // show: allowed (and acts on the page's own window, whatever windowId it names)
      const sh = await inContentScript(b, s, port('show', { wsId: mid['Me · Archive'], windowId: 999999 }));
      assert.equal(sh.ok, true, JSON.stringify(sh));
      await waitFor(async () => assert.equal(await windowWs(), mid['Me · Archive']));
      await idle();
      await b.sw('return userAction(() => showWs(args[0], args[1]));', win, await b.sw('return (await chrome.storage.local.get("workspaces")).workspaces[0].id;'));
      await idle();
    } finally {
      await detach(b, s);
    }
  });

  await t.test('C42: a real click on "Open panel" in the switcher opens the side panel (or: Chrome refuses it, said here)', async (tt) => {
    const s = await attach(b, (u) => u === pageUrl);
    try {
      await b.send('Page.bringToFront', {}, s.sessionId);
      const panels = () => b.sw("return (await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] })).length;");
      assert.equal(await panels(), 0, 'no side panel open yet');
      await mouse(b, s.sessionId, 'mouseMoved', 2, 300);
      const { sw } = await until(b, s.sessionId, true, Date.now());
      const open = sw.buttons.find((x) => x.text === 'Open panel');
      await click(b, s.sessionId, open.x, open.y);
      await waitFor(async () => assert.equal(await panels(), 1, 'the side panel did not open'), { timeout: 8000 }).catch((e) => {
        tt.diagnostic('Chrome refused sidePanel.open() for this click: ' + e.message);
        throw e;
      });
      assert.equal((await switcher(b, s.sessionId)), null, 'the switcher leaves after the click');
      const ctx = await b.sw("return (await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] })).map((c) => c.documentUrl);");
      assert.ok(ctx[0].includes('sidepanel.html'), ctx[0]);
      // Close it again: a second real click is not needed here
      await b.sw('await chrome.sidePanel.close({ windowId: args[0] });', win);
    } finally {
      await detach(b, s);
    }
  });

  await t.test('C36: automatic backup is saved and takes effect without a reload', async () => {
    const s = await openSettings();
    try {
      const timeOrigin = await evalIn(b, s.sessionId, 'performance.timeOrigin');
      const choose = (v) => evalIn(b, s.sessionId, `(() => { const e = document.getElementById('auto'); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('change', { bubbles: true })); return e.value; })()`);
      assert.deepEqual(await evalIn(b, s.sessionId, '[...document.getElementById("auto").options].map((o) => o.textContent)'), ['Never', 'Every day', 'Every week']);
      await choose('1');
      await waitFor(async () => assert.equal(await b.sw("return (await chrome.storage.local.get('autoBackup')).autoBackup;"), 1));
      assert.ok(await b.sw("return !!(await chrome.alarms.get('autoBackup'));"), 'the hourly check is set');
      await waitFor(async () => assert.match(await note(s, 'auto-note'), /Kept in Downloads\/helium-workspaces\. Files kept: 10\./));
      await choose('0');
      await waitFor(async () => assert.equal(await b.sw("return (await chrome.storage.local.get('autoBackup')).autoBackup;"), 0));
      assert.equal(await b.sw("return !!(await chrome.alarms.get('autoBackup'));"), false);
      assert.equal(await evalIn(b, s.sessionId, 'performance.timeOrigin'), timeOrigin, 'no reload');
    } finally {
      await detach(b, s);
    }
  });

  await t.test('C35: Export mega tabs writes one file that Import brings back to the same spaces and addresses', async () => {
    // Mega tabs with addresses: shown, stashed and saved ones
    await b.sw('return applyMegaTabs(args[0]);', [
      { space: 'Me', mega: 'Reading', urls: [base + 'l1', base + 'l2'] },
      { space: 'Me', mega: 'Archive', urls: [base + 'c1'] },
      { space: 'Satellite', mega: 'Main', urls: [base + 's1', base + 's2', base + 's3'] },
    ]);
    // Mega tabs by name with their web addresses (empty new-tab pages are no content). The panel opened earlier
    // has seeded the Me starter mega tabs too: they are part of the round trip as well.
    const shape = (data) => Object.fromEntries(data.workspaces.filter((w) => / · /.test(w.name)).map((w) => [w.name, w.tabs.map((x) => x.url).filter((u) => /^https?:/.test(u)).sort()]));
    const mine = {
      'Me · Reading': [base + 'l1', base + 'l2'],
      'Me · Archive': [base + 'c1'],
      'Satellite · Main': [base + 's1', base + 's2', base + 's3'],
    };
    const expected = { 'Me · Drafts': [], 'Me · Writing': [], ...mine };
    const downloads = path.join(profile, 'Downloads');
    const s = await openSettings();
    try {
      await clickEl(b, s.sessionId, '#export');
      const file = await waitFor(async () => {
        const f = fs.existsSync(downloads) ? fs.readdirSync(downloads).find((n) => /^mega-tabs-\d{4}-\d\d-\d\d\.json$/.test(n)) : null;
        assert.ok(f, 'no export file yet');
        return path.join(downloads, f);
      });
      const exported = await waitFor(async () => JSON.parse(fs.readFileSync(file, 'utf8')));
      assert.deepEqual(shape(exported), expected, 'the file holds every space and address');
      assert.ok(Object.keys(mine).every((n) => exported.workspaces.some((w) => w.name === n)));
      assert.match(await note(s, 'data-note'), /^Saved mega-tabs-\d{4}-\d\d-\d\d\.json: \d+ mega tabs, \d+ tabs\.$/);

      // Lose two of the three mega tabs, then bring them back from the file through the page's own Import
      for (const n of ['Me · Archive', 'Satellite · Main']) {
        const id = (await stashIdsOf(b)).find((w) => w.name === n).id;
        await b.action('(id) => deleteWs(id)', id);
      }
      assert.deepEqual((await stashIdsOf(b)).map((w) => w.name).filter((n) => / · /.test(n)).sort(), ['Me · Drafts', 'Me · Reading', 'Me · Writing']);
      const { root } = await b.send('DOM.getDocument', { depth: 1 }, s.sessionId);
      const { nodeId } = await b.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#file' }, s.sessionId);
      await b.send('DOM.setFileInputFiles', { nodeId, files: [file] }, s.sessionId);
      await waitFor(async () => assert.match(await note(s, 'data-note'), /^Added 2 mega tabs and \d+ tabs from mega-tabs-/));
      const again = await b.sw('return exportAll();');
      assert.deepEqual(shape(again), expected, 'the same spaces and addresses after the round trip');
      assert.deepEqual((await stashIdsOf(b)).map((w) => w.name).filter((n) => / · /.test(n)).sort(), Object.keys(expected).sort());
      // Importing the same file again changes nothing
      await b.send('DOM.setFileInputFiles', { nodeId, files: [file] }, s.sessionId);
      await waitFor(async () => assert.match(await note(s, 'data-note'), /^Nothing to add/));
      assert.deepEqual(shape(await b.sw('return exportAll();')), expected);
      // A file that is not an export is refused with a plain line, and nothing changes
      fs.writeFileSync(path.join(profile, 'junk.json'), '{"hello": 1}');
      await b.send('DOM.setFileInputFiles', { nodeId, files: [path.join(profile, 'junk.json')] }, s.sessionId);
      await waitFor(async () => assert.match(await note(s, 'data-note'), /^Could not import: /));
      assert.deepEqual(shape(await b.sw('return exportAll();')), expected);
    } finally {
      await detach(b, s);
    }
  });

  await t.test('screenshots of Settings, light and dark (Edge reveal on)', async () => {
    const s = await openSettings();
    try {
      fs.mkdirSync(DOCS, { recursive: true });
      for (const [scheme, file, bg] of [['light', 'settings.png', LIGHT_BG], ['dark', 'settings-dark.png', DARK_BG]]) {
        await b.send('Emulation.setDeviceMetricsOverride', { width: 860, height: 720, deviceScaleFactor: 1, mobile: false }, s.sessionId);
        await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] }, s.sessionId);
        await evalIn(b, s.sessionId, 'document.activeElement?.blur(), true');
        await sleep(250);
        assert.equal(await evalIn(b, s.sessionId, 'getComputedStyle(document.body).backgroundColor'), bg);
        const r = await b.send('Page.captureScreenshot', { format: 'png' }, s.sessionId);
        fs.writeFileSync(path.join(DOCS, file), Buffer.from(r.data, 'base64'));
      }
      await b.send('Emulation.setEmulatedMedia', { features: [] }, s.sessionId);
      await b.send('Emulation.clearDeviceMetricsOverride', {}, s.sessionId);
    } finally {
      await detach(b, s);
    }
  });

  await t.test('C42: the setting and the registration survive an extension reload; if the permission is gone at a start, the setting turns itself off', async () => {
    await b.sw('chrome.runtime.reload();').catch(() => {});
    await b.attachWorker();
    await waitFor(async () => assert.deepEqual(await registered(), ['megatabs-edge']));
    assert.deepEqual(await setting(), { on: true, side: 'left' });
    // Chrome will not take away the permission of this copy (it is a required one), so "the permission is
    // gone" is staged by making the check say so: what edgeSync does then is the real code
    await b.sw('globalThis.__held = edgeHasPermission; edgeHasPermission = async () => false; await edgeSync(); edgeHasPermission = globalThis.__held; return true;');
    assert.deepEqual(await registered(), [], 'no script is left registered');
    assert.deepEqual(await setting(), { on: false, side: 'left' }, 'the setting is off, the side kept');
  });

  await t.test('C36, C42: Edge reveal switched on again and then off from Settings: nothing registered, the open page stops showing it, a page opened now never has it', async () => {
    const st = await openSettings();
    const s = await attach(b, (u) => u === pageUrl);
    try {
      await clickEl(b, st.sessionId, '#edge-on');
      await waitFor(async () => assert.deepEqual(await registered(), ['megatabs-edge']));
      await b.send('Page.bringToFront', {}, s.sessionId);
      await sleep(300);
      await mouse(b, s.sessionId, 'mouseMoved', 2, 300);
      await until(b, s.sessionId, true, Date.now());
      await mouse(b, s.sessionId, 'mouseMoved', 700, 500);
      await until(b, s.sessionId, false, Date.now());
      // Off
      await clickEl(b, st.sessionId, '#edge-on');
      await waitFor(async () => assert.deepEqual(await registered(), []));
      assert.deepEqual(await setting(), { on: false, side: 'left' });
      // The last step asks Chrome to drop the host permission. This copy holds it as a required one, which Chrome
      // refuses; the page says so. (With the shipped optional <all_urls> there is nothing to refuse: see the top.)
      await waitFor(async () => assert.match(await note(st, 'edge-note'), /You cannot remove required permissions/));
      assert.equal(await evalIn(b, st.sessionId, 'document.getElementById("edge-on").checked'), false, 'the box shows what is true');
      // The page that has the script keeps no listener alive: the pointer at the edge does nothing
      await b.send('Page.bringToFront', {}, s.sessionId);
      await mouse(b, s.sessionId, 'mouseMoved', 2, 300);
      await sleep(800);
      assert.equal(await switcher(b, s.sessionId), null);
      // A page opened now does not get the script at all
      await b.sw('await chrome.tabs.create({ windowId: args[0], url: args[1], active: true });', win, base + 'off');
      await waitFor(async () => assert.ok((await b.sw('return (await chrome.tabs.query({ windowId: args[0] })).some((t) => t.url === args[1] && t.status === "complete");', win, base + 'off'))));
      const o = await attach(b, (u) => u === base + 'off');
      try {
        await b.send('Page.bringToFront', {}, o.sessionId);
        await sleep(300);
        await mouse(b, o.sessionId, 'mouseMoved', 2, 300);
        await sleep(800);
        assert.equal(await switcher(b, o.sessionId), null);
        await assert.rejects(inContentScript(b, o, '1'), /no content script/);
      } finally {
        await detach(b, o);
      }
    } finally {
      await detach(b, s);
      await detach(b, st);
    }
  });

  assert.deepEqual(b.errors, [], 'no unhandled error in the service worker');
});
