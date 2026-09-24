/** The replay check (#1488): does the render's replay emit the game events the owner played?
 *  Each case is a shape measured on a real Court take — the async interleave, the layout float, the
 *  quantised gesture — or the divergence the check exists to catch. */

import { describe, it, expect } from 'vitest';
import { compareTakeEvents, replayEvents, samePayload, payloadDifferences, parseTake } from '../../src/editor/recorder/take';

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

// #1524: one Court take (court-20260924-112205) read `diverged` on every warm render, and a
// different verdict on each cold one, from a replay that did exactly what was played.
describe('app-lifetime events (#1524)', () => {
  const IAP = ['iap.entitlements', 'court.iap.products', 'court.iap.trusted-clock'];
  const played = [ev('court.session.restored', { placements: 1 }), ev('court.level', { id: 'L1' }), ev('court.place', { cell: 'a2' })];

  it('a replay that also boots the IAP catalogue and the server clock matches — the warm 3/3', () => {
    // The editor page booted IAP long before the Play press; every replay page boots it again.
    const replayed = [ev('iap.entitlements', { productIds: [] }), ev('court.iap.products', { summary: '6/6' }),
      ev('court.iap.trusted-clock', { reason: 'boot' }), ...played];
    expect(compareTakeEvents(played, replayed, IAP)).toEqual({ status: 'matched', events: 3, ignored: IAP });
  });

  it('skips them on the PLAYED side too — a take that caught one mid-play', () => {
    expect(compareTakeEvents([ev('court.iap.trusted-clock', { reason: 'grant' }), ...played], played, IAP))
      .toEqual({ status: 'matched', events: 3, ignored: ['court.iap.trusted-clock'] });
  });

  it('still diverges on an extra event that is NOT declared', () => {
    const r = compareTakeEvents(played, [...played, ev('court.heart.lost', { left: 2 })], IAP);
    expect(r).toMatchObject({ status: 'diverged', counts: [{ type: 'court.heart.lost', played: 0, replayed: 1 }] });
    expect(r).not.toHaveProperty('ignored');
  });
});

describe('replayEvents (#1524)', () => {
  const played = [ev('court.session.restored', { placements: 1 }), ev('court.level', { id: 'L1' }), ev('court.place', { cell: 'a2' })];
  // Measured on a cold render: the session restore landed in the last boot step, one step before
  // the first video frame, and the check over the frames alone called it missing.
  const captured = [
    { step: 78, type: 'court.session.restored', payload: { placements: 1 } },
    { step: 79, type: 'court.level', payload: { id: 'L1' } },
    { step: 400, type: 'court.place', payload: { cell: 'a2' } },
  ];

  it('checks events from the boot steps — the replay\'s Play press is the page boot', () => {
    expect(replayEvents(played, captured, 79, 30).replay).toEqual({ status: 'matched', events: 3 });
  });

  it('puts only frame-0-on events on the timeline, stamped with their video frame', () => {
    const { timeline } = replayEvents(played, captured, 79, 30);
    expect(timeline.map((e) => [e.type, e.videoFrame])).toEqual([['court.level', 0], ['court.place', 321]]);
    expect(timeline[1].seconds).toBeCloseTo(321 / 30);
  });

  it('passes the app-lifetime types through to the check', () => {
    const withIap = [{ step: 79, type: 'court.iap.products', payload: { summary: '6/6' } }, ...captured];
    expect(replayEvents(played, withIap, 79, 30, ['court.iap.products']).replay)
      .toEqual({ status: 'matched', events: 3, ignored: ['court.iap.products'] });
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
