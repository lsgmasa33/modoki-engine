/** #784 phase C2b item 2 — `.mat.json` had TWO writers that disagreed: GLB import
 *  (`modelImport.ts`'s `extractMaterialAsset`) stamped `version: 1`; the "Create Material" button
 *  (→ `defaultAssetData('material')` → `defaultMaterial()`) stamped nothing at all. Measured: 11
 *  of 104 committed `.mat.json` carry no version because of this divergence. This test FAILS
 *  before the fix (`defaultMaterial()` returned no `version` key at all).
 *
 *  Per the #417/#411 class of bug, a runtime value comparison alone cannot tell "reads the
 *  constant" from "has its own literal that happens to agree today" (docs/format-versioning.md
 *  § 4's first trap: a guard must require the REPLACEMENT, not merely the absence of the old
 *  literal) — so both writer sites also get a source-level assertion, mirroring
 *  `atlasCreateParity.test.ts`. */

import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { defaultAssetData } from '../../src/runtime/assets/assetSchemas';
import { MATERIAL_FORMAT_VERSION } from '../../src/runtime/traits/Renderable3D';
import { readScannedSource } from '../helpers/sourceScanner';

const src = (rel: string) => readScannedSource(path.join(__dirname, '../../src', rel)).code;

describe('material format-version parity (#784 phase C2b)', () => {
  it('Create Material\'s default document carries the current MATERIAL_FORMAT_VERSION', () => {
    const doc = defaultAssetData('material') as Record<string, unknown>;
    expect(doc.version).toBe(MATERIAL_FORMAT_VERSION);
  });

  it('defaultMaterial() sources its stamp from MATERIAL_FORMAT_VERSION, not a literal', () => {
    const s = src('runtime/assets/assetSchemas.ts');
    expect(s).toMatch(/import\s*\{[^}]*MATERIAL_FORMAT_VERSION[^}]*\}\s*from\s*'\.\.\/traits\/Renderable3D'/);
    expect(s).toMatch(/function defaultMaterial\(\)[\s\S]*?version:\s*MATERIAL_FORMAT_VERSION/);
  });

  it('GLB import\'s extractMaterialAsset sources its stamp from MATERIAL_FORMAT_VERSION, not a literal', () => {
    const s = src('editor/scene/modelImport.ts');
    expect(s).toMatch(/import\s*\{[^}]*MATERIAL_FORMAT_VERSION[^}]*\}\s*from\s*'\.\.\/\.\.\/runtime\/traits'/);
    expect(s).toMatch(/function extractMaterialAsset[\s\S]*?version:\s*MATERIAL_FORMAT_VERSION/);
    // The old unconditional literal must be gone from this writer.
    expect(s).not.toMatch(/version:\s*1,/);
  });

  it('MATERIAL_FIELDS declares a version row (previously undeclared)', () => {
    const s = src('runtime/assets/assetSchemas.ts');
    expect(s).toMatch(/MATERIAL_FIELDS[\s\S]*?\{\s*key:\s*'version'/);
  });
});
