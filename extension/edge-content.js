// Mega tabs: Edge reveal, the part that runs in a web page. Registered by edge.js only while the setting is on.
//
// A pointer held still for 300 ms in the 6 px strip at the chosen screen edge shows a small switcher over
// the page: the mega tabs of the current space, and "Open panel". It reads nothing from the page and sends
// nothing anywhere but to the extension (a runtime port named "mega", asking only `state`, `show` and
// `openPanel`). It lives in a closed shadow root, so the page cannot see it or style it, and it leaves
// when the pointer has been away for 400 ms or on Esc. Never in fullscreen.
(() => {
  if (window.__megatabsEdge) return;   // the isolated world of this script, not the page's
  window.__megatabsEdge = true;

  const KEY = 'megaEdge';
  const STRIP = 6;      // px of hot edge
  const STILL = 300;    // ms of a still pointer before it shows
  const AWAY = 400;     // ms away before it leaves

  let side = 'left';
  let active = false;
  let host = null;
  let showTimer = 0;
  let hideTimer = 0;
  let seq = 0;          // a late answer for a switcher that is gone is dropped

  // One request, one answer, over the port the extension owns
  function ask(type, args = {}) {
    return new Promise((resolve, reject) => {
      let port;
      try {
        port = chrome.runtime.connect({ name: 'mega' });
      } catch (e) {
        return reject(e);   // the extension was reloaded: this script is orphaned
      }
      let done = false;
      port.onMessage.addListener((m) => {
        done = true;
        port.disconnect();
        if (m?.ok) resolve(m.result);
        else reject(new Error(m?.error || 'No answer'));
      });
      port.onDisconnect.addListener(() => { if (!done) reject(new Error('No answer')); });
      port.postMessage({ id: 1, type, ...args });
    });
  }

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .panel {
      --bg: #f7f7f5; --fg: #2b2b2b; --dim: #8a8a86; --line: #e6e6e2; --hover: #ececea; --active-bg: #ffffff;
      --accent: #3b82f6; --shadow: rgba(0, 0, 0, .14);
      position: fixed; top: max(16px, 14vh); width: 232px; max-height: 70vh; overflow-y: auto; padding: 8px;
      border: 1px solid var(--line); border-radius: 12px; background: var(--bg); color: var(--fg);
      font: 14px/1.4 -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
      box-shadow: 0 8px 28px var(--shadow); text-align: start; letter-spacing: 0; color-scheme: light dark;
      animation: in .12s ease-out;
    }
    .panel.left { left: 10px; }
    .panel.right { right: 10px; }
    @media (prefers-color-scheme: dark) {
      .panel { --bg: #1c1c1e; --fg: #e8e8e6; --dim: #7d7d7a; --line: #2c2c2e; --hover: #262628; --active-bg: #2e2e31; --shadow: rgba(0, 0, 0, .5); }
    }
    @keyframes in { from { opacity: 0; } to { opacity: 1; } }
    @media (prefers-reduced-motion: reduce) { .panel { animation: none; } }
    .head { padding: 4px 8px 6px; font-size: 15px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    button {
      display: flex; align-items: center; gap: 8px; width: 100%; margin: 1px 0; padding: 8px;
      border: 0; border-radius: 8px; background: transparent; color: inherit; font: inherit; text-align: start; cursor: pointer;
      position: relative;
    }
    button:hover { background: var(--hover); }
    button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    button .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    button.mega.current { background: var(--active-bg); box-shadow: 0 0 0 1px var(--line); font-weight: 600; cursor: default; }
    button.mega.current::before { content: ""; width: 3px; height: 16px; border-radius: 2px; background: var(--fg); margin-inline-start: -4px; }
    .rule { height: 1px; margin: 6px 4px; background: var(--line); }
    button.open { color: var(--dim); }
    button.open:hover { color: var(--fg); }
    .empty { margin: 4px 8px 8px; color: var(--dim); font-size: 12px; line-height: 1.5; }
  `;

  const node = (tag, props = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    n.append(...kids.filter((x) => x != null));
    return n;
  };

  function draw(view) {
    const shadow = host.attachShadow({ mode: 'closed' });
    // chrome.i18n works in a content script: the texts come from the extension's own _locales
    const dir = chrome.i18n.getMessage('@@bidi_dir') === 'rtl' ? 'rtl' : 'ltr';
    const panel = node('div', { class: 'panel ' + side, role: 'dialog', dir, lang: chrome.i18n.getMessage('lang'), 'aria-label': chrome.i18n.getMessage('appName') });
    const GENERAL = 'General'; // i18n-ok: the key edge.js sends for a mega tab that belongs to no space, not shown text
    panel.append(node('div', { class: 'head' }, view.space === GENERAL ? chrome.i18n.getMessage('generalSpace') : view.space || chrome.i18n.getMessage('appName')));
    if (!view.megas.length) panel.append(node('p', { class: 'empty' }, chrome.i18n.getMessage('noMegas')));
    for (const m of view.megas) {
      panel.append(node('button', {
        class: 'mega' + (m.current ? ' current' : ''), type: 'button', 'aria-current': m.current ? 'true' : null,
        onclick: () => {
          if (m.current) return hide();
          ask('show', { wsId: m.id }).catch(() => {});
          hide();
        },
      }, node('span', { class: 'name' }, m.name)));
    }
    panel.append(node('div', { class: 'rule', role: 'separator' }));
    panel.append(node('button', {
      class: 'open', type: 'button',
      // The request leaves inside the click: Chrome opens a side panel only for a user gesture
      onclick: () => { ask('openPanel').catch(() => {}); hide(); },
    }, node('span', { class: 'name' }, chrome.i18n.getMessage('edgeOpenPanel'))));
    shadow.append(node('style', {}, CSS), panel);
    host.addEventListener('mouseenter', () => clearTimeout(hideTimer));
  }

  async function show() {
    if (host || !active || document.fullscreenElement) return;
    const mine = ++seq;
    let view;
    try {
      view = await ask('state');
    } catch {
      return;
    }
    if (mine !== seq || host || !active || document.fullscreenElement) return;
    host = document.createElement('div');
    host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647; top: 0; left: 0; width: 0; height: 0;';
    draw(view);
    document.documentElement.append(host);
    window.addEventListener('keydown', onKey, true);
  }

  function hide() {
    seq++;
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    showTimer = hideTimer = 0;
    window.removeEventListener('keydown', onKey, true);
    host?.remove();
    host = null;
  }

  function onKey(e) {
    if (e.key === 'Escape') hide();
  }

  const inStrip = (e) => (side === 'left' ? e.clientX <= STRIP : e.clientX >= document.documentElement.clientWidth - STRIP);

  function onMove(e) {
    if (host) {
      // Over the switcher or still in the strip: stay. Anywhere else: leave after a moment.
      if (e.target === host || inStrip(e)) {
        clearTimeout(hideTimer);
        hideTimer = 0;
      } else if (!hideTimer) {
        hideTimer = setTimeout(hide, AWAY);
      }
      return;
    }
    clearTimeout(showTimer);
    showTimer = 0;
    // Not while dragging (a selection, a scrollbar, a file)
    if (e.buttons === 0 && inStrip(e)) showTimer = setTimeout(show, STILL);
  }

  // The pointer left the page (to the toolbar, another window): the switcher leaves after a moment
  function onLeave() {
    clearTimeout(showTimer);
    showTimer = 0;
    if (host && !hideTimer) hideTimer = setTimeout(hide, AWAY);
  }

  function enable() {
    if (active) return;
    active = true;
    window.addEventListener('mousemove', onMove, { capture: true, passive: true });
    document.documentElement.addEventListener('mouseleave', onLeave);
  }

  function disable() {
    if (!active) return;
    active = false;
    hide();
    window.removeEventListener('mousemove', onMove, true);
    document.documentElement.removeEventListener('mouseleave', onLeave);
  }

  function apply(v) {
    side = v?.side === 'right' ? 'right' : 'left';
    if (v?.on) enable();
    else disable();
    if (host) hide();   // a changed side draws on the next rest
  }

  try {
    chrome.storage.local.get(KEY).then((r) => apply(r[KEY]));
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[KEY]) apply(changes[KEY].newValue);
    });
  } catch {
    // The extension was reloaded under this page: nothing to do
  }
})();
