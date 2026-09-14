/** `hit-regions`: an empty FILTERED read must not blame the surface (#1208 B-4 / C-5).
 *
 *  The op picks its hint from the list it is about to return, which the caller's `kind`/`provider`/
 *  `ids` filter has already narrowed. So a typo'd `kind` on a live, loaded board earned "the
 *  surface is not hit-testable right now (no level loaded, or a modal is swallowing input)": a
 *  confident wrong cause, and the one explanation a miss investigation would act on. One op serves
 *  `modoki_hit_regions` and `device_hit_regions`, so this covers both surfaces. */

import { describe, it, expect, afterEach } from 'vitest';
import { registerHitRegionProvider } from '@modoki/engine/runtime';
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

  it('a schema-less string `ids` (modoki.call / eval) is answered, not thrown', async () => {
    provideBoard();
    const r = await runAgentOp('hit-regions', { ids: 'probe:nope' }) as Reply;
    expect(r.hint).toMatch(/ids=probe:nope/);
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
