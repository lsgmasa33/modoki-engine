/** Five read-back document types were widened from a literal-pinned `version` to
 *  `version: number` in #784 phase C1, following the precedent set by
 *  `BinaryAssetMeta.version` in #734: a type describing a document read back from disk or
 *  the network must not pin the version literal, because the bytes may have been written by
 *  a different build (see `formatVersionFromConstant.test.ts`'s header comment for the full
 *  reasoning, including why a TS type position is exempt from THAT guard).
 *
 *  This guard reads the five source files as text, isolates each named interface's own body
 *  (`Renderable3D.ts` declares TWO of the five — `MeshAsset` and `MaterialAsset` — so a
 *  file-wide search would let one revert to a literal while the other's `version: number`
 *  passes for both), and asserts the `version` field inside it is `number` — a careless
 *  revert back to a literal (`version: 1`) or a literal union (`version: 1 | 2 | 3`) must go
 *  red here. Each assertion first checks the interface and field are FOUND at all (by name,
 *  not just absence of a violation), so a rename fails loudly instead of passing vacuously.
 *  Modelled on `prefabFormatVersionLiteral.test.ts`, the local precedent for this exact
 *  read-source-as-text style. */
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readScannedSource } from '@modoki/engine/testing';
import { parseSource, printedText, typeMembers, typesNamed } from '@modoki/engine/testing/sourceAst';

const ENGINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

interface Target {
  interfaceName: string;
  file: string;
}

const TARGETS: Target[] = [
  { interfaceName: 'ParticleEffectDef', file: 'packages/modoki/src/runtime/particles/types.ts' },
  { interfaceName: 'AtlasSource', file: 'packages/modoki/src/runtime/loaders/spriteAtlas.ts' },
  { interfaceName: 'MeshAsset', file: 'packages/modoki/src/runtime/traits/Renderable3D.ts' },
  { interfaceName: 'MaterialAsset', file: 'packages/modoki/src/runtime/traits/Renderable3D.ts' },
  { interfaceName: 'PrefabFile', file: 'packages/modoki/src/editor/scene/prefab.ts' },
];

/** The type annotation of `<name>.version`, as the printer spells it — or why it cannot be read.
 *
 *  ⚠️ **The interface and its member come from the parser (#1195).** This used to cut the body at the
 *  first `'\n}'` after `interface <name> {` and match `/version\s*:\s*([^;]+);/` in it: a nested type
 *  literal closing at column 0 ended the body early, and a NESTED `version:` (a member of some inner
 *  literal) answered for the interface's own. */
function versionType(file: string, name: string): string {
  return versionTypeIn(readScannedSource(file).code, file, name);
}

/** `versionType` over source handed in directly — the one reader both the real files and the fixture use. */
function versionTypeIn(code: string, file: string, name: string): string {
  const sf = parseSource(code, file);
  const decls = typesNamed(sf, name);
  expect(decls.length, `expected one "interface ${name}" in ${file}`).toBe(1);
  const members = typeMembers(decls[0]);
  expect(members, `${name} in ${file} is no longer a plain interface or a type literal (an alias, or one that extends another)`).toBeDefined();
  // Found by NAME before asserting on its type — a rename/removal of the field must go red by name,
  // not pass vacuously because there is nothing to fail.
  const version = members!.filter((m) => m.name === 'version' && m.kind === 'property');
  expect(version.length, `no own "version" field on ${name}`).toBe(1);
  expect(version[0]!.type, `${name}.version has no type annotation`).toBeDefined();
  return printedText(version[0]!.type!);
}

describe('read-back document types declare version: number, never a pinned literal (#734, #784)', () => {
  for (const t of TARGETS) {
    it(`${t.interfaceName}.version in ${t.file} is "number"`, () => {
      const found = versionType(path.resolve(ENGINE, t.file), t.interfaceName);
      expect(found, `${t.interfaceName}.version must be "number", found "${found}"`).toBe('number');
    });
  }

  it('reads the interface\'s OWN version: not a nested literal\'s, and not moved by a column-0 closer (#1195)', () => {
    // The two shapes the text slice got wrong, on synthetic source through the guard's own reader.
    const probe = (src: string) => versionTypeIn(src, 'probe.ts', 'Doc');
    expect(probe('interface Doc {\n  meta: { version: number;\n};\n  version: 1;\n}')).toBe('1');
    expect(probe('interface Doc {\n  version: number;\n  inner: { version: 2 };\n}')).toBe('number');
  });
});
