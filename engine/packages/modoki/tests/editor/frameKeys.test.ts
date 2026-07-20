/** frameKeys — editor frame-driver callback key minting (editor-sceneview F5/F6, Missing Test #7).
 *  Guards the "rapid remount blackout" regression: two viewport instances must NEVER compute the
 *  same key, or one's cleanup unregisters the survivor's loop. Pure — no three/DOM. */
import { describe, it, expect } from 'vitest';
import { mintEditor3DFrameKey, editor2DFrameKey } from '../../src/editor/scene/frameKeys';

describe('mintEditor3DFrameKey (F5 — 3D viewport key uniqueness)', () => {
  it('mints a distinct key on every call (two rapid mounts never collide)', () => {
    // Same-tick double-mint (StrictMode double-invoke / fast-mode toggle / HMR) —
    // Date.now() collided here; the monotonic counter does not.
    const a = mintEditor3DFrameKey();
    const b = mintEditor3DFrameKey();
    expect(a).not.toBe(b);
  });

  it('produces all-unique keys across many rapid mounts', () => {
    const keys = new Set<string>();
    for (let i = 0; i < 1000; i++) keys.add(mintEditor3DFrameKey());
    expect(keys.size).toBe(1000); // no duplicates
  });

  it('uses the editor-3d- namespace', () => {
    expect(mintEditor3DFrameKey()).toMatch(/^editor-3d-\d+$/);
  });
});

describe('editor2DFrameKey (F6 — 2D layer key is size-independent)', () => {
  it('keys by entity id alone — stable across resizes/zooms', () => {
    // The old key embedded pixel size, so a resize re-registered the callback +
    // restarted the ref-counted driver. Keyed by id, the key is invariant.
    expect(editor2DFrameKey(42)).toBe('editor-2d-42');
    expect(editor2DFrameKey(42)).toBe(editor2DFrameKey(42)); // resize → same key
  });

  it('distinct entities get distinct keys (layers never clobber each other)', () => {
    expect(editor2DFrameKey(1)).not.toBe(editor2DFrameKey(2));
  });
});
