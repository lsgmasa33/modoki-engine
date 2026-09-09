/** A refusal that names an escape hatch must name one the AGENT CAN ACTUALLY TAKE (#889 close-out).
 *
 *  ## The defect this exists for
 *
 *  `/api/asset-write` was gated in #889 phase 3. Its 409 is built by `unsavedRefusal`, which lists
 *  `discardUnsaved:true` among the caller's options — and `modoki_write_asset`, the ONLY
 *  agent-facing caller of that route, neither declared `discardUnsaved` in its zod shape nor
 *  forwarded it. So the loop was: agent gets the 409, reads the option, passes it, the handler
 *  destructures it away, and the identical 409 comes back. Its sibling one route over
 *  (`modoki_write_asset_meta`) had it, so this was a deviation from the pattern, not a convention.
 *
 *  The knock-on was larger than the wording. `writeGate.kind === 'held'` can only get past the
 *  refusal when `discardUnsaved === true`, so with the param unreachable the ENTIRE post-write
 *  discard mechanism — the second `unsavedGate`, `discardedParked`, `discardWarning` — could not
 *  fire from the MCP surface at all. Route-level tests drove it by posting the body directly and
 *  were green throughout.
 *
 *  ## Why it is asserted HERE and in this shape
 *
 *  `mcpRegistry.test.ts` checks that a tool DECLARES the param and words it correctly. That is the
 *  half that was easy to add and it is not the half that was broken: a declared-but-dropped param
 *  passes every schema assertion. This drives the real handler through the real zod shape against
 *  a stub backend and reads what was actually POSTED — the only check that can tell "the tool
 *  accepts this word" from "the tool sends it on".
 *
 *  ⚠️ **The list is derived from the SURFACE, not hand-kept** — and in its first version it was not:
 *  the docblock said this while the loop ran over a hardcoded pair, leaving three of the five tools
 *  that declare the param unverified and a sixth declare-and-drop undetectable. The claim-versus-
 *  code gap this file exists to catch, in this file. It now enumerates every tool whose zod shape
 *  declares `discardUnsaved`, so a new one is covered the day it is written.
 *
 *  ⚠️ Fixtures come from each tool's own `minimalArgs` in `contracts.ts` rather than a switch on
 *  key names. Guessing produced `prefabAction` for a tool whose key is `action`; a guess that zod
 *  merely ACCEPTS is worse, because it drives a path production never takes.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { loadSurface, realRequests, type Surface } from './mcpSurface';
import { getTool, toolNames } from '../../tools/modoki-mcp/src/registry';
import { CONTRACTS } from '../../tools/modoki-mcp/src/contracts';

let surface: Surface | undefined;
afterEach(() => { surface?.restore(); surface = undefined; });

/** A minimal valid `args` for a tool, taken from the tool's OWN `minimalArgs` in `contracts.ts`.
 *
 *  ⚠️ **Not a hand-written switch on key names.** The first version guessed, and guessed wrong for
 *  `modoki_prefab` (`action`, not `prefabAction`) — and a guess that is merely *accepted* by zod is
 *  worse than one that is rejected, because it drives the handler down a path production never
 *  takes. `minimalArgs` is the repo's own declaration of a valid call, already exercised by the
 *  contract tests, so a tool whose shape changes brings its fixture with it. */
const minimalArgsFor = (name: string): Record<string, unknown> =>
  ({ ...(CONTRACTS[name as keyof typeof CONTRACTS] as { minimalArgs?: Record<string, unknown> })?.minimalArgs });

/** Every tool that DECLARES `discardUnsaved`, derived from the loaded surface rather than listed
 *  by hand. ⚠️ Must be computed AFTER `loadSurface`, which clears and repopulates the registry —
 *  reading it at module scope returns an empty list and every assertion below passes vacuously. */
const declaringTools = (s: Surface): string[] => {
  const names = toolNames()
    .filter((name) => 'discardUnsaved' in (getTool(name)!.shape as Record<string, unknown>));
  s.restore();
  return names;
};

describe('a refusal names only escapes the agent can take (#889 close-out)', () => {
  it('the derived list is non-empty — otherwise every case below passes vacuously', () => {
    const s = (surface = loadSurface(() => ({ status: 200, body: { ok: true } })));
    expect(s).toBeDefined();
    const declaring = declaringTools(loadSurface(() => ({ status: 200, body: { ok: true } })));
    // The floor, and it is the assertion that makes the derivation trustworthy rather than tidy.
    expect(declaring.length).toBeGreaterThanOrEqual(4);
    expect(declaring, 'the tool this test was written for').toContain('modoki_write_asset');
    // ⚠️ Each covered tool must declare `minimalArgs`, or its fixture silently becomes `{}` and
    // zod rejects the call — which reads as a broken test rather than as the missing declaration
    // it is. `modoki_new_scene` has none, which is why it is excluded below rather than guessed at.
    const withoutFixture = declaring.filter((n) => !Object.keys(minimalArgsFor(n)).length);
    expect(withoutFixture, 'no fixture in contracts.ts — see COVERED').toEqual(['modoki_new_scene']);
  });

  // ⚠️ **Derived, and it was NOT before.** The docblock above claimed the list came from the
  // surface while the loop ran over a hardcoded pair — so three of the five tools that declare the
  // param (`modoki_load_scene`, `modoki_new_scene`, `modoki_prefab`) were unverified, and a SIXTH
  // that declared-and-dropped would have left the floor at 5 >= 4 and gone undetected. That is the
  // same claim-versus-code gap the file exists to catch, in the file that catches it.
  /** Every declaring tool that also has a `minimalArgs` fixture. `modoki_new_scene` declares the
   *  param but no fixture — covering it would mean inventing a call shape, which is the guess this
   *  file just removed; it is named in the floor assertion above so the exclusion is visible. */
  const COVERED = declaringTools(loadSurface(() => ({ status: 200, body: { ok: true } })))
    .filter((n) => Object.keys(minimalArgsFor(n)).length > 0);

  for (const name of COVERED) {
    it(`${name} FORWARDS discardUnsaved to the backend, not just accepts it`, async () => {
      const s = (surface = loadSurface(() => ({ status: 200, body: { ok: true } })));
      await s.call(name, { ...minimalArgsFor(name), discardUnsaved: true });

      const posted = realRequests(s).filter((r) => r.method === 'POST');
      expect(posted.length, 'the handler made no POST').toBeGreaterThan(0);
      expect(
        (posted[posted.length - 1].body as Record<string, unknown> | undefined)?.discardUnsaved,
        `${name} accepted discardUnsaved and dropped it before the request — the refusal that `
        + 'names it as an option is then a dead end',
      ).toBe(true);
    });

    it(`${name} does NOT send discardUnsaved when the caller did not ask`, async () => {
      // The accept side. A handler that hardcoded the flag would pass the case above and silently
      // destroy a human's parked edit on every ordinary write.
      const s = (surface = loadSurface(() => ({ status: 200, body: { ok: true } })));
      await s.call(name, minimalArgsFor(name));

      const posted = realRequests(s).filter((r) => r.method === 'POST');
      expect((posted[posted.length - 1].body as Record<string, unknown> | undefined)?.discardUnsaved)
        .toBeUndefined();
    });
  }
});
