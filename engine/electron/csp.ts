/**
 * Prod Content-Security-Policy for the packaged editor window — extracted as a
 * PURE function so a guard test (`engine/tests/electron/cspContract.test.ts`) can
 * assert its contract without booting Electron. `main.ts` is the only caller.
 *
 * WHY this is a testable contract and not an inline string: the packaged (PROD)
 * app is the ONLY place this CSP is applied (dev sets none), so a wrong policy
 * can't be caught by `npm run dev` — it ships silently and breaks a real DMG. A
 * shipped example: `script-src` once lacked `https:`, which blocked MediaPipe's
 * GenAI wasm loader `<script>` (chess / llm-test on-device LLM) with
 * "Resource load error: genai_wasm_internal.js". The contract test locks the
 * origins each directive MUST grant so that regression fails CI, not a user's DMG.
 *
 * Policy shape (see main.ts for the full rationale): a RELAXED, loopback-scoped
 * policy for the Vite-in-prod shell. It bounds origins to loopback (the Vite shell
 * + cross-origin /api backend) + https/data/blob (asset refs, wasm, CDN wasm
 * loaders, transcoder workers). It does NOT harden against inline/eval (Vite HMR
 * needs both) — navigation + window-open denial in main.ts is the primary
 * protection. So the meaningful bound is "loopback + https, no other remote
 * origin", which every `https:`-bearing directive below preserves.
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
 * `https:` on script-src/worker-src/connect (+ img/media) is LOAD-BEARING for
 * on-device-LLM games that pull MediaPipe's wasm from a CDN — do not remove it
 * without updating cspContract.test.ts, which asserts it.
 */
export function buildProdCsp({ viteOrigin, wsOrigin }: CspOrigins): string {
  return (
    `default-src 'self' ${viteOrigin}; ` +
    `script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' https: ${viteOrigin}; ` +
    "style-src 'self' 'unsafe-inline'; " +
    `img-src 'self' data: blob: https: ${viteOrigin}; ` +
    "font-src 'self' data:; " +
    "media-src 'self' data: blob: https:; " +
    "worker-src 'self' blob: https:; " +
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
