// The 3D view of a canvas: 3d-force-graph (MIT) draws the cards as nodes and the edges as edges. It only READS the
// canvas it is given and has no way to write one: nodes are not draggable, so nothing here can change a file.
//
//   mountGraph(container, { open(jc) -> boolean, modelOf(jc) -> { read(): Promise<{ bytes, key }>, kind } | null })
//   -> { setDoc(doc), stats(), screenOf(id), destroy() }
//
// A node is a small, quiet shape with its name beside it: a sphere for a text card, a slim slab for a file, a cube for
// a link, a ring for a group; a file card that points at a .glb or .gltf is the model itself. Click a node: `open(jc)`
// decides (a note opens in Notes) and returns true; any other click flies the camera to the node. Drag orbits, the wheel
// zooms, right-drag pans. Colors come from the Board's palette, light and dark.

import ForceGraph3D from '3d-force-graph';
import {
  AmbientLight, BoxGeometry, CanvasTexture, DirectionalLight, Color, Group, Mesh, MeshStandardMaterial, NeutralToneMapping, PMREMGenerator, SphereGeometry, Sprite,
  SpriteMaterial, SRGBColorSpace, TorusGeometry,
} from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { cardColor, mix, onThemeChange, palette } from './three-theme.mjs';
import { copyOf, loadModel } from './three-model.mjs';
import { enT } from './texts.mjs';

const R = 4; // a node's radius, in scene units
const WORLD_PER_PX = 0.2; // size of a label's pixel in the scene

// The words under a node: a card's first line without its markdown, a file's name, a link's host, a group's label
function nameOf(jc, t) {
  const clip = (t) => (t.length > 30 ? t.slice(0, 28) + '...' : t);
  if (jc.type === 'text') {
    const line = String(jc.text || '').split('\n').map((l) => l.replace(/^[\s>#*\-+\d.)]+/, '').replace(/[*_`[\]]/g, '').trim()).find(Boolean);
    return clip(line || t('cvEmptyCard'));
  }
  if (jc.type === 'file') return clip(String(jc.file || '').split('/').pop().replace(/\.(md|glb|gltf|canvas)$/i, ''));
  if (jc.type === 'link') {
    try {
      return clip(new URL(jc.url).hostname);
    } catch {
      return clip(String(jc.url || t('cvLink')));
    }
  }
  if (jc.type === 'group') return clip(jc.label || t('cvGroup'));
  return clip(String(jc.type || ''));
}

function labelSprite(text, pal) {
  const dpr = 3;
  const px = 13 * dpr;
  const c = document.createElement('canvas');
  const g = c.getContext('2d');
  const font = `500 ${px}px -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif`;
  g.font = font;
  const w = Math.ceil(g.measureText(text).width) + 16 * dpr;
  const h = Math.ceil(px * 1.7);
  c.width = w;
  c.height = h;
  g.font = font;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineJoin = 'round';
  g.lineWidth = 5 * dpr;
  g.strokeStyle = pal.bg; // a halo in the background color keeps the words readable over edges
  g.strokeText(text, w / 2, h / 2 + 1);
  g.fillStyle = pal.fg;
  g.fillText(text, w / 2, h / 2 + 1);
  const map = new CanvasTexture(c);
  map.colorSpace = SRGBColorSpace;
  const s = new Sprite(new SpriteMaterial({ map, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }));
  s.scale.set((w / dpr) * WORLD_PER_PX, (h / dpr) * WORLD_PER_PX, 1);
  s.renderOrder = 10;
  return s;
}

// A light pull of every node toward the middle: a card with no edge stays near the others instead of drifting away
function gravity(k) {
  let nodes = [];
  const f = (alpha) => {
    for (const n of nodes) {
      n.vx -= n.x * k * alpha;
      n.vy -= n.y * k * alpha;
      n.vz -= n.z * k * alpha;
    }
  };
  f.initialize = (ns) => (nodes = ns);
  return f;
}

// A group is a region on the canvas, so in 3D it is pulled to the middle of the cards that sit inside it (by where they
// are on the flat canvas), and those cards are drawn lightly toward it
function groupsForce(members) {
  let nodes = [];
  const byId = () => new Map(nodes.map((n) => [n.id, n]));
  const f = (alpha) => {
    const map = byId();
    for (const [gid, ids] of members()) {
      const gn = map.get(gid);
      const ms = ids.map((id) => map.get(id)).filter(Boolean);
      if (!gn || !ms.length) continue;
      const c = ms.reduce((a, m) => [a[0] + m.x / ms.length, a[1] + m.y / ms.length, a[2] + m.z / ms.length], [0, 0, 0]);
      gn.vx += (c[0] - gn.x) * 0.5 * alpha;
      gn.vy += (c[1] - gn.y) * 0.5 * alpha;
      gn.vz += (c[2] - gn.z) * 0.5 * alpha;
      for (const m of ms) {
        m.vx += (gn.x - m.x) * 0.04 * alpha;
        m.vy += (gn.y - m.y) * 0.04 * alpha;
        m.vz += (gn.z - m.z) * 0.04 * alpha;
      }
    }
  };
  f.initialize = (ns) => (nodes = ns);
  return f;
}

const material = (hex, opts = {}) => new MeshStandardMaterial({ color: new Color(hex), roughness: 0.78, metalness: 0, ...opts });

// How a canvas node is told apart: the parts of it that change what is drawn
const sig = (jc, dark, t) => JSON.stringify([jc.type, jc.type === 'text' ? nameOf(jc, t) : '', jc.file, jc.url, jc.label, jc.color, dark]);

export function mountGraph(container, { open, modelOf, t = enT }) {
  let pal = palette(container);
  const g = new ForceGraph3D(container, { controlType: 'orbit', rendererConfig: { antialias: true, alpha: true, powerPreference: 'low-power' } });
  let dead = false;
  let settled = false;
  let fitted = false;
  const byId = new Map(); // canvas node id -> the graph's node object (it keeps its place when the canvas changes)
  const disposers = [];

  const bodyOf = (jc) => {
    const neutral = mix(pal.fg, pal.bg, pal.dark ? 0.5 : 0.6);
    if (jc.type === 'group') return { mesh: new Mesh(new TorusGeometry(R * 2.6, 0.22, 10, 64), material(cardColor(jc.color, pal, mix(pal.fg, pal.bg, 0.7)), { transparent: true, opacity: 0.75 })), lift: -R * 2.6 - 6.8 }; // the label sits above the ring
    if (jc.type === 'file') return { mesh: new Mesh(new BoxGeometry(R * 1.5, R * 1.9, R * 0.35), material(cardColor(jc.color, pal, mix(neutral, pal.fg, 0.12)))), lift: R * 1.05 };
    if (jc.type === 'link') return { mesh: new Mesh(new BoxGeometry(R * 1.3, R * 1.3, R * 1.3), material(cardColor(jc.color, pal, mix(neutral, pal.bg, 0.2)))), lift: R * 0.8 };
    return { mesh: new Mesh(new SphereGeometry(R, 28, 18), material(cardColor(jc.color, pal, neutral))), lift: R };
  };

  function buildNode(n) {
    const jc = n.jc;
    const grp = new Group();
    const body = bodyOf(jc);
    let lift = body.lift;
    grp.add(body.mesh);
    const model = modelOf?.(jc);
    if (model) {
      // the model itself replaces the placeholder as soon as it has loaded; until then (or if it cannot be read) the slab stays
      model
        .read()
        .then(({ bytes, key }) => loadModel(key, bytes, model.kind))
        .then((entry) => {
          if (dead || n.__dead) return;
          const obj = copyOf(entry);
          const wrap = new Group();
          wrap.add(obj);
          wrap.scale.setScalar(R * 4.2);
          grp.remove(body.mesh);
          body.mesh.geometry.dispose();
          grp.add(wrap);
          n.__model = true;
          label.position.y = -(R * 2.1 + 3);
        })
        .catch(() => {});
      lift = R * 2.1;
    }
    const label = labelSprite(nameOf(jc, t), pal);
    label.position.y = -(lift + 3.4);
    grp.add(label);
    return grp;
  }

  const links = () => g.graphData().links;

  // The whole graph in view: the camera looks at the middle of the nodes, from far enough that the farthest one (and its
  // label) is inside the pane at this size and shape
  function fit(ms = 0) {
    const ns = [...byId.values()].filter((n) => Number.isFinite(n.x));
    if (!ns.length) return;
    const c = ns.reduce((a, n) => [a[0] + n.x / ns.length, a[1] + n.y / ns.length, a[2] + n.z / ns.length], [0, 0, 0]);
    const r = Math.max(...ns.map((n) => Math.hypot(n.x - c[0], n.y - c[1], n.z - c[2]))) + 16;
    const cam = g.camera();
    const aspect = (container.clientWidth || 1) / (container.clientHeight || 1);
    const vfov = (cam.fov * Math.PI) / 180;
    const half = Math.min(vfov, 2 * Math.atan(Math.tan(vfov / 2) * aspect)) / 2;
    const dist = (r / Math.sin(half)) * 1.05;
    const dir = [0.22, 0.18, 1];
    const len = Math.hypot(...dir);
    g.cameraPosition({ x: c[0] + (dir[0] / len) * dist, y: c[1] + (dir[1] / len) * dist, z: c[2] + (dir[2] / len) * dist }, { x: c[0], y: c[1], z: c[2] }, ms);
  }
  let membership = new Map(); // group id -> ids of the cards inside it on the flat canvas
  g.d3Force('gravity', gravity(0.06));
  g.d3Force('groups', groupsForce(() => membership));
  g.d3Force('charge').strength(-150);
  g.d3Force('link').distance(48);
  g.backgroundColor('rgba(0,0,0,0)')
    .showNavInfo(false)
    .enableNodeDrag(false)
    .nodeLabel(() => '')
    .nodeThreeObject((n) => buildNode(n))
    .nodeThreeObjectExtend(false)
    .linkColor(() => mix(pal.dim, pal.bg, 0.15))
    .linkOpacity(0.7)
    .linkWidth(0.32)
    .linkResolution(6)
    .linkDirectionalArrowLength(2.4)
    .linkDirectionalArrowRelPos(1)
    .linkDirectionalArrowColor(() => mix(pal.dim, pal.bg, 0.15))
    .d3VelocityDecay(0.35)
    .cooldownTicks(180)
    .onEngineStop(() => {
      settled = true;
      if (!fitted && byId.size) {
        fitted = true;
        fit(400);
      }
    })
    .onNodeHover((n) => (container.style.cursor = n ? 'pointer' : ''))
    .onNodeClick((n) => {
      if (open?.(n.jc)) return;
      const dist = 70;
      const len = Math.hypot(n.x, n.y, n.z) || 1;
      g.cameraPosition({ x: n.x * (1 + dist / len), y: n.y * (1 + dist / len), z: n.z * (1 + dist / len) + (len < 1 ? dist : 0) }, n, 700);
    });

  // Two soft lights and the room's reflections: shapes read as shapes, nothing glows
  const key = new DirectionalLight(0xffffff, 0.8);
  key.position.set(0.6, 1, 1.4);
  g.lights([new AmbientLight(0xffffff, 0.75), key]);

  const controls = g.controls();
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.rotateSpeed = 0.7;
  controls.maxDistance = 2500;

  // the soft room light for any model and the node shapes
  const renderer = g.renderer();
  renderer.toneMapping = NeutralToneMapping;
  const pm = new PMREMGenerator(renderer);
  const env = pm.fromScene(new RoomEnvironment(), 0.04).texture;
  pm.dispose();
  const scene = g.scene();
  scene.environment = env;
  scene.environmentIntensity = 0.3;

  container.setAttribute('role', 'img');
  container.setAttribute('aria-label', t('cv3dScene'));

  const resize = () => g.width(container.clientWidth || 1).height(container.clientHeight || 1);
  resize();
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  disposers.push(() => ro.disconnect());

  disposers.push(
    onThemeChange(() => {
      pal = palette(container);
      for (const n of byId.values()) n.__sig = '';
      redraw();
    }),
  );

  // Rebuilds every node's object (a new color scheme, or a changed card) without moving anything
  function redraw() {
    g.nodeThreeObject((n) => buildNode(n));
    g.linkColor(() => mix(pal.dim, pal.bg, 0.15));
    g.linkDirectionalArrowColor(() => mix(pal.dim, pal.bg, 0.15));
  }

  // A small deterministic offset from the id, so the nodes start in a volume and not on one plane
  const hash = (s) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);

  function setDoc(doc) {
    const nodes = [];
    const ids = new Set();
    let changed = false;
    for (const jc of doc.nodes || []) {
      ids.add(jc.id);
      const s = sig(jc, pal.dark, t);
      let n = byId.get(jc.id);
      if (!n) {
        const h = hash(jc.id);
        n = { id: jc.id, x: (jc.x || 0) / 9, y: -(jc.y || 0) / 9, z: ((h % 23) - 11) * 3 };
        byId.set(jc.id, n);
        changed = true;
      } else if (n.__sig !== s) {
        // drawn differently now: a fresh node object (so its 3D object is rebuilt) that keeps the old one's place
        const { x, y, z, vx, vy, vz } = n;
        n.__dead = true;
        n = { id: jc.id, x, y, z, vx, vy, vz };
        byId.set(jc.id, n);
        changed = true;
      }
      n.__sig = s;
      n.jc = jc;
      nodes.push(n);
    }
    for (const [id, n] of byId) {
      if (!ids.has(id)) {
        n.__dead = true;
        byId.delete(id);
        changed = true;
      }
    }
    membership = new Map();
    for (const gr of (doc.nodes || []).filter((x) => x.type === 'group')) {
      const inside = (doc.nodes || []).filter((m) => m.type !== 'group' && m.x + (m.width || 0) / 2 >= gr.x && m.x + (m.width || 0) / 2 <= gr.x + gr.width && m.y + (m.height || 0) / 2 >= gr.y && m.y + (m.height || 0) / 2 <= gr.y + gr.height);
      membership.set(gr.id, inside.map((m) => m.id));
    }
    const l = (doc.edges || []).filter((e) => ids.has(e.fromNode) && ids.has(e.toNode) && e.fromNode !== e.toNode).map((e) => ({ id: e.id, source: e.fromNode, target: e.toNode }));
    const old = links().map((x) => `${x.source.id ?? x.source}>${x.target.id ?? x.target}`).join('|');
    if (!changed && old === l.map((x) => `${x.source}>${x.target}`).join('|')) return; // the same graph: nothing moves
    settled = false;
    g.graphData({ nodes, links: l });
  }

  return {
    setDoc,
    stats: () => {
      const p = g.camera().position;
      return { nodes: byId.size, links: links().length, settled, models: [...byId.values()].filter((n) => n.__model).length, camera: [p.x, p.y, p.z], target: controls.target.toArray(), dark: pal.dark };
    },
    // where a node is on screen, in px from the container's top left (null before it has a place)
    screenOf(id) {
      const n = byId.get(id);
      if (!n || n.x === undefined) return null;
      const p = g.graph2ScreenCoords(n.x, n.y, n.z);
      return { x: p.x, y: p.y };
    },
    // the whole graph in view at once (the same fit the first settle makes)
    fit: () => fit(0),
    renderer, // tests and screenshots read the picture through it
    destroy() {
      dead = true;
      for (const n of byId.values()) n.__dead = true;
      disposers.forEach((f) => f());
      try {
        g._destructor();
      } catch {
        /* already gone */
      }
      renderer.forceContextLoss?.();
      container.replaceChildren();
    },
  };
}
