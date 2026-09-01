/** lengthUnitWarning — the #529/#549 width/height-vs-min/max unit-mismatch heuristic.
 *  Fixtures below are the real authored shapes AS THEY WERE BEFORE #529 fixed them on `main`
 *  (Court's RulesClose/RulesLine4/RulesPanel/NarrationSkip/PlaytestRate_1/NarrationMore),
 *  inlined rather than read from the scene files at test time. #529 removed the offending
 *  size fields from RulesClose/RulesLine4, so the corpus itself no longer contains these
 *  shapes — they are retained as fixtures because they are the real-world SHAPE of the bug
 *  this heuristic exists to catch, not because the sweep would still find them today. */

import { describe, it, expect } from 'vitest';
import {
  findLengthUnitSuspects,
  formatLengthUnitWarning,
  lengthUnitWarningKey,
  SUSPICIOUS_PX_THRESHOLD,
  RELATIVE_LENGTH_UNITS,
} from '../../src/runtime/ui/lengthUnitWarning';

describe('findLengthUnitSuspects', () => {
  it('fires on both axes: Court RulesClose (no units authored — width/height % default, max* px default)', () => {
    const suspects = findLengthUnitSuspects({ width: 5.4, height: 5.4, maxWidth: 3.5, maxHeight: 3.5 });
    expect(suspects).toHaveLength(2);
    expect(suspects.map(s => s.constraintField).sort()).toEqual(['maxHeight', 'maxWidth']);
    for (const s of suspects) {
      expect(s.sizeUnit).toBe('%');
      expect(s.constraintUnit).toBe('px');
    }
  });

  it('fires on the height axis: Court RulesLine4', () => {
    const suspects = findLengthUnitSuspects({ height: 7.8, maxHeight: 5.1 });
    expect(suspects).toHaveLength(1);
    expect(suspects[0]).toMatchObject({ axis: 'height', constraintField: 'maxHeight', sizeValue: 7.8, constraintValue: 5.1 });
  });

  it('does not fire: Court RulesPanel (maxWidth 460 > threshold)', () => {
    expect(findLengthUnitSuspects({ width: 84, maxWidth: 460 })).toHaveLength(0);
  });

  it('does not fire: Court NarrationSkip (heightUnit explicit px; maxWidth 82 > threshold)', () => {
    const suspects = findLengthUnitSuspects({
      width: 14, widthUnit: 'vmin', height: 26, heightUnit: 'px', maxWidth: 82, maxHeight: 26,
    });
    expect(suspects).toHaveLength(0);
  });

  it('does not fire: Court PlaytestRate_1 (minWidth/minHeight 44 > threshold)', () => {
    const suspects = findLengthUnitSuspects({
      width: 13, widthUnit: 'vmin', height: 13, heightUnit: 'vmin', minWidth: 44, minHeight: 44,
    });
    expect(suspects).toHaveLength(0);
  });

  it('does not fire: Court NarrationMore (different axes — width vs minHeight)', () => {
    expect(findLengthUnitSuspects({ width: 100, minHeight: 18 })).toHaveLength(0);
  });

  it('does not fire when the min/max unit is explicitly relative', () => {
    expect(findLengthUnitSuspects({ height: 90, maxHeight: 3.2, maxHeightUnit: 'vh' })).toHaveLength(0);
  });

  it('does not fire when the size is zero on that axis', () => {
    expect(findLengthUnitSuspects({ maxWidth: 3.5 })).toHaveLength(0);
  });

  it('does not fire when the min/max value is zero (0 = none)', () => {
    expect(findLengthUnitSuspects({ width: 50, maxWidth: 0 })).toHaveLength(0);
  });

  it('does not fire when the size unit is itself px (both sides agree)', () => {
    expect(findLengthUnitSuspects({ width: 50, widthUnit: 'px', maxWidth: 10 })).toHaveLength(0);
  });

  it('threshold is exactly 20 (boundary): 20 fires, 21 does not', () => {
    expect(findLengthUnitSuspects({ width: 50, maxWidth: SUSPICIOUS_PX_THRESHOLD })).toHaveLength(1);
    expect(findLengthUnitSuspects({ width: 50, maxWidth: SUSPICIOUS_PX_THRESHOLD + 1 })).toHaveLength(0);
  });

  it('every relative unit triggers the size side of the check', () => {
    for (const unit of RELATIVE_LENGTH_UNITS) {
      expect(findLengthUnitSuspects({ width: 50, widthUnit: unit, maxWidth: 5 })).toHaveLength(1);
    }
  });
});

describe('formatLengthUnitWarning', () => {
  it('names the entity, both fields, both values with units, and what to do', () => {
    const [suspect] = findLengthUnitSuspects({ width: 5.4, maxWidth: 3.5 });
    const msg = formatLengthUnitWarning('RulesClose', suspect);
    expect(msg).toContain('RulesClose');
    expect(msg).toContain('width=5.4%');
    expect(msg).toContain('maxWidth=3.5px');
    expect(msg).toContain('Inspector');
  });
});

describe('lengthUnitWarningKey', () => {
  it('is the SAME key for the same entity/field/units even when the values differ — the drag case', () => {
    // A resize drag calls writeUIElement per pointermove, so sizeValue/constraintValue
    // change on every sample while the units stay fixed. The key must not change either,
    // or the dedupe guard fires hundreds of times across one drag gesture.
    const s1 = findLengthUnitSuspects({ width: 5.4, maxWidth: 3.5 })[0];
    const s2 = findLengthUnitSuspects({ width: 5.6, maxWidth: 3.9 })[0];
    expect(lengthUnitWarningKey(1, s1)).toBe(lengthUnitWarningKey(1, s2));
  });

  it('changes when the constraint unit changes, so a real fix re-warns', () => {
    // The suspect shape after a real fix (author sets maxWidthUnit to match width's '%')
    // no longer trips findLengthUnitSuspects at all — build both suspect shapes directly
    // to compare the keys in isolation from the firing logic.
    const s1 = findLengthUnitSuspects({ width: 5.4, maxWidth: 3.5 })[0];
    const fixed = { ...s1, constraintUnit: 'vh' };
    expect(lengthUnitWarningKey(1, s1)).not.toBe(lengthUnitWarningKey(1, fixed));
  });

  it('changes when the size unit changes', () => {
    const s1 = findLengthUnitSuspects({ width: 5.4, maxWidth: 3.5 })[0];
    const s2 = findLengthUnitSuspects({ width: 5.4, widthUnit: 'vmin', maxWidth: 3.5 })[0];
    expect(lengthUnitWarningKey(1, s1)).not.toBe(lengthUnitWarningKey(1, s2));
  });
});
