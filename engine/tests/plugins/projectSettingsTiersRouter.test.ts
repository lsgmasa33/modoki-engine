/** Router-level tests for `POST /api/project-settings`'s **tiers completeness gate** — the check
 *  that refuses a partial `rendering.three.tiers` block instead of writing a tier that quietly
 *  stops clamping.
 *
 *  ⚠️ **WHY THIS FILE EXISTS: the gate shipped with no test at all** (#205 R4, close-out
 *  2026-08-12). It is the load-bearing half of that fix — `tiers` is in `REPLACE_WHOLESALE`, so a
 *  patch naming it is merged as a LEAF and any field the caller omitted is simply GONE from the
 *  file; `complete()` (qualityTier.ts) then fills the hole from `UNCLAMPED_OVERRIDES` at read
 *  time, so the tier silently renders unclamped while the route answers `ok: true`. Both failure
 *  directions were invisible to `npm test`: a gate that always refuses (Project Settings can save
 *  nothing) and a gate that always passes (the silent-wrong is back) were equally green.
 *
 *  The third test is the one that found a real defect: the gate checked TOP-LEVEL keys only, so a
 *  partial `postFX` walked straight through it — and an absent effect reads as ALLOWED. */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleBackendRequest, type BackendContext } from '../../plugins/backend/editorBackendRouter';
// Through the same specifier the ROUTE imports it by (a deep source path, not the package
// barrel) — the barrel resolves to a different module instance under this test config and the
// import reads back `undefined`, which would make `completeTier()` an empty object and every
// assertion below vacuous.
import { UNCLAMPED_OVERRIDES } from '../../packages/modoki/src/runtime/rendering/qualityTier';

const cleanup: string[] = [];
afterEach(() => { for (const r of cleanup.splice(0)) fs.rmSync(r, { recursive: true, force: true }); });

function makeProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-tiers-'));
  cleanup.push(root);
  fs.writeFileSync(path.join(root, 'project.config.json'), JSON.stringify({ app: { appId: 'com.x.y' } }));
  return root;
}

function makeCtx(projectRoot: string): BackendContext {
  return {
    projectRoot,
    resolveAssetPath: (p: string) => path.join(projectRoot, p.replace(/^\//, '')),
    absToAssetUrl: () => null,
    firstRootDir: () => null,
    // The route calls this after a successful write (the dev server drops its cached config).
    // Stubbed rather than omitted: without it the happy path 500s on a TypeError, and a test that
    // only ever asserts 400s would never notice — it would "pass" while proving the gate refuses
    // everything, which is one of the two failure directions this file exists to tell apart.
    invalidateProjectConfig: () => {},
  } as unknown as BackendContext;
}

const postSettings = (projectRoot: string, body: unknown) =>
  handleBackendRequest(makeCtx(projectRoot), {
    method: 'POST', urlPath: '/api/project-settings', query: new URLSearchParams(), body,
  }) as Promise<{ status?: number; body: Record<string, unknown> }>;

/** A COMPLETE tier block, built from the engine's own identity object so a field added to
 *  `TierRenderOverrides` cannot leave this fixture silently partial (which would turn every
 *  "accepts a complete block" assertion below into a vacuous pass).
 *
 *  Non-finite numbers are replaced with a finite one: `UNCLAMPED_OVERRIDES.pixelRatioCap` is
 *  `Infinity` (its identity), which `JSON.stringify` writes as `null` — and the route's own
 *  null-patch guard refuses that BEFORE the tiers gate, so the fixture would test the wrong
 *  check. No authored config can hold `Infinity` either, so a finite value is also the honest
 *  shape of the patch a real Project Settings save posts. */
const completeTier = (): Record<string, unknown> => {
  const walk = (o: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(o).map(([k, v]) => [
      k,
      typeof v === 'number' && !Number.isFinite(v) ? 2
        : (v !== null && typeof v === 'object' && !Array.isArray(v)) ? walk(v as Record<string, unknown>)
        : v,
    ]));
  return walk(UNCLAMPED_OVERRIDES as unknown as Record<string, unknown>);
};

const tiersPatch = (mid: Record<string, unknown>) => ({ rendering: { three: { tiers: { mid } } } });

describe('POST /api/project-settings — the tiers completeness gate', () => {
  it('accepts a COMPLETE tier block (the gate must not block ordinary saves)', async () => {
    const root = makeProject();
    const r = await postSettings(root, tiersPatch(completeTier()));
    expect({ status: r.status ?? 200, body: r.body }).toMatchObject({ status: 200 });
    const written = JSON.parse(fs.readFileSync(path.join(root, 'project.config.json'), 'utf8'));
    expect(written.rendering.three.tiers.mid).toBeDefined();
  });

  it('REFUSES a tier missing a top-level field, and names it, without writing', async () => {
    const root = makeProject();
    const partial = completeTier();
    delete partial.shadows;
    const r = await postSettings(root, tiersPatch(partial));
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toMatch(/complete block/);
    expect(String(r.body.error)).toMatch(/shadows/);
    // Nothing reached disk — a 400 that had already written would be worse than no gate.
    const written = JSON.parse(fs.readFileSync(path.join(root, 'project.config.json'), 'utf8'));
    expect(written.rendering).toBeUndefined();
  });

  it('REFUSES a tier whose postFX block is partial — an absent effect reads as ALLOWED', async () => {
    // ⚠️ THE DEFECT THIS PINS (found in close-out, fixed in the same commit): the gate listed
    // `Object.keys(UNCLAMPED_OVERRIDES)`, so `postFX` counted as present when only ONE effect was
    // in it. `complete()` merges the partial block over `ALL_POSTFX`, so dropping four effects
    // from a `low` tier switched all four back ON while the route answered ok:true. Revert
    // `requiredKeyPaths` to `Object.keys(...)` and this test — and only this one — goes green-fail.
    const root = makeProject();
    const partial = completeTier();
    partial.postFX = { npr: false };
    const r = await postSettings(root, tiersPatch(partial));
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toMatch(/postFX\.(ao|dof|bloom|vignette)/);
    const written = JSON.parse(fs.readFileSync(path.join(root, 'project.config.json'), 'utf8'));
    expect(written.rendering).toBeUndefined();
  });

  it('REFUSES a non-object tier value outright', async () => {
    const root = makeProject();
    const r = await postSettings(root, tiersPatch('low' as unknown as Record<string, unknown>));
    expect(r.status).toBe(400);
  });
});
