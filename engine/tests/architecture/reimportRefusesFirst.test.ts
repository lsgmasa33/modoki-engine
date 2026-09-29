/** A rigged model re-import asks whether it may write the prefab BEFORE it bakes anything (#1678).
 *
 *  `classifyExistingPrefabId` refuses a prefab a newer build wrote. That refusal is only worth something if it lands
 *  before `/api/reimport` bakes the GLB and before `importModel` regenerates the mesh/material/texture sidecars; after
 *  them, the server's prefab gate refuses the write anyway, and all that is left is a half-rewritten import.
 *
 *  ⚠️ A SOURCE-ORDER pin, not a drive. The decision lives inline in `ModelAssetView.tsx`'s re-import callback, and a
 *  panel is never mounted in jsdom (CLAUDE.md § Tests), so the order is pinned on the code, comments stripped. The
 *  classifier's own answer is driven in `classifyExistingPrefabId.test.ts`. */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { readScannedSource } from '@modoki/engine/testing';
import { expectInOrder } from '@modoki/engine/testing/inOrder';

const FILE = path.join(__dirname, '../../packages/modoki/src/editor/panels/assetViews/ModelAssetView.tsx');

describe('ModelAssetView re-import: the prefab refusal precedes every write (#1678)', () => {
  // Mutation: move the `existingPrefab?.kind === 'refuse'` block below the `/api/reimport` fetch — red.
  it('classify, then refuse-and-return, then /api/reimport, then importModel', () => {
    const code = readScannedSource(FILE).code;
    const refuse = "existingPrefab?.kind === 'refuse'";
    const bake = "'/api/reimport'";
    expectInOrder(code, ['await classifyExistingPrefabId(prefabPath)', refuse, bake, 'await importModel('], 'ModelAssetView re-import');
    // The refusal RETURNS: nothing between it and the bake may fall through.
    expect(code.slice(code.indexOf(refuse), code.indexOf(bake))).toMatch(/setImportError\([^;]*;\s*return;/);
  });
});
