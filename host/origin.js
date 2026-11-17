'use strict';
// Which extension may start the host. The id is never written in code: the installer is told it (--id) or
// derives it from the key in extension/manifest.json, writes it into the host manifest's allowed_origins
// and into the launcher (--origin), and the host refuses to run for any other origin.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ID_SHAPE = /^[a-p]{32}$/;
const ORIGIN_SHAPE = /^chrome-extension:\/\/[a-p]{32}\/$/;
const originOf = (id) => `chrome-extension://${id}/`;

// The id Chromium gives an unpacked extension that has a `key` in its manifest: the first 32 hex digits of the
// SHA-256 of the key's DER bytes, each digit written as a letter from a to p
function idFromKey(key) {
  return [...crypto.createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32)]
    .map((c) => String.fromCharCode(97 + parseInt(c, 16)))
    .join('');
}

// The id of the extension in `extDir`, from its manifest key; null when the manifest pins no key
function idFromManifest(extDir) {
  let key;
  try {
    ({ key } = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8')));
  } catch {
    return null;
  }
  return key ? idFromKey(key) : null;
}

// The allowed origin of a host that was started with `argv`: the one after --origin when the launcher gave it,
// else the origin of the extension next to this repo's host/ folder when its manifest pins a key (a checkout
// started without the installer's launcher, or by a launcher written before --origin existed). null: nobody is allowed.
function allowedOrigin(argv, extDir = path.join(__dirname, '..', 'extension')) {
  const i = argv.indexOf('--origin');
  if (i > 0) return ORIGIN_SHAPE.test(argv[i + 1] || '') ? argv[i + 1] : null;
  const id = idFromManifest(extDir);
  return id ? originOf(id) : null;
}

// True when Chrome handed the host the allowed origin as its own argument (the --origin pair does not count)
function startedBy(argv, allowed) {
  if (!allowed) return false;
  const i = argv.indexOf('--origin');
  const rest = i > 0 ? [...argv.slice(2, i), ...argv.slice(i + 2)] : argv.slice(2);
  return rest.includes(allowed);
}

module.exports = { ID_SHAPE, ORIGIN_SHAPE, originOf, idFromKey, idFromManifest, allowedOrigin, startedBy };
