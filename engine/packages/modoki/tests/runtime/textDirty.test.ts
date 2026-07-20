/** textDirty — the relayout dirty-signal that wakes idle renderers when text state
 *  changes OUTSIDE the per-entity trait hash (async font-atlas load, dynamic-font
 *  glyph generation). The Scene2D/Scene3D/SceneView idle gates subscribe via
 *  onTextDirty(); without a wake, a just-typed dynamic glyph stays tofu until the
 *  next unrelated edit ("re-type to see it"). These lock the primitive's contract. */

import { describe, it, expect } from 'vitest';
import { markTextDirty, getTextDirtyVersion, onTextDirty } from '../../src/runtime/rendering/text/textDirty';

describe('textDirty', () => {
  it('bumps the version monotonically on each mark (so a stored-version compare detects it)', () => {
    const before = getTextDirtyVersion();
    markTextDirty();
    expect(getTextDirtyVersion()).toBe(before + 1);
    markTextDirty();
    expect(getTextDirtyVersion()).toBe(before + 2);
  });

  it('fires every subscribed listener on mark (each renderer gate wakes)', () => {
    let a = 0, b = 0;
    const offA = onTextDirty(() => { a++; });
    const offB = onTextDirty(() => { b++; });
    markTextDirty();
    expect(a).toBe(1);
    expect(b).toBe(1);
    offA();
    offB();
  });

  it('stops firing after unsubscribe (renderer stop() must not leak a wake)', () => {
    let n = 0;
    const off = onTextDirty(() => { n++; });
    markTextDirty();
    expect(n).toBe(1);
    off();
    markTextDirty();
    expect(n).toBe(1); // no further fire after unsubscribe
  });
});
