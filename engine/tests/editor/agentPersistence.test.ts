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
  createTestWorld, type TestWorld, setPlayState,
} from '@modoki/engine/runtime';
import {
  getEditVersion, hasUnsavedChanges, markSceneSaved, clearHistory, canUndo, undoLabel,
} from '@modoki/engine/editor';
import { applyOps, type MutableScene } from '@modoki/engine/runtime';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { registerEditorAgentOps } from '../../app/editor/agentEditorOps';
import { runAgentOp } from '../../app/debug/agentBridge';

registerAllTraits();
registerEditorAgentOps();

let game: TestWorld | undefined;
beforeEach(() => {
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
  it('particle-set applies live and persists, but pushes no undo entry and does not dirty the flag', async () => {
    const before = getEditVersion();
    const beforeCanUndo = canUndo();
    let written: { path?: string; body?: unknown } = {};
    const origFetch = globalThis.fetch;
    // @ts-expect-error test stub
    globalThis.fetch = async (url: string, init?: RequestInit) => {
      if (url === '/api/asset-write') { written = { path: url, body: init?.body }; return { ok: true, json: async () => ({ ok: true }) } as Response; }
      return { ok: true, json: async () => ({}) } as Response;
    };
    try {
      const def = { emitter: { shape: 'point' }, particle: { lifetime: 1 } };
      const r = await runAgentOp('particle-set', { path: '/assets/fx/phase0.particle.json', def }) as { ok: boolean };
      expect(r.ok).toBe(true);
      expect(written.path).toBe('/api/asset-write');
    } finally {
      globalThis.fetch = origFetch;
    }
    expect(getEditVersion()).toBe(before); // no pushAction ⇒ no dirty bump
    expect(canUndo()).toBe(beforeCanUndo); // no undo entry
    expect(hasUnsavedChanges()).toBe(false);
  });
});
