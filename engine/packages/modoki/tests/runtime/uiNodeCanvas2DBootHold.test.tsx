// @vitest-environment jsdom
/** #1928 — UINode lazy-loads `Canvas2DMount`, so on a device the board mounted (and registered
 *  with the boot-content gate) only AFTER the reveal's wait had found the set empty. Measured on an
 *  iPad mini 5: the gate waited for the backdrop and never saw the board. The `<Suspense>` fallback
 *  now holds a token while the chunk loads.
 *
 *  Its own file ON PURPOSE: `lazy()` caches per module graph, so in `uiNode.test.tsx` any earlier
 *  canvas2D test resolves the chunk and a later render never suspends — the fallback this pins
 *  would never mount, and the test would pass with the fix deleted. */

import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup } from '@testing-library/react';

vi.mock('../../src/runtime/rendering/Canvas2DMount', () => ({
  // Stands in for the real mount, which registers its OWN token on mount; this one registers
  // nothing, so the set empties exactly when the fallback hands over.
  Canvas2DMount: ({ entityId }: { entityId: number }) =>
    React.createElement('div', { 'data-testid': 'canvas2dmount', 'data-entity-id': entityId }),
}));

import { UINode } from '../../src/runtime/ui/UINode';
import { armBootContent, pendingBootContent, resetBootContentGate } from '../../src/runtime/core/bootContentGate';
import type { UINodeData } from '../../src/runtime/ui/uiTreeStore';

afterEach(() => { cleanup(); resetBootContentGate(); });

function canvasNode(): UINodeData {
  return {
    entityId: 5, name: 'Board', children: [], isVisible: true,
    canvas2D: { referenceWidth: 1080, referenceHeight: 1920, scaleMode: 'fitH', maxReferenceWidth: 0, maxReferenceHeight: 0 },
  } as unknown as UINodeData;
}

describe('UINode Canvas2D boot hold (#1928)', () => {
  it('holds the boot for the board while its lazy chunk loads, then hands over to the mount', async () => {
    armBootContent();
    const { findByTestId } = render(<UINode node={canvasNode()} storeState={{}} />);
    expect(pendingBootContent()).toEqual(['canvas2d:5']);
    await findByTestId('canvas2dmount');
    expect(pendingBootContent()).toEqual([]);
  });
});
