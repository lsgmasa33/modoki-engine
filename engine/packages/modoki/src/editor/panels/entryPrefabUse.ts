/** entryPrefabUse — "is this prefab used as a UIEntries entry kind?" (#671, editor half).
 *
 *  `entriesSystem` pins 14 `UIElement` fields onto every pooled `UIEntries` row root each tick
 *  (`buildPooledRowPin` in `runtime/ui/uiAuthoring.ts`), so those authored fields on the row's
 *  root are inert. The Inspector already carries a `PooledRowNote` for this — but it gates on the
 *  live sibling `UIEntry` trait, stamped at spawn and `runtimeOnly`, so it exists in no
 *  `.prefab.json`. Open the entry prefab itself (the asset you actually author in, via prefab-edit
 *  mode) and there is no signal at all. This module answers the question prefab-edit mode needs:
 *  which `UIEntries` views (and in which scenes) spawn THIS prefab guid as an entry kind.
 *
 *  Modeled on `textureRefCount` in `./makeTexture2D.ts` — read that first. Same shape: one
 *  `/api/find-references` call, `null` on any failure, and the pure filter/map kept separate from
 *  the fetch so it is unit-testable without a network.
 *
 *  ⚠️ **KNOWN LIMITATION, not a bug to fix**: `/api/find-references` reads the reference graph off
 *  DISK, not the live in-memory world. That is acceptable here because `openPrefabForEditing` saves
 *  the outgoing scene BEFORE swapping into the prefab-edit world (`prefabEdit.ts`'s
 *  `openPrefabForEditing`, around the `saveScene()` call), so disk is current by the time this
 *  fires — and the note this backs is advisory, never a gate. Do not "fix" this into a live-world
 *  walk; that would be solving a problem that does not exist here at real cost (a live walk has no
 *  existing implementation to reuse — `/api/find-references` does).
 *
 *  ⚠️ **SECOND KNOWN LIMITATION: this can OVER-report on a multi-kind bank.**
 *  `entriesSystem.ts`'s `driveView` only ever reads `kinds[0]` — `prefabRootSize`, `ensurePool` and
 *  `applySlots` all index the parsed bank at `[0]`, so a bank's kinds `[1..]` are parsed but never
 *  actually spawned as a pooled row (`loaders/sceneValidation.ts`'s `collectEntryKindUses` mirrors
 *  this and only emits a use for kind `[0]`, for the same reason). `/api/find-references` has no
 *  notion of WHICH array index a `UIEntries.prefabs[].prefab` hit came from, so this module (and
 *  the Inspector note it feeds) reports a use for every kind equally — a prefab that is only kind
 *  `[1]` of a two-kind bank would show the "pooled row" note even though the runtime never pins it.
 *  Latent today: every committed bank has exactly one kind, so this has never actually
 *  over-reported — but it is a real limitation, not a guarantee. */

import { backendFetch } from '../backend/editorBackend';
import type { FindReferencesResultLike } from './findReferencesFormat';

/** One `UIEntries` view that spawns a given prefab guid as an entry kind. */
export interface EntryKindUseHit {
  /** Virtual path of the scene/prefab file the `UIEntries` view is authored in. */
  scenePath: string;
  /** Display name of the view entity (or `EntityName@file` when it has no guid of its own). */
  viewName: string;
}

/** Pure filter/map over a `find-references` response body: keep only the DIRECT hits whose chain
 *  points at the target via `UIEntries.prefabs[].prefab` — the exact `via` label
 *  `asset-tree-shaker.ts`'s `pushRef(state, 'asset', ref, { ...referencedBy, trait: 'UIEntries' },
 *  'prefabs[].prefab')` emits for this edge. Any other `via` (a `PrefabInstance.source`, a nested
 *  prefab reference, …) is a real reference but not an entry-kind USE, and an indirect hit (hops >
 *  1, i.e. never in `direct`) means something ELSE references the entry kind's referrer rather than
 *  this prefab being spawned as a kind directly — neither belongs in the result.
 *
 *  No network, no `.tsx` — pure so it can be tested against fixture bodies without mounting the
 *  panel or reaching a backend. */
export function entryKindHitsFrom(body: FindReferencesResultLike): EntryKindUseHit[] {
  const direct = Array.isArray(body?.direct) ? body.direct : [];
  const out: EntryKindUseHit[] = [];
  for (const hit of direct) {
    const step = hit?.chain?.[0];
    if (!step || step.via !== 'UIEntries.prefabs[].prefab') continue;
    out.push({
      scenePath: step.node.path,
      viewName: step.fromEntity ? `${step.fromEntity}@${step.node.name}` : step.node.name,
    });
  }
  return out;
}

/** Which `UIEntries` views use `prefabGuid` as an entry kind, or `null` when the answer is unknown
 *  (endpoint missing, network error, malformed body).
 *
 *  `null` is deliberately distinct from `[]` — same rule `textureRefCount` states: "unused"
 *  (here, "not an entry kind") is a claim strong enough to change what the Inspector tells the
 *  author, and a failed lookup must not be able to make it. The caller (Inspector) shows nothing
 *  on `null` rather than asserting a negative on no evidence. */
export async function entryKindUsesOf(prefabGuid: string): Promise<EntryKindUseHit[] | null> {
  try {
    const res = await backendFetch(`/api/find-references?target=${encodeURIComponent(prefabGuid)}`);
    const body = (await res.json()) as (Partial<FindReferencesResultLike> & { error?: string }) | null;
    if (!res.ok || !body || typeof body !== 'object' || body.error) return null;
    return entryKindHitsFrom(body as FindReferencesResultLike);
  } catch {
    return null;
  }
}
