import { reapVitestClaimsDirs } from '../scripts/deviceClaimsStore.mjs';

/**
 * Runs once, in vitest's MAIN process (#1117). It exists for the claims-store fallback dirs that no
 * per-file hook can reach: the main process's own, created when vitest builds its Vite server and
 * the editor backend plugin sweeps stale claims, and one per CHILD process a test spawns, since a
 * child inherits `VITEST` and falls back to its own pid. Workers' dirs are dead-pid dirs by teardown,
 * so they are reaped here too. Before this, a full `npm run verify` left 96 of them.
 */
export default function globalSetup(): () => void {
  const startedAt = Date.now();
  return () => {
    reapVitestClaimsDirs({ sinceMs: startedAt });
  };
}
