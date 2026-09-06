/** Game-registered MCP tools are namespaced by their game (#270).
 *
 *  `registerAgentTool` puts a GAME's tool on the shared `modoki` MCP surface, beside the engine's
 *  `modoki_*` ones. Two names therefore have to hold across the whole repo, and neither can be
 *  enforced where it is broken:
 *
 *    - **`modoki_` is the engine's.** The registry itself throws on it, so this is belt-and-braces.
 *    - **A game tool starts with its own game id.** This one CANNOT be a runtime check, and that
 *      is the interesting part. The registry is a pure module in the package; it has no idea which
 *      game is calling it. Checking at the bridge instead would mean a mis-named tool registers
 *      fine and then silently fails to appear — the exact invisible-failure shape the seam was
 *      built to remove. So it is checked HERE, statically, where the failure is a red build with
 *      the offending file named.
 *
 *  Why it matters at all: a game claiming a bare `load_level` reads like an engine tool in a tool
 *  list, and collides with the next game that wants the same obvious name. With one project open
 *  at a time that collision is rare — which is precisely why it would be found late.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readScannedSource } from '@modoki/engine/testing';
import { PROJECT_ROOT_DIRS } from '../../scripts/projectRoots.mjs';
import { repoFiles } from '../../scripts/repoCorpus.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** `registerAgentTool({ … name: 'x' … })` — matched on the `name:` field of a call, which is the
 *  only form the API has. A dynamic name would slip past this; that is a deliberate limit, noted
 *  rather than papered over, and `expect(found).not.toHaveLength(0)` below is what keeps the
 *  regex from silently matching nothing after a refactor. */
const CALL_RE = /registerAgentTool\(\s*\{[\s\S]*?\bname:\s*'([^']+)'/g;

/** Every `.ts`/`.tsx` file under a project, git-enumerated (#771/#799) rather than a hand-rolled
 *  recursive walk. `ios`/`android` are excluded explicitly because they are TRACKED native
 *  mirrors; `node_modules`/`dist` need no entry at all — both are gitignored. */
function tsFilesUnder(projectRel: string): string[] {
  return repoFiles({
    under: projectRel,
    match: /\.tsx?$/,
    exclude: ['ios', 'android'],
    floor: 0,
  }).map(({ abs }) => abs);
}

/** The project's declared game id (`game.ts`'s `id:`), falling back to the directory name — the
 *  two are the same for every project today, and the fallback keeps a project without a parseable
 *  `game.ts` from silently skipping the check. */
function gameIdOf(projectDir: string): string {
  const gameTs = path.join(projectDir, 'game.ts');
  if (fs.existsSync(gameTs)) {
    const m = /^\s*id:\s*'([^']+)'/m.exec(readScannedSource(gameTs).code);
    if (m) return m[1];
  }
  return path.basename(projectDir);
}

type Found = { file: string; tool: string; gameId: string };

const found: Found[] = [];
/** Files that MENTION the API, counted independently of CALL_RE. This is what separates the two
 *  ways `found` can be empty: a tree that ships no project using the API at all (the OSS
 *  snapshot drops `games/`, and no published demo registers a tool) versus one where the call
 *  shape moved out from under the regex. Only the second is a defect, and conflating them made
 *  this guard fail inside the publish snapshot. */
let mentioningFiles = 0;
for (const root of PROJECT_ROOT_DIRS) {
  const rootAbs = path.join(repoRoot, root);
  if (!fs.existsSync(rootAbs)) continue;
  for (const entry of fs.readdirSync(rootAbs, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const projectDir = path.join(rootAbs, entry.name);
    const gameId = gameIdOf(projectDir);
    for (const file of tsFilesUnder(`${root}/${entry.name}`)) {
      const src = readScannedSource(file).code;
      if (!src.includes('registerAgentTool')) continue;
      mentioningFiles += 1;
      for (const m of src.matchAll(CALL_RE)) {
        found.push({ file: path.relative(repoRoot, file), tool: m[1], gameId });
      }
    }
  }
}

describe('game-registered agent tool names', () => {
  // Without this the whole file passes vacuously the moment the regex stops matching — a guard
  // that guards nothing, which is worse than no guard because it reads as coverage.
  it('finds the registrations it is meant to check', () => {
    // Nothing in this tree uses the API — the publish snapshot, which ships no `games/`. There is
    // genuinely nothing to check, so skipping is honest; failing here would fail the snapshot on
    // the ABSENCE of private content rather than on a defect.
    if (mentioningFiles === 0) return;
    expect(found.length, `${mentioningFiles} file(s) under games/ or demos/ mention registerAgentTool `
      + 'but no ({name:…}) call matched — the API or its call shape changed, so this guard stopped '
      + 'checking and must be updated, not deleted.')
      .toBeGreaterThan(0);
  });

  it('every game tool is prefixed with its own game id', () => {
    const offenders = found.filter((f) => !f.tool.startsWith(`${f.gameId}_`));
    expect(offenders, 'a game tool must be named <gameId>_<verb> so it cannot be mistaken for an '
      + 'engine tool or collide with another game\'s').toEqual([]);
  });

  it('no game tool claims the engine\'s modoki_ namespace', () => {
    expect(found.filter((f) => f.tool.startsWith('modoki_'))).toEqual([]);
  });

  it('no two projects declare the same tool name', () => {
    const byName = new Map<string, string[]>();
    for (const f of found) byName.set(f.tool, [...(byName.get(f.tool) ?? []), f.file]);
    expect([...byName].filter(([, files]) => files.length > 1)).toEqual([]);
  });
});
