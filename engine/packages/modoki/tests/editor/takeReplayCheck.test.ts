/** The replay check (#1488): does the render's replay emit the game events the owner played?
 *  Each case is a shape measured on a real Court take — the async interleave, the layout float, the
 *  quantised gesture — or the divergence the check exists to catch. */

import { describe, it, expect } from 'vitest';
import { compareTakeEvents, samePayload, payloadDifferences, parseTake } from '../../src/editor/recorder/take';

const ev = (type: string, payload: unknown = null) => ({ type, payload });

describe('compareTakeEvents', () => {
  it('is unchecked for a take recorded before takes stored their events', () => {
    expect(compareTakeEvents(undefined, [ev('a')]).status).toBe('unchecked');
  });

  it('matches when each type\'s events agree, whatever the interleave ACROSS types', () => {
    // Measured: court.iap.trusted-clock is a network fetch and lands before or after
    // court.session.restored depending on timing.
    const played = [ev('iap.entitlements'), ev('court.session.restored', { level: 10 }), ev('court.iap.trusted-clock', { ok: true }), ev('court.place', { cell: 'a2' })];
    const replayed = [ev('iap.entitlements'), ev('court.iap.trusted-clock', { ok: true }), ev('court.session.restored', { level: 10 }), ev('court.place', { cell: 'a2' })];
    expect(compareTakeEvents(played, replayed)).toEqual({ status: 'matched', events: 4 });
  });

  it('skips engine events on both sides', () => {
    expect(compareTakeEvents([ev('a')], [ev('@audio'), ev('a'), ev('@scene-loaded')]).status).toBe('matched');
  });

  it('diverges when a type happened a different number of times — a second heart lost', () => {
    const r = compareTakeEvents([ev('court.heart.lost', { left: 2 })], [ev('court.heart.lost', { left: 2 }), ev('court.heart.lost', { left: 1 })]);
    expect(r).toMatchObject({ status: 'diverged', counts: [{ type: 'court.heart.lost', played: 1, replayed: 2 }] });
  });

  it('diverges when a played event never happens in the replay', () => {
    const r = compareTakeEvents([ev('court.place', { cell: 'a2' }), ev('court.win')], [ev('court.place', { cell: 'a2' })]);
    expect(r).toMatchObject({ status: 'diverged', counts: [{ type: 'court.win', played: 1, replayed: 0 }] });
  });

  it('keeps the order WITHIN a type: the same two placements swapped differ', () => {
    const r = compareTakeEvents([ev('p', { cell: 'a1' }), ev('p', { cell: 'b2' })], [ev('p', { cell: 'b2' }), ev('p', { cell: 'a1' })]);
    expect(r).toMatchObject({ status: 'differs', details: [{ type: 'p', occurrence: 1, fields: [{ path: 'cell', played: 'a1', replayed: 'b2' }] }] });
  });

  it('reports payload-only differences as `differs`, naming the fields — a quantised gesture', () => {
    const r = compareTakeEvents(
      [ev('court.gesture', { dragged: true, travelPx: 334, heldMs: 269 })],
      [ev('court.gesture', { dragged: true, travelPx: 312, heldMs: 267 })],
    );
    expect(r).toEqual({
      status: 'differs', expected: 1, replayed: 1, counts: [],
      details: [{ type: 'court.gesture', occurrence: 1, fields: [{ path: 'travelPx', played: 334, replayed: 312 }, { path: 'heldMs', played: 269, replayed: 267 }] }],
    });
  });
});

describe('samePayload', () => {
  it('ignores the last digits of a layout float — the editor lays out inside a CSS-scaled div', () => {
    // Measured, court.relayout: 269.4687568551177 in the editor, 269.46875 headless.
    expect(samePayload({ to: 269.4687568551177 }, { to: 269.46875 })).toBe(true);
  });
  it('still tells apart any difference a game count or cell could make', () => {
    expect(samePayload({ left: 2 }, { left: 1 })).toBe(false);
    expect(samePayload(0.5, 0.52)).toBe(false);
    // Integers exactly, however large: a score, a date-keyed puzzle id, an epoch.
    expect(samePayload(12345, 12346)).toBe(false);
    expect(samePayload(20260924, 20260925)).toBe(false);
    expect(samePayload(1790216204120, 1790216304120)).toBe(false);
    expect(samePayload('a2', 'a3')).toBe(false);
  });
  it('is structural: key order does not matter, a missing key does', () => {
    expect(samePayload({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe(true);
    expect(samePayload({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(samePayload([1], [1, 2])).toBe(false);
    expect(samePayload(null, undefined)).toBe(true);
  });
});

describe('payloadDifferences', () => {
  it('names nested leaves by dotted path, capped at five', () => {
    expect(payloadDifferences({ a: { b: 1 }, c: 2 }, { a: { b: 2 }, c: 2 })).toEqual([{ path: 'a.b', played: 1, replayed: 2 }]);
    const many = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`k${i}`, i]));
    const other = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`k${i}`, i + 10]));
    expect(payloadDifferences(many, other)).toHaveLength(5);
  });
});

describe('parseTake expectedEvents', () => {
  const base = {
    format: 'modoki-take', version: 1, game: 'g', scene: 's.scene.json', viewport: { width: 1, height: 1 }, seed: 1,
    duration: 1, epochMs: 1, timezone: 'UTC', locale: 'en', safeArea: { top: 0, right: 0, bottom: 0, left: 0 }, prefs: {}, events: [],
  };
  it('is optional', () => {
    expect(() => parseTake(base)).not.toThrow();
  });
  it('is checked when present', () => {
    expect(() => parseTake({ ...base, expectedEvents: [{ t: 0, type: 'a', payload: null }] })).not.toThrow();
    expect(() => parseTake({ ...base, expectedEvents: {} })).toThrow(/expectedEvents must be an array/);
    expect(() => parseTake({ ...base, expectedEvents: [{ t: -1, type: '' }] })).toThrow(/2 problem/);
  });
});
