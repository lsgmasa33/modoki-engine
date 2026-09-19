/** `/api/prefab-member-paths` (#1437 P3-a): after an applied move re-parents a prefab row, every OTHER file
 *  that uses the prefab gets its stored member refs re-pointed — through the real handler, on real files.
 *  What the repair computes is pinned against the loader in remintPrefabMemberRefs.test.ts; this covers what
 *  the ROUTE decides: what it writes, what it marks as the editor's own write, and what it leaves alone. */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { handleBackendRequest, type BackendContext } from '../../plugins/backend/editorBackendRouter';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';
import { deriveMemberGuid } from '../../packages/modoki/src/runtime/core/assetRefRules';

const DOOR = 'aaaaaaaa-0000-4000-8000-0000000001d1';
const HOUSE = 'aaaaaaaa-0000-4000-8000-0000000001d2';
const ROOT = 'bbbbbbbb-0000-4000-8000-0000000001d1';
const UI = 'bbbbbbbb-0000-4000-8000-0000000001d2';

const row = (localId: number, name: string, parentId: number, extra: Record<string, unknown> = {}) => ({
  localId, ...extra, traits: { EntityAttributes: { name, parentId, guid: '' }, Transform: { x: 0, y: 0, z: 0 } },
});
const bind = (target: string) => ({ UIAction: { bindings: [{ event: 'click', action: 'noop', target }] } });
/** Door with Handle (3) under `handleParent`. */
const door = (handleParent: number) => ({ id: DOOR, version: 4, name: 'Door', rootLocalId: 1, entities: [row(1, 'DoorRoot', 0), row(2, 'Frame', 1), row(3, 'Handle', handleParent)] });
const house = { id: HOUSE, version: 4, name: 'House', rootLocalId: 1, entities: [
  { ...row(1, 'HouseRoot', 0), traits: { ...row(1, 'HouseRoot', 0).traits, ...bind('@member:2.2.3') } }, row(2, 'Door', 1, { prefab: DOOR }),
] };
const OLD_HANDLE = deriveMemberGuid(ROOT, [2, 3]);
const NEW_HANDLE = deriveMemberGuid(ROOT, [3]);
const scene = { id: 'cccccccc-0000-4000-8000-0000000001d1', version: 15, name: 'S', resources: [], entities: [
  { id: 1, prefab: DOOR, guid: ROOT, traits: { EntityAttributes: { name: 'DoorRoot', parentId: 0 }, Transform: { x: 0, y: 0, z: 0 } } },
  { id: 2, traits: { EntityAttributes: { name: 'Ui', parentId: 0, guid: UI }, ...bind(OLD_HANDLE) } },
] };

type Holds = { path: string; registry: string }[];
function setup(answer: 'clear' | Holds | 'silent') {
  const dir = makeScratchDir('modoki-member-paths-');
  const files: Record<string, unknown> = { '/door.prefab.json': door(1), '/house.prefab.json': house, '/s.scene.json': scene };
  for (const [p, doc] of Object.entries(files)) fs.writeFileSync(path.join(dir, p), JSON.stringify(doc, null, 2) + '\n');
  const marked: string[] = [];
  const ctx = {
    projectRoot: os.tmpdir(),
    resolveAssetPath: (p: string) => path.join(dir, p),
    getManifest: () => ({ version: 2, folders: [], assets: [
      { path: '/door.prefab.json', type: 'prefab', guid: DOOR },
      { path: '/house.prefab.json', type: 'prefab', guid: HOUSE },
      { path: '/s.scene.json', type: 'scene' },
    ] }),
    markEditorWrite: (abs: string) => { marked.push(path.basename(abs)); },
    requestBrowser: async (op: string, params: unknown) => {
      if (op !== 'resolve-unsaved' || answer === 'silent') throw new Error('timeout');
      return { ok: true, holds: answer === 'clear' ? [] : answer, discarded: [], covers: (params as { registries?: string[] }).registries ?? [] };
    },
  } as unknown as BackendContext;
  const read = (p: string) => fs.readFileSync(path.join(dir, p), 'utf-8');
  const post = (body: unknown) => handleBackendRequest(ctx, { method: 'POST', urlPath: '/api/prefab-member-paths', query: new URLSearchParams(), body });
  return { read, post, marked };
}
type Reply = { kind: string; status?: number; body: { rewritten?: string[]; held?: string[] } };

describe('/api/prefab-member-paths (#1437 P3-a)', () => {
  it('rewrites each file that uses the prefab, as the editor\'s own write, and nothing else', async () => {
    const { read, post, marked } = setup('clear');
    const doorBytes = read('/door.prefab.json');
    const r = await post({ prefab: DOOR, before: door(2) }) as Reply;
    expect(r.body.rewritten!.sort()).toEqual(['/house.prefab.json', '/s.scene.json']);
    expect(read('/s.scene.json')).toContain(NEW_HANDLE);
    expect(read('/s.scene.json')).not.toContain(OLD_HANDLE);
    expect(read('/house.prefab.json')).toContain('"@member:2.3"');
    expect(read('/door.prefab.json')).toBe(doorBytes);
    // Unmarked, the watcher would hot-reload the open scene under its live edits. Mutation: drop markEditorWrite.
    expect(marked.sort()).toEqual(['house.prefab.json', 's.scene.json']);
  });

  // Mutation: drop the `held.has(key)` skip.
  it('leaves a file an asset view holds unsaved, and names it', async () => {
    const { read, post } = setup([{ path: '/house.prefab.json', registry: 'dirtyAsset' }]);
    const r = await post({ prefab: DOOR, before: door(2) }) as Reply;
    expect(r.body.rewritten).toEqual(['/s.scene.json']);
    expect(r.body.held).toEqual(['/house.prefab.json']);
    expect(read('/house.prefab.json')).toContain('"@member:2.2.3"');
  });

  // "Could not look" is not "nothing held". Mutation: treat `unknown` as clear.
  it('writes nothing when the editor cannot say what it holds', async () => {
    const { read, post } = setup('silent');
    const r = await post({ prefab: DOOR, before: door(2) }) as Reply;
    expect(r.status).toBe(503);
    expect(read('/s.scene.json')).toContain(OLD_HANDLE);
  });

  it('refuses a request without a prefab guid and document', async () => {
    const { post } = setup('clear');
    expect(((await post({ prefab: 'door.prefab.json', before: door(2) })) as Reply).status).toBe(400);
    expect(((await post({ prefab: DOOR })) as Reply).status).toBe(400);
  });
});
