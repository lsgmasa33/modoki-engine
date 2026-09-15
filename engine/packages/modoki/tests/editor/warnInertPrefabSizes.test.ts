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

describe('the hook is on the AUTHORING writes, not on writePrefabFile (#42)', () => {
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

  it('applyToPrefabSelective warns before writing', () => {
    expect(writesWarnedFirst(prefabSf, 'applyToPrefabSelective', 'writePrefabFile')).toEqual([
      { in: 'applyToPrefabSelective', write: 'const ok = await writePrefabFile(source, newPrefab);', warned: true },
    ]);
  });

  it('createPrefabFromEntity (Save-as-Prefab) warns before writing', () => {
    expect(writesWarnedFirst(assetOpsSf, 'createPrefabFromEntity', 'writeAssetFile')).toEqual([
      { in: 'createPrefabFromEntity', write: 'if (!(await writeAssetFile(savePath, content))) return null;', warned: true },
      // The action's REDO writes the same file again and must stay quiet, for the reason above.
      { in: 'redo', write: 'if (!(await writeAssetFile(savePath, content))) { reportUndoFailure({ direction: \'Redo\', label, detail: `the prefab file was not written: ${savePath}. The entities were left un-linked rather than pointed at a file that is not there.`, }); return; }', warned: false },
    ]);
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
  return callsTo(oneFunction(sf, fnName).body, writer).map((call) => {
    const path = call.arguments[0] && printedText(call.arguments[0]);
    const warned = precedingStatements(call).some((s) => {
      const e = ts.isExpressionStatement(s) ? unwrapValue(s.expression) : undefined;
      return !!e && ts.isCallExpression(e) && calleeName(e) === 'warnInertPrefabSizes'
        && !!e.arguments[1] && printedText(e.arguments[1]) === path && warnsTheWrittenPrefab(e, call);
    });
    return { in: enclosingNamedFunction(call)?.name, write: flatText(statementOf(call)), warned };
  });
}
