import '@testing-library/jest-dom/vitest';

// Suppress jsdom's "Not implemented: HTMLCanvasElement.prototype.getContext" warning.
// PixiJS probes canvas blend modes at import time — harmless in tests, but noisy.
// Return a minimal stub context so jsdom doesn't throw.
if (typeof HTMLCanvasElement !== 'undefined') {
  HTMLCanvasElement.prototype.getContext = function () {
    return {
      fillRect() {}, clearRect() {}, putImageData() {},
      getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      setTransform() {}, resetTransform() {}, drawImage() {},
      save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {},
      closePath() {}, stroke() {}, fill() {}, arc() {},
      translate() {}, scale() {}, rotate() {},
      measureText: () => ({ width: 0, actualBoundingBoxAscent: 0, actualBoundingBoxDescent: 0 }),
      globalCompositeOperation: 'source-over',
      canvas: this,
    } as any;
  } as any;
}
