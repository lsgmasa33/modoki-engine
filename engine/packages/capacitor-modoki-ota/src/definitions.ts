import type { PluginListenerHandle } from '@capacitor/core';

/** Fired via `notifyListeners` while `stageUpdate`/`stageUpdateDelta` runs (Phase 3a).
 *  `filesDone`/`filesTotal` count every file the stage touches (copy AND download for
 *  the delta path; always `{0,1}`→`{1,1}` for the whole-zip path, since it's one
 *  network object). `bytesDone`/`bytesTotal` track ONLY the network-downloaded bytes —
 *  copy operations are already-on-disk and don't contribute to byte totals, so a
 *  mostly-copy delta update can show fast-moving `filesDone` alongside near-zero
 *  `bytesTotal`. `bytesTotal` is `0` when the total is genuinely unknown (a copy-only
 *  stage, or a server response with no Content-Length) — treat that as indeterminate
 *  progress, not "already done". No blocking UI consumes this yet (that's Phase 3b);
 *  the event exists so 3b has something to bind to. */
export interface OtaProgressEvent {
  name: string;
  version: string;
  bytesDone: number;
  bytesTotal: number;
  filesDone: number;
  filesTotal: number;
}

/** JS-side surface of the native OTA plugin (docs/ota-updates.md,
 *  Phase 1). Every method here is a thin wrapper over native file I/O — the DECISION
 *  logic it delegates to (OtaCore, both platforms) is pure and unit-tested; these
 *  methods themselves are device-verified on both platforms (see OtaPlugin.swift/java). */
export interface ModokiOtaPlugin {
  /** Downloads `zipUrl` directly (native HTTP, bypassing the JS bridge for the payload
   *  bytes), verifies its SHA-256 against `expectedZipHash`, and unzips it into a
   *  staging folder that's atomically renamed into place only once fully written and
   *  verified. Throws (rejects) on any hash/network/zip-format failure — never leaves a
   *  partial version folder where the boot watchdog's `folderExists` check would find it.
   *
   *  `files` (#556) is the target manifest's full path→hash map. AFTER unzipping into the
   *  tmp dir and BEFORE the atomic rename, native walks that dir, hashes every file it
   *  wrote, and checks the result against `files` for STRICT set equality (no missing
   *  file, no unexpected extra file, no hash mismatch) — the whole-zip hash this method
   *  already verifies only proves the DOWNLOAD was intact, never that what got WRITTEN to
   *  disk matches it file-by-file. Any mismatch throws; nothing is renamed into place.
   *
   *  ⚠️ `files` is REQUIRED here — our own JS must always send it — but BOTH native ports
   *  tolerate its absence at the call boundary. That asymmetry is deliberate, not
   *  an oversight: this TS file is itself shipped over OTA, so a device can be running a
   *  JS bundle staged BEFORE #556 added this field against a native BINARY built AFTER
   *  it. #556 originally made native reject a call missing `files`, which bricked such a
   *  device on a real Galaxy A23 — `checkForUpdate` failed on every attempt, and since
   *  the boot hook always prefers OTA-staged content over the embedded bundle, even
   *  shipping a new app binary could never rescue it. So native treats an ABSENT `files`
   *  as "pre-#556 legacy caller" (skips the whole-tree verification, logs loudly, stages
   *  exactly as pre-#556 code did) and only rejects a `files` that is PRESENT but
   *  malformed. Do not "fix" this by making the field optional here — the type staying
   *  required is what keeps every FUTURE JS build sending it. */
  stageUpdate(options: {
    name: string;
    version: string;
    zipUrl: string;
    expectedZipHash: string;
    expectedZipSize: number;
    files: { path: string; hash: string }[];
  }): Promise<{ ok: boolean }>;

  /** Phase 2 delta staging: builds the `version` folder for `name` WITHOUT downloading a
   *  whole-bundle zip — `copy` lists relative paths to copy byte-for-byte from the
   *  already-on-disk `baseVersion` (an OTA snapshot folder, OR the sentinel `"embedded"`
   *  meaning the app's OWN bundled webDir), `download` lists the new/changed files to
   *  fetch individually, each independently SHA-256-verified against its own hash before
   *  being written. Same atomicity contract as `stageUpdate`: the version folder is only
   *  renamed into place once every copy AND download has succeeded and verified — a
   *  partial delta must never be visible to the boot watchdog's `folderExists` check.
   *  Throws (rejects) if `baseVersion`'s folder (or embedded webDir) doesn't exist, or if
   *  any copy source path is missing from it — the CALLER (otaClient.ts) is responsible
   *  for falling back to `stageUpdate` when it can't get a base manifest to diff against
   *  in the first place; this method does not itself fall back to a whole download.
   *
   *  `files` (#556) is the target manifest's full path→hash map — the same field
   *  `stageUpdate` takes, and for the same reason: `copy` entries are taken byte-for-byte
   *  off disk and are NOT individually hashed (each `download` entry already is, against
   *  its own `hash`), so a locally-corrupt base file was previously invisible. AFTER every
   *  copy AND download has been written into the tmp dir and BEFORE the atomic rename,
   *  native walks the tmp dir, hashes every file, and checks STRICT set equality against
   *  `files` — deliberately less invasive than threading a hash through `copy` itself
   *  (which stays `string[]`), since verifying the whole tree already subsumes that. Any
   *  mismatch throws; nothing is renamed into place.
   *
   *  ⚠️ Required here for the same reason and with the same native-side legacy-caller
   *  exception as `stageUpdate` above — see its doc comment for the full contract. */
  stageUpdateDelta(options: {
    name: string;
    version: string;
    baseVersion: string;
    copy: string[];
    download: { path: string; url: string; hash: string; size: number }[];
    files: { path: string; hash: string }[];
  }): Promise<{ ok: boolean }>;

  /** Marks `version` as the PENDING version for `name` — takes effect on the NEXT app
   *  launch (Phase 1 is "apply next launch" by design; the native boot hook is the sole
   *  authority over what actually gets served, re-derived from state.json every launch). */
  activate(options: { name: string; version: string }): Promise<{ ok: boolean }>;

  /** Call once this session reaches its OWN "fully booted" signal (this app's is
   *  `initialized` in App.tsx). A no-op if nothing is pending for `name`. Promotion to
   *  `active` requires TWO separate successful calls across TWO separate app launches —
   *  never assume a single call promotes anything.
   *
   *  `version` names the version this confirm is EVIDENCE ABOUT; if it is not the one
   *  currently pending, the call is a no-op. ⚠️ This argument is the #553 fix. Promotion
   *  used to be decoupled from the version being promoted, so a sub-game could load the OLD
   *  version, succeed, confirm — twice — and promote a NEW version that had never once run.
   *  Omitting it is correct ONLY for the shell, whose native boot hook is the sole authority
   *  over what got served and already prefers `pending`. A sub-game must always pass it. */
  confirmBoot(options: { name: string; version?: string }): Promise<{ ok: boolean }>;

  /** #553 — decides which version of `name` to load AND records the attempt, before the
   *  caller loads anything. The sub-game counterpart of the shell's native cold-start boot
   *  hook, running the very same `OtaCore.boot()` decision.
   *
   *  ⚠️ Use THIS, never `listBundles()`, to decide what to load. `listBundles` prefers
   *  `active` over `pending`; this prefers `pending` over `active`, which is what makes a
   *  subsequent `confirmBoot` evidence about the version that actually ran. It also counts
   *  the attempt up front, so a bundle that takes the page down with it still burns one and
   *  is reverted after `maxAttempts` — the watchdog a sub-game bundle never had.
   *
   *  `{ target: 'none' }` means nothing is loadable for this name (no staged version, or the
   *  watchdog just reverted the last one and there is no fallback). A sub-game has no
   *  embedded copy, so 'none' really does mean "don't offer this game this launch". */
  beginBundleLoad(options: { name: string }): Promise<
    { target: 'none' } | { target: 'version'; name: string; version: string; path: string }
  >;

  /** #553/#550 — records what a failed load of a SPECIFIC version proves, and returns the
   *  version to fall back to for the rest of THIS launch.
   *
   *  - `'fatal'` — the published bytes are broken (unreadable `subgame.json`, a script that
   *    will not load, a missing/unparseable `assets.manifest.json`, a module with no
   *    `game.id`). Reverts immediately AND quarantines: the zip was hash-verified at stage
   *    time, so re-staging fetches the identical broken bytes, and without the quarantine
   *    `checkForUpdate` re-downloads it on every single launch (owner ruling, 2026-09-01).
   *  - `'transient'` — may not recur (a shared-dependency fetch failed). Costs one attempt.
   *  - `'notEvidence'` — ⚠️ says nothing about the bundle: an `engineApi` mismatch or a
   *    `gameId` collision. Gives the attempt back and NEVER quarantines — `rejected` survives
   *    a binary update, so quarantining a version mismatch would permanently block a bundle
   *    the next app binary would run perfectly.
   *
   *  ⚠️ The returned fallback must NEVER be passed to `confirmBoot` — it is the version being
   *  replaced, and crediting a confirm to it is the #553 defect itself. */
  reportBundleLoadFailure(options: {
    name: string;
    version: string;
    disposition: 'fatal' | 'transient' | 'notEvidence';
  }): Promise<{ target: 'none' } | { target: 'version'; name: string; version: string; path: string }>;

  /** Debug/inspection only — the raw state.json contents (or the literal string "null"
   *  if absent/corrupt), e.g. for a debug-menu tab. Never parse this for control flow. */
  getState(): Promise<{ stateJSON: string }>;

  /** OTA Phase 4 (docs/ota-subgame-modules.md) — every bundle this device has content for
   *  on disk. **DISCOVERY ONLY — this is not how you decide what to load.**
   *
   *  ⚠️ `active` is preferred over `pending` for the same name, which is the OPPOSITE of what
   *  loading a sub-game needs. This comment used to argue that a `pending` sub-game "is
   *  already safe to treat as loadable within the same session it was staged"; that holds
   *  only on a FIRST install, where the name has no `active` version. On an UPDATE the
   *  ordering here means the pending version is precisely the one that does NOT load — so
   *  the old version loaded, succeeded, and called `confirmBoot`, and two of those promoted
   *  the new version to `active` having never executed once. Device-verified on a Galaxy S22
   *  (#553). Use {@link beginBundleLoad} to decide what to load; use this only to enumerate
   *  which bundle NAMES have content on disk.
   *
   *  `path` is an absolute native filesystem path — pass it to `Capacitor.convertFileSrc()`
   *  to get a script-loadable URL. Includes EVERY bundle with content on disk, including the
   *  one this running instance itself drives — native has no notion of "self", so filtering
   *  that out (the caller already knows its own `ota.bundleName`) is the CALLER's job. */
  listBundles(): Promise<{ bundles: { name: string; version: string; path: string }[] }>;

  /** Progress ticks emitted by `stageUpdate`/`stageUpdateDelta` while they run — see
   *  {@link OtaProgressEvent}. Never fires on web (no native staging happens there). */
  addListener(eventName: 'otaProgress', listenerFunc: (event: OtaProgressEvent) => void): Promise<PluginListenerHandle>;
  removeAllListeners(): Promise<void>;
}
