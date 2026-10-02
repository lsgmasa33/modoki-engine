/** A modal asset editor's Save lays only what IT changed over a fresh read of the sidecar (#2057) — the decision in
 *  `modalMetaSave.ts`, tested as a plain function (CLAUDE.md § Editor: no jsdom panel mount). Its callers are
 *  `SpriteEditor.save` and `NineSliceEditor.save`; the live half (an agent's import-setting write survives a Save) is
 *  driven in the editor and recorded on #2057. */
import { describe, it, expect } from 'vitest';
import { planModalMetaSave } from '../../packages/modoki/src/editor/panels/modalMetaSave';

const open = () => ({ id: 'tex-guid', filterMode: 'linear', border: { l: 1, r: 1, t: 1, b: 1 } });

describe('planModalMetaSave (#2057)', () => {
  it("keeps a key someone else changed while the editor was open, and sets the editor's own change", () => {
    const fresh = { ...open(), filterMode: 'nearest' }; // the agent, meanwhile
    const plan = planModalMetaSave(open(), fresh, { border: { l: 4, r: 4, t: 4, b: 4 } });
    expect(plan).toEqual({ ok: true, set: { border: { l: 4, r: 4, t: 4, b: 4 } }, remove: [] });
    // What the caller writes: `{ ...fresh, ...set }` — the agent's filterMode survives.
    expect({ ...fresh, ...(plan.ok ? plan.set : {}) }.filterMode).toBe('nearest');
  });

  it('an owned key the editor did not change is not written — the fresh value stands even if it moved', () => {
    const fresh = { ...open(), border: { l: 9, r: 9, t: 9, b: 9 } };
    expect(planModalMetaSave(open(), fresh, { border: { l: 1, r: 1, t: 1, b: 1 } })).toEqual({ ok: true, set: {}, remove: [] });
  });

  it('refuses an owned key both changed to different values, naming it', () => {
    const fresh = { ...open(), border: { l: 9, r: 9, t: 9, b: 9 } };
    expect(planModalMetaSave(open(), fresh, { border: { l: 4, r: 4, t: 4, b: 4 } })).toEqual({ ok: false, conflict: ['border'] });
  });

  it('both changing a key to the SAME value is not a conflict', () => {
    const fresh = { ...open(), border: { l: 4, r: 4, t: 4, b: 4 } };
    expect(planModalMetaSave(open(), fresh, { border: { l: 4, r: 4, t: 4, b: 4 } }).ok).toBe(true);
  });

  it('undefined means absent: a cleared owned key is removed', () => {
    expect(planModalMetaSave(open(), open(), { border: undefined })).toEqual({ ok: true, set: {}, remove: ['border'] });
  });

  it('key order is not a change: a hand-written border listing t first equals the editor\'s l-first one', () => {
    const handWritten = { ...open(), border: { t: 1, b: 1, l: 1, r: 1 } };
    expect(planModalMetaSave(handWritten, handWritten, { border: { l: 1, r: 1, t: 1, b: 1 } })).toEqual({ ok: true, set: {}, remove: [] });
  });

  // Close-out review: the notice's Overwrite re-plans with the refused keys; only those skip the conflict check.
  // Mutation (measured): ignore `overwrite` — the first goes red.
  it('an overwritten key is set over the moved value; other conflicts still refuse', () => {
    const fresh = { ...open(), border: { l: 9, r: 9, t: 9, b: 9 }, sprites: ['agent'] };
    const o = { ...open(), sprites: ['old'] };
    expect(planModalMetaSave(o, fresh, { border: { l: 4, r: 4, t: 4, b: 4 } }, ['border']))
      .toEqual({ ok: true, set: { border: { l: 4, r: 4, t: 4, b: 4 } }, remove: [] });
    expect(planModalMetaSave(o, fresh, { border: { l: 4, r: 4, t: 4, b: 4 }, sprites: ['mine'] }, ['border']))
      .toEqual({ ok: false, conflict: ['sprites'] });
  });

  it('an untouched editor passing the OPEN values writes nothing even though its rendering would differ', () => {
    // 9-slice normalises `scale: 1` away; passing the open value (what the modal does when not dirty) is no change.
    const o = { ...open(), border: { l: 4, r: 4, t: 4, b: 4, scale: 1 } };
    const fresh = { ...o, border: { l: 9, r: 9, t: 9, b: 9 } };
    expect(planModalMetaSave(o, fresh, { border: o.border })).toEqual({ ok: true, set: {}, remove: [] });
  });
});

