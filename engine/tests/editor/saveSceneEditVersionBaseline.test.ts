/** `saveScene` must not claim an edit made DURING its disk write was saved (#573).
 *
 *  `markSceneSaved()` recorded `getEditVersion()` at CALL time — which, in `saveScene`, is on the
 *  far side of two awaits (`serializeScene`, then `writeFileToServer`; and on the Save-As path a
 *  NATIVE MODAL a human can leave open for as long as they like). The bytes written to disk were
 *  serialized BEFORE those awaits. So an edit landing inside the window was folded into the
 *  "matches disk" baseline without ever being written.
 *
 *  Why that is data loss and not a cosmetic flag: `hasUnsavedChanges()` reads this baseline, and
 *  its own doc comment names the consequence — it is the flag the game-code-reload gate checks
 *  before writing a `.ts` that force-reloads the editor (CLAUDE.md). Answering `false` over live,
 *  unwritten work is how that work gets discarded, and the same consequence was already fixed once
 *  at this site for a different cause (the partially-failed Save All term).
 *
 *  THE PRODUCTION CADENCE, stated because a red-green test proves nothing if its scenario cannot
 *  occur: the editor is a live app. `writeFileToServer` is a real `fetch` to the dev server, and
 *  the human keeps typing, dragging a gizmo, or running an agent op while it is in flight. No
 *  contrived scheduling is needed — only that an edit lands between serialize and the write
 *  resolving, which is an ordinary keystroke.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestWorld, type TestWorld, setPlayState, registerAsset } from '@modoki/engine/runtime';
import {
  clearHistory, clearDirtyAssets, pushAction, getEditVersion,
  saveScene, setCurrentScenePath, markSceneSaved, hasUnsavedChanges,
} from '@modoki/engine/editor';
import { registerAllTraits } from '../../app/ecs/registerTraits';

const SCENE_PATH = '/assets/scenes/baseline.json';

registerAllTraits();

let game: TestWorld | undefined;

/** A real edit: `pushAction` bumps the edit version for anything not a selection or file-direct
 *  action, which is exactly what a gizmo drag or a property change does. */
function makeAnEdit(): void {
  pushAction({ label: 'test edit', undo: () => {}, redo: () => {} });
}

beforeEach(() => {
  registerAsset('00000020-0000-4000-8000-000000000020', SCENE_PATH, 'scene');
  game = createTestWorld({});
  setPlayState('stopped');
  clearHistory();
  clearDirtyAssets();
  // Before setCurrentScenePath — it persists the path to localStorage for the next editor launch.
  vi.stubGlobal('localStorage', { setItem: () => {}, getItem: () => null, removeItem: () => {} });
  setCurrentScenePath(SCENE_PATH);
  markSceneSaved();
});

afterEach(() => {
  game?.dispose();
  vi.unstubAllGlobals();
});

describe('saveScene — the saved baseline is the version that was WRITTEN', () => {
  it('an edit landing during the disk write is still unsaved afterwards', async () => {
    // The human edits while the write is in flight. This is the whole defect.
    vi.stubGlobal('fetch', vi.fn(async () => {
      makeAnEdit();
      return { ok: true, json: async () => ({ ok: true }) } as unknown as Response;
    }));

    const before = getEditVersion();
    const result = await saveScene();
    expect(result.saved).toBe(true);
    // The edit really did land inside the window — otherwise this test proves nothing.
    expect(getEditVersion()).toBeGreaterThan(before);

    // Without the fix, markSceneSaved() read the POST-edit version and this is false: the editor
    // reports itself clean while the edit exists only in the live world.
    expect(hasUnsavedChanges()).toBe(true);
  });

  it('a save with no concurrent edit still reports clean', () => {
    // The positive case. Without it, the assertion above is satisfied by a baseline that is simply
    // always stale — a guard that never says "clean" is not a guard, it is a broken flag.
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) } as unknown as Response)));
    return saveScene().then((result) => {
      expect(result.saved).toBe(true);
      expect(hasUnsavedChanges()).toBe(false);
    });
  });
});
