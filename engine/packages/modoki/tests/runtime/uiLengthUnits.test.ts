/** The UI length-unit vocabulary is ONE tuple and ONE table (#1064) — every resolver answers for
 *  every unit in them.
 *
 *  Before #1064 the vocabulary was a type plus nine hand-written copies kept in step by a docblock
 *  that named five, and the one it left out was `UIRenderer`, the PUBLISHER of the `--ui-*` vars.
 *  The compile-time half of the fix (`VIEWPORT_UNIT_AXIS` is a `Record` over the viewport units) makes
 *  a new unit fail to build until the table has it; these tests are the runtime half — each iterates
 *  the table rather than naming units, so a reader that stops consulting it (a switch creeping back,
 *  a hand-written subset) is caught for whichever unit it drops, including ones added later.
 *
 *  The viewport is deliberately NON-square and NON-proportional (vw ≠ vh, vmin ≠ vmax, and neither
 *  equals a px fallback of `value`), so a unit resolved through the wrong axis — `vmax` treated as
 *  `vmin`, the game bug docs/ui-system.md records — or not resolved at all reads differently. */

import { describe, it, expect } from 'vitest';
import {
  UI_LENGTH_UNITS, VIEWPORT_LENGTH_UNITS, VIEWPORT_UNIT_AXIS, isViewportLengthUnit, viewportUnitVar,
} from '../../src/runtime/traits/uiLength';
import { resolveLengthPx } from '../../src/runtime/ui/anchorLayout';
import { cssVal } from '../../src/runtime/ui/UINode';
import { applyAnchorStyle } from '../../src/runtime/ui/anchorCss';
import { computeMoveOffsets } from '../../src/editor/scene/uiResizeMath';
import { RELATIVE_LENGTH_UNITS } from '../../src/runtime/ui/lengthUnitWarning';
import { ptPerUnit } from '../helpers/tapTargetFloor';

const VP = { name: 'non-square 300x700', w: 300, h: 700 };
/** What each unit is a percentage of, restated INDEPENDENTLY of the table under test — a test that
 *  derived its expectation from `VIEWPORT_UNIT_AXIS` could not catch a wrong entry in it. */
const EXPECTED_AXIS: Record<string, number> = { vw: 300, vh: 700, vmin: 300, vmax: 700 };

describe('the unit vocabulary', () => {
  it('the viewport units are exactly the non-px, non-% members of the tuple', () => {
    expect([...VIEWPORT_LENGTH_UNITS].sort()).toEqual(UI_LENGTH_UNITS.filter((u) => u !== 'px' && u !== '%').sort());
  });

  it('every viewport unit resolves to the dimension it is a percentage of', () => {
    expect(Object.keys(EXPECTED_AXIS).sort()).toEqual([...VIEWPORT_LENGTH_UNITS].sort());
    for (const u of VIEWPORT_LENGTH_UNITS) expect(VIEWPORT_UNIT_AXIS[u](VP.w, VP.h), u).toBe(EXPECTED_AXIS[u]);
  });

  it('membership is an own-property check: a prototype name is not a viewport unit (#993)', () => {
    for (const name of ['constructor', 'toString', 'valueOf', '__proto__', 'hasOwnProperty']) {
      expect(isViewportLengthUnit(name), name).toBe(false);
    }
    expect(isViewportLengthUnit('px')).toBe(false);
    expect(isViewportLengthUnit('%')).toBe(false);
    expect(isViewportLengthUnit(undefined)).toBe(false);
  });

  it('RELATIVE_LENGTH_UNITS is every unit but px', () => {
    expect([...RELATIVE_LENGTH_UNITS].sort()).toEqual(UI_LENGTH_UNITS.filter((u) => u !== 'px').sort());
  });
});

describe('every reader answers for every viewport unit', () => {
  it.each(VIEWPORT_LENGTH_UNITS)('resolveLengthPx resolves %s against its own axis, not as px', (u) => {
    expect(resolveLengthPx(10, u, 999, VP.w, VP.h)).toBe(EXPECTED_AXIS[u] * 10 / 100);
  });

  it.each(VIEWPORT_LENGTH_UNITS)('cssVal emits %s through the var UIRenderer publishes', (u) => {
    expect(cssVal(10, u)).toBe(`calc(10 * var(${viewportUnitVar(u)}, 1${u}))`);
    expect(viewportUnitVar(u)).toBe(`--ui-${u}`);
  });

  it.each(VIEWPORT_LENGTH_UNITS)('applyAnchorStyle emits %s through its var at both reads (bare and term)', (u) => {
    const top = (anchor: 'top-left' | 'center') => {
      const style: Record<string, unknown> = {};
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      applyAnchorStyle(style as any, { anchor, top: 12, left: 0, topUnit: u, leftUnit: 'px' } as any);
      return String(style.top);
    };
    expect(top('top-left')).toBe(`calc(12 * var(--ui-${u}, 1${u}))`);
    expect(top('center')).toBe(`calc(50% + 12 * var(--ui-${u}, 1${u}))`);
  });

  it.each(VIEWPORT_LENGTH_UNITS)('the drag inverse turns a drag of 10%s-worth of px back into 10 %s', (u) => {
    const start = { anchor: 'top-left', top: 0, topUnit: 'px', left: 0, leftUnit: u, right: 0, rightUnit: 'px', bottom: 0, bottomUnit: 'px' };
    const px = EXPECTED_AXIS[u] * 10 / 100;
    const patch = computeMoveOffsets('move-x', start, px, 0, { width: 999, height: 999 }, { width: VP.w, height: VP.h });
    expect(patch.left).toBe(10);
  });

  it.each(VIEWPORT_LENGTH_UNITS)('the tap-target helper converts %s at its own axis', (u) => {
    expect(ptPerUnit(u, VP)).toBe(EXPECTED_AXIS[u] / 100);
  });
});
