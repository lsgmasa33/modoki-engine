/** Guard: no committed `project.pbxproj` defines the same object id twice.
 *
 *  A pbxproj is an object graph keyed by 24-char ids. Defining one id twice is not a syntax
 *  error — `plutil -lint` reports the file as perfectly OK — but the later definition silently
 *  wins, so every reference to the id now resolves to an object of the WRONG CLASS. Xcode then
 *  sends a selector the object does not have and refuses the whole project:
 *
 *      xcodebuild: error: Unable to read project 'App.xcodeproj' …
 *        Reason: The project 'App' is damaged and cannot be opened.
 *        Exception: -[PBXShellScriptBuildPhase buildPhase]: unrecognized selector sent to instance
 *
 *  That is not hypothetical. `games/ota-test` shipped exactly this and was UNBUILDABLE for iOS on
 *  every clone from `7de8607fc` until 2026-08-20, found only when QA-OTA-0001 tried to run
 *  (Testboard bug `doPkkp9y6OmDJWaHFLAZ`). The id `DD0000000000000000000006` defined both a
 *  `PBXBuildFile` (OtaCore.swift, hand-written by the OTA bring-up in `7d35acba5`) and
 *  `healNativeConfig`'s `archiveWarnPhase`, which reserves that literal id in `GD_UUID`.
 *
 *  Two generators minting ids into one hardcoded `DD…` space is the mechanism, and nothing
 *  connected them: heal's own unit test asserts its id appears exactly twice, but only in a
 *  synthetic fixture — never against a committed pbxproj. So the check has to live here, over
 *  the real files.
 *
 *  Deliberately structural: it does not know or care which generator owns which id. Any
 *  duplicate DEFINITION is a damaged project, whoever wrote it.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';
import path from 'node:path';
import { hasInternalGames } from '../helpers/repoLayout';

const repoRoot = path.resolve(__dirname, '..', '..', '..');

/**
 * `\t\t<24-hex id> [/* comment *\/] = {` — a pbxproj object definition.
 *
 * ⚠️ The comment is OPTIONAL and the case is not fixed, and both halves of that were learned
 * the hard way. The first version of this required `/* … *\/` and uppercase, because that is
 * the shape the object that actually collided happened to have — matching the SYMPTOM instead
 * of the pattern. It silently missed the root `PBXProject` object (which carries no comment) in
 * all 20 committed projects, so a collision on the one id every project shares would have
 * sailed through the guard written to catch collisions. Xcode writes ids uppercase, but
 * `healNativeConfig`'s own regexes accept either, and a hand-written id is exactly the kind
 * that collides.
 */
const DEFINITION = /^\t\t([0-9A-Fa-f]{24})(?: \/\* .* \*\/)? = \{/gm;

function definedIds(source: string): string[] {
  return [...source.matchAll(DEFINITION)].map((m) => m[1]);
}

/** ⚠️ Gated on `hasInternalGames()` — the OSS snapshot ships no `games/`, and
 *  `publish-demo.sh` strips `ios/` out of every demo, so the glob below matches ZERO files
 *  there and the "finds the files it is meant to guard" assertion fires. `hasAnyProject()`
 *  would not do: the snapshot does ship demos, but without their native folders, so the
 *  count is still 0. The threshold itself (`> 5`) is a statement about `games/`. */
describe.skipIf(!hasInternalGames())('committed pbxproj object ids', () => {
  const files = globSync('{games,demos}/*/ios/App/App.xcodeproj/project.pbxproj', { cwd: repoRoot });

  it('finds the pbxproj files it is meant to guard', () => {
    // A glob that silently matches nothing would make every assertion below vacuously pass.
    expect(files.length).toBeGreaterThan(5);
  });

  it.each(files)('%s defines every object id exactly once', (rel) => {
    const ids = definedIds(readFileSync(path.join(repoRoot, rel), 'utf8'));
    expect(ids.length).toBeGreaterThan(0);

    const seen = new Set<string>();
    const duplicates = [...new Set(ids.filter((id) => (seen.has(id) ? true : (seen.add(id), false))))];

    expect(
      duplicates,
      `${rel} defines ${duplicates.join(', ')} more than once. A duplicate id makes Xcode refuse the `
      + 'whole project ("The project is damaged and cannot be opened") because references resolve to '
      + 'an object of the wrong class. Renumber the newer object to an id nothing else uses. '
      + 'healNativeConfig.ts reserves TWO ranges, not one: GD_UUID takes '
      + 'DD0000000000000000000001-0006, and WRAPPER_UUID takes D0D0D0D0D0D0D0D0D0D0D0D0.',
    ).toEqual([]);
  });
});
