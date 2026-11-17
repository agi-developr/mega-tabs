// The 3D bundle's one entry (vendor/canvas3d.js, a classic script): window.MegatabsThree. It is loaded the first time a
// card shows a 3D model or the 3D view is switched on, so a canvas without either never pays for three.js.
//   MegatabsThree.model(container, bytes, { kind: 'glb' | 'gltf', key }) -> Promise<{ destroy, stats, canvas }>
//   MegatabsThree.graph(container, { open, modelOf }) -> { setDoc, stats, screenOf, destroy }   (three-graph.mjs)
import { mountModel } from './three-model.mjs';
import { mountGraph } from './three-graph.mjs';

globalThis.MegatabsThree = { model: mountModel, graph: mountGraph };
