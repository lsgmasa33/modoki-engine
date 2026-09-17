/** `hit-regions`: an empty FILTERED read must not blame the surface (#1208 B-4 / C-5).
 *
 *  The op picks its hint from the list it is about to return, which the caller's `kind`/`provider`/
 *  `ids` filter has already narrowed. So a typo'd `kind` on a live, loaded board earned "the
 *  surface is not hit-testable right now (no level loaded, or a modal is swallowing input)": a
 *  confident wrong cause, and the one explanation a miss investigation would act on. One op serves
 *  `modoki_hit_regions` and `device_hit_regions`, so this covers both surfaces. */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { registerHitRegionProvider, collectHitRegionsReport } from '@modoki/engine/runtime';
import { runAgentOp } from '../../app/debug/agentBridge';

type Reply = { hint?: string; returnedCount: number; totalCount: number };

let unregister: (() => void) | undefined;
afterEach(() => { unregister?.(); unregister = undefined; });

function provideBoard(): void {
  unregister = registerHitRegionProvider('probe', () => [
    { id: 'probe:cell:0', kind: 'cell', provider: 'probe', shape: { type: 'circle', x: 10, y: 10, r: 5 } },
    { id: 'probe:tray:0', kind: 'tray', provider: 'probe', shape: { type: 'rect', x: 50, y: 50, w: 20, h: 20 } },
  ]);
}

describe('hit-regions empty-result hint', () => {
  it('a filter that matches nothing names the filter and the live kinds — not "not hit-testable"', async () => {
    provideBoard();
    const r = await runAgentOp('hit-regions', { kind: 'cel' }) as Reply;
    expect(r.returnedCount).toBe(0);
    expect(r.hint).not.toMatch(/not hit-testable/);
    expect(r.hint).toMatch(/kind=cel/);
    expect(r.hint).toMatch(/2 region\(s\) exist/);
    expect(r.hint).toMatch(/Live kinds there: \{cell, tray\}/);
  });

  it('an unknown provider is a spelling question, naming the registered providers', async () => {
    provideBoard();
    const r = await runAgentOp('hit-regions', { provider: 'prob' }) as Reply;
    expect(r.hint).toMatch(/No hit-region provider is named "prob"/);
    expect(r.hint).toMatch(/Registered: \{probe\}/);
  });

  it('a CORRECTLY named provider with no regions keeps the surface diagnosis, even when another provider has regions', async () => {
    // The first version of this fix asked "do any regions exist anywhere?", so an unloaded board
    // beside a HUD with one button was told to check its spelling (#1208 review, finding 1).
    const offBoard = registerHitRegionProvider('board', () => []);
    provideBoard();
    try {
      const r = await runAgentOp('hit-regions', { provider: 'board' }) as Reply;
      expect(r.hint).toMatch(/Provider "board" is registered but reported no regions/);
      expect(r.hint).not.toMatch(/spelling/);
      // …and a kind miss scoped to one provider lists THAT provider's kinds only.
      offBoard();
      const hud = registerHitRegionProvider('hud', () => [
        { id: 'hud:button:0', kind: 'button', provider: 'hud', shape: { type: 'rect', x: 0, y: 0, w: 10, h: 10 } },
      ]);
      try {
        const k = await runAgentOp('hit-regions', { provider: 'hud', kind: 'cell' }) as Reply;
        expect(k.hint).toMatch(/Live kinds there: \{button\}/);
        expect(k.hint).not.toMatch(/tray/);
      } finally { hud(); }
    } finally { offBoard(); }
  });

  it('an EMPTY ids array is a filter miss, not a surface diagnosis (device_hit_regions can send one)', async () => {
    provideBoard();
    const r = await runAgentOp('hit-regions', { ids: [] }) as Reply;
    expect(r.returnedCount).toBe(0);
    expect(r.hint).not.toMatch(/^Provider\(s\) .* registered but reported no regions/);
    expect(r.hint).toMatch(/No region matches the filter \(ids=\[\]\), but 2 region\(s\) exist/);
  });

  it('with no provider filter, a kind miss also names a provider that is registered but EMPTY', async () => {
    const offBoard = registerHitRegionProvider('board', () => []);
    provideBoard();
    try {
      const r = await runAgentOp('hit-regions', { kind: 'button' }) as Reply;
      expect(r.hint).toMatch(/Provider\(s\) \[board\] reported NO regions right now/);
      expect(r.hint).not.toMatch(/\[probe\] reported NO regions/);
    } finally { offBoard(); }
  });

  // #1214: a string `ids` used to answer — with SUBSTRING semantics (`"ball-12".includes(id)`) — and a
  // number threw inside each provider's try, so every provider was logged as failed. Both are the
  // caller's mistake and are refused before any provider runs. Reachable only schema-less.
  it.each([['probe:nope'], [5], [['ok', 7]]])('a schema-less non-array ids %j is refused, not answered', async (ids) => {
    let calls = 0;
    unregister = registerHitRegionProvider('probe', () => { calls++; return []; });
    const r = await runAgentOp('hit-regions', { ids }) as { ok?: boolean; code?: string; error?: string };
    expect(r).toMatchObject({ ok: false, code: 'REFUSED_BY_OP' });
    expect(r.error).toMatch(/ids must be an array of region id strings/);
    expect(calls).toBe(0);
  });

  it('ids:null still means "no ids" — only a present non-array is refused', async () => {
    provideBoard();
    const r = await runAgentOp('hit-regions', { ids: null }) as Reply;
    expect(r.totalCount).toBe(2);
  });

  it('a provider that THROWS is named, not diagnosed as an unloaded surface (#1214)', async () => {
    unregister = registerHitRegionProvider('board', () => { throw new Error('boom'); });
    const quiet = registerHitRegionProvider('hud', () => []);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const r = await runAgentOp('hit-regions', {}) as Reply & { failedProviders?: Array<{ provider: string; error: string }> };
      expect(r.failedProviders).toEqual([{ provider: 'board', error: 'boom' }]);
      expect(r.hint).toMatch(/\[board\] FAILED while reporting .* UNKNOWN, not absent/);
      expect(r.hint).toMatch(/\[hud\] registered but reported no regions/);
      expect(r.hint).not.toMatch(/\[board, hud\]/);
      const one = await runAgentOp('hit-regions', { provider: 'board' }) as Reply;
      expect(one.hint).toMatch(/FAILED/);
      expect(one.hint).not.toMatch(/not hit-testable/);
    } finally { quiet(); spy.mockRestore(); }
  });

  it('a provider that throws beside a live one is named in a kind miss too', async () => {
    provideBoard();
    const bad = registerHitRegionProvider('hud', () => { throw new Error('nope'); });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const r = await runAgentOp('hit-regions', { kind: 'button' }) as Reply;
      expect(r.hint).toMatch(/\[hud\] FAILED while reporting, so a kind only they draw is unknown/);
      expect(r.hint).not.toMatch(/\[hud\] reported NO regions/);
    } finally { bad(); spy.mockRestore(); }
  });

  it('the accept side: with NO regions at all, the surface diagnosis still fires', async () => {
    unregister = registerHitRegionProvider('probe', () => []);
    const bare = await runAgentOp('hit-regions', {}) as Reply;
    expect(bare.hint).toMatch(/not hit-testable/);
    // …and a filter over an empty surface is still the surface's fault, not the filter's.
    const filtered = await runAgentOp('hit-regions', { kind: 'cell' }) as Reply;
    expect(filtered.hint).toMatch(/not hit-testable/);
  });

  it('a filter that matches gives no empty-result hint', async () => {
    provideBoard();
    const r = await runAgentOp('hit-regions', { kind: 'cell' }) as Reply;
    expect(r.returnedCount).toBe(1);
    expect(r.hint ?? '').not.toMatch(/No region matches|not hit-testable/);
  });
});

describe('collectHitRegionsReport (#1214)', () => {
  it('a non-array ids throws BEFORE any provider runs, so no provider is blamed', () => {
    let calls = 0;
    unregister = registerHitRegionProvider('probe', () => { calls++; return []; });
    expect(() => collectHitRegionsReport({ ids: 'probe:0' as unknown as string[] })).toThrow(/ids must be an array/);
    expect(calls).toBe(0);
  });

  it('a provider returning a non-array is reported as failed, not as empty', () => {
    unregister = registerHitRegionProvider('probe', () => ({}) as unknown as []);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(collectHitRegionsReport().failed).toEqual([{ provider: 'probe', error: 'returned object, not an array' }]);
    } finally { spy.mockRestore(); }
  });
});
