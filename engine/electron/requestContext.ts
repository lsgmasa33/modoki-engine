/** A backend request's context, bound to the project it ARRIVED in (#1991). Pure and Electron-free, so the binding is
 *  testable (`engine/tests/electron/requestContext.test.ts`); main.ts hands `backendServer` a factory that calls it once
 *  per request.
 *
 *  main's live context reads `state.root` / `state.backend` on every call, so that Open Project can rebind the running
 *  server without restarting it. That is right for a request arriving after the switch, and wrong for one already
 *  RUNNING when it happens. The switch gate (`projectSwitch.ts`) only stops new requests. A recursive folder reimport
 *  that started in A and awaits between files would resolve its next file against B's asset roots, at the same URLs,
 *  while it thinks it is still working on A. So:
 *  - the plain values (`projectRoot`) are read ONCE, at arrival;
 *  - each member that reaches the project's files or its asset backend throws {@link ProjectSwitchedError} once the
 *    backend has been replaced. The request stops where it is, and nothing lands in the other project;
 *  - the bookkeeping a route runs AFTER its write has landed ({@link AFTER_WRITE_MEMBERS}) does nothing instead: the
 *    write is in the old project already, and throwing there turned a landed write into a "retry it" 500 that would
 *    have written it again into the new one.
 *  A stop is RECORDED on the context ({@link stoppedBySwitch}), so the server answers it as the switch's 503 even when
 *  the route's own catch-all turned the throw into a generic 500.
 *
 *  Waiting for in-flight requests to drain before the re-root was the alternative, and it was rejected: the agent's own
 *  `POST /api/open-project` is in flight for the whole open, and so is a `wait-for` long poll, so a drain would wait on
 *  the request driving the switch. */

import type { BackendContext } from '../plugins/backend/editorBackendRouter';

/** Thrown by a bound member once the project it arrived in is gone. `backendServer` answers the request 503,
 *  `switching: true`, the same as the switch gate's refusal, whether or not a route caught it on the way. */
export class ProjectSwitchedError extends Error {
  readonly switching = true;
  readonly arrivedIn: string;
  constructor(arrivedIn: string) {
    super(`The editor switched project away from ${arrivedIn} while this request was running, so it stopped rather than `
      + `act on the project now open. Anything it finished before the switch landed in ${arrivedIn}.`);
    this.name = 'ProjectSwitchedError';
    this.arrivedIn = arrivedIn;
  }
}

/** The members that reach the project's files or its asset backend. A member not listed (the renderer relay, the
 *  schema, the project switch itself) answers about the editor, not a project, and must keep working during a switch:
 *  the agent's `open-project` call reads `projectSwitch` across its own re-root. */
export const PROJECT_BOUND_MEMBERS = [
  'resolveAssetPath', 'absToAssetUrl', 'firstRootDir', 'getManifest', 'rebuildManifest', 'computeUnused',
  'computeRefEdges', 'ssrLoadModule',
] as const satisfies readonly (keyof BackendContext)[];

/** Bookkeeping that follows a write that has already landed: the old backend's self-write fingerprint, and the old
 *  Vite's config invalidation. After a switch both belong to a project that is no longer open, so they do nothing. */
export const AFTER_WRITE_MEMBERS = ['markEditorWrite', 'invalidateProjectConfig'] as const satisfies readonly (keyof BackendContext)[];

const stops = new WeakMap<BackendContext, ProjectSwitchedError>();

/** The stop a bound member raised during this request, or null. Read by `backendServer` once the route has answered. */
export function stoppedBySwitch(ctx: BackendContext): ProjectSwitchedError | null {
  return stops.get(ctx) ?? null;
}

/** `live` as it is NOW, with each {@link PROJECT_BOUND_MEMBERS} member refusing once `isCurrent()` is false. The check
 *  and the call are one synchronous step, so no switch can fall between them. */
export function bindToArrival(live: BackendContext, isCurrent: () => boolean): BackendContext {
  const bound: BackendContext = { ...live }; // evaluates the getters: `projectRoot` as it is at arrival
  const arrivedIn = bound.projectRoot;
  const slots = bound as unknown as Record<string, unknown>;
  for (const name of PROJECT_BOUND_MEMBERS) {
    const fn = slots[name];
    if (typeof fn !== 'function') continue;
    slots[name] = (...args: unknown[]) => {
      if (!isCurrent()) {
        const stop = stops.get(bound) ?? new ProjectSwitchedError(arrivedIn);
        stops.set(bound, stop);
        throw stop;
      }
      return (fn as (...a: unknown[]) => unknown)(...args);
    };
  }
  for (const name of AFTER_WRITE_MEMBERS) {
    const fn = slots[name];
    if (typeof fn !== 'function') continue;
    slots[name] = (...args: unknown[]) => (isCurrent() ? (fn as (...a: unknown[]) => unknown)(...args) : undefined);
  }
  return bound;
}
