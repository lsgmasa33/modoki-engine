/** #1549 — after a restore the Animation panel re-binds to the SAME entity, found by its guid.
 *
 *  The rebind used to be "the first Animator whose clip bank lists the clip", which is right only when
 *  exactly one does: an Animator bound by "+ New Animation" (clip not in its bank) rebound to null and
 *  kept a dead id, and two Animators sharing a clip rebound to whichever came first. */

import { describe, it, expect } from 'vitest';
import { createTestWorld } from '@modoki/engine/runtime';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { EntityAttributes } from '../../packages/modoki/src/runtime/core/traits/EntityAttributes';
import { rebindAnimatorRoot } from '../../packages/modoki/src/editor/animation/poseClip';

registerAllTraits();

const HERO = 'cccccccc-0000-4000-8000-000000001549';

describe('rebindAnimatorRoot', () => {
  it('finds the bound entity by guid even when no Animator lists the clip', () => {
    const g = createTestWorld({});
    try {
      const hero = g.spawn(EntityAttributes({ name: 'Hero', guid: HERO } as never));
      // MUTATION TARGET: drop the guid lookup and this is null — the clip is in no Animator's bank
      // (the "+ New Animation" bind), so the clip-bank fallback finds nothing.
      expect(rebindAnimatorRoot(HERO, '/assets/anim/walk.anim.json')).toBe(hero.id());
      // ACCEPT SIDE: a guid that is gone falls back to the clip lookup, which finds nothing here.
      expect(rebindAnimatorRoot('dddddddd-0000-4000-8000-000000001549', '/assets/anim/walk.anim.json')).toBeNull();
      expect(rebindAnimatorRoot(null, undefined)).toBeNull();
    } finally { g.dispose(); }
  });
});
