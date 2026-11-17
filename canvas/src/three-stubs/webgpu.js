// three-render-objects (inside 3d-force-graph) imports a WebGPU renderer it only uses when asked for one. This
// view draws with WebGL, so the multi-megabyte WebGPU build is not bundled: this class is never constructed.
export class WebGPURenderer {
  constructor() {
    throw new Error('WebGPU is not part of this bundle');
  }
}
