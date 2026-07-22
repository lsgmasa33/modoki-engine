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

  it('carries the source-written payload through to the drop, and reports accept', async () => {
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

    const res = await performDomDnd({ from: { selector: '[data-part="sprite-A"]' }, to: { selector: '.part-row' } });

    expect(res.ok).toBe(true);
    expect(res.types).toContain('application/skin-part');
    expect(res.accepted).toBe(true);
    expect(dropped).toBe('sprite-A');
  });

  it('reports ok:false + a reason on a no-op (empty types / target ignores the drop)', async () => {
    const src = document.createElement('div');
    const dst = document.createElement('div');
    for (const el of [src, dst]) {
      el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 10, height: 10, right: 10, bottom: 10, x: 0, y: 0, toJSON() {} });
      document.body.appendChild(el);
    }
    src.id = 'a'; dst.id = 'b';
    // No dragstart writer, no dragover preventDefault → not a real DnD source/target.
    const res = await performDomDnd({ from: { selector: '#a' }, to: { selector: '#b' } });
    expect(res.types).toEqual([]);
    expect(res.accepted).toBe(false);
    // C7 re-audit: a no-op must NOT report tool-level success — an agent doing a reparent/
    // file-move would otherwise build on a drop that never landed.
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/no-op/i);
  });

  it('reports ok:false when the source wrote a payload but the target rejects the drop', async () => {
    const src = document.createElement('div');
    const dst = document.createElement('div');
    for (const el of [src, dst]) {
      el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 10, height: 10, right: 10, bottom: 10, x: 0, y: 0, toJSON() {} });
      document.body.appendChild(el);
    }
    src.id = 'c'; dst.id = 'd';
    src.addEventListener('dragstart', (e) => (e as DragEvent).dataTransfer!.setData('application/x', 'v'));
    // Target never preventDefault-s dragover → a real drop wouldn't commit either.
    const res = await performDomDnd({ from: { selector: '#c' }, to: { selector: '#d' } });
    expect(res.types).toContain('application/x');
    expect(res.accepted).toBe(false);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/did not accept/i);
  });

  // ── accepted ≠ committed ──────────────────────────────────────────────────────
  //
  // Measured against the live editor 2026-07-22: dropping a TEXTURE on a Hierarchy entity row
  // returned {ok:true, accepted:true, types:[...]} and changed nothing — entityCount unchanged,
  // the target entity byte-identical, unsavedChanges:false, and canUndo:false (not one undo
  // entry pushed). The row preventDefaults dragover for ANY asset, then its drop handler
  // returns early unless the asset is a prefab. `accepted` can only ever see the first half.
  describe('accepted vs committed', () => {
    /** A source that writes a payload onto a target that accepts the TYPE — the shape of the
     *  measured bug. `commit` decides whether the "handler" records an edit. */
    function scene(commit: boolean) {
      const src = document.createElement('div'); src.id = 'src';
      const dst = document.createElement('div'); dst.id = 'dst';
      for (const el of [src, dst]) {
        el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 10, height: 10, right: 10, bottom: 10, x: 0, y: 0, toJSON() {} });
        document.body.appendChild(el);
      }
      src.addEventListener('dragstart', (e) => (e as DragEvent).dataTransfer!.setData('application/editor-asset', '/x.png'));
      dst.addEventListener('dragover', (e) => e.preventDefault()); // accepts the TYPE...
      let version = 7;
      dst.addEventListener('drop', () => { if (commit) version++; }); // ...but may ignore it
      return { editVersion: () => version };
    }

    it('reports committed:false + a warning when the handler did nothing', async () => {
      const { editVersion } = scene(false);
      const res = await performDomDnd({ from: { selector: '#src' }, to: { selector: '#dst' } }, { editVersion });
      expect(res.accepted).toBe(true);      // the target WAS willing to take this type
      expect(res.committed).toBe(false);    // ...and then did nothing with it
      expect(res.warning).toMatch(/no editor edit was recorded/i);
      expect(res.warning).toMatch(/prefab/i); // names the concrete case a caller will hit
    });

    it('leaves ok:true on an uncommitted drop rather than inventing a failure', async () => {
      // Deliberate: the sequence WAS delivered and WAS accepted, and some legitimate drops make
      // no undoable edit (a file move writes to disk). Downgrading to ok:false would trade a
      // false success for a false failure across drop targets nobody has enumerated. The
      // warning states exactly what is known instead.
      const { editVersion } = scene(false);
      const res = await performDomDnd({ from: { selector: '#src' }, to: { selector: '#dst' } }, { editVersion });
      expect(res.ok).toBe(true);
      expect(res.error).toBeUndefined();
    });

    it('reports committed:true and no warning when the handler records an edit', async () => {
      const { editVersion } = scene(true);
      const res = await performDomDnd({ from: { selector: '#src' }, to: { selector: '#dst' } }, { editVersion });
      expect(res.committed).toBe(true);
      expect(res.warning).toBeUndefined();
      expect(res.ok).toBe(true);
    });

    it('sees an ASYNC handler that commits after the event returns', async () => {
      // handlePrefabDrop awaits a fetch, so the edit lands long after dispatchEvent. If the
      // probe were read synchronously, EVERY real prefab drop would be reported uncommitted —
      // the false-failure version of this same bug.
      const src = document.createElement('div'); src.id = 'a2';
      const dst = document.createElement('div'); dst.id = 'b2';
      for (const el of [src, dst]) {
        el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 10, height: 10, right: 10, bottom: 10, x: 0, y: 0, toJSON() {} });
        document.body.appendChild(el);
      }
      src.addEventListener('dragstart', (e) => (e as DragEvent).dataTransfer!.setData('application/editor-asset', '/p.prefab.json'));
      dst.addEventListener('dragover', (e) => e.preventDefault());
      let version = 1;
      dst.addEventListener('drop', () => { setTimeout(() => { version++; }, 50); });

      const res = await performDomDnd({ from: { selector: '#a2' }, to: { selector: '#b2' } }, { editVersion: () => version });
      expect(res.committed).toBe(true);
      expect(res.warning).toBeUndefined();
    });

    it('omits `committed` entirely when no probe is supplied', async () => {
      // A non-editor host has nothing to ask. Absent is honest; `false` would assert a no-op
      // that was never checked.
      scene(true); // build the DOM; deliberately do NOT pass its probe
      const res = await performDomDnd({ from: { selector: '#src' }, to: { selector: '#dst' } });
      expect(res.committed).toBeUndefined();
      expect(res.warning).toBeUndefined();
      expect(res.ok).toBe(true);
    });

    it('does not wait on a drop that already failed', async () => {
      // No point sleeping for a commit that cannot happen — and the probe must not be
      // consulted, or a concurrent edit could mask the real failure.
      const src = document.createElement('div'); src.id = 's3';
      const dst = document.createElement('div'); dst.id = 'd3';
      for (const el of [src, dst]) {
        el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 10, height: 10, right: 10, bottom: 10, x: 0, y: 0, toJSON() {} });
        document.body.appendChild(el);
      }
      let probed = 0;
      const res = await performDomDnd({ from: { selector: '#s3' }, to: { selector: '#d3' } }, { editVersion: () => { probed++; return 0; } });
      expect(res.ok).toBe(false);
      expect(res.committed).toBeUndefined();
      expect(probed).toBe(1); // the "before" read only; never re-probed
    });
  });

  it('rejects with a clear error when an endpoint selector matches nothing', async () => {
    await expect(performDomDnd({ from: { selector: '#missing' }, to: { selector: 'body' } }))
      .rejects.toThrow(/no element matches selector/);
  });
});
