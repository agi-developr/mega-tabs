// The node types of the Canvas room: one React component per kind of card. This module is the
// place to grow the canvas into its own custom pieces (a 2D chart, a 3D scene, ...): write the
// component, add it to `nodeTypes` under a kind name, and a node whose JSON Canvas entry carries
// `"x-kind": "<name>"` is drawn with it. Such a node is still an ordinary `text` node in the file
// (so Obsidian and other readers open the canvas unchanged); the extra field only tells this room
// which component draws it. The four standard types are drawn below.

import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Handle, Position, NodeResizer, useReactFlow } from '@xyflow/react';
import { enT } from './texts.mjs';

// What the Board page gives the cards: markdown rendering (sanitized there), the notes it knows, and
// the ways to open a file. `version` changes when the Board's file list does, so file cards re-read it.
export const HostContext = createContext({
  t: enT,
  render: (t) => t,
  noteTitle: () => null,
  openNote: () => {},
  openCanvas: () => {},
  cursorHref: () => '#',
  readModel: () => Promise.reject(new Error('no storage')),
  three: () => Promise.reject(new Error('no 3D bundle')),
  version: 0,
});

// A file card that points at a 3D model (glTF binary or text) shows the model itself
export const modelKind = (file) => (/\.glb$/i.test(file || '') ? 'glb' : /\.gltf$/i.test(file || '') ? 'gltf' : null);

const SIDES = [
  ['top', Position.Top],
  ['right', Position.Right],
  ['bottom', Position.Bottom],
  ['left', Position.Left],
];

// Four dots, one per side. Every dot can start or end a connection (ConnectionMode.Loose), so an
// edge's sides in the file (fromSide/toSide) are simply the dots it is attached to.
function Handles() {
  return SIDES.map(([id, position]) => <Handle key={id} id={id} type="source" position={position} className="cv-handle" />);
}

function Resizer({ selected, min = [120, 48] }) {
  return <NodeResizer isVisible={selected} minWidth={min[0]} minHeight={min[1]} lineClassName="cv-resize-line" handleClassName="cv-resize-handle" />;
}

const PRESETS = /^[1-6]$/;
// JSON Canvas colors: "1".."6" are presets (styled in canvas.css), anything else is a hex value
function colorProps(color) {
  if (!color) return {};
  if (PRESETS.test(color)) return { 'data-color': color };
  if (/^#[0-9a-fA-F]{3,8}$/.test(color)) return { style: { '--accent-card': color }, 'data-color': 'hex' };
  return {};
}

function useHost() {
  const h = useContext(HostContext);
  return h;
}

function TextNode({ id, data, selected }) {
  const host = useHost();
  const rf = useReactFlow();
  const { jc } = data;
  const [editing, setEditing] = useState(!!data.edit);
  const [draft, setDraft] = useState(jc.text ?? '');
  const area = useRef(null);
  const html = useMemo(() => (editing ? '' : host.render(jc.text ?? '')), [editing, jc.text, host]);
  // Every key goes into the canvas at once (and so into the session's draft): a tab closed or an extension
  // reloaded mid-sentence loses nothing, and an outside delete cannot take the typed text with it (REVIEW-0.9.0 #2)
  const seen = useRef(jc.text ?? '');
  useEffect(() => {
    const t = jc.text ?? '';
    if (t !== draft && draft === seen.current) setDraft(t); // rewritten from outside while he has typed nothing
    seen.current = t;
  }, [jc.text]); // eslint-disable-line react-hooks/exhaustive-deps
  const type = (value) => {
    setDraft(value);
    rf.updateNodeData(id, { jc: { ...jc, text: value } });
  };

  useEffect(() => {
    if (editing && area.current) {
      area.current.focus();
      area.current.setSelectionRange(area.current.value.length, area.current.value.length);
    }
  }, [editing]);

  const commit = () => {
    setEditing(false);
    const text = draft;
    if (data.fresh && !text.trim()) {
      rf.deleteElements({ nodes: [{ id }] }); // a card started and left empty is not kept
      return;
    }
    rf.updateNodeData(id, { edit: false, fresh: false, jc: { ...jc, text } });
    rf.updateNode(id, { ariaLabel: text.trim() ? text.trim().replace(/\s+/g, ' ').slice(0, 60) : host.t('cvEmptyCard') });
  };

  return (
    <div className="cv-card cv-text" {...colorProps(jc.color)} onDoubleClick={() => { setDraft(jc.text ?? ''); setEditing(true); }}>
      <Resizer selected={selected} />
      {editing ? (
        <textarea
          ref={area}
          className="cv-editor nodrag nowheel nopan"
          value={draft}
          placeholder={host.t('cvWriteHere')}
          aria-label={host.t('cvCardText')}
          onChange={(e) => type(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
              e.preventDefault();
              e.stopPropagation();
              commit();
            }
          }}
        />
      ) : (
        <div
          className="md cv-md nowheel"
          onClick={(e) => {
            const a = e.target.closest?.('a[data-md]');
            if (a) {
              e.preventDefault();
              host.openNote(a.getAttribute('data-md'));
            }
          }}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
      <Handles />
    </div>
  );
}

const DOC_ICON = (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M7 3h7l5 5v13H7z" />
    <path d="M14 3v5h5" />
  </svg>
);

const CUBE_ICON = (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" />
    <path d="M4 7.5l8 4.5 8-4.5M12 12v9" />
  </svg>
);

// A file in the space. A note at the top level opens in Notes, a canvas opens here; anything else
// (a MEGATAB.md in a folder, an image) is something the Board's host does not touch, so it is a
// link that opens in Cursor, as "Open in Cursor" does.
function FileNode({ data, selected }) {
  const host = useHost();
  const { jc } = data;
  const file = jc.file ?? '';
  if (modelKind(file)) return <ModelNode data={data} selected={selected} />;
  const top = !/[/\\]/.test(file);
  const isNote = top && /\.md$/i.test(file);
  const isCanvas = top && /\.canvas$/i.test(file);
  const title = isNote ? host.noteTitle(file) || file.replace(/\.md$/i, '') : file.split('/').pop();
  return (
    <div className="cv-card cv-file" {...colorProps(jc.color)} data-file={file}>
      <Resizer selected={selected} min={[120, 48]} />
      <span className="cv-icon">{DOC_ICON}</span>
      <div className="cv-file-text">
        {isNote || isCanvas ? (
          <button type="button" className="cv-open nodrag" onClick={() => (isNote ? host.openNote(file) : host.openCanvas(file))} title={host.t(isNote ? 'cvOpenNotes' : 'cvOpenCanvas')}>
            {title}
          </button>
        ) : (
          <a className="cv-open nodrag" href={host.cursorHref(file)} title={host.t('openCursor')}>
            {title}
          </a>
        )}
        <span className="cv-sub">{file}</span>
      </div>
      <Handles />
    </div>
  );
}

// A file card for a .glb or .gltf in the space folder: a name bar you drag the card by, and under it the model drawn
// with three.js (vendor/canvas3d.js, loaded now), turned by dragging on it. The bytes come through the host's read-only
// `model` request; nothing is ever written. A model that cannot be read or drawn says so in the card, quietly.
function ModelNode({ data, selected }) {
  const host = useHost();
  const { jc } = data;
  const file = jc.file ?? '';
  const view = useRef(null);
  const [state, setState] = useState('loading'); // 'loading' | 'ready' | a message
  const { readModel, three } = host;
  useEffect(() => {
    let dead = false;
    let handle = null;
    setState('loading');
    (async () => {
      const [T, got] = await Promise.all([three(), readModel(file)]);
      if (dead) return;
      handle = await T.model(view.current, got.bytes, { kind: modelKind(file), key: got.key, t: host.t });
      if (dead) return handle.destroy();
      view.current.__model = handle; // the page and tests look at the picture through this
      setState('ready');
    })().catch((e) => {
      if (!dead) setState(e.code === 'gone' ? host.t('cvModelGone') : e.code === 'too-large' ? host.t('cvModelBig') : host.t('cvModelFail', e.message || host.t('cvUnknownError')));
    });
    return () => {
      dead = true;
      handle?.destroy();
    };
  }, [file, readModel, three]);
  const name = file.split('/').pop().replace(/\.(glb|gltf)$/i, '');
  return (
    <div className="cv-card cv-model" {...colorProps(jc.color)} data-file={file} data-model={state === 'ready' ? 'ready' : state === 'loading' ? 'loading' : 'error'}>
      <Resizer selected={selected} min={[140, 150]} />
      <div className="cv-model-bar">
        <span className="cv-icon">{CUBE_ICON}</span>
        <div className="cv-file-text">
          <span className="cv-open">{name}</span>
          <span className="cv-sub">{file}</span>
        </div>
      </div>
      <div className="cv-model-view nodrag nopan" ref={view} />
      {state !== 'ready' ? <div className="cv-model-note" role={state === 'loading' ? 'status' : 'alert'}>{state === 'loading' ? host.t('cvLoadingModel') : state}</div> : null}
      <Handles />
    </div>
  );
}

function LinkNode({ data, selected }) {
  const { jc } = data;
  const url = jc.url ?? '';
  const web = /^https?:\/\//i.test(url);
  let host = url;
  try {
    host = new URL(url).hostname;
  } catch {
    /* shown as written */
  }
  return (
    <div className="cv-card cv-link" {...colorProps(jc.color)}>
      <Resizer selected={selected} />
      <span className="cv-icon">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
          <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
        </svg>
      </span>
      <div className="cv-file-text">
        {web ? (
          <a className="cv-open nodrag" href={url} target="_blank" rel="noopener noreferrer" title={url}>
            {host}
          </a>
        ) : (
          <span className="cv-open">{url}</span>
        )}
        <span className="cv-sub">{url}</span>
      </div>
      <Handles />
    </div>
  );
}

// A region with a label; it sits under the cards (z-index: first in the file's node list)
function GroupNode({ data, selected }) {
  const { jc } = data;
  return (
    <div className="cv-group" {...colorProps(jc.color)}>
      <Resizer selected={selected} min={[120, 80]} />
      {jc.label ? <span className="cv-group-label">{jc.label}</span> : null}
      <Handles />
    </div>
  );
}

// A node type this room does not know: kept as it is, shown plainly, never rewritten
function UnknownNode({ data }) {
  const host = useHost();
  return (
    <div className="cv-card cv-unknown">
      <span className="cv-sub">{host.t('cvNotShown', data.jc.type)}</span>
      <Handles />
    </div>
  );
}

export const nodeTypes = {
  text: TextNode,
  file: FileNode,
  link: LinkNode,
  group: GroupNode,
  unknown: UnknownNode,
};
