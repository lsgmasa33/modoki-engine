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
 * appears, add it to ALLOWED below with the reason rather than widening the rule — the
 * value of this guard is that "unresolvable" means broken.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { hasInternalGames } from '../helpers/repoLayout';

const REPO = path.resolve(__dirname, '../../..');
const GUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const SKIP_DIR = /^(node_modules|dist|\.cache|ios|android|\.git|ads)$/;

/** GUIDs that legitimately resolve to nothing in committed JSON. Each needs a reason. */
const ALLOWED = new Map<string, string>([
  // (empty — see KNOWN LIMIT above)
]);

function walk(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (SKIP_DIR.test(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
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
      .map((r) => path.join(REPO, r))
      .filter((d) => fs.existsSync(d))
      .flatMap((d) => walk(d));

    const defined = definedGuids(files);
    // Sanity: if the JSON scan silently collected nothing, every code guid would look
    // dangling and this test would "fail loudly" for entirely the wrong reason.
    expect(defined.size, 'the JSON scan found no GUIDs at all — the walk is broken').toBeGreaterThan(100);

    const dangling: string[] = [];
    let scanned = 0;
    for (const f of files) {
      if (!/\.(ts|tsx)$/.test(f) || /\.test\./.test(f)) continue;
      scanned++;
      const src = fs.readFileSync(f, 'utf8');
      for (const raw of src.match(GUID_RE) ?? []) {
        const guid = raw.toLowerCase();
        if (defined.has(guid) || ALLOWED.has(guid)) continue;
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
        + 'delete it, repoint it, or add it to ALLOWED with a reason if it is minted at runtime',
    ).toEqual([]);
  });
});
