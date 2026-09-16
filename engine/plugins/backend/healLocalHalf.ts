/** Re-derive the peeled sidecar values this machine is missing, triggered by the Inspector
 *  READING an asset rather than by the game loading one (#1305).
 *
 *  ## Why the read route, and not the serve path
 *
 *  The obvious place looked like `staticAssets.ts`'s warm-cache guards: teach them that an absent
 *  local half is a cache miss, the way a missing `modelCache.hash` already is. Measured, that fixes
 *  video and nothing else. The Inspector's previews point at the SOURCE file —
 *  `AudioAssetView.tsx`'s `<audio controls src={path}>` and `TextureAssetView.tsx`'s
 *  `<img src={path}>` (deliberate, and commented as such) — so opening an audio or texture asset
 *  never requests `<src>~audio.<ext>` / a texture variant and never enters those guards. Only
 *  `VideoAssetView` asks for the converted URL. A serve-path fix would have left 29 audio and 216
 *  texture rows blank until the GAME happened to load them.
 *
 *  `/api/read-meta` is what the Inspector actually calls, and its own docblock already says it
 *  returns the merged view *precisely so these rows are not blank*. The intent was there; only the
 *  re-derivation was missing.
 *
 *  ## It must not block the response
 *
 *  `panels/assetViews/metaBatchLoad.ts` fetches this route for EVERY path in a multi-selection
 *  (`TextureBatchView`, `ModelBatchView`). Probing inline would turn "select 216 textures" into 216
 *  serial `statSync`/`ffprobe` runs before the panel draws. So the route answers immediately with
 *  what is on disk and the heal runs after; the Inspector picks the result up through the
 *  invalidation epoch it already uses to cache-bust this same URL (`useAssetInvalidationEpoch`).
 *
 *  ⚠️ **The attempt is memoised per (asset, sidecar sha) because it is allowed to FAIL.** A machine
 *  with no `ffprobe` can never produce `audioCache.durationSec`, so "incomplete" stays true
 *  forever; without the memo every Inspector open would re-attempt a probe that cannot succeed, and
 *  the fix would trade a blank row for a per-open retry storm. Keying on the sidecar's hash rather
 *  than the path alone is what lets a genuine re-import try again: the sha moves, the memo misses.
 *
 *  ⚠️ **A failed attempt is remembered, not retried.** That means a machine that later installs
 *  `ffprobe` does not backfill until something rewrites the sidecar — the Inspector's own
 *  "Re-import" button is that something, and it is the affordance the views show while the value is
 *  absent. Accepted deliberately: the alternative is re-probing on every open forever. */

import fs from 'fs';
import { blocksMissingLocalHalf, reimportTypeForBlock, metaSidecarSha256, sidecarPath } from '../meta-sidecar';

/** Put `bytes` back at `file` without a torn intermediate state — same tmp+rename discipline
 *  `writeMetaSidecar` uses, because this runs against a file the editor may be re-reading. */
function restoreBytes(file: string, bytes: Buffer): void {
  const tmp = file + '.heal-restore.tmp';
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, file);
}

/** What a heal needs from the backend, narrowed so a test can supply it without a router. */
export interface HealLocalHalfDeps {
  /** The asset type's reimport handler, or undefined when the type has none. */
  getHandler: (type: string) => ((url: string, abs: string) => Promise<void>) | undefined;
  /** Run `fn` off the response path. Injected so a test can await what production fires and
   *  forgets — a bare `void fn()` here would leave the test racing the handler. */
  defer: (fn: () => Promise<void>) => void;
  /** Asked immediately before the handler runs; `false` abandons the heal AND releases its memo
   *  slot so a later read can try again.
   *
   *  ⚠️ **This is the park gate, and skipping it would silently undo #882.** `/api/reimport`
   *  REFUSES while a `pendingMeta` park exists, in its own words: *"The bake reads the sidecar from
   *  DISK, so it would convert with the PRE-EDIT settings — and their next save would then flush
   *  that older document over the cache block this bake writes."* The heal calls the same handlers,
   *  so it needs the same gate — and it is reachable, not theoretical: `VideoAssetView` raw-fetches
   *  `/api/read-meta` even when a park exists (the deliberate #871 exemption), so parking a video
   *  settings edit and reselecting the clip would transcode with the pre-edit settings.
   *
   *  Asked inside the deferred work rather than before the response, because the gate is async and
   *  this route must not wait on it. */
  beforeRun?: () => Promise<boolean>;
  /** Called after a successful heal so the OPEN Inspector re-reads.
   *
   *  ⚠️ **Not optional in practice, and writing the file is not enough.** Observed live on
   *  `demos/forest-camp` 2026-09-17: with only a manifest rebuild here, an audio panel picked the
   *  healed value up but the texture panel kept showing `—` with `variantBytes` already on disk.
   *  The asset views refresh off `useAssetInvalidationEpoch`, which is driven by the
   *  `invalidate-assets` message the reimport route sends — so a heal that does not send it leaves
   *  the row blank until the human reselects, which is precisely the "it does not come back"
   *  symptom this whole change exists to remove. Takes the reimport TYPE because that message is
   *  keyed on it. */
  onHealed?: (assetUrl: string, type: string) => void;
}

/** Assets already attempted this process, keyed `<abs>\0<sidecar sha>`. Exported only so tests can
 *  reset it; production never clears it, which is the point. */
export const healAttempts = new Set<string>();

/** ⚠️ **Heals run at most this many at a time, and the cap is not tidiness.** `metaBatchLoad`
 *  fetches `/api/read-meta` once per path in a multi-selection, through `Promise.all` — so
 *  selecting a folder schedules one heal per asset with nothing between them and the CPU.
 *
 *  And a heal is NOT reliably cheap, which is the claim this cap exists to survive being wrong
 *  about. "Every converter re-probes even on a warm cache hit" is true, but only when the artifact
 *  cache IS warm: measured on this clone 2026-09-17, **106 of the 215 textures that would heal have
 *  no `.cache/modoki-textures` entry for their hash**, so each is a full `toktx` encode — and
 *  `games/video-test` has no `.cache` at all, so its clip is a full ffmpeg transcode. Uncapped,
 *  selecting that folder is a hundred concurrent encoders started by a GET. */
const MAX_CONCURRENT_HEALS = 2;
let activeHeals = 0;
const healQueue: Array<() => void> = [];

/** Run `fn` once a slot is free. Never rejects — the caller has already answered its request. */
async function withHealSlot(fn: () => Promise<void>): Promise<void> {
  if (activeHeals >= MAX_CONCURRENT_HEALS) await new Promise<void>((r) => healQueue.push(r));
  activeHeals++;
  try { await fn(); }
  finally {
    activeHeals--;
    healQueue.shift()?.();
  }
}

/** Why `scheduleLocalHalfHeal` did what it did — returned so the decision is assertable without
 *  observing the filesystem. `'scheduled'` means a handler run was deferred, nothing more: the
 *  handler may still fail, and that failure is deliberately not retried. */
export type HealOutcome = 'complete' | 'scheduled' | 'already-attempted' | 'no-handler';

/** Schedule re-derivation of `absPath`'s missing peeled values. Returns synchronously, always —
 *  the caller is a GET that must not wait. Never throws. */
export function scheduleLocalHalfHeal(
  assetUrl: string,
  absPath: string,
  deps: HealLocalHalfDeps,
): HealOutcome {
  let missing: ReturnType<typeof blocksMissingLocalHalf>;
  try { missing = blocksMissingLocalHalf(absPath); } catch { return 'complete'; }
  if (missing.length === 0) return 'complete';

  // One key for the asset, not one per block: every block on an asset is regenerated by the same
  // handler run, so a per-block key would schedule the same work N times.
  const key = `${absPath}\0${metaSidecarSha256(absPath) ?? ''}`;
  if (healAttempts.has(key)) return 'already-attempted';

  // An asset carries one cache block in practice; when it somehow carries more, the first that
  // names a real handler wins — they all route through the same reimport anyway.
  let handler: ((url: string, abs: string) => Promise<void>) | undefined;
  let healedType = '';
  for (const block of missing) {
    healedType = reimportTypeForBlock(block);
    handler = deps.getHandler(healedType);
    if (handler) break;
  }
  if (!handler) return 'no-handler';

  // Marked BEFORE the work, not after: two Inspector opens in the same tick must not both schedule,
  // and a throw inside the handler must not un-remember the attempt.
  healAttempts.add(key);
  const run = handler;
  deps.defer(() => withHealSlot(async () => {
    // The park gate, asked here rather than before the response because it is async. A refusal
    // RELEASES the memo: a parked edit is a "not now", not a "never", and leaving the key set
    // would strand the asset until the process restarted.
    if (deps.beforeRun) {
      let proceed: boolean;
      // A gate that THREW is not a gate that said yes — the probe could not answer, so this is the
      // `unknown` case and it fails closed, same as the router's explicit handling of it.
      try { proceed = await deps.beforeRun(); }
      catch { proceed = false; }
      if (!proceed) { healAttempts.delete(key); return; }
    }
    // ⚠️ **INVARIANT: a heal may write the gitignored half; it must leave the COMMITTED sidecar
    // byte-identical.** Not a belt-and-braces check — without it this is a repo hazard. The
    // reimport handlers rebuild their whole block in canonical key order and stamp `meta.type`
    // (`reimport-texture.ts`), so on a sidecar whose committed key order predates that shape the
    // rewrite is byte-different: measured 2026-09-17, **43 of 282 committed texture sidecars** come
    // back changed. That would make merely CLICKING an asset in the Assets tree dirty a tracked
    // `games/**` file — exactly the hazard CLAUDE.md's "never `git add -A`" rule (#18) exists for,
    // and invisible to `metaSidecarChurn` (no peeled value is present, so it stays green). It also
    // invalidates the `X-Meta-Sha256` CAS baseline the same response just handed the panel, so the
    // human's next conditional write 409s over a change nobody made.
    //
    // Restoring rather than preventing, because the handlers are shared with `/api/reimport`, where
    // rewriting the committed half is correct and wanted. The difference is the CALLER's authority:
    // a user asked for that one, and nobody asked for this.
    const committed = sidecarPath(absPath);
    const before = fs.existsSync(committed) ? fs.readFileSync(committed) : undefined;
    let healed = false;
    try {
      await run(assetUrl, absPath);
      healed = true;
    } catch (e) {
      // Swallowed on purpose — this is a best-effort repair of a display value behind a GET that
      // has already answered. A missing external CLI is the common case and is not an error the
      // user asked for.
      console.warn(`[meta-sidecar] could not re-derive local stats for ${assetUrl}:`, e);
    }
    // Runs after a THROW too: a handler that died mid-write is the case most likely to have left
    // the committed half altered.
    if (before !== undefined) {
      const after = fs.existsSync(committed) ? fs.readFileSync(committed) : undefined;
      if (after === undefined || !before.equals(after)) {
        try {
          restoreBytes(committed, before);
          console.warn(`[meta-sidecar] heal of ${assetUrl} rewrote its committed sidecar; restored it.`);
        } catch (e) {
          console.error(`[meta-sidecar] heal of ${assetUrl} changed the COMMITTED sidecar and it could not be restored:`, e);
        }
      }
    }
    // Outside the try: a throwing `onHealed` is not a failure to re-derive, and reporting it as one
    // sent the reader looking for a probe that had actually succeeded.
    if (healed) {
      try { deps.onHealed?.(assetUrl, healedType); }
      catch (e) { console.warn(`[meta-sidecar] heal of ${assetUrl} landed but could not be announced:`, e); }
    }
  }));
  return 'scheduled';
}
