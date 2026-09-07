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
 *
 * A THIRD gap, found by #832/#831's close-out (#842): `material` and `shader` are two of the nine
 * `ASSET_SCHEMA_TYPES` — agent-writable via `/api/asset-write`, and parkable in the Inspector via
 * `persistAssetEdit` — but were absent from `LiveReloadKind` entirely, not just from
 * `classifySceneChange`'s branches. Every check above still passed, because they all start from
 * `PRODUCER`/`CONSUMER` — the two sides can agree with each other while agreeing on a set that is
 * narrower than what the rest of the system actually reads and writes. That is the exact shape that
 * let `animset` hide from the first two checks too, except this time the missing types were never
 * caught by `invalidatorsAreReachable.test.ts` either, because `invalidateMaterial` WAS wired to a
 * real (Inspector) caller — the missing half was the live-reload broadcast, which only this file
 * checks. The test below closes it by asking a THIRD, independent question: does every
 * agent-writable/parkable asset type appear in `LiveReloadKind` at all?
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { readScannedSource } from '@modoki/engine/testing';
import { ASSET_SCHEMA_TYPES } from '../../packages/modoki/src/runtime/assets/assetSchemas';

const REPO = path.resolve(__dirname, '../../..');
const producerSrc = readScannedSource(path.join(REPO, 'engine/plugins/vite-asset-scanner.ts')).code;
const consumerSrc = readScannedSource(path.join(REPO, 'engine/app/debug/agentBridge.ts')).code;

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

  // ⚠️ A SCAN, and the weakest kind — but it is the only thing that can see this. `handleSceneChanged`
  // is reachable only through the Vite-HMR and Electron-IPC handlers, never through a registry or an
  // agent op, so nothing in the test suite can drive it: removing the `fireDirtyListeners()` call
  // below left all 6664 tests in the scoped suites GREEN (measured, close-out of #842). That is
  // exactly the "unreachable mechanism" this file exists for, one level up.
  it('the invalidator branch WAKES a render, not just the cache (#842 close-out)', () => {
    const fn = consumerSrc.slice(consumerSrc.indexOf('async function handleSceneChanged'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    const branch = body.slice(body.indexOf('if (invalidateCachedAsset)'));
    const branchBody = branch.slice(0, branch.indexOf('\n  }'));
    expect(
      /fireDirtyListeners\s*\(/.test(branchBody),
      'The invalidator branch of handleSceneChanged invalidates a cache and returns without waking a '
        + 'render gate. While the sim is STOPPED, Scene2D\'s idle gate (Scene2D.tsx, the '
        + '`!isSimRunning() && !this._externalDirty` early return) skips the entire frame, so the '
        + 'viewport keeps showing PRE-EDIT pixels indefinitely — which is verbatim the symptom the '
        + 'ASSET_CACHE_INVALIDATORS table exists to prevent. Invalidating a cache nothing redraws is '
        + 'not an invalidation. Call fireDirtyListeners() (runtime/core/renderDirty) after the '
        + 'invalidation; it wakes every subscribed surface, for all kinds in the table.',
    ).toBe(true);
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

  /** Asset types this test deliberately does NOT require in `LiveReloadKind`, each with the
   *  reason a broadcast genuinely isn't needed. Add a name here only with a verified reason, never
   *  to silence a failure. */
  const NOT_LIVE_RELOADABLE: Record<string, string> = {
    atlas: 'protected by an ifMatch compare-and-swap checked server-side at write time (#831), ' +
      'not by a watcher-driven park-drop — adding it to LiveReloadKind would let ' +
      'dropParkedWriteFor (#439/#469) silently discard a human\'s parked edit, exactly the ' +
      'silent-discard behaviour #831 replaced with a human-resolved fork. ⚠️ The CAS premise is '
      + 'STILL not universal, and the caveat has only NARROWED. #854 fixed the Assets-panel '
      + 'rename — applyMovesToParkedAssets now carries `ifMatch` across the move '
      + '(assetEditorBindings.test.ts pins it). It did NOT fix the other ways a file moves: the '
      + 'repair is client-side and per-call-site, so `modoki_move_asset` (out-of-process, POSTs '
      + '/api/move-file and nothing else) and a dragged FOLDER (isFolder is dropped, so no '
      + 'prefix move is built) both bypass it entirely. That is #867; until it lands, '
      + 'read this reason as "protected on the rename path", not "protected".',
  };

  it('every agent-writable/parkable asset type is in LiveReloadKind (#842)', () => {
    // `ASSET_SCHEMA_TYPES` is what `/api/asset-write` accepts and what the Inspector can park
    // (assetSchemas.ts). A type missing from `LiveReloadKind` gets no broadcast AT ALL — not "no
    // invalidator", not "falls through classifySceneChange to null", but never even a candidate
    // kind — so `dropParkedWriteFor` can never run for it (a stale parked edit clobbers a newer
    // on-disk write at Cmd+S) and no cache invalidation can ever fire for an external write. This
    // is exactly what let #831 widen the agent-writable set from 5 to 8 types while every test in
    // this file stayed green: `material` and `shader` were absent from LiveReloadKind itself, so
    // the producer/consumer cross-checks above — which only ever compare the two sides to EACH
    // OTHER — had nothing to disagree about.
    const missing = ASSET_SCHEMA_TYPES.filter(
      (t) => !(t in NOT_LIVE_RELOADABLE) && !PRODUCER.includes(t),
    );
    expect(
      missing,
      'These ASSET_SCHEMA_TYPES are agent-writable/parkable but missing from LiveReloadKind in ' +
        'engine/plugins/vite-asset-scanner.ts, so classifySceneChange can never return them, no ' +
        'modoki:scene-changed broadcast ever fires for them, dropParkedWriteFor never runs, and no ' +
        'cache is ever invalidated for an external write. Add each one to LiveReloadKind + a ' +
        '`type === \'<kind>\'` branch in classifySceneChange + SceneChangedKind + ' +
        'ASSET_CACHE_INVALIDATORS in agentBridge.ts — or, if a broadcast is genuinely not needed, ' +
        'add it to NOT_LIVE_RELOADABLE above with a verified reason.',
    ).toEqual([]);
  });
});
