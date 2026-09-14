/**
 * Prod Content-Security-Policy for the packaged editor window — extracted as a
 * PURE function so a guard test (`engine/tests/electron/cspContract.test.ts`) can
 * assert its contract without booting Electron. `main.ts` is the only caller.
 *
 * WHY this is a testable contract and not an inline string: the packaged (PROD)
 * app is the ONLY place this CSP is applied (dev sets none), so a wrong policy
 * can't be caught by `npm run dev` — it ships silently and breaks a real DMG. A
 * shipped example: `script-src` once lacked `https:`, which blocked MediaPipe's
 * GenAI wasm loader `<script>` for the on-device-LLM games (DMG 0.2.0). The
 * contract test locks what each directive MUST and MUST NOT grant, so a drift in
 * either direction fails CI, not a user's DMG.
 *
 * Policy shape (see main.ts for the full rationale): a RELAXED, loopback-scoped
 * policy for the Vite-in-prod shell. It does NOT harden against inline/eval (Vite
 * HMR needs both) — navigation + window-open denial in main.ts is the primary
 * protection. What it bounds is ORIGIN:
 *   · CODE (`script-src`, `worker-src`) — loopback + self/blob only. No remote
 *     origin can supply a script or a worker.
 *   · DATA (`connect-src`, `img-src`, `media-src`) — loopback + https/data/blob,
 *     for remote asset refs, remote video and OTA/CDN fetches.
 * `https:` on script/worker existed only for MediaPipe's CDN loader; it was
 * removed when the on-device-LLM games and their plugin were deleted (#1191).
 */

export interface CspOrigins {
  /** Loopback http origins the Vite dev server can be served from (port-wildcarded). */
  viteOrigin: string;
  /** Loopback ws origins for Vite HMR / the debug bridge (port-wildcarded). */
  wsOrigin: string;
}

/** The loopback origins main.ts passes in prod. Exported so the guard test and
 *  main.ts share ONE definition (a drift here is what a contract test catches). */
export const PROD_CSP_ORIGINS: CspOrigins = {
  viteOrigin: 'http://localhost:* http://127.0.0.1:*',
  wsOrigin: 'ws://localhost:* ws://127.0.0.1:*',
};

/**
 * Build the packaged-editor CSP header value. Kept as a single expression so the
 * contract test can parse it directive-by-directive.
 *
 * ⚠️ `script-src`/`worker-src` deliberately carry NO `https:` (#1191) — every
 * script and worker the editor runs is served from loopback or a blob. A game
 * that needs a remote script should self-host it (as the KTX2/Basis transcoders
 * do) rather than re-open this; cspContract.test.ts asserts the absence.
 */
export function buildProdCsp({ viteOrigin, wsOrigin }: CspOrigins): string {
  return (
    `default-src 'self' ${viteOrigin}; ` +
    `script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' ${viteOrigin}; ` +
    "style-src 'self' 'unsafe-inline'; " +
    `img-src 'self' data: blob: https: ${viteOrigin}; ` +
    "font-src 'self' data:; " +
    "media-src 'self' data: blob: https:; " +
    "worker-src 'self' blob:; " +
    `connect-src 'self' ${viteOrigin} ${wsOrigin} https: data: blob:`
  );
}

/** Parse a CSP string into a directive → source-list map (whitespace-split). */
export function parseCsp(csp: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const part of csp.split(';')) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    const [directive, ...sources] = tokens;
    out[directive] = sources;
  }
  return out;
}
