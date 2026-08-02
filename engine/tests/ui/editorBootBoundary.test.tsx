/** EditorBootBoundary — last-resort boundary around the editor route.
 *
 *  Regression guard for the packaged-editor cold-start dep-optimizer race: a rare mismatch
 *  between what Vite's cold scan pre-bundled and what the renderer actually requests surfaces as
 *  a SyntaxError naming a missing export, and a bare reload against the by-then-finished
 *  pre-bundle always clears it. This boundary gets ONE such reload, capped via sessionStorage so
 *  it can never loop, before falling back to the original "paint the error, never go blank"
 *  behavior — which is itself load-bearing (see the class doc comment): a silently-blank window
 *  is what made the original wedged-editor bug cost four debugging sessions.
 */

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
  });

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
