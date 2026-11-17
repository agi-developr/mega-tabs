// Undo and redo for one open canvas (C31): a stack of whole canvases, 50 steps back. No DOM, no React.
//
//   record(doc)   the screen's canvas now; a change from the one before it becomes one step. Typing in one card
//                 is one step per pause, not one per key.
//   undo() / redo()   the canvas to show, or null when there is nothing to go to
//   rebase(prev, next)   an outside edit was merged into the screen (prev -> next): the same edit is merged into
//                 every step, so Cmd+Z never takes back what the AI added and never brings back what it removed.

import { merge, same, canon, STROKES } from './jsoncanvas.mjs';

export const LIMIT = 50;
const COALESCE_MS = 1000;

// When the only difference is the text of one card: that card's id (typing), else null
function typingIn(a, b) {
  const A = canon(a);
  const B = canon(b);
  if (A.nodes.length !== B.nodes.length || !same({ ...A, nodes: [] }, { ...B, nodes: [] })) return null;
  let id = null;
  for (let i = 0; i < A.nodes.length; i++) {
    const x = A.nodes[i];
    const y = B.nodes[i];
    if (x.id !== y.id) return null;
    if (same({ nodes: [x], edges: [] }, { nodes: [y], edges: [] })) continue;
    if (id || !same({ nodes: [{ ...x, text: '' }], edges: [] }, { nodes: [{ ...y, text: '' }], edges: [] })) return null;
    id = x.id;
  }
  return id;
}

export class History {
  constructor({ limit = LIMIT, now = () => Date.now() } = {}) {
    this.limit = limit;
    this.now = now;
    this.past = [];
    this.future = [];
    this.present = null;
    this.typing = null; // { id, at }: the card being typed in, and when the last key came
  }

  get canUndo() {
    return this.past.length > 0;
  }

  get canRedo() {
    return this.future.length > 0;
  }

  record(doc) {
    const d = canon(doc);
    if (!this.present) {
      this.present = d;
      return false;
    }
    if (same(d, this.present)) return false;
    const id = typingIn(this.present, d);
    const t = this.now();
    const more = id && this.typing && this.typing.id === id && t - this.typing.at < COALESCE_MS && this.past.length > 0;
    this.typing = id ? { id, at: t } : null;
    if (!more) {
      this.past.push(this.present);
      if (this.past.length > this.limit) this.past.shift();
    }
    this.present = d;
    this.future = [];
    return true;
  }

  undo() {
    if (!this.past.length) return null;
    this.future.push(this.present);
    this.present = this.past.pop();
    this.typing = null;
    return this.present;
  }

  redo() {
    if (!this.future.length) return null;
    this.past.push(this.present);
    this.present = this.future.pop();
    this.typing = null;
    return this.present;
  }

  rebase(prev, next) {
    const go = (s) => merge(prev, s, next);
    this.past = this.past.map(go);
    this.future = this.future.map(go);
    this.present = canon(next);
    this.typing = null;
  }
}

export { STROKES };
