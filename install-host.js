'use strict';
// Installs (or removes) the Board's native-messaging host for Google Chrome on this Mac.
//
//   node install-host.js              write the host manifest and a small launcher
//   --id <extension id>    the extension that may start the host: the 32 letters shown for it at chrome://extensions.
//                          Default: the id derived from the key in extension/manifest.json (this checkout's own id).
//                          A copy whose manifest pins no key (the Web Store build) needs --id.
//   node install-host.js --uninstall  remove both again
//   --manifest-dir <dir>   where Chrome looks for host manifests
//                          (default ~/Library/Application Support/Google/Chrome/NativeMessagingHosts)
//   --wrapper-dir <dir>    where the launcher goes (default ~/Library/Application Support/Megatabs)
//   --spaces <dir>         pin the folder the host serves (default ~/Spaces; tests use a temp one)
//   --check                only print where things are and whether they are in place
//
// Two files are written, both named in the output: the host manifest (com.megatabs.board.json) and
// the launcher, a 2-line shell script that runs this folder's host/board-host.js with the absolute
// path of node (Chrome starts hosts with a bare PATH). The manifest lets exactly one extension
// start the host: the one whose id was given with --id (or the key's id). The launcher also hands that
// origin to the host (--origin), which refuses to run for any other.
// Nothing else is touched. Needs no network and no admin rights.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ID_SHAPE, originOf, idFromManifest } = require('./host/origin');

const HOST_NAME = 'com.megatabs.board';
const HOME = os.homedir();
const DEFAULT_MANIFEST_DIR = path.join(HOME, 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts');
const DEFAULT_WRAPPER_DIR = path.join(HOME, 'Library', 'Application Support', 'Megatabs');

// The id the host is installed for: the one passed in, else this checkout's own (from its manifest key)
function extensionId(extDir = path.join(__dirname, 'extension'), id) {
  if (id) {
    if (!ID_SHAPE.test(id)) throw new Error('--id must be the 32 letters (a to p) shown for the extension at chrome://extensions');
    return id;
  }
  const own = idFromManifest(extDir);
  if (!own) throw new Error('this copy pins no extension id: pass --id <the id shown for it at chrome://extensions>');
  return own;
}

// A node path that survives a package-manager upgrade: the stable link when it points at this node
function nodePath() {
  const real = fs.realpathSync(process.execPath);
  for (const p of ['/opt/homebrew/bin/node', '/usr/local/bin/node']) {
    try {
      if (fs.realpathSync(p) === real) return p;
    } catch {
      /* not there */
    }
  }
  return process.execPath;
}

const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function paths({ manifestDir = DEFAULT_MANIFEST_DIR, wrapperDir = DEFAULT_WRAPPER_DIR } = {}) {
  return { manifest: path.join(manifestDir, `${HOST_NAME}.json`), wrapper: path.join(wrapperDir, 'board-host') };
}

function install({ manifestDir = DEFAULT_MANIFEST_DIR, wrapperDir = DEFAULT_WRAPPER_DIR, spaces, node = nodePath(), id } = {}) {
  const p = paths({ manifestDir, wrapperDir });
  const extId = extensionId(undefined, id);
  const origin = originOf(extId);
  const host = path.join(__dirname, 'host', 'board-host.js');
  if (!fs.existsSync(host)) throw new Error(`missing ${host}`);
  fs.mkdirSync(wrapperDir, { recursive: true });
  fs.mkdirSync(manifestDir, { recursive: true });
  fs.writeFileSync(p.wrapper, `#!/bin/sh\nexec ${sq(node)} ${sq(host)}${spaces ? ` --root ${sq(path.resolve(spaces))}` : ''} --origin ${sq(origin)} "$@"\n`, { mode: 0o755 });
  fs.chmodSync(p.wrapper, 0o755);
  const manifest = {
    name: HOST_NAME,
    description: 'Megatabs Board: reads and writes .md files in ~/Spaces',
    path: p.wrapper,
    type: 'stdio',
    allowed_origins: [origin],
  };
  fs.writeFileSync(p.manifest, JSON.stringify(manifest, null, 2) + '\n');
  return { ...p, id: extId, node };
}

function uninstall({ manifestDir = DEFAULT_MANIFEST_DIR, wrapperDir = DEFAULT_WRAPPER_DIR } = {}) {
  const p = paths({ manifestDir, wrapperDir });
  const removed = [];
  for (const f of [p.manifest, p.wrapper]) {
    if (fs.existsSync(f)) {
      fs.rmSync(f);
      removed.push(f);
    }
  }
  try {
    fs.rmdirSync(wrapperDir); // only when empty
  } catch {
    /* not empty or not there */
  }
  return { ...p, removed };
}

if (require.main === module) {
  const raw = (n) => {
    const i = process.argv.indexOf(n);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const arg = (n) => (raw(n) === undefined ? undefined : path.resolve(raw(n)));
  const opts = { manifestDir: arg('--manifest-dir') || DEFAULT_MANIFEST_DIR, wrapperDir: arg('--wrapper-dir') || DEFAULT_WRAPPER_DIR, spaces: arg('--spaces'), id: raw('--id') };
  if (process.argv.includes('--uninstall')) {
    const r = uninstall(opts);
    console.log(r.removed.length ? `removed:\n  ${r.removed.join('\n  ')}` : 'nothing to remove');
  } else if (process.argv.includes('--check')) {
    const p = paths(opts);
    console.log(`manifest ${fs.existsSync(p.manifest) ? 'present' : 'missing'}: ${p.manifest}\nlauncher ${fs.existsSync(p.wrapper) ? 'present' : 'missing'}: ${p.wrapper}`);
    if (fs.existsSync(p.manifest)) {
      try {
        const allowed = JSON.parse(fs.readFileSync(p.manifest, 'utf8')).allowed_origins || [];
        console.log(`allows: ${allowed.join(' ') || 'nobody'}`);
        const launcher = fs.existsSync(p.wrapper) ? fs.readFileSync(p.wrapper, 'utf8') : '';
        if (launcher && !launcher.includes('--origin')) console.log('launcher: written by an older installer (no --origin); the host then falls back to this checkout\'s own id. Run node install-host.js again to update it.');
      } catch (e) {
        console.log(`manifest unreadable: ${e.message}`);
      }
    }
  } else {
    if (process.platform !== 'darwin' && !process.argv.includes('--manifest-dir')) {
      console.error('This installer knows the Chrome folder on macOS only; pass --manifest-dir <dir> elsewhere.');
      process.exit(1);
    }
    let r;
    try {
      r = install(opts);
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
    console.log(`installed for extension ${r.id}\n  manifest: ${r.manifest}\n  launcher: ${r.wrapper} (node: ${r.node})\nReload the Board page; Chrome starts the host when it connects.`);
  }
}

module.exports = { install, uninstall, paths, extensionId, HOST_NAME };
