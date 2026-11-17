'use strict';
// One Chromium (Chrome for Testing) with the extension in a chosen browser language, and every page a person sees
// opened in it: the side panel (as a small window; the real panel is not scriptable), home, settings, and the Board
// on a temp stand-in for ~/Spaces with a note and a canvas. Shared by the right-to-left test and the axe test.
// His real Chrome is never touched; the native host is installed into the TEST profile only.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { Chromium, waitFor } = require('./chromium');
const { install } = require('../install-host');

const SPACE = 'Me';

function server() {
  const s = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(`<!doctype html><title>${req.url.slice(1)}</title><p>page</p>`);
  });
  return new Promise((ok) => s.listen(0, '127.0.0.1', () => ok(s)));
}

async function evalIn(b, urlPrefix, expression) {
  const target = await waitFor(async () => {
    const { targetInfos } = await b.send('Target.getTargets');
    const x = targetInfos.find((i) => i.type === 'page' && i.url.startsWith(urlPrefix));
    if (!x) throw new Error(`no page starting with ${urlPrefix}`);
    return x;
  });
  const { sessionId } = await b.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  try {
    await b.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId);
    const r = await b.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  } finally {
    await b.send('Target.detachFromTarget', { sessionId }).catch(() => {});
  }
}

// Returns { b, ids, urls, ev(page, expr), session(page, fn({ev}), {dark}), room(name), close() }
async function openAll(bin, { lang } = {}) {
  const srv = await server();
  const spaces = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'megatabs-spaces-')));
  const dir = path.join(spaces, SPACE);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), '# Me\n\nA note with a [link](https://example.com), `code` and a list:\n\n- one\n- two\n');
  fs.writeFileSync(path.join(dir, 'Alpha.md'), '# Alpha\n\nfirst\n');
  fs.writeFileSync(
    path.join(dir, 'Board.canvas'),
    JSON.stringify({
      nodes: [
        { id: 'c1', type: 'text', x: 0, y: 0, width: 240, height: 100, text: '# First card' },
        { id: 'c2', type: 'text', x: 320, y: 0, width: 240, height: 100, text: 'Second card' },
      ],
      edges: [{ id: 'e1', fromNode: 'c1', fromSide: 'right', toNode: 'c2', toSide: 'left' }],
    }),
  );
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'megatabs-chromium-'));
  const b = new Chromium(bin, profile);
  install({ id: b.extId, manifestDir: path.join(profile, 'NativeMessagingHosts'), wrapperDir: path.join(profile, 'board-host'), spaces });
  await b.launch({ restore: 'newtab', lang });
  const win = await waitFor(async () => {
    const { windowWs } = await b.sw("return chrome.storage.session.get('windowWs');");
    const id = Object.keys(windowWs || {})[0];
    assert.ok(id, 'no main window assigned yet');
    return Number(id);
  });
  const root = `chrome-extension://${b.extId}/`;
  const urls = {
    panel: `${root}sidepanel.html?window=${win}`,
    home: `${root}home.html?window=${win}`,
    settings: `${root}settings.html`,
    board: `${root}board.html?space=${SPACE}`,
  };
  await b.sw('await chrome.windows.create({ url: args[0], type: "popup", width: 360, height: 640, focused: false });', urls.panel);
  for (const k of ['home', 'settings', 'board']) await b.sw('await chrome.tabs.create({ windowId: args[0], url: args[1], active: false });', win, urls[k]);
  const ev = (page, expr) => evalIn(b, urls[page], expr);
  for (const k of Object.keys(urls)) await waitFor(() => ev(k, 'document.readyState === "complete" || Promise.reject(new Error("loading"))'));
  await waitFor(async () => assert.ok((await ev('board', "document.querySelectorAll('#list .file').length")) >= 2));
  await waitFor(async () => assert.ok((await ev('home', "document.querySelectorAll('#tiles .tile').length")) >= 1));
  // fn(send) runs inside one DevTools session of the page, so an emulated colour scheme lasts as long as fn does
  const session = async (page, fn, { dark = false } = {}) => {
    const target = await waitFor(async () => {
      const { targetInfos } = await b.send('Target.getTargets');
      const x = targetInfos.find((i) => i.type === 'page' && i.url.startsWith(urls[page]));
      if (!x) throw new Error('page gone');
      return x;
    });
    const { sessionId } = await b.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    try {
      await b.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId);
      await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] }, sessionId);
      const ev = async (expression) => {
        const r = await b.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
        return r.result.value;
      };
      return await fn(ev);
    } finally {
      await b.send('Target.detachFromTarget', { sessionId }).catch(() => {});
    }
  };
  const room = async (name) => {
    await waitFor(async () => {
      await ev('board', `document.querySelector('#room-${name}').click(), true`);
      assert.equal(await ev('board', `document.querySelector('#room-${name}').getAttribute('aria-selected')`), 'true');
    });
  };
  const close = async () => {
    await b.kill();
    srv.close();
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    fs.rmSync(spaces, { recursive: true, force: true });
  };
  return { b, urls, ev, room, session, close, dir };
}

module.exports = { openAll, evalIn, SPACE };
