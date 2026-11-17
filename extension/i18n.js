// Übersetzte Texte aus _locales/<Sprache>/messages.json. Chrome wählt die Sprache des
// Browsers und nimmt, wo es sie nicht gibt, default_locale aus dem Manifest. $1 bis $9 in
// einem Text werden durch die weiteren Argumente ersetzt.
const tr = (key, ...subs) => chrome.i18n.getMessage(key, subs.map(String));

// A count with the right form for the language. One key per CLDR plural category (key_zero, key_one, key_two,
// key_few, key_many, key_other); Intl.PluralRules of the language picks the category, and a language that has
// no text for it falls back to key_other. The count is $1; more arguments follow as $2, $3, ...
let pluralRules;
function plural(n, key, ...subs) {
  pluralRules ??= new Intl.PluralRules(tr('lang') || undefined);
  return tr(`${key}_${pluralRules.select(n)}`, n, ...subs) || tr(`${key}_other`, n, ...subs);
}

// A message with markup in it: $1, $2 ... stand for the given nodes (a <code> element, a button). The text around
// them is the translation; the order of the placeholders is the translator's. Returns a list for el.append(...).
function trNodes(key, ...nodes) {
  const mark = (i) => `\u0001${i}\u0002`;
  const text = chrome.i18n.getMessage(key, nodes.map((_, i) => mark(i)));
  const out = [];
  let rest = text;
  for (;;) {
    const m = /\u0001(\d+)\u0002/.exec(rest);
    if (!m) break;
    if (m.index) out.push(rest.slice(0, m.index));
    out.push(nodes[Number(m[1])]);
    rest = rest.slice(m.index + m[0].length);
  }
  if (rest) out.push(rest);
  return out;
}

// The command a person runs to install the Board helper for this very extension. The id is the one Chrome gave it,
// so the same text is right for an unpacked checkout and for the store build.
const installCommand = () => `node install-host.js --id ${chrome.runtime.id}`;

// Sets the texts of a page: data-i18n the content, data-i18n-title the tooltip, data-i18n-label the accessible
// name, data-i18n-placeholder the placeholder; and the language and the writing direction (rtl for ar, fa, he)
function localize() {
  const root = document.documentElement;
  root.lang = tr('lang');
  root.dir = chrome.i18n.getMessage('@@bidi_dir') === 'rtl' ? 'rtl' : 'ltr';
  for (const e of document.querySelectorAll('[data-i18n]')) e.textContent = tr(e.dataset.i18n);
  for (const e of document.querySelectorAll('[data-i18n-title]')) e.title = tr(e.dataset.i18nTitle);
  for (const e of document.querySelectorAll('[data-i18n-label]')) e.setAttribute('aria-label', tr(e.dataset.i18nLabel));
  for (const e of document.querySelectorAll('[data-i18n-placeholder]')) e.setAttribute('placeholder', tr(e.dataset.i18nPlaceholder));
}
