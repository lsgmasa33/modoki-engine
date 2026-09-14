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
 * It guards BOTH directions: the grants the editor needs (loopback, and `https:`
 * for remote DATA), and the grant it must not carry — `https:` on the CODE
 * directives, removed with the on-device-LLM games that were its only consumer
 * (#1191). The opposite regression shipped once (DMG 0.2.0 lacked a grant it
 * needed), which is why the needed grants are pinned too.
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

  // Remote DATA (asset refs, remote video, OTA/CDN fetches) needs `https:`.
  it('grants https: to the directives that load remote data', () => {
    for (const d of ['connect-src', 'img-src', 'media-src']) {
      expect(directives[d], `${d} must allow https: (remote asset refs / fetches)`).toContain('https:');
    }
  });

  // Remote CODE is not granted (#1191): no script or worker from any remote origin. An ALLOWLIST,
  // not a denylist: CSP host-sources need no scheme (`cdn.jsdelivr.net`, `*.jsdelivr.net`), so
  // matching `https:`/`https://` alone would let a scheme-less re-grant through. Anything that is not
  // a quoted keyword, `blob:`/`data:`, or a loopback origin counts as remote — and `'strict-dynamic'`
  // is NOT local despite being quoted: it lets an already-trusted script load further scripts from
  // ANY origin, so it re-opens remote code transitively.
  it('grants no remote origin to the code directives (script-src, worker-src)', () => {
    const isLocal = (s: string) =>
      (/^'[^']+'$/.test(s) && s !== "'strict-dynamic'")
      || s === 'blob:' || s === 'data:' || /^https?:\/\/(localhost|127\.0\.0\.1):/.test(s);
    for (const d of ['script-src', 'worker-src']) {
      const remote = directives[d].filter((s) => !isLocal(s));
      expect(remote, `${d} must not allow a remote origin — self-host the script instead`).toEqual([]);
    }
  });

  it('keeps script-src able to run wasm (unsafe-eval + wasm-unsafe-eval)', () => {
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
