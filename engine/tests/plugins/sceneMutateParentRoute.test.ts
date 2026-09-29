/** The `/api/scene-mutate` route hands `applyOps` what the file cannot say about itself (#1825): the ids it backfilled
 *  (stripped again before the write, so a parent named by one names nothing on disk), and the schema's resource traits.
 *  `sceneMutate.test.ts` covers the rule with those passed by hand; this covers the route passing them.
 *  Each case names the mutation that turns it red. */

import { describe, it, expect, vi, afterAll } from 'vitest';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { handleBackendRequest, type BackendContext, type Manifest } from '../../plugins/backend/editorBackendRouter';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';

const TMP = makeScratchDir('modoki-parent-route-');
afterAll(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

function makeCtx(over: Partial<BackendContext> = {}): BackendContext {
  const base = {
    projectRoot: os.tmpdir(),
    resolveAssetPath: (p: string) => p,
    absToAssetUrl: (p: string) => p,
    firstRootDir: () => null,
    getManifest: () => ({ version: 2, assets: [] }) as Manifest,
    rebuildManifest: () => ({ version: 2, assets: [] }) as Manifest,
    markEditorWrite: () => {},
    // An editor that answers, is stopped and holds nothing unsaved — so the route edits the file.
    requestBrowser: vi.fn(async (op: string, params?: unknown) => (
      op === 'resolve-unsaved'
        ? { ok: true, holds: [], discarded: [], covers: (params as { registries?: string[] })?.registries ?? [] }
        : { playState: 'stopped' }
    )),
    getSchema: () => undefined,
    invalidateProjectConfig: () => {},
  };
  return { ...base, ...over } as unknown as BackendContext;
}
const post = (urlPath: string, body: unknown, ctx: BackendContext) =>
  handleBackendRequest(ctx, { method: 'POST', urlPath, query: new URLSearchParams(), body });

let seq = 0;
/** A v13 scene file: NO entity ids, as Save All writes it. Config carries a resource trait. */
function tempScene(): string {
  const p = path.join(TMP, `parent-${seq++}.json`);
  const ent = (name: string, guid: string, extra: Record<string, unknown> = {}) =>
    ({ name, traits: { EntityAttributes: { name, guid, parentId: 0 }, ...extra } });
  fs.writeFileSync(p, JSON.stringify({ version: 13, entities: [ent('A', 'g-a'), ent('B', 'g-b'), ent('C', 'g-c'), ent('Config', 'g-cfg', { GameConfig: { speed: 1 } })] }));
  return p;
}
const parentOnDisk = (p: string, name: string) =>
  (JSON.parse(fs.readFileSync(p, 'utf8')) as { entities: { name: string; traits: { EntityAttributes: { parentId: unknown } } }[] })
    .entities.find((e) => e.name === name)!.traits.EntityAttributes.parentId;
type Reply = { body: { changed: number; errors: string[]; saved?: boolean } };

describe('/api/scene-mutate parent writes (#1825)', () => {
  // The route backfills ids 0..3; `2` is C's for the duration of the call and nothing afterwards. Mutation: drop
  // `syntheticIds: backfilledIds` from the route's applyOps call — B is stored with parentId 2, naming nothing.
  it('a numeric parent naming a backfilled id is refused, and the file is not written', async () => {
    const p = tempScene();
    const r = await post('/api/scene-mutate', { path: p, ops: [{ op: 'setTrait', entity: { guid: 'g-b' }, trait: 'EntityAttributes', fields: { parentId: 2 } }] }, makeCtx()) as Reply;
    expect(r.body.errors[0]).toMatch(/names no entity in this scene file/);
    expect(r.body.changed).toBe(0);
    expect(parentOnDisk(p, 'B')).toBe(0);
  });

  // Mutation: drop `resourceTraits` from the route's applyOps call — A goes under the resource.
  it('the schema\'s resource traits reach the rule: a resource parent is refused', async () => {
    const p = tempScene();
    const ctx = makeCtx({ getSchema: () => ({ traits: { GameConfig: { category: 'resource', fields: {} } } }) as never });
    const r = await post('/api/scene-mutate', { path: p, ops: [{ op: 'setTrait', entity: { guid: 'g-a' }, trait: 'EntityAttributes', fields: { parentId: 'g-cfg' } }] }, ctx) as Reply;
    expect(r.body.errors[0]).toMatch(/would put a resource entity into the hierarchy/);
    expect(parentOnDisk(p, 'A')).toBe(0);
    // Accept side: a plain parent by guid is written.
    const ok = await post('/api/scene-mutate', { path: p, ops: [{ op: 'setTrait', entity: { guid: 'g-a' }, trait: 'EntityAttributes', fields: { parentId: 'g-c' } }] }, ctx) as Reply;
    expect(ok.body.errors).toEqual([]);
    expect(parentOnDisk(p, 'A')).toBe('g-c');
  });
});
