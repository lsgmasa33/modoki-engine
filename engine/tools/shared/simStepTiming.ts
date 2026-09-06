/** The `sim-step` (`device_step`) deadline formula — single-sourced so the DEVICE's own internal
 *  step budget (`agentBridge.ts`'s `sim-step` op, which runs ON the device/app bundle) and the
 *  HOST's outbound transport deadline (`mcp-tools.ts`'s `device_step` tool, which runs in the
 *  standalone `game-debug-mcp` process) can never independently drift (#822).
 *
 *  Dependency-free ON PURPOSE so both sides can import it as a VALUE at zero cost: the shipped app
 *  bundle (`engine/app/debug/agentBridge.ts` re-exports it) and the `game-debug-mcp` package (which
 *  has no dependency on `@modoki/engine` at all) both reach it via a plain relative import, the
 *  same way `engine/tools/shared/identity.ts` is already shared across both MCP servers.
 *
 *  ⚠️ `engine/app/debug/bridgeHelpers.ts` documents a DELIBERATE COPY of `mcpResult.ts`'s
 *  `describeShape` instead of importing it, because a VALUE import from `tools/shared` into the
 *  device-shipped `app/` bundle costs bytes on every device build (#648). That trade does not apply
 *  here: this file is two constants, and the alternative — a copy of the DEADLINE FORMULA kept in
 *  sync by hand — is exactly the defect #822 exists to fix. */

export const SIM_STEP_MAX_TIMEOUT_MS = 20000;

/** The default budget for `sim-step`, DERIVED from the frame count rather than flat.
 *
 *  A flat default could not cover the op's own documented maximum: 600 frames is ~10s at 60fps and
 *  ~20s at 30fps, so `sim-step {frames:600}` — the max the same handler advertises — timed out
 *  against its own budget every time. Two limits sized independently with no cross-check is how a
 *  feature fails on its headline call.
 *
 *  Exported so the arithmetic is unit-testable: pinning it through the op itself would mean waiting
 *  out a real timeout (4.5s+ per assertion), which is why the flat-default regression survived a
 *  mutation check until this was extracted. */
export function simStepDefaultTimeout(frames: number): number {
  return Math.min(SIM_STEP_MAX_TIMEOUT_MS, Math.max(3000, frames * 40 + 500));
}
