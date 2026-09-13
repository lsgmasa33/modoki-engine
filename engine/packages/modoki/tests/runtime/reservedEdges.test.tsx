/** Reserved edge bands (#1159) — a `reservesEdge` strip (an ad banner) publishes its height, and a
 *  `clearsReservedEdges` container pads it on top of the safe-area inset.
 *
 *  Four links in one chain, each tested at its own seam: the projection finds the VISIBLE strips
 *  (`resolveReservedEdges`), the length is resolved against the container's height
 *  (`reservedBandLength`), `UIRenderer` publishes the var, and `applyAnchorStyle` reads it. The
 *  browser composition of those four is the live check in games/wordweave/docs, not this file. */
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup } from '@testing-library/react';
import type { CSSProperties } from 'react';

const h = vi.hoisted(() => ({ tree: { current: [] as unknown[] } }));
vi.mock('../../src/runtime/ui/useUIEntities', () => ({ useUIEntities: () => h.tree.current }));
vi.mock('../../src/runtime/ui/UINode', () => ({ UINode: () => null }));

import {
  applyAnchorStyle, inertUIAnchorBooleanReason, reservedBandLength, reservedEdgeOf, reservedEdgeVar,
} from '../../src/runtime/ui/anchorCss';
import type { AnchorData } from '../../src/runtime/ui/anchorLayout';
import { resolveReservedEdges, useUITreeStore, type UINodeData } from '../../src/runtime/ui/uiTreeStore';
import { UIRenderer } from '../../src/runtime/ui/UIRenderer';
import { resetSafeAreaInsets } from '../../src/runtime/ui/safeArea';
import { clearPointerBlockers } from '../../src/runtime/core/pointerBlockers';

function anchor(over: Partial<AnchorData> = {}): AnchorData {
  return {
    anchor: 'stretch', top: 0, topUnit: 'px', right: 0, rightUnit: 'px',
    bottom: 0, bottomUnit: 'px', left: 0, leftUnit: 'px', pivotX: 0, pivotY: 0, ...over,
  };
}
const styleFor = (over: Partial<AnchorData>, base: CSSProperties = {}): CSSProperties => {
  const s = { ...base };
  applyAnchorStyle(s, anchor(over));
  return s;
};

describe('applyAnchorStyle — clearsReservedEdges', () => {
  it('adds the band var to the top and bottom inset of a stretched safe-area container', () => {
    const s = styleFor({ safeArea: true, clearsReservedEdges: true });
    expect(String(s.paddingBottom)).toBe(
      'max(0px, calc(var(--ui-sa-bottom, env(safe-area-inset-bottom)) + var(--ui-reserve-bottom, 0px)))');
    expect(String(s.paddingTop)).toBe(
      'max(0px, calc(var(--ui-sa-top, env(safe-area-inset-top)) + var(--ui-reserve-top, 0px)))');
  });

  it('leaves the side insets alone — a band is a top/bottom concept', () => {
    const s = styleFor({ safeArea: true, clearsReservedEdges: true });
    expect(String(s.paddingLeft)).toBe('max(0px, var(--ui-sa-left, env(safe-area-inset-left)))');
    expect(String(s.paddingRight)).not.toContain('--ui-reserve');
  });

  it('keeps an authored padding as the floor, so a panel already clear does not move', () => {
    const s = styleFor({ safeArea: true, clearsReservedEdges: true }, { paddingBottom: 40 });
    expect(String(s.paddingBottom)).toMatch(/^max\(40px, calc\(/);
  });

  it('emits exactly the safe-area CSS when the flag is off — no existing element moves', () => {
    const s = styleFor({ safeArea: true });
    expect(String(s.paddingBottom)).toBe('max(0px, var(--ui-sa-bottom, env(safe-area-inset-bottom)))');
    expect(String(s.paddingTop)).not.toContain('--ui-reserve');
  });

  it('does nothing without safeArea — it rides the safe-area padding arm', () => {
    const s = styleFor({ safeArea: false, clearsReservedEdges: true });
    expect(s.paddingBottom).toBeUndefined();
    expect(s.paddingTop).toBeUndefined();
  });
});

describe('reservedBandLength — resolved against the container HEIGHT', () => {
  it('turns % into --ui-vh, never a CSS % (which padding resolves against the WIDTH)', () => {
    expect(reservedBandLength(9.1, '%')).toBe('calc(9.1 * var(--ui-vh, 1vh))');
  });
  it('passes viewport units through their own var, and px as px', () => {
    expect(reservedBandLength(10, 'vmin')).toBe('calc(10 * var(--ui-vmin, 1vmin))');
    expect(reservedBandLength(50, 'px')).toBe('50px');
  });
  it('is 0px for a non-positive height', () => {
    expect(reservedBandLength(0, '%')).toBe('0px');
    expect(reservedBandLength(-3, 'px')).toBe('0px');
  });
});

const node = (over: Partial<UINodeData> & { anchorMode?: AnchorData['anchor']; reserves?: boolean }): UINodeData => ({
  entityId: 1, isVisible: true, height: 9.1, heightUnit: '%', children: [],
  anchor: over.anchorMode === undefined ? undefined : {
    ...anchor({ anchor: over.anchorMode }), safeArea: false,
    reservesEdge: over.reserves ?? true, clearsReservedEdges: false,
  },
  ...over,
} as unknown as UINodeData);

describe('resolveReservedEdges — which strips reserve', () => {
  it('a visible bottom-stretch strip reserves its height on the bottom edge', () => {
    expect(resolveReservedEdges([node({ anchorMode: 'bottom-stretch' })]))
      .toEqual({ top: '0px', bottom: 'calc(9.1 * var(--ui-vh, 1vh))' });
  });

  it('finds a strip nested under a full-screen root (wordweave\'s banner sits in HUD Root)', () => {
    const tree = [node({ children: [node({ anchorMode: 'bottom-stretch' })] })];
    expect(resolveReservedEdges(tree).bottom).toBe('calc(9.1 * var(--ui-vh, 1vh))');
  });

  it('a top-stretch strip reserves the top edge', () => {
    expect(resolveReservedEdges([node({ anchorMode: 'top-stretch', height: 40, heightUnit: 'px' })]).top).toBe('40px');
  });

  it('a hidden strip reserves nothing (a playable build hides the banner)', () => {
    expect(resolveReservedEdges([node({ anchorMode: 'bottom-stretch', isVisible: false })]).bottom).toBe('0px');
  });

  it('a strip inside a HIDDEN ancestor reserves nothing — UINode draws none of its children', () => {
    const tree = [node({ isVisible: false, children: [node({ anchorMode: 'bottom-stretch' })] })];
    expect(resolveReservedEdges(tree).bottom).toBe('0px');
  });

  it('the flag is inert off a top/bottom strip anchor, and a strip without the flag reserves nothing', () => {
    expect(resolveReservedEdges([node({ anchorMode: 'stretch' }), node({ anchorMode: 'bottom' })]))
      .toEqual({ top: '0px', bottom: '0px' });
    expect(resolveReservedEdges([node({ anchorMode: 'bottom-stretch', reserves: false })]).bottom).toBe('0px');
  });

  it('two strips on one edge take the LARGER — they overlap, they do not stack', () => {
    const tree = [node({ anchorMode: 'bottom-stretch' }), node({ anchorMode: 'bottom-stretch', height: 50, heightUnit: 'px' })];
    expect(resolveReservedEdges(tree).bottom).toBe('max(calc(9.1 * var(--ui-vh, 1vh)), 50px)');
  });
});

describe('inertUIAnchorBooleanReason — the Inspector greys out exactly what the runtime ignores', () => {
  it('safeArea: inert only on center', () => {
    expect(inertUIAnchorBooleanReason('safeArea', { anchor: 'center' })).not.toBeNull();
    expect(inertUIAnchorBooleanReason('safeArea', { anchor: 'top-left' })).toBeNull();
  });

  it('reservesEdge: live on a top-stretch or bottom-stretch strip only', () => {
    // An explicit table, not `reservedEdgeOf` — the predicate calls that helper, so comparing the two
    // would move together under any change to it.
    const live = new Set(['top-stretch', 'bottom-stretch']);
    for (const a of ['stretch', 'top-stretch', 'bottom-stretch', 'h-stretch', 'v-stretch', 'top', 'bottom', 'left-stretch', 'right-stretch', 'center', 'top-left']) {
      expect(inertUIAnchorBooleanReason('reservesEdge', { anchor: a }) === null, a).toBe(live.has(a));
      expect(reservedEdgeOf(a) !== null, a).toBe(live.has(a));
    }
  });

  it('clearsReservedEdges: live exactly where applyAnchorStyle emits the band term', () => {
    for (const a of ['stretch', 'top-stretch', 'bottom-stretch', 'h-stretch', 'v-stretch', 'left-stretch', 'top', 'center', 'bottom-left']) {
      for (const safeArea of [true, false]) {
        const s = styleFor({ anchor: a as AnchorData['anchor'], safeArea, clearsReservedEdges: true });
        const emits = `${String(s.paddingTop)} ${String(s.paddingBottom)}`.includes('--ui-reserve');
        expect(inertUIAnchorBooleanReason('clearsReservedEdges', { anchor: a, safeArea }) === null, `${a} safeArea=${safeArea}`).toBe(emits);
      }
    }
  });
});

class FakeRO {
  observe = vi.fn(); disconnect = vi.fn(); unobserve = vi.fn();
  constructor(public cb: () => void) {}
}

describe('UIRenderer — publishes the bands on the shared container', () => {
  beforeEach(() => {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeRO;
    h.tree.current = [{ entityId: 1 }];
  });
  afterEach(() => {
    cleanup();
    resetSafeAreaInsets();
    clearPointerBlockers();
    useUITreeStore.setState({ reserveTop: '0px', reserveBottom: '0px' });
  });

  it('writes the store\'s band lengths under the var names applyAnchorStyle reads', () => {
    useUITreeStore.setState({ reserveTop: '12px', reserveBottom: 'calc(9.1 * var(--ui-vh, 1vh))' });
    const { container } = render(<UIRenderer />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.style.getPropertyValue(reservedEdgeVar('top'))).toBe('12px');
    expect(root.style.getPropertyValue(reservedEdgeVar('bottom'))).toBe('calc(9.1 * var(--ui-vh, 1vh))');
  });
});
