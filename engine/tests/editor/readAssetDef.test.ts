/** The `read-asset-def` agent op — the READ half of the asset-editor surface.
 *
 *  Why it exists at all: `particle-set` / `anim-set-clip` / `timeline-set` each require a FULL
 *  definition, and nothing returned one. Found running `modoki_batch` use case 6, which had two
 *  consequences: to change ONE field you had to read the `.particle.json` off disk and map an
 *  asset-root URL to a filesystem path by hand (impossible for a packaged or remote editor), and an
 *  asset edit could not be VERIFIED — the write answered `{ok:true}` and the only suggested check
 *  was `render_sequence`, i.e. judging by PIXELS, which `docs/debug-tools-mcp.md` forbids.
 *
 *  The load-bearing behaviour, and what these tests exist to pin:
 *
 *  1. **It reads the LIVE cache, not the file.** Persistence is manual, so an unsaved edit exists
 *     only live; a file read would report the pre-edit value and make a successful edit look like a
 *     no-op — the exact "I asked for X and was shown Y" confusion the whole surface is being
 *     hardened against.
 *  2. **A cache MISS is an error, not an empty answer.** `null` would read as "the asset is empty".
 *  3. **`unsaved` reports a parked write**, so a pending change is never invisible.
 *
 *  Route-level coverage (param forwarding, the 400-vs-504 split) is in
 *  `engine/tests/plugins/editorActionRouter.test.ts`; the live end-to-end pass is UC6 in
 *  `engine/tools/modoki-mcp/test-smoke.mjs`. This file covers the op's own decisions. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createTestWorld, type TestWorld, setPlayState,
  setParticleEffect, clearParticleCache, setAnimationClip, clearAnimationClipCache, registerAsset,
  setSpriteAnim, clearSpriteAnimCache, setRig2D, clearRig2DCache, type Rig2DFile,
} from '@modoki/engine/runtime';
import { clearHistory, clearDirtyAssets, markSceneSaved } from '@modoki/engine/editor';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { registerEditorAgentOps } from '../../app/editor/agentEditorOps';
import { runAgentOp } from '../../app/debug/agentBridge';

/** `particle-set`/`anim-set-clip`/`timeline-set` REPLACE an existing def and now refuse a path no
 *  asset exists at (a typo used to be applied to nothing, reported ok, and then materialised as a
 *  brand-new file by save_all). These suites use synthetic paths, so register them the way a real
 *  editor would have. */
function registerTestAssets() {
  registerAsset(`00000000-0000-4000-8000-000000000000`.slice(0,36), '/assets/animations/walk.anim.json', 'animation');
  registerAsset(`00000001-0000-4000-8000-000000000001`.slice(0,36), '/assets/fx/never-loaded.particle.json', 'particle');
  registerAsset(`00000002-0000-4000-8000-000000000002`.slice(0,36), '/assets/fx/nope.particle.json', 'particle');
  registerAsset(`00000003-0000-4000-8000-000000000003`.slice(0,36), '/assets/fx/spark.particle.json', 'particle');
}


registerAllTraits();
registerEditorAgentOps();

const PARTICLE = '/assets/fx/spark.particle.json';
const CLIP = '/assets/animations/walk.anim.json';
const SPRITEANIM = '/assets/fx/hero.spriteanim.json';
const RIG2D = '/assets/fx/hero.rig2d.json';
const MINIMAL_RIG: Rig2DFile = {
  bones: [{ name: 'root', parent: -1, x: 0, y: 0, rot: 0 }],
  sprite: 'sp1',
  mesh: { verts: [[0, 0]], uvs: [[0, 0]], tris: [] },
  skinIndices: [0],
  skinWeights: [1],
};

type Def = { ok: boolean; path: string; type: string; source: string; unsaved: boolean; def: Record<string, unknown> };

let game: TestWorld | undefined;
beforeEach(() => {
  registerTestAssets();
  game = createTestWorld({});
  setPlayState('stopped');
  clearHistory();
  clearDirtyAssets();
  clearParticleCache();
  clearAnimationClipCache();
  clearSpriteAnimCache();
  clearRig2DCache();
  markSceneSaved();
  vi.stubGlobal('localStorage', { setItem: () => {}, getItem: () => null, removeItem: () => {} });
});
afterEach(() => {
  game?.dispose(); game = undefined;
  clearDirtyAssets(); clearParticleCache(); clearAnimationClipCache();
  clearSpriteAnimCache(); clearRig2DCache();
  vi.unstubAllGlobals();
});

describe('reading a definition back', () => {
  it('returns the LIVE particle def, with its type inferred from the suffix', async () => {
    setParticleEffect(PARTICLE, { maxParticles: 300 } as never);
    const r = await runAgentOp('read-asset-def', { path: PARTICLE }) as Def;
    expect(r.ok).toBe(true);
    expect(r.type).toBe('particle');
    expect(r.source).toBe('live');
    expect(r.def.maxParticles).toBe(300);
  });

  it('reads an animation clip too — the suffix picks the cache', async () => {
    setAnimationClip(CLIP, { name: 'walk', duration: 1, tracks: [] } as never);
    const r = await runAgentOp('read-asset-def', { path: CLIP }) as Def;
    expect(r.type).toBe('animation');
    expect(r.def.name).toBe('walk');
  });

  it('reads a spriteanim set too — the suffix picks the cache', async () => {
    setSpriteAnim(SPRITEANIM, { clips: { walk: { frames: ['g1'], fps: 10, mode: 'loop', cycles: 0 } } });
    const r = await runAgentOp('read-asset-def', { path: SPRITEANIM }) as Def;
    expect(r.type).toBe('spriteanim');
    expect((r.def as { clips: Record<string, unknown> }).clips).toHaveProperty('walk');
  });

  it('reads a rig2d rig too — the suffix picks the cache', async () => {
    setRig2D(RIG2D, MINIMAL_RIG);
    const r = await runAgentOp('read-asset-def', { path: RIG2D }) as Def;
    expect(r.type).toBe('rig2d');
    expect((r.def as { sprite: string }).sprite).toBe('sp1');
  });

  it('reports a rig2d at its AUTHORED precision, not the parsed rig (QA-ASSET-0015)', async () => {
    // rig2d is the one kind whose live cache holds a RUNTIME structure — packed Float32Arrays,
    // weights renormalized. Answering with that made the op report float32 numbers for a file
    // holding float64 ones, and a QA run read the difference as the editor corrupting the rig
    // on load. Every other kind reports the authored doc; so does this one now.
    const AUTHORED = 0.7172465286407307;
    setRig2D(RIG2D, { ...MINIMAL_RIG, skinIndices: [0, 0, 0, 0], skinWeights: [AUTHORED, 0, 0, 0] });
    const r = await runAgentOp('read-asset-def', { path: RIG2D }) as Def;
    expect((r.def as { skinWeights: number[] }).skinWeights[0]).toBe(AUTHORED);
  });

  it('sees an edit made through particle-set — the verification path', async () => {
    // This is the whole point: a caller can now CHECK an asset edit by data instead of by pixels.
    setParticleEffect(PARTICLE, { maxParticles: 300 } as never);
    await runAgentOp('particle-set', { path: PARTICLE, def: { maxParticles: 137 } });
    const r = await runAgentOp('read-asset-def', { path: PARTICLE }) as Def;
    expect(r.def.maxParticles).toBe(137);
  });

  it('reports `unsaved` when a write is parked, so a pending edit is never invisible', async () => {
    setParticleEffect(PARTICLE, { maxParticles: 300 } as never);
    const clean = await runAgentOp('read-asset-def', { path: PARTICLE }) as Def;
    expect(clean.unsaved).toBe(false);
    await runAgentOp('particle-set', { path: PARTICLE, def: { maxParticles: 137 } });
    const dirty = await runAgentOp('read-asset-def', { path: PARTICLE }) as Def;
    expect(dirty.unsaved).toBe(true);
  });
});

describe('refusals — a miss must not look like an answer', () => {
  it('ERRORS when the asset is not in the live cache, rather than returning null', async () => {
    // `null` would read as "the asset is empty", which is a different and wrong fact.
    await expect(runAgentOp('read-asset-def', { path: '/assets/fx/never-loaded.particle.json' }))
      .rejects.toThrow(/not in the live particle cache/);
  });

  it('says WHY nothing is cached, and what to do about it', async () => {
    const err = await runAgentOp('read-asset-def', { path: '/assets/fx/nope.particle.json' }).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/nothing in the open scene has loaded it yet/);
  });

  it('a spriteanim miss ERRORS too, and PEEKS without starting a background fetch', async () => {
    // The bug this whole op exists to avoid: probing a deliberately-absent path (the live MCP
    // sweep does exactly this) used to kick off a background load that could only fail and
    // logged console noise for a question the caller had already decided to refuse.
    const fetchSpy = vi.fn(() => Promise.reject(new Error('no network in test')));
    vi.stubGlobal('fetch', fetchSpy);
    await expect(runAgentOp('read-asset-def', { path: '/assets/fx/missing.spriteanim.json' }))
      .rejects.toThrow(/not in the live spriteanim cache/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a rig2d miss ERRORS too, and PEEKS without starting a background fetch', async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error('no network in test')));
    vi.stubGlobal('fetch', fetchSpy);
    await expect(runAgentOp('read-asset-def', { path: '/assets/fx/missing.rig2d.json' }))
      .rejects.toThrow(/not in the live rig2d cache/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses a path whose kind it cannot infer, naming the accepted types', async () => {
    const err = await runAgentOp('read-asset-def', { path: '/assets/fx/mystery.json' }).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/cannot tell what kind of asset/);
    expect((err as Error).message).toMatch(/particle.*animation.*timeline/);
  });

  it('honours an explicit `type` that overrides an unhelpful filename', async () => {
    setParticleEffect('/assets/fx/mystery.json', { maxParticles: 5 } as never);
    const r = await runAgentOp('read-asset-def', { path: '/assets/fx/mystery.json', type: 'particle' }) as Def;
    expect(r.def.maxParticles).toBe(5);
  });

  it('refuses an unsupported `type` instead of silently reading nothing', async () => {
    const err = await runAgentOp('read-asset-def', { path: PARTICLE, type: 'material' }).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/unsupported type 'material'/);
  });

  it('requires a path', async () => {
    await expect(runAgentOp('read-asset-def', {})).rejects.toThrow(/requires \{ path \}/);
  });
});
