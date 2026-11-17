// Stands in for three.js's ImageBitmapLoader inside canvas3d.js (see canvas/build.js). The real one reads its URL
// with fetch(); this one shows the URL in an <img> (a blob: URL the glTF reader made from bytes inside the model,
// or a data: URL) and makes the bitmap from that. No request is made for any URL.
import { Loader } from 'THREE_SRC/loaders/Loader.js';

class ImageBitmapLoader extends Loader {
  constructor(manager) {
    super(manager);
    this.options = { premultiplyAlpha: 'none' };
  }

  setOptions(options) {
    this.options = options;
    return this;
  }

  load(url, onLoad, onProgress, onError) {
    const manager = this.manager;
    manager.itemStart(url);
    const fail = (e) => {
      if (onError) onError(e);
      manager.itemError(url);
      manager.itemEnd(url);
    };
    if (typeof url !== 'string' || !/^(blob|data):/i.test(url)) {
      globalThis.setTimeout(() => fail(new Error('only blob: and data: images are read here')), 0);
      return undefined;
    }
    const img = new globalThis.Image();
    img.onload = () => {
      globalThis.createImageBitmap(img, this.options).then(
        (bitmap) => {
          if (onLoad) onLoad(bitmap);
          manager.itemEnd(url);
        },
        fail,
      );
    };
    img.onerror = () => fail(new Error('the image inside the model could not be decoded'));
    img.src = url;
    return undefined;
  }
}

export { ImageBitmapLoader };
