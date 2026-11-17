// The bundle's one entry: window.MegatabsCanvas.mount(container, host) shows one .canvas file of a
// space in `container` and returns a handle. The Board page (extension/canvas-room.js) is the only caller.
//   host: { call(type, args), t(key, ...args) -> text in the person's language, space, file, folder?, max() -> bytes, drafts, render(md) -> safe html, noteTitle(file),
//           openNote(file), openCanvas(file), cursorHref(file), dropped(),
//           readModel(file) -> Promise<{ bytes, key }> (a .glb/.gltf of the space, read only), three() -> Promise<MegatabsThree> }
//   handle: { session, disk(entry), touch(), flush(), focusNode(id), view(), setView('2d'|'3d'), three() -> the 3D view's handle, unsafe, destroy() }

import { Component } from 'react';
import { createRoot } from 'react-dom/client';
import { ReactFlowProvider } from '@xyflow/react';
import '@xyflow/react/dist/base.css';
import './canvas.css';
import Canvas, { roundtrip } from './App.jsx';
import { CanvasSession } from './session.mjs';
import { enT } from './texts.mjs';

// One broken card must not take the whole Board page with it (REVIEW-0.9.0 #8): the room says so, and the
// file on disk is untouched (nothing is written from a screen that could not be drawn).
class Fence extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="cv-fail" role="alert">
        <p>{this.props.t('cvDrawFail', String(this.state.error.message || this.state.error))}</p>
        <p>{this.props.t('cvDrawFail2')}</p>
      </div>
    );
  }
}

async function mount(container, { call, t = enT, space, file, folder, max, drafts, render, noteTitle, openNote, openCanvas, cursorHref, dropped, readModel, three }) {
  const session = new CanvasSession({ call, t, space, file, folder, max, drafts, normalize: (d) => roundtrip(d) });
  const doc = await session.load();
  let version = 0;
  let api = {};
  const subs = new Set();
  const host = {
    subscribe: (f) => (subs.add(f), () => subs.delete(f)),
    getVersion: () => version,
    api: { t, render, noteTitle, openNote, openCanvas, cursorHref, dropped, readModel, three },
  };
  const root = createRoot(container);
  const setApi = (a) => {
    api = a;
  };
  root.render(
    <Fence t={t}>
      <ReactFlowProvider>
        <Canvas session={session} host={host} initial={doc} setApi={setApi} />
      </ReactFlowProvider>
    </Fence>,
  );
  return {
    session,
    disk: (entry) => session.disk(entry),
    touch() {
      version++;
      subs.forEach((f) => f());
    },
    flush: () => session.flush(),
    focusNode: (id) => api.focusNode?.(id),
    view: () => api.view?.() ?? '2d',
    setView: (v) => api.setView?.(v),
    three: () => api.three?.() ?? null,
    get unsafe() {
      return session.unsafe;
    },
    destroy() {
      session.destroy();
      root.unmount();
    },
  };
}

globalThis.MegatabsCanvas = { mount };
