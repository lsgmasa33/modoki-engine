/** Per-clone ports must be DERIVED or injected, never baked into a shared file (#20, #69, #68).
 *
 *  Five clones share this machine (root CLAUDE.md § Clones), each with its own lane — backend
 *  5179..5183, with Vite and CDP derived from it. The authored table is `editorPorts.mjs` (#349);
 *  this file imports it rather than restating it. Anything committed that names
 *  one of those numbers is, by construction, correct for at most ONE clone — and wrong SILENTLY for
 *  the rest, because the call still succeeds, just against a sibling checkout. That is the same
 *  failure shape as the "which editor is this?" gotcha, and it has now happened twice:
 *
 *   - `assert-app-csp.mjs` spawned the packaged app with NO port pinned, so it bound whatever was
 *     free — measured 5179/5173, i.e. the MAIN clone's lane, from a throwaway smoke build (#68).
 *   - `.mcp.json` hardcoded `--browser-url=…:9223`, work-ai's CDP port, in a file every clone reads.
 *
 *  Both are fixed; this guard is what makes a third instance fail at test time instead of costing
 *  someone an afternoon. It asserts the two SHAPES, not the two files, so a new spawner or a new
 *  MCP server is covered without anyone remembering to add it here — and as of #830 that sentence
 *  is TRUE of the spawner half, which until then was a hand-list of two checked against itself.
 *
 *  Deliberately NOT asserted: that a derived port has any particular value (that is
 *  `clonePortCli.test.ts`'s job), and the per-clone `.claude/settings.local.json` files, which are
 *  gitignored precisely so they CAN hold a literal port. */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { hasPrivateTooling } from '../helpers/repoLayout';
import { CLONE_BACKEND_PORTS, vitePortForBackend, cdpPortForBackend } from '../../scripts/editorPorts.mjs';
import { readScannedSource } from '@modoki/engine/testing';
import { repoFiles } from '../../scripts/repoCorpus.mjs';
import { assertDeclaredListIsComplete } from '../helpers/declaredList';

const REPO = path.resolve(__dirname, '../../..');
const read = (rel: string) => readScannedSource(path.join(REPO, rel)).code;
// The public engine snapshot ships neither the committed agent-CLI config
// (.mcp.json) nor engine/scripts/** — both are private-repo-only.
const skip = !hasPrivateTooling();

/** The single committed file that configures an MCP server for an agent CLI — `.mcp.json`, the one
 *  hand-authored source (Cursor/Codex CLI support, and the generated configs mirroring it, were
 *  dropped). */
const MCP_CONFIGS = ['.mcp.json'];

/** The per-clone lanes from root CLAUDE.md § Clones. A literal occurrence of any of these in a
 *  shared config is the bug — UNLESS it is the default of a `${VAR:-…}` expansion, which is the
 *  sanctioned escape: the shared file then carries a sensible default and each clone overrides it
 *  through its own gitignored `.claude/settings.local.json`.
 *
 *  DERIVED, not hand-listed (#349). This list used to stop at three clones — 5179/5180/5181,
 *  5173-5175, 9222-9224 — while five existed, so `modoki-ai3`'s and `modoki-qa`'s lanes were
 *  invisible to the very guard whose job is to spot a baked-in lane. That is the same drift the
 *  guard exists to catch, in the guard itself, and it is why the ports now come from
 *  `editorPorts.mjs` (the one authored table) instead of a literal array here. */
const CLONE_PORTS = Object.values(CLONE_BACKEND_PORTS).flatMap((backend) => [
  backend,
  vitePortForBackend(backend),
  cdpPortForBackend(backend),
]);

/** Strip every `${VAR:-default}` expansion, so what remains is only the genuinely hardcoded text. */
function stripEnvExpansions(src: string): string {
  return src.replace(/\$\{[A-Za-z_][A-Za-z0-9_]*:-[^}]*\}/g, '${…}');
}

describe.skipIf(skip)('committed MCP configs do not hardcode a per-clone port (#68 sibling)', () => {
  for (const rel of MCP_CONFIGS) {
    it(`${rel} names a clone port only as an env-expansion default`, () => {
      const bare = stripEnvExpansions(read(rel));
      const offenders = CLONE_PORTS.filter((p) => new RegExp(`127\\.0\\.0\\.1:${p}\\b`).test(bare));
      expect(
        offenders,
        `${rel} hardcodes 127.0.0.1:${offenders.join('/')} — that is one clone's lane baked into a file `
        + 'every clone reads, so the other clones silently drive the wrong target. Use '
        + '`${VAR:-http://127.0.0.1:<hub-default>}` and put the per-clone value in that clone\'s '
        + 'gitignored .claude/settings.local.json (see root CLAUDE.md § Clones).',
      ).toEqual([]);
    });
  }
});

describe.skipIf(skip)('every harness that SPAWNS the packaged app pins a per-clone backend port (#68)', () => {
  /** Scripts that launch the packaged binary.
   *
   *  ⚠️ **The comment here used to claim this set was "found by the marker … rather than by a
   *  hand-listed set, so a NEW spawner is covered the day it is written." It was a hand-list of
   *  two, and the check below filtered SPAWNERS by itself and compared the result to SPAWNERS —
   *  which can detect a DELETED entry and never an ADDED one (#830).** Four more scripts resolved
   *  the packaged binary through the identical marker and were invisible to it:
   *  `assert-app-renders.sh`, `launch-editor.sh`, `repro-cold-boot.sh`, `test-packaged.sh`. All
   *  four happened to pin their port, so the hole was latent — but the guard was structurally
   *  incapable of noticing a fifth.
   *
   *  Now DERIVED for real. The marker is a reference to `packagedAppPaths.mjs`: a script cannot
   *  launch the packaged app without asking it where the binary is, so anything that spawns one
   *  names it. That over-captures slightly — three files reference the resolver without launching
   *  anything — and over-capturing is the safe direction: each is an EXEMPT row with a reason,
   *  rather than a silent absence. */
  const SPAWNERS = [
    'engine/scripts/assert-app-csp.mjs',
    'engine/scripts/assert-app-renders.sh',
    'engine/scripts/launch-editor.sh',
    'engine/scripts/repro-cold-boot.sh',
    'engine/scripts/smoke-packaged.sh',
    'engine/scripts/test-packaged.sh',
  ];

  /** Spawners that deliberately do NOT derive a per-clone port, with the reason each is safe.
   *  Kept separate from SPAWNERS so the port assertion still RUNS for them and states its verdict,
   *  rather than the script quietly falling out of the list. */
  const DERIVATION_EXEMPT = new Set([
    // `PORT="${PORT:-5188}"` (:47), chosen to sit OUTSIDE every clone lane (5179-5183) rather than
    // inside one: this harness relaunches the packaged app a dozen times in a row, and the comment
    // at :45 is explicit that a run must not be able to drive — or be mistaken for — a live editor.
    // Deriving a per-clone port would put it back INSIDE the range it is avoiding. It is also an
    // env-overridable default, the same `${VAR:-…}` shape the MCP half of this file sanctions.
    // ⚠️ Residual, and unfixed on purpose: two clones running repro-cold-boot AT THE SAME TIME
    // still collide on 5188. That is a real but narrow window (a manual, long-running repro
    // harness), and closing it by deriving would reintroduce the larger hazard above. Pass PORT=
    // explicitly if you need two at once.
    'engine/scripts/repro-cold-boot.sh',
  ]);

  it('the spawner list covers everything that resolves the packaged binary', () => {
    assertDeclaredListIsComplete({
      label: 'SPAWNERS in clonePortHardcoding.test.ts',
      declared: SPAWNERS,
      population: repoFiles({ under: 'engine/scripts', match: /\.(mjs|sh|mts)$/, floor: 20 })
        .map(({ rel }) => rel)
        .filter((rel) => read(rel).includes('packagedAppPaths')),
      floor: 6,
      exempt: [
        {
          item: 'engine/scripts/packagedAppPaths.mjs',
          reason: 'The RESOLVER itself — it is what a spawner asks; it launches nothing.',
        },
        {
          item: 'engine/scripts/clean-packaged-cache.mjs',
          reason: 'Imports `productName`/`killPackaged` to KILL and clean a packaged install — it '
            + 'never launches one, so there is no port for it to pin. Its own subprocesses are '
            + 'tasklist/pgrep/diskutil, all detection and eject.',
        },
      ],
      fix: 'A new script that spawns the packaged app must pin MODOKI_BACKEND_PORT (derive one '
        + 'with clonePort.mjs) and be listed in SPAWNERS. An unpinned spawner binds whatever is '
        + 'free — which is 5179, the HUB clone\'s lane — and silently drives the wrong checkout.',
    });
  });

  it('every DERIVATION_EXEMPT row still names a spawner that does NOT derive (#830 review)', () => {
    // `derives || DERIVATION_EXEMPT.has(rel)` is true either way, so a row survives its own reason:
    // migrate repro-cold-boot.sh onto clonePort.mjs and the carve-out keeps "exempting" a script
    // that would now pass on its own. Same rule the EXEMPT ledgers elsewhere carry — an exemption
    // must currently be load-bearing or it is decoration.
    const useless = [...DERIVATION_EXEMPT]
      .filter((rel) => /clonePort|editorPorts/.test(read(rel)))
      .sort();
    expect(useless, 'These DERIVATION_EXEMPT rows name scripts that now DO derive their port. '
      + 'Delete them — the carve-out is vouching for nothing, and would silently excuse the script '
      + 'if it ever stopped deriving again.').toEqual([]);
    // And the row must still name a real spawner, or it is excusing a file nothing checks.
    const orphaned = [...DERIVATION_EXEMPT].filter((rel) => !SPAWNERS.includes(rel)).sort();
    expect(orphaned, 'These DERIVATION_EXEMPT rows are not in SPAWNERS, so nothing they excuse is '
      + 'ever tested.').toEqual([]);
  });

  for (const rel of SPAWNERS) {
    it(`${rel} pins MODOKI_BACKEND_PORT`, () => {
      expect(
        read(rel).includes('MODOKI_BACKEND_PORT'),
        `${rel} launches the packaged app without pinning MODOKI_BACKEND_PORT, so main.ts's `
        + 'sticky-then-scan binds whatever is free — which is 5179, the main clone\'s editor backend. '
        + 'Derive one with clonePort.mjs (see the note in assert-app-csp.mjs).',
      ).toBe(true);
    });

    it(`${rel} derives that port per clone rather than hardcoding one`, () => {
      // ⚠️ **This marker used to be `/clonePort/` alone, and that was too narrow (#830).** There
      // are TWO sanctioned derivations, and root CLAUDE.md names the other one as the primary:
      // "Every launch path derives the backend port from the CLONE DIRECTORY
      // (engine/scripts/editorPorts.mjs, the one authored table)". `launch-editor.sh:84` and
      // `test-packaged.sh` both derive correctly through `editorPorts.mjs` and were invisible to
      // the old guard — it simply never scanned them, so the narrowness never showed. Widening
      // the SPAWNER list is what exposed it: a marker is only tested by the population it meets.
      const derives = /clonePort|editorPorts/.test(read(rel));
      expect(
        derives || DERIVATION_EXEMPT.has(rel),
        `${rel} must derive its port from clonePort.mjs or editorPorts.mjs (#20/#69/#349 — the `
        + 'sanctioned implementations), not pick a constant: two clones running this at once '
        + 'would otherwise collide.',
      ).toBe(true);
    });
  }
});
