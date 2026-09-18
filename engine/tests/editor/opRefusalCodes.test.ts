/** #1012 — an op refusal that a sharper §5 code describes TRULY carries that code.
 *
 *  One case per recoded site, driven through `runAgentOp` against the real editor ops. A thrown
 *  `OpRefusal` is asserted by `code` on the rejection (the relay turns it into the envelope — covered
 *  in `tests/framework/opRefusalRelay.test.ts`); a returned envelope is asserted on the result.
 *
 *  ⚠️ `save-all`'s code is decided from what LANDED, never from the prose, so each of its exits is
 *  tested both ways: nothing written → `REFUSED_BY_OP`, something written → `PARTIAL`. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestWorld, type TestWorld, setPlayState, registerAsset, findEntity, Transform, EntityAttributes } from '@modoki/engine/runtime';
import { markSceneSaved, clearHistory, clearDirtyAssets, markAssetDirty, setCurrentScenePath, setPrefabCache } from '@modoki/engine/editor';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { registerEditorAgentOps } from '../../app/editor/agentEditorOps';
import { runAgentOp } from '../../app/debug/agentBridge';

/** Prefab-edit mode swaps in a synthetic world that `save-all` must not write. Entering it for real
 *  needs a mocked SceneManager (`prefabEditUnsavedProbe.test.ts`), so only the one predicate
 *  `save-all` asks is mocked — the rest of the module stays real. Off by default, so no other case
 *  here sees it. */
const prefabMode = vi.hoisted(() => ({ editing: false }));
vi.mock('../../packages/modoki/src/editor/scene/prefabEdit', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isEditingPrefab: () => prefabMode.editing,
}));

registerAllTraits();
registerEditorAgentOps();

const PARKED = '/assets/fx/opcodes-1012.particle.json';
const def = () => ({ emitter: { shape: 'point' }, particle: { lifetime: 1 } });

let game: TestWorld | undefined;
beforeEach(() => {
  registerAsset('00001012-0000-4000-8000-000000001012', PARKED, 'particle');
  game = createTestWorld({});
  setPlayState('stopped');
  clearHistory();
  clearDirtyAssets();
  markSceneSaved();
  // setCurrentScenePath persists the "last scene" to localStorage, absent in this test env.
  vi.stubGlobal('localStorage', { setItem: () => {}, getItem: () => null, removeItem: () => {} });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }) as unknown as Response));
});
afterEach(() => {
  prefabMode.editing = false;
  setPlayState('stopped');
  game?.dispose(); game = undefined;
  clearDirtyAssets();
  vi.unstubAllGlobals();
});

describe('NOT_FOUND — the thing named does not exist', () => {
  it('set-selection, when no requested entity resolves', async () => {
    await expect(runAgentOp('set-selection', { guids: ['ghost-1012'] })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('delete-entities, when no requested entity resolves', async () => {
    await expect(runAgentOp('delete-entities', { guids: ['ghost-1012'] })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('an asset editor opened on a path no asset is at (requireAssetPath)', async () => {
    await expect(runAgentOp('open-sprite-editor', { path: '/assets/textures/nope-1012.png' }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('set-game-view-device, for a preset name that does not exist — with the real names as options', async () => {
    const r = await runAgentOp('set-game-view-device', { device: 'Galaxy Nope 1012' }) as { ok?: boolean; code?: string; options?: string[] };
    expect(r).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(r.options).toContain('Free');
  });
});

describe('AMBIGUOUS — the arguments disagree', () => {
  it('set-game-view-device given BOTH a device and an explicit size', async () => {
    const r = await runAgentOp('set-game-view-device', { device: 'Free', logicalWidth: 640, logicalHeight: 480 });
    expect(r).toMatchObject({ ok: false, code: 'AMBIGUOUS' });
  });
});

describe('REQUIRES_SAVE — the world swap would cross unsaved work (guardUnsaved)', () => {
  it('load-scene with a parked asset write pending', async () => {
    markAssetDirty(PARKED, 'particle', def());
    const err = await runAgentOp('load-scene', { path: '/assets/scenes/elsewhere-1012.scene.json' })
      .then(() => null, (e: unknown) => e as { code?: string; message?: string });
    expect(err).toMatchObject({ code: 'REQUIRES_SAVE' });
    // Close-out review: recoding this throw once dropped the space after the dash, so every agent
    // read "UNSAVED work —dirty asset…". The cause list is prose an agent acts on; pin its seam.
    expect(err?.message).toMatch(/UNSAVED work — \S/);
  });
});

describe('save-all while PLAYING — the scene half is refused; the code follows what landed', () => {
  beforeEach(() => { setCurrentScenePath('/assets/scenes/opcodes-1012.scene.json'); });

  it('nothing parked, nothing written → REFUSED_BY_OP', async () => {
    setPlayState('playing');
    await expect(runAgentOp('save-all', {})).rejects.toMatchObject({ code: 'REFUSED_BY_OP' });
  });

  it('a parked asset flushed before the refusal → PARTIAL, and the message says it landed', async () => {
    markAssetDirty(PARKED, 'particle', def());
    setPlayState('playing');
    const err = await runAgentOp('save-all', {}).then(() => null, (e: unknown) => e as { code?: string; message?: string });
    expect(err).toMatchObject({ code: 'PARTIAL' });
    expect(err?.message).toMatch(/WERE written/);
  });
});

describe('save-all with NO scene path (the Save-As panel needs a human) — same rule', () => {
  beforeEach(() => { setCurrentScenePath(null); });

  it('nothing parked → REFUSED_BY_OP', async () => {
    await expect(runAgentOp('save-all', {})).rejects.toMatchObject({ code: 'REFUSED_BY_OP' });
  });

  it('a parked asset flushed → PARTIAL, naming what landed', async () => {
    markAssetDirty(PARKED, 'particle', def());
    const err = await runAgentOp('save-all', {}).then(() => null, (e: unknown) => e as { code?: string; message?: string });
    expect(err).toMatchObject({ code: 'PARTIAL' });
    expect(err?.message).toMatch(/DID land/);
  });
});

describe('save-all with an explicit path that is not a scene file name (#1413)', () => {
  const writesTo = () => (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
    .filter(([u]) => String(u).includes('/api/write-file'));
  beforeEach(() => { setCurrentScenePath('/assets/scenes/open-1413.scene.json'); });

  it('a plain .json is REFUSED, nothing is written, and the corrected path is named', async () => {
    const err = await runAgentOp('save-all', { path: '/assets/scenes/new-1413.json' }).then(() => null, (e: unknown) => e as { code?: string; message?: string });
    expect(err).toMatchObject({ code: 'REFUSED_BY_OP' });
    expect(err?.message).toContain('"/assets/scenes/new-1413.scene.json"');
    expect(writesTo()).toEqual([]);
  });

  it('parked docs are still written first (#259) — the refusal is PARTIAL and names them', async () => {
    markAssetDirty(PARKED, 'particle', def());
    const err = await runAgentOp('save-all', { path: '/assets/scenes/new-1413.json' }).then(() => null, (e: unknown) => e as { code?: string; message?: string });
    expect(err).toMatchObject({ code: 'PARTIAL' });
    expect(err?.message).toMatch(/WERE written/);
    // …and the scene half really was not written, under either name.
    const bodies = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(([, init]) => String((init as { body?: string })?.body ?? ''));
    expect(bodies.some((b) => b.includes('new-1413'))).toBe(false);
  });

  it('another kind\'s suffix is refused too — it would be registered as a scene under a prefab name', async () => {
    await expect(runAgentOp('save-all', { path: '/assets/scenes/new-1413.prefab.json' })).rejects.toMatchObject({ code: 'REFUSED_BY_OP' });
    expect(writesTo()).toEqual([]);
  });

  it('a legacy /scenes/*.json the manifest already types scene is still re-savable under its name', async () => {
    registerAsset('00001413-0000-4000-8000-000000001413', '/assets/scenes/legacy-1413.json', 'scene');
    await runAgentOp('save-all', { path: '/assets/scenes/legacy-1413.json' });
    expect(writesTo().length).toBeGreaterThan(0);
  });

  it('a .scene.json path saves', async () => {
    await runAgentOp('save-all', { path: '/assets/scenes/new-1413.scene.json' });
    expect(writesTo().length).toBeGreaterThan(0);
  });
});

describe('save-all when the SCENE WRITE FAILS — the terminal exit, same rule', () => {
  beforeEach(() => {
    setCurrentScenePath('/assets/scenes/write-fail-1012.scene.json');
    markSceneSaved();
    // Asset writes succeed, the scene write does not — the assetSaveAlwaysFlushes.test.ts shape.
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/write-file')) return { ok: false, json: async () => ({ ok: false }) } as unknown as Response;
      return { ok: true, json: async () => ({ ok: true }) } as unknown as Response;
    }));
  });

  it('nothing parked → REFUSED_BY_OP', async () => {
    const err = await runAgentOp('save-all', {}).then(() => null, (e: unknown) => e as { code?: string; message?: string });
    expect(err?.message, 'precondition: this is the scene-write exit').toMatch(/SCENE was not written/);
    expect(err).toMatchObject({ code: 'REFUSED_BY_OP' });
  });

  it('a parked asset flushed → PARTIAL', async () => {
    markAssetDirty(PARKED, 'particle', def());
    const err = await runAgentOp('save-all', {}).then(() => null, (e: unknown) => e as { code?: string; message?: string });
    expect(err?.message, 'precondition: this is the scene-write exit').toMatch(/SCENE was not written/);
    expect(err).toMatchObject({ code: 'PARTIAL' });
  });
});

describe('save-all in PREFAB-EDIT mode — refused; the code follows what the parked flush wrote', () => {
  it('nothing parked → REFUSED_BY_OP', async () => {
    prefabMode.editing = true;
    const err = await runAgentOp('save-all', {}).then(() => null, (e: unknown) => e as { code?: string; message?: string });
    expect(err?.message, 'precondition: this is the prefab-edit exit').toMatch(/PREFAB-EDIT mode/);
    expect(err).toMatchObject({ code: 'REFUSED_BY_OP' });
  });

  it('a parked asset flushed before the refusal → PARTIAL', async () => {
    markAssetDirty(PARKED, 'particle', def());
    prefabMode.editing = true;
    const err = await runAgentOp('save-all', {}).then(() => null, (e: unknown) => e as { code?: string; message?: string });
    expect(err?.message, 'precondition: this is the prefab-edit exit').toMatch(/PREFAB-EDIT mode[\s\S]*WERE written/);
    expect(err).toMatchObject({ code: 'PARTIAL' });
  });
});

describe('prefab revert — the override keys named', () => {
  const PREFAB = '/assets/prefabs/opcodes-1012.prefab.json';

  /** A real instance carrying ONE real override, so `available.all` is non-empty and both refusals
   *  are reached rather than the earlier "has no overrides" exit. */
  async function instanceWithOverride(): Promise<string> {
    setPrefabCache(PREFAB, {
      version: 1, name: 'opcodes-1012', rootLocalId: 1,
      entities: [{ localId: 1, name: 'Root', traits: {
        Transform: { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 },
        EntityAttributes: { name: 'Root', parentId: 0 },
      } }],
    } as never);
    const r = await runAgentOp('prefab', { action: 'instantiate', path: PREFAB }) as { rootId: number };
    findEntity(r.rootId)!.set(Transform, { x: 5 });
    // By guid: the instance root has one, so an `entityId` is refused (#1223 D2).
    const guid = (findEntity(r.rootId)!.get(EntityAttributes) as { guid: string }).guid;
    const o = await runAgentOp('prefab', { action: 'overrides', entityGuid: guid }) as { keys?: { all?: string[] } };
    expect(o.keys?.all?.length, 'fixture must carry a real override, or the refusals below are never reached').toBeGreaterThan(0);
    return guid;
  }

  it('an EMPTY keys array → AMBIGUOUS ("nothing" and "everything" are both readings)', async () => {
    const guid = await instanceWithOverride();
    await expect(runAgentOp('prefab', { action: 'revert', entityGuid: guid, keys: [] })).rejects.toMatchObject({ code: 'AMBIGUOUS' });
  });

  it('a key matching no override → NOT_FOUND, with the real keys as options', async () => {
    const guid = await instanceWithOverride();
    const err = await runAgentOp('prefab', { action: 'revert', entityGuid: guid, keys: ['no-such-override-1012'] })
      .then(() => null, (e: unknown) => e as { code?: string; options?: string[] });
    expect(err).toMatchObject({ code: 'NOT_FOUND' });
    expect(err?.options?.length).toBeGreaterThan(0);
    expect(err?.options).not.toContain('no-such-override-1012');
  });
});
