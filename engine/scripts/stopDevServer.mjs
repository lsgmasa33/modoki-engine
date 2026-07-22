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

const rootMarker = `${norm(path.resolve(repoRoot))}/node_modules/`;
const isViteCli = (c) => c.includes('/.bin/vite') || c.includes('/vite/bin/vite.js');

let procs;
try { procs = listProcesses(); } catch (e) {
  console.error(`[stop-dev] could not list processes: ${e.message}`);
  process.exit(0); // never fail the caller — stopping is best-effort
}

const targets = procs.filter((p) => {
  if (!p.pid || p.pid === process.pid || p.pid === process.ppid) return false;
  const c = norm(p.cmd);
  return c.includes(rootMarker) && isViteCli(c);
});

if (targets.length === 0) { console.log('Done.'); process.exit(0); }

console.log(`Stopping this repo's dev server: ${targets.map((t) => t.pid).join(' ')}`);
for (const t of targets) kill(t.pid, false);           // graceful first
await new Promise((r) => setTimeout(r, 1000));
const stillUp = new Set(listProcesses().map((p) => p.pid));
for (const t of targets) if (stillUp.has(t.pid)) kill(t.pid, true);   // then force
console.log('Done.');
