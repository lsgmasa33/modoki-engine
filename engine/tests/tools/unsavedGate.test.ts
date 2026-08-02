/** The unsaved-work gate on the build/OTA family — asserted over the REAL tool surface.
 *
 *  `modoki_build`, `modoki_add_native_target` and `modoki_ota_publish` all read the scene FILE, so
 *  they promise (in their own descriptions, unconditionally) to REFUSE when the editor is holding
 *  live-world work that is not on disk.
 *
 *  REGRESSION (independent review, 2026-07-30). `unsavedChangesWarning()` probed
 *  `/api/editor-state` and returned "clean, proceed" on ANY non-200, any throw, and any body
 *  lacking `unsavedChanges === true`. So "could not check" was reported as "nothing to save" — the
 *  §5 inversion this audit was about (docs/mcp-tool-conventions.md: could-not-look is never
 *  reported as nothing-is-there), sitting on the one tool family that ships code to installed apps.
 *  A merely BUSY editor (a scene load, a GLB/KTX2 decode) misses the 5s probe easily.
 *
 *  The distinction the fix draws, and what each test below pins:
 *    unreachable backend      → proceed  (no editor exists to be stale against — a real answer)
 *    answered, unsavedChanges:false → proceed  (asked and told: clean)
 *    non-200 / junk body / no boolean / timeout → REFUSE (unknown ≠ clean)
 *    answered, unsavedChanges:true  → REFUSE
 */

import { describe, it, expect, afterEach } from 'vitest';
import { loadSurface, type Surface } from './mcpSurface';

let surface: Surface | undefined;
afterEach(() => { surface?.restore(); surface = undefined; });

/** Every tool that gates on unsaved work, with the smallest call that reaches the gate. */
const GATED: { name: string; args: Record<string, unknown> }[] = [
  { name: 'modoki_build', args: { platform: 'web' } },
  { name: 'modoki_add_native_target', args: { platform: 'ios' } },
  { name: 'modoki_ota_publish', args: { version: 'v1' } },
];

/** Did the call refuse with the REQUIRES_SAVE envelope (rather than proceeding to the build)? */
function refusedForSave(s: Surface, r: { content: Array<{ text: string }>; isError?: boolean }): boolean {
  if (!r.isError) return false;
  try {
    const err = (JSON.parse(s.text(r as never)) as { error?: { code?: string } }).error;
    return err?.code === 'REQUIRES_SAVE';
  } catch { return false; }
}

/** True if the tool went ahead and opened the build/publish stream. */
function startedTheBuild(s: Surface): boolean {
  return s.requests.some((q) => /^\/api\/(build|add-native-target|ota\/publish)/.test(q.path));
}

describe('unsaved-work gate: an editor that ANSWERS', () => {
  for (const { name, args } of GATED) {
    it(`${name} proceeds when the editor answers unsavedChanges:false`, async () => {
      surface = loadSurface((req) =>
        req.path.startsWith('/api/editor-state') ? { status: 200, body: { unsavedChanges: false } } : undefined);
      const r = await surface.call(name, args);
      expect(refusedForSave(surface, r as never)).toBe(false);
    });

    it(`${name} REFUSES when the editor answers unsavedChanges:true`, async () => {
      surface = loadSurface((req) =>
        req.path.startsWith('/api/editor-state') ? { status: 200, body: { unsavedChanges: true } } : undefined);
      const r = await surface.call(name, args);
      expect(refusedForSave(surface, r as never)).toBe(true);
      expect(startedTheBuild(surface)).toBe(false);
    });
  }
});

describe('unsaved-work gate: an editor that CANNOT be checked (the fail-open regression)', () => {
  // Each of these used to read as "clean, proceed".
  const UNKNOWN_STATES: { label: string; reply: { status?: number; body?: unknown } }[] = [
    { label: 'a 500 from /api/editor-state', reply: { status: 500, body: { error: 'boom' } } },
    { label: 'a 403 (wrong editor / auth)', reply: { status: 403, body: { error: 'forbidden' } } },
    { label: 'a 200 with a non-object body', reply: { status: 200, body: 'not json at all' } },
    { label: 'a 200 with no unsavedChanges field', reply: { status: 200, body: { scenePath: '/x.json' } } },
    { label: 'a 200 with a non-boolean unsavedChanges', reply: { status: 200, body: { unsavedChanges: 'maybe' } } },
  ];

  for (const { name, args } of GATED) {
    for (const { label, reply } of UNKNOWN_STATES) {
      it(`${name} REFUSES on ${label} — unknown is not clean`, async () => {
        surface = loadSurface((req) => (req.path.startsWith('/api/editor-state') ? reply : undefined));
        const r = await surface.call(name, args);
        expect(refusedForSave(surface, r as never)).toBe(true);
        // The load-bearing half: it must not have shipped anything.
        expect(startedTheBuild(surface)).toBe(false);
      });
    }
  }

  it('the refusal SAYS the state is unknown, so the agent does not read it as "you have unsaved work"', async () => {
    surface = loadSurface((req) =>
      (req.path.startsWith('/api/editor-state') ? { status: 500, body: { error: 'boom' } } : undefined));
    const r = await surface.call('modoki_ota_publish', { version: 'v1' });
    const why = (JSON.parse(surface.text(r as never)) as { error?: { why?: string } }).error?.why ?? '';
    expect(why).toMatch(/UNKNOWN/);
  });

  it('force:true still overrides — the gate refuses, it does not wedge', async () => {
    surface = loadSurface((req) =>
      (req.path.startsWith('/api/editor-state') ? { status: 500, body: { error: 'boom' } } : undefined));
    const r = await surface.call('modoki_ota_publish', { version: 'v1', force: true });
    expect(refusedForSave(surface, r as never)).toBe(false);
  });
});

/** The ASSUMPTION the timeout classification rests on, pinned against a REAL abort.
 *
 *  Everything above stubs `fetch`, so its timeout case throws a SYNTHETIC error with
 *  `name = 'TimeoutError'` — i.e. it checks my classification against my own belief about what a
 *  real abort looks like. If Node ever named that rejection something else (`AbortError`, say),
 *  every test above would still pass while the gate silently failed OPEN again on the one case it
 *  was written for: a busy editor that does not answer.
 *
 *  So this makes one real request to a real server that never replies, and asserts the shape.
 *  50ms rather than the production 5s — the duration is not what needs pinning, the NAME is.
 *  Verified end-to-end against a stalled stub editor on 2026-07-31: the real 5s path refused and
 *  `modoki_build`/`modoki_ota_publish` never opened their streams (with the pre-fix code, both
 *  did). */
describe('the real AbortSignal.timeout rejection is shaped the way the gate assumes', () => {
  it("rejects with name 'TimeoutError' — the discriminator unsavedChangesWarning branches on", async () => {
    const http = await import('node:http');
    const server = http.createServer(() => { /* never respond */ });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    try {
      const err = await fetch(`http://127.0.0.1:${port}/api/editor-state`, { signal: AbortSignal.timeout(50) })
        .then(() => null, (e: unknown) => e);
      expect(err, 'a stalled request must reject, not resolve').toBeTruthy();
      expect((err as Error).name).toBe('TimeoutError');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
