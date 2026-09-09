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

describe('unsaved-work gate: naming the ACTUAL cause (#844)', () => {
  // The refusal used to be one fixed sentence blaming create_entity/duplicate_entity/prefab,
  // regardless of what was actually unsaved. Since #831 a Material slider drag parks a dirty
  // ASSET the same way create_entity parks a live-world edit, so an agent whose only pending work
  // was a dirty material went looking for entities it never created.
  it('modoki_build names a dirty ASSET path instead of the old fixed create_entity sentence', async () => {
    surface = loadSurface((req) =>
      req.path.startsWith('/api/editor-state') ? {
        status: 200,
        body: {
          unsavedChanges: true,
          unsavedCauses: { sceneDirty: false, dirtyAssetPaths: ['/assets/glow.mat.json'], dirtyScenes: [] },
        },
      } : undefined);
    const r = await surface.call('modoki_build', { platform: 'web' });
    expect(refusedForSave(surface, r as never)).toBe(true);
    const why = (JSON.parse(surface.text(r as never)) as { error?: { why?: string } }).error?.why ?? '';
    expect(why).toMatch(/\/assets\/glow\.mat\.json/);
    // The negative half is what makes this bite: the OLD fixed cause must be gone.
    expect(why).not.toMatch(/create_entity/);
  });

  for (const [cause, needle] of [
    ['pendingBaseScenes', '/assets/scenes/child.scene.json'],
    ['pendingImportSettings', '/assets/tex.png'],
  ] as const) {
    it(`modoki_build names ${cause} — it was DROPPED at the wire type and blamed create_entity (#972 P5)`, async () => {
      // The wire type here declared three of the five causes the renderer sends, so these two fell
      // through to the generic wording and the agent was told to look for entities it never
      // created. #844's defect, surviving one layer out.
      surface = loadSurface((req) =>
        req.path.startsWith('/api/editor-state') ? {
          status: 200,
          body: {
            unsavedChanges: true,
            unsavedCauses: {
              sceneDirty: false, dirtyAssetPaths: [], dirtyScenes: [],
              pendingBaseScenes: [], pendingImportSettings: [], [cause]: [needle],
            },
          },
        } : undefined);
      const r = await surface.call('modoki_build', { platform: 'web' });
      expect(refusedForSave(surface, r as never)).toBe(true);
      const why = (JSON.parse(surface.text(r as never)) as { error?: { why?: string } }).error?.why ?? '';
      expect(why).toContain(needle);
      expect(why, 'the generic create_entity wording is the WRONG cause for this').not.toMatch(/create_entity/);
    });
  }

  for (const [cause, wrongShape] of [
    ['dirtyAssetPaths', true],
    ['dirtyScenes', true],
    ['sceneDirty', ['/a.mat.json']],
  ] as const) {
    it(`DEGRADES when ${cause} arrives with the other TYPE — a mismatched pair must not throw`, async () => {
      // ⚠️ Found in close-out review of my own fix. Phrasing each cause with its own describer let
      // a value of the WRONG shape reach it: `dirtyAssetPaths: true` called a list describer with a
      // boolean and threw `v.join is not a function`, which escaped `unsavedChangesWarning()` and
      // handed the agent a raw TypeError instead of the REQUIRES_SAVE envelope that carries
      // `force:true` as its exit.
      //
      // This is not a hypothetical input. This bundle and the renderer version INDEPENDENTLY —
      // the file's own comments call a mismatched pair the normal case — so a cause that changes
      // representation is exactly the traffic this seam exists to survive. Degrade, never throw.
      surface = loadSurface((req) =>
        req.path.startsWith('/api/editor-state') ? {
          status: 200,
          body: { unsavedChanges: true, unsavedCauses: { [cause]: wrongShape } },
        } : undefined);
      const r = await surface.call('modoki_build', { platform: 'web' });
      expect(refusedForSave(surface, r as never), 'it must still REFUSE — a shape it cannot phrase '
        + 'is not evidence the editor is clean').toBe(true);
      const why = (JSON.parse(surface.text(r as never)) as { error?: { why?: string } }).error?.why ?? '';
      expect(why, 'and it must still name the cause, humanized').toMatch(/dirty asset paths|dirty scenes|scene dirty/);
    });
  }

  it('a cause key that collides with Object.prototype still degrades to a humanized label', async () => {
    // ⚠️ **What this actually pins, stated honestly.** An earlier version of this test claimed to
    // cover the `hasOwn` lookup guard, and a mutation check disproved that: reverting `hasOwn` to a
    // bare `CAUSE_PHRASES[key]` leaves every test green, because `CAUSE_PHRASES['constructor']` is
    // `Object`, whose `.shape` is `undefined`, so the shape check already routes prototype keys to
    // the fallback. `hasOwn` is belt-and-braces and is kept as such — it is NOT what this test
    // falsifies. What this DOES pin is the outcome: a prototype-named cause is reported as an
    // ordinary humanized cause and never renders a function or "[object …]".
    surface = loadSurface((req) =>
      req.path.startsWith('/api/editor-state') ? {
        status: 200,
        body: { unsavedChanges: true, unsavedCauses: { constructor: ['/weird.json'], toString: true } },
      } : undefined);
    const r = await surface.call('modoki_build', { platform: 'web' });
    expect(refusedForSave(surface, r as never)).toBe(true);
    const why = (JSON.parse(surface.text(r as never)) as { error?: { why?: string } }).error?.why ?? '';
    // The load-bearing assertion is this one — it is the only one of the four that distinguishes
    // the fixed code from the broken code (the other two pass under both hypotheses, which the
    // mutation check also showed).
    expect(why, 'a prototype method must not be invoked as a describer').not.toContain('[object');
    expect(why, 'and the cause is still NAMED, humanized like any unknown key').toContain('constructor');
    expect(why).toContain('/weird.json');
  });

  it('a NULL cause value is reported as unphrasable, not silently dropped', async () => {
    // "I cannot describe this" and "there is nothing here" are different answers, and only one of
    // them is safe to act on.
    surface = loadSurface((req) =>
      req.path.startsWith('/api/editor-state') ? {
        status: 200,
        body: { unsavedChanges: true, unsavedCauses: { weirdCause: null } },
      } : undefined);
    const r = await surface.call('modoki_build', { platform: 'web' });
    expect(refusedForSave(surface, r as never)).toBe(true);
    const why = (JSON.parse(surface.text(r as never)) as { error?: { why?: string } }).error?.why ?? '';
    expect(why).toContain('weird cause');
  });

  it('a path containing DOUBLE SPACES survives verbatim — it is a legal filename', async () => {
    // The first version of this phrasing ran `.replace(/ {2,}/g,' ')` over the whole assembled
    // string, values included, so an agent was told to save a path that does not exist.
    surface = loadSurface((req) =>
      req.path.startsWith('/api/editor-state') ? {
        status: 200,
        body: {
          unsavedChanges: true,
          unsavedCauses: { sceneDirty: false, dirtyAssetPaths: ['/assets/my  art.mat.json'], dirtyScenes: [] },
        },
      } : undefined);
    const r = await surface.call('modoki_build', { platform: 'web' });
    const why = (JSON.parse(surface.text(r as never)) as { error?: { why?: string } }).error?.why ?? '';
    expect(why).toContain('/assets/my  art.mat.json');
  });

  it('the dirtyScenes sentence labels its values as GUIDs, not as paths', async () => {
    // The garbled-template defect: a shared `${n} ${noun}(s) ${tail}: ${values}` template produced
    // "…still only in memory(s) — …write them: g1", putting guids in the exact position where all
    // four sibling causes put PATHS. An agent reads `g1` as a file.
    surface = loadSurface((req) =>
      req.path.startsWith('/api/editor-state') ? {
        status: 200,
        body: {
          unsavedChanges: true,
          unsavedCauses: { sceneDirty: false, dirtyAssetPaths: [], dirtyScenes: ['g1'] },
        },
      } : undefined);
    const r = await surface.call('modoki_build', { platform: 'web' });
    const why = (JSON.parse(surface.text(r as never)) as { error?: { why?: string } }).error?.why ?? '';
    expect(why).toContain('(guid(s): g1)');
    expect(why, 'the mangled plural must be gone').not.toContain('memory(s)');
    expect(why, 'and guids must not trail in the position paths occupy').not.toMatch(/write them: g1/);
  });

  it('names a cause this bundle has never heard of, rather than falling through (#972 P5)', async () => {
    // The reason this consumer enumerates instead of naming: the MCP bundle and the renderer
    // version independently, so a NEWER renderer sending a sixth cause is exactly as likely as an
    // older one sending four. A hand-listed wire type drops the new one silently — a runtime
    // problem no compiler on this side can see. The humanized fallback is what makes a cause
    // readable the day it ships, with no edit here.
    surface = loadSurface((req) =>
      req.path.startsWith('/api/editor-state') ? {
        status: 200,
        body: {
          unsavedChanges: true,
          unsavedCauses: { sceneDirty: false, pendingProjectSettings: ['/project.config.json'] },
        },
      } : undefined);
    const r = await surface.call('modoki_build', { platform: 'web' });
    expect(refusedForSave(surface, r as never)).toBe(true);
    const why = (JSON.parse(surface.text(r as never)) as { error?: { why?: string } }).error?.why ?? '';
    expect(why).toContain('/project.config.json');
    expect(why, 'camelCase should be humanized for the reader').toContain('pending project settings');
    expect(why).not.toMatch(/create_entity/);
  });

  it('modoki_build falls back to the old generic wording when the renderer omits unsavedCauses', async () => {
    // An older/mismatched renderer answers `unsavedChanges:true` with no `unsavedCauses` field —
    // this must still refuse (unknown-cause is not "clean"), just without naming a cause list
    // that isn't there.
    surface = loadSurface((req) =>
      req.path.startsWith('/api/editor-state') ? { status: 200, body: { unsavedChanges: true } } : undefined);
    const r = await surface.call('modoki_build', { platform: 'web' });
    expect(refusedForSave(surface, r as never)).toBe(true);
  });
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
