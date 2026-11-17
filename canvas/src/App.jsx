// The Canvas room: React Flow showing one JSON Canvas file, a small toolbar (select, card, pen,
// eraser, delete), and the glue to a CanvasSession, which owns saving and merging outside edits.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ReactFlow, Background, BackgroundVariant, Controls, ConnectionMode, MarkerType, ViewportPortal, useNodesState, useEdgesState, useReactFlow } from '@xyflow/react';
import { HostContext, modelKind, nodeTypes } from './nodes.jsx';
import { DEFAULT_SIZE, NODE_TYPES, STROKES, autoSides, fromFlow, newId, simplify, strokePath, stable, toFlow } from './jsoncanvas.mjs';
import { History } from './history.mjs';
import { enT } from './texts.mjs';

export const KINDS = Object.keys(nodeTypes).filter((k) => !NODE_TYPES.includes(k) && k !== 'unknown');

const restOf = (doc) => {
  const { nodes: _n, edges: _e, [STROKES]: _s, ...rest } = doc;
  return rest;
};

// A canvas as it comes back from the screen's state: used so a file and its screen form compare equal
export const roundtrip = (doc) => {
  const f = toFlow(doc, KINDS);
  return fromFlow({ nodes: f.nodes, edges: f.edges, strokes: doc[STROKES] || [], rest: restOf(doc) });
};

const ICONS = {
  select: <path d="M5 3l14 7-6 2-2 6z" />,
  card: (
    <>
      <rect x="4" y="5" width="16" height="14" rx="3" />
      <path d="M8 10h8M8 14h5" />
    </>
  ),
  pen: <path d="M4 20l1-4L16 5a2 2 0 0 1 3 3L8 19z M14 7l3 3" />,
  eraser: <path d="M8 19h11M5 15l9-9a2 2 0 0 1 3 0l2 2a2 2 0 0 1 0 3l-6 6H9z M9 19" />,
  trash: <path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13M10 11v6M14 11v6" />,
  undo: <path d="M9 7L5 11l4 4M5 11h9a5 5 0 0 1 0 10h-3" />,
  redo: <path d="M15 7l4 4-4 4M19 11h-9a5 5 0 0 0 0 10h3" />,
};
const Icon = ({ name }) => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {ICONS[name]}
  </svg>
);

// The 3D view of the same canvas (three.js with 3d-force-graph, vendor/canvas3d.js, loaded the first time it is switched on).
// It only reads: what is on the 2D screen goes in, a click on a card opens it, and nothing it does is written to the file.
function Graph3D({ host, doc, handle }) {
  const box = useRef(null);
  const docRef = useRef(doc);
  docRef.current = doc;
  const g = useRef(null);
  const [problem, setProblem] = useState('');
  const { api } = host;
  useEffect(() => {
    let dead = false;
    let made = null;
    const open = (jc) => {
      if (jc.type === 'file') {
        const f = jc.file ?? '';
        const top = !/[/\\]/.test(f);
        if (top && /\.md$/i.test(f)) return api.openNote(f), true; // a note opens in Notes
        if (top && /\.canvas$/i.test(f)) return api.openCanvas(f), true;
        if (modelKind(f)) return false; // a model: the camera goes to it
        const href = api.cursorHref(f);
        if (href) {
          const a = document.createElement('a');
          a.href = href;
          a.click();
          return true;
        }
        return false;
      }
      if (jc.type === 'link' && /^https?:\/\//i.test(jc.url || '')) return window.open(jc.url, '_blank', 'noopener,noreferrer'), true;
      return false;
    };
    const modelOf = (jc) => (jc.type === 'file' && modelKind(jc.file) ? { kind: modelKind(jc.file), read: () => api.readModel(jc.file) } : null);
    api
      .three()
      .then((T) => {
        if (dead) return;
        made = T.graph(box.current, { open, modelOf, t: api.t });
        g.current = made;
        made.setDoc(docRef.current);
        handle.current = made;
      })
      .catch((e) => !dead && setProblem(e.message || api.t('cvDidNotLoad')));
    return () => {
      dead = true;
      handle.current = null;
      g.current = null;
      made?.destroy();
    };
  }, [api, handle]);
  useEffect(() => {
    g.current?.setDoc(doc);
  }, [doc]);
  return (
    <>
      <div className="cv-3d" ref={box} data-view="3d" />
      {problem ? <div className="cv-3d-note" role="alert">{api.t('cvThreeFailed', problem)}</div> : null}
    </>
  );
}

// i18n-keys: cvSelect cvCard cvPen cvEraser
const TOOLS = [
  ['select', 'cvSelect'],
  ['card', 'cvCard'],
  ['pen', 'cvPen'],
  ['eraser', 'cvEraser'],
];

const round1 = (n) => Math.round(n * 10) / 10;
const typing = (t) => t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);

function Canvas({ session, host, initial, setApi }) {
  const rf = useReactFlow();
  const t = host.api.t ?? enT;
  const first = useMemo(() => toFlow(initial, KINDS, t), [initial, t]);
  const [nodes, setNodes, onNodesChange] = useNodesState(first.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(first.edges);
  const [strokes, setStrokes] = useState(initial[STROKES] || []);
  const [tool, setTool] = useState('select');
  const [view, setViewState] = useState('2d'); // '2d' the canvas, '3d' the same file as a 3D graph (read only)
  const viewRef = useRef('2d');
  const setView = useCallback((v) => {
    viewRef.current = v;
    setViewState(v);
    if (v === '3d') setTool('select');
  }, []);
  const three = useRef(null); // the 3D view's handle while it is on screen
  const [status, setStatus] = useState({ text: '', alert: false }); // alert: a loud banner (Not saved, not a canvas), else a dim word
  const [dragging, setDragging] = useState(false);
  const [draft, setDraft] = useState(null); // the stroke being drawn: [[x, y], ...]
  const [deleted, setDeleted] = useState(false); // the file is gone from disk: Keep mine / Drop it
  const [blocked, setBlocked] = useState(null); // the file on disk is too big or not text: Keep mine
  const [steps, setSteps] = useState({ undo: false, redo: false });
  const history = useRef(null);
  if (!history.current) {
    history.current = new History();
    history.current.record(initial);
  }
  const rest = useRef(restOf(initial));
  const wrap = useRef(null);
  const live = useRef({});
  live.current = { nodes, edges, strokes };
  const version = useSyncExternalStore(host.subscribe, host.getVersion);
  const hostValue = useMemo(() => ({ ...host.api, version }), [host, version]);
  // What the 3D view shows: the canvas as it is on the 2D screen right now (the AI's edits and his own moves included)
  const doc3 = useMemo(() => (view === '3d' ? fromFlow({ nodes, edges, strokes, rest: rest.current }) : null), [view, nodes, edges, strokes]);

  // The screen's canvas goes to the session after every change (not while a card is being dragged), and
  // into the undo history
  useEffect(() => {
    if (dragging) return;
    const doc = fromFlow({ nodes, edges, strokes, rest: rest.current });
    session.setLocal(doc);
    history.current.record(doc);
    setSteps({ undo: history.current.canUndo, redo: history.current.canRedo });
  }, [nodes, edges, strokes, dragging, session]);

  // An outside edit, merged by the session: the screen follows, keeping what is selected and what is
  // being dragged
  const applyDoc = useCallback((doc) => {
    const f = toFlow(doc, KINDS, t);
    rest.current = restOf(doc);
    setNodes((cur) => {
      const old = new Map(cur.map((n) => [n.id, n]));
      return f.nodes.map((n) => {
        const o = old.get(n.id);
        if (!o) return n;
        const keepPos = o.dragging;
        const unchanged = stable(o.data.jc) === stable(n.data.jc) && (keepPos || (o.position.x === n.position.x && o.position.y === n.position.y)) && o.width === n.width && o.height === n.height;
        if (unchanged) return o;
        return { ...o, ...n, selected: o.selected, ...(keepPos ? { position: o.position, dragging: true } : {}), data: { ...o.data, jc: n.data.jc } };
      });
    });
    setEdges((cur) => {
      const old = new Map(cur.map((e) => [e.id, e]));
      return f.edges.map((e) => {
        const o = old.get(e.id);
        if (!o) return e;
        return stable(o.data.jc) === stable(e.data.jc) && o.source === e.source && o.target === e.target ? o : { ...o, ...e, selected: o.selected };
      });
    });
    setStrokes(doc[STROKES] || []);
  }, [setNodes, setEdges, t]);

  // Cmd+Z / Shift+Cmd+Z: a step back or forward; the result is saved like any other change
  const stepBy = useCallback((dir) => {
    const doc = dir < 0 ? history.current.undo() : history.current.redo();
    if (!doc) return;
    applyDoc(doc);
    setSteps({ undo: history.current.canUndo, redo: history.current.canRedo });
  }, [applyDoc]);

  useEffect(() => {
    session.onRemote = (doc, prev) => {
      history.current.rebase(prev, doc); // the outside edit is in every step, so undo never takes it back
      applyDoc(doc);
    };
    session.onStatus = (text, alert) => setStatus({ text, alert: !!alert });
    session.onDeleted = setDeleted;
    session.onBlocked = setBlocked;
    setStatus({ text: session.status, alert: session.alert });
    setDeleted(session.deleted);
    setBlocked(session.blocked);
    setApi({
      setTool,
      three: () => three.current,
      view: () => viewRef.current,
      setView,
      focusNode: (id) => {
        setNodes((cur) => cur.map((n) => (n.selected === (n.id === id) ? n : { ...n, selected: n.id === id })));
        rf.fitView({ nodes: [{ id }], padding: 0.6, maxZoom: 1, duration: 200 });
      },
    });
    return () => {
      session.onRemote = () => {};
      session.onStatus = () => {};
      session.onDeleted = () => {};
      session.onBlocked = () => {};
    };
  }, [session, applyDoc, setApi, setNodes, rf, setView]);

  // ---------------------------------------------------------------- cards

  const addCard = useCallback((at) => {
    const [w, h] = DEFAULT_SIZE.text;
    const box = wrap.current.getBoundingClientRect();
    const p = at || rf.screenToFlowPosition({ x: box.left + box.width / 2, y: box.top + box.height / 2 });
    let x = Math.round(p.x - w / 2);
    let y = Math.round(p.y - h / 2);
    const taken = (a, b) => live.current.nodes.some((n) => Math.abs(n.position.x - a) < 12 && Math.abs(n.position.y - b) < 12);
    while (taken(x, y)) {
      x += 28;
      y += 28;
    }
    const id = newId();
    const jc = { id, type: 'text', text: '', x, y, width: w, height: h };
    setNodes((cur) => [...cur.map((n) => (n.selected ? { ...n, selected: false } : n)), { id, type: 'text', position: { x, y }, width: w, height: h, selected: true, ariaLabel: t('cvEmptyCard'), data: { jc, edit: true, fresh: true } }]);
    setTool('select');
  }, [rf, setNodes, t]);

  const onConnect = useCallback((c) => {
    if (!c.source || !c.target || c.source === c.target) return;
    const jc = {};
    if (c.sourceHandle) jc.fromSide = c.sourceHandle;
    if (c.targetHandle) jc.toSide = c.targetHandle;
    setEdges((cur) => [...cur, { id: newId(), source: c.source, target: c.target, sourceHandle: c.sourceHandle ?? undefined, targetHandle: c.targetHandle ?? undefined, data: { jc } }]);
  }, [setEdges]);

  const selected = nodes.some((n) => n.selected) || edges.some((e) => e.selected);
  const deleteSelected = useCallback(() => {
    const { nodes: ns, edges: es } = live.current;
    rf.deleteElements({ nodes: ns.filter((n) => n.selected).map((n) => ({ id: n.id })), edges: es.filter((e) => e.selected).map((e) => ({ id: e.id })) });
  }, [rf]);

  // Edges the file gives no sides for leave from the side facing the other card. Display only: the
  // file is written with the sides it had (or the ones he made by dragging).
  const shown = useMemo(() => {
    const by = new Map(nodes.map((n) => [n.id, n]));
    return edges.map((e) => {
      const jc = e.data.jc;
      let { sourceHandle, targetHandle } = e;
      const a = by.get(e.source);
      const b = by.get(e.target);
      if ((!sourceHandle || !targetHandle) && a && b) {
        const [s, t] = autoSides(a, b);
        sourceHandle = sourceHandle || s;
        targetHandle = targetHandle || t;
      }
      const arrow = { type: MarkerType.ArrowClosed, width: 14, height: 14 };
      return { ...e, sourceHandle, targetHandle, markerEnd: jc.toEnd === 'none' ? undefined : arrow, markerStart: jc.fromEnd === 'arrow' ? arrow : undefined };
    });
  }, [nodes, edges]);

  // ---------------------------------------------------------------- pen and eraser

  const pen = useRef(null);
  const down = (e) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const p = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    pen.current = [[round1(p.x), round1(p.y)]];
    setDraft(pen.current);
  };
  const move = (e) => {
    if (!pen.current) return;
    const p = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    const last = pen.current[pen.current.length - 1];
    if (Math.hypot(p.x - last[0], p.y - last[1]) < 0.5) return;
    pen.current = [...pen.current, [round1(p.x), round1(p.y)]];
    setDraft(pen.current);
  };
  const up = () => {
    const pts = pen.current;
    pen.current = null;
    setDraft(null);
    if (!pts) return;
    setStrokes((cur) => [...cur, { id: newId(), points: simplify(pts), width: 2.5 }]);
  };
  // The pen layer covers the cards so a stroke can cross them; wheel and pinch still move and zoom the canvas
  const wheel = (e) => {
    const v = rf.getViewport();
    if (e.ctrlKey || e.metaKey) {
      const zoom = Math.min(3, Math.max(0.2, v.zoom * Math.exp(-e.deltaY * 0.01)));
      const box = wrap.current.getBoundingClientRect();
      const px = e.clientX - box.left;
      const py = e.clientY - box.top;
      rf.setViewport({ x: px - ((px - v.x) / v.zoom) * zoom, y: py - ((py - v.y) / v.zoom) * zoom, zoom });
    } else rf.setViewport({ x: v.x - e.deltaX, y: v.y - e.deltaY, zoom: v.zoom });
  };
  const erase = (id) => setStrokes((cur) => (cur.some((s) => s.id === id) ? cur.filter((s) => s.id !== id) : cur));

  // ---------------------------------------------------------------- keys

  useEffect(() => {
    const onKey = (e) => {
      if (viewRef.current === '3d') return; // the 3D view is read only: no tool, no undo
      const k = e.key.toLowerCase();
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !typing(e.target) && !e.isComposing && (k === 'z' || k === 'y')) {
        e.preventDefault();
        stepBy(k === 'y' || e.shiftKey ? 1 : -1);
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target) || e.isComposing) return;
      if (k === 'v' || k === 'escape') setTool('select');
      else if (k === 't') {
        e.preventDefault();
        addCard();
      } else if (k === 'p') setTool('pen');
      else if (k === 'e') setTool('eraser');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [addCard, stepBy]);

  const pick = (t) => (t === 'card' ? addCard() : setTool(t));

  return (
    <HostContext.Provider value={hostValue}>
      <div className="cv" ref={wrap} data-tool={tool} onDoubleClick={(e) => e.target.classList?.contains('react-flow__pane') && addCard(rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }))}>
        <div className="cv-2d" style={view === '3d' ? { visibility: 'hidden' } : undefined} aria-hidden={view === '3d'}>
        <ReactFlow
          nodes={nodes}
          edges={shown}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          connectionMode={ConnectionMode.Loose}
          isValidConnection={(c) => c.source !== c.target}
          onNodeDragStart={() => setDragging(true)}
          onNodeDragStop={() => setDragging(false)}
          deleteKeyCode={['Backspace', 'Delete']}
          panOnScroll
          zoomOnDoubleClick={false}
          minZoom={0.2}
          maxZoom={3}
          fitView={initial.nodes.length > 0}
          fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
          defaultMarkerColor="var(--dim)"
          proOptions={{ hideAttribution: false }}
        >
          <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} />
          <Controls showInteractive={false} position="bottom-left" />
          <ViewportPortal>
            <svg className="cv-strokes" width="1" height="1">
              {strokes.map((s) => (
                <g key={s.id} data-stroke={s.id}>
                  <path className="cv-stroke" d={strokePath(s.points)} stroke={s.color || undefined} strokeWidth={s.width || 2.5} />
                  <path className="cv-stroke-hit" d={strokePath(s.points)} onPointerDown={() => tool === 'eraser' && erase(s.id)} onPointerEnter={(e) => tool === 'eraser' && e.buttons === 1 && erase(s.id)} />
                </g>
              ))}
              {draft ? <path className="cv-stroke cv-draft" d={strokePath(draft)} strokeWidth={2.5} /> : null}
            </svg>
          </ViewportPortal>
        </ReactFlow>
        </div>
        {view === '3d' ? <Graph3D host={host} doc={doc3} handle={three} /> : null}
        {tool === 'pen' ? <div className="cv-pen" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onWheel={wheel} /> : null}
        <div className="cv-tools" role="toolbar" aria-label={t('cvTools')}>
          {view === '2d' ? (
            <>
          <button type="button" className="cv-tool" id="cv-undo" title={t('cvUndo')} aria-label={t('undo')} disabled={!steps.undo} onClick={() => stepBy(-1)}>
            <Icon name="undo" />
          </button>
          <button type="button" className="cv-tool" id="cv-redo" title={t('cvRedo')} aria-label={t('cvRedoLabel')} disabled={!steps.redo} onClick={() => stepBy(1)}>
            <Icon name="redo" />
          </button>
          <span className="cv-sep" />
          {TOOLS.map(([name, key]) => (
            <button key={name} type="button" className="cv-tool" data-tool-button={name} aria-pressed={tool === name} title={t(key)} aria-label={t(key)} onClick={() => pick(name)}>
              <Icon name={name} />
            </button>
          ))}
          <span className="cv-sep" />
          <button type="button" className="cv-tool" id="cv-delete" title={t('cvDelete')} aria-label={t('cvDeleteLabel')} disabled={!selected} onClick={deleteSelected}>
            <Icon name="trash" />
          </button>
          <span className="cv-sep" />
            </>
          ) : null}
          <div className="cv-view" role="group" aria-label={t('cvView')}>
            {['2d', '3d'].map((v) => (
              <button key={v} type="button" className="cv-view-btn" data-view-button={v} aria-pressed={view === v} title={t(v === '2d' ? 'cv2d' : 'cv3d')} onClick={() => setView(v)}>
                {v.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
        {deleted ? (
          <div className="cv-alert" id="cv-deleted" role="alert">
            <span>{t('cvDeleted')}</span>
            <button type="button" className="quiet" id="cv-keep" onClick={() => session.keepDeleted()}>{t('keepMine')}</button>
            <button type="button" className="quiet" id="cv-drop" onClick={() => host.api.dropped?.()}>{t('dropIt')}</button>
          </div>
        ) : status.alert ? (
          <div className="cv-alert" id="cv-alert" role="alert">
            <span>{status.text}</span>
            {blocked ? <button type="button" className="quiet" id="cv-keep-over" onClick={() => session.keepOver()}>{t('keepMine')}</button> : null}
          </div>
        ) : (
          <div className="cv-status" aria-live="polite">{status.text}</div>
        )}
      </div>
    </HostContext.Provider>
  );
}

export default Canvas;
