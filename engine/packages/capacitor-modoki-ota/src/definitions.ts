/** JS-side surface of the native OTA plugin (docs/plans/mobile-ota-updates-plan.md,
 *  Phase 1). Every method here is a thin wrapper over native file I/O — the DECISION
 *  logic it delegates to (OtaCore, both platforms) is pure and unit-tested; these
 *  methods themselves are device-unverified (see OtaPlugin.swift/java). */
export interface ModokiOtaPlugin {
  /** Downloads `zipUrl` directly (native HTTP, bypassing the JS bridge for the payload
   *  bytes), verifies its SHA-256 against `expectedZipHash`, and unzips it into a
   *  staging folder that's atomically renamed into place only once fully written and
   *  verified. Throws (rejects) on any hash/network/zip-format failure — never leaves a
   *  partial version folder where the boot watchdog's `folderExists` check would find it. */
  stageUpdate(options: {
    name: string;
    version: string;
    zipUrl: string;
    expectedZipHash: string;
    expectedZipSize: number;
  }): Promise<{ ok: boolean }>;

  /** Marks `version` as the PENDING version for `name` — takes effect on the NEXT app
   *  launch (Phase 1 is "apply next launch" by design; the native boot hook is the sole
   *  authority over what actually gets served, re-derived from state.json every launch). */
  activate(options: { name: string; version: string }): Promise<{ ok: boolean }>;

  /** Call once this session reaches its OWN "fully booted" signal (this app's is
   *  `initialized` in App.tsx). A no-op if nothing is pending for `name`. Promotion to
   *  `active` requires TWO separate successful calls across TWO separate app launches —
   *  never assume a single call promotes anything. */
  confirmBoot(options: { name: string }): Promise<{ ok: boolean }>;

  /** Debug/inspection only — the raw state.json contents (or the literal string "null"
   *  if absent/corrupt), e.g. for a debug-menu tab. Never parse this for control flow. */
  getState(): Promise<{ stateJSON: string }>;
}
