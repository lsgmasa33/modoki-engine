/** Every authorable BlobShadow field must carry Inspector metadata.
 *
 *  Narrow on purpose. `softness` shipped without a `fields` entry while all six siblings had one,
 *  and the consequence is not cosmetic: `blobEdgeStart` clamps softness to 0..1, so an UNBOUNDED
 *  Inspector field lets a user enter 2, stores 2 on the trait, and renders 1 — the panel and the
 *  shader disagree with nothing to indicate it. The trait exists to be tuned by eye in that panel
 *  (the sling puck / enemies), so the bounds are the feature, not decoration.
 *
 *  Deliberately NOT generalised to every trait: some registrations omit fields on purpose, for
 *  runtime read-back members a user must not author (`CharacterController3D.grounded`/`velY`,
 *  `moveX`/`moveZ`). A repo-wide version needs a way to mark those, which is a design call. */

import { describe, it, expect } from 'vitest';
import { BlobShadow } from '@modoki/engine/runtime';
import { getTraitMeta } from '@modoki/engine/runtime';
import { registerAllTraits } from '../../app/ecs/registerTraits';

describe('BlobShadow — Inspector field metadata', () => {
  it('registers a field entry for every authorable key, softness included', () => {
    registerAllTraits();
    const meta = getTraitMeta(BlobShadow);
    expect(meta).toBeDefined();
    const declared = Object.keys(meta!.fields ?? {});
    const authorable = Object.keys(BlobShadow.schema as Record<string, unknown>);
    expect([...authorable].sort()).toEqual([...declared].sort());
  });

  it('bounds softness to 0..1, the range blobEdgeStart actually honours', () => {
    registerAllTraits();
    const f = (getTraitMeta(BlobShadow)!.fields as Record<string, { min?: number; max?: number }>).softness;
    expect(f).toBeDefined();
    expect(f.min).toBe(0);
    expect(f.max).toBe(1);
  });
});
