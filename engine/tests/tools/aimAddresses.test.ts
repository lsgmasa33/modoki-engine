/** The ONE rule for how many addresses an aim may give (#1556) — `tools/shared/aimAddresses.ts`.
 *  The route-level tests (inputRoutes, domResolve, deviceEntityAim) prove each surface CALLS it; this
 *  pins what counts as "given", which is where a false refusal or a silent pass would come from. */
import { describe, it, expect } from 'vitest';
import { aimAddresses, ambiguousAimMessage } from '../../tools/shared/aimAddresses';

describe('aimAddresses', () => {
  it('reads each of the four addresses', () => {
    expect(aimAddresses({ entity: { guid: 'g' } })).toEqual(['entity']);
    expect(aimAddresses({ selector: '#a' })).toEqual(['selector']);
    expect(aimAddresses({ label: 'Save' })).toEqual(['label']);
    expect(aimAddresses({ x: 1, y: 2 })).toEqual(['x,y']);
    expect(aimAddresses({ entity: { name: 'P' }, selector: '#a', label: 'L', x: 0, y: 0 }))
      .toEqual(['entity', 'selector', 'label', 'x,y']);
  });

  it('does NOT count what the resolvers have always read as absent — `{}`, `\'\'`, undefined', () => {
    // `{}` is what a conditional builder sends when it had nothing; refusing it beside a real selector
    // would fail a call that has always worked.
    expect(aimAddresses({ entity: {}, selector: '#a' })).toEqual(['selector']);
    expect(aimAddresses({ selector: '', x: 1, y: 1 })).toEqual(['x,y']);
    expect(aimAddresses({ entity: undefined, selector: undefined, x: undefined })).toEqual([]);
    expect(aimAddresses(undefined)).toEqual([]);
    expect(aimAddresses(null)).toEqual([]);
  });

  it('counts a LONE coordinate — the stray `x` beside a selector is what precedence used to drop', () => {
    expect(aimAddresses({ selector: '#a', x: 3 })).toEqual(['selector', 'x,y']);
    expect(aimAddresses({ entity: { id: 1 }, y: 0 })).toEqual(['entity', 'x,y']);
  });

  it('ignores wheel deltas and every other field — they are not an address', () => {
    expect(aimAddresses({ selector: '#a', deltaX: 1, deltaY: 2, dx: 3, dy: 4, allowOccluded: true } as never)).toEqual(['selector']);
  });
});

describe('ambiguousAimMessage', () => {
  it('is null for zero or one address — the accept side', () => {
    expect(ambiguousAimMessage([])).toBeNull();
    expect(ambiguousAimMessage(['entity'])).toBeNull();
  });

  it('names every address the call gave', () => {
    expect(ambiguousAimMessage(['entity', 'selector', 'x,y'])).toContain('entity AND selector AND {x,y}');
  });
});
