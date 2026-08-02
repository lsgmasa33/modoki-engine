/** Phase 0 (mcp-persistence.md) — characterize TODAY's persistence behaviour
 *  per mutating MCP tool along the four dimensions the plan cares about: does it write a
 *  FILE, does it mutate the LIVE world, does it push an UNDO entry, does it bump the
 *  dirty flag (`hasUnsavedChanges()`)? This is the regression net for Phases 2–3 — every
 *  assertion here must keep passing UNCHANGED once the mode knob lands (Phase 1's ship
 *  gate is "auto mode, no save param ⇒ byte-identical to today").
 *
 *  Two disjoint paths exist today (see the plan §1):
 *   - Path A (file-direct): mutate_scene/set_transform (sceneMutate.ts → /api/scene-mutate)
 *     and particle/anim/timeline ops (agentEditorOps.ts → persistAsset → /api/asset-write).
 *     Always writes a file; NEVER touches the undo stack or the dirty flag.
 *   - Path B (live-world): create/duplicate/delete/reparent-entity and prefab
 *     instantiate/create/detach. Mutates the live ECS world, pushes an undo entry, and
 *     bumps `hasUnsavedChanges()`. Never saves until save_all. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  createTestWorld, type TestWorld, setPlayState, registerAsset, getParticleEffect, setParticleEffect,
} from '@modoki/engine/runtime';
import {
  getEditVersion, hasUnsavedChanges, markSceneSaved, clearHistory, canUndo, undoLabel, undo, redo,
  getDirtyAssetPaths, peekDirtyAsset,
} from '@modoki/engine/editor';

/** The PARKED doc for a path — what `save_all` would write — narrowed to the field these
 *  tests assert on. Null when nothing is pending for it. */
function dirtyAssetSnapshot(p: string): { particle?: { lifetime?: number } } | null {
  return (peekDirtyAsset(p)?.data as { particle?: { lifetime?: number } }) ?? null;
}
import { applyOps, type MutableScene } from '@modoki/engine/runtime';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { registerEditorAgentOps } from '../../app/editor/agentEditorOps';
import { runAgentOp } from '../../app/debug/agentBridge';

/** `particle-set`/`anim-set-clip`/`timeline-set` REPLACE an existing def and now refuse a path no
 *  asset exists at (a typo used to be applied to nothing, reported ok, and then materialised as a
 *  brand-new file by save_all). These suites use synthetic paths, so register them the way a real
 *  editor would have. */
function registerTestAssets() {
  registerAsset(`00000000-0000-4000-8000-000000000000`.slice(0,36), '/assets/fx/phase0.particle.json', 'particle');
  registerAsset('00000000-0000-4000-8000-000000000001', '/assets/fx/parked-undo.particle.json', 'particle');
  registerAsset('00000000-0000-4000-8000-000000000002', '/assets/fx/clean-then-undone.particle.json', 'particle');
}


registerAllTraits();
registerEditorAgentOps();

let game: TestWorld | undefined;
beforeEach(() => {
  registerTestAssets();
  game = createTestWorld({});
  setPlayState('stopped'); // createTestWorld defaults to 'playing' for sim; the editor ops don't need it
  clearHistory();
  markSceneSaved(); // baseline: "matches disk"
});
afterEach(() => { game?.dispose(); game = undefined; });

describe('Path B — live-world structural ops: mutate live, push undo, dirty the flag', () => {
  it('create-entity: live-only, undoable, dirties the flag', async () => {
    expect(hasUnsavedChanges()).toBe(false);
    const before = getEditVersion();
    const r = await runAgentOp('create-entity', { spec: { kind: 'empty' } }) as { id: number; guid: string };
    expect(r.id).toBeGreaterThan(0);
    expect(getEditVersion()).toBeGreaterThan(before);
    expect(hasUnsavedChanges()).toBe(true);
    expect(canUndo()).toBe(true);
  });

  it('duplicate-entity: live-only, undoable, dirties the flag', async () => {
    const created = await runAgentOp('create-entity', { spec: { kind: 'empty' } }) as { id: number };
    markSceneSaved(); // pretend the create was already saved — isolate duplicate's own effect
    const before = getEditVersion();
    const r = await runAgentOp('duplicate-entity', { id: created.id }) as { id: number };
    expect(r.id).not.toBe(created.id);
    expect(getEditVersion()).toBeGreaterThan(before);
    expect(hasUnsavedChanges()).toBe(true);
    expect(canUndo()).toBe(true);
  });

  it('delete-entities: live-only, undoable, dirties the flag', async () => {
    const created = await runAgentOp('create-entity', { spec: { kind: 'empty' } }) as { id: number };
    markSceneSaved();
    const before = getEditVersion();
    const r = await runAgentOp('delete-entities', { ids: [created.id] }) as { ok: boolean };
    expect(r.ok).toBe(true);
    expect(getEditVersion()).toBeGreaterThan(before);
    expect(hasUnsavedChanges()).toBe(true);
    expect(canUndo()).toBe(true);
  });

  it('reparent-entity: live-only, undoable, dirties the flag', async () => {
    const parent = await runAgentOp('create-entity', { spec: { kind: 'empty' } }) as { id: number };
    const child = await runAgentOp('create-entity', { spec: { kind: 'empty' } }) as { id: number };
    markSceneSaved();
    const before = getEditVersion();
    const r = await runAgentOp('reparent-entity', { id: child.id, parentId: parent.id }) as { ok: boolean };
    expect(r.ok).toBe(true);
    expect(getEditVersion()).toBeGreaterThan(before);
    expect(hasUnsavedChanges()).toBe(true);
    expect(canUndo()).toBe(true);
  });

  // Regression lock for commit 59bf6d28: prefab ops used to be live-only YET invisible to
  // hasUnsavedChanges()/canUndo() — the exact bug this whole plan exists to generalize a fix
  // for. If this test starts failing, the fix regressed, not just "behaviour changed".
  it('prefab instantiate: live-only, undoable, dirties the flag (regression lock, commit 59bf6d28)', async () => {
    const before = getEditVersion();
    const prefab = {
      version: 1, name: 'phase0-test', rootLocalId: 1,
      entities: [{ localId: 1, name: 'Root', traits: {
        Transform: { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 },
        EntityAttributes: { name: 'Root', parentId: 0 },
      } }],
    };
    const { setPrefabCache } = await import('@modoki/engine/editor');
    setPrefabCache('/assets/prefabs/phase0-test.prefab.json', prefab as never);
    const r = await runAgentOp('prefab', { action: 'instantiate', path: '/assets/prefabs/phase0-test.prefab.json' }) as { ok: boolean; rootId: number };
    expect(r.ok).toBe(true);
    expect(getEditVersion()).toBeGreaterThan(before);
    expect(hasUnsavedChanges()).toBe(true);
    expect(canUndo()).toBe(true);
    expect(undoLabel()).toContain('phase0-test');
  });
});

describe('Path A — file-direct scene ops: pure over the FILE, no undo/dirty side effects', () => {
  // sceneMutate.ts is the pure-function twin of /api/scene-mutate — applyOps() operates
  // entirely on a plain JS object and cannot see (or dirty) the live undo stack. This pins
  // the structural fact that makes the 409 interlock in editorBackendRouter.ts necessary
  // today (there is no live-world path for these ops at all yet).
  it('applyOps (the /api/scene-mutate core) never touches the live editVersion/undo stack', () => {
    const scene: MutableScene = {
      entities: [{ id: 1, name: 'A', traits: { Transform: { x: 0 }, EntityAttributes: { name: 'A', parentId: 0 } } }],
    };
    const before = getEditVersion();
    const beforeCanUndo = canUndo();
    const { changed } = applyOps(scene, [{ op: 'setTrait', entity: { id: 1 }, trait: 'Transform', fields: { x: 5 } }]);
    expect(changed).toBe(1);
    expect(getEditVersion()).toBe(before); // unaffected — this is a pure data transform
    expect(canUndo()).toBe(beforeCanUndo); // unaffected
    expect(hasUnsavedChanges()).toBe(false); // still "matches disk" from the live world's POV
  });

  it('sceneMutate.ts does not import the undo module (structural drift guard)', () => {
    const srcPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../packages/modoki/src/runtime/scene/sceneMutate.ts');
    const src = fs.readFileSync(srcPath, 'utf-8');
    expect(src).not.toMatch(/undoManager|pushAction/);
  });
});

describe('Path A — particle/anim/timeline ops: apply live AND always persist, no undo entry', () => {
  // These ops (particle-set, anim-set-clip, anim-add-key, timeline-set, timeline-add-clip) sit
  // between the two paths: they DO write into the live editor cache (so the panel/viewport
  // reflects the change immediately) but they never call pushAction, so — unlike the
  // structural ops above — they leave NO undo entry and do NOT bump hasUnsavedChanges(). This
  // is the "apply live then persist.ts" pattern Phase 3 turns into a manual-mode dirty registry.
  it('particle-set applies live, PARKS the write, and IS undoable — without dirtying the scene', async () => {
    // Persistence is manual-only: the op no longer writes /api/asset-write itself. It applies the
    // edit live and parks the pending doc in the dirty-asset registry, which `save-all` flushes.
    //
    // THE UNDO HALF REVERSED (audit S2.27, owner decision 2026-07-30). This test used to assert
    // "no undo entry", on the reasoning that an asset edit is not a scene edit. But
    // `ParticleEditor` pushes to the SAME global undoManager for the identical edit, so the agent
    // was the only actor whose asset edits were un-undoable — and worse, a human's Cmd-Z after an
    // agent tweak unwound THEIR OWN earlier action, one they had no reason to think was next.
    //
    // What made the old reasoning look right is preserved and still asserted below: the entry is
    // pushed with `_isFileDirect`, so it does NOT bump the scene edit version. The concern was
    // real — it was about the DIRTY BUMP, not about undoability — and the two are separable.
    const before = getEditVersion();
    const beforeCanUndo = canUndo();
    const origFetch = globalThis.fetch;
    let wroteToDisk = false;
    // @ts-expect-error test stub
    globalThis.fetch = async (url: string) => {
      if (url === '/api/asset-write') wroteToDisk = true;
      return { ok: true, json: async () => ({ ok: true }) } as Response;
    };
    try {
      const def = { emitter: { shape: 'point' }, particle: { lifetime: 1 } };
      const r = await runAgentOp('particle-set', { path: '/assets/fx/phase0.particle.json', def }) as { ok: boolean; saved: boolean };
      expect(r.ok).toBe(true);
      expect(r.saved).toBe(false);
      expect(wroteToDisk).toBe(false);
    } finally {
      globalThis.fetch = origFetch;
    }
    // The scene is NOT dirtied by an asset-only edit — `_isFileDirect` opts the entry out of the
    // notifyEdited() bump. A falsely-dirty scene is not cosmetic: it self-blocks the file-direct
    // routes that refuse while live work is unsaved.
    expect(getEditVersion()).toBe(before);
    // …and the FIRST write to an asset pushes NO entry: the cache had no prior def, so there is
    // nothing to revert TO. (An entry whose undo() applies null would consume the human's Cmd-Z
    // and restore nothing — worse than the missing entry it was meant to prevent. The caches
    // return `null` for a miss, not `undefined`, which is what the guard has to test for.)
    expect(canUndo()).toBe(beforeCanUndo);
    // A SECOND write to the same asset does push, because now there is a before-state.
    await runAgentOp('particle-set', {
      path: '/assets/fx/phase0.particle.json',
      def: { emitter: { shape: 'point' }, particle: { lifetime: 2 } },
    });
    expect(canUndo()).toBe(true);
    expect(hasUnsavedChanges()).toBe(true); // a parked asset write IS unsaved work
  });

  it('undoing an agent particle edit restores the PREVIOUS def, not just the stack pointer', async () => {
    // An entry that pops without restoring anything would be worse than none: it consumes the
    // human's Cmd-Z and changes nothing they can see.
    const first = { emitter: { shape: 'point' }, particle: { lifetime: 1 } };
    const second = { emitter: { shape: 'point' }, particle: { lifetime: 9 } };
    const path = '/assets/fx/phase0.particle.json';
    await runAgentOp('particle-set', { path, def: first });
    await runAgentOp('particle-set', { path, def: second });
    expect((getParticleEffect(path) as { particle?: { lifetime?: number } })?.particle?.lifetime).toBe(9);
    await undo();
    expect((getParticleEffect(path) as { particle?: { lifetime?: number } })?.particle?.lifetime).toBe(1);
    await redo();
    expect((getParticleEffect(path) as { particle?: { lifetime?: number } })?.particle?.lifetime).toBe(9);
  });

  /** REGRESSION (independent review, 2026-07-30). Undo restored the live CACHE but left the
   *  dirty-asset registry holding the NEW doc — so the next `save_all` committed to disk exactly
   *  the value that had just been undone. The registry has to travel with the cache. */
  it('undo moves the PARKED write too, so a later save cannot re-commit the undone def', async () => {
    const first = { emitter: { shape: 'point' }, particle: { lifetime: 1 } };
    const second = { emitter: { shape: 'point' }, particle: { lifetime: 9 } };
    const p = '/assets/fx/parked-undo.particle.json';
    await runAgentOp('particle-set', { path: p, def: first });
    await runAgentOp('particle-set', { path: p, def: second });
    expect(dirtyAssetSnapshot(p)?.particle?.lifetime).toBe(9);
    await undo();
    // The parked doc — what save_all would WRITE — must be the reverted one, not the undone one.
    expect(dirtyAssetSnapshot(p)?.particle?.lifetime).toBe(1);
    await redo();
    expect(dirtyAssetSnapshot(p)?.particle?.lifetime).toBe(9);
  });

  it('undoing the only edit to a CLEAN asset discards the parked write instead of re-parking it', async () => {
    // Nothing was pending before, so disk already holds the pre-edit def: leaving a parked write
    // would keep the asset dirty forever after an undo and self-block the file-direct routes.
    const p = '/assets/fx/clean-then-undone.particle.json';
    // A committed asset: a def in the live cache (so undo has something to revert TO) and
    // nothing parked — i.e. disk and cache agree.
    setParticleEffect(p, { emitter: { shape: 'point' }, particle: { lifetime: 2 } } as never);
    expect(getDirtyAssetPaths()).not.toContain(p);
    await runAgentOp('particle-set', { path: p, def: { emitter: { shape: 'point' }, particle: { lifetime: 7 } } });
    expect(getDirtyAssetPaths()).toContain(p);
    await undo();
    expect(getDirtyAssetPaths()).not.toContain(p);
  });

  it('the FIRST write to an asset pushes NO entry — there is nothing to revert to', async () => {
    const beforeCanUndo = canUndo();
    await runAgentOp('particle-set', {
      path: '/assets/fx/never-seen-before.particle.json',
      def: { emitter: { shape: 'point' }, particle: { lifetime: 1 } },
    }).catch(() => undefined);   // refused if unregistered; either way, no entry
    expect(canUndo()).toBe(beforeCanUndo);
  });
});
