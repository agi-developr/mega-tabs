'use strict';
// Accessibility with axe-core (MPL-2.0, test-only, vendored in test/vendor/axe-core, never in extension/) on every page
// a person sees, light and dark: the side panel, home, the Board's Notes and Canvas rooms, and settings. Any serious or
// critical finding fails the test, contrast included (WCAG 2 AA: 4.5:1 for text).
//
// The accepted exception, recorded here and not hidden: the 3D scene is a WebGL canvas that a screen reader cannot read.
// It has one aria-label (cv3dScene) that says what it is and how to use it, the cards in it are reached from the flat
// canvas and from Notes. axe is not run on the 3D view (it needs WebGL and checks only the label).
//
//   CHROME=<binary> node --test test/axe.chromium.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { openAll } = require('./ui-pages');

const bin = process.env.CHROME;
const AXE = fs.readFileSync(path.join(__dirname, 'vendor', 'axe-core', 'axe.min.js'), 'utf8');

const RUN = `(async () => {
  const r = await axe.run(document, { resultTypes: ['violations'] });
  return JSON.stringify(r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => ({
    id: v.id, impact: v.impact, help: v.help,
    nodes: v.nodes.slice(0, 4).map((n) => ({ target: n.target.join(' '), html: n.html.slice(0, 140), why: (n.any[0]?.message || n.all[0]?.message || n.none[0]?.message || '').slice(0, 200) })),
  })));
})()`;

test('axe-core: no serious or critical finding on panel, home, Board Notes, Board Canvas and settings, light and dark', { skip: !bin && 'CHROME is not set', timeout: 300000 }, async (t) => {
  const p = await openAll(bin);
  t.after(p.close);
  const cases = [
    ['panel', 'panel', null],
    ['home', 'home', null],
    ['settings', 'settings', null],
    ['board Notes', 'board', 'notes'],
    ['board Canvas', 'board', 'canvas'],
  ];
  for (const [name, page, room] of cases) {
    for (const dark of [false, true]) {
      await t.test(`${name}, ${dark ? 'dark' : 'light'}`, async () => {
        if (room) {
          await p.room(room);
          if (room === 'canvas') await new Promise((r) => setTimeout(r, 1000));
        }
        const found = await p.session(
          page,
          async (ev) => {
            await ev(`window.axe || (0, eval)(${JSON.stringify(AXE)}), true`);
            return JSON.parse(await ev(RUN));
          },
          { dark },
        );
        assert.deepEqual(found, [], found.map((v) => v.id + ": " + v.nodes.map((n) => n.target + " " + n.why).join(" | ")).join("\n"));
      });
    }
  }
});
