/**
 * Pure helpers for the project dependency-install step (`ensureProjectDeps` in main.ts).
 *
 * Extracted so the failure REPORTING is unit-testable without spawning npm or booting
 * Electron — the same posture as `fitToMaxSide` (rendererOps) and `isAdhocSignature`
 * (autoUpdate): the surrounding I/O stays in main.ts, the decision lives here.
 */

/** Injectable fs surface for `hasStaleWorkspaceLink` — real `node:fs` in main.ts, a fake in tests. */
export interface WorkspaceLinkFs {
  readdirSync(dir: string, opts: { withFileTypes: true }): Array<{ name: string; isDirectory(): boolean }>;
  readFileSync(file: string, encoding: 'utf8'): string;
  existsSync(p: string): boolean;
}

/**
 * Is one of THIS project's own `workspaces` packages missing from `node_modules`?
 * `ensureProjectDeps`'s cheap `!existsSync(node_modules)` check misses it when `node_modules`
 * exists overall but one workspace symlink inside it does not, so a game's own native plugin
 * (`capacitor-applovin-max`) 500'd on import with nothing to catch it.
 *
 * `bootstrap-game-deps.mjs` (the repo-ROOT postinstall) already doesn't have this hole — it
 * deliberately never skips on `node_modules` existing, re-running `npm install` unconditionally
 * because it's cheap (~0.3s) when already satisfied; its own comment documents #215, where a
 * STALE REGULAR dependency (not a workspace link) was the concrete symptom. This function is
 * narrower — it only detects a missing WORKSPACE package, the shape `bootstrap-game-deps.mjs`'s
 * unconditional re-run also covers but that #215 itself did not turn out to be — porting that
 * script's "don't trust node_modules existing" posture into the editor's own on-open heal, which
 * took the cheaper existence-only shortcut instead (explicitly, to avoid a slow reinstall on
 * every open) and so could still open straight into the unresolved import without ever going
 * through a root `npm install`.
 *
 * Scoped to the single-level `"dir/*"` glob shape every in-repo game's `workspaces` actually
 * uses today (checked: `projectRoots.mjs`'s discovered projects). Any other glob shape — or any
 * pattern list containing a `!`-negation, which this cheap check cannot resolve without a real
 * glob engine and would otherwise report a permanently-stale, npm-excluded member forever — is
 * skipped rather than guessed at: a false negative here just falls back to the existing "no
 * node_modules at all" check, never a crash and never a perpetual reinstall, and this stays a
 * cheap fs-only check (no glob library, no npm invocation) so it doesn't reintroduce the cost
 * the shortcut existed to avoid.
 */
export function hasStaleWorkspaceLink(
  projectRoot: string,
  pkg: { workspaces?: unknown },
  fsOps: WorkspaceLinkFs,
): boolean {
  const patterns = Array.isArray(pkg.workspaces) ? pkg.workspaces : [];
  // A negation pattern (`!packages/experimental`) changes which glob matches npm actually
  // links; replicating that correctly needs a real glob engine, which this deliberately doesn't
  // carry. Bail out rather than risk treating an npm-excluded member as "expected" — that would
  // report stale=true on every open forever, since no `npm install` can ever satisfy it.
  if (patterns.some((p) => typeof p === 'string' && p.startsWith('!'))) return false;
  for (const pattern of patterns) {
    if (typeof pattern !== 'string') continue;
    const match = /^([^*]+)\/\*$/.exec(pattern);
    if (!match) continue;
    const parentDir = `${projectRoot}/${match[1]}`;
    let entries;
    try {
      entries = fsOps.readdirSync(parentDir, { withFileTypes: true });
    } catch {
      continue; // the workspace dir itself doesn't exist yet — nothing to check
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue; // npm's own glob doesn't match dotfiles either
      let name: string | undefined;
      try {
        name = JSON.parse(fsOps.readFileSync(`${parentDir}/${entry.name}/package.json`, 'utf8')).name;
      } catch {
        continue; // no/unreadable package.json — not a real workspace package
      }
      if (name && !fsOps.existsSync(`${projectRoot}/node_modules/${name}`)) return true;
    }
  }
  return false;
}

/**
 * Compose the error a failed dependency install should surface, folding in an earlier
 * vendoring failure as the CAUSE when there was one.
 *
 * Why this exists: `vendorEnginePlugins` is what rewrites an engine plugin's dependency
 * from the placeholder `"*"` (written by addNativeTarget) to `file:plugins/<name>-<hash>.tgz`.
 * Those plugins are NOT published to the public npm registry, so once vendoring throws, the
 * `"*"` survives and the install that follows CANNOT resolve it — the install failure is a
 * guaranteed downstream consequence, never an independent problem.
 *
 * Vendoring failing is deliberately non-fatal (a project with no engine plugin installs
 * fine), so its error was only `console.warn`ed. That meant the user-facing dialog said just
 * "npm install exited with code 1" while the real cause sat in main.log — misdirection that
 * sent a real user (and their agent) chasing npm, the registry, and a phantom stale process
 * before finding a 120s vendoring timeout. Naming the cause is the whole point.
 */
export function composeDepsInstallError(installError: unknown, vendorError: string | null): Error {
  const installMsg = installError instanceof Error ? installError.message : String(installError);
  if (!vendorError) {
    // No vendoring failure ⇒ the install error stands alone. Preserve the ORIGINAL Error
    // (stack included) rather than re-wrapping a message — a genuine npm failure should
    // not be made to look like a vendoring consequence.
    return installError instanceof Error ? installError : new Error(installMsg);
  }
  return new Error(
    `${installMsg}\n\n` +
      `This is almost certainly a CONSEQUENCE of the earlier failure to prepare the ` +
      `engine plugin, which left its dependency unresolvable:\n  ${vendorError}`,
  );
}
