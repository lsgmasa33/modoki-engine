/** Pure formatting helpers for the "Find References" dialog (#284). Extracted from
 *  FindReferencesDialog.tsx so the chain-rendering logic is unit-testable without
 *  mounting the panel (CLAUDE.md: editor `.tsx` isn't expected to carry unit tests;
 *  its plain-`.ts` logic is).
 *
 *  These types are a MIRROR of the JSON shape `GET /api/find-references` returns
 *  (`FindReferencesResponse` in `engine/plugins/assetRefGraph.ts`), not an import of
 *  it — that module reaches the tree-shaker's filesystem walk, which has no place in
 *  the browser bundle.
 *
 *  ⚠️ A mirror drifts. This one does NOT drift silently:
 *  `engine/tests/plugins/findReferencesWireShape.test.ts` asserts at COMPILE TIME that
 *  the server's response is still assignable to this shape, and it is typechecked by
 *  `npm run typecheck`. Rename or retype a field on either side and the build goes
 *  red. (Mutation-checked both ways when it was written.) So change this file freely —
 *  just do not delete that guard, which is the only thing standing between a rename
 *  and a dialog quietly rendering `undefined`. */

export type RefNodeKind = 'asset' | 'entity';

export interface RefNodeLike {
  kind: RefNodeKind;
  id: string;
  path: string;
  name: string;
  guid?: string;
}

export interface RefChainStepLike {
  node: RefNodeLike;
  fromEntity?: string;
  via: string;
  origin: string;
  raw?: string;
}

export interface RefHitLike {
  from: RefNodeLike;
  hops: number;
  chain: RefChainStepLike[];
  reachable: boolean;
}

export interface FindReferencesResultLike {
  target: RefNodeLike;
  direct: RefHitLike[];
  indirect: RefHitLike[];
  returnedCount: number;
  totalCount: number;
  truncated: boolean;
  unreferenced: boolean;
  reachable: boolean;
  warnings: string[];
  unresolvedRefsFromTarget: { via: string; guid: string }[];
}

/** Short human label for an implicit-edge origin. `'own'` is an ordinary authored
 *  ref and gets no badge (returns ''); every other origin is exactly the kind of
 *  reference a human searching by hand would never have found, so it is always
 *  surfaced. */
export function originBadge(origin: string): string {
  switch (origin) {
    case 'own': return '';
    case 'derived-sprite': return 'derived sprite';
    case 'slice': return 'slice';
    case 'atlas-member': return 'atlas member';
    case 'entity-ref': return 'entity ref';
    default: return origin;
  }
}

/** Display label for one chain step's node — `EntityName@file.prefab.json` when the
 *  referring entity has no guid of its own (`fromEntity` set, so `node` is the FILE
 *  it's authored in), otherwise just the node's own name. */
export function stepNodeLabel(step: RefChainStepLike): string {
  return step.fromEntity ? `${step.fromEntity}@${step.node.name}` : step.node.name;
}

/** Render one step as `Name [via slot]` (no arrow — `formatChain` joins steps). The
 *  origin badge is appended in brackets too when the edge is implicit, e.g.
 *  `Name [via Renderable2D.sprite, derived sprite]`. */
export function formatChainStep(step: RefChainStepLike): string {
  const badge = originBadge(step.origin);
  const via = badge ? `${step.via}, ${badge}` : step.via;
  return `${stepNodeLabel(step)} [via ${via}]`;
}

/** Full chain text for one hit: `A [via] → B [via] → target`. `chain[0]` is the
 *  outermost referrer (== `hit.from`); the last step's `via` is the slot that
 *  points directly at the target. `targetName` is appended as the final arrow-head
 *  since the target itself is never a chain step. */
export function formatChain(hit: RefHitLike, targetName: string): string {
  const steps = hit.chain.map(formatChainStep);
  return [...steps, targetName].join(' → ');
}
