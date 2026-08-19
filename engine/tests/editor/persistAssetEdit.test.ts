/** The Asset Inspector's write must not fail silently.
 *
 *  `persistAssetEdit` is how a material / shader / animset field edit reaches disk, and it never
 *  looked at the response: the cache invalidation and the panel refresh ran regardless, so a
 *  rejected write left the editor confidently showing a value the file does not have, with nothing
 *  but an unhandled promise rejection to show for it. That is the C7 class — never report a save
 *  that did not happen — on the one surface where it was still live after #259.
 *
 *  The optimistic update is deliberate and is asserted here too, so a later "fix" cannot quietly
 *  turn a failed write into a value the human loses.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { persistAssetEdit } from '../../packages/modoki/src/editor/panels/assetViews/persist';
import { useEditorStore } from '@modoki/engine/editor';

const PATH = '/assets/materials/rock.mat.json';
const DOC = { color: 0xff0000 };

// Typed explicitly: a bare `vi.fn()` infers a mock loose enough that it is not assignable to
// persistAssetEdit's `invalidate` param, and vitest TRANSPILES tests without checking them — so
// this passed at runtime and failed `npm run typecheck` (the gap engine/tsconfig.test.json exists
// to close).
type Invalidate = (path: string, updated: unknown) => void;
let invalidate: ReturnType<typeof vi.fn<Invalidate>>;
let err: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  invalidate = vi.fn<Invalidate>();
  err = vi.spyOn(console, 'error').mockImplementation(() => {});
  useEditorStore.setState({ toast: null });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const toast = () => useEditorStore.getState().toast;

describe('persistAssetEdit reports a write that did not land', () => {
  it('is silent on success — no error, no toast', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) } as unknown as Response)));

    await persistAssetEdit(PATH, DOC, invalidate);

    expect(err).not.toHaveBeenCalled();
    expect(toast()).toBeNull();
    expect(invalidate).toHaveBeenCalledWith(PATH, DOC);
  });

  it('names the file and the REASON when the backend refuses', async () => {
    // A 403 (path outside the asset roots) and a 500 need different fixes, so the route's own
    // message is preferred over a bare status.
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 403, json: async () => ({ error: 'path outside allowed directories' }),
    } as unknown as Response)));

    await persistAssetEdit(PATH, DOC, invalidate);

    expect(err.mock.calls.flat().join(' ')).toContain(PATH);
    expect(err.mock.calls.flat().join(' ')).toContain('path outside allowed directories');
    expect(toast()?.kind).toBe('warn');
    expect(toast()?.message).toMatch(/FAILED/);
  });

  it('falls back to the status when the body carries no message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) } as unknown as Response)));

    await persistAssetEdit(PATH, DOC, invalidate);

    expect(err.mock.calls.flat().join(' ')).toContain('HTTP 500');
  });

  it('reports a REJECTED write (no response at all) instead of leaving it unhandled', async () => {
    // The backend restarting mid-edit rejects the fetch outright. Before, this surfaced only as an
    // unhandled promise rejection — a class of failure the editor never showed anyone.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Failed to fetch'); }));

    await expect(persistAssetEdit(PATH, DOC, invalidate)).resolves.toBeUndefined();

    expect(err.mock.calls.flat().join(' ')).toContain('Failed to fetch');
    expect(toast()?.kind).toBe('warn');
  });

  it('still applies the edit LIVE when the write fails — it reports, it does not revert', async () => {
    // The value is not lost, and the next edit rewrites the whole file, so editing again IS the
    // retry. Snapping the Inspector back would destroy the human's work over a transient failure.
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) } as unknown as Response)));

    await persistAssetEdit(PATH, DOC, invalidate);

    expect(invalidate).toHaveBeenCalledWith(PATH, DOC);
  });
});
