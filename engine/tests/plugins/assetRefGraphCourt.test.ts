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
import { computeKeptAssets, enumerateRefEdges } from '../../plugins/asset-tree-shaker';
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

/** The reverse index carries a SECOND implementation of reachability.
 *
 *  `computeKeptAssets` already computes it — that IS its keep-set, and it is the one
 *  the production build ships by. `computeReachable` in `assetRefGraph.ts` re-derives
 *  it from the edge list, because `enumerateRefEdges` seeds every walkable file
 *  (`seedAllWalkable`) to see orphans' outbound edges, which makes that run's keep-set
 *  useless as a reachability answer.
 *
 *  That is a defensible reason for the second walk and NOT a reason to trust it. Two
 *  implementations of one question drift, and this pair drifts silently: `reachable`
 *  is what tells a human whether a reference survives the build, so a disagreement
 *  shows up as a reference quietly labelled dead (or alive) and nothing else.
 *
 *  Measured at the time of writing, they agree EXACTLY — 1168/1168 paths on Court,
 *  and zero disagreement in either direction across court / 3d-test / forest-camp /
 *  sling / particle-demo. This test is what keeps that true. Run over several real
 *  projects rather than a fixture on purpose: the shapes that could diverge (a
 *  keep-listed prefab, font-family resolution, a shader's sibling .wgsl, atlas
 *  redirection) exist in committed content and not in anything hand-built. */
/*  Gated for the same reason the suite above is: all three projects it sweeps are absent
 *  from the public engine snapshot — it ships no `games/` at all, and of `demos/` only
 *  `3d-physics-demo` + `2d-physics-demo` (see `--with-demos=` in
 *  `.github/workflows/oss-ci-snapshot.yml`), never `forest-camp`. Ungated, every case
 *  fails there on `expect(kept.size).toBeGreaterThan(0)` against a project that is not
 *  on disk. */
describe.skipIf(!hasInternalGames())('assetRefGraph — reachability agrees with the shake keep-set (#284)', () => {
  const repo = path.resolve(__dirname, '../..', '..');

  for (const rel of ['games/court', 'games/sling', 'demos/forest-camp']) {
    it(`${rel}: graph.reachable equals computeKeptAssets().kept`, () => {
      const projectRoot = path.join(repo, rel);
      const roots: AssetRoot[] = [
        { urlPrefix: '/modoki/assets', absDir: path.join(repo, 'engine/packages/modoki/src/runtime/assets') },
        { urlPrefix: '/assets', absDir: path.join(projectRoot, 'runtime/assets') },
      ];

      // NFC on both sides: macOS readdir can hand back NFD while the walker queues
      // NFC-form paths out of JSON refs, and the shake normalizes for the same reason.
      const kept = new Set([...computeKeptAssets(projectRoot, roots).kept].map(p => p.normalize('NFC')));
      const enumeration = enumerateRefEdges(projectRoot, roots);
      const graph = buildRefGraph(enumeration);
      // Only the asset half is comparable — entity nodes have no keep-set counterpart.
      const reachable = new Set(
        [...graph.reachable].filter(id => id.startsWith('asset:')).map(id => id.slice('asset:'.length).normalize('NFC')),
      );

      expect(kept.size).toBeGreaterThan(0);
      // Named difference lists, not a bare size compare: when this fails the reader
      // needs to know WHICH paths disagree and in which direction.
      expect([...kept].filter(p => !reachable.has(p))).toEqual([]);
      expect([...reachable].filter(p => !kept.has(p))).toEqual([]);
    });
  }
});
