/** The MCP half of the release build path (#370) — the two defects a green gate could not see.
 *
 *  Both were found by review, not by testing, and both are invisible to every other check in the
 *  repo: `npm run verify` never drives the MCP surface with a release variant, and `test:mcp:live`
 *  cannot run a real gradle release build, so its green says nothing about either. They are pinned
 *  here, against the REAL tool handlers, asserting on the HTTP request each one actually makes.
 *
 *  1. **`variant` was accepted, documented, and never sent.** It was destructured and used only in
 *     an error message, so `modoki_build {variant:'release'}` reached the server with no variant at
 *     all → the server correctly defaulted to `debug` → `assembleDebug` + `adb install` onto the
 *     owner's phone, reported "✅ Android build deployed successfully", and produced no AAB. The
 *     keystore refusal and the debug-build warning never fired, because nothing server-side ever
 *     knew a release had been asked for. A doc asserting the flag worked shipped alongside it.
 *
 *  2. **The upload key's passwords were returned to any caller** of
 *     `modoki_project_settings action=get` — a cheap, routine, read-only call — because the route
 *     nests the whole per-machine `user` subtree and `user.keystore` now lives there.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { loadSurface, type Surface } from './mcpSurface';
import { REDACTED, redactSecrets, redactedBack } from '../../tools/modoki-mcp/src/tools/project';

let surface: Surface | undefined;
afterEach(() => { surface?.restore(); surface = undefined; });

/** `/api/build` is an SSE stream; the stub replies JSON. We only assert on the REQUEST, which is
 *  where both the defect and the fix live. `force:true` skips the unsaved-changes probe so a single
 *  request is made and `last()` is unambiguous. */
const buildSurface = () => (surface = loadSurface((req) =>
  req.path.startsWith('/api/build') ? { body: { ok: true } } : undefined));

describe('modoki_build — variant reaches the URL (#370)', () => {
  it('sends variant=release for a release build', async () => {
    const s = buildSurface();
    await s.call('modoki_build', { platform: 'android', variant: 'release', force: true });
    const req = s.last()!;
    // The exact regression: without this the server sees no variant and runs a DEBUG build.
    expect(req.path).toContain('variant=release');
    expect(req.path).toContain('platform=android');
  });

  it('sends variant=release for iOS too', async () => {
    const s = buildSurface();
    await s.call('modoki_build', { platform: 'ios', variant: 'release', force: true });
    expect(s.last()!.path).toContain('variant=release');
  });

  it('OMITS variant entirely for a debug build, and for an unspecified one', async () => {
    // Not cosmetic. An absent variant is the server's `debug` default, and every pre-#370 caller
    // (the Build menu's device rows, the e2e specs, an older agent) sends exactly this shape. The
    // request must stay byte-identical to what they sent.
    for (const args of [
      { platform: 'android', force: true },
      { platform: 'android', variant: 'debug' as const, force: true },
    ]) {
      const s = buildSurface();
      await s.call('modoki_build', args);
      expect(s.last()!.path).toBe('/api/build?platform=android');
      s.restore();
    }
    surface = undefined;
  });

  it('lets the SERVER own the release/platform rule, and sends a well-formed request either way', async () => {
    // ⚠️ This test used to claim "never sends a variant for web or playable" and never passed a
    // variant, so it could not fail — and the claim was false besides: the tool DOES forward
    // `{platform:'web', variant:'release'}`, and `vite-asset-scanner.ts` 400s it.
    //
    // Forwarding is the right call, deliberately: the rule "release applies to ios/android only"
    // lives in ONE place, the route, and re-encoding it here as a zod refinement would be a second
    // copy to drift. What matters is that the request is well-formed so the refusal the caller sees
    // is the server's actionable message, not a malformed-URL error.
    for (const platform of ['web', 'playable'] as const) {
      const s = buildSurface();
      await s.call('modoki_build', { platform, variant: 'release', force: true });
      expect(s.last()!.path).toBe(`/api/build?platform=${platform}&variant=release`);
      s.restore();
    }
    surface = undefined;
  });
});

describe('modoki_project_settings — signing passwords never reach a caller (#370)', () => {
  const userWithKey = {
    device: { iosDeviceId: 'UDID-1', iosDevicectlId: '', androidDeviceId: '' },
    sdk: { javaHome: '', androidHome: '', gcloudPath: '' },
    build: { appleTeamId: 'ABCDE12345', webBucket: '', webCdnUrlMap: '', webCdnBackendBucket: '', webDeployCommand: '' },
    keystore: { storeFile: '/keys/up.jks', storePassword: 's3cret-store', keyAlias: 'upload', keyPassword: 's3cret-key' },
  };
  const settingsSurface = () => (surface = loadSurface((req) =>
    req.path === '/api/project-settings' && req.method === 'GET'
      ? { body: { app: { appId: 'com.apiary.court' }, user: userWithKey } }
      : undefined));

  it('action=get redacts BOTH passwords', async () => {
    const s = settingsSurface();
    const out = s.text(await s.call('modoki_project_settings', { action: 'get' }));
    expect(out).not.toContain('s3cret-store');
    expect(out).not.toContain('s3cret-key');
    expect(out).toContain(REDACTED);
  });

  it('action=get keeps the NON-secret keystore fields readable', async () => {
    // A path and an alias are not secrets, and an agent diagnosing "why did the release build
    // refuse" needs to see whether they are set. Redacting everything would make the refusal
    // undiagnosable, which is its own failure.
    const s = settingsSurface();
    const out = s.text(await s.call('modoki_project_settings', { action: 'get' }));
    expect(out).toContain('/keys/up.jks');
    expect(out).toContain('upload');
  });

  it('leaves the rest of the config untouched', async () => {
    const s = settingsSurface();
    const out = s.json(await s.call('modoki_project_settings', { action: 'get' })) as Record<string, unknown>;
    expect((out.app as Record<string, unknown>).appId).toBe('com.apiary.court');
    const user = out.user as Record<string, Record<string, unknown>>;
    expect(user.build.appleTeamId).toBe('ABCDE12345');
    expect(user.device.iosDeviceId).toBe('UDID-1');
  });

  it('action=set DROPS a round-tripped sentinel instead of writing it as the password', async () => {
    // The trap that makes redaction dangerous if done by halves. The natural agent pattern is
    // get → change one field → set the whole object back; writing '••••••••' as the literal
    // password destroys the real one, and the next release build dies with "Keystore was tampered
    // with, or password was incorrect". Omitting the key means "leave it alone" under the route's
    // patch semantics.
    const s = settingsSurface();
    await s.call('modoki_project_settings', {
      action: 'set',
      values: { user: { keystore: { storeFile: '/keys/up.jks', storePassword: REDACTED, keyPassword: REDACTED, keyAlias: 'upload' } } },
    });
    const body = s.last()!.body as { user: { keystore: Record<string, unknown> } };
    expect(body.user.keystore).not.toHaveProperty('storePassword');
    expect(body.user.keystore).not.toHaveProperty('keyPassword');
    // …while a field the caller genuinely edited still goes through.
    expect(body.user.keystore.keyAlias).toBe('upload');
    expect(body.user.keystore.storeFile).toBe('/keys/up.jks');
  });

  it('action=set passes a REAL password through — the sentinel is not a wildcard', async () => {
    // The distinguishing case: if `redactedBack` dropped every password rather than only the
    // sentinel, configuring a key over MCP would silently do nothing.
    const s = settingsSurface();
    await s.call('modoki_project_settings', {
      action: 'set',
      values: { user: { keystore: { storePassword: 'a-real-one' } } },
    });
    const body = s.last()!.body as { user: { keystore: Record<string, unknown> } };
    expect(body.user.keystore.storePassword).toBe('a-real-one');
  });
});

describe('redactSecrets / redactedBack — the pure halves', () => {
  it('redactSecrets tolerates every shape a reply can take', () => {
    // Called on whatever the route returned, including an error body or a config with no user
    // subtree at all (an older backend). It must never throw — a crash here would break a routine
    // read for every project, not just one with a keystore.
    for (const input of [null, undefined, 'a string', 42, {}, { user: null }, { user: 'x' }, { user: {} }, { user: { keystore: {} } }]) {
      expect(() => redactSecrets(input)).not.toThrow();
    }
    expect(redactSecrets({ user: { keystore: { storePassword: '' } } }))
      .toEqual({ user: { keystore: { storePassword: '' } } }); // empty = not set; nothing to hide
  });

  it('redactedBack is a no-op when there is nothing to strip', () => {
    const patch = { app: { appName: 'X' } };
    expect(redactedBack(patch)).toBe(patch); // same reference — no needless copy
    expect(redactedBack({ user: { device: { iosDeviceId: 'A' } } }))
      .toEqual({ user: { device: { iosDeviceId: 'A' } } });
  });
});
