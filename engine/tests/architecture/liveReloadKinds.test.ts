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
import {
  accessPath, callsTo, callsToPath, calleeName, enclosingFunction, findNodes, flatText, functionsNamed, objectLiteralKeys,
  parseSource, printedText, readsOf, stringValueOf, ts, typesNamed, unwrapValue, variablesNamed,
} from '@modoki/engine/testing/sourceAst';
import { assertExemptionLedger } from '@modoki/engine/testing/exemptionLedger';
import { repoFiles } from '../../scripts/repoCorpus.mjs';
import { ASSET_SCHEMA_TYPES } from '../../packages/modoki/src/runtime/assets/assetSchemas';

const REPO = path.resolve(__dirname, '../../..');
// ⚠️ **Every unit here is read through the parser (#1195).** They used to be text: a union was
// `type X = ([^;]+);`, `classifySceneChange` and `handleSceneChanged` ran to the first `'\n}'`, the
// invalidator branch to the first `'\n  }'`, the table to the first `'};'`, and `onChange` was
// brace-counted from `const onChange = (` — then regexes over each slice.
const producerSf = parseSource(readScannedSource(path.join(REPO, 'engine/plugins/vite-asset-scanner.ts')).code, 'vite-asset-scanner.ts');
const consumerSf = parseSource(readScannedSource(path.join(REPO, 'engine/app/debug/agentBridge.ts')).code, 'agentBridge.ts');

/** The string members of `type <typeName> = 'a' | 'b'`, sorted. A member that is not a string literal
 *  comes back as `<its text>`, so it cannot pass as a kind. */
function unionMembers(sf: ts.SourceFile, typeName: string): string[] {
  const decls = typesNamed(sf, typeName).filter(ts.isTypeAliasDeclaration);
  if (decls.length !== 1) throw new Error(`could not find one "type ${typeName} = …" in ${sf.fileName} — did it move or get renamed?`);
  let t: ts.TypeNode = decls[0]!.type;
  while (ts.isParenthesizedTypeNode(t)) t = t.type;
  const members = ts.isUnionTypeNode(t) ? t.types : [t];
  return members.map((m) => (ts.isLiteralTypeNode(m) && ts.isStringLiteral(m.literal) ? m.literal.text : `<${printedText(m)}>`)).sort();
}

/** The one function named `name` in `sf`. */
function oneFunction(sf: ts.SourceFile, name: string): ts.FunctionLikeDeclaration & { body: ts.ConciseBody } {
  const fns = functionsNamed(sf, name);
  if (fns.length !== 1) throw new Error(`expected one function named ${name} in ${sf.fileName}, found ${fns.length}`);
  return fns[0]!;
}

/** Every value `classifySceneChange` itself returns (not a nested function's): each arm of a `? :`, a string
 *  literal as its text, anything else but `null` as `<its text>`. */
function classifyReturns(sf: ts.SourceFile): string[] {
  const fn = oneFunction(sf, 'classifySceneChange');
  const values = (e: ts.Expression): string[] => {
    const u = unwrapValue(e);
    if (ts.isConditionalExpression(u)) return [...values(u.whenTrue), ...values(u.whenFalse)];
    if (u.kind === ts.SyntaxKind.NullKeyword) return [];
    const v = stringValueOf(u);
    return [v === undefined ? `<${printedText(u)}>` : v];
  };
  return findNodes(fn.body, ts.isReturnStatement)
    .filter((r) => enclosingFunction(r) === fn && !!r.expression)
    .flatMap((r) => values(r.expression!));
}

/** The kinds `classifySceneChange` answers from an explicit `if (type === '<kind>') return '<kind>';` — the
 *  comparison AND the return naming the same kind. */
function classifyBranches(sf: ts.SourceFile): string[] {
  const fn = oneFunction(sf, 'classifySceneChange');
  return findNodes(fn.body, ts.isIfStatement).filter((s) => enclosingFunction(s) === fn).flatMap((s) => {
    const t = unwrapValue(s.expression);
    if (!ts.isBinaryExpression(t) || t.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken || accessPath(t.left) !== 'type') return [];
    const kind = stringValueOf(t.right);
    const then = s.thenStatement;
    const ret = ts.isReturnStatement(then) ? then : ts.isBlock(then) && then.statements.length === 1 && ts.isReturnStatement(then.statements[0]!) ? then.statements[0] as ts.ReturnStatement : undefined;
    return kind !== undefined && ret?.expression && stringValueOf(ret.expression) === kind ? [kind] : [];
  });
}

/** How `handleSceneChanged`'s `if (invalidateCachedAsset)` branch reaches `fireDirtyListeners()`: `top` for a
 *  statement of the branch itself, `nested` for one inside a further branch, loop or closure — and how many
 *  `return`/`throw`s (outside nested functions) sit in the branch's statements BEFORE the first top-level wake,
 *  or in all of them when there is none. A conditional `if (x) { …; return; }` above the wake counts: on that
 *  path the render is never woken (#1195 close-out review). */
function dirtyWake(sf: ts.SourceFile): { reached: string[]; exitsBefore: number } {
  const fn = oneFunction(sf, 'handleSceneChanged');
  const ifs = findNodes(fn.body, ts.isIfStatement).filter((s) => accessPath(s.expression) === 'invalidateCachedAsset');
  if (ifs.length !== 1) throw new Error(`expected one "if (invalidateCachedAsset)" in handleSceneChanged, found ${ifs.length}`);
  const then = ifs[0]!.thenStatement;
  const top = ts.isBlock(then) ? [...then.statements] : [then];
  const isWake = (st: ts.Statement) => ts.isExpressionStatement(st) && ts.isCallExpression(unwrapValue(st.expression))
    && calleeName(unwrapValue(st.expression) as ts.CallExpression) === 'fireDirtyListeners';
  const wakeAt = top.findIndex(isWake);
  const exits = (n: ts.Node): number => (ts.isFunctionLike(n) ? 0
    : (ts.isReturnStatement(n) || ts.isThrowStatement(n) ? 1 : 0) + n.getChildren().reduce((sum, c) => sum + exits(c), 0));
  return {
    reached: callsTo(then, 'fireDirtyListeners').map((c) => (top.some((st) => isWake(st) && unwrapValue((st as ts.ExpressionStatement).expression) === c) ? 'top' : 'nested')),
    exitsBefore: top.slice(0, wakeAt === -1 ? top.length : wakeAt).reduce((sum, st) => sum + exits(st), 0),
  };
}

/** The keys of `const ASSET_CACHE_INVALIDATORS = { … }`. */
function invalidatorTableKeys(sf: ts.SourceFile): string[] {
  const decls = variablesNamed(sf, 'ASSET_CACHE_INVALIDATORS');
  if (decls.length !== 1 || !decls[0]!.initializer) throw new Error('could not find one "const ASSET_CACHE_INVALIDATORS = …" — did it move or get renamed?');
  const keys = objectLiteralKeys(unwrapValue(decls[0]!.initializer));
  if (!keys) throw new Error('ASSET_CACHE_INVALIDATORS is no longer a plain object literal — read its new shape');
  return keys;
}

const PRODUCER = unionMembers(producerSf, 'LiveReloadKind');
const CONSUMER = unionMembers(consumerSf, 'SceneChangedKind');

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
    const inClassify = classifyReturns(producerSf);
    expect(inClassify.length, 'classifySceneChange should return several kinds').toBeGreaterThan(2);
    expect(inClassify.filter((kind) => !PRODUCER.includes(kind))).toEqual([]);
  });

  it('every kind in the union has an explicit branch in classifySceneChange', () => {
    // Every current member (scene, prefab, animation, timeline, particle, spriteanim, rig2d) is
    // returned from its own `type === '<kind>'` comparison — none of them reach `classifySceneChange`
    // by falling through a default/else. ⚠️ The `NO_DIRECT_COMPARISON` exception list that sat here
    // was EMPTY and is deleted (#1140): a kind that genuinely reaches classifySceneChange another way
    // is a counted `assertExemptionLedger` row, not a name list with no staleness check.
    const branches = classifyBranches(producerSf);
    const missing = PRODUCER.filter((k) => !branches.includes(k));
    expect(
      missing,
      'These LiveReloadKind members have no `type === \'<kind>\'` branch in classifySceneChange, so ' +
        'a file of that kind falls through to `return null` — no broadcast ever fires, and the asset ' +
        'silently keeps its pre-edit contents forever. Add an explicit branch.',
    ).toEqual([]);
  });

  // ⚠️ A SCAN, and the weakest kind — but it is the only thing that can see this. `handleSceneChanged`
  // is reachable only through the Vite-HMR and Electron-IPC handlers, never through a registry or an
  // agent op, so nothing in the test suite can drive it: removing the `fireDirtyListeners()` call
  // below left all 6664 tests in the scoped suites GREEN (measured, close-out of #842). That is
  // exactly the "unreachable mechanism" this file exists for, one level up.
  it('the invalidator branch WAKES a render, not just the cache (#842 close-out)', () => {
    expect(
      dirtyWake(consumerSf),
      'The invalidator branch of handleSceneChanged invalidates a cache and returns without waking a '
        + 'render gate. While the sim is STOPPED, Scene2D\'s idle gate (Scene2D.tsx, the '
        + '`!isSimRunning() && !this._externalDirty` early return) skips the entire frame, so the '
        + 'viewport keeps showing PRE-EDIT pixels indefinitely — which is verbatim the symptom the '
        + 'ASSET_CACHE_INVALIDATORS table exists to prevent. Invalidating a cache nothing redraws is '
        + 'not an invalidation. Call fireDirtyListeners() (runtime/core/renderDirty) after the '
        + 'invalidation, as a statement of the branch itself with no return or throw above it; it wakes every '
        + 'subscribed surface, for all kinds in the table.',
    ).toEqual({ reached: ['top'], exitsBefore: 0 });
  });

  it('every kind is HANDLED — a cache invalidator, or an explicit scene-reload kind', () => {
    // `scene` and `prefab` fall through to the scene-reload path on purpose; everything else must
    // have an entry in the invalidator table, or it reaches the renderer and does nothing.
    //
    // On the shared ledger since #1140: the two kinds are `sanctioned` names, so one that GAINS an
    // invalidator entry (or leaves the union) reddens instead of keeping a pardon nobody needs.
    const SCENE_RELOAD_KINDS: readonly string[] = ['scene', 'prefab'];
    const tableKeys = invalidatorTableKeys(consumerSf);
    assertExemptionLedger({
      label: 'SCENE_RELOAD_KINDS in liveReloadKinds',
      population: PRODUCER.filter((k) => !tableKeys.includes(k)).map((k) => ({ item: k, site: k })),
      sanctioned: SCENE_RELOAD_KINDS,
      floor: 1,
      fix: 'These kinds are broadcast but have no invalidator entry, so the renderer receives them and '
        + 'does nothing — the asset keeps its pre-edit contents and a read-modify-write reverts the '
        + 'file. Add them to ASSET_CACHE_INVALIDATORS (or to SCENE_RELOAD_KINDS here if a full '
        + 'scene reload really is intended).',
    });
  });

  /** Asset types this test deliberately does NOT require in `LiveReloadKind`, each with the
   *  reason a broadcast genuinely isn't needed. Add a name here only with a verified reason, never
   *  to silence a failure. Spent through the shared ledger since #1140 — it had no staleness check,
   *  so a type that JOINED LiveReloadKind kept its "not needed" reason. */
  const NOT_LIVE_RELOADABLE: ReadonlyArray<{ item: string; reason: string }> = [
    { item: 'atlas', reason: 'protected by an ifMatch compare-and-swap checked server-side at write time (#831), ' +
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
      + 'the lever that would make adding this kind safe.' },
  ];

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
    assertExemptionLedger({
      label: 'NOT_LIVE_RELOADABLE in liveReloadKinds',
      population: ASSET_SCHEMA_TYPES.filter((t) => !PRODUCER.includes(t)).map((t) => ({ item: t, site: t })),
      exempt: NOT_LIVE_RELOADABLE,
      floor: 1,
      fix: 'These ASSET_SCHEMA_TYPES are agent-writable/parkable but missing from LiveReloadKind in '
        + 'engine/plugins/vite-asset-scanner.ts, so classifySceneChange can never return them, no '
        + 'modoki:scene-changed broadcast ever fires for them, dropParkedWriteFor never runs, and no '
        + 'cache is ever invalidated for an external write. Add each one to LiveReloadKind + a '
        + '`type === \'<kind>\'` branch in classifySceneChange + SceneChangedKind + '
        + 'ASSET_CACHE_INVALIDATORS in agentBridge.ts — or, if a broadcast is genuinely not needed, '
        + 'add it to NOT_LIVE_RELOADABLE above with a verified reason.',
    });
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
  /** A file that registers a watcher — `chokidar.watch(…)` (the Electron backend) or the Vite dev server's
   *  `….watcher.on(…)` — AND classifies via `classifySceneChange`: a call to it, or any read of a binding
   *  imported AS it (an alias, or handed on by reference). From the parser, so a file (like this one) that only
   *  discusses either in prose or a string cannot satisfy it. */
  function isWatcherClassifier(sf: ts.SourceFile): boolean {
    const aliases = findNodes(sf, ts.isImportSpecifier)
      .filter((sp) => (sp.propertyName ?? sp.name).text === 'classifySceneChange').map((sp) => sp.name);
    const classifies = callsTo(sf, 'classifySceneChange').length > 0 || aliases.some((id) => readsOf(id).length > 0);
    return (callsToPath(sf, 'chokidar.watch').length > 0 || callsToPath(sf, 'watcher.on').length > 0) && classifies;
  }

  function findWatcherClassifierFiles(): string[] {
    // `.ts`/`.tsx` repo-wide — floored far under even the smallest real corpus (the public OSS
    // snapshot alone ships thousands under `engine/`), so a collapsed enumeration trips this
    // before it ever reaches the file-content check.
    const candidates = repoFiles({ match: (rel: string) => /\.tsx?$/.test(rel), floor: 500 });
    const out: string[] = [];
    for (const { abs, rel } of candidates) {
      let raw: string;
      try { raw = fs.readFileSync(abs, 'utf8'); } catch { continue; } // tracked but absent locally
      // Cheap RAW pre-filter first — narrows the whole repo down to a handful of candidates before
      // paying for a parse of each. It only ever ADDS candidates relative to the authoritative check
      // next: every call the parser can find spells both names somewhere in the raw text.
      if (!raw.includes('classifySceneChange') || !/\bwatch\b|\bwatcher\b/.test(raw)) continue;
      if (isWatcherClassifier(parseSource(readScannedSource(abs).code, rel))) out.push(abs);
    }
    return out;
  }

  /** The extension gate #857 found duplicated, as a node: `extname(…)` — optionally `.toLowerCase()`d —
   *  compared (`===`, `!==`, `==`, `!=`, either way round) with the string `.json`. */
  function isExtensionGate(n: ts.Node): n is ts.BinaryExpression {
    if (!ts.isBinaryExpression(n)) return false;
    const op = n.operatorToken.kind;
    if (![ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsToken].includes(op)) return false;
    const isExtname = (e: ts.Expression): boolean => {
      let u = unwrapValue(e);
      if (ts.isCallExpression(u) && calleeName(u) === 'toLowerCase' && ts.isPropertyAccessExpression(u.expression)) u = unwrapValue(u.expression.expression);
      return ts.isCallExpression(u) && calleeName(u) === 'extname';
    };
    return (stringValueOf(n.right) === '.json' && isExtname(n.left)) || (stringValueOf(n.left) === '.json' && isExtname(n.right));
  }

  /** The one `onChange` handler in `sf`: its extension gates (as flat text), and how many times it calls the
   *  shared `pathToClassifyForChange`. */
  function onChangeGate(sf: ts.SourceFile): { gates: string[]; callsShared: number } {
    const fn = oneFunction(sf, 'onChange');
    return { gates: findNodes(fn.body, isExtensionGate).map(flatText), callsShared: callsTo(fn.body, 'pathToClassifyForChange').length };
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
      const { gates, callsShared } = onChangeGate(parseSource(readScannedSource(abs).code, rel));
      if (gates.length > 0) {
        violators.push(
          `${rel}: onChange still tests extname(...) === '.json' directly instead of going through ` +
          'pathToClassifyForChange — this is the exact duplicated line #857 exposed: a shader BODY ' +
          '(.glsl/.wgsl) never satisfies a raw .json test, so this watcher can never broadcast a ' +
          'shader-body edit no matter what pathToClassifyForChange itself does.',
        );
      }
      if (callsShared === 0) {
        violators.push(
          `${rel}: onChange does not call pathToClassifyForChange — every watcher must resolve the ` +
          'path to classify through the one shared helper, not its own logic, so the two watchers ' +
          'cannot drift apart the way they did in #857.',
        );
      }
    }
    expect(violators, violators.join('\n')).toEqual([]);
  });

  it('isExtensionGate flags both historical spellings of the duplicated gate, and not the shared helper', () => {
    // Its half of the check above greens on zero matches, and a clean corpus has none (#1105).
    const gates = (src: string) => onChangeGate(parseSource(`const onChange = (file: string) => {\n${src}\n};`, 'probe.ts')).gates;
    expect(gates("if (path.extname(file) === '.json') {}")).toEqual(["path.extname(file) === '.json'"]);
    expect(gates('if (extname(file).toLowerCase() === ".json") {}')).toEqual(['extname(file).toLowerCase() === ".json"']);
    expect(gates("if ('.json' !== extname(\n  file,\n)) return;")).toEqual(["'.json' !== extname( file, )"]);
    expect(gates('const target = pathToClassifyForChange(file);')).toEqual([]);
    expect(gates("if (path.extname(file) === '.glsl') {}")).toEqual([]);
    expect(gates("log(\"extname(file) === '.json'\");")).toEqual([]);
  });

  it('reads the unions, classifySceneChange, the wake branch and the table as units (#1195)', () => {
    const sf = parseSource([
      "export type K = ('scene' | 'prefab' | Other);",
      'export function classifySceneChange(rel: string): K | null {',
      "  const type = detectType(rel, '.json'); const t = `\n}`;",
      "  if (type === 'prefab') return 'prefab';",
      "  if (type === 'material') return 'shader';",
      "  if (type === 'timeline') { return 'timeline'; }",
      "  const nested = () => { if (type === 'rig2d') return 'rig2d'; };",
      "  return rel.endsWith('x') ? 'scene' : kindOf(rel);",
      '}',
      'async function handleSceneChanged(msg) {',
      '  const invalidateCachedAsset = pick(msg);',
      '  if (invalidateCachedAsset) {\n  invalidateCachedAsset(msg.urlPath);\n  if (msg.x) { fireDirtyListeners(); }\n  return;\n  fireDirtyListeners();\n  }',
      '}',
      'const ASSET_CACHE_INVALIDATORS: Record<string, Fn> = { animation: invalidateAnimationClip, "timeline": invalidateTimeline };',
    ].join('\n'), 'probe.ts');
    expect(unionMembers(sf, 'K')).toEqual(['<Other>', 'prefab', 'scene']);
    expect(classifyReturns(sf)).toEqual(['prefab', 'shader', 'timeline', 'scene', '<kindOf(rel)>']);
    expect(classifyBranches(sf)).toEqual(['prefab', 'timeline']);
    expect(dirtyWake(sf)).toEqual({ reached: ['nested', 'top'], exitsBefore: 1 });
    const early = parseSource("async function handleSceneChanged(msg) { const invalidateCachedAsset = f;\n  if (invalidateCachedAsset) {\n    if (!msg.viaSibling) { await drop(msg); return; }\n    const g = () => { return 1; };\n    fireDirtyListeners();\n    return;\n  }\n}", 'early.ts');
    expect(dirtyWake(early)).toEqual({ reached: ['top'], exitsBefore: 1 });
    expect(invalidatorTableKeys(sf)).toEqual(['animation', 'timeline']);
    // A watcher file is one that CALLS both — not one that names them.
    expect(isWatcherClassifier(parseSource("server.watcher.on('change', (f) => classifySceneChange(f));", 'a.ts'))).toBe(true);
    expect(isWatcherClassifier(parseSource("const w = chokidar.watch(dir); w.on('all', onChange);\nclassifySceneChange(x);", 'b.ts'))).toBe(true);
    expect(isWatcherClassifier(parseSource("const doc = 'chokidar.watch( and classifySceneChange('; watcher.off(x);", 'c.ts'))).toBe(false);
    expect(isWatcherClassifier(parseSource("server.watcher.on('change', reload); // classifySceneChange", 'd.ts'))).toBe(false);
    // Imported under another name, called or handed on — still a classifying watcher; imported and unused is not.
    expect(isWatcherClassifier(parseSource("import { classifySceneChange as classify } from './s';\nchokidar.watch(d).on('all', (f) => classify(f));", 'e.ts'))).toBe(true);
    expect(isWatcherClassifier(parseSource("import { classifySceneChange as classify } from './s';\nchokidar.watch(d).on('all', (f) => route(f, classify));", 'f.ts'))).toBe(true);
    expect(isWatcherClassifier(parseSource("import { classifySceneChange as classify } from './s';\nchokidar.watch(d);", 'g.ts'))).toBe(false);
  });
});
