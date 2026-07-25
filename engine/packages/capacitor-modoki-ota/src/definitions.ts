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
   *  partial version folder where the boot watchdog's `folderExists` check would find it. */
  stageUpdate(options: {
    name: string;
    version: string;
    zipUrl: string;
    expectedZipHash: string;
    expectedZipSize: number;
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
   *  in the first place; this method does not itself fall back to a whole download. */
  stageUpdateDelta(options: {
    name: string;
    version: string;
    baseVersion: string;
    copy: string[];
    download: { path: string; url: string; hash: string; size: number }[];
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

  /** OTA Phase 4 (docs/ota-subgame-modules.md) — every bundle this device has
   *  content for on disk, `active` preferred over `pending` for the SAME name.
   *  DELIBERATELY does not distinguish active/pending the way `getState` does: a
   *  sub-game bundle has no boot-hook promotion path of its own (unlike the shell,
   *  `pending` only promotes to `active` via a native boot hook that decides what the
   *  WKWebView/WebView serves at COLD START — meaningless for something dynamically
   *  script-loaded inside an already-running page), so a `pending` sub-game is already
   *  safe to treat as loadable within the same session it was staged — a broken one
   *  fails the engine-API check or the script tag's `onerror`, never the app's boot.
   *  `path` is an absolute native filesystem path — pass it to
   *  `Capacitor.convertFileSrc()` to get a script-loadable URL. Includes EVERY bundle
   *  with content on disk, including the one this running instance itself drives —
   *  native has no notion of "self", so filtering that out (the caller already knows
   *  its own `ota.bundleName`) is the CALLER's job. */
  listBundles(): Promise<{ bundles: { name: string; version: string; path: string }[] }>;

  /** Progress ticks emitted by `stageUpdate`/`stageUpdateDelta` while they run — see
   *  {@link OtaProgressEvent}. Never fires on web (no native staging happens there). */
  addListener(eventName: 'otaProgress', listenerFunc: (event: OtaProgressEvent) => void): Promise<PluginListenerHandle>;
  removeAllListeners(): Promise<void>;
}
