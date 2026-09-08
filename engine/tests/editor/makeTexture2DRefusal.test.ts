/** #901 — "Make 2D" refuses on an unreadable sidecar, and the human is TOLD.
 *
 *  `makeTexture2D` is offered by the SpritePicker's spriteless-texture list. Both of its refusals
 *  — a failed `/api/read-meta`, and an ok response whose body is not an object — reported only to
 *  `console.error` and returned `false`. On screen: the click did nothing, no dialog, no toast.
 *  A correct guard and a dead menu item look identical.
 *
 *  ⚠️ **Toast, not an in-flow notice, and that is the rule rather than convenience.** This action
 *  owns no panel — it fires from a list and when it refuses nothing stays on screen to carry a
 *  banner. `panels/saveRefusal.ts` states the rule the two existing precedents imply: deliver
 *  where the human is looking; toast only when there is nowhere to look. The modal editors are the
 *  other side of that same rule.
 *
 *  ⚠️ **The refusals themselves must survive unchanged.** `/api/write-meta` replaces the sidecar
 *  wholesale, so converting from a failed read costs the asset its GUID and dangles every
 *  scene/prefab reference to it. Every test below asserts the write did NOT happen alongside the
 *  reporting — a fix that made the guard chatty and permissive would be worse than the silence. */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const backendFetch = vi.fn();
vi.mock('../../packages/modoki/src/editor/backend/editorBackend', () => ({
  backendFetch: (...a: unknown[]) => backendFetch(...a),
}));

const showToast = vi.fn();
vi.mock('../../packages/modoki/src/editor/store/editorStore', () => ({
  useEditorStore: { getState: () => ({ showToast }) },
}));

const flushPendingMetaFor = vi.fn(async (_p: string) => ({ saved: [], failed: [] }));
const writeMetaWholesale = vi.fn(async (_p: string, _m: unknown) => true);
vi.mock('../../packages/modoki/src/editor/scene/pendingMeta', () => ({
  flushPendingMetaFor: (p: string) => flushPendingMetaFor(p),
  writeMetaWholesale: (p: string, m: unknown) => writeMetaWholesale(p, m),
}));

vi.mock('../../packages/modoki/src/runtime/loaders/textureResolver', () => ({
  invalidateTexture: vi.fn(),
}));

const { makeTexture2D } = await import('../../packages/modoki/src/editor/panels/makeTexture2D');

beforeEach(() => {
  backendFetch.mockReset();
  showToast.mockReset();
  writeMetaWholesale.mockClear();
  flushPendingMetaFor.mockClear();
});

/** Every toast this module raises must be a warning — an 'info' toast is the colour that says
 *  "nothing to see", and colour is what gets read (the lesson `toastForSave` records). */
const warnToasts = () => showToast.mock.calls.filter(([, kind]) => kind === 'warn');

describe('makeTexture2D — a failed /api/read-meta', () => {
  it('refuses, does not write, and TELLS the human', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    backendFetch.mockResolvedValue({ ok: false, status: 500 });

    const ok = await makeTexture2D('/assets/rock.png');

    expect(ok, 'the refusal itself must not be softened by reporting it').toBe(false);
    expect(writeMetaWholesale, 'the sidecar must NOT be written from a failed read').not.toHaveBeenCalled();
    expect(warnToasts(), 'exactly one warning, not a flood and not silence').toHaveLength(1);
    expect(String(warnToasts()[0][0])).toMatch(/could not be read/i);
    // BOTH channels — the ruling was that the refusal must reach the human, not that the log was
    // wrong. The console keeps the path and the status for whoever is debugging.
    expect(err).toHaveBeenCalled();
    expect(String(err.mock.calls[0][0])).toContain('/assets/rock.png');
    err.mockRestore();
  });

  it('a network throw is reported the same way, not swallowed', async () => {
    // `backendFetch(...).catch(() => null)` collapses a throw to null, which reaches the same
    // branch. If that branch only handled `!res.ok`, a dev server that is DOWN would refuse
    // silently — the most likely real cause, reported least.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    backendFetch.mockRejectedValue(new Error('ECONNREFUSED'));

    expect(await makeTexture2D('/assets/rock.png')).toBe(false);
    expect(warnToasts()).toHaveLength(1);
    err.mockRestore();
  });
});

describe('makeTexture2D — an ok response whose body is not an object', () => {
  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'not json'],
  ])('refuses on %s, and says the settings did not parse', async (_label, body) => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    backendFetch.mockResolvedValue({ ok: true, json: async () => body });

    expect(await makeTexture2D('/assets/rock.png')).toBe(false);
    expect(writeMetaWholesale).not.toHaveBeenCalled();
    expect(warnToasts()).toHaveLength(1);
    expect(String(warnToasts()[0][0])).toMatch(/did not parse/i);
    err.mockRestore();
  });
});

describe('ACCEPT SIDE — a readable sidecar is converted in SILENCE', () => {
  // ⚠️ The half a "does it warn?" suite never proves, and the one that decides whether this fix is
  // an improvement. A seam that toasts unconditionally passes every assertion above while
  // interrupting every successful conversion — which trains people to dismiss the toast unread,
  // and then the real refusal goes unseen too. That is a worse bug than the silence being fixed.
  it('converts without raising a toast', async () => {
    backendFetch.mockImplementation(async (url: string) => (
      String(url).includes('/api/read-meta')
        ? { ok: true, json: async () => ({ id: 'abc-guid', format: 'ktx2-uastc' }) }
        : { ok: true, json: async () => ({ ok: true }) }
    ));

    const ok = await makeTexture2D('/assets/rock.png');

    expect(ok, 'a readable sidecar must still convert — the guard must not fail closed').toBe(true);
    expect(showToast, 'a successful conversion is not an event worth interrupting for')
      .not.toHaveBeenCalled();
  });
});
