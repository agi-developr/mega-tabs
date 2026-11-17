'use strict';
// The Canvas room's logic without a browser: JSON Canvas 1.0 reading, validation and writing, the
// merge of an outside edit into the screen, the pen's stroke thinning, and the session that saves and
// merges, driven against the real host core on temp folders. (The browser side is in
// megatabs.chromium.test.js, "Board Canvas room".)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCore, HostError } = require('../host/core');

const lib = () => import('../canvas/src/jsoncanvas.mjs');
const sess = () => import('../canvas/src/session.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const base = () => ({
  nodes: [
    { id: 'a', type: 'text', x: 0, y: 0, width: 240, height: 100, text: 'A' },
    { id: 'b', type: 'text', x: 300, y: 0, width: 240, height: 100, text: 'B', color: '4' },
    { id: 'f', type: 'file', x: 0, y: 200, width: 240, height: 72, file: 'README.md' },
  ],
  edges: [{ id: 'e1', fromNode: 'a', toNode: 'b', fromSide: 'right', toSide: 'left' }],
  'x-strokes': [{ id: 's1', points: [[0, 0], [10, 10]], width: 2.5 }],
});
const clone = (v) => JSON.parse(JSON.stringify(v));

test('validate: the spec, field by field; extension fields are allowed, everything else the spec forbids is reported', async () => {
  const { validate } = await lib();
  assert.deepEqual(validate(base()), []);
  assert.deepEqual(validate({ nodes: [], edges: [], 'x-anything': { a: 1 } }), []);
  assert.deepEqual(validate({}), [], 'both arrays are optional');
  const bad = (fn) => {
    const d = base();
    fn(d);
    return validate(d);
  };
  assert.match(bad((d) => (d.nodes[0].x = 1.5))[0], /x is not an integer/);
  assert.match(bad((d) => (d.nodes[0].type = 'x-stroke'))[0], /type/);
  assert.match(bad((d) => delete d.nodes[0].text)[0], /text/);
  assert.match(bad((d) => (d.nodes[1].color = 'red'))[0], /color/);
  assert.match(bad((d) => (d.nodes[2].subpath = 'x'))[0], /subpath/);
  assert.match(bad((d) => (d.edges[0].toNode = 'nope'))[0], /names no node/);
  assert.match(bad((d) => (d.edges[0].fromSide = 'middle'))[0], /fromSide/);
  assert.match(bad((d) => (d.edges[0].toEnd = 'dot'))[0], /toEnd/);
  assert.match(bad((d) => d.nodes.push({ ...d.nodes[0] }))[0], /duplicate/);
  assert.deepEqual(bad((d) => (d.nodes[1].color = '#abc')), []);
});

test('parse and serialize: tab-indented like Obsidian, x-strokes only when there are strokes, unknown fields kept, order kept', async () => {
  const { parse, serialize, same } = await lib();
  // strokes are one compact line each (REVIEW #1); everything else tab-indented
  const head = JSON.stringify({ nodes: base().nodes, edges: base().edges, 'x-other': { keep: true } }, null, '\t');
  const text = `${head.slice(0, -2)},\n\t"x-strokes": [\n${base()['x-strokes'].map((x) => '\t\t' + JSON.stringify(x)).join(',\n')}\n\t]\n}`;
  assert.deepEqual(JSON.parse(text)['x-strokes'], base()['x-strokes'], 'the fixture itself is valid JSON');
  const doc = parse(text);
  assert.deepEqual(doc['x-other'], { keep: true });
  assert.equal(serialize(doc), text, 'writing what was read changes no byte');
  const none = { ...doc, 'x-strokes': [] };
  assert.equal('x-strokes' in JSON.parse(serialize(none)), false);
  assert.ok(serialize(doc).startsWith('{\n\t"'));
  assert.equal(same({ nodes: [], edges: [] }, { nodes: [], edges: [], 'x-strokes': [] }), true);
  assert.equal(same({ a: 1, nodes: [] }, { nodes: [], a: 2 }), false);
  for (const bad of ['', 'nope', '[]', '{"nodes":{}}', '{"edges":3}', '{"x-strokes":{}}', '{"nodes":[{"id":7}]}', '{"nodes":[{}]}', '{"nodes":[{"id":"a"},{"id":"a"}]}', '{"edges":[{"fromNode":"a"}]}', '{"x-strokes":[{"id":"s"}]}', '{"nodes":[3]}']) assert.throws(() => parse(bad), undefined, JSON.stringify(bad));
  // A canvas another tool wrote without edges
  assert.deepEqual(parse('{"nodes":[]}').edges, []);
  // An Obsidian-style reader that knows only nodes and edges sees the same cards with or without strokes
  const readerView = (d) => JSON.stringify({ nodes: d.nodes, edges: d.edges });
  assert.equal(readerView(parse(serialize(doc))), readerView({ ...doc, 'x-strokes': undefined }));
});

test('simplify thins a stroke and keeps its shape; a closed loop is not collapsed', async () => {
  const { simplify, strokePath } = await lib();
  const line = Array.from({ length: 50 }, (_, i) => [i, i * 0.5]);
  assert.deepEqual(simplify(line), [line[0], line.at(-1)]);
  const circle = Array.from({ length: 33 }, (_, i) => [60 * Math.cos((i / 32) * 2 * Math.PI), 40 * Math.sin((i / 32) * 2 * Math.PI)]);
  circle[32] = [...circle[0]]; // ends where it started
  const s = simplify(circle);
  assert.ok(s.length >= 8 && s.length <= 33, `${s.length} points`);
  assert.deepEqual(s[0], circle[0]);
  assert.deepEqual(s.at(-1), circle.at(-1));
  assert.match(strokePath(s), /^M[-\d. ]+(Q[-\d. ]+)+L/);
  assert.match(strokePath([[1, 2]]), /^M1 2/);
  assert.equal(strokePath([]), '');
});

test('merge: his unsaved changes and their edit both survive, field by field; deletes follow who did them', async () => {
  const { merge, validate } = await lib();
  const B = base();
  // He moved a; they added c with an edge, rewrote b's text and drew a stroke
  const mine = clone(B);
  mine.nodes[0].x = 90;
  const theirs = clone(B);
  theirs.nodes.push({ id: 'c', type: 'text', x: 0, y: -200, width: 240, height: 90, text: 'C' });
  theirs.edges.push({ id: 'e2', fromNode: 'b', toNode: 'c' });
  theirs.nodes[1].text = 'B2';
  theirs['x-strokes'].push({ id: 's2', points: [[5, 5], [9, 9]] });
  const m = merge(B, mine, theirs);
  assert.equal(m.nodes.find((n) => n.id === 'a').x, 90, 'his move');
  assert.equal(m.nodes.find((n) => n.id === 'b').text, 'B2', 'their text');
  assert.deepEqual(m.nodes.map((n) => n.id), ['a', 'b', 'f', 'c']);
  assert.deepEqual(m.edges.map((e) => e.id), ['e1', 'e2']);
  assert.deepEqual(m['x-strokes'].map((s) => s.id), ['s1', 's2']);
  assert.deepEqual(validate(m), []);

  // The same card: he moved it, they edited its text: both fields
  const m2 = merge(B, (() => { const d = clone(B); d.nodes[0].x = 55; return d; })(), (() => { const d = clone(B); d.nodes[0].text = 'A2'; return d; })());
  assert.deepEqual([m2.nodes[0].x, m2.nodes[0].text], [55, 'A2']);
  // The same field: his, it is the newer
  const m3 = merge(B, (() => { const d = clone(B); d.nodes[0].x = 55; return d; })(), (() => { const d = clone(B); d.nodes[0].x = 77; return d; })());
  assert.equal(m3.nodes[0].x, 55);
  // He added a card while they added another
  const m4 = merge(B, (() => { const d = clone(B); d.nodes.push({ id: 'm', type: 'text', x: 1, y: 1, width: 1, height: 1, text: 'mine' }); return d; })(), (() => { const d = clone(B); d.nodes.push({ id: 't', type: 'text', x: 2, y: 2, width: 1, height: 1, text: 'theirs' }); return d; })());
  assert.deepEqual(m4.nodes.map((n) => n.id), ['a', 'b', 'f', 't', 'm']);
  // He deleted b: it stays deleted, with its edge, even though they edited it
  const del = clone(B);
  del.nodes.splice(1, 1);
  del.edges = [];
  const edited = clone(B);
  edited.nodes[1].text = 'B3';
  const m5 = merge(B, del, edited);
  assert.deepEqual(m5.nodes.map((n) => n.id), ['a', 'f']);
  assert.deepEqual(m5.edges, []);
  // They deleted a: gone, unless he changed it meanwhile
  const gone = clone(B);
  gone.nodes.shift();
  gone.edges = [];
  assert.deepEqual(merge(B, clone(B), gone).nodes.map((n) => n.id), ['b', 'f']);
  const changed = clone(B);
  changed.nodes[0].y = 40;
  assert.deepEqual(merge(B, changed, gone).nodes.map((n) => n.id), ['b', 'f', 'a'].sort((x, y) => ['b', 'f', 'a'].indexOf(x) - ['b', 'f', 'a'].indexOf(y)));
  // A top-level field they added is kept
  const t6 = clone(B);
  t6['x-ai'] = 'note';
  assert.equal(merge(B, clone(B), t6)['x-ai'], 'note');
  // Nothing changed on either side: the same canvas
  assert.deepEqual(merge(B, clone(B), clone(B)), clone(B));
});

test('toFlow and fromFlow: the canvas comes back as it was, unknown fields and unknown node types included', async () => {
  const { toFlow, fromFlow, same, serialize } = await lib();
  const doc = {
    ...base(),
    nodes: [...base().nodes, { id: 'g', type: 'group', x: -40, y: -40, width: 700, height: 400, label: 'G', 'x-meta': 1 }, { id: 'z', type: 'x-3d', x: 5, y: 5, width: 10, height: 10 }, { id: 'k', type: 'text', x: 0, y: 0, width: 50, height: 50, text: '', 'x-kind': 'chart' }],
    'x-ai': { v: 1 },
  };
  const { nodes, edges } = toFlow(doc, ['chart']);
  assert.deepEqual(nodes.map((n) => n.type), ['text', 'text', 'file', 'group', 'unknown', 'chart']);
  assert.equal(nodes.find((n) => n.id === 'g').zIndex, -1, 'groups sit under the cards');
  const { 'x-ai': rest, nodes: _n, edges: _e, 'x-strokes': strokes, ...r } = doc;
  const back = fromFlow({ nodes, edges, strokes, rest: { 'x-ai': rest } });
  assert.equal(same(back, doc), true);
  assert.equal(serialize(back), serialize(doc));
  // A moved and resized card is written with whole numbers
  nodes[0] = { ...nodes[0], position: { x: 10.6, y: -3.4 }, width: 200.4, height: 99.5 };
  const moved = fromFlow({ nodes, edges, strokes, rest: {} }).nodes[0];
  assert.deepEqual([moved.x, moved.y, moved.width, moved.height], [11, -3, 200, 100]);
  assert.equal(r.x, undefined);
});

// ---------------------------------------------------------------- the session, against the real host core

function setup(initial) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'megatabs-canvas-')));
  fs.mkdirSync(path.join(root, 'Me'));
  const file = path.join(root, 'Me', 'Board.canvas');
  if (initial !== undefined) fs.writeFileSync(file, initial);
  const core = createCore({ root });
  // The page's `call`: the host core behind the same answers (an error carries code, theirs, reason)
  const call = async (type, a) => {
    try {
      if (type === 'read') return core.read(a.space, a.file);
      if (type === 'write') return core.write(a.space, a.file, a.text, a.base);
      throw new Error(type);
    } catch (e) {
      if (!(e instanceof HostError)) throw e;
      throw Object.assign(new Error(e.message), { code: e.code, theirs: e.extra?.theirs, reason: e.extra?.reason, hash: e.extra?.hash, size: e.extra?.size });
    }
  };
  return { root, file, core, call, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const text = (d) => JSON.stringify(d, null, '\t');

test('session: a change is saved after the delay, atomically, with the hash it loaded; an unchanged canvas writes nothing', async () => {
  const { CanvasSession } = await sess();
  const { parse } = await lib();
  const x = setup(text(base()));
  try {
    const st = [];
    const s = new CanvasSession({ call: x.call, space: 'Me', file: 'Board.canvas', delay: 30, onStatus: (t) => st.push(t) });
    const doc = await s.load();
    const ino = fs.statSync(x.file).ino;
    s.setLocal(doc);
    await sleep(120);
    assert.equal(fs.statSync(x.file).ino, ino, 'nothing changed, nothing written');
    const next = clone(doc);
    next.nodes[0].x = 123;
    s.setLocal(next);
    assert.equal(s.dirty, true);
    assert.equal(st.at(-1), 'Unsaved');
    await sleep(200);
    assert.equal(parse(fs.readFileSync(x.file, 'utf8')).nodes[0].x, 123);
    assert.notEqual(fs.statSync(x.file).ino, ino, 'replaced by rename');
    assert.equal(st.at(-1), 'Saved');
    assert.equal(s.dirty, false);
    assert.deepEqual(fs.readdirSync(path.dirname(x.file)).filter((n) => n.endsWith('.tmp')), []);
  } finally {
    x.done();
  }
});

test('session: a write the host refuses as stale is merged with their text and saved again, nothing lost, no question', async () => {
  const { CanvasSession } = await sess();
  const { parse } = await lib();
  const x = setup(text(base()));
  try {
    const remote = [];
    const s = new CanvasSession({ call: x.call, space: 'Me', file: 'Board.canvas', delay: 20, onRemote: (d) => remote.push(d) });
    const doc = await s.load();
    s.hold = true;
    const mine = clone(doc);
    mine.nodes[0].x = 77;
    s.setLocal(mine);
    // They write the file while his move is unsaved and this page has not been told
    const theirs = clone(base());
    theirs.nodes.push({ id: 'ai', type: 'text', x: 0, y: -150, width: 240, height: 90, text: 'AI' });
    fs.writeFileSync(x.file, text(theirs));
    s.release();
    await s.saving;
    await sleep(60);
    const onDisk = parse(fs.readFileSync(x.file, 'utf8'));
    assert.equal(onDisk.nodes.find((n) => n.id === 'a').x, 77, 'his move');
    assert.ok(onDisk.nodes.some((n) => n.id === 'ai'), 'their card');
    assert.equal(remote.length, 1, 'the screen was told about their card once');
    assert.ok(remote[0].nodes.some((n) => n.id === 'ai') && remote[0].nodes.find((n) => n.id === 'a').x === 77);
    assert.equal(s.dirty, false);
  } finally {
    x.done();
  }
});

test('session: a change push (disk) merges into the screen, keeps what is unsaved, and sends it on top of theirs', async () => {
  const { CanvasSession } = await sess();
  const { parse } = await lib();
  const x = setup(text(base()));
  try {
    const remote = [];
    const s = new CanvasSession({ call: x.call, space: 'Me', file: 'Board.canvas', delay: 20, onRemote: (d) => remote.push(d) });
    const doc = await s.load();
    s.hold = true;
    const mine = clone(doc);
    mine.nodes[1].y = 500;
    s.setLocal(mine);
    const theirs = clone(base());
    theirs.nodes[0].text = 'A rewritten';
    fs.writeFileSync(x.file, text(theirs));
    const entry = x.core.list('Me').files[0];
    await s.disk(entry);
    assert.equal(remote.length, 1);
    assert.equal(remote[0].nodes[0].text, 'A rewritten');
    assert.equal(remote[0].nodes[1].y, 500, 'his unsaved move is still there');
    assert.equal(parse(fs.readFileSync(x.file, 'utf8')).nodes[1].y, 0, 'and still unsaved');
    assert.equal(s.dirty, true);
    s.release();
    await sleep(100);
    const fin = parse(fs.readFileSync(x.file, 'utf8'));
    assert.deepEqual([fin.nodes[0].text, fin.nodes[1].y], ['A rewritten', 500]);
    // His own save coming back as a push changes nothing
    const n = remote.length;
    await s.disk(x.core.list('Me').files[0]);
    assert.equal(remote.length, n);
  } finally {
    x.done();
  }
});

test('session: a file that is not valid JSON Canvas is never written over; when it is valid again, it merges', async () => {
  const { CanvasSession } = await sess();
  const { parse } = await lib();
  const x = setup('not json at all');
  try {
    const st = [];
    const s = new CanvasSession({ call: x.call, space: 'Me', file: 'Board.canvas', delay: 10, onStatus: (t) => st.push(t) });
    await s.load();
    assert.match(st.at(-1), /not a JSON Canvas/);
    s.setLocal({ nodes: [{ id: 'n', type: 'text', x: 0, y: 0, width: 1, height: 1, text: 'x' }], edges: [] });
    await sleep(80);
    assert.equal(fs.readFileSync(x.file, 'utf8'), 'not json at all', 'untouched');
  } finally {
    x.done();
  }
  const y = setup(text(base()));
  try {
    const st = [];
    const s = new CanvasSession({ call: y.call, space: 'Me', file: 'Board.canvas', delay: 10, onStatus: (t) => st.push(t) });
    await s.load();
    // A writer that is mid-way (half a file) and then finishes: nothing is reported for the half file
    fs.writeFileSync(y.file, '{"nodes": [');
    const half = y.core.list('Me').files[0];
    setTimeout(() => fs.writeFileSync(y.file, text({ ...base(), nodes: base().nodes.slice(0, 2), edges: [] })), 80);
    await s.disk(half);
    await sleep(350);
    assert.equal(st.some((t) => /not a JSON Canvas/.test(t)), false, `no complaint: ${JSON.stringify(st)}`);
    assert.equal(s.local.nodes.length, 2, 'the finished file is on screen');
    // A file that stays broken is reported, and not written over
    fs.writeFileSync(y.file, '{"nodes": [');
    await s.disk(y.core.list('Me').files[0]);
    assert.match(st.at(-1), /not a JSON Canvas/);
    s.setLocal({ ...s.local, nodes: [] });
    await sleep(60);
    assert.equal(fs.readFileSync(y.file, 'utf8'), '{"nodes": [');
    // And it is valid again: merged, saving works again
    fs.writeFileSync(y.file, text({ nodes: [], edges: [] }));
    await s.disk(y.core.list('Me').files[0]);
    assert.equal(s.invalid, '');
    assert.deepEqual(parse(fs.readFileSync(y.file, 'utf8')).nodes, []);
  } finally {
    y.done();
  }
});

test('session: a canvas deleted from outside while open is NOT written back by his next change; "Keep mine" writes it, "Drop it" lets it go (REVIEW #4)', async () => {
  const { CanvasSession } = await sess();
  const { parse } = await lib();
  const x = setup(text(base()));
  try {
    const flags = [];
    const s = new CanvasSession({ call: x.call, space: 'Me', file: 'Board.canvas', delay: 10, onDeleted: (v) => flags.push(v) });
    const doc = await s.load();
    fs.rmSync(x.file);
    await s.disk(undefined);
    assert.equal(s.deleted, true);
    assert.deepEqual(flags, [true]);
    const next = clone(doc);
    next.nodes[0].x = 5;
    s.setLocal(next);
    await sleep(150);
    assert.equal(fs.existsSync(x.file), false, 'a drag after the delete does not bring the file back');
    assert.equal(s.unsafe, true, 'closing the tab would lose it: the page asks first');
    await s.flush();
    assert.equal(fs.existsSync(x.file), false, 'not even on flush');
    await s.keepDeleted();
    assert.equal(parse(fs.readFileSync(x.file, 'utf8')).nodes[0].x, 5, 'Keep mine writes it again, on purpose');
    assert.equal(s.deleted, false);
    assert.equal(s.dirty, false);
  } finally {
    x.done();
  }
  // A rename from outside is the same thing: the old name is gone. "Drop it" forgets his unsaved canvas.
  const y = setup(text(base()));
  try {
    const s = new CanvasSession({ call: y.call, space: 'Me', file: 'Board.canvas', delay: 10 });
    const doc = await s.load();
    fs.renameSync(y.file, path.join(path.dirname(y.file), 'Renamed.canvas'));
    await s.disk(undefined);
    s.setLocal({ ...clone(doc), nodes: [] });
    s.drop();
    assert.equal(s.deleted, false);
    assert.equal(s.unsafe, false);
    await sleep(80);
    assert.equal(fs.existsSync(y.file), false);
    // And a file that comes back (undo of the delete, a rename back) is looked at like any change, never asked about
    fs.renameSync(path.join(path.dirname(y.file), 'Renamed.canvas'), y.file);
    await s.disk(y.core.list('Me').files.find((f) => f.file === 'Board.canvas'));
    assert.equal(s.deleted, false);
  } finally {
    y.done();
  }
});

test('session: a file that was deleted and is back with the same bytes is not asked about, and his unsaved change is saved', async () => {
  const { CanvasSession } = await sess();
  const { parse } = await lib();
  const x = setup(text(base()));
  try {
    const s = new CanvasSession({ call: x.call, space: 'Me', file: 'Board.canvas', delay: 10 });
    const doc = await s.load();
    const bytes = fs.readFileSync(x.file);
    fs.rmSync(x.file);
    await s.disk(undefined);
    const next = clone(doc);
    next.nodes[0].x = 9;
    s.setLocal(next);
    fs.writeFileSync(x.file, bytes);
    await s.disk(x.core.list('Me').files[0]);
    assert.equal(s.deleted, false);
    await sleep(120);
    assert.equal(parse(fs.readFileSync(x.file, 'utf8')).nodes[0].x, 9);
  } finally {
    x.done();
  }
});

test('session: a push that arrives while a read runs is looked at too, the AI card shows without another edit of his (REVIEW #6)', async () => {
  const { CanvasSession } = await sess();
  const x = setup(text(base()));
  try {
    const remote = [];
    let slow = false;
    let release;
    const gate = new Promise((r) => (release = r));
    let held;
    const call = async (type, a) => {
      if (type === 'read' && slow) {
        slow = false;
        await gate; // the answer is delayed: the file changes again before it is delivered
        return held;
      }
      return x.call(type, a);
    };
    const s = new CanvasSession({ call, space: 'Me', file: 'Board.canvas', delay: 10, onRemote: (d) => remote.push(d) });
    await s.load();
    held = await x.call('read', { space: 'Me', file: 'Board.canvas' }); // the bytes of the first look: the base
    const first = clone(base());
    first.nodes[0].text = 'A first edit';
    fs.writeFileSync(x.file, text(first));
    slow = true;
    const p = s.disk(x.core.list('Me').files[0]); // push 1: the read is now waiting on the gate
    await sleep(20);
    const final = clone(first);
    final.nodes.push({ id: 'ai', type: 'text', x: 0, y: -150, width: 240, height: 90, text: 'AI card' });
    fs.writeFileSync(x.file, text(final));
    await s.disk(x.core.list('Me').files[0]); // push 2: arrives while the read runs
    release();
    await p;
    assert.ok(s.local.nodes.some((n) => n.id === 'ai'), 'the AI card is on screen');
    assert.equal(s.local.nodes[0].text, 'A first edit');
    assert.ok(remote.length >= 1);
  } finally {
    x.done();
  }
});

test('session: a draft left by a closed tab comes back on the next load, merged with what the file holds now, and is saved (REVIEW #2)', async () => {
  const { CanvasSession } = await sess();
  const { parse } = await lib();
  const x = setup(text(base()));
  const store = new Map();
  const drafts = { get: (k) => store.get(k) ?? null, set: (k, v) => store.set(k, v), remove: (k) => store.delete(k) };
  try {
    const s1 = new CanvasSession({ call: x.call, space: 'Me', file: 'Board.canvas', delay: 10000, drafts });
    const doc = await s1.load();
    const typed = clone(doc);
    typed.nodes[0].text = 'typed but the tab closed';
    s1.setLocal(typed);
    assert.equal(store.size, 1, 'the unsaved canvas is kept at once, not after a delay');
    s1.destroy(); // the tab is gone before the 300 ms timer; nothing reached the file
    assert.equal(parse(fs.readFileSync(x.file, 'utf8')).nodes[0].text, 'A');
    // The AI adds a card meanwhile; the tab is opened again
    const theirs = clone(base());
    theirs.nodes.push({ id: 'ai', type: 'text', x: 0, y: -150, width: 240, height: 90, text: 'AI' });
    fs.writeFileSync(x.file, text(theirs));
    const s2 = new CanvasSession({ call: x.call, space: 'Me', file: 'Board.canvas', delay: 10, drafts });
    const back = await s2.load();
    assert.equal(back.nodes[0].text, 'typed but the tab closed', 'his text is back');
    assert.ok(back.nodes.some((n) => n.id === 'ai'), 'and their card is kept');
    s2.setLocal(back);
    await sleep(120);
    const fin = parse(fs.readFileSync(x.file, 'utf8'));
    assert.equal(fin.nodes[0].text, 'typed but the tab closed');
    assert.ok(fin.nodes.some((n) => n.id === 'ai'));
    assert.equal(store.size, 0, 'saved: the draft is gone');
  } finally {
    x.done();
  }
});

test('session: a card he is typing in survives the AI deleting it (REVIEW #2)', async () => {
  const { CanvasSession } = await sess();
  const x = setup(text(base()));
  try {
    const s = new CanvasSession({ call: x.call, space: 'Me', file: 'Board.canvas', delay: 10 });
    const doc = await s.load();
    s.hold = true;
    const typed = clone(doc);
    typed.nodes[1].text = 'half a sentence I was typing';
    s.setLocal(typed);
    const theirs = clone(base());
    theirs.nodes.splice(1, 1);
    theirs.edges = [];
    fs.writeFileSync(x.file, text(theirs));
    await s.disk(x.core.list('Me').files[0]);
    assert.ok(s.local.nodes.some((n) => n.id === 'b' && n.text === 'half a sentence I was typing'), 'the card he changed stays');
  } finally {
    x.done();
  }
});

test('REVIEW #1: 300 handwriting strokes (60 points each) fit the host cap, one line each; a save over the cap is refused loudly before anything is sent', async () => {
  const { CanvasSession } = await sess();
  const { serialize, parse } = await lib();
  const wiggle = (k) => Array.from({ length: 60 }, (_, i) => [Math.round((k * 7 + i * 3.1 + Math.sin(i + k) * 9) * 10) / 10, Math.round((k * 5 + Math.cos(i * 0.7 + k) * 14) * 10) / 10]);
  const strokes = Array.from({ length: 300 }, (_, k) => ({ id: 'st' + k, points: wiggle(k), width: 2.5 }));
  const doc = { ...base(), 'x-strokes': strokes };
  const out = serialize(doc);
  const pretty = Buffer.byteLength(JSON.stringify(doc, null, '\t'));
  assert.ok(Buffer.byteLength(out) < 480 * 1024, `${Buffer.byteLength(out)} bytes`);
  assert.ok(Buffer.byteLength(out) < pretty / 2, `compact ${Buffer.byteLength(out)} vs pretty ${pretty}: pretty-printing every point is what filled the cap`);
  assert.equal(out.split('\n').filter((l) => /^\t\t\{"id":"st\d+"/.test(l)).length, 300, 'one line per stroke');
  assert.deepEqual(parse(out)['x-strokes'], strokes, 'valid JSON, the same strokes');
  // The real host core takes it
  const x = setup(text(base()));
  try {
    const s = new CanvasSession({ call: x.call, space: 'Me', file: 'Board.canvas', delay: 10 });
    await s.load();
    s.setLocal(doc);
    await sleep(200);
    assert.equal(s.status, 'Saved');
    assert.equal(parse(fs.readFileSync(x.file, 'utf8'))['x-strokes'].length, 300);
    // A cap read from the host (ping/list {max}), not written into the page: a save over it is refused before the call
    let writes = 0;
    const counting = async (type, a) => {
      if (type === 'write') writes++;
      return x.call(type, a);
    };
    const st = [];
    const t = new CanvasSession({ call: counting, space: 'Me', file: 'Board.canvas', delay: 10, max: () => 20000, onStatus: (v) => st.push(v) });
    await t.load();
    const before = fs.readFileSync(x.file, 'utf8');
    t.setLocal({ ...doc, nodes: doc.nodes.slice(1) });
    await sleep(150);
    assert.equal(writes, 0, 'nothing was sent');
    assert.equal(fs.readFileSync(x.file, 'utf8'), before);
    assert.match(st.at(-1), /^Not saved \(this canvas is [\d.]+ KB; the files hold at most 20 KB/);
    assert.equal(t.dirty, true, 'still his, still unsaved');
  } finally {
    x.done();
  }
});

test('session: a file on disk that grew too big to merge waits for "Keep mine", which saves with the hash the host sent (REVIEW #9)', async () => {
  const { CanvasSession } = await sess();
  const { parse } = await lib();
  const x = setup(text(base()));
  try {
    const flags = [];
    const s = new CanvasSession({ call: x.call, space: 'Me', file: 'Board.canvas', delay: 10, onBlocked: (b) => flags.push(b?.reason ?? null) });
    const doc = await s.load();
    // Outside, the file becomes huge (not mergeable here); he changes a card
    fs.writeFileSync(x.file, text({ ...base(), nodes: [{ id: 'big', type: 'text', x: 0, y: 0, width: 1, height: 1, text: 'x'.repeat(600 * 1024) }] }));
    const mine = clone(doc);
    mine.nodes[0].x = 321;
    s.setLocal(mine);
    await sleep(200);
    assert.deepEqual(flags, ['too-large'], 'the page is told, and it can say so');
    assert.match(s.status, /^Not saved \(the file on disk changed and is over the size limit/);
    assert.equal(parse(fs.readFileSync(x.file, 'utf8')).nodes[0].id, 'big', 'theirs untouched while he decides');
    await s.keepOver();
    assert.equal(parse(fs.readFileSync(x.file, 'utf8')).nodes[0].x, 321, 'Keep mine: his canvas replaces it');
    assert.deepEqual(flags, ['too-large', null]);
  } finally {
    x.done();
  }
});

test('REVIEW #5: a canvas with a node whose id is a number, missing, or used twice is shown empty and never written over: no card, edge or stroke is dropped by a save', async () => {
  const { CanvasSession } = await sess();
  const { parse } = await lib();
  const odd = JSON.stringify({ nodes: [{ id: 'a', type: 'text', x: 0, y: 0, width: 9, height: 9, text: 'A' }, { id: 7, type: 'text', x: 1, y: 1, width: 9, height: 9, text: 'numeric id' }, { type: 'text', x: 2, y: 2, width: 9, height: 9, text: 'no id' }], edges: [] }, null, '\t');
  assert.throws(() => parse(odd), /node 2 has no text id/);
  const x = setup(odd);
  try {
    const s = new CanvasSession({ call: x.call, space: 'Me', file: 'Board.canvas', delay: 10 });
    await s.load();
    assert.match(s.invalid, /node 2 has no text id/);
    s.setLocal({ nodes: [{ id: 'n', type: 'text', x: 0, y: 0, width: 1, height: 1, text: 'x' }], edges: [] });
    await sleep(100);
    assert.equal(fs.readFileSync(x.file, 'utf8'), odd, 'all three cards are still in the file');
  } finally {
    x.done();
  }
});

test('history: 50 steps of undo and redo; typing in one card is one step per pause; an outside edit is in every step', async () => {
  const { History, LIMIT } = await import('../canvas/src/history.mjs');
  const { merge } = await lib();
  let now = 0;
  const h = new History({ now: () => now });
  const B = base();
  h.record(B);
  assert.equal(h.canUndo, false);
  const move = (n) => ({ ...clone(B), nodes: B.nodes.map((x, i) => (i === 0 ? { ...x, x: n } : x)) });
  for (let i = 1; i <= 60; i++) h.record(move(i));
  assert.equal(LIMIT, 50);
  assert.equal(h.past.length, 50, 'the 51st step back is gone');
  assert.equal(h.undo().nodes[0].x, 59);
  assert.equal(h.redo().nodes[0].x, 60);
  assert.equal(h.redo(), null);
  for (let i = 0; i < 50; i++) assert.ok(h.undo());
  assert.equal(h.undo(), null, 'nothing before the 50th step');
  // A new change after an undo drops the redo steps
  h.redo();
  h.record(move(999));
  assert.equal(h.canRedo, false);
  // Typing: one step per pause, not one per key
  const t = new History({ now: () => now });
  t.record(B);
  const typed = (text) => ({ ...clone(B), nodes: B.nodes.map((x, i) => (i === 0 ? { ...x, text } : x)) });
  for (const [i, c] of ['h', 'he', 'hel', 'hell', 'hello'].entries()) {
    now = i * 100;
    t.record(typed(c));
  }
  assert.equal(t.past.length, 1, 'five keys, one step');
  now += 5000;
  t.record(typed('hello again'));
  assert.equal(t.past.length, 2, 'after a pause the next typing is a new step');
  assert.equal(t.undo().nodes[0].text, 'hello');
  assert.equal(t.undo().nodes[0].text, 'A');
  // An outside edit (the AI adds a card) is merged into every step: undo never takes it back
  const r = new History({ now: () => now });
  r.record(B);
  const moved = move(77);
  r.record(moved);
  const theirs = clone(moved);
  theirs.nodes.push({ id: 'ai', type: 'text', x: 0, y: -150, width: 240, height: 90, text: 'AI' });
  r.rebase(moved, merge(B, moved, theirs));
  const back = r.undo();
  assert.equal(back.nodes[0].x, 0, 'his move is undone');
  assert.ok(back.nodes.some((n) => n.id === 'ai'), 'their card stays');
});

// ---------------------------------------------------------------- the starter canvas, the bundle

test('seed: Me/Board.canvas is written once, only when absent, valid JSON Canvas linking README and the four MEGATAB.md files; never overwritten, never brought back', async () => {
  const { seedCanvas } = require('../board-sync');
  const { validate } = await lib();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'megatabs-seed-')));
  try {
    assert.equal(seedCanvas(root), false, 'no Me folder: nothing is written');
    assert.deepEqual(fs.readdirSync(root), []);
    fs.mkdirSync(path.join(root, 'Me'));
    assert.equal(seedCanvas(root), true);
    const file = path.join(root, 'Me', 'Board.canvas');
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(validate(doc), []);
    assert.deepEqual(doc.nodes.filter((n) => n.type === 'file').map((n) => n.file), ['README.md', 'Reading/MEGATAB.md', 'Drafts/MEGATAB.md', 'Archive/MEGATAB.md', 'Writing/MEGATAB.md']);
    assert.equal(doc.nodes[0].type, 'group', 'a group is first in the list: it sits under the cards');
    const bytes = fs.readFileSync(file);
    assert.equal(seedCanvas(root), false, 'the second run writes nothing');
    fs.rmSync(file);
    assert.equal(seedCanvas(root), false, 'a canvas he deleted is not brought back');
    assert.ok(!fs.existsSync(file));
    // An existing Board.canvas (and no marker) is never replaced
    fs.rmSync(path.join(root, 'Me', '.megatabs-canvas-seeded'));
    fs.writeFileSync(file, '{"nodes":[],"edges":[]}');
    assert.equal(seedCanvas(root), false);
    assert.equal(fs.readFileSync(file, 'utf8'), '{"nodes":[],"edges":[]}');
    assert.ok(bytes.length > 100);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bundle: vendor/canvas.js and vendor/canvas3d.js are classic scripts with no network, eval or import.meta; every package inside has a permissive license on file', () => {
  const vendor = path.join(__dirname, '..', 'extension', 'vendor');
  for (const [file, global] of [['canvas.js', 'MegatabsCanvas'], ['canvas3d.js', 'MegatabsThree']]) {
    const js = fs.readFileSync(path.join(vendor, file), 'utf8');
    for (const bad of ['import.meta', 'eval(', 'new Function', 'fetch(', 'XMLHttpRequest', 'WebSocket', 'sendBeacon', 'importScripts']) assert.ok(!js.includes(bad), `${file} contains ${bad}`);
    assert.ok(js.includes(global), `${file} defines ${global}`);
    assert.ok(!/^\s*(import|export)\s/m.test(js), `${file} is a classic script, not a module`);
  }
  const lic = fs.readFileSync(path.join(vendor, 'LICENSE-canvas-bundle'), 'utf8');
  for (const pkg of ['@xyflow/react', '@xyflow/system', 'react', 'react-dom', 'zustand', 'd3-drag', 'd3-zoom', 'three', '3d-force-graph', 'three-forcegraph', 'three-render-objects', 'd3-force-3d']) assert.ok(lic.includes(`\n${pkg}@`), `license of ${pkg}`);
  assert.match(lic, /\n3d-force-graph@[\d.]+ \(MIT\)\n/);
  assert.match(lic, /\nthree@[\d.]+ \(MIT\)\n/);
  assert.doesNotMatch(lic, /GNU (Affero )?General Public|noncommercial|non-commercial|PolyForm|Commons Clause/i);
  for (const m of lic.matchAll(/^(@?[\w./-]+)@[\d.]+ \(([^)]+)\)$/gm)) assert.match(m[2], /^(MIT|ISC|BSD-[23]-Clause|Apache-2\.0|0BSD)$/, m[0]);
  // The page code around it makes no request either
  const room = fs.readFileSync(path.join(__dirname, '..', 'extension', 'canvas-room.js'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(room, /\bfetch\(|XMLHttpRequest|WebSocket/);
  // The source is in the repo and rebuilds it: the build step is checked in
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'canvas', 'build.js')));
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'canvas', 'src', 'nodes.jsx')));
});
