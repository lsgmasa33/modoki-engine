import '@testing-library/jest-dom/vitest';

// jsdom has no PointerEvent constructor at all (only MouseEvent) — bridge.ts's device-side input
// dispatch (tap/drag/pointer) constructs real `PointerEvent`s to feed PixiJS's federated event
// system and the canvas. `button`/`buttons` are already part of MouseEventInit, so the base
// class handles those; this only needs to add the pointer-specific fields the init dictionary
// carries (`pointerId`/`pointerType`/`isPrimary`) so a test can exercise that dispatch path.
if (typeof globalThis.PointerEvent === 'undefined' && typeof MouseEvent !== 'undefined') {
  class PointerEventPolyfill extends MouseEvent implements PointerEvent {
    pointerId: number;
    pointerType: string;
    isPrimary: boolean;
    width = 1; height = 1; pressure = 0; tangentialPressure = 0;
    tiltX = 0; tiltY = 0; twist = 0; altitudeAngle = 0; azimuthAngle = 0;
    // Added to lib.dom's PointerEvent in TypeScript 6.0 — a real browser assigns a stable
    // id per physical device, and 0 is the spec's "not reported" value.
    persistentDeviceId = 0;
    constructor(type: string, params: PointerEventInit = {}) {
      super(type, params);
      this.pointerId = params.pointerId ?? 0;
      this.pointerType = params.pointerType ?? '';
      this.isPrimary = params.isPrimary ?? false;
    }
    getCoalescedEvents() { return []; }
    getPredictedEvents() { return []; }
  }
  (globalThis as unknown as { PointerEvent: typeof PointerEventPolyfill }).PointerEvent = PointerEventPolyfill;
}

// Suppress jsdom's "Not implemented: HTMLCanvasElement.prototype.getContext" warning.
// PixiJS probes canvas blend modes at import time — harmless in tests, but noisy.
// Return a minimal stub context so jsdom doesn't throw.
if (typeof HTMLCanvasElement !== 'undefined') {
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
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
