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
 *  MCP server is covered without anyone remembering to add it here.
 *
 *  Deliberately NOT asserted: that a derived port has any particular value (that is
 *  `clonePortCli.test.ts`'s job), and the per-clone `.claude/settings.local.json` files, which are
 *  gitignored precisely so they CAN hold a literal port. */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { hasPrivateTooling } from '../helpers/repoLayout';
import { CLONE_BACKEND_PORTS, vitePortForBackend, cdpPortForBackend } from '../../scripts/editorPorts.mjs';

const REPO = path.resolve(__dirname, '../../..');
const read = (rel: string) => readFileSync(path.join(REPO, rel), 'utf8');
// The public engine snapshot ships neither the committed agent-CLI configs
// (.mcp.json/.cursor/.codex) nor engine/scripts/** — both are private-repo-only.
const skip = !hasPrivateTooling();

/** Every committed file that configures an MCP server for an agent CLI. The root `.mcp.json` is the
 *  source; the other two are GENERATED from it by `npm run sync:agent-configs` — included here so a
 *  hand-edit (which the doc conventions forbid) cannot smuggle a literal port past this guard. */
const MCP_CONFIGS = ['.mcp.json', '.cursor/mcp.json', '.codex/config.toml'];

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
  /** Scripts that launch the packaged binary. Found by the marker every such script needs — it must
   *  resolve the executable inside the app dir — rather than by a hand-listed set, so a NEW spawner
   *  is covered the day it is written. */
  const SPAWNERS = ['engine/scripts/smoke-packaged.sh', 'engine/scripts/assert-app-csp.mjs'];

  it('the spawner list still matches what actually resolves the packaged binary', () => {
    // If this fails, a spawner was added or renamed: add it above (and pin its port) rather than
    // relaxing the check — an unpinned spawner is exactly the #68 defect.
    const resolvesBinary = SPAWNERS.filter((f) => existsSync(path.join(REPO, f)))
      .filter((f) => /binInAppDir|appDir|\bbin\b/.test(read(f)));
    expect(resolvesBinary.sort()).toEqual([...SPAWNERS].sort());
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
      expect(
        /clonePort/.test(read(rel)),
        `${rel} must derive its port from clonePort.mjs (#20/#69 — the ONE implementation), not pick `
        + 'a constant: two clones running this at once would otherwise collide.',
      ).toBe(true);
    });
  }
});
