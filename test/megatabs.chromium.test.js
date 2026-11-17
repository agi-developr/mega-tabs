'use strict';
// Mega tabs in a real Chromium: the side panel page (same code as the side panel itself,
// opened as a small window because the real panel is not scriptable), the Me starter
// space, switching without reloads, empty mega tabs, and the development auto-reload.
// Runs only when CHROME points at a Chromium binary:
//
//   CHROME=<binary> node --test test/megatabs.chromium.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { Chromium, EXT, waitFor, sleep } = require('./chromium');
const { install } = require('../install-host');

const bin = process.env.CHROME;
const NEWTAB = /^chrome:\/\/(newtab|new-tab-page)\//;
const SEED = ['Reading', 'Drafts', 'Archive', 'Writing'];

function startServer() {
  const hits = new Map();
  const server = http.createServer((req, res) => {
    const name = req.url.slice(1);
    if (name !== 'favicon.ico') hits.set(name, (hits.get(name) || 0) + 1);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(`<!doctype html><title>${name}</title><p>${name}</p>`);
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ server, hits, base: `http://127.0.0.1:${server.address().port}/` })),
  );
}

// Evaluates an expression inside the page with this URL
function inPage(b, url, expression) {
  return b.withPage(url, async (s) => {
    const r = await b.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, s);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  });
}

// spaces: a temp folder standing in for ~/Spaces. The Board host is installed for the TEST profile only
// (<profile>/NativeMessagingHosts, which Chrome reads for that profile); his real Chrome is never touched.
async function launch(bin, ext, { spaces } = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'megatabs-chromium-'));
  const b = new Chromium(bin, profile, ext);
  if (spaces) install({ id: b.extId, manifestDir: path.join(profile, 'NativeMessagingHosts'), wrapperDir: path.join(profile, 'board-host'), spaces });
  await b.launch({ restore: 'newtab' });
  // The first reconcile has run once a main window is assigned to a workspace
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

test('Mega tabs panel: seed, create, switch without reload, empty mega tab, close, screenshot', { skip: !bin && 'CHROME is not set', timeout: 300000 }, async (t) => {
  const { server, hits, base } = await startServer();
  const { b, profile, win } = await launch(bin, EXT);
  t.after(cleanup(b, profile, server));

  // The panel page lives in its own small window, away from the tabs that get moved around
  const panelUrl = `chrome-extension://${b.extId}/sidepanel.html?window=${win}`;
  const openPanel = async () => {
    const id = await b.sw(
      'return (await chrome.windows.create({ url: args[0], type: "popup", width: 360, height: 640, focused: false })).id;',
      panelUrl,
    );
    await waitFor(() => inPage(b, panelUrl, 'document.readyState === "complete" || Promise.reject(new Error("loading"))'));
    return id;
  };
  const ui = (expr) => inPage(b, panelUrl, expr);
  const sections = async () =>
    JSON.parse(
      await ui(`JSON.stringify([...document.querySelectorAll('section.space')].map((s) => ({
        head: s.querySelector('.space-head span')?.textContent,
        rows: [...s.querySelectorAll('.mega')].map((r) => r.querySelector('.name').textContent),
        current: [...s.querySelectorAll('.mega.current')].map((r) => r.querySelector('.name').textContent),
      })))`),
    );
  const sec = (head) => `[...document.querySelectorAll('section.space')].find((s) => s.querySelector('.space-head span')?.textContent === ${JSON.stringify(head)})`;
  const rowIn = (head, name) => `[...${sec(head)}.querySelectorAll('.mega')].find((r) => r.querySelector('.name').textContent === ${JSON.stringify(name)})`;
  const current = async () => (await sections()).flatMap((s) => s.current)[0];
  const clickRow = async (head, name) => {
    await ui(`(${rowIn(head, name)}).click(), true`);
    await waitFor(async () => {
      assert.equal(await current(), name);
      assert.equal((await b.sw("return !!(await chrome.storage.session.get('pendingSwitch')).pendingSwitch;")), false);
    });
  };
  const mainTabs = () => b.sw('return (await chrome.tabs.query({ windowId: args[0] })).map((t) => ({ url: t.url || t.pendingUrl, title: t.title, pinned: t.pinned, status: t.status }));', win);
  const openPage = async (name) => {
    await b.sw('await chrome.tabs.create({ windowId: args[0], url: args[1], active: true });', win, base + name);
    await waitFor(async () => assert.ok((await mainTabs()).some((x) => x.url === base + name && x.status === 'complete'), `${name} not loaded`));
  };
  const addMega = async (space, name) => {
    await ui(`(() => {
      ${sec(space)}.querySelector('.add').click();
      const i = document.querySelector('input.inline'); i.value = ${JSON.stringify(name)};
      i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); return true; })()`);
    await waitFor(async () => assert.ok((await sections()).find((s) => s.head === space).rows.includes(name), `${name} not listed`));
  };

  // The existing window holds a normal page, as in his everyday browser
  await openPage('d1');
  const wsBefore = await b.sw("return (await chrome.storage.local.get('workspaces')).workspaces.map((w) => w.name);");
  assert.equal(wsBefore.length, 1, 'fresh profile has the one upstream workspace');
  const defaultTabs = (await mainTabs()).length;

  await t.test('first open seeds Me once; no "Workspace N"; default workspace shows its tab title', async () => {
    const panelWin = await openPanel();
    await waitFor(async () => assert.deepEqual((await sections()).find((s) => s.head === 'Me')?.rows, SEED));
    const text = await ui('document.body.innerText');
    assert.ok(!/Workspace( \d+)?/.test(text), `panel shows an upstream default name:\n${text}`);
    const all = await sections();
    assert.deepEqual(all.find((s) => s.head === 'Open windows').rows, ['d1'], 'default workspace listed by its active tab title');
    // Open the panel a second time: no duplicates
    await b.sw('await chrome.windows.remove(args[0]);', panelWin);
    await openPanel();
    await waitFor(async () => assert.deepEqual((await sections()).find((s) => s.head === 'Me')?.rows, SEED));
    const { workspaces, megaSeeded } = await b.sw("return chrome.storage.local.get(['workspaces', 'megaSeeded']);");
    assert.equal(megaSeeded, true);
    assert.deepEqual(workspaces.map((w) => w.name), [...wsBefore, ...SEED.map((n) => `Me · ${n}`)]);
    // The existing window's tabs were not touched
    assert.equal((await mainTabs()).length, defaultTabs);
    assert.ok((await mainTabs()).some((x) => x.url === base + 'd1'));
  });

  await t.test('create two mega tabs from the panel', async () => {
    await addMega('Me', 'Research');
    await addMega('Me', 'Notes');
    const names = await b.sw("return (await chrome.storage.local.get('workspaces')).workspaces.map((w) => w.name);");
    assert.ok(names.includes('Me · Research') && names.includes('Me · Notes'));
    assert.ok(!names.some((n) => /^Workspace \d+$/.test(n)), 'no auto-named workspace left behind');
  });

  await t.test('empty mega tab shows a new tab page, not an error', async () => {
    await clickRow('Me', 'Reading');
    const tabs = (await mainTabs()).filter((x) => !x.pinned);
    assert.equal(tabs.length, 1, JSON.stringify(tabs));
    assert.match(tabs[0].url, NEWTAB);
    assert.equal(await ui("document.querySelector('.error')?.textContent || ''"), '');
  });

  await t.test('switching between two mega tabs with real pages never re-fetches them', async () => {
    await clickRow('Me', 'Research');
    await openPage('r1');
    await clickRow('Me', 'Notes');
    await openPage('n1');
    const before = new Map(hits);
    for (const name of ['Research', 'Notes', 'Research', 'Notes', 'Research']) await clickRow('Me', name);
    assert.deepEqual(new Map(hits), before, 'a page was fetched again');
    const urls = (await mainTabs()).map((x) => x.url);
    assert.ok(urls.includes(base + 'r1') && !urls.includes(base + 'n1'), `Research shows its page: ${urls}`);
    assert.deepEqual(b.errors, [], 'unhandled errors in the service worker');
  });

  await t.test('screenshot of the panel at 360 px', async () => {
    await clickRow('Me', 'Notes');
    // d1's workspace is now parked in a stash window; it is still listed by its page title
    await waitFor(async () => assert.deepEqual((await sections()).find((s) => s.head === 'Open windows')?.rows, ['d1']));
    const png = await b.withPage(panelUrl, async (s) => {
      await b.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 640, deviceScaleFactor: 2, mobile: false }, s);
      const r = await b.send('Page.captureScreenshot', { format: 'png' }, s);
      await b.send('Emulation.clearDeviceMetricsOverride', {}, s);
      return Buffer.from(r.data, 'base64');
    });
    const out = path.join(__dirname, '..', 'docs', 'panel.png');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, png);
    assert.equal(png.readUInt32BE(16), 720, 'PNG is 360 CSS px wide at 2x');
  });

  await t.test('closing a mega tab removes it and leaves the others loaded', async () => {
    await clickRow('Me', 'Notes');
    const before = new Map(hits);
    const clickClose = () => ui(`(${rowIn('Me', 'Research')}).querySelector('.close').click(), true`);
    await clickClose(); // first click asks, second closes
    await waitFor(async () => assert.equal(await ui(`(${rowIn('Me', 'Research')}).querySelector('.close').textContent`), 'close?'));
    await clickClose();
    await waitFor(async () => assert.ok(!(await sections()).find((s) => s.head === 'Me').rows.includes('Research')));
    const names = await b.sw("return (await chrome.storage.local.get('workspaces')).workspaces.map((w) => w.name);");
    assert.ok(!names.includes('Me · Research'));
    assert.deepEqual(new Map(hits), before, 'a page was fetched again');
    assert.equal(await current(), 'Notes');
  });

  await t.test('no tab groups were created by the extension', async () => {
    assert.deepEqual(await b.sw('return chrome.tabGroups.query({});'), []);
  });
});

test('Auto-reload: a changed BUILD stamp reloads the extension within seconds, tabs stay loaded', { skip: !bin && 'CHROME is not set', timeout: 120000 }, async (t) => {
  const { server, hits, base } = await startServer();
  // A copy of the extension, so the test can change "files on disk" without touching the real folder
  const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'megatabs-ext-'));
  fs.cpSync(EXT, ext, { recursive: true });
  fs.rmSync(path.join(ext, 'board-data'), { recursive: true, force: true });
  fs.writeFileSync(path.join(ext, 'BUILD'), 'one\n');
  const { b, profile, win } = await launch(bin, ext);
  t.after(async () => {
    await cleanup(b, profile, server)();
    fs.rmSync(ext, { recursive: true, force: true });
  });

  await b.sw('await chrome.tabs.create({ windowId: args[0], url: args[1], active: true });', win, base + 'keep');
  const tabCount = () => b.sw('return (await chrome.tabs.query({ windowType: "normal" })).length;');
  await waitFor(async () => assert.equal(await b.sw("return (await chrome.storage.local.get('buildSeen')).buildSeen;"), 'one'));
  const tabs = await tabCount();
  await b.sw('globalThis.__before = true;');
  assert.equal(hits.get('keep'), 1);

  fs.writeFileSync(path.join(ext, 'BUILD'), 'two\n');
  const t0 = Date.now();
  await b.attachWorker();
  const took = Date.now() - t0;
  assert.equal(await b.sw('return globalThis.__before === undefined;'), true, 'a new service worker is running');
  assert.equal(await b.sw("return (await chrome.storage.local.get('buildSeen')).buildSeen;"), 'two');
  assert.ok(took < 5000, `reloaded after ${took} ms`);
  t.diagnostic(`extension reloaded ${took} ms after the stamp changed`);

  await sleep(1500);
  assert.equal(await tabCount(), tabs, 'tabs stayed');
  assert.equal(hits.get('keep'), 1, 'the open page was not reloaded');

  // A change in an extension file is picked up by the reload, not just the stamp
  fs.appendFileSync(path.join(ext, 'megatabs.js'), '\nglobalThis.__edited = true;\n');
  fs.writeFileSync(path.join(ext, 'BUILD'), 'three\n');
  await b.attachWorker();
  assert.equal(await b.sw('return globalThis.__edited === true;'), true, 'the edited file is the one running');
  assert.equal(hits.get('keep'), 1, 'still not reloaded');
});

// A page of the extension found by the start of its address (the Board adds #file to its own)
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

test('Board: a space header opens its .md files, listed on the left, rendered on the right, read through the host', { skip: !bin && 'CHROME is not set', timeout: 180000 }, async (t) => {
  const { server, hits, base } = await startServer();
  // A copy of the extension and a stand-in for ~/Spaces, so nothing of his real files is touched
  const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'megatabs-ext-'));
  fs.cpSync(EXT, ext, { recursive: true });
  fs.rmSync(path.join(ext, 'board-data'), { recursive: true, force: true });
  const spaces = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'megatabs-spaces-')));
  fs.mkdirSync(path.join(spaces, 'Me'));
  const calcSheet = path.join(spaces, 'Me', 'call-script.md');
  fs.writeFileSync(calcSheet, `# Calc sheet

The first ten seconds decide the talk. See [priorities](priorities.md#plans) for what we plan.

- Greet by first name
- Ask what they miss most at night
- **Never** read the price list

![remote](${base}pixel.png)

<script>document.title = 'owned'</script>
[bad](javascript:alert(1)) and [web](${base}site)
`);
  fs.writeFileSync(path.join(spaces, 'Me', 'priorities.md'), `# Priorities notes

| Plan | Per month |
| --- | --- |
| Night desk | $199 |
| Always on | $399 |

> Quote the night desk first.

\`\`\`
rate = rooms * 2
\`\`\`
`);
  fs.writeFileSync(path.join(spaces, 'Me', 'ignored.txt'), 'not markdown');

  const { b, profile, win } = await launch(bin, ext, { spaces });
  t.after(async () => {
    await cleanup(b, profile, server)();
    fs.rmSync(ext, { recursive: true, force: true });
    fs.rmSync(spaces, { recursive: true, force: true });
  });

  const panelUrl = `chrome-extension://${b.extId}/sidepanel.html?window=${win}`;
  await b.sw('await chrome.windows.create({ url: args[0], type: "popup", width: 360, height: 640, focused: false });', panelUrl);
  await waitFor(() => inPage(b, panelUrl, 'document.readyState === "complete" || Promise.reject(new Error("loading"))'));
  const ui = (expr) => inPage(b, panelUrl, expr);
  const boardBtn = (space) => `[...document.querySelectorAll('section.space')].find((s) => s.querySelector('.space-head span')?.textContent === ${JSON.stringify(space)}).querySelector('.board')`;
  await waitFor(async () => assert.equal(await ui(`${boardBtn('Me')}.textContent`), 'Board'));

  const boardUrl = `chrome-extension://${b.extId}/board.html?space=Me`;
  const board = (expr) => withPrefix(b, boardUrl, async (s) => {
    const r = await b.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, s);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  });
  const listed = async () => JSON.parse(await board(`JSON.stringify([...document.querySelectorAll('#list .file .title')].map((n) => n.textContent))`));
  const boardTabs = () => b.sw('return (await chrome.tabs.query({})).filter((t) => (t.url || "").startsWith(args[0])).length;', boardUrl);

  await t.test('the Board button opens one Board tab; both files listed, the first rendered', async () => {
    await ui(`${boardBtn('Me')}.click(), true`);
    await waitFor(async () => assert.deepEqual(await listed(), ['Calc sheet', 'Priorities notes']));
    await waitFor(async () => assert.equal(await board(`document.querySelector('#doc .md h1')?.textContent`), 'Calc sheet'));
    assert.equal(await board(`document.querySelector('#list .file.current .title').textContent`), 'Calc sheet');
    assert.match(await board(`document.querySelector('#doc .md li')?.textContent`), /Greet by first name/);
    assert.equal(await board(`document.querySelector('#doc .md strong')?.textContent`), 'Never');
    // Clicking again brings the open Board forward, no second tab
    await ui(`${boardBtn('Me')}.click(), true`);
    await sleep(500);
    assert.equal(await boardTabs(), 1);
    assert.match(await board(`document.querySelector('.doc-bar a').href`), new RegExp('^cursor://file' + calcSheet.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'));
  });

  await t.test('markdown cannot run code or reach the network', async () => {
    assert.equal(await board(`document.querySelector('#doc script')`), null, 'script tag removed');
    assert.equal(await board(`document.title`), 'Board · Me', 'the script did not run');
    assert.equal(await board(`document.querySelector('#doc img')?.hasAttribute('src') ?? false`), false, 'remote image has no src');
    assert.equal(await board(`document.querySelector('#doc a[href^="javascript"]')`), null);
    assert.equal(await board(`document.querySelector('#doc a[target="_blank"]')?.rel`), 'noopener noreferrer');
    await sleep(500);
    assert.equal(hits.get('pixel.png'), undefined, 'the remote image was never requested');
  });

  await t.test('a link to a sibling file opens it here; a table and code render', async () => {
    await board(`document.querySelector('#doc a[data-md]').click(), true`);
    await waitFor(async () => assert.equal(await board(`document.querySelector('#doc .md h1')?.textContent`), 'Priorities notes'));
    assert.equal(await board(`document.querySelector('#list .file.current .title').textContent`), 'Priorities notes');
    assert.equal(await board(`document.querySelectorAll('#doc table tr').length`), 3);
    assert.equal(await board(`document.querySelector('#doc pre code').textContent.trim()`), 'rate = rooms * 2');
    assert.equal(await board(`document.querySelector('#doc blockquote')?.textContent.trim()`), 'Quote the night desk first.');
  });

  await t.test('screenshots at 1200 px, light and dark, in the panel palette', async () => {
    await board(`document.querySelector('#list .file').click(), true`);
    await waitFor(async () => assert.equal(await board(`document.querySelector('#doc .md h1')?.textContent`), 'Calc sheet'));
    const shot = (scheme, file) => withPrefix(b, boardUrl, async (s) => {
      await b.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 760, deviceScaleFactor: 1, mobile: false }, s);
      await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] }, s);
      const bg = (await b.send('Runtime.evaluate', { expression: 'getComputedStyle(document.body).backgroundColor', returnByValue: true }, s)).result.value;
      const r = await b.send('Page.captureScreenshot', { format: 'png' }, s);
      await b.send('Emulation.setEmulatedMedia', { features: [] }, s);
      await b.send('Emulation.clearDeviceMetricsOverride', {}, s);
      const png = Buffer.from(r.data, 'base64');
      const out = path.join(__dirname, '..', 'docs', file);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, png);
      assert.equal(png.readUInt32BE(16), 1200, 'PNG is 1200 px wide');
      return bg;
    });
    const light = await shot('light', 'board.png');
    // The dark one shows the second file, so a table, a quote and code are seen too
    await board(`document.querySelectorAll('#list .file')[1].click(), true`);
    await waitFor(async () => assert.equal(await board(`document.querySelector('#doc .md h1')?.textContent`), 'Priorities notes'));
    const dark = await shot('dark', 'board-dark.png');
    await board(`document.querySelector('#list .file').click(), true`);
    await waitFor(async () => assert.equal(await board(`document.querySelector('#doc .md h1')?.textContent`), 'Calc sheet'));
    assert.equal(light, 'rgb(247, 247, 245)', 'light uses the panel background');
    assert.equal(dark, 'rgb(28, 28, 30)', 'dark uses the panel background');
  });

  await t.test('a space with no folder says so and shows its files once the folder appears; an outside edit shows with no reload', async () => {
    const nowhereUrl = `chrome-extension://${b.extId}/board.html?space=Nowhere`;
    await b.sw('await chrome.tabs.create({ windowId: args[0], url: args[1], active: false });', win, nowhereUrl);
    const nowhere = (expr) => withPrefix(b, nowhereUrl, async (s) => (await b.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, s)).result.value);
    await waitFor(async () => assert.match(await nowhere('document.querySelector("#doc .note")?.textContent || ""'), /No folder for "Nowhere"/));
    // The folder appears later (someone makes it): the open Board picks it up by itself
    fs.mkdirSync(path.join(spaces, 'Nowhere'));
    fs.writeFileSync(path.join(spaces, 'Nowhere', 'first.md'), '# First note\n');
    await waitFor(async () => assert.equal(await nowhere('document.querySelector("#doc .md h1")?.textContent'), 'First note'), { timeout: 4000 });

    // An outside edit shows in the open Board with no reload (the page keeps its time origin)
    const origin = await board('performance.timeOrigin');
    fs.writeFileSync(calcSheet, '# Calc sheet v2\n\nRewritten.\n');
    fs.writeFileSync(path.join(spaces, 'Me', 'extra.md'), 'no heading here\n');
    const t0 = Date.now();
    await waitFor(async () => assert.deepEqual(await listed(), ['Calc sheet v2', 'extra', 'Priorities notes']), { timeout: 4000 });
    await waitFor(async () => assert.equal(await board(`document.querySelector('#doc .md h1')?.textContent`), 'Calc sheet v2'));
    t.diagnostic(`edit on disk to the Board showing it: ${Date.now() - t0} ms`);
    assert.equal(await board('performance.timeOrigin'), origin, 'the page was not reloaded');
  });
});

// ---------------------------------------------------------------- C15-C21: editing in the Board

// Keys and text as a person types them, through the page's input path
async function press(b, s, key, code, text) {
  await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, text, unmodifiedText: text }, s);
  await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code }, s);
}

test('Board editing: read -> edit -> save, outside edits live, conflict, new note, no reload', { skip: !bin && 'CHROME is not set', timeout: 300000 }, async (t) => {
  const { sync } = require('../board-sync');
  const { server } = await startServer();
  const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'megatabs-ext-'));
  fs.cpSync(EXT, ext, { recursive: true });
  fs.rmSync(path.join(ext, 'board-data'), { recursive: true, force: true });
  const spaces = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'megatabs-spaces-')));
  const dir = path.join(spaces, 'Me');
  fs.mkdirSync(path.join(dir, 'Reading'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Reading', 'MEGATAB.md'), '---\nurls:\n  - http://127.0.0.1:9/never\n---\nHow it works.\n');
  const NOTES = '---\ntitle: Notes\ntags: [a, b]\n---\n\n# Notes\n\nFirst line.\n\n\nAfter two blank lines.\n';
  const CRLF = '# Windows\r\n\r\nline one\r\nline two\r\n';
  const NOEOL = 'no final newline';
  fs.writeFileSync(path.join(dir, 'notes.md'), NOTES);
  fs.writeFileSync(path.join(dir, 'crlf.md'), CRLF);
  fs.writeFileSync(path.join(dir, 'noeol.md'), NOEOL);
  fs.writeFileSync(path.join(dir, 'other.md'), '# Other\n');
  sync({ from: spaces, to: ext }); // the stand-in for the LaunchAgent: megatabs.json and BUILD
  const buildFile = path.join(ext, 'BUILD');
  const buildBefore = fs.readFileSync(buildFile, 'utf8');

  const { b, profile, win } = await launch(bin, ext, { spaces });
  t.after(async () => {
    await cleanup(b, profile, server)();
    fs.rmSync(ext, { recursive: true, force: true });
    fs.rmSync(spaces, { recursive: true, force: true });
  });

  const boardUrl = `chrome-extension://${b.extId}/board.html?space=Me`;
  await b.sw('await chrome.tabs.create({ windowId: args[0], url: args[1], active: true });', win, boardUrl);
  const page = (fn) => withPrefix(b, boardUrl, async (s) => {
    await b.send('Emulation.setFocusEmulationEnabled', { enabled: true }, s);
    return fn(s);
  });
  const ev = (expr) => page(async (s) => {
    const r = await b.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, s);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  });
  const file = (n) => path.join(dir, n);
  const disk = (n) => fs.readFileSync(file(n), 'utf8');
  const tabsCount = () => b.sw('return (await chrome.tabs.query({})).length;');
  const h1 = () => ev(`document.querySelector('#doc .md h1')?.textContent`);
  const editorValue = () => ev(`document.querySelector('textarea.overtype-input')?.value ?? null`);
  const bodyText = () => ev(`document.querySelector('#doc').innerText`);
  const status = () => ev(`document.querySelector('.status')?.textContent ?? ''`);
  const pick = async (name) => {
    await ev(`[...document.querySelectorAll('#list .file')].find((b) => b.title === ${JSON.stringify(name)}).click(), true`);
    await waitFor(async () => assert.equal(await ev('document.querySelector("#list .file.current")?.title'), name));
    // the pane shows that file (not the one before it)
    await waitFor(async () => assert.equal(await ev(`document.querySelector('.doc-bar .bar-left span')?.textContent.startsWith(${JSON.stringify(name)})`), true));
  };
  // Types at the end of the editor, as a person does: focus, caret to the end, text goes in through the input path
  const typeAtEnd = (text) => page(async (s) => {
    await b.send('Runtime.evaluate', { expression: `(() => { const t = document.querySelector('textarea.overtype-input'); t.focus(); t.setSelectionRange(t.value.length, t.value.length); return true; })()`, returnByValue: true }, s);
    await b.send('Input.insertText', { text }, s);
  });
  const editing = async () => assert.equal(await ev(`!!document.querySelector('#doc .overtype-container')`), true);
  const clickMode = () => ev(`document.querySelector('#mode').click(), true`);
  // Done: back to the rendered view, waited for
  const done = async () => {
    await clickMode();
    await waitFor(async () => assert.equal(await ev(`!document.querySelector('#doc .overtype-container') && document.querySelector('#mode')?.textContent`), 'Edit'));
  };
  let origin = await waitFor(async () => {
    const v = await ev('performance.timeOrigin');
    assert.ok(await ev(`document.querySelectorAll('#list .file').length >= 4`));
    return v;
  });
  const sw0 = await b.sw('globalThis.__marker = 1; return true;');
  assert.equal(sw0, true);
  const noReload = async (why) => {
    assert.equal(await ev('performance.timeOrigin'), origin, `${why}: the Board page was not reloaded`);
    assert.equal(await b.sw('return globalThis.__marker === 1;'), true, `${why}: the extension was not reloaded`);
    assert.equal(fs.readFileSync(buildFile, 'utf8'), buildBefore, `${why}: BUILD unchanged`);
  };
  const tabs0 = await tabsCount();

  await t.test('C15: Edit turns the shown file into an editor of the same text in the same pane; Done goes back; no new tab', async () => {
    await pick('notes.md');
    await waitFor(async () => assert.equal(await h1(), 'Notes'));
    assert.equal(await ev(`document.querySelector('#mode').textContent`), 'Edit');
    assert.equal(await ev(`!!document.querySelector('#doc .overtype-container')`), false, 'reading shows no editor');
    await clickMode();
    await waitFor(editing);
    assert.equal(await editorValue(), NOTES, 'the editor holds the file text exactly');
    assert.equal(await ev(`document.querySelector('#mode').textContent`), 'Done');
    assert.equal(await ev(`document.querySelector('#list .file.current').title`), 'notes.md', 'same pane, same file');
    assert.equal(await tabsCount(), tabs0, 'no new tab');
    await done();
    await waitFor(async () => assert.equal(await h1(), 'Notes'));
    assert.equal(await ev(`!!document.querySelector('#doc .overtype-container')`), false);
    // The keys: E to edit, Esc to read
    await page(async (s) => press(b, s, 'e', 'KeyE', 'e'));
    await waitFor(editing);
    await page(async (s) => press(b, s, 'Escape', 'Escape'));
    await waitFor(async () => assert.equal(await h1(), 'Notes'));
    assert.equal(await tabsCount(), tabs0);
    assert.equal(disk('notes.md'), NOTES, 'looking and going back changed no byte');
  });

  await t.test('C16: within 1 s of a typing pause the file equals the editor text byte for byte, written by atomic replace', async () => {
    await clickMode();
    await waitFor(editing);
    const ino = fs.statSync(file('notes.md')).ino;
    const t0 = Date.now();
    await typeAtEnd('Typed in the Board. 🚀 ä\n');
    await waitFor(async () => assert.equal(disk('notes.md'), NOTES + 'Typed in the Board. 🚀 ä\n'), { timeout: 1500, interval: 50 });
    const took = Date.now() - t0;
    t.diagnostic(`typed to bytes on disk: ${took} ms`);
    assert.ok(took < 1000, `saved ${took} ms after typing`);
    assert.deepEqual(fs.readFileSync(file('notes.md')), Buffer.from(NOTES + 'Typed in the Board. 🚀 ä\n', 'utf8'));
    assert.notEqual(fs.statSync(file('notes.md')).ino, ino, 'replaced by rename');
    assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), [], 'no temp file left');
    await waitFor(async () => assert.equal(await status(), 'Saved'));
    assert.equal(await editorValue(), NOTES + 'Typed in the Board. 🚀 ä\n');
    // His own save comes back through the watcher and changes nothing on screen
    await sleep(1500);
    assert.equal(await editorValue(), NOTES + 'Typed in the Board. 🚀 ä\n');
    assert.equal(await ev(`!!document.querySelector('#conflict')`), false);
    await noReload('after a save');
    // CRLF and a missing final newline survive
    await done();
    await pick('crlf.md');
    await clickMode();
    await waitFor(editing);
    assert.equal(await editorValue(), CRLF.replace(/\r\n/g, '\n'), 'the editor shows plain newlines');
    await typeAtEnd('three\n');
    await waitFor(async () => assert.equal(disk('crlf.md'), CRLF + 'three\r\n'), { timeout: 1500, interval: 50 });
    await done();
    await pick('noeol.md');
    await clickMode();
    await waitFor(editing);
    await typeAtEnd(' and more');
    await waitFor(async () => assert.equal(disk('noeol.md'), NOEOL + ' and more'), { timeout: 1500, interval: 50 });
    await done();
    await pick('notes.md');
    await noReload('after three saves');
  });

  await t.test('C21: saving, an outside edit of a Board file and of a MEGATAB.md never change BUILD or reload anything', async () => {
    const hits0 = await b.sw('return globalThis.__marker;');
    assert.equal(hits0, 1);
    fs.writeFileSync(path.join(dir, 'Reading', 'MEGATAB.md'), '---\nurls:\n  - http://127.0.0.1:9/never\n---\nHow it works, edited.\n');
    fs.appendFileSync(file('other.md'), 'edited too\n');
    const r = sync({ from: spaces, to: ext });
    assert.equal(r.changed, false, 'BUILD did not change');
    await sleep(3500); // longer than the extension's own BUILD and files polling
    await noReload('after outside .md edits');
  });

  await t.test('C17: an outside write shows within 2 s with no reload, in the rendered view and in the editor, cursor kept', async () => {
    await waitFor(async () => assert.equal(await h1(), 'Notes'));
    const t0 = Date.now();
    fs.appendFileSync(file('notes.md'), 'echo >> from outside\n'); // as `echo >> ~/Spaces/Me/README.md` does
    await waitFor(async () => assert.match(await bodyText(), /echo >> from outside/), { timeout: 2000, interval: 50 });
    const shown = Date.now() - t0;
    t.diagnostic(`outside write to rendered view: ${shown} ms`);
    assert.ok(shown < 2000);
    await noReload('after an outside write');
    // Same in the editor, with nothing unsaved: the text updates, the caret stays where it was
    await clickMode();
    await waitFor(editing);
    await ev(`(() => { const t = document.querySelector('textarea.overtype-input'); t.focus(); t.setSelectionRange(5, 5); return true; })()`);
    fs.appendFileSync(file('notes.md'), 'second outside line\n');
    await waitFor(async () => assert.match(await editorValue(), /second outside line/), { timeout: 2000, interval: 50 });
    assert.equal(await ev(`document.querySelector('textarea.overtype-input').selectionStart`), 5, 'the caret did not move');
    assert.equal(await ev(`!!document.querySelector('#conflict')`), false);
    await noReload('after an outside write while editing');
    // A new file from outside appears in the list
    fs.writeFileSync(file('from-claude.md'), '# From Claude\n');
    await waitFor(async () => assert.ok((await listed()).includes('From Claude')), { timeout: 2000, interval: 50 });
    await done();
  });

  async function listed() {
    return JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('#list .file .title')].map((n) => n.textContent))`));
  }

  await t.test('C18: unsaved text and a changed file: nothing is overwritten, the Board says so, he picks (keep mine / load theirs)', async () => {
    await clickMode();
    await waitFor(editing);
    const theirs = disk('notes.md') + 'THEIRS line\n';
    // Typed, then the file changes underneath before the save pause is over
    await typeAtEnd('MINE line\n');
    fs.writeFileSync(file('notes.md'), theirs);
    await waitFor(async () => assert.equal(await ev(`!!document.querySelector('#conflict')`), true), { timeout: 2000, interval: 50 });
    assert.match(await ev(`document.querySelector('#conflict').innerText`), /Changed on disk:\s*Load theirs\s*Keep mine\s*See theirs/);
    await sleep(1200); // longer than the save pause: still nothing written
    assert.equal(disk('notes.md'), theirs, 'theirs is untouched');
    assert.match(await editorValue(), /MINE line\n$/, 'mine is kept in the editor');
    assert.equal(await ev(`document.querySelector('#conflict pre').textContent`), theirs, 'both are there: theirs one click away');
    // Load theirs
    await ev(`document.querySelector('#load-theirs').click(), true`);
    await waitFor(async () => assert.equal(await editorValue(), theirs));
    assert.equal(await ev(`!!document.querySelector('#conflict')`), false);
    assert.equal(disk('notes.md'), theirs);
    // Again, and this time keep mine
    await typeAtEnd('MINE 2\n');
    fs.writeFileSync(file('notes.md'), theirs + 'THEIRS 2\n');
    await waitFor(async () => assert.equal(await ev(`!!document.querySelector('#conflict')`), true), { timeout: 2000, interval: 50 });
    const mine = await editorValue();
    assert.match(mine, /MINE 2\n$/);
    await ev(`document.querySelector('#keep-mine').click(), true`);
    await waitFor(async () => assert.equal(disk('notes.md'), mine), { timeout: 2000, interval: 50 });
    assert.equal(await ev(`!!document.querySelector('#conflict')`), false);
    // The save the host refuses (stale base) shows the same line and writes nothing
    await ev(`doc.base = 'f'.repeat(64), true`);
    await typeAtEnd('lost?\n');
    await waitFor(async () => assert.equal(await ev(`!!document.querySelector('#conflict')`), true), { timeout: 2000, interval: 50 });
    assert.equal(disk('notes.md'), mine, 'the host refused the stale save');
    assert.equal(await ev(`document.querySelector('#conflict pre').textContent`), mine);
    await ev(`document.querySelector('#load-theirs').click(), true`);
    await waitFor(async () => assert.equal(await editorValue(), mine));
    await noReload('after conflicts');
    await done();
  });

  await t.test('an unsaved draft survives a reload of the Board page', async () => {
    await clickMode();
    await waitFor(editing);
    const onDisk = disk('notes.md');
    await ev("doc.conflict = { reason: 'changed' }, true"); // holds the autosave, so the text is only in the page when it reloads
    await typeAtEnd('draft kept\n');
    assert.equal(disk('notes.md'), onDisk);
    await ev('location.reload(), true');
    await waitFor(async () => assert.match((await editorValue()) || '', /draft kept\n$/), { timeout: 5000 });
    origin = await ev('performance.timeOrigin'); // this reload was on purpose
    assert.equal(await ev(`!!document.querySelector('#conflict')`), false, 'the file did not change meanwhile, so there is nothing to choose');
    await waitFor(async () => assert.equal(disk('notes.md'), onDisk + 'draft kept\n'), { timeout: 3000, interval: 100 });
    await waitFor(async () => assert.equal(await ev(`sessionStorage.length`), 0), { timeout: 2000 }); // saved: the draft is gone
    await done();
  });

  await t.test('C19: New note creates a .md in the space, never overwrites a name, and refuses names that leave the folder', async () => {
    await ev(`document.querySelector('#new').click(), true`);
    await waitFor(async () => assert.equal(await ev(`!!document.querySelector('#new-name')`), true));
    const name = (text) => page(async (s) => {
      await b.send('Runtime.evaluate', { expression: `(() => { const i = document.querySelector('#new-name'); i.focus(); i.select(); return true; })()`, returnByValue: true }, s);
      await b.send('Input.insertText', { text }, s);
      await press(b, s, 'Enter', 'Enter', '\r');
    });
    // A taken name: nothing changes
    const taken = disk('other.md');
    await name('other');
    await waitFor(async () => assert.match(await ev(`document.querySelector('#new-msg').textContent`), /taken/));
    assert.equal(disk('other.md'), taken);
    // A name that tries to leave the folder: nothing is created anywhere
    const before = fs.readdirSync(spaces).sort();
    await name('../escaped');
    await waitFor(async () => assert.match(await ev(`document.querySelector('#new-msg').textContent`), /can't be used/));
    assert.deepEqual(fs.readdirSync(spaces).sort(), before);
    assert.ok(!fs.existsSync(path.join(spaces, 'escaped.md')));
    // A good name: the file is made, listed, opened in the editor
    await name('Call ideas');
    await waitFor(async () => assert.equal(disk('Call ideas.md'), '# Call ideas\n\n'));
    await waitFor(async () => assert.ok((await listed()).includes('Call ideas')));
    await waitFor(editing);
    assert.equal(await ev(`document.querySelector('#list .file.current').title`), 'Call ideas.md');
    await typeAtEnd('First idea.');
    await waitFor(async () => assert.equal(disk('Call ideas.md'), '# Call ideas\n\nFirst idea.'), { timeout: 1500, interval: 50 });
    await done();
    await noReload('after a new note');
  });

  await t.test('screenshots of the editor at 1200 px, light and dark, in the panel palette', async () => {
    await pick('notes.md');
    await clickMode();
    await waitFor(editing);
    const shot = (scheme, out) => page(async (s) => {
      await b.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 760, deviceScaleFactor: 1, mobile: false }, s);
      await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] }, s);
      await sleep(400);
      const colors = (await b.send('Runtime.evaluate', {
        expression: `JSON.stringify({ bg: getComputedStyle(document.body).backgroundColor, text: getComputedStyle(document.querySelector('.overtype-preview')).color, caret: getComputedStyle(document.querySelector('textarea.overtype-input')).caretColor })`,
        returnByValue: true,
      }, s)).result.value;
      const r = await b.send('Page.captureScreenshot', { format: 'png' }, s);
      await b.send('Emulation.setEmulatedMedia', { features: [] }, s);
      await b.send('Emulation.clearDeviceMetricsOverride', {}, s);
      const png = Buffer.from(r.data, 'base64');
      fs.writeFileSync(path.join(__dirname, '..', 'docs', out), png);
      assert.equal(png.readUInt32BE(16), 1200);
      return JSON.parse(colors);
    });
    const light = await shot('light', 'board-edit.png');
    const dark = await shot('dark', 'board-edit-dark.png');
    assert.equal(light.bg, 'rgb(247, 247, 245)');
    assert.equal(dark.bg, 'rgb(28, 28, 30)');
    assert.equal(light.text, 'rgb(43, 43, 43)', 'editor text uses the panel text colour (light)');
    assert.equal(dark.text, 'rgb(232, 232, 230)', 'editor text uses the panel text colour (dark)');
    await done();
  });
});

test('Board without its host says how to install it, instead of showing an empty page', { skip: !bin && 'CHROME is not set', timeout: 120000 }, async (t) => {
  const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'megatabs-ext-'));
  fs.cpSync(EXT, ext, { recursive: true });
  fs.rmSync(path.join(ext, 'board-data'), { recursive: true, force: true });
  const { b, profile, win } = await launch(bin, ext); // no host installed in this profile
  t.after(async () => {
    await cleanup(b, profile)();
    fs.rmSync(ext, { recursive: true, force: true });
  });
  const url = `chrome-extension://${b.extId}/board.html?space=Me`;
  await b.sw('await chrome.tabs.create({ windowId: args[0], url: args[1], active: true });', win, url);
  await waitFor(async () => {
    const text = await withPrefix(b, url, async (s) => (await b.send('Runtime.evaluate', { expression: 'document.querySelector("#banner").textContent', returnByValue: true }, s)).result.value);
    assert.match(text, /host is not installed.*install-host\.js/);
  }, { timeout: 8000 });
});

test('A reload that adds the nativeMessaging permission (0.7.0 -> the current version) leaves the unpacked extension running, with the permission', { skip: !bin && 'CHROME is not set', timeout: 120000 }, async (t) => {
  const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'megatabs-ext-'));
  fs.cpSync(EXT, ext, { recursive: true });
  fs.rmSync(path.join(ext, 'board-data'), { recursive: true, force: true });
  const mfile = path.join(ext, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(mfile, 'utf8'));
  const withPerm = JSON.stringify(m, null, 2);
  m.permissions = m.permissions.filter((p) => p !== 'nativeMessaging');
  m.version = '0.7.0';
  fs.writeFileSync(mfile, JSON.stringify(m, null, 2));
  fs.writeFileSync(path.join(ext, 'BUILD'), 'one\n');
  const { b, profile } = await launch(bin, ext);
  t.after(async () => {
    await cleanup(b, profile)();
    fs.rmSync(ext, { recursive: true, force: true });
  });
  assert.equal(await b.sw('return chrome.runtime.getManifest().permissions.includes("nativeMessaging");'), false, 'starts without it');
  await waitFor(async () => assert.equal(await b.sw("return (await chrome.storage.local.get('buildSeen')).buildSeen;"), 'one'));
  // The files change the way the dev flow changes them: new manifest, new BUILD stamp, the extension reloads itself
  fs.writeFileSync(mfile, withPerm);
  fs.writeFileSync(path.join(ext, 'BUILD'), 'two\n');
  await b.attachWorker();
  assert.equal(await b.sw('return chrome.runtime.getManifest().version;'), JSON.parse(withPerm).version);
  assert.equal(await b.sw('return chrome.runtime.getManifest().permissions.includes("nativeMessaging");'), true, 'the reloaded extension has the permission, no approval step in the way');
  assert.equal(await b.sw('return typeof chrome.runtime.connectNative;'), 'function');
});

// ---------------------------------------------------------------- C11, C12: mega tabs from plain files

test('Mega tabs from MEGATAB.md files: made, URLs opened as tabs, hand-opened tabs untouched, workflow text in the panel', { skip: !bin && 'CHROME is not set', timeout: 300000 }, async (t) => {
  const { sync } = require('../board-sync');
  const { server, hits, base } = await startServer();
  const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'megatabs-ext-'));
  fs.cpSync(EXT, ext, { recursive: true });
  fs.rmSync(path.join(ext, 'board-data'), { recursive: true, force: true });
  // A stand-in for ~/Spaces; the real folder is never read
  const spaces = fs.mkdtempSync(path.join(os.tmpdir(), 'megatabs-spaces-'));
  const mega = (space, name, text) => {
    fs.mkdirSync(path.join(spaces, space, name), { recursive: true });
    fs.writeFileSync(path.join(spaces, space, name, 'MEGATAB.md'), text);
  };
  const file = (urls, body) => `---\nurls:\n${urls.map((u) => `  - ${u}`).join('\n')}\n---\n${body}\n`;
  const HOW = 'Work the pipeline. Move each lead **one step** and write what happened. See [notes](x.md).';
  mega('Me', 'Reading', file([base + 'f1'], `# How Reading works\n\n${HOW}`));
  mega('Me', 'Archive', file([], ''));
  mega('Lab', 'Ideas', file([base + 'i1'], 'Where ideas wait.'));
  sync({ from: spaces, to: ext });

  const { b, profile, win } = await launch(bin, ext);
  t.after(async () => {
    await cleanup(b, profile, server)();
    fs.rmSync(ext, { recursive: true, force: true });
    fs.rmSync(spaces, { recursive: true, force: true });
  });
  const wsNames = () => b.sw("return (await chrome.storage.local.get('workspaces')).workspaces.map((w) => w.name);");
  const mainTabs = () => b.sw('return (await chrome.tabs.query({ windowId: args[0] })).map((t) => ({ id: t.id, url: t.url || t.pendingUrl, active: t.active, status: t.status }));', win);
  const countIn = (urls, name) => urls.filter((u) => u === base + name).length;
  const panelUrl = `chrome-extension://${b.extId}/sidepanel.html?window=${win}`;
  const ui = (expr) => inPage(b, panelUrl, expr);
  // The panel page (a stand-in window here) is closed when the extension reloads itself; the real side panel reloads its page
  const openPanel = async () => {
    await b.sw('await chrome.windows.create({ url: args[0], type: "popup", width: 360, height: 640, focused: false });', panelUrl);
    await waitFor(() => inPage(b, panelUrl, 'document.readyState === "complete" || Promise.reject(new Error("loading"))'));
  };
  const rowText = () => ui(`JSON.stringify([...document.querySelectorAll('section.space')].map((s) => [s.querySelector('.space-head span')?.textContent, [...s.querySelectorAll('.mega .name')].map((n) => n.textContent)]))`).then(JSON.parse);
  // The panel shows one space at a time (C37): bring the space forward through the switcher first
  const showSpace = async (space) => {
    await waitFor(async () => {
      const head = () => ui(`document.querySelector('section.space:not(.open) .space-head span')?.textContent`);
      if ((await head()) === space) return;
      if (!(await ui("!!document.querySelector('.menu')"))) await ui("document.querySelector('.switcher').click(), true");
      await ui(`[...document.querySelectorAll('.menu .item')].find((i) => i.querySelector('.label').textContent === ${JSON.stringify(space)})?.click(), true`);
      assert.equal(await head(), space);
    });
  };
  const click = async (space, name) => {
    await showSpace(space);
    await ui(`[...[...document.querySelectorAll('section.space')].find((s) => s.querySelector('.space-head span').textContent === ${JSON.stringify(space)}).querySelectorAll('.mega')].find((r) => r.querySelector('.name').textContent === ${JSON.stringify(name)}).click(), true`);
    await waitFor(async () => {
      assert.equal(await ui(`document.querySelector('.mega.current .name')?.textContent`), name);
      assert.equal(await b.sw("return !!(await chrome.storage.session.get('pendingSwitch')).pendingSwitch;"), false);
    });
  };

  await t.test('a folder with MEGATAB.md makes the mega tab (once); its URL waits in it, nothing is opened in the window he works in', async () => {
    await waitFor(async () => {
      const n = await wsNames();
      for (const x of ['Me · Reading', 'Me · Archive', 'Lab · Ideas']) assert.ok(n.includes(x), `${x} missing in ${n}`);
    });
    await openPanel();
    // The first-open starter (C8) names the same four; no duplicates
    // (the panel shows one space at a time and switching would open f1: read the mega tabs from storage)
    await waitFor(async () => assert.deepEqual((await wsNames()).filter((x) => x.startsWith('Me · ')).map((x) => x.slice('Me · '.length)).sort(), ['Archive', 'Drafts', 'Reading', 'Writing']));
    const n = await wsNames();
    assert.equal(new Set(n).size, n.length, `duplicate workspaces: ${n}`);
    assert.equal(countIn((await mainTabs()).map((x) => x.url), 'f1'), 0, 'f1 is not in the current window');
    assert.equal(hits.get('f1'), undefined, 'and was not fetched');
  });

  await t.test('switching to the mega tab shows its URL as a tab; others are not touched', async () => {
    await click('Me', 'Reading');
    await waitFor(async () => assert.equal(countIn((await mainTabs()).map((x) => x.url), 'f1'), 1));
    assert.equal(hits.get('f1'), 1);
  });

  await t.test('C12: the current mega tab shows its workflow text, dim and short; none for an empty body', async () => {
    const text = await ui(`document.querySelector('.how')?.textContent || ''`);
    assert.equal(text, `Work the pipeline. Move each lead one step and write what happened. See notes.`, 'plain text: no markdown marks');
    // it sits under the current row, in the Me section, and nowhere else
    assert.equal(await ui(`document.querySelectorAll('.how').length`), 1);
    assert.equal(await ui(`document.querySelector('.mega.current').nextElementSibling.className`), 'how');
    // clamped to three lines, dim, small
    const style = JSON.parse(await ui(`(() => { const s = getComputedStyle(document.querySelector('.how')); return JSON.stringify({ clamp: s.webkitLineClamp, color: s.color, size: s.fontSize }); })()`));
    assert.equal(style.clamp, '3');
    assert.equal(style.size, '12px');
    assert.equal(style.color, 'rgb(98, 98, 94)', 'the panel\'s dim colour');
    // Archive has an empty body: nothing under it
    await click('Me', 'Archive');
    await waitFor(async () => assert.equal(await ui(`document.querySelectorAll('.how').length`), 0));
    await click('Lab', 'Ideas');
    await waitFor(async () => assert.equal(await ui(`document.querySelector('.how')?.textContent`), 'Where ideas wait.'));
    await click('Me', 'Reading');
    // light and dark, at 360 px, for the eye
    const shot = (scheme, out) => b.withPage(panelUrl, async (s) => {
      await b.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 420, deviceScaleFactor: 2, mobile: false }, s);
      await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] }, s);
      const color = (await b.send('Runtime.evaluate', { expression: 'getComputedStyle(document.querySelector(".how")).color', returnByValue: true }, s)).result.value;
      const r = await b.send('Page.captureScreenshot', { format: 'png' }, s);
      await b.send('Emulation.setEmulatedMedia', { features: [] }, s);
      await b.send('Emulation.clearDeviceMetricsOverride', {}, s);
      fs.mkdirSync(path.join(__dirname, '..', 'docs'), { recursive: true });
      fs.writeFileSync(path.join(__dirname, '..', 'docs', out), Buffer.from(r.data, 'base64'));
      return color;
    });
    assert.equal(await shot('light', 'megatab-how.png'), 'rgb(98, 98, 94)');
    assert.equal(await shot('dark', 'megatab-how-dark.png'), 'rgb(154, 154, 150)');
  });

  await t.test('a URL added to the file opens as a tab after sync; a tab he opened by hand is untouched; re-sync adds nothing', async () => {
    const hand = await b.sw('return (await chrome.tabs.create({ windowId: args[0], url: args[1], active: false })).id;', win, base + 'mine');
    await waitFor(async () => assert.equal(countIn((await mainTabs()).map((x) => x.url), 'mine'), 1));
    const before = await mainTabs();
    const hitsBefore = new Map(hits);
    mega('Me', 'Reading', file([base + 'f1', base + 'f2'], `# How Reading works\n\n${HOW}`));
    const r = sync({ from: spaces, to: ext });
    assert.equal(r.changed, false, 'a .md edit never changes BUILD, so nothing reloads');
    const swBefore = await b.sw('globalThis.__keep = 1; return true;');
    assert.equal(swBefore, true);
    await waitFor(async () => assert.equal(countIn((await mainTabs()).map((x) => x.url), 'f2'), 1), { timeout: 20000 }); // picked up by the extension polling megatabs.json
    assert.equal(await b.sw('return globalThis.__keep === 1;'), true, 'the extension was not reloaded');
    const after = await mainTabs();
    for (const x of before) assert.ok(after.some((y) => y.id === x.id), `tab ${x.url} was closed`);
    assert.ok(after.some((x) => x.id === hand), 'the hand-opened tab is still there');
    assert.equal(after.filter((x) => x.active).length, 1);
    assert.equal(after.find((x) => x.active).id, before.find((x) => x.active).id, 'the tab he is on stays the active one');
    for (const k of ['f1', 'mine']) assert.equal(hits.get(k), hitsBefore.get(k), `${k} was loaded again`);
    // Nothing changed on disk: no reload; and even a reload would add nothing
    assert.equal(sync({ from: spaces, to: ext }).changed, false);
    const n = (await mainTabs()).length;
    await b.sw('return applyMegaTabs();');
    await b.sw('return applyMegaTabs();');
    assert.equal((await mainTabs()).length, n, 'applying the same files again opens nothing');
    assert.equal(countIn((await mainTabs()).map((x) => x.url), 'f2'), 1);
  });

  await t.test('a URL added to a mega tab that is not shown opens in its stash window; the window he works in is not touched', async () => {
    await openPanel();
    await click('Lab', 'Ideas'); // Reading is now stashed
    await waitFor(async () => assert.equal(countIn((await mainTabs()).map((x) => x.url), 'i1'), 1));
    const main = await mainTabs();
    const hitsBefore = new Map(hits);
    mega('Me', 'Reading', file([base + 'f1', base + 'f2', base + 'f3'], `# How Reading works\n\n${HOW}`));
    sync({ from: spaces, to: ext });
    const leads = (await b.sw("return (await chrome.storage.local.get('workspaces')).workspaces.find((w) => w.name === 'Me · Reading').id;"));
    await waitFor(async () => {
      const where = await b.sw(`const out = [];
        for (const w of await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] })) {
          for (const t of w.tabs) if ((t.url || t.pendingUrl) === args[0]) out.push({ windowId: w.id, stash: w.tabs.some((x) => (x.url || x.pendingUrl || '').endsWith('stash.html#' + args[1])) });
        }
        return out;`, base + 'f3', leads);
      assert.deepEqual(where.map((x) => x.stash), [true], JSON.stringify(where));
    }, { timeout: 20000 });
    const after = await mainTabs();
    assert.deepEqual(after.map((x) => x.url).sort(), main.map((x) => x.url).sort(), 'his window is unchanged');
    for (const k of ['f1', 'f2', 'i1']) assert.equal(hits.get(k), hitsBefore.get(k), `${k} was loaded again`);
    assert.deepEqual(b.errors, [], 'unhandled errors in the service worker');
  });

  await t.test('a new folder with MEGATAB.md makes a new mega tab after sync; no tab group was made', async () => {
    mega('Me', 'Research', file([], 'Reading and notes.'));
    sync({ from: spaces, to: ext });
    await waitFor(async () => assert.ok((await wsNames()).includes('Me · Research')), { timeout: 20000 });
    await openPanel();
    await showSpace('Me');
    await waitFor(async () => assert.ok((await rowText()).find(([s]) => s === 'Me')[1].includes('Research')));
    assert.deepEqual(await b.sw('return chrome.tabGroups.query({});'), []);
  });
});

// ---------------------------------------------------------------- C14: Option+W toggles the panel

test('Option+W toggle: an open side panel is closed, a closed one is opened (the browser only allows opening on a real key press)', { skip: !bin && 'CHROME is not set', timeout: 180000 }, async (t) => {
  const { server } = await startServer();
  const { b, profile, win } = await launch(bin, EXT);
  t.after(cleanup(b, profile, server));
  const panels = () => b.sw('return (await chrome.runtime.getContexts({ contextTypes: ["SIDE_PANEL"] })).length;');
  assert.equal(await b.sw('return typeof chrome.sidePanel.close;'), 'function', 'this Chrome can close a side panel');

  // sidePanel.open() needs a user gesture. A script cannot make one in the extension's service
  // worker, so the test makes a real mouse click in an extension page that opens the panel.
  const helper = `chrome-extension://${b.extId}/board.html?space=toggle`;
  await b.sw('await chrome.tabs.create({ windowId: args[0], url: args[1], active: true });', win, helper);
  const clickOpen = () => b.withPage(helper, async (s) => {
    await b.send('Runtime.evaluate', { expression: `document.body.innerHTML = '<button id=go style="position:fixed;left:10px;top:10px;width:200px;height:100px">go</button>';
      window.__r = 'none'; document.getElementById('go').onclick = async () => { try { await chrome.sidePanel.open({ windowId: ${win} }); window.__r = 'opened'; } catch (e) { window.__r = 'ERR ' + e.message; } }; true` }, s);
    await b.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 50, y: 50, button: 'left', clickCount: 1 }, s);
    await b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 50, y: 50, button: 'left', clickCount: 1 }, s);
    await waitFor(async () => assert.equal((await b.send('Runtime.evaluate', { expression: 'window.__r', returnByValue: true }, s)).result.value, 'opened'));
  });

  await t.test('open panel -> the toggle closes it', async () => {
    assert.equal(await panels(), 0);
    await clickOpen();
    await waitFor(async () => assert.equal(await panels(), 1));
    assert.equal(await b.sw('return togglePanel(args[0]);', win), 'closed');
    await waitFor(async () => assert.equal(await panels(), 0));
  });

  await t.test('closed panel -> the toggle asks the browser to open it (refused here: no real key press)', async () => {
    await assert.rejects(b.sw('return togglePanel(args[0]);', win), /user gesture/);
    assert.equal(await panels(), 0);
  });

  await t.test('and again: open, toggle closes (second time over)', async () => {
    await clickOpen();
    await waitFor(async () => assert.equal(await panels(), 1));
    assert.equal(await b.sw('return togglePanel(args[0]);', win), 'closed');
    await waitFor(async () => assert.equal(await panels(), 0));
  });

  await t.test('the key is bound to toggle-panel in the manifest the browser loaded', async () => {
    const cmds = await b.sw('return chrome.commands.getAll();');
    const toggle = cmds.find((c) => c.name === 'toggle-panel');
    assert.ok(toggle, JSON.stringify(cmds.map((c) => c.name)));
    assert.equal(toggle.shortcut, process.platform === 'darwin' ? '⌥W' : 'Alt+W');
  });
});

// ---------------------------------------------------------------- C22-C25: the Canvas room

test('Board Canvas room: open a .canvas, drag / add / connect / delete saved to the file, outside edits merged, pen strokes kept in the file', { skip: !bin && 'CHROME is not set', timeout: 300000 }, async (t) => {
  const jcm = await import('../canvas/src/jsoncanvas.mjs');
  const { sync } = require('../board-sync');
  const { server } = await startServer();
  const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'megatabs-ext-'));
  fs.cpSync(EXT, ext, { recursive: true });
  fs.rmSync(path.join(ext, 'board-data'), { recursive: true, force: true });
  const spaces = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'megatabs-spaces-')));
  const dir = path.join(spaces, 'Me');
  fs.mkdirSync(path.join(dir, 'Reading'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Reading', 'MEGATAB.md'), '---\nurls:\n  - http://127.0.0.1:9/never\n---\nHow it works.\n');
  fs.writeFileSync(path.join(dir, 'README.md'), '# Readme heading\n\nThe space.\n');
  const FIXTURE = {
    nodes: [
      { id: 'g1', type: 'group', x: -40, y: -64, width: 700, height: 410, label: 'Phase one' },
      { id: 't1', type: 'text', x: 0, y: 0, width: 240, height: 110, text: '# Reading\n\nThe reading list, **12 articles**.' },
      { id: 't2', type: 'text', x: 320, y: 0, width: 240, height: 110, text: 'Second card', color: '4' },
      { id: 'f1', type: 'file', x: 0, y: 200, width: 240, height: 72, file: 'README.md' },
      { id: 'f2', type: 'file', x: 320, y: 200, width: 240, height: 72, file: 'Reading/MEGATAB.md' },
      { id: 'l1', type: 'link', x: 640, y: 120, width: 240, height: 72, url: 'https://example.com/priorities' },
    ],
    edges: [
      { id: 'e1', fromNode: 't1', fromSide: 'right', toNode: 't2', toSide: 'left' },
      { id: 'e2', fromNode: 't1', toNode: 'f1' },
      { id: 'e3', fromNode: 't2', toNode: 'l1', toEnd: 'none' },
    ],
    'x-note': 'a top-level field this room does not know',
  };
  const canvasFile = path.join(dir, 'Board.canvas');
  fs.writeFileSync(canvasFile, JSON.stringify(FIXTURE, null, '\t'));
  sync({ from: spaces, to: ext });
  const buildFile = path.join(ext, 'BUILD');
  const buildBefore = fs.readFileSync(buildFile, 'utf8');

  const { b, profile, win } = await launch(bin, ext, { spaces });
  t.after(async () => {
    await cleanup(b, profile, server)();
    fs.rmSync(ext, { recursive: true, force: true });
    fs.rmSync(spaces, { recursive: true, force: true });
  });

  const boardUrl = `chrome-extension://${b.extId}/board.html?space=Me`;
  await b.sw('await chrome.tabs.create({ windowId: args[0], url: args[1], active: true });', win, boardUrl);
  const page = (fn) => withPrefix(b, boardUrl, async (s) => {
    await b.send('Emulation.setFocusEmulationEnabled', { enabled: true }, s);
    return fn(s);
  });
  const ev = (expr) => page(async (s) => {
    const r = await b.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, s);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  });
  const read = () => JSON.parse(fs.readFileSync(canvasFile, 'utf8'));
  const node = (id, doc = read()) => doc.nodes.find((n) => n.id === id);
  const tmpFiles = () => fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'));
  const box = async (sel) => JSON.parse(await ev(`(() => { const r = document.querySelector(${JSON.stringify(sel)})?.getBoundingClientRect(); return r ? JSON.stringify({ x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 }) : 'null'; })()`));
  const zoom = () => ev(`new DOMMatrix(getComputedStyle(document.querySelector('.react-flow__viewport')).transform).a`);
  const nodeSel = (id) => `.react-flow__node[data-id="${id}"]`;
  const count = (sel) => ev(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
  // A mouse as a person uses it: press, move in steps with the button down, release
  const drag = (from, to, steps = 8) => page(async (s) => {
    const m = (type, x, y, extra = {}) => b.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra }, s);
    await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, button: 'none', buttons: 0 }, s);
    await m('mousePressed', from.x, from.y);
    for (let i = 1; i <= steps; i++) await m('mouseMoved', from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
    await m('mouseReleased', to.x, to.y);
  });
  const stroke = (points) => page(async (s) => {
    const m = (type, p, buttons, button = buttons ? 'left' : 'none') => b.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button, buttons, clickCount: 1 }, s);
    await m('mouseMoved', points[0], 0);
    await m('mousePressed', points[0], 1);
    for (const p of points.slice(1)) await m('mouseMoved', p, 1);
    await m('mouseReleased', points.at(-1), 0, 'left');
  });
  const click = (p) => page(async (s) => {
    await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none', buttons: 0 }, s);
    await b.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1 }, s);
    await b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', buttons: 0, clickCount: 1 }, s);
  });
  const key = (k, code, text) => page((s) => press(b, s, k, code, text));
  const room = (name) => ev(`document.querySelector('#room-${name}').click(), true`);

  // Starts in Notes (no canvas in the address); the switch is the only way to the Canvas room
  await waitFor(async () => assert.ok((await count('#list .file')) >= 1));
  const origin = await ev('performance.timeOrigin');
  assert.equal(await b.sw('globalThis.__marker = 1; return true;'), true);
  const noReload = async (why) => {
    assert.equal(await ev('performance.timeOrigin'), origin, `${why}: the Board page was not reloaded`);
    assert.equal(await b.sw('return globalThis.__marker === 1;'), true, `${why}: the extension was not reloaded`);
    assert.equal(fs.readFileSync(buildFile, 'utf8'), buildBefore, `${why}: BUILD unchanged`);
  };

  await t.test('C22: the switch opens the Canvas room; a fixture .canvas shows its 6 nodes (text, file, link, group) and 3 edges; light and dark', async () => {
    assert.equal(await ev(`document.querySelector('#room-notes').getAttribute('aria-selected')`), 'true');
    assert.equal(await count('.react-flow'), 0, 'no canvas code runs in Notes');
    assert.equal(await ev(`document.querySelectorAll('.rooms button').length`), 2, 'one quiet switch, two words');
    await room('canvas');
    await waitFor(async () => {
      assert.equal(await count('.react-flow__node'), 6);
      assert.equal(await count('.react-flow__edge'), 3);
    });
    assert.deepEqual(JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('#list .file')].map((f) => f.title))`)), ['Board.canvas'], 'the list shows canvases in this room');
    assert.equal(await ev(`document.querySelector('#new').textContent`), 'New canvas');
    assert.equal(await ev(`document.querySelector('#room-canvas').getAttribute('aria-selected')`), 'true');
    assert.equal(await ev(`decodeURIComponent(location.hash)`), '#Board.canvas');
    assert.equal(await count('.cv-text'), 2);
    assert.equal(await count('.cv-file'), 2);
    assert.equal(await count('.cv-link'), 1);
    assert.equal(await count('.cv-group'), 1);
    assert.equal(await ev(`document.querySelector('.cv-group-label').textContent`), 'Phase one');
    assert.equal(await ev(`document.querySelector(${JSON.stringify(nodeSel('t1') + ' .md h1')})?.textContent`), 'Reading', 'markdown in a card is rendered');
    assert.match(await ev(`document.querySelector(${JSON.stringify(nodeSel('t1') + ' .md strong')})?.textContent`), /38 trades/);
    assert.equal(await ev(`document.querySelector('.cv-file[data-file="README.md"] .cv-open').textContent`), 'Readme heading', 'a file card shows the note title');
    assert.equal(await ev(`document.querySelector(${JSON.stringify(nodeSel('t2') + ' .cv-card')}).getAttribute('data-color')`), '4');
    assert.equal(await ev(`document.querySelector('.cv-link a').href`), 'https://example.com/priorities');
    assert.equal(await ev(`document.querySelector('.cv-link a').rel`), 'noopener noreferrer');
    // Nothing was fetched: every resource the page loaded is part of the extension
    assert.deepEqual(JSON.parse(await ev(`JSON.stringify(performance.getEntriesByType('resource').map((r) => r.name).filter((n) => !n.startsWith('chrome-extension://')))`)), []);
    assert.deepEqual(read(), { ...FIXTURE }, 'opening a canvas changes no byte of it');
    assert.equal(fs.readFileSync(canvasFile, 'utf8'), JSON.stringify(FIXTURE, null, '\t'));
    // Its calm palette follows the Board's, light and dark
    const colors = (scheme) => page(async (s) => {
      await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] }, s);
      await sleep(300);
      const r = await b.send('Runtime.evaluate', { expression: `JSON.stringify({ pane: getComputedStyle(document.querySelector('.react-flow')).backgroundColor, card: getComputedStyle(document.querySelector('.cv-text')).backgroundColor, text: getComputedStyle(document.querySelector('.cv-text')).color })`, returnByValue: true }, s);
      await b.send('Emulation.setEmulatedMedia', { features: [] }, s);
      return JSON.parse(r.result.value);
    });
    assert.deepEqual(await colors('light'), { pane: 'rgb(247, 247, 245)', card: 'rgb(255, 255, 255)', text: 'rgb(43, 43, 43)' });
    assert.deepEqual(await colors('dark'), { pane: 'rgb(28, 28, 30)', card: 'rgb(46, 46, 49)', text: 'rgb(232, 232, 230)' });
    // Back to Notes and to the Canvas again: the same canvas
    await room('notes');
    await waitFor(async () => assert.equal(await count('.react-flow'), 0));
    assert.ok((await count('#doc .md')) > 0);
    await room('canvas');
    await waitFor(async () => assert.equal(await count('.react-flow__node'), 6));
    await noReload('after opening the room');
  });

  await t.test('C23: drag a card, add a text card, connect two cards, delete: each change is in the file (valid JSON Canvas, atomic), no reload', async () => {
    // Drag
    const before = node('t1');
    const z = await zoom();
    const b1 = await box(nodeSel('t1') + ' .cv-card');
    const ino = fs.statSync(canvasFile).ino;
    const t0 = Date.now();
    await drag({ x: b1.cx, y: b1.cy + 30 }, { x: b1.cx + 80, y: b1.cy + 30 + 50 });
    await waitFor(async () => assert.notEqual(node('t1').x, before.x), { timeout: 2500, interval: 50 });
    t.diagnostic(`drag to bytes on disk: ${Date.now() - t0} ms`);
    const moved = node('t1');
    // the first step of the mouse starts the drag, so up to one step (10 px) of the 80 is not counted
    assert.ok(moved.x - before.x <= 80 / z + 2 && moved.x - before.x >= 70 / z - 2 && moved.y - before.y <= 50 / z + 2 && moved.y - before.y >= 40 / z - 2, `moved by (${moved.x - before.x}, ${moved.y - before.y}) at zoom ${z}`);
    assert.ok(Number.isInteger(moved.x) && Number.isInteger(moved.y));
    assert.notEqual(fs.statSync(canvasFile).ino, ino, 'replaced by rename');
    assert.deepEqual(tmpFiles(), []);
    assert.deepEqual(jcm.validate(read()), []);
    assert.equal(read()['x-note'], 'a top-level field this room does not know', 'a field this room does not know is kept');
    assert.equal(node('t2').color, '4', 'the other cards are as they were');
    await noReload('after a drag');

    // Add a text card with the T key, type, Esc
    await key('t', 'KeyT', 't');
    await waitFor(async () => assert.equal(await ev(`document.activeElement?.tagName`), 'TEXTAREA'));
    await page((s) => b.send('Input.insertText', { text: 'Call him back 🚀' }, s));
    await key('Escape', 'Escape');
    await waitFor(async () => assert.equal(read().nodes.length, 7), { timeout: 2500, interval: 50 });
    const card = read().nodes.at(-1);
    assert.deepEqual([card.type, card.text], ['text', 'Call him back 🚀']);
    assert.ok([card.x, card.y, card.width, card.height].every(Number.isInteger));
    assert.deepEqual(jcm.validate(read()), []);
    await waitFor(async () => assert.equal(await ev(`document.querySelector(${JSON.stringify(nodeSel(card.id) + ' .md')})?.textContent.trim()`), 'Call him back 🚀'));

    // Connect: from the new card's dot to the dot on the left of "Second card"
    await ev(`document.querySelector(${JSON.stringify(nodeSel(card.id))}).dispatchEvent(new MouseEvent('mouseover', { bubbles: true })), true`);
    const from = await box(`${nodeSel(card.id)} .react-flow__handle[data-handleid="top"]`);
    const to = await box(`${nodeSel('t2')} .react-flow__handle[data-handleid="bottom"]`);
    await drag({ x: from.cx, y: from.cy }, { x: to.cx, y: to.cy }, 12);
    await waitFor(async () => assert.equal(read().edges.length, 4), { timeout: 2500, interval: 50 });
    const edge = read().edges.at(-1);
    assert.equal(edge.fromNode, card.id);
    assert.equal(edge.toNode, 't2');
    assert.deepEqual([edge.fromSide, edge.toSide], ['top', 'bottom']);
    assert.deepEqual(jcm.validate(read()), []);
    assert.equal(await count('.react-flow__edge'), 4);

    // Delete: click the card to select it, Backspace
    const c = await box(`${nodeSel(card.id)} .cv-card`);
    await click({ x: c.cx, y: c.cy });
    await waitFor(async () => assert.equal(await ev(`document.querySelector(${JSON.stringify(nodeSel(card.id))}).classList.contains('selected')`), true));
    await key('Backspace', 'Backspace');
    await waitFor(async () => {
      assert.equal(read().nodes.length, 6);
      assert.equal(read().edges.length, 3, 'its edge went with it');
    }, { timeout: 2500, interval: 50 });
    assert.equal(read().nodes.some((n) => n.id === card.id), false);
    assert.deepEqual(jcm.validate(read()), []);
    await waitFor(async () => assert.equal(await count('.react-flow__node'), 6));
    assert.deepEqual(tmpFiles(), []);
    await noReload('after drag, add, connect, delete');
    await waitFor(async () => assert.equal(await ev(`document.querySelector('.cv-status').textContent`), 'Saved'));
  });

  await t.test('C24: an outside edit shows within 2 s and keeps his unsaved move; a file card opens its note in Notes', async () => {
    const session = `canvasHandle.session`;
    await ev(`${session}.hold = true, true`); // keeps his next move unsaved, as a move is for the first 300 ms
    const z = await zoom();
    const t2 = node('t2');
    const b2 = await box(nodeSel('t2') + ' .cv-card');
    await drag({ x: b2.cx, y: b2.cy + 30 }, { x: b2.cx + 60, y: b2.cy + 30 + 40 });
    await waitFor(async () => assert.equal(await ev(`${session}.dirty`), true));
    await waitFor(async () => assert.equal(await ev(`document.querySelector('.cv-status').textContent`), 'Unsaved'));
    const movedBox = await box(nodeSel('t2'));
    assert.deepEqual(node('t2'), t2, 'his move is not in the file yet');
    // The AI adds a card and an edge, and edits another card's text, all in one write of the file
    const theirs = read();
    theirs.nodes.push({ id: 'ai1', type: 'text', x: 320, y: -140, width: 240, height: 90, text: 'Added by the AI' });
    theirs.edges.push({ id: 'ai-e', fromNode: 't2', toNode: 'ai1', fromSide: 'top', toSide: 'bottom' });
    node('t1', theirs).text = '# Reading\n\nRewritten by the AI.';
    const t0 = Date.now();
    fs.writeFileSync(canvasFile, JSON.stringify(theirs, null, '\t'));
    await waitFor(async () => assert.equal(await count('.react-flow__node'), 7), { timeout: 2000, interval: 50 });
    t.diagnostic(`outside write to the card on screen: ${Date.now() - t0} ms`);
    assert.ok(Date.now() - t0 < 2000);
    await waitFor(async () => assert.match(await ev(`document.querySelector(${JSON.stringify(nodeSel('t1') + ' .md')}).textContent`), /Rewritten by the AI/), { timeout: 2000, interval: 50 });
    await waitFor(async () => assert.equal(await count('.react-flow__edge'), 4));
    // His move is still on screen, still unsaved
    const after = await box(nodeSel('t2'));
    assert.ok(Math.abs(after.x - movedBox.x) < 1 && Math.abs(after.y - movedBox.y) < 1, 'his moved card did not jump back');
    assert.equal(await ev(`${session}.dirty`), true);
    assert.deepEqual(node('t2'), t2, 'the file still has the old position');
    await noReload('after an outside edit');
    // Releasing the hold writes both: his move on top of their card, edge and text
    await ev(`${session}.release(), true`);
    await waitFor(async () => assert.notEqual(node('t2').x, t2.x), { timeout: 2500, interval: 50 });
    const fin = read();
    assert.ok(node('t2', fin).x - t2.x <= 60 / z + 2 && node('t2', fin).x - t2.x >= 50 / z - 2 && node('t2', fin).y - t2.y > 20 / z, 'his move');
    assert.equal(node('ai1', fin).text, 'Added by the AI', 'their card is still there');
    assert.ok(fin.edges.some((e) => e.id === 'ai-e'), 'their edge is still there');
    assert.match(node('t1', fin).text, /Rewritten by the AI/, 'their edit is still there');
    assert.deepEqual(jcm.validate(fin), []);
    assert.equal(await ev(`!!document.querySelector('#conflict')`), false, 'no question was asked');

    // A file card pointing at a .md opens it in Notes
    await ev(`document.querySelector('.cv-file[data-file="README.md"] .cv-open').click(), true`);
    await waitFor(async () => assert.equal(await ev(`document.querySelector('#doc .md h1')?.textContent`), 'Readme heading'));
    assert.equal(await ev(`document.querySelector('#room-notes').getAttribute('aria-selected')`), 'true');
    assert.equal(await ev(`decodeURIComponent(location.hash)`), '#README.md');
    assert.equal(await count('.react-flow'), 0);
    await room('canvas');
    await waitFor(async () => assert.equal(await count('.react-flow__node'), 7));
    // A file in a folder (the host only serves top-level files) opens in Cursor
    assert.equal(await ev(`document.querySelector('.cv-file[data-file="Reading/MEGATAB.md"] a.cv-open').getAttribute('href')`), 'cursor://file' + encodeURI(path.join(dir, 'Reading', 'MEGATAB.md')));
    await noReload('after opening a note from the canvas');
  });

  await t.test('C25: the pen draws strokes into the file (extension field x-strokes); they survive reopening; the eraser removes one', async () => {
    await ev(`document.querySelector('[data-tool-button="pen"]').click(), true`);
    assert.equal(await ev(`document.querySelector('[data-tool-button="pen"]').getAttribute('aria-pressed')`), 'true');
    const area = await box('.cv');
    // A loose circle in the empty part of the canvas, below the cards
    const cx = area.x + area.w - 190;
    const cy = area.y + area.h - 150;
    const pts = Array.from({ length: 33 }, (_, i) => ({ x: cx + 60 * Math.cos((i / 32) * 2 * Math.PI), y: cy + 40 * Math.sin((i / 32) * 2 * Math.PI) }));
    const z = await zoom();
    const m = JSON.parse(await ev(`(() => { const m = new DOMMatrix(getComputedStyle(document.querySelector('.react-flow__viewport')).transform); return JSON.stringify({ tx: m.e, ty: m.f }); })()`));
    await stroke(pts);
    await waitFor(async () => assert.equal(read()['x-strokes']?.length, 1), { timeout: 2500, interval: 50 });
    const s = read()['x-strokes'][0];
    assert.equal(typeof s.id, 'string');
    assert.ok(s.points.length >= 8 && s.points.length <= pts.length, `${s.points.length} points after thinning`);
    assert.ok(s.points.every((p) => p.length === 2 && p.every(Number.isFinite)));
    const flowX = (pts[0].x - area.x - m.tx) / z;
    const flowY = (pts[0].y - area.y - m.ty) / z;
    assert.ok(Math.abs(s.points[0][0] - flowX) < 1.5 && Math.abs(s.points[0][1] - flowY) < 1.5, 'stored in canvas coordinates');
    assert.deepEqual(jcm.validate(read()), [], 'the strokes are an extension: every other reader still sees a valid JSON Canvas');
    assert.equal(read().nodes.length, 7, 'the cards are untouched by drawing');
    assert.equal(await count('.cv-stroke'), 1);
    await noReload('after drawing');

    // Reopen: reload the page (the address keeps the canvas), the stroke is drawn again from the file
    await ev('location.reload(), true');
    await waitFor(async () => assert.equal(await count('.react-flow__node'), 7), { timeout: 8000 });
    await waitFor(async () => assert.equal(await count('.cv-stroke'), 1));
    assert.match(await ev(`document.querySelector('.cv-stroke').getAttribute('d')`), /^M/);
    // Moving a card afterwards keeps the stroke in the file
    const x0 = node('t1').x;
    const c = await box(nodeSel('t1') + ' .cv-card');
    await drag({ x: c.cx, y: c.cy + 30 }, { x: c.cx - 30, y: c.cy + 30 });
    await waitFor(async () => assert.ok(node('t1').x < x0), { timeout: 2500, interval: 50 });
    assert.equal(read()['x-strokes'].length, 1);
    assert.deepEqual(read()['x-strokes'][0], s);

    // The eraser: pressing on the stroke removes it, from the screen and the file
    await ev(`document.querySelector('[data-tool-button="eraser"]').click(), true`);
    const p0 = pts[0];
    await page(async (sess) => {
      await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p0.x, y: p0.y, button: 'none', buttons: 0 }, sess);
      await b.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p0.x, y: p0.y, button: 'left', buttons: 1, clickCount: 1 }, sess);
      await b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p0.x, y: p0.y, button: 'left', buttons: 0, clickCount: 1 }, sess);
    });
    await waitFor(async () => assert.equal(read()['x-strokes'], undefined, 'no strokes: the field is left out'), { timeout: 2500, interval: 50 });
    assert.equal(await count('.cv-stroke'), 0);
    assert.deepEqual(jcm.validate(read()), []);
    // Draw one again for the picture
    await ev(`document.querySelector('[data-tool-button="pen"]').click(), true`);
    await stroke(pts);
    await waitFor(async () => assert.equal(read()['x-strokes']?.length, 1), { timeout: 2500, interval: 50 });
    await ev(`document.querySelector('[data-tool-button="select"]').click(), true`);
    assert.deepEqual(tmpFiles(), []);
  });

  await t.test('screenshots of the Canvas at 1200 px, light and dark', async () => {
    const shot = (scheme, out) => page(async (s) => {
      await b.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 760, deviceScaleFactor: 1, mobile: false }, s);
      await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] }, s);
      await sleep(300);
      await b.send('Runtime.evaluate', { expression: `document.querySelector('.react-flow__controls-fitview').click(), true`, returnByValue: true }, s);
      await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5, button: 'none', buttons: 0 }, s);
      await sleep(700);
      const r = await b.send('Page.captureScreenshot', { format: 'png' }, s);
      await b.send('Emulation.setEmulatedMedia', { features: [] }, s);
      await b.send('Emulation.clearDeviceMetricsOverride', {}, s);
      const png = Buffer.from(r.data, 'base64');
      fs.writeFileSync(path.join(__dirname, '..', 'docs', out), png);
      assert.equal(png.readUInt32BE(16), 1200);
    });
    await shot('light', 'canvas.png');
    await shot('dark', 'canvas-dark.png');
  });
});
