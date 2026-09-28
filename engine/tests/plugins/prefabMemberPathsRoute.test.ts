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
/** `nextLocalId` (#1774's mark) and a field no writer knows: the route carries the whole parsed document. */
const house = { id: HOUSE, version: 8, name: 'House', rootLocalId: 1, nextLocalId: 7, futureField: { kept: true }, entities: [
  { ...row(1, 'HouseRoot', 0), traits: { ...row(1, 'HouseRoot', 0).traits, ...bind('@member:2.2.3') } }, row(2, 'Door', 1, { prefab: DOOR }),
] };
const OLD_HANDLE = deriveMemberGuid(ROOT, [2, 3]);
const NEW_HANDLE = deriveMemberGuid(ROOT, [3]);
const scene = { id: 'cccccccc-0000-4000-8000-0000000001d1', version: 15, name: 'S', resources: [], entities: [
  { id: 1, prefab: DOOR, guid: ROOT, traits: { EntityAttributes: { name: 'DoorRoot', parentId: 0 }, Transform: { x: 0, y: 0, z: 0 } } },
  { id: 2, traits: { EntityAttributes: { name: 'Ui', parentId: 0, guid: UI }, ...bind(OLD_HANDLE) } },
] };

type Holds = { path: string; registry: string }[];
function setup(answer: 'clear' | Holds | 'silent', duringGate?: (dir: string) => void) {
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
      duringGate?.(dir);
      // Answers only for the registries it was asked about, as the renderer op does.
      const asked = (params as { registries?: string[] }).registries ?? [];
      return { ok: true, holds: answer === 'clear' ? [] : answer.filter((h) => asked.includes(h.registry)), discarded: [], covers: asked };
    },
  } as unknown as BackendContext;
  const read = (p: string) => fs.readFileSync(path.join(dir, p), 'utf-8');
  const post = (body: unknown) => handleBackendRequest(ctx, { method: 'POST', urlPath: '/api/prefab-member-paths', query: new URLSearchParams(), body });
  return { read, post, marked };
}
type Written = { path: string; type: string; guid?: string; text: string; prior: string };
type Reply = { kind: string; status?: number; body: { rewritten?: string[]; held?: string[]; changed?: string[]; written?: Written[] } };

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

  // #1751: the reply carries what the route wrote and what each file held before, so the client can take the
  // watcher's place. Mutation: drop `written` from the reply — the client has nothing to seat.
  it('returns each file it wrote, with the bytes it held before', async () => {
    const { read, post } = setup('clear');
    const priorHouse = read('/house.prefab.json');
    const r = await post({ prefab: DOOR, before: door(2) }) as Reply;
    const byPath = new Map(r.body.written!.map((w) => [w.path, w]));
    expect([...byPath.keys()].sort()).toEqual(['/house.prefab.json', '/s.scene.json']);
    expect(byPath.get('/house.prefab.json')).toMatchObject({ type: 'prefab', guid: HOUSE, prior: priorHouse, text: read('/house.prefab.json') });
    expect(byPath.get('/s.scene.json')).toMatchObject({ type: 'scene', text: read('/s.scene.json') });
  });

  // #1774's overlap: the rewrite never rebuilds a typed literal, so the mark and a field no writer knows survive.
  // Mutation: have planMemberPathRepair return `{ id, version, name, rootLocalId, entities }` for a prefab.
  it('keeps the localId mark and every field it does not know', async () => {
    const { read, post } = setup('clear');
    await post({ prefab: DOOR, before: door(2) });
    const doc = JSON.parse(read('/house.prefab.json'));
    expect(doc.nextLocalId).toBe(7);
    expect(doc.futureField).toEqual({ kept: true });
    expect(doc.version).toBe(8);
  });

  // #1784: the write is conditional on the text the plan read — a commit that landed during the renderer await is
  // not overwritten with the older bytes. Mutation: drop the re-read comparison — House gets the stale rewrite.
  it('leaves a file that changed while it waited on the editor, and names it', async () => {
    const landed = JSON.stringify({ ...house, name: 'House (saved meanwhile)' }, null, 2) + '\n';
    const { read, post } = setup('clear', (dir) => fs.writeFileSync(path.join(dir, 'house.prefab.json'), landed));
    const r = await post({ prefab: DOOR, before: door(2) }) as Reply;
    expect(read('/house.prefab.json')).toBe(landed);
    expect(r.body.changed).toEqual(['/house.prefab.json']);
    expect(r.body.rewritten).toEqual(['/s.scene.json']);
    expect(r.body.written!.map((w) => w.path)).toEqual(['/s.scene.json']);
  });

  // A pending base-scene edit parks one FIELD, not a document: its flush (`/api/scene-mutate` setBaseScene) re-reads
  // the file, so it lands on the repaired bytes. Holding the scene back for it left its refs dangling for good (#1751
  // close-out review). Mutation: add 'pendingBaseScene' to the gate's registries — the scene is left unrepaired.
  it('repairs a scene whose base-scene edit is pending — that edit is a field, not a document', async () => {
    const { read, post } = setup([{ path: '/s.scene.json', registry: 'pendingBaseScene' }]);
    const r = await post({ prefab: DOOR, before: door(2) }) as Reply;
    expect(r.body.held).toEqual([]);
    expect(read('/s.scene.json')).not.toContain(OLD_HANDLE);
  });

  it('refuses a request without a prefab guid and document', async () => {
    const { post } = setup('clear');
    expect(((await post({ prefab: 'door.prefab.json', before: door(2) })) as Reply).status).toBe(400);
    expect(((await post({ prefab: DOOR })) as Reply).status).toBe(400);
  });
});
