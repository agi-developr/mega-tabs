'use strict';
// Mega tabs from plain files (C11, C13) and the panel toggle (C14), without a real browser:
// board-sync turns ~/Spaces/<space>/<mega tab>/MEGATAB.md into board-data/megatabs.json, and
// the extension makes mega tabs and opens their URLs from it. Every test uses temp folders;
// the real ~/Spaces is never read or written.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { sync, parseMegaTab, seedMegaTabs, EXAMPLE_MEGAS } = require('../board-sync');
const { setup, ok, url } = require('./harness');

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const rm = (...dirs) => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true }));

function mega(spaces, space, name, text) {
  const dir = path.join(spaces, space, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'MEGATAB.md'), text);
}

const file = (urls, body = '') => `---\nurls:\n${urls.map((u) => `  - ${u}`).join('\n')}\n---\n${body}\n`;

// ---------------------------------------------------------------- C11: sync output

test('MEGATAB.md: front matter urls (list, inline, quotes, comments) and body; only web addresses are kept', () => {
  assert.deepEqual(parseMegaTab('---\nurls:\n  - https://a.test/x # note\n  - "http://b.test"\n  - javascript:alert(1)\n  - ftp://c.test\n  - file:///etc/passwd\n---\nHello\n\nworld\n'), {
    urls: ['https://a.test/x', 'http://b.test'],
    body: 'Hello\n\nworld',
  });
  assert.deepEqual(parseMegaTab('---\nurls: [https://a.test, https://b.test]\n---\n'), { urls: ['https://a.test', 'https://b.test'], body: '' });
  assert.deepEqual(parseMegaTab('no front matter\n'), { urls: [], body: 'no front matter' });
  assert.deepEqual(parseMegaTab('---\r\nurls:\r\n  - https://a.test\r\n---\r\nbody\r\n'), { urls: ['https://a.test'], body: 'body' });
});

test('sync writes megatabs.json from <space>/<mega tab>/MEGATAB.md and nothing else (no .md copies, no index); a .md change never changes BUILD', () => {
  const spaces = tmp('megatabs-spaces-');
  const ext = tmp('megatabs-ext-');
  try {
    fs.mkdirSync(path.join(spaces, 'Me'));
    fs.writeFileSync(path.join(spaces, 'Me', 'notes.md'), '# Notes\n');
    mega(spaces, 'Me', 'Reading', file(['https://crm.test'], 'Work the pipeline.'));
    mega(spaces, 'Me', 'Archive', file([]));
    mega(spaces, 'Other', 'Ideas', 'Just text, no urls.\n');
    fs.mkdirSync(path.join(spaces, 'Me', 'NoFile')); // a folder without MEGATAB.md is not a mega tab
    const r = sync({ from: spaces, to: ext });
    assert.equal(r.megatabs, 3);
    assert.equal(r.files, 1, 'one .md file for the Board');
    const out = JSON.parse(fs.readFileSync(path.join(ext, 'board-data', 'megatabs.json'), 'utf8'));
    assert.deepEqual(out.megatabs, [
      { space: 'Me', mega: 'Archive', urls: [], body: '' },
      { space: 'Me', mega: 'Reading', urls: ['https://crm.test'], body: 'Work the pipeline.' },
      { space: 'Other', mega: 'Ideas', urls: [], body: 'Just text, no urls.' },
    ]);
    // G6: the Board reads through its host, so no copy of any .md and no index is written
    assert.deepEqual(fs.readdirSync(path.join(ext, 'board-data')), ['megatabs.json']);
    // Idempotent: nothing changed, BUILD unchanged
    const build = fs.readFileSync(path.join(ext, 'BUILD'), 'utf8');
    assert.equal(sync({ from: spaces, to: ext }).changed, false);
    // C21: any .md edit (a Board file, a MEGATAB.md, a new note) leaves BUILD as it was, so nothing reloads
    fs.writeFileSync(path.join(spaces, 'Me', 'notes.md'), '# Notes\n\nedited\n');
    fs.writeFileSync(path.join(spaces, 'Me', 'new.md'), 'new\n');
    mega(spaces, 'Me', 'Reading', file(['https://crm.test', 'https://more.test'], 'Work the pipeline.'));
    const r2 = sync({ from: spaces, to: ext });
    assert.equal(r2.changed, false);
    assert.equal(fs.readFileSync(path.join(ext, 'BUILD'), 'utf8'), build);
    assert.equal(r2.files, 2);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(ext, 'board-data', 'megatabs.json'), 'utf8')).megatabs.find((m) => m.mega === 'Reading').urls,
      ['https://crm.test', 'https://more.test'],
      'the MEGATAB.md edit still reaches the extension, through megatabs.json',
    );
    // Removing a folder removes it from the output; sync itself deletes nothing under spaces
    assert.ok(fs.existsSync(path.join(spaces, 'Me', 'Reading', 'MEGATAB.md')));
  } finally {
    rm(spaces, ext);
  }
});

// ---------------------------------------------------------------- C13: the Me seed

test('seed: four Me MEGATAB.md files once, never overwriting, never again after the marker', () => {
  const spaces = tmp('megatabs-seed-');
  try {
    assert.deepEqual(seedMegaTabs(spaces), [], 'no Me folder: nothing is written');
    fs.mkdirSync(path.join(spaces, 'Me'));
    // One already exists with his own text: it must stay exactly as it is
    mega(spaces, 'Me', 'Reading', 'his own words\n');
    const made = seedMegaTabs(spaces);
    assert.deepEqual(made.sort(), ['Archive', 'Drafts', 'Writing']);
    const read = (n) => fs.readFileSync(path.join(spaces, 'Me', n, 'MEGATAB.md'), 'utf8');
    assert.equal(read('Reading'), 'his own words\n');
    const snapshot = Object.fromEntries(['Reading', 'Drafts', 'Archive', 'Writing'].map((n) => [n, read(n)]));
    // A second run changes nothing
    assert.deepEqual(seedMegaTabs(spaces), []);
    // Even without the marker, an existing file is never rewritten
    fs.rmSync(path.join(spaces, 'Me', '.megatabs-seeded'));
    fs.writeFileSync(path.join(spaces, 'Me', 'Archive', 'MEGATAB.md'), 'edited\n');
    assert.deepEqual(seedMegaTabs(spaces), []);
    assert.equal(read('Archive'), 'edited\n');
    assert.equal(read('Drafts'), snapshot['Drafts']);
    // A mega tab he deletes is not brought back
    fs.rmSync(path.join(spaces, 'Me', 'Writing'), { recursive: true });
    assert.deepEqual(seedMegaTabs(spaces), []);
    assert.equal(fs.existsSync(path.join(spaces, 'Me', 'Writing')), false);
  } finally {
    rm(spaces);
  }
});

test('seed content: neutral example addresses only, 2-3 sentences each', () => {
  const spaces = tmp('megatabs-seed-');
  const ext = tmp('megatabs-ext-');
  try {
    fs.mkdirSync(path.join(spaces, 'Me'));
    seedMegaTabs(spaces);
    sync({ from: spaces, to: ext });
    const { megatabs } = JSON.parse(fs.readFileSync(path.join(ext, 'board-data', 'megatabs.json'), 'utf8'));
    assert.deepEqual(megatabs.map((m) => m.mega).sort(), ['Archive', 'Drafts', 'Reading', 'Writing']);
    for (const m of megatabs) {
      for (const u of m.urls) assert.match(u, /^https:\/\/(example\.(com|org)|en\.wikipedia\.org)\//, `${m.mega}: ${u} is a neutral example address`);
      const sentences = m.body.split(/(?<=[.!?])\s+/).filter(Boolean);
      assert.ok(sentences.length >= 2 && sentences.length <= 3, `${m.mega}: ${sentences.length} sentences`);
    }
    assert.deepEqual(Object.keys(EXAMPLE_MEGAS).sort(), ['Archive', 'Drafts', 'Reading', 'Writing']);
  } finally {
    rm(spaces, ext);
  }
});

test('command line: seeds the four starters once and says so; the second run seeds nothing', () => {
  const spaces = tmp('megatabs-cli-');
  const ext = tmp('megatabs-ext-');
  try {
    fs.mkdirSync(path.join(spaces, 'Me'));
    fs.cpSync(path.join(__dirname, '..', 'extension'), ext, { recursive: true, filter: (s) => path.basename(s) !== 'board-data' });
    const run = () => execFileSync(process.execPath, [path.join(__dirname, '..', 'board-sync.js'), '--from', spaces, '--to', ext], { encoding: 'utf8' });
    const first = run();
    assert.match(first, /4 mega tab\(s\)/);
    assert.match(first, /seeded mega tabs/);
    const second = run();
    assert.match(second, /4 mega tab\(s\)/);
    assert.doesNotMatch(second, /seeded/);
    assert.doesNotMatch(second, /updated/, 'nothing changed, BUILD unchanged');
  } finally {
    rm(spaces, ext);
  }
});

// ---------------------------------------------------------------- C11: the extension side

const SPEC = { workspaces: { A: ['a1', 'a2'] } };
const A = ['a1', 'a2'];
const apply = async (env, list) => {
  const p = env.w.eval(`applyMegaTabs(${JSON.stringify(list)})`);
  await env.w.settle();
  return JSON.parse(JSON.stringify(await p)); // out of the worker's realm
};
const wsByName = (env, name) => env.b.local.data.workspaces.find((w) => w.name === name);
const allUrls = (env) => env.b.windows.flatMap((w) => w.tabs.map((t) => t.url)).filter((u) => !u.startsWith(env.b.origin));
const countOf = (env, u) => allUrls(env).filter((x) => x === u).length;
const savedUrls = (env, id) => [...(env.b.local.data.backup?.[id]?.shown || []), ...(env.b.local.data.backup?.[id]?.stash || []), ...(env.b.local.data.backup?.[id]?.later || [])].map((e) => e.url);
const noMoves = (env, from) => env.b.calls.slice(from).filter((c) => ['tabs.remove', 'tabs.move', 'tabs.update', 'tabs.discard', 'windows.remove'].includes(c.name) && !(c.name === 'tabs.update' && !('url' in (c.args[1] || {}))));

test('a folder with MEGATAB.md makes the mega tab; its URLs wait in it and open on the first switch, nothing reloaded', async () => {
  const env = await setup(SPEC);
  const { b, w, win } = env;
  const listed = [{ space: 'Me', mega: 'Reading', urls: [url('crm'), url('mail')], body: 'x' }];
  const r = await apply(env, listed);
  assert.deepEqual(r, { made: 1, opened: 2 });
  const leads = wsByName(env, 'Me · Reading');
  assert.ok(leads, 'workspace made');
  assert.deepEqual(savedUrls(env, leads.id), [url('crm'), url('mail')]);
  assert.deepEqual(allUrls(env).sort(), A.map(url).sort(), 'no tab opened in the window he is working in');
  // Idempotent
  assert.deepEqual(await apply(env, listed), { made: 0, opened: 0 });
  assert.deepEqual(savedUrls(env, leads.id), [url('crm'), url('mail')]);
  assert.equal(b.local.data.workspaces.filter((x) => x.name === leads.name).length, 1);
  // Switching to it opens them (the engine restores a mega tab's saved tabs)
  await ok(w.request({ type: 'switch', windowId: win, wsId: leads.id }));
  assert.equal(countOf(env, url('crm')), 1);
  assert.equal(countOf(env, url('mail')), 1);
  assert.deepEqual(b.errors, []);
});

test('a URL added to the file opens in a shown mega tab; hand-opened tabs are never closed or moved; re-sync adds nothing', async () => {
  const env = await setup(SPEC);
  const { b, w, win } = env;
  await apply(env, [{ space: 'Me', mega: 'Reading', urls: [url('crm')], body: '' }]);
  const leads = wsByName(env, 'Me · Reading');
  await ok(w.request({ type: 'switch', windowId: win, wsId: leads.id }));
  // He opens one by hand; it is also in the file's next version
  const hand = await b.chrome.tabs.create({ windowId: win, url: url('hand'), active: false });
  const other = await b.chrome.tabs.create({ windowId: win, url: url('mine'), active: true });
  await w.settle();
  const idsBefore = b.windows.flatMap((x) => x.tabs.map((t) => t.id));
  const mark = b.calls.length;
  const r = await apply(env, [{ space: 'Me', mega: 'Reading', urls: [url('crm'), url('hand'), url('new')], body: '' }]);
  assert.deepEqual(r, { made: 0, opened: 1 }, 'only the missing URL opened');
  assert.equal(countOf(env, url('new')), 1);
  assert.equal(countOf(env, url('hand')), 1, 'the hand-opened tab is not duplicated');
  assert.equal(countOf(env, url('crm')), 1);
  const idsAfter = b.windows.flatMap((x) => x.tabs.map((t) => t.id));
  for (const id of idsBefore) assert.ok(idsAfter.includes(id), `tab ${id} was closed`);
  assert.deepEqual(noMoves(env, mark), [], 'no tab closed, moved or reloaded');
  assert.equal((await b.chrome.tabs.get(hand.id)).windowId, win);
  assert.equal((await b.chrome.tabs.get(other.id)).active, true, 'the tab he is on stays active');
  // The new tab is in his window, not active
  const newTab = b.tabsByUrl(url('new'))[0];
  assert.equal(newTab.windowId, win);
  assert.equal(newTab.active, false);
  // Re-sync: nothing new. And a tab he closes by hand is not reopened
  assert.deepEqual(await apply(env, [{ space: 'Me', mega: 'Reading', urls: [url('crm'), url('hand'), url('new')], body: '' }]), { made: 0, opened: 0 });
  await b.chrome.tabs.remove(newTab.id);
  await w.settle();
  assert.deepEqual(await apply(env, [{ space: 'Me', mega: 'Reading', urls: [url('crm'), url('hand'), url('new')], body: '' }]), { made: 0, opened: 0 });
  assert.equal(countOf(env, url('new')), 0);
  assert.deepEqual(b.errors, []);
});

test('a URL added to the file opens in a stashed mega tab without switching to it or reloading others', async () => {
  const env = await setup(SPEC);
  const { b, w, win } = env;
  await apply(env, [{ space: 'Me', mega: 'Reading', urls: [url('crm')], body: '' }]);
  const leads = wsByName(env, 'Me · Reading');
  await ok(w.request({ type: 'switch', windowId: win, wsId: leads.id })); // Reading shown, A stashed
  await ok(w.request({ type: 'switch', windowId: win, wsId: env.ids.A })); // back: Reading stashed
  const ids = Object.fromEntries(b.windows.flatMap((x) => x.tabs.map((t) => [t.url, t.id])));
  const mark = b.calls.length;
  const r = await apply(env, [{ space: 'Me', mega: 'Reading', urls: [url('crm'), url('later')], body: '' }]);
  assert.deepEqual(r, { made: 0, opened: 1 });
  const t = b.tabsByUrl(url('later'))[0];
  const holder = b.windows.find((x) => x.id === t.windowId);
  assert.equal(b.stashOf(holder), leads.id, 'opened in the stash window of Reading');
  assert.equal(t.active, false);
  assert.equal(b.windows.find((x) => x.id === win).tabs.some((x) => x.url === url('later')), false, 'not in his window');
  assert.deepEqual(noMoves(env, mark), []);
  for (const u of A.map(url)) assert.equal((await b.chrome.tabs.get(ids[u])).windowId, win, 'his tabs stayed');
  await w.settle();
  assert.deepEqual(await apply(env, [{ space: 'Me', mega: 'Reading', urls: [url('crm'), url('later')], body: '' }]), { made: 0, opened: 0 });
  assert.equal(countOf(env, url('later')), 1);
  assert.deepEqual(b.errors, []);
});

test('bad entries are ignored: non-web URLs, empty names; an existing workspace is reused, not duplicated', async () => {
  const env = await setup(SPEC);
  const before = env.b.local.data.workspaces.length;
  const r = await apply(env, [
    { space: 'Me', mega: 'Reading', urls: ['javascript:alert(1)', 'file:///etc/hosts', 'chrome://settings', url('ok')], body: '' },
    { space: '', mega: 'X', urls: [url('no')] },
    { mega: 'Y', urls: [url('no2')] },
    null,
  ]);
  assert.deepEqual(r, { made: 1, opened: 1 });
  assert.equal(env.b.local.data.workspaces.length, before + 1);
  const id = wsByName(env, 'Me · Reading').id;
  assert.deepEqual(savedUrls(env, id), [url('ok')]);
  // The same name given by hand earlier is reused
  assert.deepEqual(await apply(env, [{ space: 'Me', mega: 'Reading', urls: [], body: '' }]), { made: 0, opened: 0 });
  assert.equal(env.b.local.data.workspaces.filter((x) => x.name === 'Me · Reading').length, 1);
});

// ---------------------------------------------------------------- C14: Option+W toggles

// The fake browser has no side panel; a stand-in records what is asked of it
async function withPanel(env, { hasClose = true } = {}) {
  env.w.eval(`globalThis.__panel = { open: false, calls: [] };
    chrome.runtime.getContexts = async () => (__panel.open ? [{ contextType: 'SIDE_PANEL', windowId: -1 }] : []);
    chrome.sidePanel = { open: async (o) => { __panel.calls.push('open'); __panel.open = true; } };
    ${hasClose ? "chrome.sidePanel.close = async (o) => { __panel.calls.push('close'); __panel.open = false; };" : ''}`);
}
const press = async (env, windowId) => {
  env.b.fire('commands.onCommand', 'toggle-panel', { windowId });
  await env.w.settle();
};
const panelState = (env) => JSON.parse(JSON.stringify(env.w.eval('__panel')));

test('Option+W (toggle-panel): opens when closed, closes when open, twice over', async () => {
  const env = await setup(SPEC);
  await withPanel(env);
  await press(env, env.win);
  assert.deepEqual(panelState(env), { open: true, calls: ['open'] });
  await press(env, env.win);
  assert.equal(panelState(env).open, false, 'second press closes it');
  assert.deepEqual(panelState(env).calls, ['open', 'open', 'close'], 'open is always asked first (it must come before any await)');
  await press(env, env.win);
  assert.equal(panelState(env).open, true, 'third press opens again');
  assert.deepEqual(env.b.errors, []);
});

test('without chrome.sidePanel.close a panel that is open is left open and the result says so', async () => {
  const env = await setup(SPEC);
  await withPanel(env, { hasClose: false });
  env.w.eval('__panel.open = true');
  const p = env.w.eval('togglePanel(1)');
  await env.w.settle();
  assert.equal(await p, 'cannot-close');
  assert.equal(panelState(env).open, true);
});

test('a browser without side panels: the key does nothing and nothing throws', async () => {
  const env = await setup(SPEC);
  const p = env.w.eval('togglePanel(1)');
  await env.w.settle();
  assert.equal(await p, 'unsupported');
  await press(env, env.win);
  assert.deepEqual(env.b.errors, []);
});

test('manifest: Alt+W belongs to toggle-panel; the toolbar icon still opens the panel and there is no popup', () => {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'extension', 'manifest.json'), 'utf8'));
  assert.equal(m.commands['toggle-panel'].suggested_key.default, 'Alt+W');
  assert.equal(m.commands._execute_action.suggested_key, undefined, 'one key, one owner');
  assert.equal(m.action.default_popup, undefined);
  assert.equal(m.version, '0.12.0');
  const bg = fs.readFileSync(path.join(__dirname, '..', 'extension', 'background.js'), 'utf8');
  assert.match(bg, /setPanelBehavior\(\{ openPanelOnActionClick: true \}\)/);
});
