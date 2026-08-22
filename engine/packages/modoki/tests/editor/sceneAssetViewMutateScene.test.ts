/** SceneAssetView's `mutateScene` (#308 close-out, part D-1) — a rejecting `backendFetch`
 *  used to throw straight out of an undo/redo closure. `undo()` (undoManager.ts) pops the
 *  action BEFORE awaiting it, so a throw skips `redoStack.push`/`notifyEdited`/the `!undo`
 *  journal event and loses the action from BOTH stacks. The fix wraps the request in a
 *  try/catch so a thrown fetch rejection resolves `{ok:false, errors}` like every other
 *  backend wrapper in `assetOps` (`writeAssetFile`/`deleteAssetFile`/… are each
 *  `try { … return res.ok } catch { return false }`) — this file pins that resolution,
 *  the HTTP-error branch, and the success branch. `mutateScene` is module-private in
 *  SceneAssetView.tsx and was exported (with the same "Exported for unit testing without
 *  mounting the component" comment `checkBaseSceneCycle` already carries in that file)
 *  purely so this is testable without rendering the panel. */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const backendFetch = vi.fn();
vi.mock('../../src/editor/backend/editorBackend', () => ({
  backendFetch: (...args: unknown[]) => backendFetch(...args),
}));

import { mutateScene } from '../../src/editor/panels/assetViews/SceneAssetView';

beforeEach(() => { backendFetch.mockReset(); });

describe('mutateScene', () => {
  it('resolves {ok:true} on a successful setBaseScene call', async () => {
    backendFetch.mockResolvedValue({
      ok: true, status: 200, json: async () => ({ ok: true, errors: [] }),
    });
    const result = await mutateScene('/level.json', 'g-base');
    expect(result).toEqual({ ok: true, errors: [] });
    expect(backendFetch).toHaveBeenCalledWith('/api/scene-mutate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/level.json', ops: [{ op: 'setBaseScene', baseScene: 'g-base' }] }),
    });
  });

  // The real backend answers a non-2xx `/api/scene-mutate` failure with a SINGULAR `error`
  // string, not an `errors` array (see editorBackendRouter.ts's `json({error:...}, 4xx)` sites
  // for this route — "path outside allowed directories", "scene not found: …", etc.) — so this
  // pins the singular-`error` fallback specifically, not the `errors`-array branch (which the
  // ok:false-at-200 test below exercises instead; the two must not be conflated, since `??`
  // short-circuits on `body.errors` and would silently never reach `body.error` otherwise).
  it('resolves {ok:false} with the route\'s (singular) error body on an HTTP error, without throwing', async () => {
    backendFetch.mockResolvedValue({
      ok: false, status: 403, json: async () => ({ error: 'path outside allowed directories' }),
    });
    const result = await mutateScene('/level.json', 'g-base');
    expect(result).toEqual({ ok: false, errors: ['path outside allowed directories'] });
  });

  it('resolves {ok:false} with an HTTP-status fallback when the body carries no `error`', async () => {
    backendFetch.mockResolvedValue({
      ok: false, status: 500, json: async () => ({}),
    });
    const result = await mutateScene('/level.json', 'g-base');
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(['HTTP 500']);
  });

  // The defect this test guards: a THROWN backendFetch rejection (network failure, the
  // backend restarting) used to propagate out of this function and, through it, out of an
  // undo/redo closure — the one failure mode #308's `reportUndoFailure` design explicitly
  // rules out. It must resolve, not reject.
  it('resolves {ok:false} instead of throwing when backendFetch REJECTS', async () => {
    backendFetch.mockRejectedValue(new Error('network down'));
    await expect(mutateScene('/level.json', 'g-base')).resolves.toEqual({ ok: false, errors: ['network down'] });
  });

  it('resolves {ok:false} when the HTTP status is 200 but the BODY itself reports ok:false', async () => {
    // e.g. a cycle refusal the route answers without a non-2xx status.
    backendFetch.mockResolvedValue({
      ok: true, status: 200, json: async () => ({ ok: false, errors: ['would create a cycle'] }),
    });
    const result = await mutateScene('/level.json', 'g-base');
    expect(result).toEqual({ ok: false, errors: ['would create a cycle'] });
  });

  it('clearing the base (null) sends baseScene: null', async () => {
    backendFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) });
    await mutateScene('/level.json', null);
    const body = JSON.parse((backendFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({ path: '/level.json', ops: [{ op: 'setBaseScene', baseScene: null }] });
  });
});
