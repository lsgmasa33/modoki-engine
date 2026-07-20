/** skeletalPreview module contract — the editor↔runtime bridge that lets the
 *  Animation editor advance the skeletal mixer while NOT in Play mode. */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  setSkeletalPreview,
  isSkeletalPreviewing,
  skeletalPreviewDelta,
} from '../../src/runtime/systems/skeletalPreview';

describe('skeletalPreview', () => {
  beforeEach(() => setSkeletalPreview(false, 0));

  it('defaults to inactive with zero delta', () => {
    expect(isSkeletalPreviewing()).toBe(false);
    expect(skeletalPreviewDelta()).toBe(0);
  });

  it('reports the delta only while active', () => {
    setSkeletalPreview(true, 0.016);
    expect(isSkeletalPreviewing()).toBe(true);
    expect(skeletalPreviewDelta()).toBeCloseTo(0.016);
  });

  it('zeroes the delta when deactivated (even if a dt is passed)', () => {
    setSkeletalPreview(true, 0.016);
    setSkeletalPreview(false, 0.033); // dt ignored when inactive
    expect(isSkeletalPreviewing()).toBe(false);
    expect(skeletalPreviewDelta()).toBe(0);
  });
});
