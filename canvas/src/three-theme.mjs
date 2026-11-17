// The Board's palette, read from the page's CSS variables (sidepanel.css), so the 3D scenes are drawn in the
// same colors as the rest of the Board, light and dark. Plain data in, plain data out: no three.js here.

const FALLBACK = {
  light: { bg: '#f7f7f5', fg: '#2b2b2b', dim: '#62625e', line: '#e6e6e2', card: '#ffffff' },
  dark: { bg: '#1c1c1e', fg: '#e8e8e6', dim: '#9a9a96', line: '#2c2c2e', card: '#2e2e31' },
};

export const darkNow = () => !!globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches;

export function palette(el) {
  const dark = darkNow();
  const cs = globalThis.getComputedStyle(el);
  const v = (name, key) => cs.getPropertyValue(name).trim() || FALLBACK[dark ? 'dark' : 'light'][key];
  return { dark, bg: v('--bg', 'bg'), fg: v('--fg', 'fg'), dim: v('--dim', 'dim'), line: v('--line', 'line'), card: v('--active-bg', 'card') };
}

// #rrggbb mixed: t = 0 is a, t = 1 is b
export function mix(a, b, t) {
  const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const x = p(a);
  const y = p(b);
  return '#' + x.map((c, i) => Math.round(c * (1 - t) + y[i] * t).toString(16).padStart(2, '0')).join('');
}

// JSON Canvas preset colors "1".."6", the same muted tones canvas.css uses for cards
const PRESET = { 1: '#c4574f', 2: '#c98a43', 3: '#bda23f', 4: '#5d9a68', 5: '#4d9aa5', 6: '#8a6db6' };
export function cardColor(color, pal, fallback) {
  const hex = /^[1-6]$/.test(color || '') ? PRESET[color] : /^#[0-9a-fA-F]{6}$/.test(color || '') ? color : null;
  return hex ? mix(hex, pal.bg, pal.dark ? 0.25 : 0.2) : fallback;
}

// Calls fn when the system switches between light and dark; returns the function that stops it
export function onThemeChange(fn) {
  const q = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
  if (!q) return () => {};
  q.addEventListener('change', fn);
  return () => q.removeEventListener('change', fn);
}
