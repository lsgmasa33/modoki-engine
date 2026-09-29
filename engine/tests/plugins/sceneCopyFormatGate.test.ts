/** A scene COPY re-mints every entity guid (`remintSceneEntityGuids`), and it refuses a scene this build cannot read
 *  rather than re-mint it — Duplicate, both imports on a collision, and Save As. Observed before the gate: a v99 scene
 *  duplicated `ok:true` with the entity it had in a shape this build does not know still sharing the original's guid,
 *  a versionless one was re-minted into a file no reader opens, and a merge-conflicted one was copied VERBATIM under
 *  the original's asset id and entity guids. Each case names the mutation that turns it red. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { handleBackendRequest, type BackendContext, type Manifest } from '../../plugins/backend/editorBackendRouter';
import { resolveAssetPath, absToAssetUrl, scanAllAssets, type AssetRoot } from '../../plugins/vite-asset-scanner';
import { MIN_READABLE_SCENE_FORMAT_VERSION, SCENE_FORMAT_VERSION } from '../../packages/modoki/src/runtime/core/version';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';

const ORIGINAL_ID = '11111111-1111-4111-8111-111111111111';
const UNUSED_ID = '22222222-2222-4222-8222-222222222222';
const ENTITY = '33333333-3333-4333-8333-333333333333';

let tmp = '';
let src = '';
let roots: AssetRoot[] = [];
let manifest: Manifest;

function makeCtx(): BackendContext {
  return {
    projectRoot: tmp,
    editorRoot: tmp,
    resolveAssetPath: (p: string) => resolveAssetPath(p, roots),
    absToAssetUrl: (abs: string, opts?: { onDisk?: boolean }) => absToAssetUrl(abs, roots, opts),
    firstRootDir: () => null,
    getManifest: () => manifest,
    rebuildManifest: () => (manifest = { version: 2, assets: scanAllAssets(roots) } as unknown as Manifest),
    // An editor that answers, is stopped and holds nothing unsaved — so Duplicate's unsaved gate lets it through.
    requestBrowser: vi.fn(async (op: string, params?: unknown) => (
      op === 'resolve-unsaved'
        ? { ok: true, holds: [], discarded: [], covers: (params as { registries?: string[] })?.registries ?? [] }
        : { playState: 'stopped' }
    )),
    getSchema: () => undefined,
    markEditorWrite: () => {},
    ssrLoadModule: async () => ({}),
    invalidateProjectConfig: () => {},
  } as unknown as BackendContext;
}

type Reply = { status?: number; body: Record<string, unknown> };
const post = async (urlPath: string, body: unknown) =>
  (await handleBackendRequest(makeCtx(), { method: 'POST', urlPath, query: new URLSearchParams(), body })) as Reply;
const writeAt = (dir: string, rel: string, content: string) => {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
};
/** A one-entity scene under `id`, stamped `version` (omitted when undefined). */
const scene = (version: unknown, id = ORIGINAL_ID) => JSON.stringify({
  id, ...(version === undefined ? {} : { version }),
  entities: [{ name: 'A', traits: { EntityAttributes: { name: 'A', guid: ENTITY } } }],
});
const MERGE_CONFLICTED = `{"id": "${ORIGINAL_ID}", "version": ${SCENE_FORMAT_VERSION},\n<<<<<<< HEAD\n"entities": []\n}`;

const REFUSED = [
  ['too old', scene(MIN_READABLE_SCENE_FORMAT_VERSION - 1), 'scene-format-too-old', /format version \d+.*reads scenes from format version/],
  ['versionless', scene(undefined), 'scene-format-too-old', /no format version/],
  ['too new', scene(SCENE_FORMAT_VERSION + 1), 'scene-format-too-new', /newer than this engine supports/],
  ['non-numeric-version', scene(String(SCENE_FORMAT_VERSION)), 'scene-format-unreadable', /format version is unreadable \(non-numeric-version\)/],
  // Mutation: `withFreshJsonIdentity` back to `return null` on a parse failure for a scene — copied verbatim, 200.
  ['unparsable', MERGE_CONFLICTED, 'scene-format-unreadable', /not valid JSON/],
  // Mutation: drop the `if (isScene) assertSceneFormatReadable(json)` in the non-object branch — copied verbatim, 200.
  ['non-object', '[1, 2]', 'scene-format-unreadable', /format version is unreadable \(not-an-object\)/],
] as const;

beforeEach(() => {
  tmp = makeScratchDir('modoki-scene-copy-gate-');
  src = makeScratchDir('modoki-scene-copy-gate-src-');
  roots = [{ urlPrefix: '/assets', absDir: tmp }];
  // The original an import collides with, at a version this build reads.
  writeAt(tmp, 'zoo/Level.scene.json', scene(SCENE_FORMAT_VERSION));
  fs.mkdirSync(path.join(tmp, 'imp'));
  manifest = { version: 2, assets: scanAllAssets(roots) } as unknown as Manifest;
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(src, { recursive: true, force: true });
});

describe('/api/duplicate-asset refuses a scene it cannot read', () => {
  // Mutation (the four version rows): delete `assertSceneFormatReadable(scene)` at the top of
  // `remintSceneEntityGuids` — each is re-minted and written, 200. Mutation (every row): drop the route's
  // `SceneFormatRefusedError` catch — a 500 with no code. Mutation (the folder assertion): make the destination
  // folder before `withFreshJsonIdentity` runs again — the refused copy leaves an empty folder behind.
  it.each(REFUSED)('a %s scene is refused, and nothing is written', async (_label, text, reason, message) => {
    const from = writeAt(tmp, 'lvl/Src.scene.json', text);
    const r = await post('/api/duplicate-asset', { from: '/assets/lvl/Src.scene.json', to: '/assets/fresh/Copy.scene.json' });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ ok: false, code: 'REFUSED_BY_OP', reason });
    expect(r.body.error).toMatch(message);
    expect(r.body.error).toMatch(/^duplicate-asset refused \/assets\/lvl\/Src\.scene\.json: .*nothing was written\.$/s);
    // Mutation: drop the `Scene not loaded: ` strip in `sceneCopyRefusal` — a copy refusal claims a load that never ran.
    expect(r.body.error).not.toMatch(/Scene not loaded/);
    expect(fs.existsSync(path.join(tmp, 'fresh')), 'a refused copy made its destination folder').toBe(false);
    expect(fs.readFileSync(from, 'utf-8')).toBe(text);
  });

  // Accept side, both edges of the readable range. Mutations: the gate's floor one higher
  // (`minReadable: MIN_READABLE_SCENE_FORMAT_VERSION + 1`) — only the oldest-readable row goes red; its ceiling one
  // lower (`SCENE_FORMAT_VERSION - 1`) — only the current row goes red. The refusals above stay green under both.
  it.each([
    ['the oldest readable', MIN_READABLE_SCENE_FORMAT_VERSION],
    ['the current', SCENE_FORMAT_VERSION],
  ])('%s version is copied under fresh identities', async (_label, version) => {
    writeAt(tmp, 'lvl/Src.scene.json', scene(version));
    const r = await post('/api/duplicate-asset', { from: '/assets/lvl/Src.scene.json', to: '/assets/fresh/Copy.scene.json' });
    expect(r.body).toMatchObject({ ok: true });
    const copy = JSON.parse(fs.readFileSync(path.join(tmp, 'fresh/Copy.scene.json'), 'utf-8'));
    expect(copy.id).toBe(r.body.guid);
    expect(copy.id).not.toBe(ORIGINAL_ID);
    expect(copy.version).toBe(version);
    expect(copy.entities[0].traits.EntityAttributes.guid).not.toBe(ENTITY);
  });
});

describe('an import that must re-mint a scene refuses one it cannot read', () => {
  // Mutation: drop `/api/import-file`'s `SceneFormatRefusedError` catch — a 500 with no code.
  it('/api/import-file: a too-new scene colliding with a project asset is refused, and nothing lands', async () => {
    const from = writeAt(src, 'Level.scene.json', scene(SCENE_FORMAT_VERSION + 1));
    const r = await post('/api/import-file', { srcPath: from, destFolder: '/assets/imp', reimport: false });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ ok: false, code: 'REFUSED_BY_OP', reason: 'scene-format-too-new' });
    expect(r.body.error).toMatch(/^import-file refused .*Level\.scene\.json: .*nothing was written\.$/s);
    expect(fs.readdirSync(path.join(tmp, 'imp'))).toEqual([]);
  });

  // An unparsable scene cannot say whether it collides, and as it came it lands under the original's asset id. Mutation:
  // `importedAssetBytes` back to `return { bytes }` on a parse failure for a scene — both routes answer 200 and write it.
  it.each([
    ['/api/import-file', async () => post('/api/import-file', { srcPath: writeAt(src, 'Level.scene.json', MERGE_CONFLICTED), destFolder: '/assets/imp', reimport: false })],
    ['/api/import-identity', async () => post('/api/import-identity', { path: '/assets/imp/Level.scene.json', content: Buffer.from(MERGE_CONFLICTED).toString('base64') })],
  ])('%s: an unparsable scene is refused, not written as it came', async (_route, call) => {
    const r = await call();
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ ok: false, code: 'REFUSED_BY_OP', reason: 'scene-format-unreadable' });
    expect(r.body.error).toMatch(/not valid JSON/);
    expect(r.body.content).toBeUndefined();
    // import-identity writes nothing either way — only import-file's empty folder is evidence.
    if (_route === '/api/import-file') expect(fs.readdirSync(path.join(tmp, 'imp'))).toEqual([]);
  });

  // KEEP SIDE of the one above: only a SCENE is refused. Mutation: throw on every parse failure — this goes red.
  it('an unparsable non-scene JSON asset is still imported as it came', async () => {
    const bytes = '{"id": "x",\n<<<<<<< HEAD\n}';
    const from = writeAt(src, 'Broken.prefab.json', bytes);
    const r = await post('/api/import-file', { srcPath: from, destFolder: '/assets/imp', reimport: false });
    expect(fs.readFileSync(path.join(tmp, 'imp/Broken.prefab.json'), 'utf-8')).toBe(bytes);
    expect(r.body.reason).toBeUndefined();
  });

  // Mutation: make the destination folder before `importIdentity` runs again — the refusal leaves `fresh/deeper` behind.
  it('/api/import-file: a refused import into a folder that does not exist yet does not make it', async () => {
    const from = writeAt(src, 'Level.scene.json', scene(SCENE_FORMAT_VERSION + 1));
    const r = await post('/api/import-file', { srcPath: from, destFolder: '/assets/fresh/deeper', reimport: false });
    expect(r.status).toBe(409);
    expect(fs.existsSync(path.join(tmp, 'fresh'))).toBe(false);
  });

  // The Assets panel's half. Mutation: drop `/api/import-identity`'s `SceneFormatRefusedError` catch — a 500.
  it('/api/import-identity: the same colliding too-new scene is refused', async () => {
    const content = Buffer.from(scene(SCENE_FORMAT_VERSION + 1)).toString('base64');
    const r = await post('/api/import-identity', { path: '/assets/imp/Level.scene.json', content });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ ok: false, code: 'REFUSED_BY_OP', reason: 'scene-format-too-new' });
    expect(r.body.content).toBeUndefined();
  });

  // KEEP SIDE: an import that keeps its own id re-mints nothing, so the gate has nothing to refuse — the file lands
  // byte for byte and is refused when something LOADS it, like any other scene on disk. Mutation: gate every scene
  // import up front (`assertSceneFormatReadable` at the top of `importedAssetBytes`) — this goes red.
  it('a too-new scene under an id no asset holds is imported as it came', async () => {
    const bytes = scene(SCENE_FORMAT_VERSION + 1, UNUSED_ID);
    const from = writeAt(src, 'Future.scene.json', bytes);
    const r = await post('/api/import-file', { srcPath: from, destFolder: '/assets/imp', reimport: false });
    expect(r.body).toMatchObject({ ok: true, guid: UNUSED_ID });
    expect(fs.readFileSync(path.join(tmp, 'imp/Future.scene.json'), 'utf-8')).toBe(bytes);
  });
});

// The client stamps the current version on what it sends, so this is the backstop for a caller that does not.
// Mutation: drop `/api/scene-save-as`'s `SceneFormatRefusedError` catch — a 500 with no code.
it('/api/scene-save-as refuses a too-new scene, and writes nothing', async () => {
  const r = await post('/api/scene-save-as', { path: '/assets/lvl/Saved.scene.json', content: scene(SCENE_FORMAT_VERSION + 1) });
  expect(r.status).toBe(409);
  expect(r.body).toMatchObject({ ok: false, code: 'REFUSED_BY_OP', reason: 'scene-format-too-new' });
  expect(fs.existsSync(path.join(tmp, 'lvl/Saved.scene.json'))).toBe(false);
});

// The spread into `{ ...scene, id }` makes any non-object an object with no version, which the gate calls `too-old`
// ("probably written by hand"). Mutation: drop the route's non-object `assertSceneFormatReadable` — each answers too-old.
it.each([['an array', '[1, 2]'], ['null', 'null'], ['a string', '"x"']])('/api/scene-save-as refuses %s as unreadable', async (_label, content) => {
  const r = await post('/api/scene-save-as', { path: '/assets/lvl/Saved.scene.json', content });
  expect(r.status).toBe(409);
  expect(r.body).toMatchObject({ ok: false, reason: 'scene-format-unreadable' });
  expect(r.body.error).toMatch(/not-an-object/);
  expect(fs.existsSync(path.join(tmp, 'lvl/Saved.scene.json'))).toBe(false);
});
