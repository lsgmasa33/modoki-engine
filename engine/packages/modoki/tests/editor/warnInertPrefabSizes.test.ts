/**
 * The prefab WRITE-time half of #42: `warnInertPrefabSizes` and, just as importantly, WHICH writes
 * call it.
 *
 * `validatePrefabData` is already unit-tested (tests/runtime/validatePrefabData.test.ts). What was
 * uncovered is the seam production actually goes through — nobody reaches the validator directly;
 * they reach it by saving a prefab. This file covers the reporting behaviour, plus a source-level
 * guard on the placement decision, because that decision is invisible in the code and easy to
 * "simplify" away.
 */

import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { readScannedSource } from '../helpers/sourceScanner';
import { calledNames, calleeName, callsTo, declarationOf, enclosingNamedFunction, findNodes, flatText, functionsNamed, parseSource, precedingStatements, printedText, referencesToPath, statementOf, ts, unwrapValue } from '../helpers/sourceAst';
import { warnInertPrefabSizes } from '../../src/editor/scene/prefab';
import { assertExemptionLedger } from '../helpers/exemptionLedger';
import { registerAsset, unregisterAsset } from '../../src/runtime/loaders/assetManifest';

const SRC = path.resolve(__dirname, '../../src');
const read = (rel: string) => readScannedSource(path.join(SRC, rel)).code;

const trap = (localId = 3) => ({
  entities: [{ localId, name: 'Band', traits: { UIAnchor: { anchor: 'stretch' }, UIElement: { width: 90, widthUnit: '%' } } }],
});

describe('warnInertPrefabSizes (prefab write-time reporting)', () => {
  it('warns once per finding, naming the prefab FILE', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    warnInertPrefabSizes(trap(), '/assets/prefabs/thing.prefab.json');
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0][0]);
    // The FILE is the whole point of reporting here rather than from the scene side — without it
    // the reader is told a value is dead but not which of 89 prefabs holds it.
    expect(msg).toContain('/assets/prefabs/thing.prefab.json');
    expect(msg).toContain('localId=3');
    // `[Editor]` is the prefix the editor Console panel surfaces; a bare warn is invisible there.
    expect(msg).toContain('[Editor]');
    warn.mockRestore();
  });

  it('names the FILE when the caller holds the prefab GUID (#1251)', () => {
    // Apply-to-Prefab passes PrefabInstance.source and prefab edit mode passes the edited prefab's guid —
    // both GUIDs, which tell the reader nothing about which of the project's prefabs holds the dead size.
    const guid = '8b0f2a4e-5c1d-4e7a-9f3b-2d6c8a1e4f70';
    registerAsset(guid, '/assets/prefabs/band.prefab.json', 'prefab');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      warnInertPrefabSizes(trap(), guid);
      expect(String(warn.mock.calls[0]?.[0])).toContain('/assets/prefabs/band.prefab.json');
    } finally {
      warn.mockRestore();
      unregisterAsset(guid);
    }
  });

  it('is silent for a clean prefab — it must not chatter on every save', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    warnInertPrefabSizes({ entities: [{ localId: 1, traits: { UIAnchor: { anchor: 'stretch' }, UIElement: { width: 100, widthUnit: '%' } } }] }, '/x.prefab.json');
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('never throws on a malformed prefab — a save must not fail because a WARNING path threw', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const bad of [null, undefined, 42, {}, { entities: 'no' }]) {
      expect(() => warnInertPrefabSizes(bad, '/x.prefab.json')).not.toThrow();
    }
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('the hook is on EVERY AUTHORING write, not on writePrefabFile (#42, #1251)', () => {
  // Source-level on purpose. This encodes a decision that is invisible in the code itself and
  // would look like an obvious cleanup to a later reader: `writePrefabFile` is the single choke
  // point for every prefab write, so hooking it is the tempting move — but it is ALSO the
  // undo/redo restore path (`installPrefabSnapshot`), so warning there fires while someone
  // REVERTS the value, blaming them for an edit they are undoing. Same idiom as this repo's other
  // architecture guards (reapScoping, determinismGuard, testTypecheckCoverage).
  //
  // ⚠️ **Read through the parser (#1195).** Each function body used to be cut from its `export async
  // function` line to the first `'\n}'`, and each write site matched by a regex over two adjacent lines:
  // a template literal holding a column-0 `}` ended the body early, a warning reached through a local
  // helper was invisible, and a blank line between the warning and the write turned a pass into a fail.
  const prefabSf = parseSource(read('editor/scene/prefab.ts'), 'prefab.ts');
  const assetOpsSf = parseSource(read('editor/panels/assetOps.ts'), 'assetOps.ts');

  it('every writePrefabFile call in the editor warns first, unless it is a restore (#1251)', () => {
    // A CENSUS, not a list of the writes somebody remembered: #42 named Apply-to-Prefab and Save-as-Prefab,
    // and prefab edit mode's save and the agent `create` op — both older than #42 or unlisted — went
    // unwarned. A writer added later now fails here by file and function instead of being skipped.
    const census = prefabWriteCensus();
    // The reader must SEE the authoring writes, or an empty census would pass everything below.
    expect(census).toEqual(expect.arrayContaining([
      { file: 'packages/modoki/src/editor/scene/prefab.ts', in: 'applyToPrefabSelective', warned: true },
      { file: 'packages/modoki/src/editor/scene/prefabEdit.ts', in: 'savePrefabEdit', warned: true },
      { file: 'app/editor/agentEditorOps.ts', in: 'registerEditorAgentOps', warned: true }, // prefabAction:'create'
    ]));
    // An unwarned write is an offender unless it is a restore. Keyed `file::function` and SPENT per call, so a second
    // unwarned write inside a pardoned function is an offender too, and a restore that starts warning (or goes away)
    // leaves its row over-blessed — stale — rather than silently excusing the next authoring write.
    assertExemptionLedger({
      label: 'unwarned writePrefabFile calls in warnInertPrefabSizes (#1251)',
      population: census.filter((w) => !w.warned).map((w) => ({ item: `${w.file}::${w.in}`, site: w.file })),
      exempt: [{
        item: 'packages/modoki/src/editor/scene/prefab.ts::installPrefabSnapshot',
        reason: 'the undo/redo restore: a warning there blames someone for the value they are reverting',
      }],
      scanned: census.length,
      floor: 4,
      fix: 'call warnInertPrefabSizes(<the prefab>, <the same source>) before the write — it is an authoring write',
    });
  });

  it('every function that serializes a prefab reports an inert size, unless it GENERATES the prefab (#1251 close-out)', () => {
    // The writePrefabFile census cannot see a writer that goes through writeAssetFile — Save-as-Prefab, the canonical
    // authoring write, is one. Anchoring on `serializePrefab(` reaches every writer shape, because a prefab file is only
    // ever produced from a serialized tree. (applyToPrefabSelective edits a cached template rather than serializing, and
    // stays covered by the census above.)
    // The reader decides per CALL: a second serializer in a function that already warns for another prefab is unwarned.
    const probe = (body: string) => {
      const sf = parseSource(`async function ops(which) {\n${body}\n}`, 'probe.ts');
      return callsTo(sf, 'serializePrefab').map((c) => serializedPrefabIsWarned(c, sf));
    };
    expect(probe("if (which === 'a') { const p = serializePrefab(1); warnInertPrefabSizes(p, 'x'); }\n  if (which === 'b') { const q = serializePrefab(2); }")).toEqual([true, false]);
    expect(probe("const p = serializePrefab(1);\n  warnInertPrefabSizes(other, 'x');")).toEqual([false]);
    expect(probe("serializePrefab(1);")).toEqual([false]);

    const producers = serializeCensus();
    expect(producers.length, 'the reader must see the serializers, or the ledger below is vacuous').toBeGreaterThanOrEqual(6);
    assertExemptionLedger({
      label: 'prefab serializers that never call warnInertPrefabSizes (#1251)',
      population: producers.filter((p) => !p.warns).map((p) => ({ item: `${p.file}::${p.in}`, site: p.file })),
      exempt: GENERATED_PREFAB_WRITERS,
      scanned: producers.length,
      floor: 6,
      fix: 'an AUTHORING write calls warnInertPrefabSizes(<the prefab>, <its source>) before writing; a prefab generated from a model or rig gets an exempt row saying so',
    });
  });

  it('createPrefabFromEntity (Save-as-Prefab) warns before writing', () => {
    expect(writesWarnedFirst(assetOpsSf, 'createPrefabFromEntity', 'writeAssetFile')).toEqual([
      { in: 'createPrefabFromEntity', write: 'if (!(await writeAssetFile(savePath, content))) return null;', warned: true },
      // The action's REDO writes the same file again and must stay quiet, for the reason above.
      { in: 'redo', write: 'if (!(await writeAssetFile(savePath, content))) { reportUndoFailure({ direction: \'Redo\', label, detail: `the prefab file was not written: ${savePath}. The entities were left un-linked rather than pointed at a file that is not there.`, }); return; }', warned: false },
    ]);
  });

  it("the agent create op answers with the warnings it computed — the agent never reads the renderer console (#1251 close-out)", () => {
    const sf = parseSource(readScannedSource(path.join(ENGINE, 'app/editor/agentEditorOps.ts')).code, 'agentEditorOps.ts');
    const kept = findNodes(sf, ts.isVariableDeclaration).filter((d) => {
      const init = d.initializer && unwrapValue(d.initializer);
      return !!init && ts.isCallExpression(init) && calleeName(init) === 'warnInertPrefabSizes';
    });
    expect(kept.length, 'one kept warnInertPrefabSizes result in the agent ops').toBe(1);
    const returned = findNodes(sf, ts.isReturnStatement).filter((r) =>
      findNodes(r, ts.isIdentifier).some((id) => declarationOf(id) === kept[0]));
    expect(returned.length, 'the kept warnings reach a return statement').toBe(1);
  });

  it('writePrefabFile itself does NOT warn, so undo/redo stays quiet', () => {
    // Asserted on the function specifically — asserting on the whole file would pass merely because
    // the helper is DEFINED there.
    expect(warnChain(prefabSf, 'writePrefabFile')).toBeUndefined();
  });

  it('installPrefabSnapshot (the undo/redo path) does NOT warn', () => {
    expect(warnChain(prefabSf, 'installPrefabSnapshot')).toBeUndefined();
  });

  it('the two readers see a warning the text slices could not, and only a real one (#1195)', () => {
    const chain = (src: string, name = 'writePrefabFile') => warnChain(parseSource(src, 'probe.ts'), name);
    // A column-0 `}` inside a template literal ended the old slice before the call.
    expect(chain('function writePrefabFile(p, s) {\n  const t = `\n}`;\n  warnInertPrefabSizes(p, s);\n}')).toEqual(['writePrefabFile']);
    // Through a helper of the same file, however deep.
    expect(chain('function writePrefabFile(p, s) { a(p, s); }\nfunction a(p, s) { b(p, s); }\nfunction b(p, s) { warnInertPrefabSizes(p, s); }'))
      .toEqual(['writePrefabFile', 'a', 'b']);
    // Handed on rather than called is still the warning — but only by its own name: an ALIAS is a known blind spot.
    expect(chain('function writePrefabFile(p, s) { [p].forEach(warnInertPrefabSizes); }')).toEqual(['writePrefabFile']);
    expect(chain('function writePrefabFile(p, s) { [p].forEach((x) => report(x, s)); }\nconst report = warnInertPrefabSizes;')).toBeUndefined();
    // A name in a string, a longer name, and a cycle with no warning in it.
    expect(chain('function writePrefabFile(p, s) { log("warnInertPrefabSizes"); warnInertPrefabSizesLater(p); }')).toBeUndefined();
    expect(chain('function writePrefabFile() { a(); }\nfunction a() { writePrefabFile(); }')).toBeUndefined();
    // The function must exist, once.
    expect(() => chain('function other() {}')).toThrow(/one function named writePrefabFile/);

    const first = (body: string) => writesWarnedFirst(parseSource(`async function save(prefab, path) {\n${body}\n}`, 'probe.ts'), 'save', 'write')
      .map((w) => w.warned);
    expect(first('warnInertPrefabSizes(prefab, path);\n\n  await write(path, prefab);')).toEqual([true]);
    expect(first('const warnings = warnInertPrefabSizes(prefab, path);\n  await write(path, prefab);')).toEqual([true]);
    expect(first('const warnings = dirty && warnInertPrefabSizes(prefab, path);\n  await write(path, prefab);')).toEqual([false]);
    expect(first('await write(path, prefab);\n  warnInertPrefabSizes(prefab, path);')).toEqual([false]);
    expect(first('if (dirty) warnInertPrefabSizes(prefab, path);\n  await write(path, prefab);')).toEqual([false]);
    expect(first('warnInertPrefabSizes(prefab, other);\n  await write(path, prefab);')).toEqual([false]);
    // The warning must inspect the prefab being written — directly, or the value its body is built from.
    expect(first('warnInertPrefabSizes({}, path);\n  await write(path, prefab);')).toEqual([false]);
    expect(first('warnInertPrefabSizes(undefined, path);\n  await write(path, prefab);')).toEqual([false]);
    expect(first('warnInertPrefabSizes(prefab, path);\n  const content = jsonFileBody(prefab);\n  await write(path, content);')).toEqual([true]);
    expect(first('warnInertPrefabSizes(prefab, path);\n  await write(path, jsonFileBody(prefab));')).toEqual([true]);
    expect(first('')).toEqual([]);
    // A write in a closure is still listed, and an earlier statement of the OUTER function is not its warning.
    expect(first('warnInertPrefabSizes(prefab, path);\n  const redo = async () => { await write(path, prefab); };')).toEqual([false]);
  });
});

/** The one function named `name` in `sf` — a rename, or a second copy, fails here by name. */
function oneFunction(sf: ts.SourceFile, name: string): ts.FunctionLikeDeclaration & { body: ts.ConciseBody } {
  const fns = functionsNamed(sf, name);
  expect(fns.length, `expected one function named ${name} in ${sf.fileName}`).toBe(1);
  return fns[0]!;
}

/** How `name` reaches `warnInertPrefabSizes`: the chain of THIS file's functions ending in one that reads
 *  it (called or handed on), or `undefined` when none does. A callee is matched by name, so a method
 *  that merely shares a local function's name is followed too — the loud direction. */
function warnChain(sf: ts.SourceFile, name: string, seen = new Set<string>()): string[] | undefined {
  if (seen.size === 0) oneFunction(sf, name);
  if (seen.has(name)) return undefined;
  seen.add(name);
  for (const fn of functionsNamed(sf, name)) {
    if (referencesToPath(fn.body, 'warnInertPrefabSizes').length > 0) return [name];
    for (const callee of calledNames(fn.body)) {
      const rest = warnChain(sf, callee, seen);
      if (rest) return [name, ...rest];
    }
  }
  return undefined;
}

/** Whether `warn`'s first argument names the object `write` writes: a binding that one of the writer's later
 *  arguments reads — directly, inlined (`jsonFileBody(prefab)`), or through a `const` that argument names and whose
 *  initializer reads it. ⚠️ Loose on purpose past that: any read of the prefab in the argument counts, so
 *  `jsonFileBody(stale, prefab.id)` would pass — the guard pins WHICH object is warned, not how the body is built. */
function warnsTheWrittenPrefab(warn: ts.CallExpression, write: ts.CallExpression): boolean {
  const warned = warn.arguments[0] && unwrapValue(warn.arguments[0]);
  const target = warned && ts.isIdentifier(warned) ? declarationOf(warned) : undefined;
  if (!target) return false;
  const resolves = (id: ts.Identifier) => declarationOf(id) === target;
  return write.arguments.slice(1).some((a) => findNodes(a, ts.isIdentifier).some((id) => {
    if (resolves(id)) return true;
    const d = declarationOf(id);
    return !!d && ts.isVariableDeclaration(d) && !!d.initializer && findNodes(d.initializer, ts.isIdentifier).some(resolves);
  }));
}

/** Every call to `writer` inside function `fnName` (closures included, named by the function they sit in), and whether
 *  `warnInertPrefabSizes(<the prefab written>, <the same path>)` ran as an EARLIER statement on its way there —
 *  unconditionally, not inside a branch. "The prefab written" resolves by symbol: the warned binding is one of the
 *  writer's data arguments, or feeds one (`const content = jsonFileBody(prefab)`) — so `warnInertPrefabSizes({}, path)`
 *  is not the warning (#1195 close-out review: the old regexes pinned both arguments). */
function writesWarnedFirst(sf: ts.SourceFile, fnName: string, writer: string): Array<{ in: string | undefined; write: string; warned: boolean }> {
  return callsTo(oneFunction(sf, fnName).body, writer).map((call) =>
    ({ in: enclosingNamedFunction(call)?.name, write: flatText(statementOf(call)), warned: warnedFirst(call) }));
}

function warnedFirst(call: ts.CallExpression): boolean {
  const path = call.arguments[0] && printedText(call.arguments[0]);
  return precedingStatements(call).some((s) => {
    // A bare call, or its result kept (`const warnings = warnInertPrefabSizes(…)` — the agent op returns them).
    const kept = ts.isVariableStatement(s) && s.declarationList.declarations.length === 1
      ? s.declarationList.declarations[0]!.initializer : undefined;
    const e = ts.isExpressionStatement(s) ? unwrapValue(s.expression) : kept && unwrapValue(kept);
    return !!e && ts.isCallExpression(e) && calleeName(e) === 'warnInertPrefabSizes'
      && !!e.arguments[1] && printedText(e.arguments[1]) === path && warnsTheWrittenPrefab(e, call);
  });
}

const ENGINE = path.resolve(SRC, '../../..');

/** Prefab writes GENERATED from an import rather than authored: their trees are model/rig entities with no `UIElement`,
 *  so there is no inert UI size to report and nobody to report it to. */
const GENERATED_PREFAB_WRITERS = [
  { item: 'packages/modoki/src/editor/panels/Assets.tsx::importModelWithMeta', reason: 'model import: the prefab is serialized from the GLB it just spawned — mesh/bone entities, no UIElement' },
  { item: 'packages/modoki/src/editor/panels/assetViews/ModelAssetView.tsx::ModelAssetView', reason: 'model re-import regenerates the model prefab from the GLB — mesh/bone entities, no UIElement' },
  { item: 'packages/modoki/src/editor/scene/skinPrefab.ts::makeRigPrefabAsset', reason: 'a 2D skin rig prefab built from bone definitions — Bone/skin entities, no UIElement' },
];

function serializedPrefabIsWarned(call: ts.CallExpression, fn: ts.Node): boolean {
  let bound: ts.Node = call;
  while (bound.parent && (ts.isParenthesizedExpression(bound.parent) || ts.isAwaitExpression(bound.parent) || ts.isAsExpression(bound.parent))) bound = bound.parent;
  const decl = bound.parent;
  if (!decl || !ts.isVariableDeclaration(decl) || !ts.isIdentifier(decl.name)) return false;
  return callsTo(fn, 'warnInertPrefabSizes').some((w) => {
    const arg = w.arguments[0] && unwrapValue(w.arguments[0]);
    return !!arg && ts.isIdentifier(arg) && declarationOf(arg) === decl;
  });
}

/** Every `serializePrefab(` call in the editor, with the function it sits in and whether THAT CALL's prefab is warned:
 *  the call's result is bound to a variable, and some `warnInertPrefabSizes(<that variable>, …)` in the same function
 *  names it — resolved by symbol. ⚠️ Per call, not per function (#1251 close-out re-review): `registerEditorAgentOps`
 *  is one function holding every agent op and already warns once, so a function-level test passed a second, unwarned
 *  serializer added beside `detach`. */
function serializeCensus(): Array<{ file: string; in: string | undefined; warns: boolean }> {
  const roots = [path.join(SRC, 'editor'), path.join(ENGINE, 'app/editor')];
  const files = roots.flatMap((root) => (fs.readdirSync(root, { recursive: true }) as string[])
    .filter((f) => /\.tsx?$/.test(f)).map((f) => path.join(root, f)));
  return files.sort().flatMap((abs) => {
    const code = readScannedSource(abs).code;
    if (!code.includes('serializePrefab(')) return [];
    return callsTo(parseSource(code, path.basename(abs)), 'serializePrefab').map((call) => {
      const fn = enclosingNamedFunction(call);
      return {
        file: path.relative(ENGINE, abs).split(path.sep).join('/'),
        in: fn?.name,
        warns: !!fn && serializedPrefabIsWarned(call, fn.node),
      };
    });
  });
}

/** Every `writePrefabFile` call in the editor — the package's `src/editor` and the app shell's `app/editor` (the
 *  agent ops) — with the function it sits in and whether it warns first. Enumerated from the files, not named. */
function prefabWriteCensus(): Array<{ file: string; in: string | undefined; warned: boolean }> {
  const roots = [path.join(SRC, 'editor'), path.join(ENGINE, 'app/editor')];
  const files = roots.flatMap((root) => (fs.readdirSync(root, { recursive: true }) as string[])
    .filter((f) => /\.tsx?$/.test(f)).map((f) => path.join(root, f)));
  return files.sort().flatMap((abs) => {
    const code = readScannedSource(abs).code;
    if (!code.includes('writePrefabFile')) return [];
    return callsTo(parseSource(code, path.basename(abs)), 'writePrefabFile').map((call) => ({
      file: path.relative(ENGINE, abs).split(path.sep).join('/'),
      in: enclosingNamedFunction(call)?.name,
      warned: warnedFirst(call),
    }));
  });
}
