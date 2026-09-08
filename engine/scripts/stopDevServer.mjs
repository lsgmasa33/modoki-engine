/**
 * Stop the standalone Vite dev server for ONE repo — the cross-platform engine behind
 * `npm run dev:stop`.
 *
 * Replaces `pgrep -f "<root>/node_modules/.bin/vite"`, which was broken twice over on
 * Windows: `pgrep` does not exist in Git Bash (stop-dev.sh printed "Done." and killed
 * nothing), and even where it exists the pattern is forward-slashed while the real
 * Windows command line is
 *   "node" "E:\repo\node_modules\.bin\\..\vite\bin\vite.js" --config engine/vite.config.ts
 * so it could not have matched anyway.
 *
 * REPO-SCOPED by design: a process qualifies only when its command line contains THIS
 * repo's `<root>/node_modules/` path, so a sibling clone's dev server is never touched.
 * That scoping is the whole point of the script — a blind port sweep used to kill other
 * worktrees' editors.
 *
 * Also deliberately narrow: it matches the vite CLI entry (`.bin/vite`, `vite/bin/vite.js`),
 * i.e. what `npm run dev` starts. The Electron editor owns the Vite it spawned and stops it
 * on quit — quit the editor to stop that one.
 *
 *   node stopDevServer.mjs <repoRoot>
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { canonicalPath } from './pathIdentity.mjs';

const repoRoot = process.argv[2] ?? process.cwd();

/** Windows paths are case-insensitive and mix separators; compare on one normal form. */
const norm = (s) => {
  const f = String(s ?? '').split('\\').join('/');
  return process.platform === 'win32' ? f.toLowerCase() : f;
};

/** [{ pid, cmd }] for every process we can see. */
function listProcesses() {
  if (process.platform === 'win32') {
    // Get-CimInstance, not the deprecated wmic (absent on recent Windows).
    const out = execFileSync('powershell', [
      '-NoProfile', '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress',
    ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    const parsed = JSON.parse(out || '[]');
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.map((r) => ({ pid: Number(r.ProcessId), cmd: r.CommandLine ?? '' }));
  }
  const out = execFileSync('ps', ['-Ao', 'pid=,args='], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return out.split('\n').map((line) => {
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    return m ? { pid: Number(m[1]), cmd: m[2] } : null;
  }).filter(Boolean);
}

function kill(pid, force) {
  try {
    if (process.platform === 'win32') execFileSync('taskkill', force ? ['/F', '/PID', String(pid)] : ['/PID', String(pid)], { stdio: 'ignore' });
    else process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
  } catch { /* already gone */ }
}

/** The spellings of `<repoRoot>/node_modules/` a matching command line might carry.
 *
 *  ⚠️ **One marker was not enough, and the failure was SILENT** (#908). `path.resolve` does not
 *  resolve symlinks, so a clone reached through a link built a marker with the LINK spelling while
 *  the running server's command line carried the TARGET spelling — the `includes()` missed, nothing
 *  was stopped, and the script printed the same `Done.` and exit 0 as a successful kill. Measured
 *  on darwin with a control: the same command through the link left the dummy alive and reported
 *  success; through the real path it killed it.
 *
 *  ⚠️ **`canonicalPath` is the SPELLING canonicaliser and its own docblock says not to build a
 *  PREDICATE on it — that is not what this is.** We are not comparing two paths; we are producing a
 *  second literal spelling of a path that EXISTS by construction (we are running inside it), to
 *  substring-match against a foreign process's `argv`. #892's `resolve` fallback is unreachable
 *  here, and `samePath` is the wrong tool because there is no second path to hand it.
 *
 *  ⚠️ **This covers ONE of the two directions, deliberately.** Both spellings come from OUR
 *  invocation, so stopping through the link while the server was launched by the real path is
 *  covered, and the reverse is not — we never hold a spelling nobody handed us. Closing that would
 *  mean extracting the vite path out of a foreign command line and canonicalising THAT, a
 *  quoting-sensitive token parse over a path that may contain a space (`clonePortCli.test.ts`
 *  exists because one does). The empty-match report below is what makes the residual visible
 *  instead of silent, which is the cost that actually hurt. */
const rootMarkers = [...new Set([
  `${norm(path.resolve(repoRoot))}/node_modules/`,
  `${norm(canonicalPath(repoRoot))}/node_modules/`,
])];
const isViteCli = (c) => c.includes('/.bin/vite') || c.includes('/vite/bin/vite.js');

/** True for the Vite the ELECTRON EDITOR spawned, as opposed to the one `npm run dev`
 *  started. The header above has always promised this carve-out ("the Electron editor
 *  owns the Vite it spawned — quit the editor to stop that one"), but nothing implemented
 *  it: the editor spawns `$REPO/node_modules/vite/bin/vite.js`, the exact path isViteCli
 *  matches, so `dev:stop` killed the editor's Vite every time and printed `Done.` The
 *  editor was left alive with a dead dev server behind it — a failure mode that presents
 *  as "the app is broken", not as "something was stopped" (#129).
 *
 *  `--configLoader runner` is the discriminator: devServer.ts passes it (so a packaged,
 *  read-only install never writes a bundled config into its own tree) and NOTHING else in
 *  the repo does — `npm run dev` is a bare `vite --config engine/vite.config.ts`. */
const isEditorOwned = (c) => c.includes('--configloader runner') || c.includes('--configloader=runner');

let procs;
try { procs = listProcesses(); } catch (e) {
  console.error(`[stop-dev] could not list processes: ${e.message}`);
  process.exit(0); // never fail the caller — stopping is best-effort
}

const mine = procs.filter((p) => {
  if (!p.pid || p.pid === process.pid || p.pid === process.ppid) return false;
  const c = norm(p.cmd);
  return rootMarkers.some((m) => c.includes(m)) && isViteCli(c);
});
// Compare lowercased on EVERY platform: norm() only lowercases on win32, and the flag is
// spelled the same everywhere.
const editorOwned = mine.filter((p) => isEditorOwned(norm(p.cmd).toLowerCase()));
const targets = mine.filter((p) => !editorOwned.includes(p));

// Say what we are NOT touching, and how to stop it — the old silence here is the whole bug.
if (editorOwned.length) {
  console.log(
    `Leaving the editor's own dev server alone: ${editorOwned.map((t) => t.pid).join(' ')}\n`
    + '  (that Vite belongs to a running Electron editor, which stops it on quit — killing it\n'
    + '   would leave the editor up with a dead dev server behind it. Use `npm run editor:stop`.)',
  );
}

// ⚠️ **`Done.` used to be printed here too, so THREE outcomes shared one line and one exit code:
// killed something, matched nothing, and matched only the editor's own Vite** (#908). "Nothing was
// stopped" is the interesting one — it is what a path-spelling miss looks like, and it read as
// success. Splitting it is separable from the identity question above and carries no design risk:
// it does not make any miss less likely, it makes every miss legible.
if (targets.length === 0) {
  if (mine.length === 0) {
    console.log(`No dev server running for this repo — nothing to stop.\n  (looked for a vite CLI under ${rootMarkers.join(' or ')})`);
  } else {
    console.log("Nothing to stop — the only match is the editor's own dev server, left alone above.");
  }
  process.exit(0);
}

console.log(`Stopping this repo's dev server: ${targets.map((t) => t.pid).join(' ')}`);
for (const t of targets) kill(t.pid, false);           // graceful first
await new Promise((r) => setTimeout(r, 1000));
const stillUp = new Set(listProcesses().map((p) => p.pid));
for (const t of targets) if (stillUp.has(t.pid)) kill(t.pid, true);   // then force
console.log('Done.');
