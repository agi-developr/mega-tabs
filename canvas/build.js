// Bundles the Canvas room into extension/vendor/:
//   canvas.js + canvas.css   React + React Flow + our code in src/ (the 2D room)
//   canvas3d.js              three.js + 3d-force-graph + a glTF reader + our code (the 3D view and 3D model cards),
//                            loaded only when a card shows a model or the 3D view is switched on
// and gathers the licenses of everything inside into extension/vendor/LICENSE-canvas-bundle.
// The extension never fetches anything: this runs once on a developer machine and its output is
// checked in.  Run:  cd canvas && bun install && bun run build   (then `node stamp.js` in the repo root)

import fs from 'node:fs';
import path from 'node:path';

const here = import.meta.dir;
const out = path.join(here, '..', 'extension', 'vendor');

const r = await Bun.build({
  entrypoints: [path.join(here, 'src', 'entry.jsx')],
  outdir: out,
  naming: 'canvas.[ext]',
  format: 'iife',
  target: 'browser',
  minify: true,
  // zustand (inside React Flow) reads import.meta.env.MODE; a classic script cannot contain import.meta
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{"MODE":"production"}' },
});
if (!r.success) {
  for (const l of r.logs) console.error(String(l));
  process.exit(1);
}

// Text no bundle may contain: no network, no eval. (test/canvas.test.js checks the same list on the built files.)
const BANNED = ['import.meta', 'eval(', 'new Function', 'fetch(', 'XMLHttpRequest', 'WebSocket', 'sendBeacon', 'importScripts'];
const check = (file) => {
  const js = fs.readFileSync(path.join(out, file), 'utf8');
  for (const bad of BANNED) if (js.includes(bad)) throw new Error(`${file} contains ${bad}: not allowed in an extension page script`);
};
check('canvas.js');

// ---- the 3D bundle. three.js reads URLs with fetch() in two loaders (FileLoader, ImageBitmapLoader); a model here
// never loads a URL, so those two modules are replaced by small ones that decode data:/blob: URLs in place and refuse
// everything else (src/three-stubs/). three-forcegraph has one more fetch(): its `jsonUrl` option (load a graph from
// a URL), which this view never sets; that call is replaced by a rejection. The WebGPU build, which 3d-force-graph imports and never uses, is replaced by
// an empty class. 'three' is bundled from its source files (three/src/Three.js) so each module can be swapped.
const threeSrc = path.join(here, 'node_modules', 'three', 'src');
const stub = (name) => fs.readFileSync(path.join(here, 'src', 'three-stubs', name), 'utf8').replaceAll('THREE_SRC', threeSrc.split(path.sep).join('/'));
const noNetwork = {
  name: 'three-without-network',
  setup(build) {
    build.onResolve({ filter: /^three$/ }, () => ({ path: path.join(threeSrc, 'Three.js') }));
    build.onResolve({ filter: /^three\/webgpu$/ }, () => ({ path: path.join(here, 'src', 'three-stubs', 'webgpu.js') }));
    build.onLoad({ filter: /three[\\/]src[\\/]loaders[\\/]FileLoader\.js$/ }, () => ({ contents: stub('FileLoader.js'), loader: 'js' }));
    build.onLoad({ filter: /three-forcegraph[\\/]dist[\\/]three-forcegraph\.mjs$/ }, async ({ path: file }) => {
      const code = await Bun.file(file).text();
      const call = 'fetch(jsonUrl).then(r => r.json())';
      if (!code.includes(call)) throw new Error('three-forcegraph changed: its jsonUrl fetch() is not where build.js expects it; look at it before bundling');
      return { contents: code.replace(call, 'Promise.reject(new Error("jsonUrl is not supported: this view never loads a URL"))'), loader: 'js' };
    });
    build.onLoad({ filter: /three[\\/]src[\\/]loaders[\\/]ImageBitmapLoader\.js$/ }, () => ({ contents: stub('ImageBitmapLoader.js'), loader: 'js' }));
  },
};
const r3 = await Bun.build({
  entrypoints: [path.join(here, 'src', 'three-entry.mjs')],
  outdir: out,
  naming: 'canvas3d.[ext]',
  format: 'iife',
  target: 'browser',
  minify: true,
  plugins: [noNetwork],
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{"MODE":"production"}' },
});
if (!r3.success) {
  for (const l of r3.logs) console.error(String(l));
  process.exit(1);
}
check('canvas3d.js');

// Licenses: every runtime package in node_modules (types-only packages ship no code)
const mods = path.join(here, 'node_modules');
const pkgs = [];
for (const d of fs.readdirSync(mods)) {
  if (d === '.bin' || d === '@types') continue;
  const dirs = d.startsWith('@') ? fs.readdirSync(path.join(mods, d)).map((x) => path.join(mods, d, x)) : [path.join(mods, d)];
  for (const dir of dirs) if (fs.existsSync(path.join(dir, 'package.json'))) pkgs.push(dir);
}
const ALLOWED = new Set(['MIT', 'ISC', 'BSD-3-Clause', 'BSD-2-Clause', 'Apache-2.0', '0BSD']);
let text = 'Third-party code bundled into canvas.js, canvas.css and canvas3d.js (extension/vendor/). Built by canvas/build.js.\nEvery license below is permissive (MIT, ISC, BSD or Apache); build.js refuses anything else.\n';
for (const dir of pkgs.sort()) {
  const p = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  if (!ALLOWED.has(p.license)) throw new Error(`${p.name}@${p.version}: license ${p.license} is not on the allowed list`);
  const file = fs.readdirSync(dir).find((f) => /^licen[sc]e(\.md|\.txt)?$/i.test(f));
  if (!file) throw new Error(`${p.name}: no license file`);
  text += `\n${'='.repeat(78)}\n${p.name}@${p.version} (${p.license})\n${'='.repeat(78)}\n${fs.readFileSync(path.join(dir, file), 'utf8').trim()}\n`;
}
fs.writeFileSync(path.join(out, 'LICENSE-canvas-bundle'), text);

for (const o of [...r.outputs, ...r3.outputs]) console.log(path.relative(path.join(here, '..'), o.path), `${(o.size / 1024).toFixed(0)} KB`);
console.log('LICENSE-canvas-bundle:', pkgs.length, 'packages');
