/** Editor preferences keyed by entity guid must never key by a RUNTIME guid (#1210).
 *
 *  Both stores below persist to localStorage and are read back next session. A runtime guid is
 *  valid only until reload and its counter restarts every session, so a persisted one would attach
 *  the preference to whichever entity happens to get that address next time — silently. A durable
 *  guid is the control in each test, so a store that stopped persisting at all cannot pass. */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { getCurrentWorld, spawnEntity, EntityAttributes, Transform, destroyEntity } from '@modoki/engine/runtime';
import { useEditorStore } from '@modoki/engine/editor';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { registerLastAnimationClipPersistence } from '../../packages/modoki/src/editor/animation/lastAnimationClip';
import { formatRuntimeGuid } from '../../packages/modoki/src/runtime/core/assetRefRules';

registerAllTraits();

// The engine lane has no localStorage; back it with a real map so the persisted payload is readable
// (a no-op stub would make the assertions below vacuous).
const storage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => (storage.has(k) ? storage.get(k)! : null),
  setItem: (k: string, v: string) => { storage.set(k, String(v)); },
  removeItem: (k: string) => { storage.delete(k); },
  clear: () => { storage.clear(); },
});
afterAll(() => { vi.unstubAllGlobals(); });

const DURABLE = 'd1111111-1111-4111-8111-111111111111';

describe('camera framing gizmo toggle (#1210)', () => {
  beforeEach(() => { useEditorStore.setState({ cameraGizmoShown: new Set() }); });

  it('stores a durable guid and ignores a runtime one', () => {
    const { setCameraGizmoShown } = useEditorStore.getState();
    setCameraGizmoShown(formatRuntimeGuid(1, 1), true);
    expect([...useEditorStore.getState().cameraGizmoShown]).toEqual([]);
    setCameraGizmoShown(DURABLE, true);
    expect([...useEditorStore.getState().cameraGizmoShown]).toEqual([DURABLE]);
  });
});

describe('last animation clip binding (#1210)', () => {
  const spawned: ReturnType<typeof spawnEntity>[] = [];
  const persisted = (): { animatorGuid: string | null } | null => {
    for (const [k, v] of storage) if (k.includes('editor:lastAnimationClip')) return JSON.parse(v);
    return null;
  };
  const bindTo = (guid: string, clip: string) => {
    const e = spawnEntity(getCurrentWorld(), Transform(), EntityAttributes({ name: `anim-${clip}`, guid }));
    spawned.push(e);
    useEditorStore.setState({
      editingAnimationAsset: { path: `/assets/${clip}.anim.json`, type: 'animation', name: clip },
      animatorRootEntityId: e.id(),
    } as never);
  };

  beforeEach(() => { storage.clear(); registerLastAnimationClipPersistence(); });
  afterEach(() => { for (const e of spawned.splice(0)) destroyEntity(e); });

  it('persists a durable Animator guid but records a runtime-guid binding as unbound', () => {
    bindTo(DURABLE, 'durable');
    expect(persisted()?.animatorGuid).toBe(DURABLE);
    bindTo(formatRuntimeGuid(1, 2), 'runtime');
    expect(persisted()?.animatorGuid).toBeNull();
  });
});
