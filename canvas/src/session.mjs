// One open .canvas file: what is on screen, what the file held when this page last read or wrote
// it, and the rules that keep the two together. No DOM, no React: it talks to the storage through the
// `call(type, args)` it is given (the native host or the picked folder: same answers), so node tests
// drive it against the real host core.
//
//   - A change on screen is written 300 ms after the last one (atomic, through the host), carrying the
//     hash of the file this page last saw.
//   - If the file changed meanwhile (the host answers "conflict" and hands over their text), or a
//     change push shows a new hash, their canvas is merged with mine by id (jsoncanvas.merge). A
//     card he just moved and a card the AI just added both survive; no question is asked.
//   - A file that is not valid JSON Canvas is never overwritten, and nothing is written while it is so.
//   - A file deleted or renamed from outside is NOT written again by the next change: the session stops
//     saving and asks ("Keep mine" writes it again, "Drop it" lets it go) (REVIEW-0.9.0 #4).
//   - Unsaved changes are also kept in `drafts` (the tab's sessionStorage), so closing the tab or reloading
//     the extension does not lose them (REVIEW-0.9.0 #2); they come back on the next load, merged.
//   - A save over the size cap the host reported is refused here, loudly, before anything is sent. A file on disk
//     that is too big or not text to be merged is kept apart until he says "Keep mine" (REVIEW-0.9.0 #1, #9).

import { parse, serialize, merge, same, emptyDoc } from './jsoncanvas.mjs';
import { enT } from './texts.mjs';

const bytesOf = (text) => new TextEncoder().encode(text).length;
const kb = (n) => `${n < 10 * 1024 ? (n / 1024).toFixed(1) : Math.round(n / 1024)} KB`;

export class CanvasSession {
  constructor({ call, space, file, folder, delay = 300, max = 0, drafts = null, normalize = (d) => d, t = enT, onRemote = () => {}, onStatus = () => {}, onDeleted = () => {}, onBlocked = () => {} }) {
    this.call = call;
    this.t = t; // (key, ...args) -> text in the person's language; the status lines are made with it
    this.normalize = normalize; // every canvas read from the file goes through this first, so the file's form and the screen's compare equal
    this.space = space;
    this.file = file;
    this.folder = folder; // the mega tab's folder inside the space, when the canvas sits in one
    this.delay = delay;
    this.max = max; // bytes (or a function giving them): the biggest file the storage takes, from its ping/list
    this.drafts = drafts; // { get(key), set(key, text), remove(key) } or null
    this.onRemote = onRemote; // (doc, prev): the screen's canvas changed because of an outside edit
    this.onDeleted = onDeleted; // (true|false): the file is gone from disk / is back
    this.onBlocked = onBlocked; // ({ reason, hash, size } | null): the file on disk cannot be merged
    this.onStatus = (t, alert = false) => {
      if (t === this.status && alert === this.alert) return;
      this.status = t;
      this.alert = alert;
      onStatus(t, alert); // (text, alert): '', Saving, Saved, Unsaved are quiet; Not saved (why) and a file that is not a canvas are alerts
    };
    this.status = '';
    this.alert = false; // the status is a loud banner, not a dim word
    this.hold = false; // tests (and nothing else) hold the autosave to keep a move unsaved
    this.base = null; // { hash, doc }: the file as this page last read or wrote it
    this.local = null; // the canvas on screen
    this.invalid = '';
    this.deleted = false; // gone from disk, waiting for his choice
    this.blocked = null;
    this.timer = null;
    this.saving = null;
    this.reading = false;
    this.again = false;
    this.again2 = false;
    this.latestEntry = undefined;
    this.gone = false; // he chose "Keep mine" on a deleted file: the next write creates it
    this.destroyed = false;
  }

  get draftKey() {
    return `canvas-draft:${this.space}/${this.folder ? this.folder + '/' : ''}${this.file}`;
  }

  #args(extra) {
    return { space: this.space, ...(this.folder ? { folder: this.folder } : {}), file: this.file, ...extra };
  }

  #maxBytes() {
    return typeof this.max === 'function' ? this.max() : this.max;
  }

  async load() {
    const r = await this.call('read', this.#args());
    let doc;
    try {
      doc = this.normalize(parse(r.text));
    } catch (e) {
      // Shown empty, and never written over what is there
      this.base = { hash: r.hash, doc: emptyDoc() };
      this.local = emptyDoc();
      this.invalid = this.t('sInvalid', e.message);
      this.onStatus(this.invalid, true);
      return this.local;
    }
    this.base = { hash: r.hash, doc };
    this.local = doc;
    this.#restoreDraft(doc, r.hash);
    return this.local;
  }

  // Unsaved changes left by a closed or reloaded tab come back, merged with what the file holds now
  #restoreDraft(doc, hash) {
    let d = null;
    try {
      d = JSON.parse(this.drafts?.get(this.draftKey) || 'null');
    } catch {
      d = null;
    }
    if (!d || !d.doc) return;
    try {
      const mine = this.normalize(d.doc);
      if (same(mine, doc)) return this.#dropDraft();
      this.local = d.hash === hash ? mine : merge(this.normalize(d.base || doc), mine, doc);
      if (!same(this.local, doc)) this.onStatus(this.t('statusUnsaved'));
    } catch {
      this.#dropDraft(); // a draft that does not read is not worth keeping
    }
  }

  #keepDraft() {
    if (!this.drafts) return;
    try {
      if (this.dirty) this.drafts.set(this.draftKey, JSON.stringify({ hash: this.base.hash, base: this.base.doc, doc: this.local }));
      else this.drafts.remove(this.draftKey);
    } catch {
      /* storage full or off: the file itself is still saved */
    }
  }

  #dropDraft() {
    try {
      this.drafts?.remove(this.draftKey);
    } catch {
      /* nothing to remove */
    }
  }

  get dirty() {
    return !!this.local && !same(this.local, this.base.doc);
  }

  // Something of his is not on disk yet, or waits for a choice: closing the tab should ask first
  get unsafe() {
    return !this.destroyed && !!this.base && (this.dirty || this.deleted || !!this.blocked);
  }

  // The screen's canvas now (called after every change on screen)
  setLocal(doc) {
    if (this.destroyed || !this.base) return;
    this.local = doc;
    if (this.invalid) return;
    clearTimeout(this.timer);
    this.#keepDraft();
    if (!this.dirty) {
      if (this.status === this.t('statusUnsaved')) this.onStatus(this.saving ? this.t('statusSaving') : '');
      return;
    }
    if (this.deleted) return; // waiting for his choice: nothing is written
    this.onStatus(this.t('statusUnsaved'));
    if (!this.hold) this.timer = setTimeout(() => this.save(), this.delay);
  }

  // Release a held autosave (tests)
  release() {
    this.hold = false;
    if (this.dirty) this.save();
  }

  save() {
    clearTimeout(this.timer);
    if (this.destroyed || this.invalid || this.deleted || this.blocked) return Promise.resolve();
    if (this.saving) {
      this.again = true;
      return this.saving;
    }
    this.saving = this.#write().finally(() => {
      this.saving = null;
      if (this.again && !this.destroyed) {
        this.again = false;
        if (this.dirty && !this.hold && !this.deleted && !this.blocked) this.timer = setTimeout(() => this.save(), this.delay);
      }
    });
    return this.saving;
  }

  async #write() {
    for (let i = 0; i < 6; i++) {
      if (!this.dirty && !this.gone) return;
      const doc = this.local;
      const text = serialize(doc);
      const max = this.#maxBytes();
      const size = bytesOf(text);
      if (max && size > max) {
        // Refused here, before anything is sent: the status is a loud banner on the page, and the next change tries again
        this.onStatus(this.t('sTooBig', kb(size), kb(max)), true);
        return;
      }
      this.onStatus(this.t('statusSaving'));
      try {
        const r = await this.call('write', this.#args({ text, base: this.gone ? null : this.base.hash }));
        this.base = { hash: r.hash, doc: this.normalize(parse(text)) };
        this.gone = false;
        this.#keepDraft();
        this.onStatus(this.t(this.dirty ? 'statusUnsaved' : 'statusSaved'));
        if (this.dirty && !this.hold) this.timer = setTimeout(() => this.save(), this.delay);
        return;
      } catch (e) {
        if (e.code === 'conflict' && e.reason === 'gone') {
          this.#markDeleted(); // deleted or renamed from outside since the last look: ask, never write it back unasked
          return;
        }
        if (e.code === 'conflict' && e.theirs) {
          if (!this.#reconcile(e.theirs.text, e.theirs.hash)) return;
          continue;
        }
        if (e.code === 'conflict' && e.hash) {
          // On disk now, but too big or not text: it cannot be merged. His canvas waits for "Keep mine".
          this.blocked = { reason: e.reason || 'changed', hash: e.hash, size: e.size ?? null };
          this.onStatus(this.t(this.blocked.reason === 'too-large' ? 'sBlockedBig' : 'sBlockedText'), true);
          this.onBlocked(this.blocked);
          return;
        }
        this.onStatus(this.t('notSavedWhy', e.code === 'offline' ? this.t('hostNotConnected') : e.message), true);
        return;
      }
    }
    this.onStatus(this.t('sKeepsChanging'), true);
  }

  #markDeleted() {
    clearTimeout(this.timer);
    this.deleted = true;
    this.onStatus(this.t('statusDeleted'));
    this.onDeleted(true);
  }

  // "Keep mine" on a file deleted from outside: it is written again, on purpose
  keepDeleted() {
    if (!this.deleted) return Promise.resolve();
    this.deleted = false;
    this.gone = true;
    this.onDeleted(false);
    return this.save();
  }

  // "Keep mine" over a file on disk that could not be merged: the write replaces it, on purpose
  keepOver() {
    if (!this.blocked) return Promise.resolve();
    this.base = { hash: this.blocked.hash, doc: this.base.doc };
    this.blocked = null;
    this.onBlocked(null);
    return this.save();
  }

  // "Drop it": the file is gone and he lets it go; nothing of it is kept
  drop() {
    this.deleted = false;
    this.local = this.base.doc;
    this.#dropDraft();
    this.onDeleted(false);
  }

  // Their text is the file now: merge it into the screen. Returns false when it cannot be merged.
  // final = false: a text that does not parse is not yet reported (a writer that truncates and then writes
  // is caught between the two)
  #reconcile(text, hash, final = true) {
    let theirs;
    try {
      theirs = this.normalize(parse(text));
    } catch (e) {
      if (!final) return false;
      this.invalid = this.t('sInvalidNow', e.message);
      this.onStatus(this.invalid, true);
      return false;
    }
    if (this.invalid) {
      this.invalid = '';
      this.onStatus('');
    }
    if (this.blocked) {
      this.blocked = null;
      this.onBlocked(null);
    }
    const merged = merge(this.base.doc, this.local, theirs);
    const prev = this.local;
    this.base = { hash, doc: theirs };
    this.gone = false;
    if (!same(merged, this.local)) {
      this.local = merged;
      this.onRemote(merged, prev);
    }
    this.#keepDraft();
    if (!this.dirty && this.status === this.t('statusUnsaved')) this.onStatus(this.saving ? this.t('statusSaving') : '');
    return true;
  }

  // A change push from the host for this file: `entry` is its list entry, or undefined when it is gone.
  // A push that arrives while a look is running is not dropped: the look runs once more on the newest one.
  async disk(entry) {
    if (this.destroyed || !this.base) return;
    if (this.reading) {
      this.again2 = true;
      this.latestEntry = entry;
      return;
    }
    this.reading = true;
    try {
      let cur = entry;
      for (;;) {
        this.again2 = false;
        await this.#look(cur);
        if (!this.again2 || this.destroyed) break;
        cur = this.latestEntry;
      }
    } finally {
      this.reading = false;
    }
  }

  async #look(entry) {
    if (!entry) {
      // Deleted or renamed on disk: what is on screen stays; he decides
      if (!this.deleted) this.#markDeleted();
      return;
    }
    if (this.deleted || this.gone) {
      // It is back (undo of a delete, a rename back): look at it like any change
      this.deleted = false;
      this.gone = false;
      this.onDeleted(false);
      if (this.dirty) this.onStatus(this.t('statusUnsaved'));
    }
    if (entry.hash === this.base.hash) {
      if (this.dirty && !this.saving) this.setLocal(this.local);
      return; // no change (his own save comes back this way)
    }
    let r;
    try {
      r = await this.call('read', this.#args());
    } catch {
      return; // gone or unreadable meanwhile: the next push says
    }
    if (this.destroyed || r.hash === this.base.hash) return;
    if (!this.#reconcile(r.text, r.hash, false)) {
      await new Promise((done) => setTimeout(done, 250));
      try {
        r = await this.call('read', this.#args());
      } catch {
        return;
      }
      if (this.destroyed || r.hash === this.base.hash) return;
      this.#reconcile(r.text, r.hash, true);
    }
    if (this.dirty && !this.saving) this.setLocal(this.local); // my unsaved changes are now on top of theirs
  }

  // Page closing or the room closing: what is unsaved is written now
  async flush() {
    clearTimeout(this.timer);
    if (this.dirty && !this.invalid && !this.deleted && !this.blocked) await this.save();
    else if (this.saving) await this.saving;
  }

  destroy() {
    this.destroyed = true;
    clearTimeout(this.timer);
  }
}
