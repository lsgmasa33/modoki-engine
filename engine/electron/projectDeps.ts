/**
 * Pure helpers for the project dependency-install step (`ensureProjectDeps` in main.ts).
 *
 * Extracted so the failure REPORTING is unit-testable without spawning npm or booting
 * Electron — the same posture as `fitToMaxSide` (rendererOps) and `isAdhocSignature`
 * (autoUpdate): the surrounding I/O stays in main.ts, the decision lives here.
 */

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
