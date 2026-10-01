/** Open Project's order of work, and the gate that keeps a switching editor's writes in the project they came from
 *  (#1976). Pure and Electron-free, so the order is testable (`engine/tests/electron/projectSwitch.test.ts`); main.ts
 *  supplies the steps.
 *
 *  The backend's context reads the open project LIVE (`state.root`, `state.backend`), and the old project's window stays
 *  open and interactive until the reload. Its requests carry no project identity (the instance token is the MCP's), and
 *  a scene save is unconditional. So whatever project the backend is rooted at when a save ARRIVES is where it lands.
 *  Two rules follow:
 *  1. **Re-root only once the new project is ready**, after its install and dev server, right before the reload.
 *     main.ts used to re-root first, so for the whole install (seconds; an npm install can take minutes) a Cmd+S in the
 *     old window overwrote the NEW project's file at the same path. On a failed install or dev server the editor also
 *     stayed rooted at the new project while still showing the old one, so every later save went to the other project.
 *     Now a failed switch never re-roots, and the old window keeps working on its own project.
 *  2. **Between the re-root and the reload's commit, refuse writes** (503, `switching: true`). That span is short (the
 *     re-root's awaits plus the navigation), but a write from the old window that arrives in it would land in the new
 *     project, and nothing else can tell the two windows apart.
 *
 *  Unity has no such window: Open Project closes the editor before the other project opens. */

/** What `refusal` answers while a switch is in flight. */
export interface SwitchRefusal {
  status: 503;
  body: { ok: false; switching: true; reason: 'project-switching'; error: string };
}

export interface SwitchGate {
  /** Refuse writes from now on. Opens again after `maxMs` even if nothing calls `open`, so a switch that never reaches
   *  its reload (a navigation that never commits) cannot wedge the editor read-only. `null`: no timeout and `open()`
   *  cannot lift it, for a re-root that failed half way, where a write could land in either project; only a later
   *  `close` (another open, which re-roots consistently) or a relaunch does. */
  close(reason: string, maxMs?: number | null): void;
  open(): void;
  isClosed(): boolean;
  /** The refusal for this request while closed, or null. Reads (GET/HEAD/OPTIONS) pass, and so does `/api/open-project`:
   *  a newer open must still be able to supersede this one (#1160). */
  refusal(method: string, urlPath: string): SwitchRefusal | null;
}

/** Long enough for a re-root and a reload's commit on a slow machine, short enough that a stuck gate recovers. */
export const SWITCH_GATE_MAX_MS = 30_000;

const PASSES = new Set(['GET', 'HEAD', 'OPTIONS']);
/** Writes the gate lets through: only a newer open, which must still be able to supersede this one (#1160). Not a
 *  route table — this module serves nothing (routeCoverage.test.ts lists the files that do). */
const PASS_PATHS = new Set(['/api/open-project']);

export function createSwitchGate(): SwitchGate {
  let reason: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** A `close(…, null)`: only a NEW `close` (a later open, which re-roots consistently) may lift it, never `open()` —
   *  a reload commit that arrives afterwards (the old window's Vite client reloading itself) is not a relaunch. */
  let sticky = false;
  const reset = () => {
    reason = null;
    sticky = false;
    if (timer) { clearTimeout(timer); timer = null; }
  };
  const open = () => { if (!sticky) reset(); };
  return {
    close(why, maxMs = SWITCH_GATE_MAX_MS) {
      reset();
      reason = why;
      if (maxMs === null) { sticky = true; return; }
      timer = setTimeout(open, maxMs);
      timer.unref?.();
    },
    open,
    isClosed: () => reason !== null,
    refusal(method, urlPath) {
      if (reason === null || PASSES.has(method.toUpperCase()) || PASS_PATHS.has(urlPath)) return null;
      return {
        status: 503,
        body: {
          ok: false, switching: true, reason: 'project-switching',
          error: `The editor is switching project (${reason}), so this request was refused and did nothing: a write now `
            + 'could land in the other project. Retry once the new project has loaded.',
        },
      };
    },
  };
}

export type SwitchOutcome =
  | { kind: 'reRooted' }
  | { kind: 'superseded'; pairError?: unknown }
  | { kind: 'failed'; error: unknown; pairError?: unknown; reRootFailed?: true };

/** The order of an open: prepare the new project, then (still current) close the gate and re-root.
 *  - `prepare` installs and starts the dev server. It resolves false when a newer open replaced this one while it
 *    waited, and throws when it fails. Nothing is re-rooted until it succeeds.
 *  - `pairBack` runs when an open ends WITHOUT re-rooting (failed or superseded). `prepare` may already have moved the
 *    dev server to the new project (a Vite that times out stays up, and comes ready seconds later), and the old
 *    window's Vite client reloads itself once a server answers. That would mount the NEW project's code over the OLD
 *    project's backend. So `pairBack` puts the dev server back on the root the backend serves. Its failure is
 *    reported, not thrown.
 *  - `reRoot` moves the backend to the new project. The gate is closed BEFORE it starts, because its own awaits are part
 *    of the window. If it throws, the backend may be half moved, so the gate stays closed with no timeout and `open()`
 *    cannot lift it: every write is refused until a relaunch or another open.
 *  The caller reloads the window after `reRooted`, and opens the gate once that navigation commits. */
export async function prepareThenReRoot(steps: {
  gate: SwitchGate;
  reason: string;
  isCurrent(): boolean;
  prepare(): Promise<boolean>;
  pairBack(): Promise<void>;
  reRoot(): Promise<void>;
}): Promise<SwitchOutcome> {
  const pairBack = async (): Promise<{ pairError?: unknown }> => {
    try { await steps.pairBack(); return {}; } catch (pairError) { return { pairError }; }
  };
  let prepared: boolean;
  try {
    prepared = await steps.prepare();
  } catch (error) {
    return { kind: 'failed', error, ...(await pairBack()) };
  }
  if (!prepared || !steps.isCurrent()) return { kind: 'superseded', ...(await pairBack()) };
  steps.gate.close(steps.reason);
  try {
    await steps.reRoot();
  } catch (error) {
    steps.gate.close(`a project switch failed part way (${String(error instanceof Error ? error.message : error)}); relaunch the editor`, null);
    return { kind: 'failed', error, reRootFailed: true };
  }
  return { kind: 'reRooted' };
}
