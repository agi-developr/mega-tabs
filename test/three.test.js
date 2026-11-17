'use strict';
// C51 and C52 without a browser: the model fixture is a valid glTF binary and reproducible from its script, the .gltf
// twin is the same model, the palette helpers of the 3D view, and what the build step keeps out of the 3D bundle.
// (The browser side is test/three.chromium.test.js; the host and storage `model` request is in host.test.js and
// board-storage.test.js.)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { glb, gltfText } = require('./fixtures/make-vase');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures');

function readGlb(buf) {
  assert.equal(buf.toString('latin1', 0, 4), 'glTF', 'magic');
  assert.equal(buf.readUInt32LE(4), 2, 'glTF version 2');
  assert.equal(buf.readUInt32LE(8), buf.length, 'the header knows the file length');
  const chunks = [];
  for (let at = 12; at < buf.length; ) {
    const len = buf.readUInt32LE(at);
    const type = buf.toString('latin1', at + 4, at + 8);
    assert.equal(len % 4, 0, `${type} chunk is padded to 4 bytes`);
    chunks.push({ type, data: buf.subarray(at + 8, at + 8 + len) });
    at += 8 + len;
  }
  return { json: JSON.parse(chunks[0].data.toString('utf8')), jsonType: chunks[0].type, bin: chunks[1].data, binType: chunks[1].type, count: chunks.length };
}

test('fixture: test/fixtures/vase.glb is a valid, tiny glTF binary whose accessors fit its buffer and whose bounds are true', () => {
  const file = fs.readFileSync(path.join(FIX, 'vase.glb'));
  assert.ok(file.length < 64 * 1024, `tiny: ${file.length} bytes`);
  const g = readGlb(file);
  assert.deepEqual([g.jsonType, g.binType.replace(/\0/g, ''), g.count], ['JSON', 'BIN', 2]);
  assert.equal(g.json.asset.version, '2.0');
  assert.ok(g.json.buffers[0].byteLength <= g.bin.length);
  for (const v of g.json.bufferViews) assert.ok(v.byteOffset + v.byteLength <= g.bin.length, 'a buffer view stays inside the buffer');
  const [pos, nor, idx] = g.json.accessors;
  assert.equal(pos.count, nor.count);
  assert.equal(idx.count % 3, 0, 'whole triangles');
  const view = g.json.bufferViews[pos.bufferView];
  assert.equal(view.byteLength, pos.count * 12);
  const f = new Float32Array(g.bin.buffer.slice(g.bin.byteOffset + view.byteOffset, g.bin.byteOffset + view.byteOffset + view.byteLength));
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < f.length; i += 3) for (let k = 0; k < 3; k++) {
    min[k] = Math.min(min[k], f[i + k]);
    max[k] = Math.max(max[k], f[i + k]);
  }
  assert.deepEqual(pos.min.map((v) => +v.toFixed(5)), min.map((v) => +v.toFixed(5)), 'POSITION min is the real minimum (a reader needs it)');
  assert.deepEqual(pos.max.map((v) => +v.toFixed(5)), max.map((v) => +v.toFixed(5)));
  const ib = g.json.bufferViews[idx.bufferView];
  const ix = new Uint16Array(g.bin.buffer.slice(g.bin.byteOffset + ib.byteOffset, g.bin.byteOffset + ib.byteOffset + ib.byteLength));
  assert.ok(Math.max(...ix) < pos.count, 'every index points at a vertex');
  assert.equal(g.json.materials[0].pbrMetallicRoughness.baseColorTexture, undefined, 'no texture: it is self-contained');
  assert.equal(g.json.images, undefined);
});

test('fixture: the checked-in files are exactly what make-vase.js writes (so they are ours and reproducible), and the .gltf is the same model with its buffer inside', () => {
  assert.ok(fs.readFileSync(path.join(FIX, 'vase.glb')).equals(glb()), 'vase.glb is reproducible');
  assert.equal(fs.readFileSync(path.join(FIX, 'vase.gltf'), 'utf8'), gltfText(), 'vase.gltf is reproducible');
  const g = readGlb(fs.readFileSync(path.join(FIX, 'vase.glb')));
  const t = JSON.parse(fs.readFileSync(path.join(FIX, 'vase.gltf'), 'utf8'));
  assert.match(t.buffers[0].uri, /^data:application\/octet-stream;base64,/);
  const embedded = Buffer.from(t.buffers[0].uri.split(',')[1], 'base64');
  assert.ok(embedded.equals(g.bin), 'the same bytes');
  const { uri: _u, ...a } = t.buffers[0];
  assert.deepEqual([t.meshes, t.materials, t.accessors, a], [g.json.meshes, g.json.materials, g.json.accessors, g.json.buffers[0]]);
});

test('theme: the 3D view reads the Board palette (hex colors from the CSS variables) and mixes them; JSON Canvas preset colors are the muted tones the cards use', async () => {
  const { mix, cardColor, palette } = await import(pathToFileURL(path.join(ROOT, 'canvas', 'src', 'three-theme.mjs')).href);
  assert.equal(mix('#000000', '#ffffff', 0), '#000000');
  assert.equal(mix('#000000', '#ffffff', 1), '#ffffff');
  assert.equal(mix('#000000', '#ffffff', 0.5), '#808080');
  assert.equal(mix('#2b2b2b', '#f7f7f5', 0.25), '#5e5e5e');
  const pal = { dark: false, bg: '#f7f7f5', fg: '#2b2b2b' };
  assert.equal(cardColor(undefined, pal, '#123456'), '#123456', 'no color: the fallback');
  assert.equal(cardColor('9', pal, '#123456'), '#123456', 'an unknown preset: the fallback');
  assert.notEqual(cardColor('4', pal, '#123456'), '#123456', 'a preset is its muted tone');
  assert.match(cardColor('4', pal, '#000000'), /^#[0-9a-f]{6}$/);
  assert.equal(cardColor('#ff0000', pal, '#000000'), mix('#ff0000', pal.bg, 0.2), 'a hex color is softened toward the background, never neon');
  // with no browser the palette still answers (the page's own variables win when there are some)
  globalThis.matchMedia = () => ({ matches: false });
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
  assert.deepEqual(palette({}), { dark: false, bg: '#f7f7f5', fg: '#2b2b2b', dim: '#62625e', line: '#e6e6e2', card: '#ffffff' });
  globalThis.matchMedia = () => ({ matches: true });
  assert.equal(palette({}).bg, '#1c1c1e');
  globalThis.getComputedStyle = () => ({ getPropertyValue: (n) => (n === '--bg' ? ' #101010 ' : '') });
  assert.equal(palette({}).bg, '#101010', 'the page variable wins');
  delete globalThis.matchMedia;
  delete globalThis.getComputedStyle;
});

test('build: canvas/build.js refuses a package outside the permissive list, bans network and eval in both bundles, and swaps the two three.js loaders that use fetch for ones that read no URL', () => {
  const build = fs.readFileSync(path.join(ROOT, 'canvas', 'build.js'), 'utf8');
  assert.match(build, /ALLOWED = new Set\(\['MIT', 'ISC', 'BSD-3-Clause', 'BSD-2-Clause', 'Apache-2\.0', '0BSD'\]\)/);
  const banned = build.match(/BANNED = \[([^\]]*)\]/)[1];
  for (const word of ['fetch(', 'eval(', 'new Function', 'XMLHttpRequest', 'WebSocket', 'import.meta', 'sendBeacon', 'importScripts']) assert.ok(banned.includes(`'${word}'`), `${word} is banned`);
  assert.match(build, /check\('canvas\.js'\)/);
  assert.match(build, /check\('canvas3d\.js'\)/);
  const file = fs.readFileSync(path.join(ROOT, 'canvas', 'src', 'three-stubs', 'FileLoader.js'), 'utf8').replace(/\/\/.*$/gm, '');
  const bitmap = fs.readFileSync(path.join(ROOT, 'canvas', 'src', 'three-stubs', 'ImageBitmapLoader.js'), 'utf8').replace(/\/\/.*$/gm, '');
  for (const code of [file, bitmap]) assert.doesNotMatch(code, /\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon|eval\(|new Function/);
  assert.match(file, /only data: URLs/);
  assert.match(bitmap, /\(blob\|data\):/);
  // the page code that loads and feeds the bundle makes no request either
  const room = fs.readFileSync(path.join(ROOT, 'extension', 'canvas-room.js'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(room, /\bfetch\(|XMLHttpRequest|WebSocket/);
  // the 3D sources hold nothing that writes: no call of a write request anywhere in them
  for (const f of ['three-graph.mjs', 'three-model.mjs', 'three-entry.mjs']) {
    const code = fs.readFileSync(path.join(ROOT, 'canvas', 'src', f), 'utf8').replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(code, /call\(\s*['"](write|create|trash|untrash|rename)/, `${f} never writes`);
    assert.doesNotMatch(code, /enableNodeDrag\(\s*true/, `${f}: nodes of the 3D view are not draggable`);
  }
});

test('CSP: the Board page allows blob: for images only (a model\'s own pictures), and nothing else new', () => {
  const html = fs.readFileSync(path.join(ROOT, 'extension', 'board.html'), 'utf8');
  const csp = html.match(/Content-Security-Policy" content="([^"]+)"/)[1];
  assert.match(csp, /img-src 'self' data: blob:;/);
  assert.match(csp, /connect-src 'none'/);
  assert.match(csp, /media-src 'none'/);
  assert.match(csp, /script-src 'self'(;|$)/);
  assert.doesNotMatch(csp, /unsafe-eval|https?:|\*/);
  assert.equal((csp.match(/blob:/g) || []).length, 1, 'blob: appears once, in img-src');
});
