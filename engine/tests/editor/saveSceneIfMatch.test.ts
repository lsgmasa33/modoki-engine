/** #1695 — `saveScene({ ifMatch })` writes the open scene's file only while it holds the bytes with that hash, and
 *  reports the bytes it wrote. Apply's undo and redo save the scene through it, over what the OTHER half saved, so a
 *  change made to the file while its history was parked (a `modoki_mutate_scene`, a hand edit, a `git pull`) is not
 *  overwritten by the in-memory snapshot.
 *
 *  The route is a fake holding the exact bytes it received, with `/api/write-file`'s own if-match rule.
 *  Mutation: drop the `ifMatch` in `writePrimaryScene` (write unconditionally) — the refusal case goes red. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createTestWorld, type TestWorld, setPlayState, registerAsset } from '@modoki/engine/runtime';
import { clearHistory, clearDirtyAssets, pushAction, saveScene, setCurrentScenePath, markSceneSaved, hasUnsavedChanges } from '@modoki/engine/editor';
import { lastWrittenSceneBytes } from '../../packages/modoki/src/editor/scene/serialize';
import { registerAllTraits } from '../../app/ecs/registerTraits';

const SCENE_PATH = '/assets/scenes/ifmatch.json';
const sha = (t: string) => createHash('sha256').update(t).digest('hex');

registerAllTraits();

let game: TestWorld | undefined;
let disk: string | undefined;
let writes = 0;

beforeEach(() => {
  registerAsset('00000021-0000-4000-8000-000000001695', SCENE_PATH, 'scene');
  game = createTestWorld({});
  setPlayState('stopped');
  clearHistory();
  clearDirtyAssets();
  vi.stubGlobal('localStorage', { setItem: () => {}, getItem: () => null, removeItem: () => {} });
  setCurrentScenePath(SCENE_PATH);
  markSceneSaved();
  disk = '{"the":"file as it is on disk"}\n';
  writes = 0;
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: { body?: string }) => {
    const b = JSON.parse(init?.body ?? '{}') as { content?: string; ifMatch?: string };
    if (b.ifMatch !== undefined && (disk === undefined || sha(disk) !== b.ifMatch)) {
      return { ok: false, status: 409, json: async () => ({ ok: false, reason: 'if-match' }) } as unknown as Response;
    }
    writes++;
    disk = b.content;
    return { ok: true, status: 200, json: async () => ({ ok: true }) } as unknown as Response;
  }));
});

afterEach(() => {
  game?.dispose();
  vi.unstubAllGlobals();
});

describe('saveScene({ ifMatch }) — only over the bytes the caller expects (#1695)', () => {
  it('a file changed since is not overwritten: nothing is written, and the scene stays unsaved', async () => {
    pushAction({ label: 'an edit', undo: () => {}, redo: () => {} });
    const before = disk;
    const res = await saveScene({ ifMatch: sha('{"what":"the other half saved"}\n'), allowDialog: false });
    expect(res).toMatchObject({ saved: false, reason: 'conflict' });
    expect(disk).toBe(before);
    expect(writes).toBe(0);
    expect(hasUnsavedChanges()).toBe(true);
  });

  it('the bytes it expects are there: it writes, reports what it wrote, and the scene is saved', async () => {
    pushAction({ label: 'an edit', undo: () => {}, redo: () => {} });
    const res = await saveScene({ ifMatch: sha(disk!), allowDialog: false });
    expect(res.saved).toBe(true);
    expect(res.content).toBe(disk);
    expect(writes).toBe(1);
    expect(hasUnsavedChanges()).toBe(false);
  });

  // What Apply's undo keys its scene save on (#1695, close-out review): the editor's own LAST write to the file, from any
  // save — so the user's own Cmd+S is never read as an outside change. Mutation: drop the record in `writePrimaryScene`.
  it("every save of the editor's own is recorded as what it last wrote there; a refused one is not", async () => {
    await saveScene({ allowDialog: false });
    expect(lastWrittenSceneBytes(SCENE_PATH)).toBe(disk);
    const before = lastWrittenSceneBytes(SCENE_PATH);
    await saveScene({ ifMatch: sha('not what is there'), allowDialog: false });
    expect(lastWrittenSceneBytes(SCENE_PATH)).toBe(before);
  });
});
