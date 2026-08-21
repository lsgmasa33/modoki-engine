/** Reverse reference graph integration test (#284) — over the REAL `games/court`
 *  project, exercising `enumerateRefEdges` + `buildRefGraph` against actual scene/
 *  prefab/texture files on disk.
 *
 *  The test that matters is the derived-sprite edge: `v7b-king.png`'s own guid
 *  appears in NO file — only the auto-emitted whole-image sprite guid
 *  (`deriveGuid('sprite:' + textureGuid)`) does, on `tray-badge.prefab.json`'s Coin
 *  entity. This is the exact bug #284 exists to catch (see the header comments in
 *  `assetRefGraph.ts` and `asset-tree-shaker.ts`): every icon in `games/court` once
 *  read as unreferenced because an ad-hoc search for the texture's own guid found
 *  nothing. Assertions here are about the MECHANISM (an implicit edge is found, and
 *  it's tagged `derived-sprite`), not exact counts — Court's art will churn. */

import { describe, it, expect } from 'vitest';
import path from 'path';
import { enumerateRefEdges } from '../../plugins/asset-tree-shaker';
import { buildRefGraph, resolveTarget, findReferences } from '../../plugins/assetRefGraph';
import type { AssetRoot } from '../../plugins/vite-asset-scanner';
import { deriveGuid } from '../../packages/modoki/src/runtime/core/assetRefRules';
import { readMetaSidecar } from '../../plugins/meta-sidecar';
import { hasInternalGames } from '../helpers/repoLayout';

/** Gated on `hasInternalGames()`: this suite reads REAL files out of `games/court`, and the
 *  public engine snapshot (lsgmasa33/modoki-engine) ships no `games/` at all — it ships two
 *  demos, so the loose `hasAnyProject()` would read TRUE and the suite would FAIL there
 *  rather than skip. That is exactly what happened: it went red on `ci/main` for the
 *  `506981512` merge with `expected undefined to be truthy` (the `.meta.json` read returns
 *  nothing when the texture is not on disk). See `engine/tests/helpers/repoLayout.ts`. */
describe.skipIf(!hasInternalGames())('assetRefGraph — games/court integration (#284)', () => {
  const repo = path.resolve(__dirname, '../..', '..');
  const projectRoot = path.join(repo, 'games/court');
  const roots: AssetRoot[] = [
    { urlPrefix: '/modoki/assets', absDir: path.join(repo, 'engine/packages/modoki/src/runtime/assets') },
    { urlPrefix: '/assets', absDir: path.join(projectRoot, 'runtime/assets') },
  ];

  function loadGraph() {
    const enumeration = enumerateRefEdges(projectRoot, roots);
    return { enumeration, graph: buildRefGraph(enumeration) };
  }

  it('finds the derived-sprite reference to v7b-king.png that a naive guid search would miss', () => {
    const texAbs = path.join(projectRoot, 'runtime/assets/textures/v7b-king.png');
    const meta = readMetaSidecar(texAbs) as { id?: string };
    const texGuid = meta.id;
    expect(texGuid).toBeTruthy();

    const { graph } = loadGraph();
    const target = resolveTarget(graph, texGuid!);
    expect(target).not.toBeNull();
    expect(target!.kind).toBe('asset');

    const result = findReferences(graph, target!);

    // THE assertion this test exists for: a naive implementation that greps the project
    // for `texGuid` finds zero hits (it never appears verbatim anywhere), and one that
    // walks refs without modeling the auto-emitted whole-image sprite guid would report
    // this texture as unreferenced. The real answer is "yes, tray-badge.prefab.json's
    // Coin entity uses it" — reachable only through the derived-sprite indirection.
    expect(result.unreferenced).toBe(false);

    const derivedHit = result.direct.find(h => h.chain[0]?.origin === 'derived-sprite');
    expect(derivedHit).toBeTruthy();
    // The referrer is the prefab FILE (Coin has no guid of its own, so it can't be an
    // addressable node — see the `fromEntity` doc comment in assetRefGraph.ts).
    expect(derivedHit!.from.name).toBe('tray-badge.prefab.json');
    expect(derivedHit!.from.kind).toBe('asset');
    // The entity-source annotation survives: the report says WHICH entity in the file
    // carried the ref, even though that entity itself isn't addressable.
    expect(derivedHit!.chain[0]!.fromEntity).toBe('Coin');
    // The authored value (the derived guid) is surfaced too — it differs from the
    // target's own guid, which is exactly what makes it an implicit edge worth showing.
    expect(derivedHit!.chain[0]!.raw).toBe(deriveGuid('sprite:' + texGuid!));

    // At least one hit anywhere in the project carries a fromEntity annotation — the
    // general form of the assertion above, not specific to this one texture.
    expect(result.direct.some(h => h.chain[0]?.fromEntity)).toBe(true);
  });

  it('resolves the derived sprite guid to the SAME node as the texture\'s own guid', () => {
    const texAbs = path.join(projectRoot, 'runtime/assets/textures/v7b-king.png');
    const meta = readMetaSidecar(texAbs) as { id?: string };
    const texGuid = meta.id!;

    const { graph } = loadGraph();
    const byOwnGuid = resolveTarget(graph, texGuid);
    const bySpriteGuid = resolveTarget(graph, deriveGuid('sprite:' + texGuid));

    expect(byOwnGuid).not.toBeNull();
    expect(bySpriteGuid).not.toBeNull();
    expect(bySpriteGuid!.id).toBe(byOwnGuid!.id);
  });
});
