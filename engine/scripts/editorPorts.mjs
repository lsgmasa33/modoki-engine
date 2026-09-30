/**
 * The CLONE → EDITOR BACKEND PORT table — the single source of truth for RULE 2
 * ("each clone gets a fixed, distinct backend port", CLAUDE.md § Clones).
 *
 * The backend port is a FAIL-LOUD CONTRACT: it is the MCP target, so every tool
 * call in a session is aimed at whatever this resolves to. Getting it wrong does
 * not merely fail — pointed at a SIBLING clone's editor, every `modoki_*` call
 * SUCCEEDS and silently drives the other checkout. That is the "call
 * modoki_identity first when edits seem to vanish" hazard.
 *
 * ⚠️ WHY THIS FILE EXISTS (#349). The table used to be copy-pasted into four
 * places, and it had already drifted in two of them:
 *   - `launch-editor.sh` defaulted to **5179 — the HUB's pinned port** — so a bare
 *     `launch-editor.sh <project>` from any worker clone launched into main's lane.
 *   - `relaunch-editor.sh` mapped `work-ai`/`work-ai2` only; `work-ai3` and
 *     `work-qa` fell through to the same 5179 default. Its own comment said "Must
 *     list EVERY worker branch" — the comment did not stop the drift, which is
 *     exactly why the guard test below exists instead of a fifth comment.
 *   - `package.json`'s `editor:ai` hardcoded 5180, so it was wrong on ai2/ai3/qa.
 *   - `.mcp.json` (COMMITTED) defaulted MODOKI_BACKEND to 5179 for every clone.
 * That last pair is the damaging one: `.claude/settings.local.json` is gitignored,
 * so a FRESH worker clone has no MODOKI_BACKEND — MCP defaulted to 5179 and the
 * launcher defaulted to 5179, the two wrong defaults agreed, and with the hub's
 * editor up the session drove the hub's checkout. Measured in
 * `~/.modoki/editor-launches.log`: three worker-clone launches landed on 5179, one
 * of them (modoki-qa, 2026-08-25) against a LIVE hub editor.
 *
 * `.mcp.json` kept its 5179 default after this file landed (owner, 2026-08-26: this file
 * fixed the LAUNCHER only), and the MCP half was fixed separately, by #1894. The committed
 * `.mcp.json` now carries NO `${...}` expansion and no `MODOKI_BACKEND` at all: each MCP server
 * takes `MODOKI_BACKEND` from the environment Claude Code spawns it with (a clone's gitignored
 * `.claude/settings.local.json` `env` still wins), and when that is unset it derives THIS table's
 * port from the clone its own source file lives in (`engine/tools/shared/backendUrl.ts`). The
 * expansion had to go, not merely change: Claude Code evaluates a `${VAR:-default}` once BEFORE
 * settings `env` applies and once after, and when the two differ it connects BOTH — every worker
 * session ran a second copy of each server aimed at the hub's 5179/9222 (#1894). The reasons the
 * 2026-08-26 ruling gave still hold for what #1894 did NOT do: `.mcp.json` stays committed (it is
 * what `hasPrivateTooling()` keys on), and both servers still banner a wrong-clone backend
 * (`shared/identity.ts` → `identityMismatch`, `deviceToolSurface.test.ts` § S2.39).
 *
 * KEYED ON THE CLONE DIRECTORY NAME, not the branch (owner, 2026-08-26). A clone's
 * directory is stable even while it temporarily has another branch checked out, and
 * it is how the table in docs/clones-and-ports.md already reads.
 *
 * An UNKNOWN directory resolves to `null` = "auto ports", NOT to a pinned value.
 * A scratch clone (`bugfix-qa` appears in the launch log) is a legitimate thing to
 * have, and auto ports cannot collide with anyone's pinned lane — whereas ANY
 * hardcoded fallback is guaranteed-correct on one clone and guaranteed-wrong on the
 * rest, which is the bug this file replaces. Callers warn and carry on.
 *
 * ⚠️ NOT `clonePort.mjs` (singular), which sits right beside it and solves a
 * DIFFERENT problem: that one HASHES a repo path into a harness port range (#69)
 * so throwaway test/smoke lanes land outside the human range and cannot collide.
 * Nothing is pinned there and nothing is authored — it is a hash. This file is the
 * authored, pinned, human-facing table. Reach for `clonePort.mjs` when a HARNESS
 * needs a port nobody will type; reach for this one when a HUMAN or an MCP session
 * needs the editor that clone owns.
 *
 * This is a `.mjs` (with a `.d.mts` sidecar) for the same reason as
 * `projectRoots.mjs`: most consumers are bash scripts and plain Node, which cannot
 * import TypeScript. Bash reaches it through the CLI at the bottom.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clonePort } from './clonePort.mjs';
import { canonicalPath } from './pathIdentity.mjs';
import { isEntryPoint } from './entryPoint.mjs';

// The table and its lookup live in the effect-free `cloneBackendPorts.mjs` (#1894) so the MCP
// servers can import them without importing this file's CLI; re-exported so nothing else moves.
import { CLONE_BACKEND_PORTS, backendPortForClone, backendUrlForClone } from './cloneBackendPorts.mjs';
export { CLONE_BACKEND_PORTS, backendPortForClone, backendUrlForClone };

/** The hub's port. Named so call sites can say what they mean instead of `5179`. */
export const HUB_BACKEND_PORT = CLONE_BACKEND_PORTS['modoki'];

/**
 * Vite dev-server port derived from a backend port: `5173 + (backend - 5179)`.
 * A PREFERENCE, not a pin — if it is taken the editor still boots on an ephemeral
 * port (see docs/clones-and-ports.md § RULE 2).
 *
 * @param {number} backendPort
 * @returns {number}
 */
export function vitePortForBackend(backendPort) {
  return 5173 + (backendPort - HUB_BACKEND_PORT);
}

/**
 * CDP remote-debugging port derived from a backend port: `9222 + (backend - 5179)`.
 * On the main Mac the `editor-*` shell functions override this to the 932x series
 * so it cannot collide with the `chrome-devtools` MCP's 9222.
 *
 * @param {number} backendPort
 * @returns {number}
 */
export function cdpPortForBackend(backendPort) {
  return 9222 + (backendPort - HUB_BACKEND_PORT);
}

/**
 * The CDP port the editor ACTUALLY binds on the main Mac: `9322 + (backend - 5179)`.
 *
 * ⚠️ This is not a second opinion about `cdpPortForBackend` — it is the OVERRIDE, and both are
 * real. The `editor-*` shell functions set `MODOKI_CDP_PORT` to the 932x series by hand so the
 * editor cannot collide with the `chrome-devtools` MCP's own 9222, and `launch-editor.sh` honours
 * an explicit value ahead of its derivation. So `cdpPortForBackend` describes the fallback and
 * this describes the environment: on `modoki-qa`, the former says 9226 and the editor is on 9326.
 *
 * It lives here because it was already being restated everywhere it was needed and nowhere
 * authored (#1102) — inline arithmetic in `qaCaseReferences.test.ts`, a literal column in
 * `qa/knowledge.md` § 1, and the shell functions themselves, which are outside the repo and are
 * the only executable copy. A value with no home gets restated by each consumer, which is the
 * mechanism behind #900/#1095/#1098 as well.
 *
 * ⚠️ The shell functions remain the real source: this cannot bind a port, only predict one. If
 * they are ever changed, THIS is the line that has to follow them — the guard in
 * `editorPorts.test.ts` pins the docs to this function, not to the shell.
 *
 * @param {number} backendPort
 * @returns {number}
 */
export function editorCdpPortForBackend(backendPort) {
  return 9322 + (backendPort - HUB_BACKEND_PORT);
}

/**
 * The CDP port for a SINGLE-INSTANCE launch with no pinned backend — i.e. an unknown
 * clone directory, which also covers the Windows machine (it holds exactly one clone,
 * so nothing there can collide; owner, 2026-08-26).
 *
 * HASHED from the repo path via `clonePort.mjs`, NOT fixed at 9222. The first version
 * of this returned the hub's CDP port, reasoning that an unpinned instance lands on the
 * hub's BACKEND port anyway — and that reasoning recreated #349 one layer down. When the
 * hub's editor is already up it owns 9222, so the scratch clone's Chromium cannot bind
 * it; the launcher would nonetheless print `CDP: …9222` and an agent aiming there would
 * drive THE HUB'S RENDERER. A banner that names a port belonging to another clone is the
 * exact failure this file exists to remove.
 *
 * `clonePort.mjs` is the right tool precisely because it is the OTHER module: a hash
 * needs no authored table, and an unknown clone is by definition absent from ours. The
 * 9240..9279 block sits clear of the human lane (9222..9226) and of the `chrome-devtools`
 * MCP's 9222.
 *
 * @param {string} repoRoot
 * @returns {number}
 */
export function unpinnedCdpPort(repoRoot) {
  return clonePort(repoRoot, 9240, 40);
}

// ── CLI ────────────────────────────────────────────────────────────────────────
// Bash consumers cannot import an ES module, so they shell out:
//
//   BACKEND_PORT="${MODOKI_BACKEND_PORT:-$(node engine/scripts/editorPorts.mjs backend)}"
//
// Prints the port on stdout, or NOTHING for an unknown clone (so the substitution
// yields the empty string = auto ports, which every caller already handles for
// MODOKI_MULTI). The warning goes to stderr so it reaches the human without
// polluting the value. Always exits 0: these callers run under `set -e`, and a
// non-zero exit inside a command substitution would kill the launch rather than
// degrade it — a worse outcome than the auto port it is warning about.
// `fileURLToPath`, never `new URL(...).pathname`: on Windows the latter yields a
// slash-prefixed drive path (`/C:/…`), and that leading slash survives `path.resolve`,
// making both the self-check and the repo root wrong (docs/windows.md § path handling).
// (Spelled without a `Users/<name>` example on purpose — this file ships in the public
// snapshot, and `scan-publish-safety.mjs` reads that shape as a leaked home directory.)
//
// REALPATH BOTH SIDES. Node resolves symlinks for `import.meta.url` but leaves
// `process.argv[1]` as the caller typed it, so comparing them raw makes this whole
// CLI block a silent no-op whenever the script is reached through a symlinked path:
// it printed no port AND no warning, and `resave-*.sh` then died claiming
// "'modoki-qa' is not a known clone directory" about a name that IS in the table.
// Silence was the worst part — every other unknown-clone path at least says why.
// #881: this was a hand-rolled `canonicalPath` — resolve, realpath, fall back on throw — built on
// the JS `fs.realpathSync` walk, which resolves symlinks but NOT `subst` or drive-letter case. The
// `===` folded nothing either. `samePath` is both halves, and it is the same question: "do these
// two spellings name one FILE?"
// #910: was `samePath`, which CASE-FOLDS. The shared helper deliberately does not — both operands
// exist by construction, so `.native` has normalised their casing already, and folding here would
// import #905's accepted over-match into a check whose over-match means running CLI mode on a mere
// import. This site moved OFF that hazard rather than onto it.
const invokedDirectly = isEntryPoint(import.meta.url);

if (invokedDirectly) {
  const repoRoot = process.argv[3] ?? fileURLToPath(new URL('../..', import.meta.url));
  const port = backendPortForClone(repoRoot);
  const cmd = process.argv[2];
  // `cdp-unpinned` answers BEFORE the unknown-clone branch below, and must: it is the
  // question asked precisely WHEN the clone is unknown, so resolving it inside the
  // known-clone arm would make it unreachable in its only real case — and it would have
  // printed the warning plus nothing at all, which reads as "CDP off" rather than a bug.
  // It depends on no clone, so the repoRoot argument is irrelevant to it.
  if (cmd === 'cdp-unpinned') {
    process.stdout.write(String(unpinnedCdpPort(repoRoot)));
  } else if (port === null) {
    process.stderr.write(
      // The CANONICAL name, i.e. the one both lookups actually missed. Printing
      // `basename(resolve(...))` here would name a different string than the one that failed,
      // which is the confusion #881 was about in the first place.
      `[editor-ports] '${path.basename(canonicalPath(repoRoot))}' is not a known clone directory — ` +
        `using AUTO ports. Set MODOKI_BACKEND_PORT explicitly to pin one ` +
        // Names the TABLE, not a doc: this file ships in the public snapshot and runs on every
        // launch from an unknown directory, while docs/clones-and-ports.md does not ship (#907).
        `(known: ${Object.keys(CLONE_BACKEND_PORTS).join(', ')}; table: CLONE_BACKEND_PORTS in engine/scripts/editorPorts.mjs).\n`,
    );
  } else if (cmd === 'backend') {
    process.stdout.write(String(port));
  } else if (cmd === 'vite') {
    process.stdout.write(String(vitePortForBackend(port)));
  } else if (cmd === 'cdp') {
    process.stdout.write(String(cdpPortForBackend(port)));
  } else if (cmd === 'editor-cdp') {
    // The port the editor ACTUALLY binds here, as opposed to `cdp`'s fallback derivation. Without
    // this verb the 932x series was unaskable from bash — `cdp` prints a number `qa/knowledge.md`
    // § 1 explicitly tells a runner is wrong on this clone — which is precisely why every consumer
    // that needed it wrote the arithmetic out again (#1102).
    process.stdout.write(String(editorCdpPortForBackend(port)));
  } else if (cmd === 'url') {
    process.stdout.write(`http://127.0.0.1:${port}`);
  } else {
    process.stderr.write(`[editor-ports] unknown command '${cmd ?? ''}' — want: backend | vite | cdp | editor-cdp | cdp-unpinned | url\n`);
  }
}
