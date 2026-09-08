/** #901 member 4 — the endpoint's failed-read refusal reaches the human.
 *
 *  `writeMetaConditional` is the ONE `/api/write-meta` POST implementation, shared by the eight
 *  explicit-action writers and by both modal editors. It refuses before issuing the request when
 *  the document it was handed came from a failed read — a wholesale write would replace the sidecar
 *  with a document carrying no GUID, the scanner's heal pass would mint a fresh one, and every
 *  scene/prefab reference to that asset would dangle. Correct, load-bearing, and reported only to
 *  `console.error`.
 *
 *  ## ⚠️ Why a toast here, and why NOT a structured flag
 *
 *  The first fix for this was a `MetaWriteResult.unreadable` flag, carried into
 *  `MetaFlushResult.failed` and given its own `toastForSave` sentence — modelled on `conflict`,
 *  which works exactly that way. **It was unreachable, and its tests passed.** Two independent
 *  reasons, either alone fatal:
 *
 *   1. **Every caller collapses the result.** `writeMetaOrWarn` is `.then((r) => r.ok)` and
 *      `writeMetaWholesale` goes through it, so nothing downstream can read a flag on
 *      `MetaWriteResult` at all.
 *   2. **The flush cannot produce this failure.** `classifyMetaPark` refuses a failed-read document
 *      at PARK time, so the pending map never holds one and `flushPendingMeta` never writes one —
 *      pinned by `pendingMeta.test.ts` § "the flush can NEVER carry a failed-read document".
 *
 *  The `toastForSave` tests passed throughout because they hand-built the outcome with the flag
 *  already set. Deleting either middle link left them green. The mechanism has to be reported where
 *  the refusal HAPPENS, and this endpoint owns no panel, so it toasts — the same rule
 *  `panels/saveRefusal.ts` states for the modal editors, applied to the case with nowhere to look.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const backendFetch = vi.fn();
vi.mock('../../packages/modoki/src/editor/backend/editorBackend', () => ({
  backendFetch: (url: string, init?: unknown) => backendFetch(url, init),
}));

const showToast = vi.fn();
vi.mock('../../packages/modoki/src/editor/store/editorStore', () => ({
  useEditorStore: { getState: () => ({ showToast }) },
}));

const { writeMetaConditional, writeMetaOrWarn } = await import(
  '../../packages/modoki/src/editor/panels/assetViews/widgets'
);
const { metaReadFallback, stampMetaReadPath } = await import(
  '../../packages/modoki/src/editor/scene/metaReadFallback'
);

const PATH = '/assets/textures/rock.png';

beforeEach(() => {
  backendFetch.mockReset();
  showToast.mockReset();
});

const warnToasts = () => showToast.mock.calls.filter(([, kind]) => kind === 'warn');

describe('writeMetaConditional refuses a failed-read document, and SAYS SO', () => {
  it('refuses, POSTs nothing, and raises exactly one warning', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    const r = await writeMetaConditional(PATH, metaReadFallback());

    expect(r.ok, 'the refusal must not be softened by reporting it').toBe(false);
    expect(r.conflict, 'a refused read is not a 409').toBe(false);
    expect(backendFetch, 'the whole point — a wholesale write must never leave').not.toHaveBeenCalled();

    expect(warnToasts(), 'one warning: not silent, not a flood').toHaveLength(1);
    const text = String(warnToasts()[0][0]);
    expect(text).toMatch(/never read|could not be read/i);
    expect(text, 'the remedy, or the human is told something happened and not what to do')
      .toMatch(/reselect|re-read/i);

    // BOTH channels. #890/#891's ruling is that the refusal must reach the HUMAN — not that the
    // log line was wrong. The console keeps the path for whoever is debugging.
    expect(err).toHaveBeenCalled();
    expect(String(err.mock.calls[0][0])).toContain(PATH);
    err.mockRestore();
  });

  it('the toast survives the boolean collapse every caller applies', async () => {
    // ⚠️ THE REGRESSION THIS FILE EXISTS FOR. `writeMetaOrWarn` — what `SpriteEditor.save`,
    // `NineSliceEditor.save` and `writeMetaWholesale` all call — is `.then((r) => r.ok)`. A fix
    // that reported through the RESULT is erased exactly here, silently. Reporting at the refusal
    // is what makes it survive, so assert it through the collapsing wrapper rather than only
    // through the structured one.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    const wrote = await writeMetaOrWarn(PATH, metaReadFallback());

    expect(wrote).toBe(false);
    expect(warnToasts(), 'the human hears about it even though the caller sees only `false`')
      .toHaveLength(1);
    err.mockRestore();
  });

  it('a missing toast host cannot swallow the refusal', async () => {
    // The guard must behave identically whether or not anything is listening. A reporting failure
    // that let the write through would be strictly worse than the silence being fixed.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    showToast.mockImplementation(() => { throw new Error('no toast host'); });

    const r = await writeMetaConditional(PATH, metaReadFallback());

    expect(r.ok).toBe(false);
    expect(backendFetch).not.toHaveBeenCalled();
    err.mockRestore();
  });
});

describe('ACCEPT SIDE — a properly-read document is written in SILENCE', () => {
  // ⚠️ The half that decides whether this is an improvement. A seam that toasts unconditionally
  // passes every assertion above while interrupting every successful write, which trains people to
  // dismiss the toast unread — and then the real refusal goes unseen too.
  it('writes, and raises no toast', async () => {
    backendFetch.mockResolvedValue({
      ok: true, status: 200, json: async () => ({ sha256: 'abc' }), text: async () => '',
    });

    const doc = stampMetaReadPath({ id: 'guid-1', maxSize: 512 }, PATH);
    const r = await writeMetaConditional(PATH, doc);

    expect(r.ok, 'a readable document must still be written — the guard must not fail closed').toBe(true);
    expect(backendFetch).toHaveBeenCalled();
    expect(showToast, 'a successful write is not an event worth interrupting for').not.toHaveBeenCalled();
  });

  it('a SERVER failure is not dressed as a failed-read refusal', async () => {
    // The two have opposite remedies: a 500 should be retried, a failed read cannot be. If this
    // branch also toasted "reselect the asset", a human with a flaky dev server would be sent to do
    // something useless — the same misdirection, one branch over.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    backendFetch.mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' });

    const doc = stampMetaReadPath({ id: 'guid-1' }, PATH);
    const r = await writeMetaConditional(PATH, doc);

    expect(r.ok).toBe(false);
    expect(backendFetch, 'this one really was attempted').toHaveBeenCalled();
    for (const [text] of warnToasts()) {
      expect(String(text), 'a 500 must not carry the re-read remedy').not.toMatch(/reselect/i);
    }
    err.mockRestore();
  });
});
