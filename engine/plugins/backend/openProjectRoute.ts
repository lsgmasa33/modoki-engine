/** `POST /api/open-project` — the pieces of the agent's project switch (#1587) that need no renderer
 *  and no Electron: what a folder IS, what a relative path would have meant, and how the host's
 *  outcome becomes a §5 reply. The route itself lives in `editorBackendRouter.ts`, beside the shared
 *  unsaved-work gate it runs first. Mechanism and rationale: docs/editor.md § "Switching project from an agent — `modoki_open_project` (#1587)". */

import fs from 'fs';
import path from 'path';

/** The one test for "this folder is a Modoki project": it carries `project.config.json`. Shared with
 *  the first-run picker's `projectFolderKind` (`engine/electron/projects.ts`). */
export function isProjectFolder(dir: string): boolean {
  return fs.existsSync(path.join(dir, 'project.config.json'));
}

/** What the host did with an open it was handed. `opened` means the NEW editor document mounted,
 *  not merely that `state.root` changed (see `rendererMountWaiter.ts`). */
export type ProjectOpenOutcome =
  | { kind: 'opened'; previousRoot: string }
  /** A newer open (a human's, or another call) was requested while this one waited; that one owns
   *  the editor now. */
  | { kind: 'superseded'; by: string }
  /** The deps install or the Vite restart failed. The human path shows this as a dialog. */
  | { kind: 'failed'; detail: string }
  /** The budget ran out. The open is NOT cancelled — it keeps going in the background. */
  | { kind: 'timeout'; stage: 'preparing' | 'mounting' };

/** The Electron host's handle on its project open. Absent on the Vite dev-server host, which cannot
 *  re-root itself. */
export interface ProjectSwitchHost {
  /** Where the host's opens stand. `inFlight` is the newest open not yet settled (null when none);
   *  `opened` is the root the last SETTLED open actually opened, launch included — null after a
   *  failed open, which leaves the editor in no project's state. */
  status(): { inFlight: string | null; opened: string | null };
  /** The instance token (C6, per project) the backend expects RIGHT NOW — null when none was
   *  minted. It changes at the START of an open, not at its end. */
  expectedToken(): string | null;
  open(root: string, opts: { timeoutMs: number }): Promise<ProjectOpenOutcome>;
}

/** A request for a root the host already has, settled without opening anything: `already-open`,
 *  `in-flight` (an open of that root is still running), or `null` to proceed with a real open.
 *
 *  ⚠️ Not a comparison against the newest REQUESTED root. That root is set when an open is queued
 *  and never rolled back, so after a TIMEOUT or a failed open a repeat call compared equal and
 *  answered `ok, alreadyOpen` about a project still installing, or one that failed to open
 *  (#1587 close-out review). */
export function sameRootVerdict(
  root: string,
  status: { inFlight: string | null; opened: string | null },
  same: (a: string, b: string) => boolean,
): 'already-open' | 'in-flight' | null {
  if (status.inFlight) return same(root, status.inFlight) ? 'in-flight' : null;
  return status.opened && same(root, status.opened) ? 'already-open' : null;
}

/** The reply for an open of a root that is already being opened. Refused rather than queued: a
 *  second open of the same root would reload the window again for nothing. */
export function inFlightReply(root: string): Reply {
  return { status: 409, body: {
    ok: false, code: 'REFUSED_BY_OP',
    error: `open-project: an open of ${root} is already running (an earlier call that timed out, or the File menu). `
      + 'It was not repeated — wait for that one instead.',
    options: ['modoki_get_editor_state — answers from the new project once its editor has mounted'],
  } };
}

export const OPEN_PROJECT_DEFAULT_TIMEOUT_MS = 120_000;
export const OPEN_PROJECT_MIN_TIMEOUT_MS = 1_000;
export const OPEN_PROJECT_MAX_TIMEOUT_MS = 600_000;

/** For a relative `path`, the absolute folder the caller most likely meant: the first of the
 *  editor's own root and the open project's ancestors under which it names a real project. `null`
 *  when none does. Only ever a SUGGESTION in a refusal — the tool never resolves a relative path
 *  itself (owner, 2026-09-27), because a wrong guess reloads the editor into the wrong project. */
export function suggestAbsoluteProject(rel: string, bases: { editorRoot?: string; projectRoot: string }): string | null {
  const candidates: string[] = [];
  if (bases.editorRoot) candidates.push(bases.editorRoot);
  for (let dir = path.dirname(bases.projectRoot); ; dir = path.dirname(dir)) {
    candidates.push(dir);
    if (path.dirname(dir) === dir) break;
  }
  for (const base of candidates) {
    const abs = path.resolve(base, rel);
    if (isProjectFolder(abs)) return abs;
  }
  return null;
}

type Reply = { status?: number; body: Record<string, unknown> };

/** A request that can be settled before anything is asked of the renderer: `refuse` with a reply,
 *  or `proceed` with the normalised absolute root. */
export function checkOpenProjectRequest(
  body: unknown,
  bases: { editorRoot?: string; projectRoot: string },
): { kind: 'refuse'; reply: Reply } | { kind: 'proceed'; root: string; discardUnsaved: boolean; timeoutMs: number } {
  const b = (body ?? {}) as { path?: unknown; discardUnsaved?: unknown; timeoutMs?: unknown };
  if (typeof b.path !== 'string' || !b.path.trim()) {
    return { kind: 'refuse', reply: { status: 400, body: { ok: false, code: 'REFUSED_BY_OP', error: 'open-project needs `path`: the absolute path of a project folder (one holding project.config.json).' } } };
  }
  const raw = b.path.trim();
  if (!path.isAbsolute(raw)) {
    const suggestion = suggestAbsoluteProject(raw, bases);
    return { kind: 'refuse', reply: { status: 400, body: {
      ok: false, code: 'REFUSED_BY_OP',
      error: `open-project refused a relative path ('${raw}'): pass the absolute path of the project folder. `
        + (suggestion
          ? `Did you mean ${suggestion}?`
          : 'No project of that name was found under the editor root or the open project\'s parent folders.'),
      ...(suggestion ? { options: [suggestion] } : {}),
    } } };
  }
  const root = path.resolve(raw);
  if (!isProjectFolder(root)) {
    return { kind: 'refuse', reply: { status: 404, body: {
      ok: false, code: 'NOT_FOUND',
      error: `open-project: ${root} is not a Modoki project — it has no project.config.json. Nothing was opened.`,
    } } };
  }
  if (b.timeoutMs !== undefined && (typeof b.timeoutMs !== 'number' || !Number.isFinite(b.timeoutMs))) {
    return { kind: 'refuse', reply: { status: 400, body: { ok: false, code: 'REFUSED_BY_OP', error: '`timeoutMs` must be a finite number of milliseconds.' } } };
  }
  const timeoutMs = Math.min(OPEN_PROJECT_MAX_TIMEOUT_MS, Math.max(OPEN_PROJECT_MIN_TIMEOUT_MS,
    typeof b.timeoutMs === 'number' ? b.timeoutMs : OPEN_PROJECT_DEFAULT_TIMEOUT_MS));
  return { kind: 'proceed', root, discardUnsaved: b.discardUnsaved === true, timeoutMs };
}

/** Every reply of the route names the instance token the backend expects NOW (#1587 close-out
 *  review). An open switches the token when it STARTS, so a caller told only on success is locked
 *  out by every other outcome: a TIMEOUT (whose own advice is "call get_editor_state" — refused), a
 *  failure, a supersession, and the in-flight refusal it would retry into. Not a secret: the token
 *  is a mix-up guard, not auth (`instanceToken.ts`), and a caller with a WRONG token never reaches
 *  this route (the gate refuses it first). */
export function withExpectedToken(body: Record<string, unknown>, token: string | null): Record<string, unknown> {
  return token ? { ...body, token } : body;
}

/** The reply for a host outcome. Only `opened` is a success; the three others each say what state
 *  the editor is in now, because none of them is "nothing happened". */
export function openProjectReply(root: string, outcome: ProjectOpenOutcome): Reply {
  switch (outcome.kind) {
    case 'opened':
      return { body: { ok: true, opened: true, projectRoot: root, previousRoot: outcome.previousRoot } };
    case 'superseded':
      return { status: 409, body: {
        ok: false, code: 'REFUSED_BY_OP',
        error: `open-project: a newer project open (${outcome.by}) was requested while this one waited, so ${root} was not opened. The editor is switching to ${outcome.by}.`,
        options: ['modoki_identity — confirm which project the editor has open now'],
      } };
    case 'failed':
      return { status: 400, body: {
        ok: false, code: 'REFUSED_BY_OP',
        error: `open-project: preparing ${root} failed (dependency install or Vite server): ${outcome.detail}. `
          + 'The editor may be in an inconsistent state.',
        options: [`relaunch the editor: engine/scripts/launch-editor.sh "${root}"`],
      } };
    case 'timeout':
      return { status: 504, body: {
        ok: false, code: 'TIMEOUT',
        error: `open-project: ${root} is still ${outcome.stage === 'preparing' ? 'being prepared (dependency install / Vite start)' : 'loading in the editor window'} after the time budget. `
          + 'The open was NOT cancelled and is still running — do not repeat this call.',
        options: [
          'modoki_get_editor_state — answers once the new editor has mounted',
          'modoki_identity — projectRoot already names the new project; it is not evidence that it finished loading',
        ],
      } };
  }
}
