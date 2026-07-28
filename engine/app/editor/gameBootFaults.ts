/** Faults raised by the OPEN PROJECT's own game code while the editor booted.
 *
 *  Its own module (rather than living in `editor/setup.ts`) so `agentEditorOps.ts` can read
 *  it without an import cycle — setup.ts already imports agentEditorOps.
 *
 *  ── Why this exists ──────────────────────────────────────────────────────────────────────
 *  `editor/setup.ts` used to `await g.registerSystems()` unguarded while booting. A single
 *  throw inside a game module — a typo mid-edit, a bad import, a stale reference after a
 *  hot-reload — rejected `createGameEditor()`. The editor route is a bare `React.lazy` +
 *  `Suspense`, so the whole UI simply never mounted: a BLANK window, no frame driver (hence
 *  `fps: 0` while `playState` still read "playing"), and `registerEditorAgentOps()` never
 *  reached — which is why the agent bridge then answered `unknown agent op 'editor-state'`
 *  and a screenshot of the empty compositor failed. All of it silent.
 *
 *  Booting anyway is the right call, not mere robustness: the editor is the tool you use to
 *  FIX broken game code, so game code is precisely the thing it must not die on. The project
 *  loads degraded (its systems aren't registered) and says so — on screen, in the console,
 *  and as data in `modoki_get_editor_state.gameBootFaults`. */

export interface GameBootFault {
  gameId: string;
  /** Which hook threw — `loadConfig`, `registerPostprocessors`, `registerSystems`, … */
  phase: string;
  message: string;
}

const faults: GameBootFault[] = [];

/** Record a game-code boot fault. */
export function addGameBootFault(fault: GameBootFault): void {
  faults.push(fault);
}

/** Game-code faults collected during editor boot (empty when the project booted clean). */
export function getGameBootFaults(): readonly GameBootFault[] {
  return faults;
}

/** A one-line human summary, or null when the project booted clean. */
export function describeGameBootFaults(): string | null {
  if (faults.length === 0) return null;
  return faults.map((f) => `${f.gameId}.${f.phase}(): ${f.message}`).join(' | ');
}
