// @vitest-environment jsdom
/** Enact Phase 1 — HTML5 drag-and-drop synthesis (engine/app/debug/domDnd.ts).
 *  Verifies the synthesized sequence lets the app's OWN dragstart handler fill the
 *  DataTransfer and the drop handler read it back — the human-drag contract. */
import { describe, it, expect, beforeEach } from 'vitest';
import { performDomDnd } from '../../app/debug/domDnd';

// jsdom ships no DataTransfer/DragEvent; the renderer (Chromium) does. Minimal
// shims so the test exercises the REAL synthesizer logic. DragEvent subclasses
// jsdom's MouseEvent (so clientX/cancelable/preventDefault behave) + carries dt.
class FakeDataTransfer {
  private store = new Map<string, string>();
  setData(type: string, val: string) { this.store.set(type, val); }
  getData(type: string) { return this.store.get(type) ?? ''; }
  get types() { return Array.from(this.store.keys()); }
}
class FakeDragEvent extends MouseEvent {
  dataTransfer: FakeDataTransfer | null;
  constructor(type: string, init: MouseEventInit & { dataTransfer?: FakeDataTransfer }) {
    super(type, init);
    this.dataTransfer = init.dataTransfer ?? null;
  }
}
(globalThis as unknown as { DataTransfer: unknown }).DataTransfer = FakeDataTransfer;
(globalThis as unknown as { DragEvent: unknown }).DragEvent = FakeDragEvent;

describe('performDomDnd', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('carries the source-written payload through to the drop, and reports accept', () => {
    const src = document.createElement('div');
    src.setAttribute('data-part', 'sprite-A');
    src.draggable = true;
    const dst = document.createElement('div');
    dst.className = 'part-row';
    // Give both a nonzero rect so selector-center resolution has coordinates.
    for (const el of [src, dst]) {
      el.getBoundingClientRect = () => ({ left: 10, top: 10, width: 20, height: 20, right: 30, bottom: 30, x: 10, y: 10, toJSON() {} });
      document.body.appendChild(el);
    }

    // App handlers: source writes a payload; target accepts + reads it on drop.
    src.addEventListener('dragstart', (e) => {
      (e as DragEvent).dataTransfer!.setData('application/skin-part', 'sprite-A');
    });
    let dropped: string | null = null;
    dst.addEventListener('dragover', (e) => e.preventDefault()); // signal "droppable"
    dst.addEventListener('drop', (e) => {
      dropped = (e as DragEvent).dataTransfer!.getData('application/skin-part');
    });

    const res = performDomDnd({ from: { selector: '[data-part="sprite-A"]' }, to: { selector: '.part-row' } });

    expect(res.ok).toBe(true);
    expect(res.types).toContain('application/skin-part');
    expect(res.accepted).toBe(true);
    expect(dropped).toBe('sprite-A');
  });

  it('reports ok:false + a reason on a no-op (empty types / target ignores the drop)', () => {
    const src = document.createElement('div');
    const dst = document.createElement('div');
    for (const el of [src, dst]) {
      el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 10, height: 10, right: 10, bottom: 10, x: 0, y: 0, toJSON() {} });
      document.body.appendChild(el);
    }
    src.id = 'a'; dst.id = 'b';
    // No dragstart writer, no dragover preventDefault → not a real DnD source/target.
    const res = performDomDnd({ from: { selector: '#a' }, to: { selector: '#b' } });
    expect(res.types).toEqual([]);
    expect(res.accepted).toBe(false);
    // C7 re-audit: a no-op must NOT report tool-level success — an agent doing a reparent/
    // file-move would otherwise build on a drop that never landed.
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/no-op/i);
  });

  it('reports ok:false when the source wrote a payload but the target rejects the drop', () => {
    const src = document.createElement('div');
    const dst = document.createElement('div');
    for (const el of [src, dst]) {
      el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 10, height: 10, right: 10, bottom: 10, x: 0, y: 0, toJSON() {} });
      document.body.appendChild(el);
    }
    src.id = 'c'; dst.id = 'd';
    src.addEventListener('dragstart', (e) => (e as DragEvent).dataTransfer!.setData('application/x', 'v'));
    // Target never preventDefault-s dragover → a real drop wouldn't commit either.
    const res = performDomDnd({ from: { selector: '#c' }, to: { selector: '#d' } });
    expect(res.types).toContain('application/x');
    expect(res.accepted).toBe(false);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/did not accept/i);
  });

  it('throws a clear error when an endpoint selector matches nothing', () => {
    expect(() => performDomDnd({ from: { selector: '#missing' }, to: { selector: 'body' } }))
      .toThrow(/no element matches selector/);
  });
});
