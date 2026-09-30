/** `/api/scene-mutate` applies its ops ONE BY ONE, and a call where some applied and some failed answers PARTIAL
 *  (#1910) — on the file path, where the applied ops are already on disk, and on the live path alike.
 *
 *  It used to answer the failing op's own code (`NOT_FOUND`), and a caller reading `ok:false` + NOT_FOUND assumes
 *  nothing happened: it fixes the ref, resends the whole list, and applies the first ops twice. The per-op contract
 *  itself is deliberate (docs/mcp-tool-conventions.md) and is pinned in `applySceneOpsLive.test.ts`; this pins the
 *  VERDICT. Each case names the mutation that turns it red. */

import { describe, it, expect, vi, afterAll } from 'vitest';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { handleBackendRequest, type BackendContext, type Manifest } from '../../plugins/backend/editorBackendRouter';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';

const TMP = makeScratchDir('modoki-partial-route-');
afterAll(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

type Live = Record<string, unknown> | undefined;
/** An editor that answers and holds nothing unsaved. With `live`, it has THIS scene open, so the route goes live and
 *  `apply-scene-ops` answers `live`; without it, a different scene is open and the route edits the file. */
function makeCtx(scenePath: string, live?: Live): BackendContext {
  return {
    projectRoot: os.tmpdir(),
    resolveAssetPath: (p: string) => p,
    absToAssetUrl: (p: string) => p,
    firstRootDir: () => null,
    getManifest: () => ({ version: 2, assets: [] }) as Manifest,
    rebuildManifest: () => ({ version: 2, assets: [] }) as Manifest,
    markEditorWrite: () => {},
    requestBrowser: vi.fn(async (op: string, params?: unknown) => {
      if (op === 'resolve-unsaved') return { ok: true, holds: [], discarded: [], covers: (params as { registries?: string[] })?.registries ?? [] };
      if (op === 'apply-scene-ops') return live;
      return { playState: 'stopped', runMode: 'stopped', scenePath: live ? scenePath : '/elsewhere.scene.json' };
    }),
    getSchema: () => undefined,
    invalidateProjectConfig: () => {},
  } as unknown as BackendContext;
}
const post = async (body: unknown, ctx: BackendContext) =>
  (await handleBackendRequest(ctx, { method: 'POST', urlPath: '/api/scene-mutate', query: new URLSearchParams(), body })) as unknown as { body: Body };

let seq = 0;
function tempScene(): string {
  const p = path.join(TMP, `partial-${seq++}.json`);
  fs.writeFileSync(p, JSON.stringify({ version: 13, entities: [{ name: 'A', traits: { EntityAttributes: { name: 'A', guid: 'g-a', parentId: 0 }, Transform: { x: 0 } } }] }));
  return p;
}
const onDisk = (p: string) => JSON.parse(fs.readFileSync(p, 'utf8')) as { entities: { name: string; traits: { Transform?: { x: number } } }[] };

type Body = {
  ok: boolean; changed: number; errors: string[]; code?: string; error?: string; options?: string[];
  appliedOps?: number[]; failedOps?: number[]; failedCode?: string; saved?: boolean; mode?: string; created?: unknown[];
};
const setX = (guid: string, x: number) => ({ op: 'setTrait', entity: { guid }, trait: 'Transform', fields: { x } });

describe('/api/scene-mutate — a mixed op list is PARTIAL (#1910)', () => {
  // Mutation: drop `...(partial ?? {})` from the file-direct reply — the code is NOT_FOUND and no op is named.
  it('file path: the applied op is WRITTEN, and the reply says PARTIAL and names which op applied and which failed', async () => {
    const p = tempScene();
    const r = await post({ path: p, ops: [setX('g-a', 7), setX('no-such-guid', 1)] }, makeCtx(p));
    const b = r.body;
    expect(b.ok).toBe(false);
    expect(b.code).toBe('PARTIAL');
    expect(b.changed).toBe(1);
    expect(b.appliedOps).toEqual([0]);
    expect(b.failedOps).toEqual([1]);
    expect(b.saved).toBe(true);
    expect(b.error).toMatch(/op\[0\] applied and op\[1\] failed/);
    expect(b.error).toMatch(/already WRITTEN to the scene file/);
    expect(b.error).toMatch(/Do NOT resend the whole list/);
    expect(b.options?.[0]).toMatch(/resend only the failed ops \(op\[1\]\)/);
    expect(b.options?.some((o) => o.includes('modoki_history'))).toBe(false); // nothing to undo on the file path
    // A live read cannot see a file write, so it is never offered as the check; the receipts are (close-out review).
    // Mutation: offer the live branch's options on both paths — get_scene_state appears here.
    expect(b.options?.some((o) => o.startsWith('modoki_get_scene_state'))).toBe(false);
    expect(b.options?.some((o) => o.includes('receipts'))).toBe(true);
    expect(b.error).toMatch(/modoki_get_scene_state will NOT show them/);
    // The failing op's own code survives beside PARTIAL. Mutation: drop `code: applyCode` from the file verdict call.
    expect(b.failedCode).toBe('NOT_FOUND');
    expect(onDisk(p).entities[0].traits.Transform!.x).toBe(7);
  });

  // The receipt that makes a retry of ONLY the failed ops possible for an add. Mutation: as above.
  it('file path: an addEntity before a failing op is PARTIAL and keeps its `created` receipt', async () => {
    const p = tempScene();
    const r = await post({ path: p, ops: [{ op: 'addEntity', name: 'New', traits: {} }, setX('no-such-guid', 1)] }, makeCtx(p));
    const b = r.body;
    expect(b.code).toBe('PARTIAL');
    expect(b.created).toHaveLength(1);
    expect(onDisk(p).entities.map((e) => e.name)).toEqual(['A', 'New']);
  });

  // The ACCEPT side: a call where every op failed changed nothing a retry could repeat, so it keeps its own code.
  // Mutation: make `partialApplyVerdict` fire on `errors.length > 0` alone — this answers PARTIAL.
  it('file path: every op failing is the failing op\'s own NOT_FOUND, with the file untouched', async () => {
    const p = tempScene();
    const before = fs.readFileSync(p, 'utf8');
    const b = (await post({ path: p, ops: [setX('no-such-guid', 1)] }, makeCtx(p))).body;
    expect(b.code).toBe('NOT_FOUND');
    expect(b.appliedOps).toBeUndefined();
    expect(b.mode).toBe('manual'); // the description promises `mode` on every reply; this branch omitted it
    expect(fs.readFileSync(p, 'utf8')).toBe(before);
  });

  // Mutation: drop the `...(partial ? …)` spread from the live reply.
  it('live path: PARTIAL, with the failing op\'s own options kept after the partial ones', async () => {
    const p = tempScene();
    const live = {
      changed: 1, errors: ['op[1] (setTrait): no LIVE entity'], warnings: [], unresolved: [{ guid: 'no-such-guid' }],
      code: 'NOT_FOUND', options: ['the ref\'s own remedy'], appliedOps: [0], failedOps: [1],
    };
    const b = (await post({ path: p, ops: [setX('g-a', 7), setX('no-such-guid', 1)] }, makeCtx(p, live))).body;
    expect(b.code).toBe('PARTIAL');
    expect(b.saved).toBe(false);
    expect(b.appliedOps).toEqual([0]);
    expect(b.failedOps).toEqual([1]);
    expect(b.error).toMatch(/in the LIVE world, as ONE undo step/);
    expect(b.options?.[0]).toMatch(/resend only the failed ops/);
    expect(b.options?.some((o) => o.includes('modoki_history'))).toBe(true);
    expect(b.failedCode).toBe('NOT_FOUND'); // passed through from the live reply's `code`
    expect(b.options?.at(-1)).toBe('the ref\'s own remedy');
  });

  // A renderer from before the op lists still gets the right CODE; only the op names are lost.
  // Mutation: decide `partialApplyVerdict` on `appliedOps.length` instead of `changed` — this answers NOT_FOUND.
  it('live path: a renderer that sends no op lists still answers PARTIAL, naming counts instead', async () => {
    const p = tempScene();
    const live = { changed: 1, errors: ['op[1] (setTrait): no LIVE entity'], warnings: [], unresolved: [], code: 'NOT_FOUND' };
    const b = (await post({ path: p, ops: [setX('g-a', 7), setX('no-such-guid', 1)] }, makeCtx(p, live))).body;
    expect(b.code).toBe('PARTIAL');
    expect(b.appliedOps).toBeUndefined();
    expect(b.error).toMatch(/1 op\(s\) applied and the ops named in `errors` failed/);
  });
});
