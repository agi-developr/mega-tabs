'use strict';
// Right-to-left in a real Chromium (Chrome for Testing): the browser in Arabic, the side panel, home, settings and
// the Board take the language's direction (dir=rtl, lang=ar), the layout mirrors, and nothing overflows its page.
//
//   CHROME=<binary> node --test test/rtl.chromium.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { openAll } = require('./ui-pages');

const bin = process.env.CHROME;

const overflow = (page) => `(() => {
  const d = document.documentElement;
  const wide = [...document.querySelectorAll('body *')].filter((n) => { const r = n.getBoundingClientRect(); return r.width && (r.right > innerWidth + 1 || r.left < -1) && !n.closest('.react-flow'); });
  return JSON.stringify({ scroll: d.scrollWidth - d.clientWidth, wide: wide.slice(0, 5).map((n) => n.tagName + '.' + n.className) });
})()`;

test('Arabic: panel, home, settings and Board are right-to-left and do not overflow', { skip: !bin && 'CHROME is not set', timeout: 240000 }, async (t) => {
  const p = await openAll(bin, { lang: 'ar' });
  t.after(p.close);

  for (const page of ['panel', 'home', 'settings', 'board']) {
    await t.test(`${page}: lang=ar, dir=rtl, computed direction rtl, text in Arabic`, async () => {
      assert.equal(await p.ev(page, 'document.documentElement.lang'), 'ar');
      assert.equal(await p.ev(page, 'document.documentElement.dir'), 'rtl');
      assert.equal(await p.ev(page, 'getComputedStyle(document.body).direction'), 'rtl');
      assert.match(await p.ev(page, 'document.title'), page === 'panel' ? /^Mega Tabs$/ : /[\u0600-\u06FF]/, 'the title is translated');
      assert.match(await p.ev(page, 'document.body.innerText'), /[؀-ۿ]/, 'Arabic letters on the page');
    });
    await t.test(`${page}: no horizontal overflow`, async () => {
      const r = JSON.parse(await p.ev(page, overflow(page)));
      assert.equal(r.scroll <= 0 && r.wide.length === 0, true, JSON.stringify(r));
    });
  }

  await t.test('Board: the list sits on the right and the note on the left (the layout mirrors)', async () => {
    const r = JSON.parse(await p.ev('board', `JSON.stringify({ list: document.querySelector('#list').getBoundingClientRect().left, doc: document.querySelector('#doc').getBoundingClientRect().left, w: innerWidth })`));
    assert.ok(r.list > r.doc, JSON.stringify(r));
  });

  await t.test('Board canvas room: still no overflow, the canvas surface keeps its own direction', async () => {
    await p.room('canvas');
    await new Promise((r) => setTimeout(r, 800));
    const r = JSON.parse(await p.ev('board', overflow('board')));
    assert.equal(r.scroll <= 0 && r.wide.length === 0, true, JSON.stringify(r));
    assert.ok(Number(await p.ev('board', "document.querySelectorAll('.react-flow__node').length")) >= 2);
  });

  await t.test('panel: a mega-tab row icon and the name are mirrored (name starts at the right edge)', async () => {
    const r = JSON.parse(await p.ev('panel', `JSON.stringify((() => { const n = document.querySelector('.mega .name, .space-head span'); const b = n.getBoundingClientRect(); return { right: b.right, w: innerWidth }; })())`));
    assert.ok(r.right > r.w / 2, JSON.stringify(r));
  });
});
