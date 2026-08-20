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

/** jsdom has no layout, so BOTH halves of an aim have to be supplied by hand: every
 *  `getBoundingClientRect()` is 0x0, and `document.elementFromPoint` does not exist at all
 *  (`tests/setup.ts` installs an always-miss stub returning null).
 *
 *  That second one became load-bearing with #260: `performDomDnd` now hit-tests both endpoints,
 *  and an always-miss reads as "covered by nothing", so EVERY drop in this file would carry the
 *  human-impossible warning and none of the occlusion assertions would mean anything. `place()`
 *  gives an element a real rect and registers it for a coordinate-aware stub, so a test can
 *  express a clean aim and a covered one and tell them apart. Later registrations sit ON TOP —
 *  that is how a cover is written. Endpoints get DISTINCT positions for the same reason: at a
 *  shared rect the second element registered would cover the first, and every drop would warn. */
const stack: Element[] = [];
function place<T extends Element>(el: T, x: number, y: number, w = 10, h = 10): T {
  el.getBoundingClientRect = () => ({
    left: x, top: y, width: w, height: h, right: x + w, bottom: y + h, x, y, toJSON() {},
  }) as DOMRect;
  document.body.appendChild(el);
  stack.push(el);
  return el;
}
document.elementFromPoint = (x: number, y: number) => {
  for (let i = stack.length - 1; i >= 0; i--) {
    const r = stack[i].getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return stack[i];
  }
  return null;
};

describe('performDomDnd', () => {
  beforeEach(() => { document.body.innerHTML = ''; stack.length = 0; });

  it('carries the source-written payload through to the drop, and reports accept', async () => {
    const src = document.createElement('div');
    src.setAttribute('data-part', 'sprite-A');
    src.draggable = true;
    const dst = document.createElement('div');
    dst.className = 'part-row';
    // Nonzero, non-overlapping rects so selector-centre resolution has coordinates and
    // neither endpoint reads as covering the other.
    place(src, 10, 10, 20, 20);
    place(dst, 100, 10, 20, 20);

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
    src.id = 'a'; dst.id = 'b';
    place(src, 0, 0); place(dst, 100, 0);
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
    src.id = 'c'; dst.id = 'd';
    place(src, 0, 0); place(dst, 100, 0);
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
      place(src, 0, 0); place(dst, 100, 0);
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
      place(src, 0, 0); place(dst, 100, 0);
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
      place(src, 0, 0); place(dst, 100, 0);
      let probed = 0;
      const res = await performDomDnd({ from: { selector: '#s3' }, to: { selector: '#d3' } }, { editVersion: () => { probed++; return 0; } });
      expect(res.ok).toBe(false);
      expect(res.committed).toBeUndefined();
      expect(probed).toBe(1); // the "before" read only; never re-probed
    });
  });

  // ── a covered endpoint: warn, don't refuse (#260) ─────────────────────────────
  //
  // `modoki_dnd` is the one aimed input op that does NOT refuse a covered aim, and that is
  // correct: `docs/mcp-tool-conventions.md` §3 refuses because the input would land on the
  // covering element, and `dispatchEvent` bypasses hit-testing so it does not. Refusing would
  // reject a call that works. The DEFECT was the silence — a covered drop succeeded and read
  // identically to one a human could perform, so a QA case could pass on a broken gesture.
  describe('covered endpoints', () => {
    /** A working source/target pair, with `cover` registered last (i.e. on top) over whichever
     *  endpoints its rect spans. */
    function scene(coverRect: { x: number; y: number; w: number; h: number } | null) {
      const src = document.createElement('div'); src.id = 'cs';
      const dst = document.createElement('div'); dst.id = 'cd';
      place(src, 0, 0); place(dst, 100, 0);
      src.addEventListener('dragstart', (e) => (e as DragEvent).dataTransfer!.setData('application/editor-asset', '/p.prefab.json'));
      dst.addEventListener('dragover', (e) => e.preventDefault());
      let version = 1;
      dst.addEventListener('drop', () => { version++; });
      if (coverRect) {
        const cover = document.createElement('div');
        cover.setAttribute('data-ui-id', 'modal.scrim');
        place(cover, coverRect.x, coverRect.y, coverRect.w, coverRect.h);
      }
      return { editVersion: () => version };
    }

    it('still delivers the drop when the target is covered — ok:true, and the edit lands', async () => {
      // The load-bearing half of "warn, don't refuse": this call WORKS, so refusing it would be
      // a false failure. Assert the commit, not just the absence of an error.
      const { editVersion } = scene({ x: 95, y: -5, w: 30, h: 30 });
      const res = await performDomDnd({ from: { selector: '#cs' }, to: { selector: '#cd' } }, { editVersion });
      expect(res.ok).toBe(true);
      expect(res.error).toBeUndefined();
      expect(res.committed).toBe(true);
    });

    it('reports occluded + names the cover on the covered endpoint only', async () => {
      const { editVersion } = scene({ x: 95, y: -5, w: 30, h: 30 });
      const res = await performDomDnd({ from: { selector: '#cs' }, to: { selector: '#cd' } }, { editVersion });
      expect(res.to.occluded).toBe(true);
      expect(res.to.hitTarget).toContain('modal.scrim');
      expect(res.from.occluded).toBe(false);   // the source was clear — don't smear the blame
      expect(res.warning).toMatch(/NOT ONE A HUMAN COULD PERFORM/);
      expect(res.warning).toMatch(/target \(to\)/);
      expect(res.warning).not.toMatch(/source \(from\)/);
    });

    it('catches a covered SOURCE too — a human could not even grab it', async () => {
      const { editVersion } = scene({ x: -5, y: -5, w: 30, h: 30 });
      const res = await performDomDnd({ from: { selector: '#cs' }, to: { selector: '#cd' } }, { editVersion });
      expect(res.from.occluded).toBe(true);
      expect(res.to.occluded).toBe(false);
      expect(res.warning).toMatch(/source \(from\)/);
    });

    it('names both endpoints when one cover spans them', async () => {
      const { editVersion } = scene({ x: -5, y: -5, w: 200, h: 30 });
      const res = await performDomDnd({ from: { selector: '#cs' }, to: { selector: '#cd' } }, { editVersion });
      expect(res.warning).toMatch(/source \(from\)/);
      expect(res.warning).toMatch(/target \(to\)/);
    });

    it('says nothing about occlusion on a clean drop', async () => {
      // The regression that would make this whole change worthless: a warning on every drop is
      // the same as no warning at all.
      const { editVersion } = scene(null);
      const res = await performDomDnd({ from: { selector: '#cs' }, to: { selector: '#cd' } }, { editVersion });
      expect(res.from.occluded).toBe(false);
      expect(res.to.occluded).toBe(false);
      expect(res.warning).toBeUndefined();
    });

    it('reports both warnings when a covered drop also records no edit', async () => {
      const src = document.createElement('div'); src.id = 'bs';
      const dst = document.createElement('div'); dst.id = 'bd';
      place(src, 0, 0); place(dst, 100, 0);
      src.addEventListener('dragstart', (e) => (e as DragEvent).dataTransfer!.setData('application/editor-asset', '/x.png'));
      dst.addEventListener('dragover', (e) => e.preventDefault());   // accepts the TYPE, commits nothing
      const cover = document.createElement('div');
      cover.setAttribute('data-ui-id', 'modal.scrim');
      place(cover, 95, -5, 30, 30);
      const res = await performDomDnd({ from: { selector: '#bs' }, to: { selector: '#bd' } }, { editVersion: () => 7 });
      expect(res.warning).toMatch(/NOT ONE A HUMAN COULD PERFORM/);
      expect(res.warning).toMatch(/no editor edit was recorded/);
    });

    /** A COORDINATE aim matched nothing by name, so there is nothing for it to be occluded
     *  relative to — whatever sits under the point IS the target. Reporting `occluded` there
     *  would be a category error, and it would fire on every coordinate drop. */
    it('does not claim occlusion for a coordinate endpoint', async () => {
      scene(null);
      const res = await performDomDnd({ from: { x: 5, y: 5 }, to: { x: 105, y: 5 } });
      expect(res.from.occluded).toBeUndefined();
      expect(res.to.occluded).toBeUndefined();
      expect(res.warning).toBeUndefined();
    });
  });

  it('rejects with a clear error when an endpoint selector matches nothing', async () => {
    await expect(performDomDnd({ from: { selector: '#missing' }, to: { selector: 'body' } }))
      .rejects.toThrow(/no element matches selector/);
  });
});
