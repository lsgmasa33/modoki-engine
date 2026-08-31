/**
 * The live-reload kind unions on both sides of the wire agree, and every kind is HANDLED (#74).
 *
 * This guards the root cause of a defect that occurred FIVE times, not the five symptoms:
 *
 *   `invalidateAnimationClip` · `invalidateTimeline` · `invalidateParticleEffect` ·
 *   `invalidateSpriteAnim` · `invalidateRig2D`
 *
 * — each shipped exported, unit-tested, and with ZERO production callers. Each caused the same
 * silent failure: the asset keeps working with its PRE-EDIT contents, so it reads as "my change was
 * ignored" rather than as a stale cache, and a read-modify-write round-trip
 * (`read_asset_def` → `write_asset`) reverts the file that was just written, because the read
 * reports the live cache as authoritative.
 *
 * The cause is a producer/consumer pair kept in step BY HAND:
 *   - producer: `LiveReloadKind` + `classifySceneChange` in `engine/plugins/vite-asset-scanner.ts`
 *   - consumer: `SceneChangedKind` + `ASSET_CACHE_INVALIDATORS` in `engine/app/debug/agentBridge.ts`
 *
 * They cannot share a type — the plugin is a Node module and the app tsconfig has no node types,
 * which is why the consumer redeclares the union with a "keep the two in sync" comment. Three
 * instances were fixed one at a time, each leaving a comment explaining the class, and instances
 * four and five happened anyway. A comment is not a mechanism; this test is.
 *
 * Deliberately source-parsing rather than importing: importing the plugin into the app test program
 * is the exact thing the type split exists to avoid. Same idiom as this repo's other architecture
 * guards (reapScoping, determinismGuard, testTypecheckCoverage, barrelSurface).
 *
 * A second gap, found by mutation this session: deleting `if (type === 'animset') return 'animset';`
 * from `classifySceneChange` while leaving `'animset'` in the `LiveReloadKind` union left every test
 * below green — a union member with no branch in `classifySceneChange` silently falls through to
 * `return null` (no broadcast, ever) and nothing here noticed. The added test below closes that by
 * requiring every union member to appear in an explicit `type === '<kind>'` branch.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(__dirname, '../../..');
const producerSrc = fs.readFileSync(path.join(REPO, 'engine/plugins/vite-asset-scanner.ts'), 'utf8');
const consumerSrc = fs.readFileSync(path.join(REPO, 'engine/app/debug/agentBridge.ts'), 'utf8');

/** Members of a `type X = 'a' | 'b'` declaration. */
function unionMembers(src: string, typeName: string): string[] {
  const m = new RegExp(`type ${typeName}\\s*=\\s*([^;]+);`).exec(src);
  if (!m) throw new Error(`could not find "type ${typeName} = …" — did it move or get renamed?`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
}

const PRODUCER = unionMembers(producerSrc, 'LiveReloadKind');
const CONSUMER = unionMembers(consumerSrc, 'SceneChangedKind');

describe('live-reload kinds: producer and consumer cannot drift (#74)', () => {
  it('found both unions (sanity: the parse works, so a pass means something)', () => {
    expect(PRODUCER.length).toBeGreaterThan(2);
    expect(CONSUMER.length).toBeGreaterThan(2);
  });

  it('the two unions have identical members', () => {
    // A kind the producer broadcasts but the consumer has never heard of is silently ignored — the
    // exact shape of all five prior instances.
    expect(CONSUMER, 'agentBridge.SceneChangedKind must match vite-asset-scanner.LiveReloadKind')
      .toEqual(PRODUCER);
  });

  it('every kind classifySceneChange can RETURN is in the union', () => {
    const returned = [...producerSrc.matchAll(/return '([a-z0-9]+)';/g)].map((m) => m[1]);
    const classifyBody = producerSrc.slice(producerSrc.indexOf('export function classifySceneChange'));
    const inClassify = [...classifyBody.slice(0, classifyBody.indexOf('\n}')).matchAll(/return '([a-z0-9]+)';/g)].map((m) => m[1]);
    expect(inClassify.length, 'classifySceneChange should return several kinds').toBeGreaterThan(2);
    for (const kind of inClassify) expect(PRODUCER).toContain(kind);
    expect(returned.length).toBeGreaterThan(0);
  });

  it('every kind in the union has an explicit branch in classifySceneChange', () => {
    // Every current member (scene, prefab, animation, timeline, particle, spriteanim, rig2d) is
    // returned from its own `type === '<kind>'` comparison — none of them reach `classifySceneChange`
    // by falling through a default/else. If a future kind legitimately needs another route, it must
    // be added to this exception list explicitly, not silently exempted.
    const NO_DIRECT_COMPARISON: string[] = [];
    const classifyBody = producerSrc.slice(producerSrc.indexOf('export function classifySceneChange'));
    const fnBody = classifyBody.slice(0, classifyBody.indexOf('\n}'));
    const missing = PRODUCER.filter(
      (k) => !NO_DIRECT_COMPARISON.includes(k) && !new RegExp(`type === '${k}'`).test(fnBody),
    );
    expect(
      missing,
      'These LiveReloadKind members have no `type === \'<kind>\'` branch in classifySceneChange, so ' +
        'a file of that kind falls through to `return null` — no broadcast ever fires, and the asset ' +
        'silently keeps its pre-edit contents forever. Add an explicit branch (or, if it genuinely ' +
        'reaches classifySceneChange by another route, add it to NO_DIRECT_COMPARISON above with a ' +
        'comment saying how).',
    ).toEqual([]);
  });

  it('every kind is HANDLED — a cache invalidator, or an explicit scene-reload kind', () => {
    // `scene` and `prefab` fall through to the scene-reload path on purpose; everything else must
    // have an entry in the invalidator table, or it reaches the renderer and does nothing.
    const SCENE_RELOAD_KINDS = ['scene', 'prefab'];
    const table = consumerSrc.slice(consumerSrc.indexOf('const ASSET_CACHE_INVALIDATORS'));
    const tableBody = table.slice(0, table.indexOf('};'));
    const unhandled = PRODUCER.filter(
      (k) => !SCENE_RELOAD_KINDS.includes(k) && !new RegExp(`\\b${k}:`).test(tableBody),
    );
    expect(
      unhandled,
      'These kinds are broadcast but have no invalidator entry, so the renderer receives them and '
        + 'does nothing — the asset keeps its pre-edit contents and a read-modify-write reverts the '
        + 'file. Add them to ASSET_CACHE_INVALIDATORS (or to SCENE_RELOAD_KINDS here if a full '
        + 'scene reload really is intended).',
    ).toEqual([]);
  });
});
