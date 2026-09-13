/**
 * Invariant guard: a GUID literal in game code must RESOLVE to something.
 *
 * The third side of the asset-ref triangle:
 *   • `assetRefIntegrity.test.ts` — refs in asset/scene JSON resolve (data side).
 *   • `codeAssetRefs.test.ts`     — a code GUID that resolves to an ASSET is a ref the
 *                                   build cannot see (#53). It deliberately IGNORES
 *                                   unresolvable GUIDs, because its job is invisible
 *                                   refs, not broken ones.
 *   • this file                   — a code GUID that resolves to NOTHING is dangling.
 *
 * #70 fell straight through that gap: `games/3d-test` carried
 * `thumbnailUrl: '14e4ba5e-…'` for an asset that no longer existed, and nothing was
 * watching, because the only guard looking at code GUIDs skips exactly the ones that
 * resolve to nothing.
 *
 * WHY THIS IS VIABLE, when the sibling guard's header says such a rule false-positives:
 * that warning is about the ASSET index alone — game code legitimately addresses ENTITIES
 * by guid (demos/postfx-demo names its caption/light/environment entities that way), and
 * an entity guid is not an asset. The fix is simply a wider notion of "defined": asset
 * `id`s AND entity `guid`s, both of which live in committed JSON. Measured across
 * `games/` + `demos/` at the time of writing: 2319 defined GUIDs, 33 literals in game
 * code, **0** unresolvable. So the rule costs nothing today.
 *
 * KNOWN LIMIT: a guid MINTED AT RUNTIME (an entity spawned by code, never serialised)
 * would have no JSON home and would fail here. There is no such case today; if one
 * appears, give it a JSON home or a counted `assertExemptionLedger` row keyed
 * `file::guid` — not a repo-wide name list, and not a widened rule. The value of this guard
 * is that "unresolvable" means broken.
 *
 * ⚠️ The `ALLOWED` Map that used to sit here was EMPTY and repo-wide: its first row would have
 * pardoned one GUID in every game file at once. Deleted in #1140; the classifier is pinned on
 * synthetic source instead, because a clean tree reports zero either way.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { hasInternalGames } from '../helpers/repoLayout';
import { repoFiles } from '../../scripts/repoCorpus.mjs';

const REPO = path.resolve(__dirname, '../../..');
const GUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** The GUID literals in `src` that `defined` does not hold — the classifier, pure so it can be
 *  pinned on synthetic input. Lower-cased, since committed JSON and code disagree on case. */
function danglingGuidsIn(src: string, defined: ReadonlySet<string>): string[] {
  return (src.match(GUID_RE) ?? []).map((raw) => raw.toLowerCase()).filter((g) => !defined.has(g));
}

/** Every file under `root` (a repo-relative POSIX path, e.g. `games`), git-enumerated (#771/#799)
 *  rather than a hand-rolled recursive walk. `ios`/`android` are excluded explicitly because they
 *  are TRACKED native mirrors; `node_modules`/`dist`/`.cache`/`.git`/`ads` need no entry at all —
 *  every one of them is gitignored (or, for `.git`, never emitted by `git ls-files` at all). */
function walk(root: string): string[] {
  return repoFiles({
    under: root,
    exclude: ['ios', 'android'],
    floor: 0,
  }).map(({ abs }) => abs);
}

/** Every GUID that committed JSON DEFINES: asset `id`s and entity `guid`s alike. */
function definedGuids(files: string[]): Set<string> {
  const defined = new Set<string>();
  const visit = (n: unknown): void => {
    if (Array.isArray(n)) { n.forEach(visit); return; }
    if (n && typeof n === 'object') {
      for (const [k, v] of Object.entries(n as Record<string, unknown>)) {
        if ((k === 'id' || k === 'guid') && typeof v === 'string') defined.add(v.toLowerCase());
        visit(v);
      }
    }
  };
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try { visit(JSON.parse(fs.readFileSync(f, 'utf8'))); } catch { /* not our JSON to police */ }
  }
  return defined;
}

describe('GUID literals in game code resolve to a real asset or entity (#70)', () => {
  // The public engine snapshot ships neither games/ nor demos/ — with no game code and no
  // committed JSON to scan, both safety assertions below ("found no GUIDs at all" /
  // "scanned no game .ts files") would fire for the wrong reason: nothing walked, not a
  // broken walker.
  it.skipIf(!hasInternalGames())('has no dangling GUID in games/ or demos/', () => {
    const files = ['games', 'demos']
      .filter((r) => fs.existsSync(path.join(REPO, r)))
      .flatMap((r) => walk(r));

    const defined = definedGuids(files);
    // Sanity: if the JSON scan silently collected nothing, every code guid would look
    // dangling and this test would "fail loudly" for entirely the wrong reason.
    expect(defined.size, 'the JSON scan found no GUIDs at all — the walk is broken').toBeGreaterThan(100);

    const dangling: string[] = [];
    let scanned = 0;
    for (const f of files) {
      if (!/\.(ts|tsx)$/.test(f) || /\.test\./.test(f)) continue;
      scanned++;
      for (const guid of danglingGuidsIn(fs.readFileSync(f, 'utf8'), defined)) {
        dangling.push(`${path.relative(REPO, f)}: ${guid}`);
      }
    }

    // The dangerous direction: if the CODE walk found nothing, `dangling` is empty and this
    // test goes green having checked nothing at all. A guard that can silently become a
    // no-op is worse than no guard, because it reports safety it never verified.
    expect(scanned, 'scanned no game .ts files — the walk is broken, not the repo clean').toBeGreaterThan(20);

    expect(
      [...new Set(dangling)],
      'a GUID literal in game code that no committed asset or entity defines is a dangling ref — '
        + 'delete it or repoint it (see KNOWN LIMIT above if it is minted at runtime)',
    ).toEqual([]);
  });

  it('the classifier reports an undefined GUID and passes a defined one, case-insensitively', () => {
    const defined = new Set(['aaaaaaaa-0000-4000-8000-000000000001']);
    const src = "a('AAAAAAAA-0000-4000-8000-000000000001'); b('bbbbbbbb-0000-4000-8000-000000000002');";
    expect(danglingGuidsIn(src, defined)).toEqual(['bbbbbbbb-0000-4000-8000-000000000002']);
  });
});
