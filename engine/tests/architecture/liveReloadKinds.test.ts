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
 *
 * A FOURTH gap, closed by #857's close-out: every check above cross-checks `classifySceneChange`
 * against its consumer — none of them ask whether a given watcher even REACHES
 * `classifySceneChange` with the right input. `onChange` in `engine/plugins/vite-asset-scanner.ts`
 * (the Vite dev-server watcher) and its independent twin in `engine/electron/assetBackend.ts` (the
 * Electron main-process watcher — the DEFAULT editor surface per CLAUDE.md, and what the `modoki`
 * MCP drives) each decided, on their OWN, whether a changed file was even a candidate to classify —
 * both tested `extname(file).toLowerCase() === '.json'` directly. When #857 taught the Vite side to
 * remap a shader BODY (`.glsl`/`.wgsl`) to its sibling `.shader.json` descriptor before classifying,
 * the fix reached only the file that shared `classifySceneChange`'s CALL: the raw `.json` extension
 * test itself was the one line left duplicated — the same shape as the THIRD gap's
 * `classifySceneChange` duplication, one call site over. So the fix worked in a browser and stayed
 * dead in Electron dev/packaged. `pathToClassifyForChange` (`vite-asset-scanner.ts`) is now the
 * single shared gate; the check below asserts every watcher implementation calls it instead of
 * re-testing the extension itself — found by ENUMERATING watcher implementations (any file
 * registering a chokidar/`.watcher.on` handler that also classifies via `classifySceneChange`)
 * rather than a hand-typed two-file list, so a third such watcher is swept in automatically instead
 * of silently passing outside the list.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { readScannedSource } from '@modoki/engine/testing';
import { repoFiles } from '../../scripts/repoCorpus.mjs';
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
      + 'now UNIVERSAL across the ways a file moves, which it was not until #867. #854 fixed '
      + 'the Assets-panel rename only — applyMovesToParkedAssets carries `ifMatch` across the '
      + 'move — leaving `modoki_move_asset` (out-of-process) and a dragged FOLDER (no prefix '
      + 'move was built) to bypass the repair entirely, because it was wired to CALL SITES '
      + 'rather than to the move. #867 moved it onto the move: /api/move-file and '
      + '/api/delete-asset now call the renderer back through requestBrowser, and the folder '
      + 'drag builds a prefix move. ⚠️ What is still NOT covered is a move this repo does not '
      + 'make — a shell `mv`, or any writer that is not one of those two routes; the watcher '
      + 'sees it as an unrelated unlink+add and no repair runs. So read this reason as '
      + '"protected on every path the editor and the agent surface can take". '
      + '⚠️ Separately, one HALF of this reason has an answer now, and it is deliberately not '
      + 'being used here: #857 added `viaSibling`, so a broadcast CAN reach the invalidator '
      + 'without dropParkedWriteFor firing at all. That defuses the silent-discard objection '
      + 'but not the CAS one above, and a `.meta.json` write is a direct write to its own file '
      + 'rather than a sibling-raised one, so the flag would be false for it anyway — it is not '
      + 'the lever that would make adding this kind safe.',
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

/**
 * Every watcher that classifies a changed file via `classifySceneChange` must decide WHAT to
 * classify through the one shared `pathToClassifyForChange` (#857) — never by re-testing
 * `extname(file) === '.json'` itself. Two independent copies of that test is exactly how #857
 * happened: the Vite plugin's `onChange` was taught to remap a shader BODY (`.glsl`/`.wgsl`) to
 * its sibling `.shader.json` descriptor before classifying, and the fix landed only there — the
 * raw extension check in the Electron backend's OWN `onChange` was the one line the previous
 * `classifySceneChange`-sharing fix (the THIRD gap above) left duplicated, so it kept gating on
 * the un-remapped body path and the whole feature was dead on Electron dev/packaged, the DEFAULT
 * editor surface per CLAUDE.md.
 *
 * `findWatcherClassifierFiles` below is a genuine ENUMERATION, not a hardcoded pair: it walks the
 * tracked corpus (`repoCorpus.mjs`, git-sourced) for any `.ts`/`.tsx` file that both registers a
 * watcher (`chokidar.watch(` or the Vite dev server's `server.watcher.on(`) AND classifies via
 * `classifySceneChange` — the two independent signals that together mean "this is one of the
 * producer's own watcher implementations", not merely a file that mentions either concept in
 * passing (`agentBridge.ts` and `dirtyAssets.ts` reference `classifySceneChange` too, as the
 * CONSUMER, but neither registers a watcher, so neither is swept in). Exactly two files satisfy
 * both today; a third watcher grown anywhere in the tree that also classifies scene changes is
 * swept in automatically and held to the same rule, rather than silently passing outside a
 * hand-typed list the way the THIRD gap's fix once did.
 */
describe('live-reload watchers share ONE extension gate, not two (#857)', () => {
  /** A real watcher registration in this codebase — `chokidar`'s own watch call (the Electron
   *  backend) or the Vite dev server's watcher `.on(` (verified: repo-wide, only two files match
   *  either shape today). Deliberately checked against COMMENT-BLANKED code below, not raw text:
   *  this very describe block's own docblock and comments talk ABOUT both shapes in prose, and a
   *  raw-text match would flag this test file itself as a watcher implementation (measured while
   *  writing this guard — the fail mode `readScannedSource`'s own module doc warns about, landing
   *  here on the first attempt). */
  const WATCHER_REGISTRATION = /chokidar\.watch\(|\.watcher\.on\(/;

  function findWatcherClassifierFiles(): string[] {
    // `.ts`/`.tsx` repo-wide — floored far under even the smallest real corpus (the public OSS
    // snapshot alone ships thousands under `engine/`), so a collapsed enumeration trips this
    // before it ever reaches the file-content check.
    const candidates = repoFiles({ match: (rel: string) => /\.tsx?$/.test(rel), floor: 500 });
    const out: string[] = [];
    for (const { abs } of candidates) {
      let raw: string;
      try { raw = fs.readFileSync(abs, 'utf8'); } catch { continue; } // tracked but absent locally
      // Cheap RAW pre-filter first — narrows the whole repo down to a handful of candidates
      // before paying for a comment-blanked parse of each. Widening the candidate set here is
      // harmless (a raw mention that turns out to be prose is dropped by the blanked check next);
      // narrowing it here would not be, so this check only ever ADDS candidates relative to the
      // authoritative one below.
      if (!WATCHER_REGISTRATION.test(raw) || !raw.includes('classifySceneChange')) continue;
      // The authoritative check: comment-blanked, so a file that only ever DISCUSSES a watcher
      // registration or `classifySceneChange` — like this describe block's own docblock — cannot
      // satisfy it.
      const { code } = readScannedSource(abs);
      if (WATCHER_REGISTRATION.test(code) && code.includes('classifySceneChange')) out.push(abs);
    }
    return out;
  }

  /** No whitespace/quote-variant escape: `extname` call, optional `.toLowerCase()`, `===`, a
   *  quoted `.json` — the exact shape of the duplicated line in both its historical spellings. */
  const EXTENSION_GATE = /extname\s*\([^)]*\)\s*(?:\.\s*toLowerCase\s*\(\s*\)\s*)?===\s*(['"])\.json\1/;

  /** Slice the `onChange` handler's body out of comment-blanked source (balanced braces — same
   *  idiom as invalidatorGranularity.test.ts's extractFunctionBody), so a mention of the extension
   *  gate in a COMMENT can neither satisfy nor defeat this check. Both watcher files declare the
   *  handler the same way: `const onChange = (file: string) => { ... };`. */
  function extractOnChangeBody(code: string, label: string): string {
    const sigIdx = code.indexOf('const onChange = (');
    if (sigIdx === -1) {
      throw new Error(`${label}: "const onChange = (" not found — did the watcher handler move or get renamed?`);
    }
    const braceStart = code.indexOf('{', sigIdx);
    if (braceStart === -1) throw new Error(`${label}: no "{" found after "const onChange = ("`);
    let depth = 1;
    let j = braceStart + 1;
    while (depth > 0 && j < code.length) {
      if (code[j] === '{') depth++;
      else if (code[j] === '}') depth--;
      j++;
    }
    return code.slice(braceStart, j);
  }

  const watcherFiles = findWatcherClassifierFiles();

  it('found watcher implementations to check (sanity: the enumeration works, so a pass means something)', () => {
    // At least the two known today (vite-asset-scanner.ts, assetBackend.ts) — `toBeGreaterThan`
    // rather than `toBe` so a genuine third implementation does not itself fail this sanity check.
    expect(watcherFiles.length).toBeGreaterThan(1);
  });

  it("no watcher's onChange re-implements the .json extension gate — all call pathToClassifyForChange", () => {
    const violators: string[] = [];
    for (const abs of watcherFiles) {
      const rel = path.relative(REPO, abs).split(path.sep).join('/');
      const { code } = readScannedSource(abs);
      const body = extractOnChangeBody(code, rel);
      if (EXTENSION_GATE.test(body)) {
        violators.push(
          `${rel}: onChange still tests extname(...) === '.json' directly instead of going through ` +
          'pathToClassifyForChange — this is the exact duplicated line #857 exposed: a shader BODY ' +
          '(.glsl/.wgsl) never satisfies a raw .json test, so this watcher can never broadcast a ' +
          'shader-body edit no matter what pathToClassifyForChange itself does.',
        );
      }
      if (!/pathToClassifyForChange\s*\(/.test(body)) {
        violators.push(
          `${rel}: onChange does not call pathToClassifyForChange — every watcher must resolve the ` +
          'path to classify through the one shared helper, not its own logic, so the two watchers ' +
          'cannot drift apart the way they did in #857.',
        );
      }
    }
    expect(violators, violators.join('\n')).toEqual([]);
  });
});
