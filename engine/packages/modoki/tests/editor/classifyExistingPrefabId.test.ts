/** classifyExistingPrefabId / classifyExistingDocumentId — what a caller about to OVERWRITE a
 *  document may conclude about the id it already carries.
 *
 *  Resolution order: asset-manifest guid (survives a file rewrite, offline) → the on-disk file's
 *  `id`. What changed in #1468 is the third answer. It used to be a single `undefined` covering
 *  "genuinely missing", "the server answered 500", "the bytes are corrupt" and "a newer build wrote
 *  it" — and every caller reads `undefined` as *first-time import* and mints a FRESH guid over a
 *  document whose bytes are still on disk, orphaning every scene that referenced the old one. That
 *  is the tropical-island bug the manifest lookup exists to prevent, arriving through the door the
 *  lookup does not cover, and it is #896's class: absence must be decided by `assetIsAbsent`, never
 *  by "the read did not work".
 *
 *  Each case names the mutation that must turn it red. */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/runtime/loaders/assetUrl', () => ({
  assetUrl: (p: string) => `ASSETURL:${p}`,
}));

const PREFAB_PATH = '/games/3d-test/assets/models/tropical-island/island.prefab.json';
const MAT_PATH = '/games/3d-test/assets/materials/sand.mat.json';
const KNOWN_ID = '23bd8d04-6202-4514-a936-315c42c40109';

/** A fetch Response good enough for `parseAssetJson`, which reads `ok`/`status` then `text()`. */
const serve = (status: number, body: unknown) => vi.fn(async () => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
})) as unknown as typeof fetch;

async function load() {
  const manifest = await import('../../src/runtime/loaders/assetManifest');
  const prefab = await import('../../src/editor/scene/prefab');
  manifest.clearManifest();
  return { manifest, ...prefab };
}

describe('classifyExistingPrefabId', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.resetModules(); });

  it('returns the manifest guid for a registered prefab, over the id the file carries', async () => {
    const { manifest, classifyExistingPrefabId } = await load();
    manifest.registerAsset(KNOWN_ID, PREFAB_PATH, 'prefab');
    global.fetch = serve(200, { id: 'ffffffff-0000-4000-8000-000000000000', entities: [] });
    expect(await classifyExistingPrefabId(PREFAB_PATH)).toEqual({ kind: 'known', id: KNOWN_ID });
  });

  it('falls back to the on-disk file id when the manifest does not know the path', async () => {
    const { classifyExistingPrefabId } = await load();
    global.fetch = serve(200, { id: KNOWN_ID, entities: [] });

    expect(await classifyExistingPrefabId(PREFAB_PATH)).toEqual({ kind: 'known', id: KNOWN_ID });
    expect((global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0])
      .toBe(`ASSETURL:${PREFAB_PATH}`);
  });

  // ── Mintable: nothing is there to orphan ────────────────────────────────────────────────

  it('is mintable for a genuinely absent file (404)', async () => {
    const { classifyExistingPrefabId } = await load();
    global.fetch = serve(404, '');
    expect(await classifyExistingPrefabId(PREFAB_PATH)).toEqual({ kind: 'mintable', reason: 'absent' });
  });

  it('is mintable for the dev server\'s SPA fallback, which serves index.html with a 200', async () => {
    // The one case where a 200 is positive evidence of absence — and the most common one in dev,
    // since Vite answers every unknown path this way.
    const { classifyExistingPrefabId } = await load();
    global.fetch = serve(200, '<!doctype html><html></html>');
    expect(await classifyExistingPrefabId(PREFAB_PATH)).toEqual({ kind: 'mintable', reason: 'absent' });
  });

  it('is mintable when the document is readable and carries no id', async () => {
    const { classifyExistingPrefabId } = await load();
    global.fetch = serve(200, { entities: [] });
    expect(await classifyExistingPrefabId(PREFAB_PATH)).toEqual({ kind: 'mintable', reason: 'no-id' });
  });

  // ── Refuse: something IS there and this build must not re-identify it ───────────────────
  //
  // Mutation for all four: return `{ kind: 'mintable', reason: 'absent' }` from the catch in
  // `classifyExistingDocumentId`, i.e. restore the old collapse. Every test in this block goes red.

  it('REFUSES a 500 — the server could not serve a file that may well exist', async () => {
    const { classifyExistingPrefabId } = await load();
    global.fetch = serve(500, '');
    expect((await classifyExistingPrefabId(PREFAB_PATH)).kind).toBe('refuse');
  });

  it('REFUSES a 403 as well — a permissions failure is not an absence', async () => {
    const { classifyExistingPrefabId } = await load();
    global.fetch = serve(403, '');
    expect((await classifyExistingPrefabId(PREFAB_PATH)).kind).toBe('refuse');
  });

  it('REFUSES corrupt bytes — the file is there, and half-written is not free', async () => {
    const { classifyExistingPrefabId } = await load();
    global.fetch = serve(200, '{ "id": "23bd8d04-620');
    expect((await classifyExistingPrefabId(PREFAB_PATH)).kind).toBe('refuse');
  });

  it('REFUSES a prefab a NEWER build wrote, and says both versions', async () => {
    const { classifyExistingPrefabId, PREFAB_FORMAT_VERSION } = await load();
    global.fetch = serve(200, { id: KNOWN_ID, version: PREFAB_FORMAT_VERSION + 1, entities: [] });
    const v = await classifyExistingPrefabId(PREFAB_PATH);
    expect(v.kind).toBe('refuse');
    if (v.kind !== 'refuse') throw new Error('unreachable');
    expect(v.reason).toContain(String(PREFAB_FORMAT_VERSION + 1));
    expect(v.reason).toContain(String(PREFAB_FORMAT_VERSION));
  });

  it('accepts a prefab at the CURRENT version — the version check is one-sided', async () => {
    const { classifyExistingPrefabId, PREFAB_FORMAT_VERSION } = await load();
    global.fetch = serve(200, { id: KNOWN_ID, version: PREFAB_FORMAT_VERSION, entities: [] });
    expect(await classifyExistingPrefabId(PREFAB_PATH)).toEqual({ kind: 'known', id: KNOWN_ID });
  });

  it('accepts an OLDER prefab, which is the whole authored corpus today', async () => {
    const { classifyExistingPrefabId } = await load();
    global.fetch = serve(200, { id: KNOWN_ID, version: 2, entities: [] });
    expect(await classifyExistingPrefabId(PREFAB_PATH)).toEqual({ kind: 'known', id: KNOWN_ID });
  });
});

// #1678: an existing prefab is always in the manifest, and the manifest used to answer BEFORE the read — so the
// too-new refusal ran only for a path nothing had indexed, never for the file it protects, and the rigged re-import
// rewrote its sidecars before the server refused the prefab write.
// Mutation for the first and third: return `{kind:'known'}` from the manifest before the fetch for every document
// (the old short-circuit). Both go red; the material case below stays green.
describe('classifyExistingPrefabId — a REGISTERED prefab is still read before it is called known (#1678)', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.resetModules(); });

  it('REFUSES a registered prefab a newer build wrote', async () => {
    const { manifest, classifyExistingPrefabId, PREFAB_FORMAT_VERSION } = await load();
    manifest.registerAsset(KNOWN_ID, PREFAB_PATH, 'prefab');
    global.fetch = serve(200, { id: KNOWN_ID, version: PREFAB_FORMAT_VERSION + 3, entities: [] });
    const v = await classifyExistingPrefabId(PREFAB_PATH);
    expect(v.kind).toBe('refuse');
    if (v.kind !== 'refuse') throw new Error('unreachable');
    expect(v.reason).toContain(`prefab format ${PREFAB_FORMAT_VERSION + 3}`);
  });

  // The manifest names a file the disk no longer has: keep its id, never mint over the refs to it.
  // Mutation: drop the `known ?` in the absent branch — it answers mintable.
  it('keeps the manifest id when the registered prefab is absent on disk', async () => {
    const { manifest, classifyExistingPrefabId } = await load();
    manifest.registerAsset(KNOWN_ID, PREFAB_PATH, 'prefab');
    global.fetch = serve(404, '');
    expect(await classifyExistingPrefabId(PREFAB_PATH)).toEqual({ kind: 'known', id: KNOWN_ID });
  });

  it('REFUSES a registered prefab it cannot read — it cannot tell whether a newer build wrote it', async () => {
    const { manifest, classifyExistingPrefabId } = await load();
    manifest.registerAsset(KNOWN_ID, PREFAB_PATH, 'prefab');
    global.fetch = serve(500, '');
    expect((await classifyExistingPrefabId(PREFAB_PATH)).kind).toBe('refuse');
  });

  // Accept side. Mutation: drop the `!isPrefab` from the short-circuit, so a registered material is read
  // too — the fetch spy is then called.
  it('a registered MATERIAL is answered from the manifest without a read', async () => {
    const { manifest, classifyExistingDocumentId } = await load();
    manifest.registerAsset(KNOWN_ID, MAT_PATH, 'material');
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
    expect(await classifyExistingDocumentId(MAT_PATH)).toEqual({ kind: 'known', id: KNOWN_ID });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('classifyExistingDocumentId — the version check is asked only where the constant means something', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.resetModules(); });

  it('does NOT compare a material against PREFAB_FORMAT_VERSION', async () => {
    // Each document kind has its own ladder and its own disposition; a material's `version` means
    // nothing to the prefab constant, and refusing on it would be a confident wrong answer. The
    // material's own gate is `/api/asset-write`'s ASSET_WRITE_FORMAT_VERSION.
    // Mutation: drop the `.prefab.json` condition — this goes red and the prefab tests stay green,
    // which is the asymmetry that makes the condition load-bearing rather than decorative.
    const { classifyExistingDocumentId, PREFAB_FORMAT_VERSION } = await load();
    global.fetch = serve(200, { id: KNOWN_ID, version: PREFAB_FORMAT_VERSION + 99 });
    expect(await classifyExistingDocumentId(MAT_PATH)).toEqual({ kind: 'known', id: KNOWN_ID });
  });

  it('still refuses an unreadable material — that half is kind-agnostic', async () => {
    const { classifyExistingDocumentId } = await load();
    global.fetch = serve(500, '');
    expect((await classifyExistingDocumentId(MAT_PATH)).kind).toBe('refuse');
  });
});
