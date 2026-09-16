/** Source-level guard on the #1284 fix: every place that serializes a prefab from a LIVE
 *  tree must warm the editor prefab cache from that same tree first.
 *
 *  The behaviour is covered in coldPrefabCacheWarming.test.ts. What that cannot cover is
 *  the thing that actually went wrong: `serializePrefab` reads the cache synchronously, so
 *  whether a given CALL is safe depends on what its caller awaited beforehand — and the
 *  prefab-edit save had this right for months while the two Create Prefab paths did not.
 *  A seventh call site is a one-line addition that no runtime test would notice.
 *
 *  Same shape as the `warnInertPrefabSizes` census beside it, and deliberately so: the two
 *  ask different questions of the same population, and neither can answer the other's. */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { readScannedSource } from '../helpers/sourceScanner';
import { calledNames, callsTo, enclosingNamedFunction, functionBodyOf, functionsNamed, parseSource, precedingStatements, printedText, ts, unwrapValue } from '../helpers/sourceAst';
import { assertExemptionLedger } from '../helpers/exemptionLedger';

const SRC = path.resolve(__dirname, '../../src');
const ENGINE = path.resolve(SRC, '../../..');
const WARM = 'preloadNestedPrefabsForSubtree';

/** Is this `serializePrefab(<entity>, …)` call preceded, in its own function and
 *  unconditionally, by `await preloadNestedPrefabsForSubtree(<the same entity>)`?
 *
 *  Matched on the printed argument text rather than by symbol — the arguments here are
 *  always a plain local (`entityId`, `rootId`), and requiring the SAME one is what stops a
 *  warm of some other tree from vouching for this call. A preload inside an `if` or a
 *  callback is not a preceding ExpressionStatement, so it does not count: conditional
 *  warming is exactly the bug. */
function serializedTreeIsWarmed(call: ts.CallExpression): boolean {
  const target = call.arguments[0] ? printedText(call.arguments[0]) : undefined;
  if (!target) return false;
  return precedingStatements(call).some((s) => {
    if (!ts.isExpressionStatement(s)) return false;
    const e = unwrapValue(s.expression);
    if (!ts.isCallExpression(e) || !ts.isIdentifier(e.expression) || e.expression.text !== WARM) return false;
    return !!e.arguments[0] && printedText(e.arguments[0]) === target;
  });
}

/** Every `serializePrefab(` call under the package's `src/editor` and the app shell's
 *  `app/editor`, enumerated from the FILES rather than from a list, with whether that call
 *  warms the tree it is about to serialize. */
function warmCensus(): Array<{ file: string; in: string | undefined; warms: boolean }> {
  const roots = [path.join(SRC, 'editor'), path.join(ENGINE, 'app/editor')];
  const files = roots.flatMap((root) => (fs.readdirSync(root, { recursive: true }) as string[])
    .filter((f) => /\.tsx?$/.test(f)).map((f) => path.join(root, f)));
  return files.sort().flatMap((abs) => {
    const code = readScannedSource(abs).code;
    if (!code.includes('serializePrefab(')) return [];
    return callsTo(parseSource(code, path.basename(abs)), 'serializePrefab').map((call) => ({
      file: path.relative(ENGINE, abs).split(path.sep).join('/'),
      in: enclosingNamedFunction(call)?.name,
      warms: serializedTreeIsWarmed(call),
    }));
  });
}

/** Serializers whose tree CANNOT hold a `PrefabInstance`, so there is nothing to warm, plus
 *  the one that warms in a different function. Each states the reason, because "it does not
 *  warm" is not by itself a defence — the two Create Prefab paths did not warm either. */
const NOT_WARMED_BY_DESIGN = [
  {
    item: 'packages/modoki/src/editor/panels/Assets.tsx::importModelWithMeta',
    reason: 'model import: the tree is the GLB it just spawned — modelImport.ts never writes PrefabInstance, so no nested instance can be held',
  },
  {
    item: 'packages/modoki/src/editor/panels/assetViews/ModelAssetView.tsx::ModelAssetView',
    reason: 'model re-import regenerates the prefab from the same GLB tree — no PrefabInstance either',
  },
  {
    item: 'packages/modoki/src/editor/scene/skinPrefab.ts::makeRigPrefabAsset',
    reason: 'a 2D rig prefab built by spawnEntitySubtree(buildRigSubtree(...)) — synthetic bone nodes, no PrefabInstance',
  },
  {
    item: 'packages/modoki/src/editor/scene/prefabEdit.ts::savePrefabEditReport',
    reason: 'the prefab-edit world is warmed when it is OPENED (openPrefabForEditing awaits preloadNestedPrefabs before scaffolding), so the save re-reads a cache filled for this exact purpose. ⚠️ That covers the prefabs the FILE referenced at open; an instance the author drops in DURING the edit is covered instead by the drop going through instantiatePrefabAsync, which fetches it — not by the open-time preload',
  },
];

describe('#1284 — every live-tree serializer warms the prefab cache first', () => {
  it('reads a preceding same-argument warm, and nothing weaker', () => {
    const probe = (body: string) => {
      const sf = parseSource(`async function ops(entityId, other) {\n${body}\n}`, 'probe.ts');
      return callsTo(sf, 'serializePrefab').map((c) => serializedTreeIsWarmed(c));
    };
    // The shape the fix actually ships.
    expect(probe(`await ${WARM}(entityId);\n  const p = serializePrefab(entityId);`)).toEqual([true]);
    expect(probe(`await ${WARM}(entityId);\n  const p = serializePrefab(entityId, existingId);`)).toEqual([true]);
    // A warm of a DIFFERENT tree must not vouch for this one.
    expect(probe(`await ${WARM}(other);\n  const p = serializePrefab(entityId);`)).toEqual([false]);
    // Order matters, and so does actually calling it.
    expect(probe(`const p = serializePrefab(entityId);\n  await ${WARM}(entityId);`)).toEqual([false]);
    expect(probe('const p = serializePrefab(entityId);')).toEqual([false]);
    // Conditional or deferred warming is the bug, not a pass.
    expect(probe(`if (maybe) await ${WARM}(entityId);\n  const p = serializePrefab(entityId);`)).toEqual([false]);
    expect(probe(`const later = () => ${WARM}(entityId);\n  const p = serializePrefab(entityId);`)).toEqual([false]);
    // Per CALL, not per function — a second serializer beside a warmed one is unwarmed.
    expect(probe(`await ${WARM}(entityId);\n  const p = serializePrefab(entityId);\n  const q = serializePrefab(other);`)).toEqual([true, false]);
  });

  it('every serializer either warms its tree or is on the ledger with a reason', () => {
    const census = warmCensus();
    // Both Create Prefab entry points — the two #1284 observed on — must be warmed.
    expect(census.filter((c) => c.warms).map((c) => `${c.file}::${c.in}`).sort()).toEqual([
      'app/editor/agentEditorOps.ts::registerEditorAgentOps',
      'packages/modoki/src/editor/panels/assetOps.ts::createPrefabFromEntity',
    ]);
    assertExemptionLedger({
      label: 'serializePrefab calls that do not warm the live tree first (#1284)',
      population: census.filter((c) => !c.warms).map((c) => ({ item: `${c.file}::${c.in}`, site: c.file })),
      exempt: NOT_WARMED_BY_DESIGN,
      scanned: census.length,
      floor: 6,
      fix: `await ${WARM}(<the entity being serialized>) before the call — serializePrefab reads nested children from the editor cache SYNCHRONOUSLY and flattens what it cannot find (#1284)`,
    });
  });
});

/** The OTHER half of the family, and the reason it is guarded by NAME rather than by the
 *  argument-matching reader above.
 *
 *  `applyToPrefabSelective` and `revertOverridesSelective` are the two async entry points into
 *  `rebuildInstance`, which calls `captureNestedInstanceOverrides` — a sync cache read over the
 *  live tree with NO warning at all on a miss (a nested instance's per-copy overrides simply
 *  vanish across the rebuild). Their warms cannot be seen by `serializedTreeIsWarmed`: one sits
 *  inside a `for...of` over the instance roots, and the read itself happens two calls deeper, in
 *  a different function.
 *
 *  So this asserts only that each entry point still warms at all. That is weaker than the census
 *  above and deliberately so — it exists because close-out review found BOTH lines could be
 *  deleted with all 12,187 package tests still green. A behaviour test for the override loss
 *  belongs with the world-level warming seam in #1295, which restructures these paths anyway.
 *
 *  ⚠️ #1295 is the rest of this population: ~15 sync readers over the live tree, four of them in
 *  synchronous undo closures that can never await, so the caller-side warm cannot finish the job. */
describe('#1284 — the two rebuild entry points warm the live tree (#1295 carries the rest)', () => {
  it.each(['applyToPrefabSelective', 'revertOverridesSelective'])('%s calls the subtree warm', (fnName) => {
    const sf = parseSource(readScannedSource(path.join(SRC, 'editor/scene/prefab.ts')).code, 'prefab.ts');
    const fns = functionsNamed(sf, fnName);
    expect(fns.length, `${fnName} not found — did it move or get renamed?`).toBe(1);
    const body = functionBodyOf(fns[0]);
    expect(body, `${fnName} has no body`).toBeTruthy();
    expect(calledNames(body!), `${fnName} feeds rebuildInstance -> captureNestedInstanceOverrides, a SILENT sync cache read`).toContain(WARM);
  });
});

/** Is `node` preceded, on its own path and UNCONDITIONALLY, by `await preloadNestedPrefabsForSubtree(...)`?
 *
 *  ⚠️ The statement must BE the warm, not merely contain one. `precedingStatements` yields the
 *  enclosing blocks' earlier statements, and a preceding `if (which === 'overrides') { … }` is one
 *  of those — so a subtree search (`callsTo(st, WARM).length > 0`) lets a sibling branch's warm
 *  vouch for this read, which is the regression this guard has now been through twice. A warm
 *  nested inside a preceding conditional may never have run. */
function warmedByPrecedingStatement(node: ts.Node): boolean {
  return precedingStatements(node).some((st) => {
    if (!ts.isExpressionStatement(st)) return false;
    const e = unwrapValue(st.expression);
    return ts.isCallExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === WARM;
  });
}

/** The rest of the family. The AST reader at the top of this file matches a warm in the SAME
 *  function immediately before the call; these sites do not have that shape (the dialog warms in
 *  a `useEffect` closure while the read happens inside the pure helper `buildStructural`, and the
 *  agent ops warm inside anonymous `if (which === ...)` branches).
 *
 *  ⚠️ **Two earlier shapes of this guard were both too weak, and the second was a REGRESSION.**
 *  A per-file COUNT is blind to ORDER, so moving a warm after the reads it covers stayed green —
 *  the exact defect ("the warm existed 111 lines later, too late") it was written for. Replacing it
 *  with `enclosingFunction(w) === enclosingFunction(r) && w.getStart() < r.getStart()` was WORSE in
 *  one place: every prefab sub-action lives inside ONE `registerAgentOp('prefab', async (params) =>
 *  …)` arrow, so the `which === 'overrides'` branch's warm compared equal to the
 *  `which === 'apply'` branch's read and vouched for it — deleting the apply warm stayed green,
 *  while the count guard it replaced had caught exactly that.
 *
 *  So it checks DOMINANCE, not position: the warm must be in a statement that PRECEDES the read on
 *  the read's own path (`precedingStatements` walks the enclosing blocks), which a sibling `if`
 *  branch never is.
 *
 *  ⚠️ Argument identity is deliberately NOT checked here, unlike `serializedTreeIsWarmed` above.
 *  `assetOps`' redo warms `id` and then re-resolves into `tagId` before tagging — correct, because
 *  the await is a window in which a world rebuild can stale the id — and a naive arg match would
 *  call that correction a defect. */
const ORDERED_WARMS: Array<{ file: string; reader: string; why: string }> = [
  {
    file: 'packages/modoki/src/editor/panels/ApplyPrefabDialog.tsx', reader: 'buildStructural',
    why: 'without it a hand-added nested instance is missing from the dialog and unpromotable',
  },
  {
    file: 'app/editor/agentEditorOps.ts', reader: 'collectInstanceOverrideKeys',
    why: 'on apply/revert this capture is what an explicit `keys` list is validated against, so a cold miss turns a legitimate key into a refusal',
  },
  {
    file: 'packages/modoki/src/editor/panels/assetOps.ts', reader: 'tagEntityTreeAsInstance',
    why: 'the async redo re-runs planPrefabRows; cold, planMatchesFile disagrees with the file written warm and the redo tags NOTHING',
  },
  {
    file: 'packages/modoki/src/editor/scene/prefab.ts', reader: 'captureInstanceStructure',
    why: 'applyToPrefab and applyToPrefabSelective both build key sets from it; cold, a hand-added subtree is dropped from an apply-EVERYTHING action',
  },
];

/** Enclosing functions where the reader runs WITHOUT a warm of its own, each with why that is
 *  correct. Not a place to park an unwarmed site — every row says what warms it instead. */
const READS_WARMED_ELSEWHERE = [
  { item: 'packages/modoki/src/editor/scene/prefab.ts::refreshInstances', reason: 'called only from applyToPrefabSelective, which warms every root in rootsToRefresh before calling it' },
  { item: 'packages/modoki/src/editor/scene/prefab.ts::captureNestedInstanceOverrides', reason: 'runs inside the sync rebuildInstance; its two async callers warm first. The four SYNC undo closures that also reach rebuildInstance are #1295 — they can never await one' },
  { item: 'packages/modoki/src/editor/scene/prefab.ts::captureInstanceReference', reason: 'internal recursion, reached only from planPrefabRows/captureNestedRef, both behind a warmed caller' },
  { item: 'packages/modoki/src/editor/scene/prefabOverrideKeys.ts::collectInstanceOverrideKeys', reason: 'a pure helper; both in-repo callers (the two agent ops) warm before calling it. It IS re-exported from editor/index.ts, so an out-of-repo caller is not checkable here' },
  { item: 'packages/modoki/src/editor/scene/serialize.ts::serializeScene', reason: 'the scene save warms by its own mechanism — await Promise.all over every live instance source before the capture loop' },
];

describe('#1284 — warms outside the serialize census (#1295 carries the sync undo closures)', () => {
  it.each(ORDERED_WARMS)('$file warms BEFORE $reader, not merely somewhere in the file', ({ file, reader }) => {
    const abs = path.join(ENGINE, file);
    const sf = parseSource(readScannedSource(abs).code, path.basename(abs));
    const reads = callsTo(sf, reader);
    expect(reads.length, `${reader} not found in ${file} — did it move or get renamed?`).toBeGreaterThan(0);
    // A read inside a function on the ledger is warmed by its CALLER, so it has no warm of its
    // own by design; the ledger row is what vouches for it. Everything else must be DOMINATED.
    const ledgered = (r: ts.CallExpression) =>
      READS_WARMED_ELSEWHERE.some((k) => k.item === `${file}::${enclosingNamedFunction(r)?.name}`);
    const unordered = reads.filter((r) => !ledgered(r) && !warmedByPrecedingStatement(r));
    expect(unordered.map((r) => `${reader} at line ${sf.getLineAndCharacterOfPosition(r.getStart()).line + 1}`),
      `every ${reader} call must be preceded by ${WARM} in its own function`).toEqual([]);
  });

  /** `planPrefabRows` — the reader whose cold miss FLATTENS — is reached through
   *  `tagEntityTreeAsInstance`, and nothing enumerated those call sites. That is exactly how the
   *  async redo in `assetOps.ts` survived a manual sweep AND an adversarial review: every census
   *  anchored on `captureInstanceStructure`, which that path never calls. Pinned here by warmed /
   *  unwarmed split rather than by name, so both a lost warm and a new cold site are red.
   *
   *  ⚠️ Enumerated from the FILES. It hardcoded two paths at first, which repeated at the file level
   *  the mistake it exists to fix — a probe file carrying a bare unwarmed call sat green, because
   *  the guard never looked at it. `tagEntityTreeAsInstance` is re-exported from editor/index.ts,
   *  so a new panel reaches it. */
  it('every tagEntityTreeAsInstance call is warmed, except the one sync closure #1295 owns', () => {
    const roots = [path.join(SRC, 'editor'), path.join(ENGINE, 'app/editor')];
    const sites = roots
      .flatMap((root) => (fs.readdirSync(root, { recursive: true }) as string[])
        .filter((f) => /\.tsx?$/.test(f)).map((f) => path.relative(ENGINE, path.join(root, f)).split(path.sep).join('/')))
      .sort()
      .flatMap((rel) => {
        const abs = path.join(ENGINE, rel);
        if (!readScannedSource(abs).code.includes('tagEntityTreeAsInstance(')) return [];
        const sf = parseSource(readScannedSource(abs).code, path.basename(abs));
        return callsTo(sf, 'tagEntityTreeAsInstance').map((c) => ({
          at: `${rel}:${sf.getLineAndCharacterOfPosition(c.getStart()).line + 1}`,
          warmed: warmedByPrecedingStatement(c),
        }));
      });
    expect(sites.length, 'a new tagEntityTreeAsInstance call site must be classified').toBe(4);
    expect(sites.filter((x) => !x.warmed).map((x) => x.at),
      'EVERY site warms now — the last holdout was the agent create redo, which turned out to be able to await after all')
      .toEqual([]);
  });

  /** ⚠️ Counted PER OCCURRENCE, not deduped. A `new Set` here hid a second unwarmed call added
   *  inside an already-listed function — proven by mutation during close-out review. */
  it('no NEW sync structure reader has landed unclassified', () => {
    const roots = [path.join(SRC, 'editor'), path.join(ENGINE, 'app/editor')];
    const files = roots.flatMap((root) => (fs.readdirSync(root, { recursive: true }) as string[])
      .filter((f) => /\.tsx?$/.test(f)).map((f) => path.join(root, f)));
    const found = files.sort().flatMap((abs) => {
      const code = readScannedSource(abs).code;
      if (!code.includes('captureInstanceStructure(')) return [];
      const rel = path.relative(ENGINE, abs).split(path.sep).join('/');
      return callsTo(parseSource(code, path.basename(abs)), 'captureInstanceStructure')
        .map((c) => `${rel}::${enclosingNamedFunction(c)?.name}`);
    });
    const warmedHere = ORDERED_WARMS.map((w) => w.file);
    const classified = found.filter((f) => READS_WARMED_ELSEWHERE.some((k) => k.item === f)
      || warmedHere.some((wf) => f.startsWith(`${wf}::`)));
    expect(found.filter((f) => !classified.includes(f)),
      'a new captureInstanceStructure call site must be classified: warmed in its own function, or a row in READS_WARMED_ELSEWHERE')
      .toEqual([]);
    expect(found.length, 'occurrence count is pinned so a SECOND call inside a known function cannot hide behind dedupe').toBe(9);
  });
});
