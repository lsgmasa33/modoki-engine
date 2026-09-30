/** `/api/validate-prefab` (`modoki_validate_prefab`) reads the NESTED prefabs the template-key check walks (#1876 L5).
 *
 *  The check asks the walk the derive mirrors, which needs every document a frame is expanded from; the route reads each
 *  one by guid through the manifest, as it reads the file itself. Without it, a key two documents give one frame (one
 *  guid for two nodes) went unreported, and the answer called the document clean. Mutation: the route calls
 *  `validatePrefabData(parsed.data)` with no reader — the repeat goes silent and only the "not checked" line is left. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { handleBackendRequest, type BackendContext, type Manifest } from '../../plugins/backend/editorBackendRouter';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';
import { relay } from './backendRelay';

let root = '';
beforeEach(() => { root = makeScratchDir('modoki-validate-nested-'); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const S = 'cccccccc-0000-4000-8000-000000018771';
const PN = 'cccccccc-0000-4000-8000-000000018772';
const O = 'cccccccc-0000-4000-8000-000000018773';
const row = (localId: number, name: string, parentId: number, nodeGuid: string, extra: Record<string, unknown> = {}) => ({
  localId, name, nodeGuid, ...extra, traits: { EntityAttributes: { name, parentId, guid: '' } },
});
const dup = (parentLocalId: number) => ({ parentLocalId, guid: '', key: 'k-dup', name: 'Dup', traits: { EntityAttributes: { name: 'Dup', parentId: 0 } }, children: [] });
// PN nests S at row A and adds a k-dup node into that S frame; O nests PN at row N and adds a k-dup node AT row A — the
// same frame, from another document.
const docs = {
  [S]: { id: S, version: 9, name: 'S', rootLocalId: 1, entities: [row(1, 'SR', 0, 'eeeeeeee-0000-4000-8000-000000018771'), row(2, 'SA', 1, 'eeeeeeee-0000-4000-8000-000000018772')] },
  [PN]: { id: PN, version: 9, name: 'PN', rootLocalId: 1, entities: [
    row(1, 'R', 0, 'eeeeeeee-0000-4000-8000-000000018773'), row(2, 'A', 1, 'eeeeeeee-0000-4000-8000-000000018774', { prefab: S, added: [dup(1)] }),
  ] },
  [O]: { id: O, version: 9, name: 'O', rootLocalId: 1, entities: [
    row(1, 'OR', 0, 'eeeeeeee-0000-4000-8000-000000018775'), row(2, 'N', 1, 'eeeeeeee-0000-4000-8000-000000018776', { prefab: PN, added: [dup(2)] }),
  ] },
};

function makeCtx(listed: string[]): BackendContext {
  for (const [guid, doc] of Object.entries(docs)) fs.writeFileSync(path.join(root, `${guid}.prefab.json`), JSON.stringify(doc));
  const manifest: Manifest = { version: 2, assets: listed.map((guid) => ({ path: `/${guid}.prefab.json`, type: 'prefab', guid })) };
  return {
    projectRoot: root,
    resolveAssetPath: (p: string) => path.join(root, p.replace(/^\//, '')),
    absToAssetUrl: (p: string) => p,
    firstRootDir: () => null,
    getManifest: () => manifest,
    rebuildManifest: () => manifest,
    markEditorWrite: () => {},
    requestBrowser: relay(),
    getSchema: () => undefined,
    invalidateProjectConfig: () => {},
  } as unknown as BackendContext;
}
const validate = (listed: string[]) =>
  handleBackendRequest(makeCtx(listed), { method: 'GET', urlPath: '/api/validate-prefab', query: new URLSearchParams({ path: `/${O}.prefab.json` }), body: undefined }) as
    Promise<{ status?: number; body: { ok?: boolean; warnings?: string[] } }>;

describe('/api/validate-prefab walks the nested prefabs through the manifest (#1876 L5)', () => {
  it('a key two documents give one frame is an ERROR in the answer', async () => {
    const r = await validate([S, PN, O]);
    expect(r.body.ok).toBe(false);
    expect(r.body.warnings?.filter((w) => w.startsWith('ERROR:'))).toEqual([expect.stringContaining('k-dup')]);
  });
  it('a nested prefab the manifest cannot name is said to be NOT checked, never passed as clean', async () => {
    const r = await validate([S, O]);
    expect(r.body.warnings).toEqual([expect.stringMatching(new RegExp(`not checked below nested prefab\\(s\\) ${PN}`))]);
  });
});
