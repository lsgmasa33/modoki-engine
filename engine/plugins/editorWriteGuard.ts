/** The watcher's self-write guard (#1702 moved it here): the one implementation both watchers use — the Vite plugin's
 *  (`vite-asset-scanner.ts`) and the Electron main process's (`engine/electron/assetBackend.ts`, which kept a hand-copied
 *  inline twin until #1702 had to change both) — and a LEAF, so the host-agnostic router (`backend/editorBackendRouter.ts`)
 *  can name {@link EDITOR_DELETE_FINGERPRINT} without importing a Vite plugin.
 *
 *  What it is for: a file route that changes a scene, prefab or asset-def file MARKS the path it is about to change, and
 *  the watcher skips its hot-reload broadcast for an event the mark recognises. Without the mark, the editor's own change
 *  comes back as an EXTERNAL one — and an external prefab change reloads the open scene from disk, discarding its
 *  unsaved edits and undo stack (#1702: every Move to Trash of a prefab did exactly that). */

/** The `hash` a route marks a path it DELETES with: "the editor removed this file". `isWrite` then recognises the path
 *  while it stays absent, past the TTL too. Not a sha1, so it can never equal a real file's fingerprint. */
export const EDITOR_DELETE_FINGERPRINT = 'deleted-by-editor';

/** Canonicalize a path for use as a self-write-guard key. Windows paths are
 *  case-INSENSITIVE on the drive letter and reach the guard through two spellings:
 *  the editor's save resolves an OPENED scene's `/@fs/<abs>` URL (whose drive-letter
 *  case comes from wherever that URL was minted — `path.resolve` preserves it, so a
 *  lowercase `e:` stays lowercase), while chokidar reports the SAME file with the
 *  drive case of the watched `absDir` (derived from `projectRoot`, typically
 *  uppercase `E:`). Keying the guard Map by the raw string then MISSES — the editor's
 *  own save looks external and bounces the live scene (the Windows Ctrl+S full-reload
 *  bug). Fold the drive letter to a single case and unify separators so both spellings
 *  collapse to one key. A no-op on POSIX paths (no drive letter, no backslashes), so
 *  Linux/macOS keying is unchanged.
 *
 *  ⚠️ **TWO watchers call this**, the Vite plugin's and the Electron main process's, both through
 *  {@link createEditorWriteGuard}. Any cost added here is paid at both, on the chokidar hot path —
 *  several events per save.
 *
 *  ⚠️ **This deliberately does NOT resolve symlinks, and that is settled — do not "fix" it**
 *  (#960, closed not-planned). The two operands genuinely come from DIFFERENT producers, so the
 *  "same producer, correct by construction" reasoning does not apply: `mark` receives
 *  `fromFsUrl(<client-supplied /@fs string>)` (`editorBackendRouter.ts`), while `isWrite`
 *  receives chokidar's path, built from `findAssetRoots(projectRoot)`. Neither chain calls
 *  `realpath` anywhere.
 *
 *  What makes the symlink direction unreachable is a check UPSTREAM of this one: the same
 *  `/@fs/` branch gates on containment first —
 *      `const rel = path.relative(ctx.projectRoot, abs)` → `..` ⇒ **403**
 *  — so a client spelling that differs from `projectRoot`'s by a symlink is REFUSED before a key
 *  is ever built. Measured both directions against a real symlinked tree (logical root + physical
 *  client, and the reverse): both 403, with a positive control confirming the probe does report a
 *  guard miss when one exists. A `realpathSync.native` here would be insurance against a state
 *  the containment check already rejects — and a syscall per watcher event to buy it.
 *
 *  The drive-letter direction, which this DOES fold, is the reachable one: `path.relative` on
 *  win32 is case-insensitive, so a case-flipped drive passes containment and then misses the Map.
 *
 *  ⚠️ **The adjacent question — MEASURED, and the answer is "real mechanism, unreachable flow".**
 *  If a client's `/@fs/` spelling can ever differ from `projectRoot`'s, that 403 is itself a bug
 *  worse than the missed guard: it refuses the save outright. Driven against a live editor
 *  launched with `MODOKI_PROJECT` pointing at a SYMLINK to `games/video-test`:
 *
 *    POST /api/write-file  /@fs<logical>/runtime/assets/probe.json   -> 200   (same file)
 *    POST /api/write-file  /@fs<physical>/runtime/assets/probe.json  -> 403   (same file)
 *    POST /api/write-file  /@fs/tmp/outside/probe.json               -> 403   (control)
 *
 *  So the mechanism is real. What makes it unreachable in the normal flow is that nothing hands
 *  the client a PHYSICAL spelling: every `/@fs/` URL the backend mints goes through
 *  `toFsUrl(ctx.projectRoot)`, i.e. the same lexical `path.resolve` of `MODOKI_PROJECT` that the
 *  containment check compares against — and the open scene does not use the `/@fs/` branch at all
 *  (it resolves as an asset-root path, `/assets/scenes/main.scene.json`). Vite serves BOTH
 *  spellings with a 200, so it does not force a mismatch either.
 *
 *  ⚠️ **It stays a live trap for anything that introduces a resolved path**: a native file dialog
 *  (macOS returns resolved paths), a pasted path, or a drag-drop would all spell it physically and
 *  be refused. If you add such a seam, canonicalise BOTH sides of the containment check — do not
 *  reach for `realpathSync` in the write guard below, which is a different question that #960
 *  settled the other way. */
export function normalizeWriteGuardKey(absPath: string, platform: NodeJS.Platform = process.platform): string {
  // (#1702) Three more ways the route's spelling and chokidar's differ for ONE file, folded here so both sides of the
  // guard pass through this one function:
  // - Unicode normalisation: a client-sent `é` is usually NFC, while a macOS path read back from the filesystem can be
  //   NFD — APFS and NTFS both treat the two as one name.
  // - a trailing separator on a folder path.
  // - letter case, on the platforms whose default filesystem is case-INSENSITIVE (macOS, Windows): an agent may send a
  //   path in another case than the disk's (#1261's class). ⚠️ Over-folds on a case-SENSITIVE volume there (a
  //   case-sensitive APFS volume): a mark on `foo.json` then also covers `Foo.json` — within the TTL, or while a delete
  //   mark's "gone" still holds for both. A hash-tagged write mark still needs the bytes to match. Not folded on Linux.
  const key = absPath.normalize('NFC').replace(/\\/g, '/').replace(/(.)\/+$/, '$1')
    .replace(/^([a-zA-Z]):/, (_m, d: string) => `${d.toLowerCase()}:`);
  return platform === 'darwin' || platform === 'win32' ? key.toLowerCase() : key;
}

/** The self-write guard: scene/prefab files the editor just saved itself (via
 *  /api/write-file) are recorded here so the watcher skips the hot-reload broadcast
 *  for them — an editor Cmd+S must not bounce the live scene, while external edits
 *  (an agent's write, /api/scene-mutate) still reload. Gated by expiry only — NEVER
 *  delete on read, because chokidar emits several events per save (add+change,
 *  write+rename) and deleting on the first would let later events of the same save
 *  bounce the scene; the TTL covers the burst, and a second `mark` for the same
 *  file extends it. A self-cleaning timer drops entries that never re-fire a watcher
 *  event so the map can't leak. Factored out (+ injectable clock) for unit testing
 *  the TTL behavior (editor-core F9). */
export function createEditorWriteGuard(ttlMs = 1500, now: () => number = Date.now, platform: NodeJS.Platform = process.platform) {
  // A delete's fingerprint is "the file is gone" ({@link EDITOR_DELETE_FINGERPRINT}): the timing-independent check
  // for an `unlink` that lands past the TTL — a Finder trash over AppleScript can take seconds. The file coming back
  // (its `add`) no longer matches, which evicts the entry, so a later external change still reloads.
  // Per path: the TTL expiry (fast path for chokidar's add+change burst) PLUS an
  // optional content fingerprint of the exact bytes the editor wrote. The hash is
  // the timing-independent fallback the fixed TTL couldn't give: if a rename event
  // lands AFTER the TTL (heavy disk latency, the F9 failure) but the file's current
  // bytes still equal what we wrote, it's unmistakably our own save — skip the
  // bounce. The instant the bytes diverge (a genuine external edit / agent write),
  // the fingerprint stops matching and the reload proceeds, so this can't mask a
  // real change. (editor-core F9)
  const recent = new Map<string, { exp: number; hash: string | null }>();
  const mark = (absPathRaw: string, hash: string | null = null) => {
    const absPath = normalizeWriteGuardKey(absPathRaw, platform);
    recent.set(absPath, { exp: now() + ttlMs, hash });
    setTimeout(() => {
      const e = recent.get(absPath);
      // Drop expired entries — but keep a hash-tagged one resident past its TTL so
      // the timing-independent fingerprint check above still works for a very-late
      // rename. It's evicted by isWrite the moment the bytes diverge, or replaced by
      // the next mark; the residual set is bounded by the distinct files saved this
      // session (a handful of scenes/prefabs).
      if (e && e.exp <= now() && e.hash == null) recent.delete(absPath);
    }, ttlMs + 100);
  };
  const isWrite = (absPathRaw: string, currentHash?: () => string | null) => {
    const absPath = normalizeWriteGuardKey(absPathRaw, platform);
    const e = recent.get(absPath);
    if (!e) return false;
    if (e.exp > now()) return true; // fast path: still inside the burst window
    if (e.hash != null && currentHash) {
      const cur = currentHash();
      if (e.hash === EDITOR_DELETE_FINGERPRINT ? cur == null : (cur != null && cur === e.hash)) return true; // still ours
      recent.delete(absPath); // diverged → a genuine external edit; stop guarding it
    }
    return false;
  };
  return { mark, isWrite };
}
