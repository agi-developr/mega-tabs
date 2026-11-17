'use strict';
// ISA C47: the Chrome Web Store images exist at the sizes the Store asks for, and the extension's icon set is square
// at the four manifest sizes. Dimensions and PNG colour type come from the file's own header; the pictures are looked
// at by eye (scripts/store-images.js builds them: CHROME=<Chrome for Testing> node scripts/store-images.js).
// store/ is a working-paper folder that does not ship in the public export, so without it the Store checks skip.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const IMAGES = path.join(ROOT, 'store', 'images');
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function header(file) {
  const b = fs.readFileSync(file);
  assert.ok(b.subarray(0, 8).equals(SIGNATURE), `${file} is not a PNG`);
  assert.equal(b.toString('latin1', 12, 16), 'IHDR');
  return { bytes: b.length, width: b.readUInt32BE(16), height: b.readUInt32BE(20), bitDepth: b[24], colorType: b[25] };
}

const SKIP = !fs.existsSync(IMAGES) && 'store/images is not in this copy';

// colour type 2 = 24-bit RGB, no alpha channel (what the Store asks for screenshots and tiles); 6 = RGBA
const STORE = [
  ['screenshot-1-switch.png', 1280, 800],
  ['screenshot-2-spaces.png', 1280, 800],
  ['screenshot-3-notes.png', 1280, 800],
  ['screenshot-4-canvas.png', 1280, 800],
  ['screenshot-5-private.png', 1280, 800],
  ['promo-small-440x280.png', 440, 280],
  ['promo-marquee-1400x560.png', 1400, 560],
];

for (const [name, width, height] of STORE) {
  test(`${name}: ${width}x${height}, 24-bit PNG without alpha, a sensible size`, { skip: SKIP }, () => {
    const h = header(path.join(IMAGES, name));
    assert.deepEqual([h.width, h.height], [width, height]);
    assert.equal(h.bitDepth, 8);
    assert.equal(h.colorType, 2, 'RGB without an alpha channel');
    assert.ok(h.bytes > 5 * 1024, `${h.bytes} bytes: nearly empty`);
    assert.ok(h.bytes < 2 * 1024 * 1024, `${h.bytes} bytes: too heavy for the Store`);
  });
}

test('icon-128.png: the Store icon, 128x128 with transparent padding', { skip: SKIP }, () => {
  const h = header(path.join(IMAGES, 'icon-128.png'));
  assert.deepEqual([h.width, h.height, h.colorType], [128, 128, 6]);
});

test('the manifest icons are our own square PNGs at 16, 32, 48 and 128', () => {
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'extension', 'manifest.json'), 'utf8'));
  assert.deepEqual(Object.keys(m.icons).sort((a, b) => a - b), ['16', '32', '48', '128']);
  for (const [size, rel] of Object.entries(m.icons)) {
    const h = header(path.join(ROOT, 'extension', rel));
    assert.deepEqual([h.width, h.height], [Number(size), Number(size)], rel);
    assert.equal(h.colorType, 6, `${rel} keeps its transparent corners`);
  }
  const act = m.action.default_icon;
  for (const rel of Object.values(act)) assert.ok(fs.existsSync(path.join(ROOT, 'extension', rel)), rel);
});

test('the store icon is the manifest 128 icon (same bytes)', { skip: SKIP }, () => {
  assert.ok(fs.readFileSync(path.join(IMAGES, 'icon-128.png')).equals(fs.readFileSync(path.join(ROOT, 'extension', 'icons', '128.png'))));
});
