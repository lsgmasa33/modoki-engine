/** The two questions a prefab write asks the scene-adoption owner (#1692, #1698), without importing it.
 *
 *  `commitPrefabWrites` must not start while an editor route is between its world call and its adopt, and must not
 *  rebuild frames in a world a route is still adopting. Those answers live in `sceneAdoption.ts`, whose imports reach
 *  most of the editor — and `./prefab` imports the commit, so a direct import closes a load-time cycle, and every unit
 *  test that hand-lists a runtime mock breaks on each export the owner's graph needs. So the owner INSTALLS its answers
 *  here when it loads (`installAdoptionGate`, at the bottom of sceneAdoption.ts), and the commit reads them.
 *
 *  ⚠️ A registration seam: with the owner never loaded there are no routes, so nothing to wait for — the editor always
 *  loads it (`serialize.ts` imports it), and `prefabCommit.test.ts` loads it to drive the gate. */

export interface AdoptionGate {
  /** `sceneAdoption.adoptionsSettled`: a promise while any route is mid-adoption (or a leave repair runs), else null. */
  settled(): Promise<void> | null;
  /** How many routes are between their world call and their adopt now. */
  pending(): number;
}

let gate: AdoptionGate | null = null;

/** Called once by `sceneAdoption.ts` at load. */
export function installAdoptionGate(g: AdoptionGate): void { gate = g; }

/** See {@link AdoptionGate.settled}; null when no owner is loaded. */
export function adoptionsSettledGate(): Promise<void> | null { return gate ? gate.settled() : null; }

/** See {@link AdoptionGate.pending}; 0 when no owner is loaded. */
export function pendingAdoptionCount(): number { return gate ? gate.pending() : 0; }
