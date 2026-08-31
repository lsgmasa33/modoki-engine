/** atlasPersist's `persistAtlasDoc` (#308 close-out, part D-2) — the write+report AtlasAssetView's
 *  `update` callback used to inline directly in the component (`void writeAssetFile(...).then((ok)
 *  => { if (!ok) reportWriteFailed(...) })`), which meant it could only be covered by mounting the
 *  panel — forbidden per CLAUDE.md § Panels ("editor `.tsx` is not expected to carry tests"). Extracted
 *  into this plain `.ts` module so a failing write reports (console + toast) and a succeeding one
 *  stays silent, without rendering anything. Uses the REAL `useEditorStore` for the toast assertion,
 *  matching the rest of the suite's convention (`assetUndo.test.ts`). */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const writeAssetFileSpy = vi.fn();
vi.mock('../../src/editor/panels/assetOps', () => ({
  writeAssetFile: (...args: unknown[]) => writeAssetFileSpy(...args),
}));

import {
  persistAtlasDoc, classifyAtlasLoad, canPersistAtlasDoc, DEFAULT_ATLAS_DOC,
  atlasWriteIsSafe, persistAtlasDocIfUnchanged,
} from '../../src/editor/panels/assetViews/atlasPersist';
import { useEditorStore } from '../../src/editor/store/editorStore';

let consoleSpies: Array<{ mockRestore: () => void }> = [];
const spyConsole = (level: 'error' | 'warn') => {
  const s = vi.spyOn(console, level).mockImplementation(() => {});
  consoleSpies.push(s);
  return s;
};

beforeEach(() => {
  writeAssetFileSpy.mockReset();
  useEditorStore.setState({ toast: null });
});
afterEach(() => { for (const s of consoleSpies) s.mockRestore(); consoleSpies = []; });

describe('persistAtlasDoc', () => {
  it('writes the content and stays silent (no console, no toast) on success', async () => {
    const error = spyConsole('error');
    writeAssetFileSpy.mockResolvedValue(true);
    const result = await persistAtlasDoc('/a.atlas.json', '{"members":[]}\n');
    expect(writeAssetFileSpy).toHaveBeenCalledWith('/a.atlas.json', '{"members":[]}\n');
    expect(result).toBe(true);
    expect(error).not.toHaveBeenCalled();
    expect(useEditorStore.getState().toast).toBeNull();
  });

  it('reports (console error + toast) when the write is rejected', async () => {
    const error = spyConsole('error');
    writeAssetFileSpy.mockResolvedValue(false);
    const result = await persistAtlasDoc('/a.atlas.json', '{"members":[]}\n');
    expect(result).toBe(false);
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toContain('/a.atlas.json');
    const toast = useEditorStore.getState().toast;
    expect(toast).not.toBeNull();
    expect(toast!.kind).toBe('warn');
    expect(toast!.message).toContain('a.atlas.json');
  });
});

/** #430 — a failed/aborted load used to leave the panel silently editable on DEFAULT_ATLAS_DOC,
 *  so the first edit after a bad load overwrote the real `.atlas.json`. `classifyAtlasLoad` is
 *  the load effect's decision logic, extracted so it's covered without mounting the panel. */
describe('classifyAtlasLoad', () => {
  it('a non-ok HTTP response classifies as failed, with no doc to apply', () => {
    const result = classifyAtlasLoad({ kind: 'httpError' });
    expect(result).toEqual({ loadState: 'failed' });
  });

  it('a network throw classifies as failed', () => {
    const result = classifyAtlasLoad({ kind: 'networkError' });
    expect(result).toEqual({ loadState: 'failed' });
  });

  it('an abort classifies as null — not failed, caller does nothing', () => {
    const result = classifyAtlasLoad({ kind: 'aborted' });
    expect(result).toBeNull();
  });

  it('a well-formed body classifies as ok, normalized doc attached', () => {
    const body = { id: 'g1', version: 1, members: ['a', 'b'], pageSize: 512, padding: 1, extrude: 2 };
    const result = classifyAtlasLoad({ kind: 'ok', body });
    expect(result).toEqual({ loadState: 'ok', doc: body, raw: body });
  });

  it('a malformed body (missing/wrong-typed fields) still classifies as ok, normalized to defaults', () => {
    const body = { members: 'not-an-array', pageSize: 'big' };
    const result = classifyAtlasLoad({ kind: 'ok', body });
    expect(result).toEqual({
      loadState: 'ok',
      doc: {
        id: undefined, version: undefined,
        members: [],
        pageSize: DEFAULT_ATLAS_DOC.pageSize,
        padding: DEFAULT_ATLAS_DOC.padding,
        extrude: DEFAULT_ATLAS_DOC.extrude,
      },
      raw: body,
    });
  });

  it('an empty body (parsed `{}`) still classifies as ok — a loaded-empty atlas is editable, not failed', () => {
    const result = classifyAtlasLoad({ kind: 'ok', body: {} });
    expect(result?.loadState).toBe('ok');
  });

  // Review finding 4: a body that parses but isn't a plain object must not classify as 'ok' —
  // `{...raw}` / the `Partial<AtlasSourceDoc>` cast both assume an object, so `null`/an array/a
  // string/a number would otherwise be absorbed into a "valid" doc with no `id` (the #430 loss,
  // reached through a different response shape) or, for a string, spread character-by-character
  // into the written file.
  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'anything'],
    ['a number', 42],
  ])('a non-object JSON body (%s) classifies as failed', (_label, body) => {
    const result = classifyAtlasLoad({ kind: 'ok', body });
    expect(result).toEqual({ loadState: 'failed' });
  });

  it('an object body with wrong-typed fields is still ok — the empty-atlas distinction is the whole fix', () => {
    const result = classifyAtlasLoad({ kind: 'ok', body: { members: 'not-an-array', pageSize: 'big' } });
    expect(result?.loadState).toBe('ok');
  });
});

describe('canPersistAtlasDoc', () => {
  it('refuses while loading, even with a matching path', () => {
    expect(canPersistAtlasDoc('loading', '/a.atlas.json', '/a.atlas.json')).toBe(false);
  });

  it('refuses when the load failed, even with a matching path', () => {
    expect(canPersistAtlasDoc('failed', '/a.atlas.json', '/a.atlas.json')).toBe(false);
  });

  it('allows once loaded ok with a matching path', () => {
    expect(canPersistAtlasDoc('ok', '/a.atlas.json', '/a.atlas.json')).toBe(true);
  });

  // The finding that matters most: `loadState === 'ok'` is not enough on its own. A selection
  // change from atlas A to atlas B can repaint the panel with `loadState === 'ok'` still set from
  // A's load, A's `doc`/`rawDoc`, and `path` already updated to B — the window between the `path`
  // prop changing and B's load effect landing. A write in that window would serialize A's content
  // onto B's file, the exact loss #430 fixed, reached a different way.
  it('refuses when loadedPath !== path even with loadState === "ok" — the A-to-B selection window', () => {
    expect(canPersistAtlasDoc('ok', '/a.atlas.json', '/b.atlas.json')).toBe(false);
  });

  it('refuses when loadedPath is null (no load has landed yet) regardless of loadState', () => {
    expect(canPersistAtlasDoc('ok', null, '/a.atlas.json')).toBe(false);
  });
});

/** #439 — the compare-and-swap write guard. The panel writes the WHOLE `.atlas.json` document on
 *  every control interaction; nothing reliably notifies it of a same-path content change on disk
 *  (a `git checkout` under a live editor, CLAUDE.md's documented hazard), so the guarantee has to
 *  sit on the WRITE: re-read immediately before writing, and refuse if the file no longer matches
 *  what was last read. */
describe('atlasWriteIsSafe', () => {
  it('is safe when the current text still matches what was loaded', () => {
    expect(atlasWriteIsSafe('{"members":[]}\n', '{"members":[]}\n')).toBe(true);
  });

  it('refuses when the current text differs from what was loaded', () => {
    expect(atlasWriteIsSafe('{"members":[]}\n', '{"members":["a"]}\n')).toBe(false);
  });

  // `loadedText === null` means this panel never successfully read the file (or dropped its
  // baseline on a path change) — there's nothing to compare against, so "safe" cannot be true.
  it('refuses when loadedText is null', () => {
    expect(atlasWriteIsSafe(null, '{"members":[]}\n')).toBe(false);
  });

  // `currentText === null` means the re-read ITSELF failed (network error, file gone, etc.) — we
  // don't know what's on disk, and "we don't know" must never be treated as "go ahead and
  // overwrite the whole document". Refusing is the only answer that can't silently destroy data.
  it('refuses when currentText is null (the re-read failed)', () => {
    expect(atlasWriteIsSafe('{"members":[]}\n', null)).toBe(false);
  });

  it('refuses when both are null', () => {
    expect(atlasWriteIsSafe(null, null)).toBe(false);
  });
});

describe('persistAtlasDocIfUnchanged', () => {
  it('writes when the on-disk text still matches loadedText, and returns "written"', async () => {
    writeAssetFileSpy.mockResolvedValue(true);
    const readCurrent = vi.fn(async () => '{"members":[]}\n');

    const outcome = await persistAtlasDocIfUnchanged(
      '/a.atlas.json', '{"members":["x"]}\n', '{"members":[]}\n', readCurrent,
    );

    expect(outcome).toBe('written');
    expect(readCurrent).toHaveBeenCalledWith('/a.atlas.json');
    expect(writeAssetFileSpy).toHaveBeenCalledWith('/a.atlas.json', '{"members":["x"]}\n');
  });

  // The ticket's own repro: a `.atlas.json` whose `members` changed on disk (e.g. a `git
  // checkout` landing under a live editor) must NOT be overwritten by a subsequent padding nudge
  // the panel queued against the stale baseline it read before the checkout.
  it('#439 repro: members changed on disk under a live editor — a later padding nudge is refused, not written', async () => {
    const onDiskAfterCheckout = '{"members":["from-git-checkout"],"padding":1}\n';
    const readCurrent = vi.fn(async () => onDiskAfterCheckout);
    const staleLoadedText = '{"members":["original"],"padding":1}\n';
    const paddingNudgeContent = '{"members":["original"],"padding":2}\n';

    const outcome = await persistAtlasDocIfUnchanged(
      '/court.atlas.json', paddingNudgeContent, staleLoadedText, readCurrent,
    );

    expect(outcome).toBe('conflict');
    expect(writeAssetFileSpy).not.toHaveBeenCalled();
  });

  it('returns "conflict" and never writes when the on-disk text changed', async () => {
    const readCurrent = vi.fn(async () => '{"members":["changed"]}\n');

    const outcome = await persistAtlasDocIfUnchanged(
      '/a.atlas.json', '{"members":["x"]}\n', '{"members":[]}\n', readCurrent,
    );

    expect(outcome).toBe('conflict');
    expect(writeAssetFileSpy).not.toHaveBeenCalled();
  });

  it('returns "conflict" and never writes when the re-read resolves null', async () => {
    const readCurrent = vi.fn(async () => null);

    const outcome = await persistAtlasDocIfUnchanged(
      '/a.atlas.json', '{"members":["x"]}\n', '{"members":[]}\n', readCurrent,
    );

    expect(outcome).toBe('conflict');
    expect(writeAssetFileSpy).not.toHaveBeenCalled();
  });

  // The re-read must never propagate a throw out of the write path — an unhandled rejection here
  // would crash the panel's write handler instead of just refusing the write.
  it('returns "conflict" and never writes when the re-read throws', async () => {
    const readCurrent = vi.fn(async () => { throw new Error('network down'); });

    const outcome = await persistAtlasDocIfUnchanged(
      '/a.atlas.json', '{"members":["x"]}\n', '{"members":[]}\n', readCurrent,
    );

    expect(outcome).toBe('conflict');
    expect(writeAssetFileSpy).not.toHaveBeenCalled();
  });

  it('returns "failed" when the write itself is rejected', async () => {
    writeAssetFileSpy.mockResolvedValue(false);
    const readCurrent = vi.fn(async () => '{"members":[]}\n');

    const outcome = await persistAtlasDocIfUnchanged(
      '/a.atlas.json', '{"members":["x"]}\n', '{"members":[]}\n', readCurrent,
    );

    expect(outcome).toBe('failed');
    expect(writeAssetFileSpy).toHaveBeenCalledWith('/a.atlas.json', '{"members":["x"]}\n');
  });
});
