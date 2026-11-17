'use strict';
// C48: every text of the product is in _locales, every locale has every key, and no UI file keeps a literal text.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, EXT, CANVAS_SRC, LEGACY_FILES, liveKeys, baseOf } = require('./locale-keys');

const LOCALES = path.join(EXT, '_locales');
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const en = readJson(path.join(LOCALES, 'en', 'messages.json'));
const codes = fs.readdirSync(LOCALES).filter((d) => fs.statSync(path.join(LOCALES, d)).isDirectory()).sort();
const table = Object.fromEntries(codes.map((c) => [c, readJson(path.join(LOCALES, c, 'messages.json'))]));
const { live, plural } = liveKeys(en);
const subs = (s) => [...new Set(String(s).match(/\$[1-9]/g) || [])].sort().join('');
const tag = (code) => code.replace('_', '-');
const RTL = ['ar', 'fa', 'he'];

// The codes Chrome accepts for _locales (https://developer.chrome.com/docs/extensions/reference/api/i18n#locales)
const CHROME_CODES = new Set(('ar am bg bn ca cs da de el en en_AU en_GB en_US es es_419 et fa fi fil fr gu he hi hr hu id it ja kn ko lt lv ml mr ms nl no pl pt_BR pt_PT ro ru sk sl sr sv sw ta te th tr uk vi zh_CN zh_TW').split(' '));

// The plural categories a language really uses for whole numbers (a language with "many" only from one million on
// does not need it for tab counts)
function formsOf(code) {
  const pr = new Intl.PluralRules(tag(code));
  const forms = new Set();
  for (let i = 0; i <= 10000; i++) forms.add(pr.select(i));
  return [...forms];
}

test('at least 40 translations besides English, each a code Chrome accepts, each with its own language tag', () => {
  const translated = codes.filter((c) => c !== 'en');
  assert.ok(translated.length >= 40, `${translated.length} locales besides en`);
  for (const c of codes) {
    assert.ok(CHROME_CODES.has(c), `${c} is not a locale code Chrome accepts`);
    assert.equal(table[c].lang?.message, tag(c), `${c}: the "lang" text is the language tag`);
  }
  assert.ok(translated.includes('de'));
  for (const c of ['ar', 'fa', 'he']) assert.ok(codes.includes(c), `right-to-left ${c} is there`);
});

test('every locale has every key a page or the manifest asks for, with the same placeholders and no empty text', () => {
  assert.ok(live.length > 200, `${live.length} live keys`);
  for (const c of codes) {
    for (const k of live) {
      if (plural.includes(k)) continue;
      const m = table[c][k]?.message;
      assert.ok(m && m.trim(), `${c}: ${k} is missing or empty`);
      assert.equal(subs(m), subs(en[k].message), `${c}: placeholders of ${k}`);
    }
    for (const [k, v] of Object.entries(table[c])) assert.match(v.message, /\S/, `${c}: ${k} is empty`);
  }
});

test('plurals: every locale has the forms its language uses (Intl.PluralRules), written for its own count', () => {
  assert.ok(plural.includes('tabs') && plural.includes('megaTabs') && plural.includes('tabsNotRestored'), plural.join());
  for (const c of codes) {
    const need = c === 'en' ? ['one', 'other'] : formsOf(c);
    for (const b of plural.filter((p) => p === 'tabs' || p === 'megaTabs' || p === 'tabsNotRestored')) {
      for (const f of need) {
        const m = table[c][`${b}_${f}`]?.message;
        assert.ok(m, `${c}: ${b}_${f} is missing (${tag(c)} uses ${need.join(', ')})`);
        assert.equal(subs(m), subs(en[`${b}_other`].message), `${c}: placeholders of ${b}_${f}`);
      }
      // A form the language never uses would be dead text
      for (const k of Object.keys(table[c]).filter((x) => baseOf(x) === b && x !== b)) assert.ok(need.includes(k.slice(b.length + 1)), `${c}: ${k} is never used by ${tag(c)}`);
    }
  }
  // The rules differ where they should
  assert.deepEqual(formsOf('ru').sort(), ['few', 'many', 'one']);
  assert.deepEqual(formsOf('ar').sort(), ['few', 'many', 'one', 'other', 'two', 'zero']);
  assert.deepEqual(formsOf('ja'), ['other']);
});

test('the manifest name and description fit the Web Store in every locale', () => {
  for (const c of codes) {
    const name = table[c].extName.message;
    const desc = table[c].extDescription.message;
    assert.ok(name.length <= 75, `${c}: name is ${name.length} characters (75 at most)`);
    assert.ok(name.startsWith('Mega Tabs'), `${c}: the product name stays Mega Tabs`);
    assert.ok(desc.length <= 132, `${c}: description is ${desc.length} characters (132 at most)`);
  }
});

test('right-to-left locales are the ones the pages mirror (@@bidi_dir follows the locale name)', () => {
  for (const c of RTL) assert.ok(table[c], `${c} exists`);
  const dirs = fs.readFileSync(path.join(EXT, 'i18n.js'), 'utf8');
  assert.match(dirs, /@@bidi_dir/);
  assert.match(dirs, /root\.dir = /);
});

test('every locale has its store listing (store/listing/<locale>.md) with a summary of 132 characters or fewer', (t) => {
  const dir = path.join(ROOT, 'store', 'listing');
  if (!fs.existsSync(dir)) return t.skip('store/ is not part of this copy');
  for (const c of codes) {
    const f = path.join(dir, `${c}.md`);
    assert.ok(fs.existsSync(f), `store/listing/${c}.md is missing`);
    const text = fs.readFileSync(f, 'utf8');
    const summary = /^## Summary\n+```\n([^\n]+)\n```/m.exec(text)?.[1];
    assert.ok(summary, `${c}: no summary block`);
    assert.ok(summary.length <= 132, `${c}: summary is ${summary.length} characters`);
    assert.equal(summary, table[c].extDescription.message, `${c}: the listing summary is the manifest description`);
    const name = /^## Name\n+`([^`\n]+)`/m.exec(text)?.[1];
    assert.equal(name, table[c].extName.message, `${c}: the listing name is the manifest name`);
    const long = /^## Description\n+```\n([\s\S]+?)\n```/m.exec(text)?.[1];
    assert.ok(long && long.length > 600, `${c}: the long description is missing or short`);
    assert.ok(long.length <= 16000, `${c}: the long description is over 16000 characters`);
  }
});

// ---------------------------------------------------------------- no literal UI text left

// What counts as a literal text: a string with words in it that is shown to a person. Technical strings (an Error
// message, a console line, a key name, a selector, a path) are not UI. A line that carries `i18n-ok` is let through,
// with the reason beside it.
const UI_FILES = [
  'sidepanel.js', 'home.js', 'settings.js', 'board.js', 'canvas-room.js', 'edge-content.js', 'megatabs.js', 'edge.js',
  'sidepanel.html', 'home.html', 'settings.html', 'board.html', 'stash.html',
].map((f) => path.join(EXT, f)).concat(
  fs.readdirSync(CANVAS_SRC).filter((f) => /\.(jsx|mjs)$/.test(f) && f !== 'texts.mjs').map((f) => path.join(CANVAS_SRC, f)),
);
const WORD_OK = new Set(('Escape Enter Backspace Delete ArrowUp ArrowDown ArrowLeft ArrowRight Tab Files Meta Control Shift Alt Range Highlight Segmenter ' +
  'Uint8Array TextEncoder TextDecoder Promise Object Number String Array Math Date JSON CSS Map Set URL Blob Error Component Context Provider ' +
  'SF General MegatabsStorage MegatabsCanvas MegatabsThree ForceGraph3D Color Mesh ' +
  'Reflect Symbol Intl DOMPurify OverType Proxy ReactFlow BigInt').split(' '));

function stripComments(src) {
  // block and line comments; a `//` inside a string (https://...) is kept by walking the text
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '*') {
      const j = src.indexOf('*/', i + 2);
      i = j < 0 ? src.length : j + 1;
      out += ' ';
    } else if (c === '/' && src[i + 1] === '/' && !/[:"'`(]/.test(src[i - 1] || ' ')) {
      const j = src.indexOf('\n', i);
      const line = src.slice(i, j < 0 ? src.length : j);
      i = j < 0 ? src.length : j - 1;
      if (/i18n-ok/.test(line)) out += ' /*i18n-ok*/';
    } else if (c === '/' && /[(,=:[!&|?{};]\s*$/.test(out.slice(-3)) && src[i + 1] !== '/') {
      // a regular expression literal: copied whole, so a quote inside it does not start a string
      let j = i + 1;
      let cls = false;
      while (j < src.length && (src[j] !== '/' || cls) && src[j] !== '\n') {
        if (src[j] === '\\') j++;
        else if (src[j] === '[') cls = true;
        else if (src[j] === ']') cls = false;
        j++;
      }
      out += src.slice(i, j + 1);
      i = j;
    } else if (c === '\'' || c === '"' || c === '`') {
      // copy the string whole
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j;
    } else out += c;
  }
  return out;
}

function literalsIn(src) {
  const found = [];
  const lines = stripComments(src).split('\n');
  lines.forEach((line, n) => {
    if (/i18n-ok/.test(line)) return;
    for (const m of line.matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)) {
      const s = m[1] ?? m[2] ?? m[3];
      const before = line.slice(0, m.index);
      if (/(?:new\s+Error|Error)\(\s*$|console\.\w+\(\s*$|throw\s+\S*\s*$/.test(before)) continue; // technical text
      if (/\b(?:require|import|from)\s*\(?\s*$/.test(before)) continue;
      if (/\b(?:querySelector(?:All)?|getElementById|closest|matches|classList\.\w+|createElement|setAttribute|getAttribute|removeAttribute|addEventListener|storage\.\w+\.(?:get|set|remove)|sendMessage|connect|postMessage|call|mega|send|ask)\(\s*$/.test(before)) continue; // selectors, names, protocol words
      // the words in a template literal, without its ${...}
      const text = s.replace(/\$\{[^}]*\}/g, ' ').replace(/\\./g, ' ');
      if (/\bfont\b|\b(?:sans-serif|monospace|system-ui|serif)\b/.test(line)) continue; // a font stack
      for (const w of text.matchAll(/(?:^|[\s(])([A-Z][a-z]{2,}[A-Za-z]*(?:\s+[A-Za-z][a-z'’]*)*)/g)) {
        const first = w[1].split(/\s+/)[0];
        if (WORD_OK.has(first)) continue;
        if (/^(?:https?:|chrome|data:|#|\/|\.|[a-z0-9-]+\.[a-z]{2,3}$)/.test(text.trim())) continue;
        found.push(`${n + 1}: ${s.length > 70 ? s.slice(0, 70) + '…' : s}`);
        break;
      }
    }
  });
  return found;
}

function htmlTexts(src) {
  const found = [];
  const body = src.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)[\s\S]*?<\/\1>/g, '');
  for (const m of body.matchAll(/>([^<]+)</g)) if (/[A-Za-z]{2,}/.test(m[1])) found.push(`text: ${m[1].trim().slice(0, 60)}`);
  for (const m of body.matchAll(/\s(title|aria-label|placeholder|alt)="([^"]*[A-Za-z]{2,}[^"]*)"/g)) found.push(`${m[1]}: ${m[2].slice(0, 60)}`);
  return found;
}

test('no UI file keeps a literal text: every word a person reads comes from _locales (technical Error and console text excepted)', () => {
  const problems = [];
  for (const f of UI_FILES) {
    const src = fs.readFileSync(f, 'utf8');
    const hits = f.endsWith('.html') ? htmlTexts(src) : literalsIn(src);
    for (const h of hits) problems.push(`${path.relative(ROOT, f)} ${h}`);
  }
  assert.deepEqual(problems, []);
});

test('the literal-text check catches what it is for (so a clean run means something)', () => {
  assert.deepEqual(literalsIn("el('button', {}, 'Save changes');"), ['1: Save changes']);
  assert.deepEqual(literalsIn('el("p", { title: `Open ${name} now` })'), ['1: Open ${name} now']);
  assert.deepEqual(literalsIn("throw new Error('The host is gone');"), []);
  assert.deepEqual(literalsIn("const x = 'General'; // i18n-ok: a key"), []);
  assert.deepEqual(literalsIn("e.key === 'Escape' && x.classList.add('current')"), []);
  assert.deepEqual(htmlTexts('<h1>Spaces</h1><p data-i18n="x"></p>'), ['text: Spaces']);
  assert.deepEqual(htmlTexts('<input aria-label="Search" data-i18n-label="a">'), ['aria-label: Search']);
  assert.deepEqual(htmlTexts('<h1 data-i18n="spaces"></h1>'), []);
  // The old popup and transfer page are not held to this: nothing opens them
  assert.ok(LEGACY_FILES.every((f) => !UI_FILES.some((u) => path.basename(u) === f)));
});
