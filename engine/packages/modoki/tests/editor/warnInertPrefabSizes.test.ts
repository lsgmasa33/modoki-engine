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
import { boundIdentifier, calledNames, callsTo, declarationOf, enclosingFunction, enclosingNamedFunction, findNodes, flatText, functionsNamed, guardProves, parseSource, precedingStatements, printedText, referencesToPath, statementOf, ts, unwrapValue, valueCarrier } from '../helpers/sourceAst';
import { warnInertPrefabSizes } from '../../src/editor/scene/prefab';
import { assertExemptionLedger } from '../helpers/exemptionLedger';
import { registerAsset, unregisterAsset } from '../../src/runtime/loaders/assetManifest';

const SRC = path.resolve(__dirname, '../../src');
/** A probe source's import of the warning — the readers only accept the engine function, never a same-named stranger. */
const WARN_IMPORT = "import { warnInertPrefabSizes } from './prefab';\n";
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
    // It DOES say so (#1212): a document with no entities array is not a prefab. Every real
    // authoring writer passes a serialized PrefabFile, which always carries `entities`, so this
    // never fires on a legitimate save — only on the malformed input it describes.
    expect(warn).toHaveBeenCalledTimes(5);
    expect(String(warn.mock.calls[0][0])).toMatch(/not a prefab document/);
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
      { file: 'packages/modoki/src/editor/scene/prefabEdit.ts', in: 'savePrefabEditReport', warned: true }, // via writePrefabFileReport
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
      const sf = parseSource(`${WARN_IMPORT}async function ops(which) {\n${body}\n}`, 'probe.ts');
      return callsTo(sf, 'serializePrefab').map((c) => serializedPrefabIsWarned(c));
    };
    expect(probe("if (which === 'a') { const p = serializePrefab(1); warnInertPrefabSizes(p, 'x'); }\n  if (which === 'b') { const q = serializePrefab(2); }")).toEqual([true, false]);
    expect(probe("const p = serializePrefab(1);\n  warnInertPrefabSizes(other, 'x');")).toEqual([false]);
    expect(probe("serializePrefab(1);")).toEqual([false]);
    // Unconditional, and reached through the shared wrapper climb.
    expect(probe("const p = serializePrefab(1);\n  if (never) warnInertPrefabSizes(p, 'x');")).toEqual([false]);
    expect(probe("const p = serializePrefab(1);\n  const later = () => warnInertPrefabSizes(p, 'x');")).toEqual([false]);
    expect(probe("warnInertPrefabSizes(p, 'x');\n  const p = serializePrefab(1);")).toEqual([false]);
    expect(probe("const p = serializePrefab(1)!;\n  const w = warnInertPrefabSizes(p, 'x');")).toEqual([true]);
    // Nothing between the two may leave first (review of d6c713d53) — but the null bail may, since it has no prefab.
    expect(probe("const p = serializePrefab(1);\n  if (fast) { await writeAssetFile(path, jsonFileBody(p)); return; }\n  warnInertPrefabSizes(p, 'x');")).toEqual([false]);
    expect(probe("const p = serializePrefab(1);\n  await write(p);\n  throw new Error('x');\n  warnInertPrefabSizes(p, 'x');")).toEqual([false]);
    expect(probe("const p = serializePrefab(1);\n  for (const k of ks) { if (k) break; }\n  warnInertPrefabSizes(p, 'x');")).toEqual([true]);
    expect(probe("const p = serializePrefab(1);\n  if (!p) return null;\n  warnInertPrefabSizes(p, 'x');")).toEqual([true]);
    expect(probe("const p = serializePrefab(1);\n  if (!p) { console.error('none'); return false; }\n  warnInertPrefabSizes(p, 'x');")).toEqual([true]);
    expect(probe("const p = serializePrefab(1);\n  if (!p || fast) return null;\n  warnInertPrefabSizes(p, 'x');")).toEqual([false]);
    expect(probe("const p = serializePrefab(1);\n  if (!q) return null;\n  warnInertPrefabSizes(p, 'x');")).toEqual([false]);
    // The engine function only: a method sharing its name, or a local shadowing it, is not the warning.
    expect(probe("const p = serializePrefab(1);\n  logger.warnInertPrefabSizes(p, 'x');")).toEqual([false]);
    expect(probe("function warnInertPrefabSizes() {}\n  const p = serializePrefab(1);\n  warnInertPrefabSizes(p, 'x');")).toEqual([false]);
    // …and an import only when it is that export of that module.
    const probeFrom = (imp: string) => callsTo(parseSource(`${imp}\nasync function ops() {\n  const p = serializePrefab(1);\n  warnInertPrefabSizes(p, 'x');\n}`, 'probe.ts'), 'serializePrefab').map((c) => serializedPrefabIsWarned(c));
    expect(probeFrom("import { warnInertPrefabSizes } from './someLogger';")).toEqual([false]);
    expect(probeFrom("import { noop as warnInertPrefabSizes } from './prefab';")).toEqual([false]);
    expect(probeFrom("import { warnInertPrefabSizes } from '@modoki/engine/editor';")).toEqual([true]);
    expect(probeFrom("import { warnInertPrefabSizes } from '../scene/prefab';")).toEqual([true]);

    const producers = serializeCensus();
    expect(producers.length, 'the reader must see the serializers, or the ledger below is vacuous').toBeGreaterThanOrEqual(6);
    assertExemptionLedger({
      label: 'prefab serializers that never call warnInertPrefabSizes (#1251)',
      population: producers.filter((p) => !p.warns).map((p) => ({ item: `${p.file}::${p.in}`, site: p.file })),
      exempt: [...GENERATED_PREFAB_WRITERS, ...SERIALIZE_FOR_A_CALLER],
      scanned: producers.length,
      floor: 6,
      fix: 'an AUTHORING write calls warnInertPrefabSizes(<the prefab>, <its source>) before writing; a prefab generated from a model or rig gets an exempt row saying so',
    });
  });

  it('createPrefabFromEntity (Save-as-Prefab) warns before writing', () => {
    // The create goes through writeNewAssetDocument since #1264 (create-only, ask, keep the guid), so the
    // authoring write is THAT call, and the warned binding feeds its builder.
    expect(writesWarnedFirst(assetOpsSf, 'createPrefabFromEntity', 'writeNewAssetDocument').map(({ in: fn, warned }) => ({ in: fn, warned }))).toEqual([
      { in: 'createPrefabFromEntity', warned: true },
    ]);
    // The plain writes left are the action's restores, and must stay quiet for the reason above: UNDO of a Replace
    // writes the REPLACED bytes back, REDO writes the same file again.
    expect(writesWarnedFirst(assetOpsSf, 'createPrefabFromEntity', 'writeAssetFile').map(({ in: fn, warned }) => ({ in: fn, warned }))).toEqual([
      { in: 'undo', warned: false },
      { in: 'redo', warned: false },
    ]);
  });

  it("the agent create op answers with the warnings it computed — the agent never reads the renderer console (#1251 close-out)", () => {
    const sf = parseSource(readScannedSource(path.join(ENGINE, 'app/editor/agentEditorOps.ts')).code, 'agentEditorOps.ts');
    const kept = findNodes(sf, ts.isVariableDeclaration).filter((d) => {
      const init = d.initializer && unwrapValue(d.initializer);
      return isWarnCall(init);
    });
    expect(kept.length, 'one kept warnInertPrefabSizes result in the agent ops').toBe(1);
    expect(returnsAnswering(kept[0], (v) => isBinding(v, kept[0])), 'the kept warnings ARE the response\'s `warnings`').toBe(1);
  });

  it('the agent apply and edit-save ops answer with the warnings their save reported (#1258)', () => {
    // Both warn one call down (applyToPrefabSelective, savePrefabEditReport), so the op holds no warn call of its own —
    // what has to reach its response is the helper result's `warnings`. Each helper is behaviour-tested for filling it:
    // applyToPrefabPromotedAdditions.test.ts and prefabEditZIndexRoundTrip.test.ts.
    const sf = parseSource(readScannedSource(path.join(ENGINE, 'app/editor/agentEditorOps.ts')).code, 'agentEditorOps.ts');

    // apply: `const result = await applyToPrefabWithUndo(…)`, answered as `warnings: result.warnings`.
    const applyCalls = callsTo(sf, 'applyToPrefabWithUndo');
    expect(applyCalls.length, 'one applyToPrefabWithUndo call in the agent ops').toBe(1);
    const applyResult = boundIdentifier(applyCalls[0]);
    expect(applyResult, 'its result is kept in a variable').toBeDefined();
    const resultDecl = declarationOf(applyResult!)!;
    expect(returnsAnswering(applyCalls[0], (v) => ts.isPropertyAccessExpression(v) && v.name.text === 'warnings'
      && ts.isIdentifier(v.expression) && isBinding(v.expression, resultDecl)), "apply answers with result.warnings itself").toBe(1);

    // edit-save: `const { saved, warnings } = await savePrefabEditReport()`, answered as `{ warnings }`.
    const saveCalls = callsTo(sf, 'savePrefabEditReport');
    expect(saveCalls.length, 'one savePrefabEditReport call in the agent ops').toBe(1);
    expect(callsTo(sf, 'savePrefabEdit').length, 'the boolean savePrefabEdit drops the warnings — the op must not use it').toBe(0);
    const pattern = valueCarrier(saveCalls[0]).parent;
    expect(pattern && ts.isVariableDeclaration(pattern) && ts.isObjectBindingPattern(pattern.name), 'the report is destructured').toBe(true);
    const warningsBinding = (pattern as ts.VariableDeclaration).name as ts.ObjectBindingPattern;
    const el = warningsBinding.elements.find((e) => ts.isIdentifier(e.name) && e.name.text === 'warnings' && !e.propertyName);
    expect(el, 'edit-save keeps `warnings` from the report').toBeDefined();
    expect(returnsAnswering(saveCalls[0], (v) => isBinding(v, el!)), "edit-save answers with the report's warnings itself").toBe(1);
  });

  it('the response readers accept only the kept value itself, not a derived or replaced list', () => {
    // Review of #1258: the first version only asked whether the name was MENTIONED in a return, so `warnings: []` and
    // `warnings: warnings.slice(1)` both passed. The reader now requires the `warnings` property's value to BE the binding.
    const probe = (ret: string) => {
      const sf = parseSource(`function op() {\n  const w = compute();\n  const result = other();\n  ${ret}\n}`, 'probe.ts');
      const w = findNodes(sf, ts.isVariableDeclaration).find((d) => ts.isIdentifier(d.name) && d.name.text === 'w')!;
      return returnsAnswering(w, (v) => isBinding(v, w));
    };
    expect(probe('return { ok: true, ...(w.length ? { warnings: w } : {}) };')).toBe(1);
    expect(probe('return { ok: true, warnings: w };')).toBe(1);
    expect(probe('return { ok: true, ...(w.length ? { warnings: [] as string[] } : {}) };')).toBe(0);
    expect(probe('return { ok: true, ...(w.length ? { warnings: w.slice(1) } : {}) };')).toBe(0);
    expect(probe('return { ok: true, count: w.length };')).toBe(0);
    expect(probe('return { ok: true, warnings: result };')).toBe(0);
    expect(probe('const later = () => ({ warnings: w });\n  return { ok: true };')).toBe(0);
    // Second review: the condition that SENDS the list, where it sits, and whose return it is.
    expect(probe('return { ok: true, ...(!w.length ? { warnings: w } : {}) };')).toBe(0);
    expect(probe('return { ok: true, ...(w.length > 99 ? { warnings: w } : {}) };')).toBe(0);
    expect(probe('return { ok: true, ...(false ? { warnings: w } : {}) };')).toBe(0);
    expect(probe('return { ok: true, ...(w.length ? { warnings: w } : { warnings: w }) };')).toBe(0);
    expect(probe('return { ok: true, debug: { warnings: w } };')).toBe(0);
    expect(probe('pushAction({ redo: () => { return { warnings: w }; } });\n  return { ok: true };')).toBe(0);
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

    const first = (body: string) => writesWarnedFirst(parseSource(`${WARN_IMPORT}async function save(prefab, path) {\n${body}\n}`, 'probe.ts'), 'save', 'write')
      .map((w) => w.warned);
    expect(first('warnInertPrefabSizes(prefab, path);\n\n  await write(path, prefab);')).toEqual([true]);
    expect(first('const warnings = warnInertPrefabSizes(prefab, path);\n  await write(path, prefab);')).toEqual([true]);
    expect(first('const warnings = dirty && warnInertPrefabSizes(prefab, path);\n  await write(path, prefab);')).toEqual([false]);
    expect(first('await write(path, prefab);\n  warnInertPrefabSizes(prefab, path);')).toEqual([false]);
    expect(first('if (dirty) warnInertPrefabSizes(prefab, path);\n  await write(path, prefab);')).toEqual([false]);
    expect(first('warnInertPrefabSizes(prefab, other);\n  await write(path, prefab);')).toEqual([false]);
    expect(first('this.warnInertPrefabSizes(prefab, path);\n  await write(path, prefab);')).toEqual([false]);
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
    return isWarnCall(e)
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

/** Functions that serialize a prefab for a CALLER and write nothing themselves: whether it is written, and so warned,
 *  is the caller's, which the write census above holds to it. */
const SERIALIZE_FOR_A_CALLER = [
  { item: 'packages/modoki/src/editor/scene/prefabEdit.ts::serializePrefabEditWorld', reason: 'the prefab-edit world as a document: savePrefabEditReport warns what it writes (the write census row for it), and the tests read it as what a Save would write' },
];

/** Whether `e` calls THE engine `warnInertPrefabSizes` — by its bare name, resolving to an import or to its own
 *  top-level declaration in `prefab.ts`. A method that shares the name (`logger.warnInertPrefabSizes(…)`) or a local
 *  function shadowing it is not the warning (#1251 review of d6c713d53). */
function isWarnCall(e: ts.Expression | undefined): e is ts.CallExpression {
  if (!e || !ts.isCallExpression(e) || !ts.isIdentifier(e.expression) || e.expression.text !== 'warnInertPrefabSizes') return false;
  const d = declarationOf(e.expression);
  if (!d) return false;
  // An import of THAT export from THAT module: not a same-named export of another module, nor another export aliased
  // to the name (review of the census fix: `from './someLogger'` and `{ noop as warnInertPrefabSizes }` both passed).
  if (ts.isImportSpecifier(d)) {
    const decl = d.parent.parent.parent;
    const from = ts.isStringLiteral(decl.moduleSpecifier) ? decl.moduleSpecifier.text : '';
    return (d.propertyName ?? d.name).text === 'warnInertPrefabSizes' && (/(^|\/)prefab$/.test(from) || from === '@modoki/engine/editor');
  }
  return ts.isFunctionDeclaration(d) && ts.isSourceFile(d.parent) && path.basename(d.getSourceFile().fileName) === 'prefab.ts';
}

/** Whether statement `s` can leave its list without running the statements after it: a `return` or `throw` anywhere
 *  in it, or a `break`/`continue` aimed outside it — nested functions and classes excluded, since their exits are
 *  their own. Syntactic only: a call that throws is not known to. The ONE exit allowed is the null bail
 *  `if (!prefab) <exit>` — on that path there is no prefab to warn about. */
function mayLeaveBefore(s: ts.Node, isPrefab: (e: ts.Expression) => boolean): boolean {
  if (ts.isIfStatement(s) && !s.elseStatement && guardProves({ test: s.expression, holds: true, by: s }, isPrefab, false)) return false;
  const isLoop = (n: ts.Node) => ts.isForStatement(n) || ts.isForInStatement(n) || ts.isForOfStatement(n) || ts.isWhileStatement(n) || ts.isDoStatement(n);
  const leaves = (n: ts.Node, loop: boolean, sw: boolean): boolean => {
    if (ts.isFunctionLike(n) || ts.isClassLike(n)) return false;
    if (ts.isReturnStatement(n) || ts.isThrowStatement(n)) return true;
    if (ts.isBreakStatement(n)) return !!n.label || !(loop || sw);
    if (ts.isContinueStatement(n)) return !!n.label || !loop;
    const inLoop = loop || isLoop(n);
    const inSwitch = sw || ts.isSwitchStatement(n);
    return !!ts.forEachChild(n, (c) => leaves(c, inLoop, inSwitch) || undefined);
  };
  return leaves(s, false, false);
}

function serializedPrefabIsWarned(call: ts.CallExpression): boolean {
  // Bound through the shared wrapper climb (`!`, `as`, `satisfies`, parens, await), so `serializePrefab(id)!` is read.
  const name = boundIdentifier(call);
  const decl = name?.parent;
  if (!decl) return false;
  // The warning must be an UNCONDITIONAL later statement of the same list — the bar `warnedFirst` holds the
  // writePrefabFile census to. A warning inside a branch, a closure or a callback may never run (#1251 close-out
  // re-review: `if (never) warnInertPrefabSizes(copy, …)` passed). Nor may anything between the two leave the list
  // (review of d6c713d53: `if (fast) { await write(p); return; }` above the warning passed) — except the null bail.
  // It does not also pin "before the write", because this census exists for writers it cannot name.
  const stmt = statementOf(call);
  const list = stmt.parent && (stmt.parent as { statements?: readonly ts.Node[] }).statements;
  if (!list) return false;
  const isPrefab = (e: ts.Expression) => ts.isIdentifier(e) && declarationOf(e) === decl;
  for (const s of list.slice(list.indexOf(stmt) + 1)) {
    const kept = ts.isVariableStatement(s) && s.declarationList.declarations.length === 1
      ? s.declarationList.declarations[0]!.initializer : undefined;
    const e = ts.isExpressionStatement(s) ? unwrapValue(s.expression) : kept && unwrapValue(kept);
    if (isWarnCall(e)) {
      const arg = e.arguments[0] && unwrapValue(e.arguments[0]);
      if (arg && isPrefab(arg)) return true;
    }
    if (mayLeaveBefore(s, isPrefab)) return false;
  }
  return false;
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
        warns: serializedPrefabIsWarned(call),
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
    const sf = parseSource(code, path.basename(abs));
    // ⚠️ BOTH names (#1468). The save choke point gained a report-returning sibling —
    // `writePrefabFileReport` carries the backend's refusal reason out, which a boolean cannot — and
    // `writePrefabFile` is now a thin wrapper over it. A census that knows only the old name stops
    // seeing every caller that moves to the new one, which is this guard going quiet rather than
    // green: `savePrefabEditReport` dropped straight out of it.
    return [...callsTo(sf, 'writePrefabFile'), ...callsTo(sf, 'writePrefabFileReport')]
      .map((call) => ({
        file: path.relative(ENGINE, abs).split(path.sep).join('/'),
        in: enclosingNamedFunction(call)?.name,
        warned: warnedFirst(call),
      }))
      // The wrapper's own delegation is not a write SITE — it is the same write, named twice.
      .filter((w) => w.in !== 'writePrefabFile');
  });
}

/** Whether `v` is a read of exactly the binding `decl` declares — by symbol, so a same-named local elsewhere does not count. */
function isBinding(v: ts.Expression, decl: ts.Declaration): boolean {
  return ts.isIdentifier(v) && declarationOf(v) === decl;
}

/** How many `return` statements of the function `host` runs in answer with the kept warnings, in one of the two shapes
 *  an op uses: a top-level `warnings: <v>` / `{ warnings }` in the returned object literal, or a top-level spread
 *  `...(<v>.length ? { warnings: <v> } : {})`, where `<v>` satisfies `isValue` in both places.
 *
 *  Each restriction closes a false pass a review found (#1258 close-out): the VALUE is judged, so `warnings: []` and
 *  `warnings: w.slice(1)` fail; the spread's CONDITION must be exactly the list's own `.length`, so `!w.length ?`,
 *  `w.length > 99 ?` and `false ?` fail; the property must be TOP-LEVEL, so `debug: { warnings: w }` fails; and the
 *  return must be the host function's own, so a `return { warnings }` inside a callback fails.
 *
 *  ⚠️ Not modelled, and it fails CLOSED rather than open: a response built into a variable and returned by name, or a
 *  value like `w ?? []`, counts 0 and turns the guard red. What it does NOT see is a warnings-carrying return on a
 *  refusal branch while the success return drops it; the ops throw on refusal, so there is no such branch today. */
function returnsAnswering(host: ts.Node, isValue: (v: ts.Expression) => boolean): number {
  const fn = enclosingFunction(host);
  const isWarningsProp = (p: ts.ObjectLiteralElementLike): boolean =>
    (ts.isShorthandPropertyAssignment(p) || ts.isPropertyAssignment(p)) && ts.isIdentifier(p.name) && p.name.text === 'warnings'
    && isValue(ts.isShorthandPropertyAssignment(p) ? p.name : unwrapValue(p.initializer));
  const isGuardedSpread = (p: ts.ObjectLiteralElementLike): boolean => {
    if (!ts.isSpreadAssignment(p)) return false;
    const cond = unwrapValue(p.expression);
    if (!ts.isConditionalExpression(cond)) return false;
    const test = unwrapValue(cond.condition);
    const whenTrue = unwrapValue(cond.whenTrue);
    const whenFalse = unwrapValue(cond.whenFalse);
    return ts.isPropertyAccessExpression(test) && test.name.text === 'length' && isValue(unwrapValue(test.expression))
      && ts.isObjectLiteralExpression(whenTrue) && whenTrue.properties.some(isWarningsProp)
      && ts.isObjectLiteralExpression(whenFalse) && whenFalse.properties.length === 0;
  };
  return findNodes(fn, ts.isReturnStatement).filter((r) => {
    if (enclosingFunction(r) !== fn || !r.expression) return false;
    const obj = unwrapValue(r.expression);
    return ts.isObjectLiteralExpression(obj) && obj.properties.some((p) => isWarningsProp(p) || isGuardedSpread(p));
  }).length;
}
