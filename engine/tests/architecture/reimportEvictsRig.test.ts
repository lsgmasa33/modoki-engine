/**
 * A re-import evicts BOTH caches a GLB can occupy, at EVERY entry point (#1366).
 *
 * Evicting a re-imported GLB takes two calls — `invalidateModel` for the static mesh templates and
 * `invalidateRiggedModel` for the skinned prototype — and for months only ONE of the four entry
 * points made both:
 *
 *   - `editor/scene/modelImport.ts` (drag a file in)              — correct
 *   - `editor/panels/assetViews/reimport.ts` (Assets-panel batch) — `invalidateModel` alone
 *   - `app/debug/agentBridge.ts` (`invalidate-assets`, MCP/curl)  — `invalidateModel` alone
 *   - `editor/panels/assetViews/ModelAssetView.tsx` (Re-import)   — `invalidateModel` alone
 *
 * So a re-imported SKINNED GLB kept its pre-import skeleton, bind pose and clip set for the
 * session — and its live clones WERE evicted and rebuilt, from the stale prototype, so the
 * viewport visibly re-seated the mesh and the re-import looked like it had worked.
 *
 * ⚠️ **Why a guard and not four more behavioural tests.** The behaviour is one mechanism and is
 * pinned once, in `riggedModelCache.test.ts` ("invalidateModelAndRig evicts the rigged
 * prototype"). What four near-duplicate cases could not do is stop a FIFTH entry point being
 * added next year with the same half-recipe — which is exactly how this defect grew from one call
 * site to three. This guard encodes the invariant instead: outside the modules that own the pair,
 * nobody composes it by hand.
 *
 * ⚠️ It is deliberately NOT satisfied by `invalidatorsAreReachable.test.ts`, whose allowlist once
 * vouched for `invalidateRiggedModel` on the strength of its single caller. That guard asks "does
 * anything call this?"; this one asks "does everything that should, call it the same way?".
 */

import { describe, it } from 'vitest';
import path from 'node:path';
import { repoFiles } from '../../scripts/repoCorpus.mjs';
import { readScannedSource } from '@modoki/engine/testing';
import { assertExemptionLedger } from '@modoki/engine/testing/exemptionLedger';
import { parseSource, ts } from '@modoki/engine/testing/sourceAst';

/** Where a re-import can be triggered from. */
const SCAN_UNDER = [
  'engine/app',
  'engine/packages/modoki/src/editor',
  'engine/packages/modoki/src/runtime',
];

/** The references that OWN the pair, pardoned at `file::token` grain and COUNTED.
 *
 *  `reimportInvalidation.ts` composes the two into `invalidateModelAndRig`. `meshTemplateCache.ts`
 *  names `invalidateModel` on its RELEASE paths (`releaseModelByPath` and the two post-await
 *  acquire guards), which run because the last OWNER let go — a refcounted release, deliberately
 *  not a re-import, and the reason the pair is not simply folded into `invalidateModel`.
 *
 *  ⚠️ **Token grain, not file grain, and the difference is load-bearing.** Sanctioning the FILE
 *  pardons every occurrence that file will ever contain (`exemptionLedger`'s own docblock says so —
 *  the #1123 defect). Measured during this change's close-out review: with a file-grained sanction,
 *  adding `invalidateRiggedModel(modelPath)` as the first line of `invalidateModel` — the precise
 *  fold `reimportInvalidation.ts` bans in bold, which would make every refcounted RELEASE dispose a
 *  rigged prototype another scene still owns — left this guard GREEN. At token grain
 *  `meshTemplateCache.ts::invalidateRiggedModel` has no row at all, so that fold is an offender.
 *
 *  ⚠️ `riggedModelCache.ts::invalidateRiggedModel` is NOT here: it DEFINES the function but never
 *  references it otherwise, and an exempt row matching nothing is a claim with no subject — the
 *  ledger fails it as stale.
 *
 *  ⚠️ **COUNTED rows, not `sanctioned`, and that is the third grain this guard has needed.**
 *  `sanctioned` is an uncounted `includes(item)`, so at token grain it still pardoned every
 *  occurrence of that token the file will ever contain. Measured: appending a fourth
 *  `invalidateModel` call to `meshTemplateCache.ts` — a per-entity / streaming-LOD unload, which
 *  CLAUDE.md § Resource Management and that module's own INVARIANT comment both anticipate someone
 *  writing — left this guard GREEN, with the rigged prototype unevicted. That is #1366's shape
 *  arriving through the pardon itself. `count` makes the row spend per occurrence, so a FOURTH site
 *  is an offender and a DELETED one is a stale row: over- and under-blessing both fail. */
const OWNERS: ReadonlyArray<{ item: string; count: number; reason: string }> = [
  {
    item: 'engine/packages/modoki/src/runtime/loaders/reimportInvalidation.ts::invalidateModel',
    count: 2, // the import, and the call inside `invalidateModelAndRig`
    reason: 'the module that composes the pair — this IS the one sanctioned recipe',
  },
  {
    item: 'engine/packages/modoki/src/runtime/loaders/reimportInvalidation.ts::invalidateRiggedModel',
    count: 2, // the import, and the call inside `invalidateModelAndRig`
    reason: 'the module that composes the pair — this IS the one sanctioned recipe',
  },
  {
    item: 'engine/packages/modoki/src/runtime/loaders/meshTemplateCache.ts::invalidateModel',
    count: 3,
    reason: 'the three refcounted RELEASE sites — releaseModelByPath, and the post-await guards in '
      + 'acquireModel and acquireMesh. A release runs because the last OWNER let go, not because '
      + 'bytes changed, so it must NOT evict the rigged prototype (riggedModelCache tracks its own '
      + 'owners). A FOURTH occurrence is a new evict site and must justify itself here.',
  },
];

const HALVES = new Set(['invalidateModel', 'invalidateRiggedModel']);

/** Every REFERENCE to `invalidateModel` / `invalidateRiggedModel` in `sf`, by name.
 *
 *  ⚠️ **A reference, NOT a call — and that distinction is the whole guard.** This detector
 *  originally matched `ts.isCallExpression`, and was therefore blind to the shape #1366 ACTUALLY
 *  SHIPPED IN: `agentBridge.ts` never called `invalidateModel`, it named it as a TABLE VALUE
 *  (`const INVALIDATORS = { model: invalidateModel, … }`), which is a property assignment. Measured
 *  during this change's close-out review: reverting `agentBridge.ts` to its exact pre-fix form left
 *  this guard, `invalidateAssetsOp` and `invalidatorsAreReachable` all green — the guard could not
 *  see the defect at the entry point it originated at. Matching references also covers an aliased
 *  import (`import { invalidateModel as evict }`), a namespace/method call
 *  (`cache.invalidateModel(p)`) and a `const f = invalidateModel` handoff, none of which the
 *  call-only form saw.
 *
 *  Two exclusions, both narrow:
 *  - an `export … from` re-export, which is `runtime/index.ts`'s barrel passing the name through
 *    rather than composing anything;
 *  - a function DECLARATION's own name, so the cache that defines a half is not an offender for
 *    defining it. */
function halfRefs(sf: ts.SourceFile): string[] {
  const found: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isExportDeclaration(n)) return; // barrel re-export: not a composition
    if (ts.isFunctionDeclaration(n) && n.name && HALVES.has(n.name.text)) {
      // Skip the name, walk the body — a self-call inside it still counts.
      if (n.body) visit(n.body);
      return;
    }
    if (ts.isIdentifier(n) && HALVES.has(n.text)) found.push(n.text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

describe('a re-import evicts the rigged prototype at every entry point (#1366)', () => {
  const files = repoFiles({ under: SCAN_UNDER, match: /\.tsx?$/, floor: 200 });

  it('every hand-composed half-reference is either an owner or an offender', () => {
    const population: Array<{ item: string; site: string }> = [];
    for (const f of files) {
      const rel = f.rel ?? path.relative(process.cwd(), f.abs);
      const sf = parseSource(readScannedSource(f.abs).code, path.basename(f.abs));
      for (const name of halfRefs(sf)) population.push({ item: `${rel}::${name}`, site: `${rel}: ${name}` });
    }

    assertExemptionLedger({
      label: 'hand-composed re-import eviction in reimportEvictsRig',
      population,
      exempt: OWNERS,
      scanned: files.length,
      floor: 200,
      fix: 'This calls a HALF of the re-import eviction directly. A re-import must go through '
        + '`invalidateModelAndRig` (or `REIMPORT_INVALIDATORS`) in '
        + 'runtime/loaders/reimportInvalidation.ts, so the rigged prototype is never the half that '
        + 'gets forgotten (#1366). If it is a refcounted RELEASE rather than a re-import, it belongs '
        + 'in the cache module that owns the refcount, not here.',
    });
  });
});
