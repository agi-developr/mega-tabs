'use strict';
// C51 and C52 in a real Chromium (Chrome for Testing): the Canvas room's 2D/3D switch (3d-force-graph draws the same
// .canvas file; orbit; a click opens the note in Notes; nothing is written unless he moves something) and a file card that
// points at a .glb/.gltf in the space folder, drawn with three.js in the card and in the 3D view.
//
//   CHROME=<binary> node --test test/three.chromium.test.js
//
// Files live in temp folders; the real ~/Spaces is never touched. The native host is installed into the TEST profile only.
// Screenshots (light and dark) go to docs/ and are looked at, not only taken.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { Chromium, EXT, waitFor, sleep } = require('./chromium');
const { install } = require('../install-host');

const bin = process.env.CHROME;
const skip = !bin && 'CHROME is not set';
const SPACE = 'Me';
const FIX = path.join(__dirname, 'fixtures');
const DOCS = path.join(__dirname, '..', 'docs');

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

// Chrome for Testing on a copy of the extension, a temp stand-in for ~/Spaces with the native host installed for it
async function start(t, { build, hash = '' } = {}) {
  const server = await startServer();
  const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'megatabs-ext-'));
  fs.cpSync(EXT, ext, { recursive: true });
  fs.rmSync(path.join(ext, 'board-data'), { recursive: true, force: true });
  const spaces = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'megatabs-spaces-')));
  fs.mkdirSync(path.join(spaces, SPACE), { recursive: true });
  build?.(path.join(spaces, SPACE), spaces, server.base);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'megatabs-chromium-'));
    const b = new Chromium(bin, profile, ext);
  install({ id: b.extId, manifestDir: path.join(profile, 'NativeMessagingHosts'), wrapperDir: path.join(profile, 'board-host'), spaces });
  await b.launch({ restore: 'newtab' });
  const win = await waitFor(async () => {
    const { windowWs } = await b.sw("return chrome.storage.session.get('windowWs');");
    const id = Object.keys(windowWs || {})[0];
    assert.ok(id, 'no main window assigned yet');
    return Number(id);
  });
  t.after(async () => {
    await b.kill();
    server.server.close();
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    fs.rmSync(ext, { recursive: true, force: true });
    fs.rmSync(spaces, { recursive: true, force: true });
  });
  const base = `chrome-extension://${b.extId}/board.html?space=${SPACE}`;
  await b.sw('await chrome.tabs.create({ windowId: args[0], url: args[1], active: true });', win, base + hash);
  const page = (fn) => withPrefix(b, base, async (s) => {
    await b.send('Emulation.setFocusEmulationEnabled', { enabled: true }, s);
    return fn(s);
  });
  const ev = (expr) => page(async (s) => {
    const r = await b.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, s);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  });
  const x = {
    b, spaces, dir: path.join(spaces, SPACE), server, base, ev, page,
    disk: (n) => fs.readFileSync(path.join(spaces, SPACE, n), 'utf8'),
    count: (sel) => ev(`document.querySelectorAll(${JSON.stringify(sel)}).length`),
    box: async (sel) => JSON.parse(await ev(`(() => { const r = document.querySelector(${JSON.stringify(sel)})?.getBoundingClientRect(); return r ? JSON.stringify({ x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 }) : 'null'; })()`)),
    click: (p, hoverMs = 0) => page(async (s) => {
      await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none', buttons: 0 }, s);
      if (hoverMs) await sleep(hoverMs);
      await b.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1 }, s);
      await b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', buttons: 0, clickCount: 1 }, s);
    }),
    drag: (from, to, steps = 10) => page(async (s) => {
      const m = (type, px, py) => b.send('Input.dispatchMouseEvent', { type, x: px, y: py, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 }, s);
      await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, button: 'none', buttons: 0 }, s);
      await m('mousePressed', from.x, from.y);
      for (let i = 1; i <= steps; i++) await m('mouseMoved', from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
      await m('mouseReleased', to.x, to.y);
    }),
    wheel: (p, deltaY) => page((s) => b.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: p.x, y: p.y, deltaX: 0, deltaY }, s)),
    room: async (name) => {
      await waitFor(async () => {
        await ev(`document.querySelector('#room-${name}').click(), true`);
        assert.equal(await ev(`document.querySelector('#room-${name}').getAttribute('aria-selected')`), 'true');
      });
    },
    // the 3D view's numbers (null while it is not on screen)
    three: () => ev(`JSON.stringify(canvasHandle?.three()?.stats() ?? null)`).then((v) => JSON.parse(v)),
    settled: async () => waitFor(async () => {
      const s = await x.three();
      assert.ok(s?.settled && s.nodes > 0, `the 3D layout has not settled: ${JSON.stringify(s)}`);
      return s;
    }, { timeout: 30000 }),
    // where a card's node is on the page, in px
    nodeAt: async (id) => {
      const c = await x.box('.cv-3d');
      const p = JSON.parse(await ev(`JSON.stringify(canvasHandle.three().screenOf(${JSON.stringify(id)}))`));
      return { x: c.x + p.x, y: c.y + p.y };
    },
    shot: (scheme, file, { width = 1200, height = 760 } = {}) => page(async (s) => {
      await x.b.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, s);
      await x.b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] }, s);
      await sleep(900);
      const r = await x.b.send('Page.captureScreenshot', { format: 'png' }, s);
      await x.b.send('Emulation.setEmulatedMedia', { features: [] }, s);
      await x.b.send('Emulation.clearDeviceMetricsOverride', {}, s);
      const png = Buffer.from(r.data, 'base64');
      fs.writeFileSync(path.join(DOCS, file), png);
      assert.equal(png.readUInt32BE(16), width);
    }),
  };
  return x;
}

const T = (id, x, y, text, extra = {}) => ({ id, type: 'text', x, y, width: 240, height: 100, text, ...extra });
const FILE = (id, x, y, file, extra = {}) => ({ id, type: 'file', x, y, width: 260, height: 72, file, ...extra });
const writeCanvas = (dir, name, doc) => fs.writeFileSync(path.join(dir, name), JSON.stringify(doc, null, '\t'));
const copyFix = (dir, from, to = from) => fs.copyFileSync(path.join(FIX, from), path.join(dir, to));

// A small calm board for the 3D view: texts, notes, a link, a group, edges
const BOARD = () => ({
  nodes: [
    { id: 'g1', type: 'group', x: -40, y: -60, width: 700, height: 340, label: 'This week' },
    T('t1', 0, 0, '# Call the three gardens\n\nThe ones that answered last week.'),
    T('t2', 340, 0, 'Draft the first cold email', { color: '4' }),
    FILE('n1', 0, 180, 'README.md'),
    FILE('n2', 340, 180, 'Calc sheet.md'),
    { id: 'l1', type: 'link', x: 680, y: 80, width: 260, height: 72, url: 'https://example.com/motels' },
  ],
  edges: [
    { id: 'e1', fromNode: 't1', fromSide: 'right', toNode: 't2', toSide: 'left' },
    { id: 'e2', fromNode: 't1', fromSide: 'bottom', toNode: 'n1', toSide: 'top' },
    { id: 'e3', fromNode: 't2', fromSide: 'bottom', toNode: 'n2', toSide: 'top' },
    { id: 'e4', fromNode: 't2', fromSide: 'right', toNode: 'l1', toSide: 'left' },
  ],
});
const buildBoard = (dir) => {
  fs.writeFileSync(path.join(dir, 'README.md'), '# Me space\n\nThe space for the reading project.\n');
  fs.writeFileSync(path.join(dir, 'Calc sheet.md'), '# Calc sheet\n\nThe first ten seconds decide the talk.\n');
  writeCanvas(dir, 'Board.canvas', BOARD());
};

// What the page asked the storage for since the spy went in
const spy = (x) => x.ev(`(() => { window.__asked = []; const o = store.call.bind(store); store.call = (t, a) => (window.__asked.push(t), o(t, a)); return true; })()`);
const asked = async (x) => JSON.parse(await x.ev('JSON.stringify(window.__asked)'));
const WRITES = ['write', 'create', 'trash', 'untrash', 'rename', 'putcover', 'mkspace', 'renamespace'];
const fileState = (file) => {
  const st = fs.statSync(file);
  return JSON.stringify([fs.readFileSync(file, 'utf8'), st.ino, st.mtimeMs]);
};
// the drawn picture of a model card: how much of it is not transparent, and a fingerprint of its pixels
const picture = async (x, file) => JSON.parse(await x.ev(`(() => {
  const c = document.querySelector('.cv-model[data-file="${file}"] .cv-model-view canvas');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let on = 0, h = 0;
  for (let i = 0; i < d.length; i += 4) { if (d[i + 3] > 16) on++; h = (h * 31 + d[i] + d[i + 1] * 3 + d[i + 2] * 7 + d[i + 3]) >>> 0; }
  return JSON.stringify({ w: c.width, h: c.height, on: on / (d.length / 4), h });
})()`));
const press = (x, k, code) => x.page(async (s) => {
  await x.b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, text: k.length === 1 ? k : undefined }, s);
  await x.b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code }, s);
});
const switchTo = async (x, v) => {
  const b = await x.box(`[data-view-button="${v}"]`);
  await x.click({ x: b.cx, y: b.cy });
};
// Runs fn with the page in a color scheme (the override lives as long as the session that set it)
const inScheme = (x, value, fn) => x.page(async (s) => {
  await x.b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value }] }, s);
  try {
    return await fn();
  } finally {
    await x.b.send('Emulation.setEmulatedMedia', { features: [] }, s);
  }
});
// The storage is connected: only then can the spy go in
const connected = (x) => waitFor(async () => assert.equal(await x.ev(`store?.kind`), 'host'));

// ---------------------------------------------------------------------------------------------------------------
// C51: the 3D view of the same canvas
// ---------------------------------------------------------------------------------------------------------------

test('C51: the Canvas room has a quiet 2D/3D switch; 3D draws the same .canvas file with 3d-force-graph: cards are nodes, edges stay edges, orbit, click opens the note in Notes, nothing is written', { skip, timeout: 400000 }, async (t) => {
  const x = await start(t, { build: buildBoard });
  await connected(x);
  await spy(x);
  await x.room('canvas');
  await waitFor(async () => assert.equal(await x.count('.react-flow__node'), 6));
  const file = path.join(x.dir, 'Board.canvas');
  const before = fileState(file);
  const origin = await x.ev('performance.timeOrigin');

  await t.test('the switch is two plain words in the toolbar, 2D open; the 3D code is not even loaded until it is used', async () => {
    assert.deepEqual(JSON.parse(await x.ev(`JSON.stringify([...document.querySelectorAll('.cv-view-btn')].map((b) => [b.textContent, b.getAttribute('aria-pressed')]))`)), [['2D', 'true'], ['3D', 'false']]);
    assert.equal(await x.ev('typeof globalThis.MegatabsThree'), 'undefined', 'canvas3d.js is not loaded for the flat canvas');
    assert.equal(await x.ev(`!![...document.scripts].find((s) => s.src.endsWith('vendor/canvas3d.js'))`), false);
    assert.equal(await x.ev(`document.querySelector('.cv-view').getAttribute('aria-label')`), 'View');
    assert.equal(await x.ev('canvasHandle.view()'), '2d');
  });

  await t.test('3D: the same file as a graph: one node per card, one edge per edge, the flat canvas hidden and its tools gone, WebGL drawing the pane', async () => {
    await switchTo(x, '3d');
    await waitFor(async () => assert.equal(await x.count('.cv-3d canvas'), 1), { timeout: 15000 });
    const s = await x.settled();
    assert.equal(s.nodes, 6, 'six cards: two texts, two notes, a link, a group');
    assert.equal(s.links, 4, 'four edges');
    assert.equal(await x.ev('canvasHandle.view()'), '3d');
    assert.equal(await x.ev(`document.querySelector('[data-view-button="3d"]').getAttribute('aria-pressed')`), 'true');
    assert.equal(await x.ev(`getComputedStyle(document.querySelector('.cv-2d')).visibility`), 'hidden', 'the flat canvas is hidden');
    assert.equal(await x.count('[data-tool-button]'), 0, 'no pen, eraser or card tool in 3D');
    const c = await x.box('.cv-3d canvas');
    assert.ok(c.w > 600 && c.h > 500, 'the scene fills the pane: ' + JSON.stringify(c));
    assert.equal(await x.ev(`!!document.querySelector('.cv-3d canvas').getContext('webgl2')`), true, 'a WebGL2 canvas');
    assert.equal(await x.ev(`document.querySelector('.cv-3d').getAttribute('aria-label').startsWith('3D view of this canvas')`), true, 'the scene has a name for a screen reader');
  });

  await t.test('orbit: dragging on the scene turns the camera round, the wheel brings it nearer; neither writes anything', async () => {
    await sleep(900); // the camera eases to fit the graph when the layout settles
    const c = await x.box('.cv-3d canvas');
    const s0 = await x.three();
    await x.drag({ x: c.x + 120, y: c.y + c.h - 90 }, { x: c.x + 330, y: c.y + c.h - 150 });
    await sleep(600);
    const s1 = await x.three();
    const dist = (st) => Math.hypot(...st.camera.map((v, i) => v - st.target[i])); // from the point it turns around
    const moved = Math.hypot(...s1.camera.map((v, i) => v - s0.camera[i]));
    assert.ok(moved > 20, 'the camera went round: ' + moved);
    assert.ok(Math.abs(dist(s1) - dist(s0)) < dist(s0) * 0.05, 'turning keeps the distance');
    await x.wheel({ x: c.cx, y: c.cy }, -400);
    await sleep(600);
    const s2 = await x.three();
    assert.ok(dist(s2) < dist(s1) - 10, `the wheel zoomed in: ${dist(s1)} -> ${dist(s2)}`);
  });

  await t.test('nothing is written: a drag that starts on a node, and the keys of the flat tools, left the file byte for byte, same inode and time; the page asked the storage only to read', async () => {
    const n = await x.nodeAt('t1');
    await x.drag(n, { x: n.x + 120, y: n.y + 40 });
    for (const [k, code] of [['t', 'KeyT'], ['p', 'KeyP'], ['Backspace', 'Backspace']]) await press(x, k, code);
    await sleep(1500);
    assert.equal(fileState(file), before, 'the file is untouched');
    const calls = await asked(x);
    assert.ok(!calls.some((c) => WRITES.includes(c)), 'asked: ' + calls.join(','));
    assert.equal((await x.three()).nodes, 6, 'no card was added or removed');
    assert.equal(await x.ev('performance.timeOrigin'), origin, 'no reload');
  });

  await t.test('an outside edit (the AI adds a card and an edge) shows in the open 3D view within a few seconds, no reload', async () => {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    doc.nodes.push(T('t3', 0, 360, 'A card the AI added'));
    doc.edges.push({ id: 'e5', fromNode: 'n1', toNode: 't3' });
    fs.writeFileSync(file, JSON.stringify(doc, null, '\t'));
    await waitFor(async () => {
      const s = await x.three();
      assert.deepEqual([s.nodes, s.links], [7, 5]);
    }, { timeout: 6000 });
    assert.equal(await x.ev('performance.timeOrigin'), origin);
  });

  await t.test('click a node: a note card opens that note in Notes (address #README.md)', async () => {
    await x.settled();
    await sleep(500);
    const n = await x.nodeAt('n1');
    const again = await x.nodeAt('n1');
    assert.ok(Math.hypot(n.x - again.x, n.y - again.y) < 1, 'the node is not moving under the pointer');
    await x.click(n, 300);
    await waitFor(async () => assert.equal(await x.ev('room'), 'notes'), { timeout: 5000 });
    await waitFor(async () => assert.equal(await x.ev(`document.querySelector('#doc .md h1')?.textContent`), 'Me space'));
    assert.equal(await x.ev('decodeURIComponent(location.hash)'), '#README.md');
    assert.equal(await x.ev('performance.timeOrigin'), origin);
  });

  await t.test('back in Canvas the room opens flat again (3D is a choice, not a state that sticks) and its scene is gone, not running in the background', async () => {
    await x.room('canvas');
    await waitFor(async () => assert.equal(await x.count('.react-flow__node'), 7));
    assert.equal(await x.ev('canvasHandle.view()'), '2d');
    assert.equal(await x.three(), null);
    assert.equal(await x.count('.cv-3d'), 0);
  });

  await t.test('a text card click flies the camera to it and opens nothing; no request left the extension; the file still holds the AI\'s card and was never written', async () => {
    await switchTo(x, '3d');
    await x.settled();
    await sleep(500);
    const s0 = await x.three();
    await x.click(await x.nodeAt('t2'), 300);
    await sleep(1100);
    const s1 = await x.three();
    assert.ok(Math.hypot(...s1.camera.map((v, i) => v - s0.camera[i])) > 5, 'the camera flew to the card');
    assert.equal(await x.ev('room'), 'canvas', 'a text card opens nothing else');
    const res = JSON.parse(await x.ev(`JSON.stringify(performance.getEntriesByType('resource').map((r) => r.name).filter((n) => !n.startsWith('chrome-extension://')))`));
    assert.deepEqual(res, [], 'nothing left the extension');
    assert.deepEqual([...x.server.hits.keys()], [], 'the test server saw no request');
    assert.ok(fileState(file).includes('A card the AI added'));
    assert.ok(!(await asked(x)).some((c) => WRITES.includes(c)));
  });

  await t.test('the policy of the page still forbids every connection and medium; blob: is allowed for images only (a model\'s own pictures), never for scripts or connections', async () => {
    const csp = await x.ev(`document.querySelector('meta[http-equiv="Content-Security-Policy"]').content`);
    for (const want of ["connect-src 'none'", "media-src 'none'", "script-src 'self'", "img-src 'self' data: blob:", "frame-src 'none'", "object-src 'none'"]) assert.ok(csp.includes(want), `${want} in ${csp}`);
    assert.doesNotMatch(csp, /unsafe-eval|https?:|\*/);
  });

  await t.test('light and dark: the scene follows the system and is calm in both (screenshots in docs/)', async () => {
    const room = `getComputedStyle(document.querySelector('.cv-3d')).backgroundImage`;
    const dark = await inScheme(x, 'dark', async () => {
      await waitFor(async () => assert.equal((await x.three()).dark, true));
      return x.ev(room);
    });
    const light = await inScheme(x, 'light', async () => {
      await waitFor(async () => assert.equal((await x.three()).dark, false));
      return x.ev(room);
    });
    assert.notEqual(dark, light, 'the room changes color with the scheme');
    await x.settled();
    await x.ev('canvasHandle.three().fit(), true');
    await sleep(1500);
    await x.shot('light', 'canvas-3d.png');
    await x.shot('dark', 'canvas-3d-dark.png');
    assert.ok(fileState(file).includes('A card the AI added'), 'still the same canvas');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// C52: a file card that points at a .glb/.gltf
// ---------------------------------------------------------------------------------------------------------------

const MODELS = () => ({
  nodes: [
    T('intro', 0, 0, '# The vase\n\nOne model, drawn in its card.', { width: 240, height: 110 }),
    FILE('m1', 300, -60, 'vase.glb', { width: 300, height: 280 }),
    FILE('m2', 660, -60, 'Reading/vase.gltf', { width: 300, height: 280 }),
    FILE('bad', 0, 180, 'fake.glb', { width: 260, height: 170 }),
    FILE('gone', 0, 380, 'ghost.glb', { width: 260, height: 170 }),
    FILE('n1', 300, 260, 'README.md'),
  ],
  edges: [
    { id: 'e1', fromNode: 'intro', fromSide: 'right', toNode: 'm1', toSide: 'left' },
    { id: 'e2', fromNode: 'm1', fromSide: 'right', toNode: 'm2', toSide: 'left' },
  ],
});
const buildModels = (dir) => {
  fs.mkdirSync(path.join(dir, 'Reading'));
  fs.writeFileSync(path.join(dir, 'README.md'), '# Me space\n\nThe space.\n');
  copyFix(dir, 'vase.glb');
  copyFix(dir, 'vase.gltf', path.join('Reading', 'vase.gltf'));
  fs.writeFileSync(path.join(dir, 'fake.glb'), 'this is a text file, not a model');
  writeCanvas(dir, 'Models.canvas', MODELS());
};

test('C52: a file card that points at a .glb or .gltf in the space folder renders the model with three.js in the card (turn it by dragging) and in the 3D view; read only', { skip, timeout: 500000 }, async (t) => {
  const x = await start(t, { build: buildModels });
  await connected(x);
  await spy(x);
  await x.room('canvas');
  await waitFor(async () => assert.equal(await x.count('.react-flow__node'), 6));
  const file = path.join(x.dir, 'Models.canvas');
  const modelFiles = [path.join(x.dir, 'vase.glb'), path.join(x.dir, 'Reading', 'vase.gltf'), path.join(x.dir, 'fake.glb')];
  const before = [file, ...modelFiles].map(fileState);

  await t.test('the card shows the model: a .glb and a .gltf (buffer inside the file) are drawn, with the name above and a name for a screen reader', async () => {
    await waitFor(async () => assert.equal(await x.count('.cv-model[data-model="ready"]'), 2), { timeout: 30000 });
    for (const f of ['vase.glb', 'Reading/vase.gltf']) {
      const p = await picture(x, f);
      assert.ok(p.on > 0.04 && p.on < 0.7, `${f}: the model covers part of the card, the rest is clear: ${JSON.stringify(p)}`);
      assert.ok(p.w >= 250 && p.h >= 180, `${f}: drawn at the card's size: ${p.w}x${p.h}`);
    }
    assert.equal(await x.ev(`document.querySelector('.cv-model[data-file="vase.glb"] .cv-open').textContent`), 'vase');
    assert.equal(await x.ev(`document.querySelector('.cv-model[data-file="vase.glb"] canvas').getAttribute('aria-label').startsWith('3D model')`), true);
    assert.equal(await x.ev(`document.querySelector('.cv-model[data-file="vase.glb"] canvas').tabIndex`), 0, 'reachable by Tab');
    assert.equal(await x.ev(`document.querySelectorAll('.cv-model canvas').length`), 2);
    // one WebGL context for all the cards: the cards' canvases are plain 2D copies
    assert.equal(await x.ev(`[...document.querySelectorAll('.cv-model canvas')].every((c) => !!c.getContext('2d'))`), true);
  });

  await t.test('a model that cannot be shown says so in its card, quietly: a file that is no model, and one that is not in the folder', async () => {
    await waitFor(async () => assert.equal(await x.count('.cv-model[data-model="error"]'), 2), { timeout: 15000 });
    const notes = JSON.parse(await x.ev(`JSON.stringify([...document.querySelectorAll('.cv-model[data-model="error"]')].map((c) => [c.getAttribute('data-file'), c.querySelector('.cv-model-note').textContent]))`));
    const byFile = Object.fromEntries(notes);
    assert.match(byFile['fake.glb'], /cannot be shown/);
    assert.match(byFile['fake.glb'], /not a binary glTF/);
    assert.equal(byFile['ghost.glb'], 'This model is not in the folder.');
    assert.equal(await x.count('.cv-model[data-file="fake.glb"] canvas'), 0);
  });

  await t.test('turning the model: a drag on it changes the picture and moves neither the card nor the file; a drag on its name bar moves the card (his move, so it is saved)', async () => {
    const view = await x.box('.cv-model[data-file="vase.glb"] .cv-model-view');
    const card = await x.box('.react-flow__node[data-id="m1"]');
    const p0 = await picture(x, 'vase.glb');
    await x.drag({ x: view.cx - 60, y: view.cy }, { x: view.cx + 60, y: view.cy - 30 });
    await sleep(900);
    const p1 = await picture(x, 'vase.glb');
    assert.notEqual(p1.h, p0.h, 'the picture changed: the model turned');
    const card1 = await x.box('.react-flow__node[data-id="m1"]');
    assert.deepEqual([Math.round(card1.x), Math.round(card1.y)], [Math.round(card.x), Math.round(card.y)], 'the card did not move');
    await sleep(900);
    assert.equal(fileState(file), before[0], 'the canvas file is untouched by turning a model');
    // the name bar is the handle for the card
    const bar = await x.box('.cv-model[data-file="vase.glb"] .cv-model-bar');
    await x.drag({ x: bar.cx, y: bar.cy }, { x: bar.cx + 80, y: bar.cy + 60 });
    await waitFor(async () => {
      const m = JSON.parse(fs.readFileSync(file, 'utf8')).nodes.find((n) => n.id === 'm1');
      assert.ok(m.x > 300 + 40 && m.y > -60 + 30, 'saved: ' + JSON.stringify([m.x, m.y]));
    }, { timeout: 5000 });
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(doc.nodes.find((n) => n.id === 'm1').file, 'vase.glb', 'the card still points at the same file');
    assert.deepEqual(modelFiles.map(fileState), before.slice(1), 'no model file was touched');
  });

  await t.test('read only: the page asked the storage for model bytes and never to write, create, trash or rename anything for a model', async () => {
    const calls = await asked(x);
    assert.ok(calls.filter((c) => c === 'model').length >= 3, 'model bytes were asked for: ' + calls.join(','));
    assert.deepEqual(calls.filter((c) => c !== 'write' && WRITES.includes(c)), [], 'only his card move was written');
    assert.deepEqual(fs.readdirSync(x.dir).sort(), ['Reading', 'Models.canvas', 'README.md', 'fake.glb', 'vase.glb']);
    assert.deepEqual(fs.readdirSync(path.join(x.dir, 'Reading')).sort(), ['vase.gltf']);
  });

  await t.test('3D: both models are nodes of the graph, drawn as the models; a card that is not a model stays a slab', async () => {
    await switchTo(x, '3d');
    await waitFor(async () => assert.equal(await x.count('.cv-3d canvas'), 1), { timeout: 15000 });
    await waitFor(async () => assert.equal((await x.three()).models, 2), { timeout: 30000 });
    const s = await x.settled();
    assert.deepEqual([s.nodes, s.links, s.models], [6, 2, 2]);
    await x.ev('canvasHandle.three().fit(), true');
    await sleep(1800);
    await x.shot('light', 'canvas-3d-models.png');
    await x.shot('dark', 'canvas-3d-models-dark.png');
  });

  await t.test('no request left the extension (a model cannot make the page load anything), and the models and the canvas file are as they were', async () => {
    const res = JSON.parse(await x.ev(`JSON.stringify(performance.getEntriesByType('resource').map((r) => r.name).filter((n) => !n.startsWith('chrome-extension://') && !n.startsWith('blob:') && !n.startsWith('data:')))`));
    assert.deepEqual(res, []);
    assert.deepEqual([...x.server.hits.keys()], []);
    assert.deepEqual(modelFiles.map(fileState), before.slice(1));
  });
});

test('C52: the 2D card in light and dark (screenshots in docs/), the model repainted after a scheme change', { skip, timeout: 300000 }, async (t) => {
  const x = await start(t, {
    build: (dir) => {
      fs.writeFileSync(path.join(dir, 'README.md'), '# Me space\n');
      copyFix(dir, 'vase.glb');
      writeCanvas(dir, 'Object.canvas', {
        nodes: [
          T('a', 0, 40, '# A physical thing\n\nThe vase from the shelf, as a model.', { width: 240, height: 130 }),
          FILE('m', 300, -40, 'vase.glb', { width: 320, height: 300 }),
          FILE('n', 0, 220, 'README.md'),
        ],
        edges: [{ id: 'e', fromNode: 'a', fromSide: 'right', toNode: 'm', toSide: 'left' }],
      });
    },
  });
  await x.room('canvas');
  await waitFor(async () => assert.equal(await x.count('.cv-model[data-model="ready"]'), 1), { timeout: 30000 });
  await sleep(600);
  const p0 = await picture(x, 'vase.glb');
  const p1 = await inScheme(x, 'dark', async () => {
    await sleep(900);
    return picture(x, 'vase.glb');
  });
  assert.notEqual(p1.h, p0.h, 'the card repainted for dark (its shade is darker)');
  assert.ok(p1.on > 0.04, 'and the model is still there');
  await x.shot('light', 'canvas-glb-card.png');
  await x.shot('dark', 'canvas-glb-card-dark.png');
});

test('C52: a model cannot make the page load anything: a .gltf whose buffer is a web address is refused, one whose picture is a web address is drawn without it, and the test server sees nothing', { skip, timeout: 300000 }, async (t) => {
  const x = await start(t, {
    build: (dir, _spaces, base) => {
      const gltf = JSON.parse(fs.readFileSync(path.join(FIX, 'vase.gltf'), 'utf8'));
      const outside = JSON.parse(JSON.stringify(gltf));
      outside.buffers[0].uri = base + 'evil-buffer.bin'; // the geometry from the network
      fs.writeFileSync(path.join(dir, 'outside-buffer.gltf'), JSON.stringify(outside));
      const pic = JSON.parse(JSON.stringify(gltf));
      pic.images = [{ uri: base + 'evil-picture.png' }]; // a texture from the network, the geometry inside
      pic.textures = [{ source: 0 }];
      pic.materials[0].pbrMetallicRoughness.baseColorTexture = { index: 0 };
      fs.writeFileSync(path.join(dir, 'outside-picture.gltf'), JSON.stringify(pic));
      writeCanvas(dir, 'Evil.canvas', { nodes: [FILE('a', 0, 0, 'outside-buffer.gltf', { width: 280, height: 220 }), FILE('b', 320, 0, 'outside-picture.gltf', { width: 280, height: 220 }), T('c', 0, 260, 'a plain card')], edges: [] });
    },
  });
  await x.room('canvas');
  await waitFor(async () => {
    assert.equal(await x.count('.cv-model[data-model="error"]'), 1, 'the model whose geometry is a web address cannot be shown');
    assert.equal(await x.count('.cv-model[data-model="ready"]'), 1, 'the model whose picture is a web address is drawn without the picture');
  }, { timeout: 30000 });
  await sleep(1500);
  assert.deepEqual([...x.server.hits.keys()], [], 'the page asked the test server for: ' + [...x.server.hits.keys()].join(', '));
  assert.match(await x.ev(`document.querySelector('.cv-model[data-file="outside-buffer.gltf"] .cv-model-note').textContent`), /cannot be shown/);
  assert.equal(await x.ev(`document.querySelector('.cv-model[data-file="outside-picture.gltf"]').getAttribute('data-model')`), 'ready');
  const res = JSON.parse(await x.ev(`JSON.stringify(performance.getEntriesByType('resource').map((r) => r.name).filter((n) => !n.startsWith('chrome-extension://')))`));
  assert.deepEqual(res, []);
});
