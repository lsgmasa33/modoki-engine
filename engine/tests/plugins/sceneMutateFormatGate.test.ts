/** `/api/scene-mutate`'s file-direct path runs the same format gate as every scene load
 *  (`assertSceneFormatReadable`), BEFORE it applies or writes anything. It edits the raw JSON, so
 *  without the gate a too-new file was edited through shapes this build does not know, and a
 *  too-old or unreadable one got an edit reported as saved to a file no reader will open.
 *  Each case names the mutation that turns it red. */

import { describe, it, expect, vi, afterAll } from 'vitest';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { handleBackendRequest, type BackendContext, type Manifest } from '../../plugins/backend/editorBackendRouter';
import { MIN_READABLE_SCENE_FORMAT_VERSION, SCENE_FORMAT_VERSION } from '../../packages/modoki/src/runtime/core/version';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';

const TMP = makeScratchDir('modoki-mutate-format-');
afterAll(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

function makeCtx(): BackendContext {
  return {
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
  } as unknown as BackendContext;
}

let seq = 0;
/** A one-entity scene file stamped `version` (omitted when undefined), or `raw` text verbatim. */
function tempScene(version: unknown, raw?: string): string {
  const p = path.join(TMP, `scene-${seq++}.json`);
  const scene: Record<string, unknown> = {
    entities: [{ name: 'A', traits: { EntityAttributes: { name: 'A', guid: 'g-a', parentId: 0 } } }],
  };
  if (version !== undefined) scene.version = version;
  fs.writeFileSync(p, raw ?? JSON.stringify(scene));
  return p;
}
const rename = (p: string) => handleBackendRequest(makeCtx(), {
  method: 'POST', urlPath: '/api/scene-mutate', query: new URLSearchParams(),
  body: { path: p, ops: [{ op: 'setTrait', entity: { guid: 'g-a' }, trait: 'EntityAttributes', fields: { name: 'Renamed' } }] },
}) as Promise<{ status?: number; body: { ok?: boolean; changed: number; code?: string; reason?: string; error?: string; errors: string[] } }>;

describe('/api/scene-mutate file-direct format gate', () => {
  // Mutation: delete the `assertSceneFormatReadable(scene)` call — the rename lands on disk, bytes differ.
  it.each([
    ['too old', MIN_READABLE_SCENE_FORMAT_VERSION - 1, 'scene-format-too-old', /format version \d+.*reads scenes from format version/],
    ['versionless', undefined, 'scene-format-too-old', /no format version/],
    ['too new', SCENE_FORMAT_VERSION + 1, 'scene-format-too-new', /newer than this engine supports/],
    ['non-numeric-version', String(SCENE_FORMAT_VERSION), 'scene-format-unreadable', /format version is unreadable/],
  ])('a %s scene is refused before anything is written', async (_label, version, reason, message) => {
    const p = tempScene(version);
    const before = fs.readFileSync(p);
    const r = await rename(p);
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ ok: false, changed: 0, code: 'REFUSED_BY_OP', reason });
    expect(r.body.error).toMatch(message);
    expect(r.body.error).toMatch(/nothing was written/);
    expect(fs.readFileSync(p).equals(before)).toBe(true);
  });

  // A merge-conflicted file is the commonest unreadable scene. Mutation: drop the SyntaxError catch
  // around the read — the route answers a bare 500 with no code.
  it('an unparsable scene is refused as unreadable, not a 500', async () => {
    const p = tempScene(undefined, `{"version": ${SCENE_FORMAT_VERSION},\n<<<<<<< HEAD\n"entities": []\n}`);
    const before = fs.readFileSync(p);
    const r = await rename(p);
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ ok: false, changed: 0, code: 'REFUSED_BY_OP', reason: 'scene-format-unreadable' });
    expect(r.body.error).toMatch(/not valid JSON/);
    expect(fs.readFileSync(p).equals(before)).toBe(true);
  });

  // Accept side, both edges of the readable range. Mutation: make the gate refuse everything
  // (`minReadable: SCENE_FORMAT_VERSION + 1`) — these go red while the refusals above stay green.
  it.each([
    ['the oldest readable', MIN_READABLE_SCENE_FORMAT_VERSION],
    ['the current', SCENE_FORMAT_VERSION],
  ])('%s version is edited and written', async (_label, version) => {
    const p = tempScene(version);
    const r = await rename(p);
    expect(r.body.errors).toEqual([]);
    expect(r.body.changed).toBe(1);
    const onDisk = JSON.parse(fs.readFileSync(p, 'utf8')) as { entities: { traits: { EntityAttributes: { name: string } } }[] };
    expect(onDisk.entities[0].traits.EntityAttributes.name).toBe('Renamed');
  });
});
