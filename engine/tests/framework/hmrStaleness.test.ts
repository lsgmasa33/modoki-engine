// @vitest-environment jsdom
/**
 * hmrStaleness — the RENDERER half of the game-code HMR fix.
 *
 * WHY THIS FILE MATTERS MORE THAN ITS SIZE SUGGESTS. This module owns the only code path
 * in the engine that can deliberately destroy a user's unsaved work, and the only signal
 * (`discardedUnsavedEdits` / `!hmr.discarded-unsaved`) that docs tell agents to trust when
 * deciding whether an editor's measurements are stale. Both were previously untested: the
 * one existing test covered the dev-SERVER hook (which signal is sent), not what the
 * renderer does with it.
 *
 * The module takes its hot context and its dirty-probe as parameters precisely so this is
 * testable — `import.meta.hot` is undefined under vitest, so without those seams every
 * branch below would be unreachable from a test.
 *
 * `location.reload` is not implementable in jsdom, so it is replaced with a spy per test.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readScannedSource } from '@modoki/engine/testing';
import { flatText, importsIn, lineOf, parseSource } from '@modoki/engine/testing/sourceAst';
import type { HotLike } from '../../app/debug/hmrStaleness';

// Type-only reference (not a value import) — keeps this test file, like the module it covers,
// free of a runtime `@modoki/engine` binding.
type UnsavedCauses = import('../../app/debug/hmrStaleness').UnsavedCauses;

// A `vi.hoisted` mock, not a plain `vi.fn()` inside the factory: this file's `beforeEach` calls
// `vi.resetModules()` per test (each test gets a fresh `hmrStaleness` module instance so
// `status` doesn't leak between tests — see below), and a factory-local `vi.fn()` would be
// RE-CREATED on every reset, plus `journal()`'s dynamic `import('@modoki/engine/editor')` and
// this file's own import of the same specifier were observed to resolve to two DIFFERENT module
// instances under that reset (same class of bug as "an /@fs import gives a second module
// instance" — see the engine memory notes). Holding the one mock outside the factory sidesteps
// both: there is exactly one `editorEmitMock` for the whole file, cleared per test.
const { editorEmitMock } = vi.hoisted(() => ({ editorEmitMock: vi.fn() }));
vi.mock('@modoki/engine/editor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@modoki/engine/editor')>();
  return { ...actual, editorEmit: editorEmitMock };
});

// `status` is module-level and deliberately STICKY for the life of a page (an agent reading
// get_editor_state later must still learn that work was dropped). That is right in
// production — initHmrStaleness runs once per page load — but it would leak between tests,
// so each test gets a fresh module instance instead of a test-only reset export.
type Mod = typeof import('../../app/debug/hmrStaleness');
let initHmrStaleness: Mod['initHmrStaleness'];
let getHmrStatus: Mod['getHmrStatus'];

const DISCARDED_KEY = 'modoki:hmr-discarded';
const BANNER_ID = 'modoki-hmr-banner';

/** A stand-in for Vite's hot context that lets a test fire HMR events by hand. */
function fakeHot(): HotLike & { emit: (event: string, payload?: unknown) => void } {
  const handlers = new Map<string, ((p: never) => void)[]>();
  return {
    on: (event, cb) => {
      const list = handlers.get(event) ?? [];
      list.push(cb);
      handlers.set(event, list);
    },
    emit: (event, payload) => {
      for (const cb of handlers.get(event) ?? []) (cb as (p: unknown) => void)(payload);
    },
  };
}

let reload: ReturnType<typeof vi.fn>;

const banner = () => document.getElementById(BANNER_ID);
const bannerText = () => banner()?.textContent ?? '';
const clickButton = (label: string): void => {
  const btn = [...(banner()?.querySelectorAll('button') ?? [])]
    .find((b) => b.textContent === label);
  if (!btn) throw new Error(`no "${label}" button; banner reads: ${bannerText()}`);
  btn.click();
};
/** Let the handler's awaits settle — the dirty probe is async by design. */
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(async () => {
  vi.resetModules();
  editorEmitMock.mockClear();
  ({ initHmrStaleness, getHmrStatus } = await import('../../app/debug/hmrStaleness'));
  vi.useFakeTimers({ shouldAdvanceTime: true });
  reload = vi.fn();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, reload },
  });
  sessionStorage.clear();
  document.getElementById(BANNER_ID)?.remove();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('game code changed — clean scene', () => {
  it('reloads immediately, with no banner and no discard record', async () => {
    const hot = fakeHot();
    initHmrStaleness(hot, () => false);
    hot.emit('modoki:game-code-changed', { file: '/g/runtime/systems.ts' });
    await settle();

    expect(reload).toHaveBeenCalledTimes(1);
    expect(banner()).toBeNull();
    // Nothing was lost, so nothing may be reported as lost.
    expect(sessionStorage.getItem(DISCARDED_KEY)).toBeNull();
  });
});

describe('game code changed — dirty scene', () => {
  it('does NOT reload during the grace window, and warns that work will be lost', async () => {
    const hot = fakeHot();
    initHmrStaleness(hot, () => ({ sceneDirty: true }));
    hot.emit('modoki:game-code-changed', { file: '/g/runtime/systems.ts' });
    await settle();

    expect(reload).not.toHaveBeenCalled();
    expect(bannerText()).toContain('unsaved scene changes will be LOST');

    vi.advanceTimersByTime(2000);
    expect(reload, 'must still be counting down at 2s').not.toHaveBeenCalled();
  });

  it('takes the loss when the countdown expires, and records it for the next page', async () => {
    const hot = fakeHot();
    initHmrStaleness(hot, () => ({ sceneDirty: true }));
    hot.emit('modoki:game-code-changed', { file: '/g/runtime/systems.ts' });
    await settle();

    vi.advanceTimersByTime(5200);
    await settle();

    expect(reload).toHaveBeenCalledTimes(1);
    const rec = JSON.parse(sessionStorage.getItem(DISCARDED_KEY) ?? 'null');
    expect(rec?.file).toBe('/g/runtime/systems.ts');
  });

  it('SAVING during the grace window means no discard is recorded', async () => {
    // Saving is an advertised response to the banner, so this is the COMMON case — and
    // recording a discard that never happened would poison the exact signal agents are
    // told to trust. The flag must be re-read at reload time, not captured 5s earlier.
    let dirty: UnsavedCauses | false = { sceneDirty: true };
    const hot = fakeHot();
    initHmrStaleness(hot, () => dirty);
    hot.emit('modoki:game-code-changed', { file: '/g/runtime/systems.ts' });
    await settle();

    dirty = false; // user hits Cmd+S while the banner counts down
    vi.advanceTimersByTime(5200);
    await settle();

    expect(reload).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(DISCARDED_KEY), 'nothing was lost, so nothing may be claimed lost')
      .toBeNull();
  });

  it('"Reload now" discards immediately', async () => {
    const hot = fakeHot();
    initHmrStaleness(hot, () => ({ sceneDirty: true }));
    hot.emit('modoki:game-code-changed', { file: '/g/a.ts' });
    await settle();

    clickButton('Reload now');
    await settle();

    expect(reload).toHaveBeenCalledTimes(1);
    expect(JSON.parse(sessionStorage.getItem(DISCARDED_KEY) ?? 'null')?.file).toBe('/g/a.ts');
  });

  it('"Cancel" keeps the edits, skips the reload, and marks the editor STALE', async () => {
    const hot = fakeHot();
    initHmrStaleness(hot, () => ({ sceneDirty: true }));
    hot.emit('modoki:game-code-changed', { file: '/g/a.ts' });
    await settle();

    clickButton('Cancel');
    vi.advanceTimersByTime(10_000); // the countdown must be dead, not merely paused

    expect(reload).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(DISCARDED_KEY)).toBeNull();
    // This is the state where measurements silently lie, so it must be reported.
    expect(getHmrStatus().staleGameCode).toBe(true);
    expect(bannerText()).toContain('STALE');
  });
});

describe('reporting a discard the PREVIOUS page took', () => {
  it('consumes the record on boot, surfaces it, and does not re-report it', async () => {
    sessionStorage.setItem(DISCARDED_KEY, JSON.stringify({ file: '/g/x.ts', at: 1 }));

    initHmrStaleness(fakeHot(), () => false);
    await settle();

    expect(getHmrStatus().discardedUnsavedEdits).toBe(true);
    expect(bannerText()).toContain('discarded');
    // Consumed, so a later reload does not claim a second, phantom loss.
    expect(sessionStorage.getItem(DISCARDED_KEY)).toBeNull();
  });

  it('stays silent when there is no record', async () => {
    initHmrStaleness(fakeHot(), () => false);
    await settle();
    expect(getHmrStatus().discardedUnsavedEdits).toBe(false);
    expect(banner()).toBeNull();
  });
});

describe('no hot context (a shipped game build)', () => {
  it('is completely inert', async () => {
    initHmrStaleness(undefined, () => ({ sceneDirty: true }));
    await settle();
    expect(reload).not.toHaveBeenCalled();
    expect(banner()).toBeNull();
  });
});

describe('shader code changed (postfx/npr TSL)', () => {
  /** The shader-graph twin of the game-code reload. TSL nodes bake into a compiled WGSL
   *  pipeline, so a hot patch leaves the OLD graph rendering and a correct fix reads as
   *  "didn't work" — the same lying-measurement failure class, and therefore the same policy:
   *  reload, but never silently at the cost of unsaved scene work. */
  it('reloads immediately when the scene is clean', async () => {
    const hot = fakeHot();
    initHmrStaleness(hot, () => false);
    hot.emit('modoki:shader-code-changed', { file: '/e/runtime/rendering/postfx/dofViewZ.ts' });
    await settle();

    expect(reload).toHaveBeenCalledTimes(1);
    expect(banner()).toBeNull();
    expect(sessionStorage.getItem(DISCARDED_KEY)).toBeNull();
  });

  it('warns before discarding unsaved scene work, naming the shader edit', async () => {
    const hot = fakeHot();
    initHmrStaleness(hot, () => ({ sceneDirty: true }));
    hot.emit('modoki:shader-code-changed', { file: '/e/runtime/rendering/npr/edgeNodes.ts' });
    await settle();

    expect(reload).not.toHaveBeenCalled();
    expect(bannerText()).toContain('Shader code changed');
    expect(bannerText()).toContain('unsaved scene changes will be LOST');

    vi.advanceTimersByTime(5200);
    await settle();
    expect(reload).toHaveBeenCalledTimes(1);
    const rec = JSON.parse(sessionStorage.getItem(DISCARDED_KEY) ?? 'null');
    expect(rec?.file).toBe('/e/runtime/rendering/npr/edgeNodes.ts');
  });

  it('Cancel marks the editor STALE — measurements from it are not to be trusted', async () => {
    const hot = fakeHot();
    initHmrStaleness(hot, () => ({ sceneDirty: true }));
    hot.emit('modoki:shader-code-changed', { file: '/e/runtime/rendering/postfx/PostFXStack.ts' });
    await settle();

    clickButton('Cancel');
    await settle();

    expect(reload).not.toHaveBeenCalled();
    expect(getHmrStatus().staleGameCode).toBe(true);
    expect(bannerText()).toContain('STALE');
  });

  it('still handles a game-code change — the two producers share one handler', async () => {
    const hot = fakeHot();
    initHmrStaleness(hot, () => false);
    hot.emit('modoki:game-code-changed', { file: '/g/runtime/systems.ts' });
    await settle();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

// #850 — the countdown named a fixed cause ("unsaved scene changes") written when the scene was
// the only thing that COULD be unsaved. Since #831/#845, a parked asset/base-scene/import-setting
// edit sets the same flag with `sceneDirty: false`, so the fixed string was already wrong before
// this fix. These tests pin the correction: the message is BUILT from whatever `unsavedChangeCauses()`
// (the real shape, mirrored here as `UnsavedCauses`) actually reports, not hand-listed.
describe('the countdown names the ACTUAL cause, not a fixed one (#850)', () => {
  it('names a parked asset edit and does NOT say "scene" when the scene itself is clean', async () => {
    const hot = fakeHot();
    // sceneDirty is false: only a parked asset edit (e.g. a material saved to the dirty-asset
    // registry, not disk) is pending. Mutating a careless fix's cause-check to `sceneDirty:
    // true` here would falsely turn this red — see the mutation-check note in the report.
    initHmrStaleness(hot, () => ({ sceneDirty: false, dirtyAssetPaths: ['games/x/materials/foo.mat.json'] }));
    hot.emit('modoki:game-code-changed', { file: '/g/a.ts' });
    await settle();

    expect(bannerText()).toContain('asset edit');
    // The negative half is what makes the mutation check bite (#844 precedent) — a fix that
    // renders the OLD fixed string alongside the new cause would still pass the positive half.
    expect(bannerText()).not.toContain('scene');
  });

  it('names BOTH causes when the scene AND a parked asset edit are dirty', async () => {
    const hot = fakeHot();
    initHmrStaleness(hot, () => ({ sceneDirty: true, dirtyAssetPaths: ['games/x/materials/foo.mat.json'] }));
    hot.emit('modoki:game-code-changed', { file: '/g/a.ts' });
    await settle();

    expect(bannerText()).toContain('unsaved scene changes');
    expect(bannerText()).toContain('asset edit');
  });

  it('the !hmr.discarded-unsaved journal event carries the cause', async () => {
    // Pre-warm the module `journal()` dynamically imports. `vi.resetModules()` (beforeEach)
    // forces a full cold re-transform of the editor barrel on the FIRST import each test,
    // which can take real wall-clock time a fixed `setTimeout(0)` settle() cannot reliably
    // outlast — awaiting it here first means `journal()`'s own import resolves same-tick.
    await import('@modoki/engine/editor');

    // The event fires on the NEXT page's boot (§0 — "report a loss the PREVIOUS page took"),
    // reading the record the discarding page left in sessionStorage — same setup as "reporting
    // a discard the PREVIOUS page took" above, but now with a `causes` payload to check.
    sessionStorage.setItem(DISCARDED_KEY, JSON.stringify({
      file: '/g/a.ts', at: 1, causes: { dirtyAssetPaths: ['games/x/materials/foo.mat.json'] },
    }));

    initHmrStaleness(fakeHot(), () => false);
    await settle();

    expect(editorEmitMock).toHaveBeenCalledWith('!hmr.discarded-unsaved', {
      file: '/g/a.ts',
      causes: { dirtyAssetPaths: ['games/x/materials/foo.mat.json'] },
    });
  });

  it('a cause this module has never seen still appears in the message, unedited', async () => {
    // The whole point: `unsavedChangeCauses()` growing a SIXTH field must not require touching
    // hmrStaleness.ts. This probe reports a key CAUSE_LABELS has no entry for — proving the
    // enumeration is real, not a longer hand-written list that happens to cover five keys today.
    const hot = fakeHot();
    initHmrStaleness(hot, () => ({ aBrandNewFutureCause: true }));
    hot.emit('modoki:game-code-changed', { file: '/g/a.ts' });
    await settle();

    // Humanized fallback (camelCase → spaced words), not a silent drop and not a raw key dump.
    expect(bannerText()).toContain('a brand new future cause');
  });
});

/** The module edges a file writes to `@modoki/engine` or any subpath of it, by kind (#1179).
 *
 *  This was a line filter — a line starting `import` and not `import(` must not mention the package —
 *  which a wrapped `import {\n  x,\n} from '@modoki/engine/editor'` passed (its `from` line does not
 *  start with `import`), and which never looked at `export … from`. It still counts `import type` as
 *  static, as the line filter did: the rule is "only the dynamic import", and a type import is how a
 *  value import starts. */
export function engineEdges(code: string, label: string): { static: string[]; dynamicEditor: number } {
  const edges = importsIn(parseSource(code, label)).filter((e) => e.spec === '@modoki/engine' || e.spec.startsWith('@modoki/engine/'));
  return {
    static: edges.filter((e) => e.kind !== 'dynamic').map((e) => `${label}:${lineOf(e.node)}: ${flatText(e.node)}`),
    dynamicEditor: edges.filter((e) => e.kind === 'dynamic' && e.spec === '@modoki/engine/editor').length,
  };
}

describe('layering — this module has no direct editor-state import (#850)', () => {
  it('imports @modoki/engine only via the guarded dynamic import, never statically', async () => {
    const path = await import('node:path');
    const edges = engineEdges(readScannedSource(path.join(__dirname, '../../app/debug/hmrStaleness.ts')).code, 'hmrStaleness.ts');

    // Positive control: the dynamic imports must actually be present in the source — a check
    // that would pass just as well against a file importing nothing proves nothing.
    expect(edges.dynamicEditor).toBeGreaterThan(0);

    // The actual guard: no static import or re-export of the package, however it is formatted.
    expect(edges.static).toEqual([]);
  });

  it('engineEdges reads each edge from its declaration, not its first line (#1179)', () => {
    const edges = (code: string) => engineEdges(code, 'fixture.ts');
    expect(edges(`import {
      unsavedChangeCauses,
    } from '@modoki/engine/editor';
    import type { X } from '@modoki/engine';
    export { y } from '@modoki/engine/runtime';
    import z = require('@modoki/engine/editor');
    import { other } from '@modoki/engineering';
    const s = "import { a } from '@modoki/engine'";
    async function f() { return import(
      '@modoki/engine/editor'); }
    const g = () => import('@modoki/engine/runtime');`)).toEqual({
      static: [
        "fixture.ts:1: import { unsavedChangeCauses, } from '@modoki/engine/editor';",
        "fixture.ts:4: import type { X } from '@modoki/engine';",
        "fixture.ts:5: export { y } from '@modoki/engine/runtime';",
        "fixture.ts:6: import z = require('@modoki/engine/editor');",
      ],
      dynamicEditor: 1,
    });
  });
});
