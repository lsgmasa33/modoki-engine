/** `savePrefabEdit` must refuse while scrub/preview/play is live — the prefab twin of the guard
 *  `saveScene` has carried since the preview-mode refactor.
 *
 *  IT SERIALIZES THE PREFAB SUBTREE OUT OF THE LIVE WORLD, so during a preview envelope that world
 *  holds a posed rig, a control-spawned prefab, physics-settled positions — and a save writes them
 *  into the `.prefab.json`, where every scene instantiating it inherits them. There is no revert:
 *  Stop restores the world, not the file.
 *
 *  It was guarded in exactly ONE caller (the Cmd+S handler's `!canEdit()` early return), which
 *  meant the agent path — `modoki_prefab {action:'edit-save'}` — never had it, and #259 removed the
 *  human's when that early return was deleted so parked asset docs could still flush during a
 *  preview. Moving it into `savePrefabEdit` covers both and cannot be forgotten by a third caller.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useEditorStore, savePrefabEdit } from '@modoki/engine/editor';
import { setRunMode } from '@modoki/engine/runtime';

const PREFAB = { path: '/assets/prefabs/tree.prefab.json', guid: 'ffffffff-0000-4000-8000-00000000beef', name: 'Tree' };

let writes: string[];
beforeEach(() => {
  writes = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    writes.push(typeof input === 'string' ? input : input.toString());
    return { ok: true, json: async () => ({ ok: true }) } as unknown as Response;
  }));
  useEditorStore.setState({ editingPrefab: PREFAB });
});
afterEach(() => {
  setRunMode('stopped');
  useEditorStore.setState({ editingPrefab: null });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('savePrefabEdit refuses to write authored data out of a previewing world', () => {
  for (const mode of ['scrub', 'preview', 'playing'] as const) {
    it(`refuses in run-mode '${mode}', and writes NOTHING`, async () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      setRunMode(mode);

      await expect(savePrefabEdit()).resolves.toBe(false);

      // Not just "returned false": nothing may reach the disk, and the reason has to name the mode
      // — a bare false is indistinguishable from "prefab root not found", which needs the opposite
      // advice from the human.
      expect(writes).toEqual([]);
      expect(err.mock.calls.flat().join(' ')).toContain(mode);
    });
  }

  it('does NOT refuse when stopped — the guard must not be a wall', async () => {
    // The control case. Without it, "nothing was written" would pass just as happily if
    // savePrefabEdit were broken outright, and the guard would be vouching for a dead function.
    // It gets past the run-mode check and fails LATER (no prefab-edit world in this suite), which
    // is exactly what proves the mode check let it through.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    setRunMode('stopped');

    await expect(savePrefabEdit()).resolves.toBe(false);

    const msg = err.mock.calls.flat().join(' ');
    expect(msg).not.toContain("run-mode is");
    expect(msg).toMatch(/prefab root not found|no longer in the editor cache/);
  });
});
