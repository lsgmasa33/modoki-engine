/** A placement refused because the prefab was written while it was being read (#1752): the copy in hand is older than
 *  the file, so nothing was spawned. Thrown by `instantiatePrefabInstance` when its read token (`capturePrefabRead`,
 *  `prefabRead.ts`) moved; every caller turns it into a message the user or the agent reads (`placePrefabFromPath`, the
 *  instantiate undo step, the agent op).
 *
 *  ⚠️ A module with NO imports, on purpose: the instantiate undo step (`prefabInstantiateUndo.ts`) recognises it, and
 *  reaching it through `prefabRead.ts` pulled the manifest and runtime prefab cache into the undo layer — past the
 *  partial `world` mock of a suite that imports that step, which then failed to load (`onWorldSwap` missing). */
export class StalePrefabRead extends Error {
  readonly prefabName: string;
  constructor(prefabName: string) {
    super(`"${prefabName}" was changed on disk while it was being placed, so nothing was added — place it again to use the new version.`);
    this.name = 'StalePrefabRead';
    this.prefabName = prefabName;
  }
}
