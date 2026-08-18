/** `writeMetaOrWarn` must be AWAITABLE, and the asset-editor modals must await it before closing.
 *
 *  WHY. It returned `void`, so the write could not be sequenced. `NineSliceEditor.save()` and
 *  `SpriteEditor.save()` both did `writeMetaOrWarn(path, meta)` and then `onClose()` — and the
 *  Inspector's onClose handler re-reads that same file (`loadMeta()`). Two HTTP requests over one
 *  file with no ordering between them: when the GET won, the edit was on disk and the Inspector
 *  showed the PRE-edit numbers, permanently, with nothing indicating why.
 *
 *  Intermittent by construction, which is what made it expensive: reported as "editing the
 *  9-slice doesn't change the Inspector values", it did NOT reproduce on the first live attempt
 *  (the POST happened to win), and only showed itself on a later run against the same build.
 *  A racing pair like this cannot be pinned by driving the UI and hoping — so these tests pin the
 *  two things that actually make it impossible: the function hands back a promise, and the two
 *  save paths await it before the close callback that triggers the read.
 *
 *  `EnvironmentAssetView` was ALREADY writing `await writeMetaOrWarn(...)` against the `void`
 *  signature — an await that resolved instantly and sequenced nothing. The intent was there and
 *  the type silently defeated it, which is the strongest argument for the promise return. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const EDITOR = path.resolve(__dirname, '../../packages/modoki/src/editor');
const read = (rel: string) => readFileSync(path.join(EDITOR, rel), 'utf-8');

// ── The runtime half: the write is a promise that resolves only after the POST settles. ──
const backendFetch = vi.fn();
vi.mock('../../packages/modoki/src/editor/backend/editorBackend', () => ({
  backendFetch: (...a: unknown[]) => backendFetch(...a),
}));

const { writeMetaOrWarn } = await import('../../packages/modoki/src/editor/panels/assetViews/widgets');

// No `vi.restoreAllMocks()` in an afterEach: it also strips the implementation off the module
// mock's `vi.fn()`, so a later test's `backendFetch(...)` returned undefined and
// `undefined.then(...)` threw synchronously out of writeMetaOrWarn — a failure that looks like
// the code under test and is not. Each test sets its own implementation; spies restore locally.
beforeEach(() => backendFetch.mockReset());

describe('writeMetaOrWarn is sequenceable', () => {
  it('does not resolve until the POST has settled — the whole point', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    backendFetch.mockReturnValue(gate.then(() => ({ ok: true })));

    let settled = false;
    const p = writeMetaOrWarn('/assets/t.png', { border: { l: 1 } }).then((ok) => { settled = true; return ok; });

    await Promise.resolve();
    expect(settled).toBe(false);        // still in flight — a caller awaiting it has NOT proceeded
    release();
    expect(await p).toBe(true);
  });

  it('resolves false and logs when the backend rejects the write', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      backendFetch.mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' });
      expect(await writeMetaOrWarn('/assets/t.png', {})).toBe(false);
      expect(err).toHaveBeenCalledTimes(1);
    } finally { err.mockRestore(); }
  });

  it('resolves false and logs when the transport fails, rather than rejecting', async () => {
    // A rejecting promise would make `await writeMetaOrWarn(...)` throw out of save() and skip
    // onClose() — the dialog would hang open on a dev-server blip. Swallow-and-report instead.
    //
    // The failure is injected from INSIDE the response rather than by rejecting the mock itself:
    // a mock that returns a rejected promise leaves that promise in vitest's `mock.results` with
    // no handler on THAT reference, which the runner reports as an unhandled rejection and
    // attributes to this test — a red test with a green subject. Same `.catch` branch either way.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      backendFetch.mockResolvedValue({ get ok(): boolean { throw new Error('offline'); } });
      expect(await writeMetaOrWarn('/assets/t.png', {})).toBe(false);
      expect(err).toHaveBeenCalledTimes(1);
      expect(String(err.mock.calls[0][0])).toContain('network error');
    } finally { err.mockRestore(); }
  });
});

// ── The call-site half: a source check, because these live in .tsx save handlers whose only
//    other cover would be mounting PixiJS/canvas in jsdom (which asserts the mock, not the app).
describe('the asset-editor modals await the write before closing', () => {
  it('NineSliceEditor marks the edit saved from the WRITE RESULT, never unconditionally', () => {
    // Found reviewing this change: `savedRef.current = true` after the await ignored a FAILED
    // write. The modal still closes, so marking it saved skipped the unmount revert and left the
    // live sprite holding a border that never reached disk — the exact divergence
    // `nineSliceRevert` exists to prevent, reintroduced on the error path.
    const src = read('panels/NineSliceEditor.tsx');
    expect(src).not.toMatch(/savedRef\.current = true/);
    expect(src).toMatch(/const persisted = await writeMetaOrWarn\(/);
    expect(src).toMatch(/savedRef\.current = persisted/);
  });

  for (const rel of ['panels/NineSliceEditor.tsx', 'panels/SpriteEditor.tsx']) {
    it(`${rel} awaits writeMetaOrWarn`, () => {
      expect(read(rel)).toMatch(/await writeMetaOrWarn\(/);
    });

    it(`${rel}'s save is async, so the await actually suspends it`, () => {
      expect(read(rel)).toMatch(/const save = async \(\) =>/);
    });

    it(`${rel} does NOT close when the write fails — the edit must survive a dev-server blip`, () => {
      // Owner's call (2026-08-18): keep the dialog open and log. Closing on a failed write throws
      // the edit away for a reason that has nothing to do with the edit, with no way to retry.
      // Structural, because the ORDER is the behaviour: the bail must sit between the awaited
      // write and onClose(), not after it.
      const src = read(rel);
      const write = src.indexOf('await writeMetaOrWarn(');
      const bail = src.indexOf('if (!persisted)', write);
      const close = src.indexOf('onClose();', write);
      expect(bail).toBeGreaterThan(write);
      expect(bail).toBeLessThan(close);
      expect(src.slice(bail, close)).toMatch(/console\.error\(/);   // and it says so, loudly
      expect(src.slice(bail, close)).toMatch(/\breturn;/);
    });

    it(`${rel} calls onClose only AFTER the awaited write`, () => {
      // Ordering matters, not just presence: awaiting the write and then closing FIRST in the
      // source would reintroduce the race.
      const src = read(rel);
      const write = src.indexOf('await writeMetaOrWarn(');
      const close = src.indexOf('onClose();', write);
      expect(write).toBeGreaterThan(-1);
      expect(close).toBeGreaterThan(write);
    });
  }
});
