'use strict';
// Writes vase.glb and vase.gltf next to this file: a small lathe-turned vase (about 40 KB), made by this script
// from nothing but numbers, so it is ours and CC0 (no copyright claimed). One mesh, one plain PBR material, no
// textures. vase.gltf is the same model as glTF JSON with its buffer embedded as a data: URI (self-contained).
//   node test/fixtures/make-vase.js

const fs = require('node:fs');
const path = require('node:path');

const SEG = 40; // steps around
// profile: [radius, height], bottom to top
const PROFILE = [[0, 0], [0.5, 0], [0.56, 0.04], [0.66, 0.2], [0.76, 0.45], [0.74, 0.7], [0.58, 0.95], [0.4, 1.12], [0.34, 1.26], [0.38, 1.36], [0.46, 1.42], [0.44, 1.44], [0.3, 1.38]];

function build() {
  const pos = [];
  const nor = [];
  const idx = [];
  const rows = PROFILE.length;
  for (let j = 0; j < rows; j++) {
    const [r, y] = PROFILE[j];
    const a = PROFILE[Math.max(0, j - 1)];
    const b = PROFILE[Math.min(rows - 1, j + 1)];
    const dr = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dr, dy) || 1;
    // outward normal of the profile in the (r, y) plane: the tangent turned a quarter
    const nr = dy / len;
    const ny = -dr / len;
    for (let i = 0; i <= SEG; i++) {
      const t = (i / SEG) * Math.PI * 2;
      pos.push(r * Math.cos(t), y, r * Math.sin(t));
      nor.push(nr * Math.cos(t), ny, nr * Math.sin(t));
    }
  }
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < SEG; i++) {
      const p = j * (SEG + 1) + i;
      const q = p + SEG + 1;
      idx.push(p, q, p + 1, p + 1, q, q + 1);
    }
  }
  return { pos: new Float32Array(pos), nor: new Float32Array(nor), idx: new Uint16Array(idx) };
}

function gltf(byteLength, uri) {
  const { pos } = build();
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) {
    min[k] = Math.min(min[k], pos[i + k]);
    max[k] = Math.max(max[k], pos[i + k]);
  }
  const m = build();
  return {
    asset: { version: '2.0', generator: 'megatabs test/fixtures/make-vase.js (CC0)' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'Vase' }],
    meshes: [{ name: 'Vase', primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }],
    materials: [{ name: 'Clay', pbrMetallicRoughness: { baseColorFactor: [0.72, 0.6, 0.5, 1], metallicFactor: 0, roughnessFactor: 0.62 } }],
    buffers: [uri ? { byteLength, uri } : { byteLength }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: m.pos.byteLength, target: 34962 },
      { buffer: 0, byteOffset: m.pos.byteLength, byteLength: m.nor.byteLength, target: 34962 },
      { buffer: 0, byteOffset: m.pos.byteLength + m.nor.byteLength, byteLength: m.idx.byteLength, target: 34963 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: m.pos.length / 3, type: 'VEC3', min, max },
      { bufferView: 1, componentType: 5126, count: m.nor.length / 3, type: 'VEC3' },
      { bufferView: 2, componentType: 5123, count: m.idx.length, type: 'SCALAR' },
    ],
  };
}

function binary() {
  const m = build();
  const parts = [Buffer.from(m.pos.buffer), Buffer.from(m.nor.buffer), Buffer.from(m.idx.buffer)];
  let bin = Buffer.concat(parts);
  if (bin.length % 4) bin = Buffer.concat([bin, Buffer.alloc(4 - (bin.length % 4))]);
  return bin;
}

function glb() {
  const bin = binary();
  let json = Buffer.from(JSON.stringify(gltf(bin.length)), 'utf8');
  if (json.length % 4) json = Buffer.concat([json, Buffer.alloc(4 - (json.length % 4), 0x20)]);
  const head = Buffer.alloc(12);
  head.write('glTF', 0, 'latin1');
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8);
  const ch = (len, type) => {
    const b = Buffer.alloc(8);
    b.writeUInt32LE(len, 0);
    b.write(type, 4, 'latin1');
    return b;
  };
  return Buffer.concat([head, ch(json.length, 'JSON'), json, ch(bin.length, 'BIN\0'), bin]);
}

function gltfText() {
  const bin = binary();
  return JSON.stringify(gltf(bin.length, 'data:application/octet-stream;base64,' + bin.toString('base64')));
}

if (require.main === module) {
  fs.writeFileSync(path.join(__dirname, 'vase.glb'), glb());
  fs.writeFileSync(path.join(__dirname, 'vase.gltf'), gltfText());
  console.log('vase.glb', glb().length, 'bytes; vase.gltf', gltfText().length, 'bytes');
}
module.exports = { glb, gltfText, build };
