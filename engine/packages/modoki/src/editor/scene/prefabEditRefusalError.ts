/** The thrown form of the prefab-edit refusal (#1817, #1836) and its vocabulary. The predicate that decides it is
 *  `prefabEditRefusal.ts`.
 *
 *  ⚠️ A module with NO imports, on purpose, as `stalePrefabRead.ts` is: the instantiate undo step
 *  (`prefabInstantiateUndo.ts`) recognises the error, and reaching it through `prefabEditRefusal.ts` pulled
 *  `SceneManager` into the undo layer, past the partial `world` mock of a suite that imports that step, which then
 *  failed to load (`onWorldSwap` missing). */

export type PrefabEditRefusalReason = 'root-removed' | 'root-moved' | 'outside-root' | 'self-nesting' | 'scaffold' | 'under-missing-prefab';

export interface PrefabEditRefusal {
  reason: PrefabEditRefusalReason;
  /** The editor's words, for a toast and an agent's refusal alike. */
  text: string;
}

/** Thrown by a choke point whose return value cannot carry a refusal (a placement, a create, a paste, a duplicate, a
 *  delete). Classified by CLASS: the Hierarchy and the other panels toast its message (`prefabEditRefusalToast.ts`), and
 *  every editor agent op answers it as `REFUSED_BY_OP` (`registerEditorAgentOps`). */
export class PrefabEditRefusalError extends Error {
  readonly reason: PrefabEditRefusalReason;
  constructor(refusal: PrefabEditRefusal) {
    super(refusal.text);
    this.name = 'PrefabEditRefusalError';
    this.reason = refusal.reason;
  }
}
