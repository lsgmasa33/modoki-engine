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

import { persistAtlasDoc } from '../../src/editor/panels/assetViews/atlasPersist';
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
