// The English texts of the Canvas room, for places that run without a page: the node tests, and a session or a
// label made without a `t`. In the extension the page passes its own `t` (chrome.i18n, the person's language), so
// this table is only the fallback. The one source of the words is extension/_locales/en/messages.json.

import en from '../../extension/_locales/en/messages.json' with { type: 'json' };

// $1 to $9 take the arguments in order, $$ is a dollar sign (the same rule chrome.i18n.getMessage follows)
export const enT = (key, ...subs) => {
  const m = en[key]?.message;
  if (m === undefined) throw new Error(`unknown text: ${key}`);
  return m.replace(/\$(\$|[1-9])/g, (_, x) => (x === '$' ? '$' : String(subs[x - 1] ?? '')));
};
