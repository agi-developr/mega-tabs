// A glTF/GLB model drawn with three.js: in a card on the 2D canvas and (loadModel) as a node of the 3D view.
//
//   - loadModel(key, bytes, kind): parses the bytes ONCE per key into a unit-sized, centred object; every view clones it.
//   - mountModel(container, bytes, opts): a card's viewport. Orbit with a drag; no zoom (the wheel still moves the canvas).
//   - All cards share ONE WebGL renderer (a browser allows only a few contexts): each card renders into it when it
//     changes and copies the picture into its own 2D canvas, so a canvas with twenty models holds one context.
//   - No Draco, KTX2 or Meshopt decoders (they need workers or wasm the extension page does not load): a model
//     that needs one is refused with a plain message. No file is fetched: see three-stubs/.

import {
  CanvasTexture, CircleGeometry, Group, Box3, Vector3, Mesh, MeshBasicMaterial, NeutralToneMapping, PerspectiveCamera, PMREMGenerator,
  Scene, SRGBColorSpace, WebGLRenderer, MathUtils,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { clone } from 'three/addons/utils/SkeletonUtils.js';
import { darkNow, onThemeChange } from './three-theme.mjs';
import { enT } from './texts.mjs';

let t = enT; // the page's texts, set by mountModel

// ---------------------------------------------------------------- parsing

const parsed = new Map(); // key -> Promise<{ root, radius, bottom }>
const KEEP = 12;

function message(e) {
  const m = String(e?.message || e || 'unknown error');
  if (/DRACO|KTX2|MESHOPT|Draco|meshopt/i.test(m)) return t('cvModelCompressed');
  return m.replace(/^THREE\.GLTFLoader:\s*/, '');
}

export function loadModel(key, bytes, kind) {
  const hit = parsed.get(key);
  if (hit) return hit;
  const p = new Promise((resolve, reject) => {
    const input = kind === 'gltf' ? new TextDecoder('utf-8').decode(bytes) : bytes instanceof ArrayBuffer ? bytes : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    new GLTFLoader().parse(
      input,
      '',
      (gltf) => {
        const scene = gltf.scene || gltf.scenes?.[0];
        if (!scene) return reject(new Error('the file holds no scene'));
        scene.updateMatrixWorld(true);
        const box = new Box3().setFromObject(scene);
        if (box.isEmpty()) return reject(new Error('the model has nothing to draw'));
        const size = box.getSize(new Vector3());
        const center = box.getCenter(new Vector3());
        const max = Math.max(size.x, size.y, size.z) || 1;
        scene.position.sub(center);
        const root = new Group();
        root.add(scene);
        root.scale.setScalar(1 / max);
        root.updateMatrixWorld(true);
        resolve({ root, radius: size.length() / 2 / max, bottom: -size.y / 2 / max });
      },
      (e) => reject(new Error(message(e))),
    );
  });
  parsed.set(key, p);
  p.catch(() => parsed.delete(key));
  while (parsed.size > KEEP) parsed.delete(parsed.keys().next().value);
  return p;
}

// A copy that shares geometry and materials with the parsed model (cheap), safe to put in another scene
export const copyOf = (entry) => clone(entry.root);

// ---------------------------------------------------------------- the one shared renderer

let shared = null;
function sharedRenderer() {
  if (shared) return shared;
  const canvas = document.createElement('canvas');
  const r = new WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power' });
  r.setClearColor(0x000000, 0);
  r.toneMapping = NeutralToneMapping;
  const pm = new PMREMGenerator(r);
  const env = pm.fromScene(new RoomEnvironment(), 0.04).texture;
  pm.dispose();
  const s = { r, env, w: 0, h: 0 };
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    if (shared === s) shared = null;
  });
  shared = s;
  return s;
}

// The same soft light for every model: a room-like environment, no lamp to aim
export function lightScene(scene, env, intensity = 0.62) {
  scene.environment = env;
  scene.environmentIntensity = intensity;
}

// A faint disc of shade under the model: depth without a floor
function groundShade(bottom, dark) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 4, 64, 64, 62);
  grad.addColorStop(0, `rgba(0,0,0,${dark ? 0.5 : 0.24})`);
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  const m = new Mesh(new CircleGeometry(0.9, 40), new MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false }));
  m.rotation.x = -Math.PI / 2;
  m.position.y = bottom - 0.002;
  return m;
}

// ---------------------------------------------------------------- a card's viewport

const DIR = new Vector3(0.9, 0.5, 1.1).normalize();

class ModelView {
  constructor(container, entry) {
    this.container = container;
    this.entry = entry;
    this.dead = false;
    this.raf = 0;
    this.need = true;
    this.dark = darkNow();
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'mt-model';
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', t('cvModelScene'));
    this.canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;cursor:grab;outline-offset:-2px';
    this.ctx = this.canvas.getContext('2d');
    this.scene = new Scene();
    this.content = copyOf(entry);
    this.shade = groundShade(entry.bottom, this.dark);
    this.scene.add(this.content, this.shade);
    this.camera = new PerspectiveCamera(32, 1, 0.05, 50);
    this.camera.position.copy(DIR).multiplyScalar(3);
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableZoom = false;
    this.controls.enablePan = false;
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.rotateSpeed = 0.8;
    this.controls.maxPolarAngle = Math.PI / 2 + 0.25;
    this.controls.listenToKeyEvents(this.canvas);
    this.controls.addEventListener('start', () => (this.canvas.style.cursor = 'grabbing'));
    this.controls.addEventListener('end', () => (this.canvas.style.cursor = 'grab'));
    this.controls.addEventListener('change', () => this.kick());
    container.append(this.canvas);
    this.ro = new ResizeObserver(() => {
      this.need = true;
      this.kick();
    });
    this.ro.observe(container);
    this.stopTheme = onThemeChange(() => this.theme());
    this.kick();
  }

  theme() {
    this.dark = darkNow();
    this.scene.remove(this.shade);
    this.shade.material.map?.dispose();
    this.shade.material.dispose();
    this.shade.geometry.dispose();
    this.shade = groundShade(this.entry.bottom, this.dark);
    this.scene.add(this.shade);
    this.need = true;
    this.kick();
  }

  // Frames are drawn while something moves (a drag, the easing after it) and once after any other change
  kick() {
    if (this.raf || this.dead) return;
    const step = () => {
      this.raf = 0;
      if (this.dead) return;
      const moved = this.controls.update();
      if (moved || this.need) {
        this.need = false;
        this.paint();
        this.raf = requestAnimationFrame(step);
      }
    };
    this.raf = requestAnimationFrame(step);
  }

  fit(aspect) {
    const vfov = MathUtils.degToRad(this.camera.fov);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * aspect);
    const dist = (this.entry.radius / Math.sin(Math.min(vfov, hfov) / 2)) * 1.06;
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.camera.position.copy(this.controls.target).addScaledVector(dir, dist);
    this.controls.minDistance = this.controls.maxDistance = dist;
  }

  paint() {
    let S;
    try {
      S = sharedRenderer();
    } catch {
      return;
    }
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const rect = this.container.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    if (S.w !== w || S.h !== h) {
      S.r.setPixelRatio(1);
      S.r.setSize(w, h, false);
      S.w = w;
      S.h = h;
    }
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.fit(w / h);
    lightScene(this.scene, S.env);
    S.r.toneMappingExposure = this.dark ? 0.8 : 1; // a pale model does not glare on a dark card
    S.r.render(this.scene, this.camera);
    this.ctx.clearRect(0, 0, w, h);
    this.ctx.drawImage(S.r.domElement, 0, 0, w, h);
    this.painted = (this.painted || 0) + 1;
  }

  destroy() {
    this.dead = true;
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.stopTheme();
    this.controls.dispose();
    this.shade.material.map?.dispose();
    this.shade.material.dispose();
    this.shade.geometry.dispose();
    this.canvas.remove();
  }
}

// Shows `bytes` (a .glb, or a .gltf's text as bytes) in `container`; resolves to { destroy, stats } or rejects with a plain message
export async function mountModel(container, bytes, { kind = 'glb', key = '', t: given = enT } = {}) {
  t = given;
  try {
    sharedRenderer();
  } catch {
    throw new Error(t('cvNoWebgl'));
  }
  const entry = await loadModel(key || `${kind}:${bytes.byteLength}`, bytes, kind);
  const view = new ModelView(container, entry);
  return {
    destroy: () => view.destroy(),
    stats: () => ({ painted: view.painted || 0, width: view.canvas.width, height: view.canvas.height }),
    // the picture as drawn now (tests and screenshots)
    canvas: view.canvas,
  };
}
