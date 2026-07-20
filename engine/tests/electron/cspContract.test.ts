import { describe, it, expect } from 'vitest';
import { buildProdCsp, parseCsp, PROD_CSP_ORIGINS } from '../../electron/csp';

/**
 * PACKAGING GUARD — the packaged-editor (PROD) Content-Security-Policy.
 *
 * The prod CSP is applied ONLY in the packaged app (dev sets none), so a wrong
 * policy ships silently and only breaks a real DMG — never `npm run dev` or a
 * normal unit test that boots the renderer in dev. This guard asserts the
 * load-bearing origins directly on the pure `buildProdCsp` contract so a
 * regression fails CI instead of a user's install.
 *
 * Concrete regression this guards: `script-src`/`worker-src` once lacked `https:`,
 * which CSP-blocked MediaPipe's GenAI wasm loader `<script>` + inference worker
 * (chess / llm-test on-device LLM, loaded from jsdelivr) →
 * "Resource load error: genai_wasm_internal.js" and the game never loaded.
 */
describe('packaged editor CSP contract', () => {
  const csp = buildProdCsp(PROD_CSP_ORIGINS);
  const directives = parseCsp(csp);

  it('defines every directive the policy relies on', () => {
    for (const d of [
      'default-src',
      'script-src',
      'style-src',
      'img-src',
      'font-src',
      'media-src',
      'worker-src',
      'connect-src',
    ]) {
      expect(directives[d], `missing directive: ${d}`).toBeDefined();
    }
  });

  // The core of the guard: external CDN loads (MediaPipe wasm loader + worker,
  // the model download, remote asset refs) need `https:`. These MUST stay granted.
  it('grants https: to the directives that load external CDN resources', () => {
    for (const d of ['script-src', 'worker-src', 'connect-src', 'img-src', 'media-src']) {
      expect(directives[d], `${d} must allow https: (external CDN / asset refs)`).toContain('https:');
    }
  });

  it('keeps script-src able to run MediaPipe wasm (unsafe-eval + wasm-unsafe-eval)', () => {
    expect(directives['script-src']).toContain("'unsafe-eval'");
    expect(directives['script-src']).toContain("'wasm-unsafe-eval'");
  });

  it('scopes the Vite shell + backend to loopback origins', () => {
    // default-src / script-src / connect-src must reach the loopback Vite server;
    // connect-src must also reach the ws HMR/bridge origin.
    for (const tok of PROD_CSP_ORIGINS.viteOrigin.split(/\s+/)) {
      expect(directives['default-src']).toContain(tok);
      expect(directives['script-src']).toContain(tok);
      expect(directives['connect-src']).toContain(tok);
    }
    for (const tok of PROD_CSP_ORIGINS.wsOrigin.split(/\s+/)) {
      expect(directives['connect-src']).toContain(tok);
    }
  });

  it('does not open the policy to an unbounded wildcard', () => {
    // The bound that matters is "loopback + https, no other remote origin". A bare
    // `*` (or `http:`/`ws:` without loopback scoping) would defeat that. Allow the
    // loopback port-wildcards (`http://127.0.0.1:*`) but not a standalone `*`.
    for (const [d, sources] of Object.entries(directives)) {
      expect(sources, `${d} must not contain a bare * wildcard`).not.toContain('*');
      expect(sources, `${d} must not allow bare http:`).not.toContain('http:');
    }
  });
});
