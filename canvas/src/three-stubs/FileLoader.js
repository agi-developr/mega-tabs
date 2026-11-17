// Stands in for three.js's FileLoader inside canvas3d.js (see canvas/build.js). The real one reads a URL with
// fetch(). This bundle never makes a request: a model arrives as bytes from the host, and the one thing a glTF
// may still ask a loader for is an embedded `data:` URL (a .gltf with its buffer inside), which is decoded
// right here. Any other URL is refused, so a model file cannot make the page load anything.
import { Loader } from 'THREE_SRC/loaders/Loader.js';

function decodeDataUrl(url) {
  const m = /^data:([^,]*?),(.*)$/s.exec(url);
  if (!m) return null;
  const base64 = /;base64$/i.test(m[1]);
  const mime = m[1].replace(/;base64$/i, '').split(';')[0];
  let bytes;
  if (base64) {
    const bin = globalThis.atob(m[2]);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } else {
    bytes = new TextEncoder().encode(decodeURIComponent(m[2]));
  }
  return { bytes, mime };
}

class FileLoader extends Loader {
  constructor(manager) {
    super(manager);
    this.mimeType = '';
    this.responseType = '';
  }

  setResponseType(value) {
    this.responseType = value;
    return this;
  }

  setMimeType(value) {
    this.mimeType = value;
    return this;
  }

  load(url, onLoad, onProgress, onError) {
    if (url === undefined) url = '';
    const manager = this.manager;
    manager.itemStart(url);
    const done = () => {
      const d = typeof url === 'string' ? decodeDataUrl(url) : null;
      if (!d) {
        if (onError) onError(new Error('only data: URLs are read here; a model cannot load anything else'));
        manager.itemError(url);
        manager.itemEnd(url);
        return;
      }
      let out;
      if (this.responseType === 'arraybuffer') out = d.bytes.buffer.slice(d.bytes.byteOffset, d.bytes.byteOffset + d.bytes.byteLength);
      else if (this.responseType === 'blob') out = new Blob([d.bytes], { type: d.mime });
      else if (this.responseType === 'json') out = JSON.parse(new TextDecoder().decode(d.bytes));
      else out = new TextDecoder().decode(d.bytes);
      if (onLoad) onLoad(out);
      manager.itemEnd(url);
    };
    globalThis.setTimeout(done, 0);
    return undefined;
  }
}

export { FileLoader };
