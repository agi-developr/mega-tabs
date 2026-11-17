// JSON Canvas 1.0 (https://jsoncanvas.org/spec/1.0/) as plain data: parse, validate, write, merge, and
// the conversion to and from React Flow's nodes and edges. No DOM and no React here, so the same
// code runs in the Board page (inside the bundle) and in node tests.
//
// One extension, `x-strokes` (top level): the pen's freehand strokes, [{ id, points: [[x, y], ...],
// color?, width? }] in canvas coordinates. A top-level field was chosen over nodes of type
// "x-stroke" because a reader that only looks at `nodes` and `edges` (Obsidian) ignores it, while a
// node with an unknown `type` is something a strict reader may refuse. See ISA.md Decisions.

import { enT } from './texts.mjs';

export const NODE_TYPES = ['text', 'file', 'link', 'group'];
export const SIDES = ['top', 'right', 'bottom', 'left'];
export const STROKES = 'x-strokes';

export function newId() {
  const b = new Uint8Array(8);
  globalThis.crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------- reading and writing

// The canvas as a plain object with `nodes` and `edges` arrays. Throws on text that is not a JSON object, and on
// an element this room could not keep as it is (no text `id`, or an id used twice): such a file is shown empty and
// never written over, so a save can never drop a card, edge or stroke (REVIEW-0.9.0 #5).
export function parse(text) {
  let v;
  try {
    v = JSON.parse(text);
  } catch {
    throw new Error('not JSON');
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not a JSON object');
  if (v.nodes !== undefined && !Array.isArray(v.nodes)) throw new Error('"nodes" is not an array');
  if (v.edges !== undefined && !Array.isArray(v.edges)) throw new Error('"edges" is not an array');
  if (v[STROKES] !== undefined && !Array.isArray(v[STROKES])) throw new Error('"x-strokes" is not an array');
  const lists = [['node', v.nodes || [], () => true], ['edge', v.edges || [], () => true], ['stroke', v[STROKES] || [], (s) => Array.isArray(s.points)]];
  for (const [what, list, extra] of lists) {
    const seen = new Set();
    list.forEach((x, i) => {
      if (!x || typeof x !== 'object' || Array.isArray(x)) throw new Error(`${what} ${i + 1} is not an object`);
      if (typeof x.id !== 'string' || !x.id) throw new Error(`${what} ${i + 1} has no text id`);
      if (seen.has(x.id)) throw new Error(`${what} id "${x.id}" is used twice`);
      seen.add(x.id);
      if (!extra(x)) throw new Error(`${what} "${x.id}" has no points`);
    });
  }
  return { ...v, nodes: v.nodes || [], edges: v.edges || [], ...(v[STROKES] ? { [STROKES]: v[STROKES] } : {}) };
}

export const emptyDoc = () => ({ nodes: [], edges: [] });

// Text for the file: tab-indented like Obsidian writes it, nodes and edges first, `x-strokes` last and left out
// when there are none. Each stroke is ONE line (its JSON, no indentation): a pretty-printed point costs a line of
// its own, and 120 handwriting strokes then filled the whole size cap (REVIEW-0.9.0 #1). Still plain valid JSON.
export function serialize(doc) {
  const { nodes = [], edges = [], [STROKES]: strokes, ...rest } = doc;
  const out = { nodes, edges, ...rest };
  if (!(strokes && strokes.length)) return JSON.stringify(out, null, '\t');
  const token = `\u0000strokes${newId()}\u0000`;
  out[STROKES] = token;
  const lines = strokes.map((s) => '\t\t' + JSON.stringify(s)).join(',\n');
  return JSON.stringify(out, null, '\t').replace(JSON.stringify(token), () => `[\n${lines}\n\t]`);
}

// Key order does not matter for "is this the same canvas": a stable text for comparing
export function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(v[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

// The canvas the way it is compared: both lists present, no empty `x-strokes`
export function canon(doc) {
  const { nodes = [], edges = [], [STROKES]: strokes, ...rest } = doc;
  return { ...rest, nodes, edges, ...(strokes && strokes.length ? { [STROKES]: strokes } : {}) };
}
export const same = (a, b) => stable(canon(a)) === stable(canon(b));

// ---------------------------------------------------------------- validation (the spec, nothing more)

const isInt = (n) => Number.isInteger(n);
const colorOk = (c) => typeof c === 'string' && (/^[1-6]$/.test(c) || /^#[0-9a-fA-F]{3,8}$/.test(c));

// Problems with a canvas as the JSON Canvas 1.0 spec states it; [] when it is valid. Extension fields are fine.
export function validate(doc) {
  const bad = [];
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return ['not an object'];
  const nodes = doc.nodes ?? [];
  const edges = doc.edges ?? [];
  if (!Array.isArray(nodes)) bad.push('nodes is not an array');
  if (!Array.isArray(edges)) bad.push('edges is not an array');
  if (bad.length) return bad;
  const ids = new Set();
  for (const [i, n] of nodes.entries()) {
    const w = `node ${i}`;
    if (typeof n.id !== 'string' || !n.id) bad.push(`${w}: id`);
    else if (ids.has(n.id)) bad.push(`${w}: duplicate id ${n.id}`);
    else ids.add(n.id);
    if (!NODE_TYPES.includes(n.type)) bad.push(`${w}: type ${JSON.stringify(n.type)}`);
    for (const k of ['x', 'y', 'width', 'height']) if (!isInt(n[k])) bad.push(`${w}: ${k} is not an integer`);
    if (n.color !== undefined && !colorOk(n.color)) bad.push(`${w}: color`);
    if (n.type === 'text' && typeof n.text !== 'string') bad.push(`${w}: text`);
    if (n.type === 'file') {
      if (typeof n.file !== 'string') bad.push(`${w}: file`);
      if (n.subpath !== undefined && !(typeof n.subpath === 'string' && n.subpath.startsWith('#'))) bad.push(`${w}: subpath`);
    }
    if (n.type === 'link' && typeof n.url !== 'string') bad.push(`${w}: url`);
    if (n.type === 'group') {
      if (n.label !== undefined && typeof n.label !== 'string') bad.push(`${w}: label`);
      if (n.background !== undefined && typeof n.background !== 'string') bad.push(`${w}: background`);
      if (n.backgroundStyle !== undefined && !['cover', 'ratio', 'repeat'].includes(n.backgroundStyle)) bad.push(`${w}: backgroundStyle`);
    }
  }
  const eids = new Set();
  for (const [i, e] of edges.entries()) {
    const w = `edge ${i}`;
    if (typeof e.id !== 'string' || !e.id) bad.push(`${w}: id`);
    else if (eids.has(e.id)) bad.push(`${w}: duplicate id ${e.id}`);
    else eids.add(e.id);
    for (const k of ['fromNode', 'toNode']) {
      if (typeof e[k] !== 'string') bad.push(`${w}: ${k}`);
      else if (!ids.has(e[k])) bad.push(`${w}: ${k} names no node`);
    }
    for (const k of ['fromSide', 'toSide']) if (e[k] !== undefined && !SIDES.includes(e[k])) bad.push(`${w}: ${k}`);
    for (const k of ['fromEnd', 'toEnd']) if (e[k] !== undefined && !['none', 'arrow'].includes(e[k])) bad.push(`${w}: ${k}`);
    if (e.color !== undefined && !colorOk(e.color)) bad.push(`${w}: color`);
    if (e.label !== undefined && typeof e.label !== 'string') bad.push(`${w}: label`);
  }
  return bad;
}

// ---------------------------------------------------------------- three-way merge by id

const eq = (a, b) => stable(a) === stable(b);

// One element (a node, an edge or a stroke): field by field, mine wins where I changed a field,
// theirs where only they did
function mergeFields(b, m, t) {
  const out = {};
  for (const k of new Set([...Object.keys(t), ...Object.keys(m), ...Object.keys(b)])) {
    const mine = eq(m[k], b[k]) ? 'same' : 'changed';
    const v = mine === 'same' ? t[k] : m[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

// base: what the file held when I last read or wrote it; mine: what is on my screen; theirs: the file now.
// Nothing I changed is lost and nothing they changed is lost, except where we changed the same field
// (mine wins, it is the newer one). A thing I deleted stays deleted; a thing only they deleted goes,
// unless I changed it meanwhile.
function mergeList(base, mine, theirs) {
  const b = new Map(base.map((x) => [x.id, x]));
  const m = new Map(mine.map((x) => [x.id, x]));
  const t = new Map(theirs.map((x) => [x.id, x]));
  const out = [];
  for (const id of [...new Set([...t.keys(), ...m.keys()])]) {
    const inB = b.has(id);
    if (m.has(id) && t.has(id)) {
      if (!inB) out.push(eq(m.get(id), t.get(id)) ? t.get(id) : m.get(id));
      else if (eq(m.get(id), b.get(id))) out.push(t.get(id));
      else if (eq(t.get(id), b.get(id))) out.push(m.get(id));
      else out.push(mergeFields(b.get(id), m.get(id), t.get(id)));
    } else if (m.has(id)) {
      if (!inB || !eq(m.get(id), b.get(id))) out.push(m.get(id)); // mine added, or changed after they deleted it
    } else if (!inB) out.push(t.get(id)); // theirs added
    // else: I deleted it. It stays deleted.
  }
  return out;
}

export function merge(base, mine, theirs) {
  const B = canon(base);
  const M = canon(mine);
  const T = canon(theirs);
  const nodes = mergeList(B.nodes, M.nodes, T.nodes);
  const alive = new Set(nodes.map((n) => n.id));
  const known = new Set([...B.nodes, ...M.nodes, ...T.nodes].map((n) => n.id));
  // An edge whose node was deleted by one of us goes with it; an edge that was never attached stays
  const attached = (id) => alive.has(id) || !known.has(id);
  const edges = mergeList(B.edges, M.edges, T.edges).filter((e) => attached(e.fromNode) && attached(e.toNode));
  const strokes = mergeList(B[STROKES] || [], M[STROKES] || [], T[STROKES] || []);
  const { nodes: _n, edges: _e, [STROKES]: _s, ...rb } = B;
  const { nodes: _n2, edges: _e2, [STROKES]: _s2, ...rm } = M;
  const { nodes: _n3, edges: _e3, [STROKES]: _s3, ...rt } = T;
  return canon({ ...mergeFields(rb, rm, rt), nodes, edges, ...(strokes.length ? { [STROKES]: strokes } : {}) });
}

// ---------------------------------------------------------------- React Flow <-> JSON Canvas

const round = (n) => Math.round(n);
export const DEFAULT_SIZE = { text: [260, 110], file: [260, 72], link: [260, 72], group: [360, 240] };

// Which side an edge leaves or enters when the file does not say: the side facing the other node
export function autoSides(a, b) {
  const ac = { x: a.position.x + (a.width ?? 0) / 2, y: a.position.y + (a.height ?? 0) / 2 };
  const bc = { x: b.position.x + (b.width ?? 0) / 2, y: b.position.y + (b.height ?? 0) / 2 };
  const dx = bc.x - ac.x;
  const dy = bc.y - ac.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? ['right', 'left'] : ['left', 'right'];
  return dy >= 0 ? ['bottom', 'top'] : ['top', 'bottom'];
}

// What a card is called to someone who cannot see it (keyboard and screen reader users reach it with Tab)
function nameOf(n, t) {
  const clip = (t) => (t.length > 60 ? t.slice(0, 57) + '...' : t);
  if (n.type === 'text') return n.text && n.text.trim() ? clip(n.text.trim().replace(/\s+/g, ' ')) : t('cvEmptyCard');
  if (n.type === 'file') return t('cvNodeNote', n.file ?? '');
  if (n.type === 'link') return t('cvNodeLink', n.url ?? '');
  if (n.type === 'group') return n.label ? t('cvNodeGroup', n.label) : t('cvGroup');
  return t('cvNodeType', n.type);
}

// What React Flow gets. The JSON Canvas node itself rides along in data.jc, so fields this
// code does not know about (and unknown node types) are written back as they were.
// `kinds`: custom node components the room has (nodes.jsx); a node asks for one with "x-kind".
export function toFlow(doc, kinds = [], t = enT) {
  const nodes = (doc.nodes || []).map((n) => ({
    id: n.id,
    type: kinds.includes(n['x-kind']) ? n['x-kind'] : NODE_TYPES.includes(n.type) ? n.type : 'unknown',
    position: { x: n.x ?? 0, y: n.y ?? 0 },
    width: n.width ?? 260,
    height: n.height ?? 100,
    ...(n.type === 'group' ? { zIndex: -1 } : {}),
    ariaLabel: nameOf(n, t),
    data: { jc: n },
  }));
  const edges = (doc.edges || []).map((e) => ({
    id: e.id,
    source: e.fromNode,
    target: e.toNode,
    sourceHandle: e.fromSide,
    targetHandle: e.toSide,
    label: e.label,
    data: { jc: e },
  }));
  return { nodes, edges };
}

// The canvas for a set of React Flow nodes and edges. `strokes` and `rest` (top-level fields
// this code does not know) come from the caller; `base` is only used to keep the node order.
export function fromFlow({ nodes, edges, strokes = [], rest = {} }) {
  const outNodes = nodes.map((n) => {
    const jc = { ...n.data.jc };
    const w = n.width ?? n.measured?.width ?? jc.width ?? DEFAULT_SIZE[jc.type]?.[0] ?? 260;
    const h = n.height ?? n.measured?.height ?? jc.height ?? DEFAULT_SIZE[jc.type]?.[1] ?? 100;
    return { ...jc, id: n.id, x: round(n.position.x), y: round(n.position.y), width: round(w), height: round(h) };
  });
  const outEdges = edges.map((e) => ({ ...e.data.jc, id: e.id, fromNode: e.source, toNode: e.target }));
  return canon({ ...rest, nodes: outNodes, edges: outEdges, ...(strokes.length ? { [STROKES]: strokes } : {}) });
}

// ---------------------------------------------------------------- strokes

// Ramer-Douglas-Peucker: the pen's points are thinned so a drawing stays small in the file
export function simplify(points, tol = 0.8) {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, z] = stack.pop();
    let max = 0;
    let at = -1;
    const [ax, ay] = points[a];
    const [zx, zy] = points[z];
    const len = Math.hypot(zx - ax, zy - ay);
    for (let i = a + 1; i < z; i++) {
      const [x, y] = points[i];
      // a closed stroke (end on its start) has no line to measure against: use the distance to that point
      const d = len < 1e-6 ? Math.hypot(x - ax, y - ay) : Math.abs((zy - ay) * x - (zx - ax) * y + zx * ay - zy * ax) / len;
      if (d > max) {
        max = d;
        at = i;
      }
    }
    if (max > tol && at > 0) {
      keep[at] = 1;
      stack.push([a, at], [at, z]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

// An SVG path through the points, rounded off with quadratic curves through the midpoints
const r1 = (n) => Math.round(n * 10) / 10;
export function strokePath(points) {
  if (!points.length) return '';
  const [x0, y0] = points[0].map(r1);
  if (points.length === 1) return `M${x0} ${y0}l.01 0`;
  if (points.length === 2) return `M${x0} ${y0}L${r1(points[1][0])} ${r1(points[1][1])}`;
  let d = `M${x0} ${y0}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [x, y] = points[i];
    const [nx, ny] = points[i + 1];
    d += `Q${r1(x)} ${r1(y)} ${r1((x + nx) / 2)} ${r1((y + ny) / 2)}`;
  }
  const [lx, ly] = points[points.length - 1];
  return `${d}L${r1(lx)} ${r1(ly)}`;
}
