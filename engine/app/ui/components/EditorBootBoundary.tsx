import { Component, type ErrorInfo, type ReactNode } from 'react';

// A packaged editor's Vite dep-optimizer pre-bundles `@modoki/engine` subpaths (and, for a game
// with its own `packages/app-services`, that game's native-SDK deps too) cold at startup
// (vite.config.ts optimizeDeps.include) to avoid a mid-session re-optimize. That cold scan has a
// rare race — first observed on a fresh per-machine Windows install — where the renderer's first
// request lands before esbuild's scan has discovered every reachable export, and the served chunk
// is missing one. The browser reports this as a SyntaxError naming the missing export; a bare
// reload against the by-then-finished pre-bundle always clears it. See docs/todo.md for the open
// investigation into the scan race itself.
export const STALE_DEP_OPTIMIZE_RE = /does not provide an export named/i;
export const BOOT_RETRY_SESSION_KEY = 'modoki:bootRetryCount';
export const MAX_BOOT_RETRIES = 1;

/** Last-resort boundary around the editor route. The editor is loaded through a bare
 *  `React.lazy`, so ANY rejection during its bootstrap used to unmount the tree and leave a
 *  BLANK window — alive, serving HTTP, rendering nothing, with the reason visible only to
 *  someone who thought to open the console. That silent-blank outcome is what made the
 *  wedged-editor bug cost four debugging sessions, so it must not be reachable by any path,
 *  including ones nobody has hit yet. Paint the error instead — UNLESS the error matches the
 *  known stale-dep-optimize-chunk signature above, in which case we get ONE silent,
 *  clearly-logged reload attempt (capped via sessionStorage, so it can't loop) before falling
 *  back to painting the error like any other failure. */
export class EditorBootBoundary extends Component<{ children: ReactNode }, { error: Error | null; retrying: boolean }> {
  state: { error: Error | null; retrying: boolean } = { error: null, retrying: false };
  static getDerivedStateFromError(error: Error) {
    // Read-only check — decides in the SAME pass as the crash so the "recovering" UI
    // renders on the first frame instead of flashing the full error screen first.
    // The retry-count WRITE (and the reload itself) is a side effect and stays in
    // componentDidCatch, which React guarantees runs at most once per catch.
    const retryCount = Number(sessionStorage.getItem(BOOT_RETRY_SESSION_KEY) ?? '0');
    const retrying = STALE_DEP_OPTIMIZE_RE.test(error.message) && retryCount < MAX_BOOT_RETRIES;
    return { error: retrying ? null : error, retrying };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    const retryCount = Number(sessionStorage.getItem(BOOT_RETRY_SESSION_KEY) ?? '0');
    const isStaleDepOptimize = STALE_DEP_OPTIMIZE_RE.test(error.message);
    console.error(
      `[EditorBootBoundary] the editor failed to start (retryCount=${retryCount}, ` +
      `staleDepOptimizeSignature=${isStaleDepOptimize}, willRetry=${this.state.retrying}, ` +
      `at=${new Date().toISOString()}):`,
      error, info.componentStack,
    );
    if (this.state.retrying) {
      const nextCount = retryCount + 1;
      sessionStorage.setItem(BOOT_RETRY_SESSION_KEY, String(nextCount));
      console.warn(
        `[EditorBootBoundary] stale dep-optimize chunk signature — reloading ` +
        `(attempt ${nextCount}/${MAX_BOOT_RETRIES}) instead of painting the error`,
      );
      window.location.reload();
      return;
    }
    if (isStaleDepOptimize) {
      console.warn(`[EditorBootBoundary] stale dep-optimize signature recurred past the retry cap (${MAX_BOOT_RETRIES}) — painting the error instead of retrying again`);
    }
  }
  render() {
    const { error, retrying } = this.state;
    if (retrying) {
      return (
        <div style={{
          height: '100vh', background: '#1a1a2e', color: '#e5e7eb', padding: 28,
          fontFamily: 'system-ui, sans-serif', display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          Recovering from a startup glitch — reloading…
        </div>
      );
    }
    if (!error) return this.props.children;
    return (
      <div style={{
        height: '100vh', background: '#1a1a2e', color: '#fee2e2', padding: 28, overflow: 'auto',
        fontFamily: 'system-ui, sans-serif',
      }}>
        <h2 style={{ margin: '0 0 10px', color: '#fca5a5' }}>The editor failed to start</h2>
        <p style={{ margin: '0 0 14px', color: '#e5e7eb', maxWidth: 760, lineHeight: 1.5 }}>
          Nothing is rendering because the editor never finished booting. This is the error that
          stopped it — fix it and the editor reloads automatically.
        </p>
        <pre style={{
          whiteSpace: 'pre-wrap', background: '#0f172a', border: '1px solid #334155',
          padding: 14, color: '#fecaca', fontSize: 13, margin: 0,
        }}>{`${error.name}: ${error.message}\n\n${error.stack ?? ''}`}</pre>
      </div>
    );
  }
}
