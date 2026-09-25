/** `tools/shared/filterDisclosure.ts` (#1214) and the two device tools that could not use a renderer
 *  op to disclose: `device_console_logs` (the app now reports the whole ring) and `device_native_logs`
 *  (the filter runs where the lines are read, so it can only name the filter). */

import { describe, it, expect, afterEach } from 'vitest';
import { describeFilter, emptyFilterHint, histogram, liveSet } from '../../tools/shared/filterDisclosure';
import { loadDeviceSurface, deviceReply, type DeviceSurface } from './deviceSurface';
import { loadSurface } from './mcpSurface';

describe('filterDisclosure', () => {
  it('histogram counts by key', () => {
    expect(histogram(['a', 'b', 'a'], (x) => x)).toEqual({ a: 2, b: 1 });
  });

  it('histogram counts a key that shadows an Object.prototype member', () => {
    expect({ ...histogram(['constructor', 'toString', 'constructor'], (x) => x) }).toEqual({ constructor: 2, toString: 1 });
  });

  it('emptyFilterHint names what the unfiltered count counts', () => {
    expect(emptyFilterHint({ what: 'rect', filter: 'layer=2d', unfilteredCount: 3, unfilteredLabel: 'exist with no filter' }))
      .toMatch(/^no rect matches layer=2d, but 3 exist with no filter\./);
    expect(emptyFilterHint({ what: 'rect', filter: 'layer=2d', unfilteredCount: 0, unfilteredLabel: 'exist with no filter' }))
      .toMatch(/\(0 with no filter\)/);
  });

  it('describeFilter leaves out what did not filter', () => {
    expect(describeFilter({ name: 'P', id: undefined, where: '', ids: [], guids: ['a', 'b'], n: 0 })).toBe('name=P, guids=[a,b], n=0');
  });

  it('liveSet is distinct, sorted, capped, and blank-free', () => {
    expect(liveSet(['b', 'a', 'b', '', '  '])).toBe('{a, b}');
    expect(liveSet(['a', 'b', 'c'], 2)).toBe('{a, b, … +1 more}');
    expect(liveSet(['a', 'b'], 0)).toBe('{… +2 more}');
  });

  // An alphabetical cut would show the first twelve and hide the intended value.
  it('liveSet near= puts the closest value inside the cap', () => {
    const many = Array.from({ length: 40 }, (_, i) => `Aaa${String(i).padStart(2, '0')}`).concat(['Save As']);
    expect(liveSet(many, 3)).not.toMatch(/Save As/);
    expect(liveSet(many, 3, 'Sav As')).toMatch(/^\{Save As, /);
    // a substring hit outranks an edit-distance one
    expect(liveSet(['Plyr', 'PlayerOne'], 1, 'player')).toBe('{PlayerOne, … +1 more}');
  });

  it('emptyFilterHint tells the two readings apart', () => {
    expect(emptyFilterHint({ what: 'entity', filter: 'name=X', unfilteredCount: 0 }))
      .toBe('no entity matches name=X — and none exist to match (0 unfiltered), so the filter is not why this is empty.');
    const h = emptyFilterHint({ what: 'entity', filter: 'name=Plyer', unfilteredCount: 2, live: { name: ['Enemy', 'Player'], empty: [''] }, near: { name: 'Plyer' } });
    expect(h).toBe('no entity matches name=Plyer, but 2 exist unfiltered. Live now: name ∈ {Player, Enemy}. Check the spelling, or drop the filter.');
  });
});

describe('device_native_logs names an empty filter (#1214)', () => {
  let s: DeviceSurface | undefined;
  afterEach(() => { s?.restore(); s = undefined; });

  it('an empty filtered read does not say "No logs."', async () => {
    s = await loadDeviceSurface((req) => req.path === '/api/device/request' ? deviceReply([]) : undefined);
    const r = await s.call('device_native_logs', { filter: 'Modoki' });
    expect(r.isError).toBeFalsy();
    expect(s.text(r)).toMatch(/No line containing "Modoki" in this window/);
    expect(s.text(r)).not.toMatch(/No logs\./);
  });

  it('an unfiltered empty read still says "No logs."', async () => {
    s = await loadDeviceSurface((req) => req.path === '/api/device/request' ? deviceReply([]) : undefined);
    const r = await s.call('device_native_logs', {});
    expect(s.text(r)).toMatch(/No logs\./);
  });
});

describe('the journal tools send the cursor epoch (#1214 B-3)', () => {
  it.each([
    ['modoki_editor_journal', '/api/editor-journal?since=5&epoch=abc-123'],
    ['modoki_wait_for_edit', '/api/wait-for-edit?since=5&epoch=abc-123'],
  ])('%s', async (tool, path) => {
    const s = loadSurface();
    try {
      await s.call(tool, { since: 5, epoch: 'abc-123' });
      expect(s.last()?.path).toBe(path);
    } finally { s.restore(); }
  });
});
