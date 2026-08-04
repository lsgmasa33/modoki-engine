/** EditorBootBoundary — last-resort boundary around the editor route.
 *
 *  Regression guard for the packaged editor serving a dep chunk that is missing an export the
 *  renderer imports, which surfaces as a SyntaxError naming that export. This boundary gets ONE
 *  recovery attempt, capped via sessionStorage so it can never loop, before falling back to the
 *  original "paint the error, never go blank" behavior — which is itself load-bearing (see the
 *  class doc comment): a silently-blank window is what made the original wedged-editor bug cost
 *  four debugging sessions.
 *
 *  The recovery is NOT a bare reload. It was, and #110 measured why that could never work for the
 *  dominant cause (stale Chromium browser caches after an app update): Vite serves the dep URL
 *  `immutable` and its browserHash doesn't move on an engine-only update, so a reload re-requests
 *  the identical URL and gets the identical stale body — burning the one retry for nothing. So the
 *  cache clear must happen BEFORE the reload, and the tests below pin that ORDER, not just that
 *  both happened. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import {
  EditorBootBoundary,
  STALE_DEP_OPTIMIZE_RE,
  BOOT_RETRY_SESSION_KEY,
  MAX_BOOT_RETRIES,
} from '../../app/ui/components/EditorBootBoundary';

/** Throws in render on every render while `shouldThrow` is true — the standard React
 *  error-boundary test pattern (React doesn't offer a built-in "throw once" helper). */
function Bomb({ shouldThrow, message }: { shouldThrow: boolean; message: string }) {
  if (shouldThrow) throw new SyntaxError(message);
  return <div>ok</div>;
}

describe('EditorBootBoundary', () => {
  const realLocation = window.location;
  let reloadSpy: ReturnType<typeof vi.fn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    sessionStorage.clear();
    reloadSpy = vi.fn();
    // jsdom's window.location.reload is not implemented AND not directly spy-able (its
    // properties are non-configurable) — replace the whole `location` object so
    // componentDidCatch's call is both observable and inert. Restored in afterEach.
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...realLocation, reload: reloadSpy },
    });
    // componentDidCatch always logs — silence it so the test output stays readable, and to
    // exercise the "never throws while logging" path even with console mocked.
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    sessionStorage.clear();
    Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
    delete (window as unknown as { __modokiElectron?: unknown }).__modokiElectron;
  });

  /** Install the Electron preload bridge the packaged editor has (absent in a plain browser). */
  function stubElectron(invoke: (c: string, p?: unknown) => Promise<unknown>) {
    (window as unknown as { __modokiElectron?: unknown }).__modokiElectron = { invoke };
  }

  const STALE = "The requested module '/@fs/.../@modoki_engine_editor.js?v=d000db2e' does not provide an export named 'waitForEditorJournal'";

  it('renders children normally when nothing throws', () => {
    const { getByText } = render(
      <EditorBootBoundary>
        <div>editor booted</div>
      </EditorBootBoundary>,
    );
    expect(getByText('editor booted')).toBeTruthy();
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it('a non-matching error paints the full error screen immediately — no retry attempted', () => {
    const { getByText, queryByText } = render(
      <EditorBootBoundary>
        <Bomb shouldThrow message="something unrelated blew up" />
      </EditorBootBoundary>,
    );
    expect(getByText('The editor failed to start')).toBeTruthy();
    expect(queryByText(/Recovering/)).toBeNull();
    expect(reloadSpy).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(BOOT_RETRY_SESSION_KEY)).toBeNull();
  });

  it('the stale dep-optimize signature triggers exactly one reload, shows the recovering UI (not the red error screen), and records the attempt', () => {
    const message = "The requested module '/@fs/.../@modoki_engine_runtime.js' does not provide an export named 'getRendererGateHealth'";
    expect(STALE_DEP_OPTIMIZE_RE.test(message)).toBe(true); // sanity: this IS the signature under test

    const { getByText, queryByText } = render(
      <EditorBootBoundary>
        <Bomb shouldThrow message={message} />
      </EditorBootBoundary>,
    );

    expect(getByText(/Recovering from a startup glitch/)).toBeTruthy();
    expect(queryByText('The editor failed to start')).toBeNull();
    expect(reloadSpy).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(BOOT_RETRY_SESSION_KEY)).toBe('1');
  });

  it('a SECOND occurrence within the same session (retry cap already spent) paints the error instead of reloading again — cannot loop', () => {
    sessionStorage.setItem(BOOT_RETRY_SESSION_KEY, String(MAX_BOOT_RETRIES));
    const message = "does not provide an export named 'whatever'";

    const { getByText, queryByText } = render(
      <EditorBootBoundary>
        <Bomb shouldThrow message={message} />
      </EditorBootBoundary>,
    );

    expect(getByText('The editor failed to start')).toBeTruthy();
    expect(queryByText(/Recovering/)).toBeNull();
    expect(reloadSpy).not.toHaveBeenCalled();
    // The retry count must not climb past the cap.
    expect(sessionStorage.getItem(BOOT_RETRY_SESSION_KEY)).toBe(String(MAX_BOOT_RETRIES));
  });

  it('under Electron, clears the browser caches BEFORE reloading — the order is the whole fix (#110)', async () => {
    // A bare reload re-requests the same `immutable` dep URL and gets the same stale body back,
    // so a clear that lands AFTER the reload is indistinguishable from no clear at all.
    const order: string[] = [];
    const invoke = vi.fn(async (channel: string) => { order.push(`invoke:${channel}`); return { ok: true }; });
    stubElectron(invoke);
    reloadSpy.mockImplementation(() => { order.push('reload'); });

    render(
      <EditorBootBoundary>
        <Bomb shouldThrow message={STALE} />
      </EditorBootBoundary>,
    );

    // The clear is awaited, so the reload lands a microtask later than the synchronous path.
    await vi.waitFor(() => expect(reloadSpy).toHaveBeenCalledTimes(1));
    expect(invoke).toHaveBeenCalledWith('modoki:clear-browser-caches');
    expect(order).toEqual(['invoke:modoki:clear-browser-caches', 'reload']);
    expect(sessionStorage.getItem(BOOT_RETRY_SESSION_KEY)).toBe('1');
  });

  it('still reloads when the cache clear throws — a failed clear must not strand the editor on "Recovering…"', async () => {
    stubElectron(vi.fn(async () => { throw new Error('no session'); }));

    const { getByText } = render(
      <EditorBootBoundary>
        <Bomb shouldThrow message={STALE} />
      </EditorBootBoundary>,
    );

    expect(getByText(/Recovering from a startup glitch/)).toBeTruthy();
    await vi.waitFor(() => expect(reloadSpy).toHaveBeenCalledTimes(1));
  });

  it('still reloads when the cache clear reports failure rather than throwing', async () => {
    stubElectron(vi.fn(async () => ({ ok: false, error: 'clearCache unavailable' })));

    render(
      <EditorBootBoundary>
        <Bomb shouldThrow message={STALE} />
      </EditorBootBoundary>,
    );

    await vi.waitFor(() => expect(reloadSpy).toHaveBeenCalledTimes(1));
  });

  it('the retry cap is spent even if the clear never resolves — a hung IPC cannot buy extra retries', () => {
    // The count is persisted BEFORE the async work, so a wedged clearCache can't loop the boundary.
    stubElectron(vi.fn(() => new Promise<unknown>(() => {})));

    render(
      <EditorBootBoundary>
        <Bomb shouldThrow message={STALE} />
      </EditorBootBoundary>,
    );

    expect(sessionStorage.getItem(BOOT_RETRY_SESSION_KEY)).toBe(String(MAX_BOOT_RETRIES));
    expect(reloadSpy).not.toHaveBeenCalled(); // still awaiting the clear — deliberately not reloaded yet
  });

  it('logs a diagnostic on every catch, matching-signature or not, so main.log has a trail', () => {
    render(
      <EditorBootBoundary>
        <Bomb shouldThrow message="unrelated crash" />
      </EditorBootBoundary>,
    );
    // React itself also console.error's the caught error in dev mode — find OUR entry among
    // whatever else logged, rather than assuming we're the only caller.
    const ownLog = consoleErrorSpy.mock.calls.find(([firstArg]: unknown[]) => String(firstArg).includes('[EditorBootBoundary]'));
    expect(ownLog).toBeDefined();
    expect(String(ownLog![0])).toContain('retryCount=');
    expect(String(ownLog![0])).toContain('staleDepOptimizeSignature=false');
    expect(consoleWarnSpy).not.toHaveBeenCalled(); // no retry attempted, no retry-specific warning
  });
});
