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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

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

/** Extract `interface <name> { ... }`'s body — up to the next top-level `}` at the start of a
 *  line, which is how every one of these interfaces is formatted in this repo. */
function interfaceBody(src: string, name: string): string | null {
  const start = src.indexOf(`interface ${name} {`);
  if (start === -1) return null;
  const bodyStart = src.indexOf('{', start) + 1;
  const end = src.indexOf('\n}', bodyStart);
  if (end === -1) return null;
  return src.slice(bodyStart, end);
}

describe('read-back document types declare version: number, never a pinned literal (#734, #784)', () => {
  for (const t of TARGETS) {
    it(`${t.interfaceName}.version in ${t.file} is "number"`, () => {
      const abs = path.resolve(ENGINE, t.file);
      const src = readFileSync(abs, 'utf8');
      const body = interfaceBody(src, t.interfaceName);
      expect(body, `could not find "interface ${t.interfaceName} { ... }" in ${t.file}`).toBeTruthy();

      const fieldMatch = body!.match(/version\s*:\s*([^;]+);/);
      // Assert the field is found by name before asserting on its type — a rename/removal of
      // the field must go red by NAME, not pass vacuously because there is nothing to fail.
      expect(fieldMatch, `no "version: <type>;" field found in interface ${t.interfaceName}`).toBeTruthy();

      expect(
        fieldMatch![1].trim(),
        `${t.interfaceName}.version must be "number", found "${fieldMatch![1].trim()}"`,
      ).toBe('number');
    });
  }
});
