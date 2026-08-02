/** Which editor am I talking to? (Enact Phase 4.)
 *
 *  SHARED by BOTH MCP servers (`docs/mcp-tool-conventions.md` §9 — a rule implemented twice
 *  diverges, and this one had not been implemented twice at all: the DEVICE server had no identity
 *  guard whatsoever. `.mcp.json` defaults MODOKI_BACKEND to 5179 for every clone, so a `device_*`
 *  call from the work-ai2 clone drove the MAIN clone's editor — and its device lease — with every
 *  call reporting success.
 *
 *  Two clones of this repo run side by side on one machine, each with its own editor on
 *  its own backend port. An MCP client pointed at the wrong port drives the OTHER clone's
 *  editor — and every call SUCCEEDS. `tap` taps, `get_scene_state` returns a scene, the
 *  undo stack grows. Nothing the agent expects to change changes, and no error is ever
 *  raised. That failure mode consumed an entire session before anyone noticed.
 *
 *  So: the backend now says who it is (`GET /api/identity`), and this compares it against
 *  the client's own working directory. The comparison is deliberately conservative —
 *  false alarms are worse than silence here, because a banner nobody can act on trains
 *  the reader to ignore banners. */

export interface BackendIdentity {
  repoRoot: string;
  projectRoot: string;
  backendPort: number;
  pid: number;
  branch: string | null;
  packaged: boolean;
  /** C6: how our MODOKI_TOKEN related to the editor that answered. Absent on a pre-C6
   *  backend. 'mismatch' ⇒ every non-identity call is being refused with a 403. */
  tokenCheck?: 'ok' | 'absent' | 'mismatch';
  vitePort?: number | null;
  cdpEnabled?: boolean;
  cdpPort?: number | null;
  cdpReachable?: boolean;
  cdpOurs?: boolean;
}

/** Canonicalize a filesystem path for comparison: unify separators, fold the drive-letter
 *  case, then strip a trailing separator so `/a/b` and `/a/b/` compare equal.
 *
 *  Windows spells the SAME directory several ways (`E:\p\m`, `e:/p/m`), so a raw string
 *  compare misses a real containment — which made `identityMismatch` cry wolf on every
 *  Windows session run from a subdirectory (the MCP's own `npm --prefix` smoke was
 *  mis-logged as a benign "cwd artifact" for months). Same normalisation, and the same
 *  reason, as `normalizeWriteGuardKey` (engine/plugins/vite-asset-scanner.ts) and
 *  `instanceToken.rootKey`. No-op on POSIX paths.
 *
 *  Deliberately folds ONLY the drive letter, not the whole path: full case-folding is
 *  right for an identity KEY (rootKey/cloneId, where any drift breaks it) but wrong here,
 *  since it would place `/a/B` inside `/a/b` on case-SENSITIVE Linux. Drive-letter-only is
 *  also platform-independent, so these paths behave identically under CI on either OS. */
function norm(p: string): string {
  const s = p.replace(/\\/g, '/').replace(/^([a-zA-Z]):/, (_m, d: string) => `${d.toLowerCase()}:`);
  return s.length > 1 && s.endsWith('/') ? s.slice(0, -1) : s;
}

/** Is `child` the same path as, or inside, `parent`? Segment-aware, so `/a/bc` is NOT
 *  inside `/a/b`. */
export function isWithin(child: string, parent: string): boolean {
  const c = norm(child), p = norm(parent);
  return c === p || c.startsWith(p + '/');
}

/** A one-line description of the editor, for the "you are here" log. */
export function describeIdentity(id: BackendIdentity, backendUrl: string): string {
  const branch = id.branch ? ` (${id.branch})` : '';
  return `[modoki] backend ${backendUrl} → ${id.repoRoot}${branch}${id.packaged ? ' [packaged]' : ''}`;
}

/** C6 — the backend told us our token names a DIFFERENT editor/project, so it is refusing
 *  every other call with a 403. Unlike `identityMismatch` (a heuristic on cwd), this is the
 *  editor's own verdict, so it's authoritative and reported unconditionally — including for
 *  a packaged editor, where the cwd heuristic deliberately stays silent. */
export function tokenMismatchWarning(id: BackendIdentity, backendUrl: string): string | null {
  if (id.tokenCheck !== 'mismatch') return null;
  return (
    `⚠️  WRONG EDITOR: the editor at ${backendUrl} (project ${id.projectRoot}) rejected this ` +
    `session's MODOKI_TOKEN — this .mcp.json was written for a DIFFERENT editor or project ` +
    `that no longer holds that port. Every modoki_* call will fail with 403 until it's fixed. ` +
    `Fix: in the editor you actually want, run AI → Connect Claude Code, then restart \`claude\`.`
  );
}

/** Returns a loud warning when the backend is serving a DIFFERENT checkout than the one
 *  the client is running in — or `null` when they agree (or when the question is
 *  meaningless).
 *
 *  Two cases are deliberately NOT warnings:
 *   - A PACKAGED editor: its `repoRoot` is inside the .app bundle, so it never matches a
 *     source checkout. Comparing them would warn on every legitimate DMG session.
 *   - `cwd` inside `repoRoot` (or vice versa): running the MCP from a subdirectory of the
 *     repo the editor serves is correct, not a mismatch. */
export function identityMismatch(
  id: BackendIdentity,
  cwd: string,
  backendUrl: string,
): string | null {
  if (id.packaged) return null;
  if (!id.repoRoot || !cwd) return null;
  if (isWithin(cwd, id.repoRoot) || isWithin(id.repoRoot, cwd)) return null;
  return (
    `⚠️  WRONG EDITOR: MODOKI_BACKEND=${backendUrl} is serving ${id.repoRoot}` +
    `${id.branch ? ` (branch ${id.branch})` : ''}, but this session is running in ${cwd}. ` +
    `Every modoki_* call is driving the OTHER checkout's editor — it will appear to succeed and ` +
    `change nothing here. Point MODOKI_BACKEND at this repo's editor, or relaunch it ` +
    `(engine/scripts/launch-editor.sh).`
  );
}
