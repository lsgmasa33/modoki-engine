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
