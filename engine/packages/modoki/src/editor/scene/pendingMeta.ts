/** Pending `.meta.json` edits — the manual-save half of Inspector import-settings edits (#845).
 *
 *  A texture-compression dropdown, an LOD-ratio slider, and every other Inspector control bound
 *  to a `.meta.json` sidecar used to POST `/api/write-meta` the moment the field changed — no save
 *  action, while `get_editor_state` reported `persistenceMode:'manual'`. That is #831's defect on
 *  a fifth surface: `writeMetaOrWarn` (`assetViews/widgets.tsx`) is a plain fetch wrapper with no
 *  registry behind it, so none of #831's four asset-VIEW fixes (which went through
 *  `persistAssetEdit`/`dirtyAssets.ts`) touched it.
 *
 *  ## Why this is NOT the dirty-asset registry
 *
 *  `dirtyAssets.ts` parks whole `ASSET_SCHEMA_TYPES` documents and flushes them through
 *  `/api/asset-write`, which 400s on an unknown type. `.meta.json` is a SIDECAR, not one of those
 *  eight schemas — it is hard-keyed to `AssetSchemaType` throughout (the route, the MCP zod enums,
 *  `assetTypeParity.test.ts`, the watcher classification), and widening it to carry a ninth,
 *  differently-shaped document would leak into all of them. So this is a SIBLING registry,
 *  mirroring `pendingBaseScene.ts` — same problem, same author's answer, one field's worth of
 *  shape.
 *
 *  ## No live branch, and therefore no `activeFlushMarkers`
 *
 *  `pendingBaseScene.ts` needs a marker set per in-flight flush because `applyBaseSceneEdit` has a
 *  LIVE branch (the currently-open scene) that bypasses the park entirely — a case its own re-park
 *  guard (`!pending.has(path)`) cannot see on its own, because the live branch's `pending.delete`
 *  is a no-op once the flush has already taken the map empty. There is no equivalent branch here:
 *  EVERY `.meta.json` field change parks, full stop. `!pending.has(path)` is therefore already
 *  correct with nothing further to close.
 *
 *  ⚠️ Do not "restore" `activeFlushMarkers` here on the strength of the sibling file having it —
 *  it would be machinery with nothing to guard, covering a live-write race that cannot occur.
 *
 *  ## The flush runs ALONGSIDE the other two, not before or after them
 *
 *  Unlike `/api/scene-mutate`, `/api/write-meta` carries no unsaved-work refusal, so there is no
 *  ordering constraint forcing this flush to run last (or first, or anywhere in particular)
 *  relative to the scene write or the dirty-asset flush. It is wired in next to every
 *  `flushDirtyAssets()` call for locality, not because the order matters — see
 *  `saveCommand.ts`/`serialize.ts`.
 *
 *  ## Re-import races the flush
 *
 *  A re-import (`/api/reimport`, fired from an Apply/Re-import button or a batch view) reads the
 *  CURRENT `.meta.json` off DISK — both to know what to convert with, and to report back what it
 *  baked. With parking in place, firing one while an edit is still only parked would either (a)
 *  bake the OLD settings while the panel already shows the new ones, or (b) leave the pending
 *  park's now-stale snapshot to overwrite the re-import's own fresh disk write at the next Cmd+S —
 *  worse than the bug being fixed, since the earlier immediate-write behaviour never let the two
 *  drift. `flushPendingMetaFor` exists for exactly that: every call site that is about to read the
 *  sidecar because a re-import is about to (or just did) touch it flushes THIS path first, so the
 *  read — and whatever it feeds — sees the same truth the panel does. A load that is NOT chasing a
 *  re-import (a plain mount / asset reselect) should prefer the parked value instead of flushing —
 *  see `peekPendingMeta`.
 *
 *  ## The OTHER half of the race - a full-document READ that misses the park (#845 close-out)
 *
 *  Parking created a SECOND way to be wrong, symmetric with the write-side risk documented above:
 *  several call sites read `.meta.json` off disk and either DECIDE something from it (what
 *  postprocessor to show, what to merge a new edit onto) or WRITE THE WHOLE DOCUMENT BACK (the
 *  9-slice/sprite editors' Save, a model import's id/generated-file merge) - and none of them
 *  consulted this registry before `readMetaPreferringPark` existed. Concretely:
 *
 *   1. Human edits 9-slice insets in the Texture Inspector -> `updateBorder` PARKS `meta.border`.
 *   2. Human opens the 9-Slice editor. Its load effect GETs `/api/read-meta`, which returns DISK -
 *      without the parked border.
 *   3. Human saves in that editor. It writes the FULL `nextMeta`, built on the stale base -> the
 *      parked border is absent from what lands on disk.
 *   4. Cmd+S flushes the park, which overwrites the WHOLE document with the Inspector's older
 *      base -> the 9-Slice editor's slices/border are destroyed.
 *
 *  Both directions lose real work, and neither existed before parking did - nothing was ever
 *  concurrently "about to land" on disk when every edit wrote immediately. `readMetaPreferringPark`
 *  is the fix for the READ half (`peekPendingMeta` before the GET, exactly like this file's
 *  existing mount-time-load callers already did by hand); `metaWrittenToDisk` is the other half -
 *  it lets an immediate full-document writer drop the park its own write already incorporated,
 *  without dropping one that arrived AFTER it read. See both functions below. */

import { backendFetch } from '../backend/editorBackend';
import { cacheBustReimport } from '../panels/useAssetInvalidationEpoch';
import { writeMetaConditional, writeMetaOrWarn } from '../panels/assetViews/widgets';
import { metaReadFallback, metaCameFromFailedRead, stampMetaReadPath, metaReadPathOf } from './metaReadFallback';
import { useEditorStore } from '../store/editorStore';

/** path -> the full `.meta.json` object to write. Last edit to a path wins, exactly like the
 *  dirty-asset registry: a second edit before a save simply supersedes the first. */
const pending = new Map<string, unknown>();

/** path -> sha256 of the `.meta.json` bytes as this editor last SAW them (#845 phase 2).
 *
 *  Deliberately a SEPARATE map rather than a field on the pending entry, for two reasons. The
 *  entry's object identity is `metaWrittenToDisk`'s version stamp, so widening it into
 *  `{doc, ifMatch}` would put the stamp on a wrapper and quietly change what "the same park"
 *  means. And a baseline outlives its park: it is captured on a plain READ, survives the flush
 *  that clears the park, and is what the panel's NEXT edit writes against.
 *
 *  ⚠️ The value comes from the SERVER (`X-Meta-Sha256`, and `sha256` in the write reply), never
 *  from hashing anything here. `/api/read-meta` returns the MERGED view — `.meta.local.json`
 *  folded back in — and `writeMetaSidecar` stamps `version`, may salvage an `id`, and splits those
 *  blocks back out, so the bytes on disk are not the bytes a panel ever holds. Hashing client-side
 *  would produce a baseline that can never match and 409 every write forever, which is the failure
 *  `contentHash.ts`'s docblock warns about. */
const baselines = new Map<string, string>();

/** The read-failed tag, its producer and its predicate live in their own leaf module so the
 *  WRITE ENDPOINT can import them without a cycle — see `metaReadFallback.ts` for the whole
 *  mechanism and why it is keyed on the document rather than the path (#880). Re-exported here
 *  because this is the module every caller already imports. */
export { metaReadFallback, metaCameFromFailedRead, stampMetaReadPath, metaReadPathOf } from './metaReadFallback';

/** The baseline for `path`, or `undefined` when this editor has never read it. `undefined` means
 *  UNCONDITIONAL: `ifMatchRefusal` treats an absent `ifMatch` as "proceed", which is the correct
 *  and deliberate reading — we have no idea what is on disk, so we have no basis to refuse. It
 *  does NOT mean "unchanged". */
export function peekMetaBaseline(path: string | undefined): string | undefined {
  return path ? baselines.get(path) : undefined;
}

/** Test-only: forget every recorded baseline. (There is no failed-read state left to clear —
 *  #880 moved that onto the DOCUMENT, where it needs no registry entry and no reset.)
 *
 *  ⚠️ **"Test-only" is the CORRECT state, not an oversight — do not wire this to a project
 *  switch** (#871 half ②, refuted). That half was filed on the reading that a baseline keyed by an
 *  asset-root-relative path (`/assets/textures/rock.png` is not distinctive) would carry project
 *  A's sha into project B. It cannot: **opening a project hard-reloads the renderer**, which
 *  destroys this module along with everything else. `setProject` (`engine/electron/main.ts`) is the
 *  only project-switch entry point and every one of its callers ends at
 *  `webContents.reloadIgnoringCache()`; there is no in-renderer project switch and no
 *  asset-root-change hook anywhere under `editor/`. The same convention is stated at
 *  `panels/traitClipboard.ts`, and it is why the two sibling registries' `clearDirtyAssets`
 *  (`dirtyAssets.ts`) and `clearPendingBaseScenes` (`pendingBaseScene.ts`) likewise have no
 *  production caller.
 *
 *  **What would make it real:** a SOFT project switch — re-rooting the asset tree without
 *  reloading the renderer. If that is ever built, this function and `clearPendingMeta` below are
 *  what it must call, and `pending` matters more than `baselines` (a parked edit surviving into
 *  another project is worse than a stale hash, which only costs one spurious 409 that then drops
 *  the baseline anyway). */
export function clearMetaBaselines(): void { baselines.clear(); }

/** Forget the baseline for `path` — this editor no longer knows what the sidecar holds.
 *
 *  ⚠️ **MODULE-PRIVATE, and deliberately so.** `dfe8ce441` deleted this function with a stated
 *  reason worth keeping in view: it had ZERO callers, and its docblock named two call sites that
 *  actually inline `baselines.delete` instead. #874 brought it back — but exporting it would have
 *  repeated the mistake one level up, because an exported "forget" invites a caller to forget
 *  WITHOUT having written anything, which is precisely the fail-open review caught (a failed write
 *  dropping a baseline that was still accurate). The exported surface is `writeMetaWholesale`,
 *  which cannot be called that way: it forgets only what its own successful write invalidated.
 *
 *  The two callers are both below, and both sit behind a confirmed write: `writeMetaWholesale`
 *  and `metaWrittenToDisk`. The discard paths still inline `baselines.delete` — deliberate, they
 *  hold the map directly.
 *
 *  A baseline describes bytes at a path, so it is meaningless once this editor has replaced those
 *  bytes itself. Keeping it makes the human's NEXT edit conflict against a hash for content nobody
 *  is looking at any more — #874's spurious 409. */
function forgetMetaBaseline(path: string): void { baselines.delete(path); }

/** Record the CAS baseline a successful `/api/read-meta` response establishes for `path`
 *  (#845 phase 2, #871). A non-ok response records nothing — see the note at the top of the body.
 *
 *  Call this for EVERY raw GET of that route — `readMetaPreferringPark` does it for the one
 *  blessed path, and a file that is a declared exemption in `metaReadPreferringPark.test.ts`
 *  owes it too, along with `metaReadFallback()` for its `{}`.
 *
 *  ⚠️ **AN EXEMPTION FROM THE READ HELPER IS NOT AN EXEMPTION FROM WHAT THE RESPONSE TEACHES.**
 *  That is the whole of #871: `VideoAssetView` is exempted for a true and still-correct reason —
 *  it keeps a third piece of state (`applied`) that must reflect DISK, so it cannot use a helper
 *  that skips the network call whenever a park exists — and that reason was read as vouching for
 *  the file generally. It vouches only for WHICH DOCUMENT THE PANEL DISPLAYS. Because the raw
 *  fetch dropped the header, `baselines` had no entry for any `.mp4`, `flushPendingMetaFor`
 *  passed `undefined` as `ifMatch`, and `ifMatchRefusal` reads an absent `ifMatch` as *proceed* —
 *  the precondition was inert for that entire asset type while looking present.
 *
 *  ⚠️ **The same trap fired a SECOND time, and the merge is what caught it.** `dfe8ce441` added a
 *  read-failed flag to the block this function had already extracted, so an exempted reader would
 *  have recorded the baseline and NOT the read-failure — leaving the video panel free to park a
 *  document built on the `{}` fallback, with no `id`, and destroy the asset's GUID. #880 moved
 *  that half OUT again, onto the fallback document itself, which is what finally makes the
 *  exemption survivable: an exempted reader now owes `metaReadFallback()` — a value it cannot
 *  half-adopt — instead of a second bookkeeping call it can forget. The rule generalises: what an
 *  exemption must not be allowed to skip is better carried by the DATA than by a call.
 *
 *  Three hazards on the baseline half, which is why this is shared and not four lines per site:
 *
 *   - **Only on an ok response.** A 403/404 body is `{}` and carries no header, and writing
 *     `undefined` in on failure would ERASE a baseline an earlier successful read established —
 *     turning the next write unconditional exactly when the editor is least sure what is on disk.
 *   - **A missing header means NO BASELINE, never "unchanged".** The route omits it for a `null`
 *     sidecar, and an absent entry correctly means *unconditional*.
 *   - **Never hash client-side.** The body is the MERGED view (`.meta.local.json` folded back in)
 *     and `writeMetaSidecar` stamps/splits on the way out, so the bytes on disk are not the bytes
 *     a panel ever holds. A client-computed baseline could never match and would 409 forever.
 *
 *  Structurally typed rather than taking a `Response` so a test (and a stub backend) can hand it
 *  the two fields it actually reads. */
export function noteMetaReadResult(
  path: string,
  res: { ok?: boolean; headers?: { get?: (name: string) => string | null | undefined } | null } | null | undefined,
): void {
  // ⚠️ A FAILED READ RECORDS NOTHING HERE, and that is the #880 fix, not an omission.
  //
  // This function armed a path-keyed `readFailed` flag for three revisions, and every one of them
  // was wrong in the same way: the hazard is *"is the document about to be written the `{}`
  // fallback?"*, which belongs to one COMPONENT, and a flag keyed by path answers for whichever
  // component asked last. The guard now travels ON the fallback document (`metaReadFallback`),
  // so a failed read needs no registry entry — and this function is back to the one job its name
  // claims. Given it shipped a defect on two of three attempts at the second job, that narrowing
  // is the point.
  if (!res?.ok) return;
  // ⚠️ ONLY THE BASELINE is skipped while a park is live — see this function's docblock. The
  // parked document was built from older bytes, so a baseline taken from what disk holds NOW is a
  // claim that document cannot support.
  if (peekPendingMeta(path) !== undefined) return;
  const sha = res.headers?.get?.('X-Meta-Sha256');
  if (sha) baselines.set(path, sha);
}

let _version = 0;
const listeners = new Set<() => void>();
function bump(): void { _version += 1; for (const fn of listeners) fn(); }

/** Subscribe to changes (park / flush / discard). Returns an unsubscribe. */
export function subscribePendingMeta(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
/** Monotonic change counter — the `getSnapshot` for a `useSyncExternalStore` subscriber. */
export function getPendingMetaVersion(): number { return _version; }

/** Would a park of `meta` under `path` be ACCEPTED, and if not, why?
 *
 *  ⚠️ **This exists because two surfaces need the same answer at two different TIMES, and the
 *  second one used to guess** (#903). `parkMetaEdit` asks it at write time; the batch views
 *  (`metaBatchLoad`) ask it at LOAD time, to decide which members of a multi-selection an edit can
 *  reach at all. Before this, the views did not ask — they set their local map for every selected
 *  path and called `parkMetaEdit`, which returned `void`, so a refused member was shown as edited
 *  and silently dropped at Cmd+S.
 *
 *  The fix could have been a second predicate in the views. It is one function instead, for the
 *  reason `docs/falsifiable-tests.md` keeps finding: **two mechanisms for one property cannot be
 *  mutation-checked apart** — break either alone and the other keeps the behaviour green, so the
 *  day they disagree is the day it ships. The views ASK the registry rather than re-deriving what
 *  the registry will decide.
 *
 *  Both refusals read the DOCUMENT, never the path, so they answer for the component that built it
 *  and for no other — the panel next to this one, whose read succeeded, keeps editing (#880). */
export type MetaParkVerdict =
  /** The document is stamped for this path and was not built on a failed read — it may be parked. */
  | { parked: true }
  /** `FROM_FAILED_READ`: the panel is showing defaults with no GUID in hand. The write is
   *  wholesale, so parking this costs the asset its GUID and dangles every reference to it —
   *  refusing loses one field edit, parking loses the asset. */
  | { parked: false; reason: 'failed-read' }
  /** `READ_FOR_PATH` (#890/#891/#897): the document carries no stamp (nobody read it — so it has
   *  no `id`, and the heal pass mints a new GUID) or names another path (it is asset A's document,
   *  so two assets would claim one GUID, which is worse). Neither is visible to the failed-read
   *  tag: the first has no response to tag, the second was read successfully — of the wrong file. */
  | { parked: false; reason: 'foreign-read'; readFor: string | undefined };

/** ⚠️ **Callers branch on `.parked`, NEVER on the return value.** A verdict object is always
 *  truthy, so `if (!classifyMetaPark(p, m))` — and `if (!parkMetaEdit(p, m))` — is dead code that
 *  reads exactly like a guard. That is why this is a discriminated union and not a boolean: a
 *  boolean cannot carry the two reasons, and the two reasons are what the human is told. */
export function classifyMetaPark(path: string, meta: unknown): MetaParkVerdict {
  if (metaCameFromFailedRead(meta)) return { parked: false, reason: 'failed-read' };
  const readFor = metaReadPathOf(meta);
  if (readFor !== path) return { parked: false, reason: 'foreign-read', readFor };
  return { parked: true };
}

/** The one wording for a refused park, so the console line and the batch views' banner cannot
 *  drift into saying different things about the same verdict. `parkMetaEdit` prefixes it.
 *
 *  ⚠️ **One console string changed in the #903 merge and it was deliberate, not drift.** main's two
 *  inline copies ended differently — the failed-read branch said "saving would replace the file with
 *  a document missing it", the foreign-read branch "would replace the file wholesale and cost an
 *  asset its identity". Unifying on the second is what collapsing two copies into one function
 *  means, and both consequences are true of both branches. Nothing asserts console text, so no test
 *  would have caught either choice; it is named here because the merge commit reconciled the TOASTS
 *  against main byte-for-byte (they still are) and said nothing about this line. */
export function refusalMessageFor(path: string, verdict: MetaParkVerdict): string {
  if (verdict.parked) return `${path} can be parked`;
  const cause = verdict.reason === 'failed-read'
    ? "this panel's .meta.json read failed, so it is showing defaults with no GUID in hand"
    : verdict.readFor === undefined
      ? 'this panel has no .meta.json for that path (its read threw, or has not landed yet), so '
        + 'it is showing defaults with no GUID in hand'
      : `this panel is still holding the document it read for ${verdict.readFor}, so parking it `
        + 'here would write that asset\'s GUID into this one';
  return `refusing to park an import-settings edit for ${path} — ${cause}. Saving would replace `
    + 'the file wholesale and cost an asset its identity. RECOVERY: reselect the asset to re-read '
    + 'it. Other panels showing this asset are unaffected.';
}

/** Report a refused park to BOTH channels: the console, for the agent and the log, and a toast,
 *  for the human who is looking at the control right now (owner, 2026-09-08).
 *
 *  ⚠️ **A refusal that only reaches the console is indistinguishable from a broken control.** The
 *  human toggles Flip Y, the checkbox snaps back, nothing is parked and nothing on screen says
 *  why — measured in #890's own drive, where the destruction and the refusal both happened with
 *  no on-screen signal. `EnvironmentAssetView.apply()` already toasted its own refusal; making
 *  this seam do it means the two refusals behave alike rather than one being the exception.
 *
 *  The store keeps ONE toast slot on a 3.5s timer, so a rapid-fire field (a number input firing
 *  per keystroke) re-shows the same message rather than queueing N of them — no dedupe needed
 *  here, and adding one would be a second mechanism for a property the store already has.
 *
 *  `console.error` keeps the FULL diagnosis (which path, which document, the recovery); the toast
 *  is the short human half. They are deliberately not the same string — one is read in a log
 *  afterwards, the other is read in 3.5 seconds while the asset is still selected.
 *
 *  ⚠️ **The store write is DEFERRED to a microtask, and that is not tidiness.** Most park sites call
 *  `parkMetaEdit` from inside a `setState` UPDATER — `setSettings((prev) => { … parkMetaEdit(…) … })`
 *  in Model/Texture/Font/Audio/Video, and the same shape in both batch views. React invokes an
 *  updater during the render phase and StrictMode double-invokes it, and this repo has already
 *  ruled twice that the position must be pure: `AtlasAssetView` ("a setState updater must be pure,
 *  and React StrictMode double-invokes it in dev, so writing here issued two disk writes per edit")
 *  and `SpritePicker` — and `runtime/core/consoleRing.ts` defers for this exact reason in its own
 *  words: *"a synchronous notify from a warn/error raised during render would be a
 *  setState-during-render from the caller's perspective"*. A synchronous `showToast` here is a
 *  zustand `set` notifying every subscriber
 *  of the main editor store from inside another component's render — React's "Cannot update a
 *  component while rendering a different component". `console.error` was inert in that position;
 *  this is not.
 *
 *  ⚠️ It does NOT make the whole function pure, and the honest statement of the residual is that
 *  `bump()` below already notifies `useMetaDirty`'s subscribers synchronously from the same
 *  position — pre-existing, untouched here, and a smaller subscriber set. This defers the write
 *  this change ADDED rather than claiming to have fixed the seam.
 *
 *  A double-invoked updater enqueues the microtask twice; the store's single toast slot collapses
 *  that to one message with its timer reset, so no dedupe is owed. */
function refuseWithToast(consoleMessage: string, toastMessage: string): void {
  console.error(consoleMessage);
  queueMicrotask(() => {
    // ⚠️ The try/catch is what `consoleRing.ts` learned to do around the same deferral. A
    // microtask has no caller: a throwing store subscriber used to propagate into the React stack,
    // where a boundary could see it and the stack said who was at fault, and would now be an
    // uncaught exception on an empty stack. `console.error` above already carries the diagnosis,
    // so swallowing the REPORT's own failure loses nothing the human needed.
    try { useEditorStore.getState().showToast(toastMessage, 'warn'); } catch { /* reported above */ }
  });
}


/** The human half of a refused park — the short sentence the toast shows, chosen by the SAME
 *  verdict the console line is composed from.
 *
 *  ⚠️ **The three messages already matched the three verdicts one-for-one, by hand** — a failed
 *  read, a document nobody read, and another asset's document. #903's `MetaParkVerdict` is that
 *  distinction made explicit, so this reads the discriminant instead of re-deriving it from
 *  `metaCameFromFailedRead`/`metaReadPathOf` a third time. Same reason `classifyMetaPark` exists:
 *  one predicate, several consumers. */
function toastMessageFor(verdict: MetaParkVerdict): string {
  if (verdict.parked) return ''; // unreachable — callers check `.parked` first
  if (verdict.reason === 'failed-read') {
    return 'That edit was not saved — this asset\'s import settings could not be read. '
      + 'Reselect the asset to re-read it, then try again.';
  }
  return verdict.readFor === undefined
    ? 'That edit was not saved — this asset\'s import settings have not been read yet. '
      + 'Reselect the asset, then try again.'
    : 'That edit was not saved — the panel was still showing the previously selected asset. '
      + 'Reselect this asset, then try again.';
}

/** Park a `.meta.json` edit for `path`. `meta` is the FULL sidecar object — every call site
 *  already merges onto whatever it loaded (same contract `writeMetaOrWarn` had), so this simply
 *  holds that object instead of POSTing it.
 *
 *  ⚠️ **The stored value is a SHALLOW COPY, and that copy is what makes `metaWrittenToDisk`'s
 *  reference-identity stamp correct rather than merely true today.** That stamp assumes each park
 *  produces a value distinct from the last, and every call site happens to satisfy it because each
 *  spreads a fresh object literal. But that is an invariant held by the DISCIPLINE of a dozen-odd
 *  unrelated call sites, enforced by nothing — and the day someone parks a
 *  mutated-in-place object (the obvious way to write the nineteenth), `pending.get(path) ===
 *  pendingRef` starts matching a park that is genuinely NEWER than the read, so
 *  `metaWrittenToDisk` drops it and the edit is silently lost. That is the exact clobber this
 *  module exists to close, reached through the mechanism closing it.
 *
 *  Copying here moves the invariant from "every caller must remember" to "the registry
 *  guarantees", for one spread. The copy is shallow on purpose: only the TOP-LEVEL identity is
 *  the stamp, so deep-cloning would cost more and buy nothing.
 *
 *  ⚠️ **There are TWO routes in now, and the second does not build its payload at the call site**
 *  (#903). The batch views hand a PLAN to `parkPlannedMetaEdits`, which calls this per member with
 *  `next[path]` — a fresh object built by `planMetaBatchWrite`'s mutate callback, so the freshness
 *  invariant still holds, but it is the PLANNER that guarantees it rather than the caller. Deliberately
 *  not stating a call-site COUNT here any more: the old "18" was already one refactor from wrong, and
 *  a number nobody re-derives is worse than none. `grep -rn 'parkMetaEdit(' src/editor` is the answer,
 *  and `tests/editor/metaMergeNotClobber.test.ts` is what actually holds the corpus honest. */
export function parkMetaEdit(path: string, meta: unknown, ifMatch?: string): MetaParkVerdict {
  // ⚠️ THE REFUSAL IS `classifyMetaPark`'s, not a second copy of it (#903). Both decisions
  // below used to be inline here, and the batch views needed the SAME question answered at LOAD
  // time — which is exactly the shape that drifts: two predicates for one property, and no
  // mutation can tell them apart until they disagree in production. One implementation, two
  // consumers; the reasons the classifier returns are what this function turns into prose.
  const verdict = classifyMetaPark(path, meta);
  if (!verdict.parked) {
    // ⚠️ BOTH channels, and the split is `refuseWithToast`'s (#890/#891, owner 2026-09-08):
    // console keeps the full diagnosis, the toast is the short human half, and the store
    // write is deferred to a microtask because most park sites call this from inside a
    // setState updater. Composed from the ONE verdict rather than re-deriving each side.
    refuseWithToast(`[pendingMeta] ${refusalMessageFor(path, verdict)}`, toastMessageFor(verdict));
    return verdict;
  }
  // ⚠️ The registry invariant every other reader leans on: EVERY document in `pending` is stamped
  // for the key it is under. It holds by construction — the check above establishes
  // `readFor === path`, and this spread copies symbol keys — which is what lets
  // `readMetaPreferringPark`'s parked branch hand the entry straight back to the panel as its next
  // base without re-stamping it. Re-stamping there would break the `meta === pendingRef` identity
  // contract `metaWrittenToDisk` depends on; re-stamping HERE would be a second mechanism for a
  // property this one already guarantees, which no mutation could tell apart from a no-op.
  //
  // (The old `typeof meta === 'object'` ternary is gone rather than kept "just in case": the guard
  // above already rejects every non-object — `metaReadPathOf` returns `undefined` for one — so its
  // else branch was unreachable, and an unreachable branch reads as a case somebody handled.)
  pending.set(path, { ...(meta as Record<string, unknown>) });
  // ⚠️ `ifMatch` is for a CROSS-PATH re-park only (a rename — `applyMovesToParkedMeta`), and an
  // omitted one PRESERVES whatever this path already had rather than clearing it. That mirrors
  // `markAssetDirty`'s rule and matters for the same reason: every ordinary field-change caller
  // passes nothing, and clearing on omission would turn the compare-and-swap off on the second
  // keystroke.
  //
  // At a NEW key the two are genuinely different questions — #854, on the sibling registry, the
  // same day: "preserve what is here" and "carry what came from there" have different answers, and
  // dropping it there turns the CAS off for the rest of the session on a file the human is
  // actively working on.
  if (ifMatch !== undefined) baselines.set(path, ifMatch);
  bump();
  return verdict;
}

/** The parked `.meta.json` for `path`, or `undefined` when nothing is pending for it. A mount-time
 *  load should call this BEFORE fetching `/api/read-meta` and use it in place of the network
 *  response when present — the disk copy is the PRE-edit doc for as long as the park is
 *  unflushed, and re-seeding the panel from it would read as the edit having been lost (mirrors
 *  `AtlasAssetView`'s `pendingAssetDoc` check for asset docs). */
export function peekPendingMeta(path: string | undefined): unknown | undefined {
  return path ? pending.get(path) : undefined;
}

/** What `readMetaPreferringPark` hands back. */
export interface PreferredMetaRead {
  /** The doc to use — the parked edit when one exists, else what `/api/read-meta` returned.
   *
   *  ⚠️ On a non-ok response this is `metaReadFallback()`, NOT a bare `{}`. It is empty to every
   *  string-key consumer, so a call site spreading it behaves exactly as it did when this was
   *  literally `{}` — but it carries the tag that makes a park or a wholesale write built on it
   *  REFUSABLE (#880). A caller substituting its own `{}` (for a THROWN read, say — this function
   *  does not swallow those) hands its panel an untagged document and opts out of that guard. */
  meta: Record<string, unknown>;
  /** The EXACT value `pending` held for `path` at the moment of this read — the same object
   *  reference as `meta` when a park existed, `undefined` when none did. A caller about to write
   *  `meta` back to disk WHOLESALE holds onto this and passes it to `metaWrittenToDisk` afterward;
   *  a caller that only decides (never writes back) ignores it. */
  pendingRef: unknown;
  /** Did this read actually establish the document? `true` for a parked doc, and for an ok GET.
   *  `false` means the GET failed and `meta` is the `{}` FALLBACK, not an empty sidecar.
   *
   *  ⚠️ **A caller that writes the document back WHOLESALE must abort on `false`.**
   *  `/api/write-meta` → `writeMetaSidecar` replaces the sidecar; it does not merge with disk. So
   *  spreading a fallback `{}` writes a sidecar with no `id`, and the scanner's heal pass then
   *  MINTS A NEW GUID for the asset — silently orphaning every scene/prefab reference to it. A
   *  transient 500 on a read would destroy the asset's identity. `makeTexture2D`'s "A FAILED READ MUST ABORT" comment spells this
   *  out at length and returns early; it is the precedent, and this flag is what lets the other
   *  wholesale writers follow it instead of each re-deriving the argument.
   *
   *  ⚠️ `ok: true` is NOT "there is a sidecar" — `readMetaSidecar` also returns `{}` for a file
   *  that exists and does not PARSE (#778). That case is survivable for a different reason
   *  (`writeMetaSidecar` salvages the `id` textually before quarantining), so do not re-derive a
   *  "safe to spread" argument from this flag alone. It distinguishes a failed READ, nothing more. */
  ok: boolean;
}

/** Read `path`'s `.meta.json`, preferring a parked edit over disk (#845 close-out — see this
 *  module's header addendum). The ONE place a `.meta.json` GET happens: every other reader either
 *  goes through here or is a documented exemption in `metaReadPreferringPark.test.ts`
 *  (`engine/tests/architecture`).
 *
 *  Does not swallow a network/abort error — the caller's own `.catch`/try decides what "the read
 *  failed" means for it, exactly as every call site already did for its raw `fetch` before this
 *  existed (some treat an abort specially; most just keep defaults).
 *
 *  `reimportEpoch`, when passed, cache-busts the GET the same way several mount-time loads already
 *  did by hand (`cacheBustReimport`) — folded in here so a caller does not need its own raw fetch
 *  just to add that query param. */
export async function readMetaPreferringPark(
  path: string,
  opts?: { signal?: AbortSignal; reimportEpoch?: number; passive?: boolean },
): Promise<PreferredMetaRead> {
  const parked = peekPendingMeta(path);
  if (parked !== undefined) return { meta: parked as Record<string, unknown>, pendingRef: parked, ok: true };
  const url = cacheBustReimport(`/api/read-meta?path=${encodeURIComponent(path)}`, opts?.reimportEpoch ?? 0);
  const r = await backendFetch(url, opts?.signal ? { signal: opts.signal } : undefined);
  // ⚠️ `passive` reads record NOTHING (#872 review). A baseline is a claim about the bytes a
  // PANEL's displayed document came from, and the flush conditions the human's next save on it —
  // so only a read that feeds a panel may move it. The agent surface (`read-asset-meta`) feeds no
  // panel: before #872 it ran in the Node process and could not touch this map at all. Measured
  // failure once it could: panel reads V1 → something external rewrites the sidecar → the AGENT
  // reads (advancing the baseline to EXTERNAL) → the human parks an edit built on the stale
  // in-memory doc → the flush is ACCEPTED and overwrites the external change, where without the
  // agent's read it was correctly refused. An observer must not disarm the guard it observes.
  if (!opts?.passive) noteMetaReadResult(path, r);
  // ⚠️ The fallback is `metaReadFallback()`, never a bare `{}` — every panel spreads what it gets
  // here into its next park, and that tag is what makes the spread refusable. See
  // `FROM_FAILED_READ`.
  // ⚠️ STAMPED with the path it was read for (#890/#891). `parkMetaEdit` refuses a document whose
  // stamp is absent or names another path, so this line is what makes an ordinary field change
  // parkable at all — and what makes a panel still holding the PREVIOUS asset's document unable to
  // park it under this one. See `READ_FOR_PATH`.
  const meta = r.ok ? stampMetaReadPath(await r.json(), path) : metaReadFallback();
  return { meta, pendingRef: undefined, ok: r.ok };
}

/** Write `path`'s FULL `.meta.json` and, ONLY IF it landed, forget the baseline it invalidated
 *  (#874). Returns whether the write reached disk.
 *
 *  This is the one shape for an EXPLICIT-ACTION wholesale write — the writes
 *  `writeMetaConditional`'s docblock calls "the right default for the eight explicit-action
 *  writers": built from a fresh read moments earlier, with the human asking for them, and so
 *  deliberately UNCONDITIONAL. What they all owe afterwards is the forget, and it exists here
 *  rather than at each call site for two reasons found by review:
 *
 *   - **Three copies had already drifted into two shapes.** `makeTexture2D` guarded on the write's
 *     boolean; `EnvironmentAssetView` did not, so a FAILED write (a dev-server blip — the case the
 *     modal editors keep their dialogs open for) dropped a baseline that was still accurate, and
 *     the next external change was silently CLOBBERED instead of 409'd. The precondition was
 *     disarmed by the code meant to keep it honest.
 *   - **A fourth site would not have known the rule.** Two of the three had no test at all, so
 *     nothing went red for the one that got it wrong. One function has one test.
 *
 *  ⚠️ FORGET rather than advance — and that is a CHOICE, not a constraint. `writeMetaOrWarn`
 *  collapses the reply to a boolean, but this module also imports `writeMetaConditional`, which
 *  returns the server's post-write `sha256`; switching to it would leave the CAS ARMED instead of
 *  unconditional until the next panel read. Not done because every current caller re-reads almost
 *  immediately (Environment's `loadMeta()`, makeTexture2D's re-import) or targets a generated file
 *  nothing holds a baseline for, so advancing would buy a hash that is stale or unused. Revisit it
 *  if a caller appears that writes and then sits. Leaving the OLD hash remains the one actively
 *  wrong option of the three. */
export async function writeMetaWholesale(path: string, meta: unknown): Promise<boolean> {
  // ⚠️ NO TAG CHECK HERE — it moved to `writeMetaConditional`, the single POST implementation
  // (#880 close-out review, finding 1). A copy here would be a second guard on one endpoint, and
  // that duplication is precisely what left the FOURTH door open: the tag was consumed in three
  // places while `writeMetaOrWarn` — which `SpriteEditor.save` and `NineSliceEditor.save` call
  // directly — consumed it nowhere, and those two were safe only by hand-rolling their own
  // `metaLoadedRef`. Guarding the endpoint covers all of them at once.
  const wrote = await writeMetaOrWarn(path, meta);
  if (wrote) forgetMetaBaseline(path);
  return wrote;
}

/** The EDITOR just wrote `path`'s FULL `.meta.json` to disk itself, built from a
 *  `readMetaPreferringPark` read — drop the park that read observed, so a later Cmd+S does not
 *  flush that now-superseded doc straight over what was just written. Returns whether a park was
 *  actually dropped.
 *
 *  ⚠️ **Pass the exact `pendingRef` THAT READ RETURNED — never a fresh `peekPendingMeta(path)`
 *  call.** The whole point is telling "the park this write already incorporated" apart from "a
 *  park made SINCE the read (during a slow write, or the network round trip)", and only the value
 *  captured at read time can do that:
 *
 *   - `pending.get(path) === pendingRef` (a defined value, unchanged) — nothing has moved since the
 *     read; the write already carries this park's contents, so it is safe — and correct — to drop.
 *   - `pending.get(path)` is a DIFFERENT object than a defined `pendingRef` — a newer edit
 *     superseded the one this write read. That edit is on screen, is not (yet) on disk, and must
 *     survive to the next flush — dropping it here would be the exact clobber this function exists
 *     to prevent, just moved to the other side.
 *   - `pendingRef` was `undefined` (the read fell through to disk) and something is parked now —
 *     same rule: it landed after the read, keep it.
 *   - both `undefined` — nothing was ever parked for this write to race against; a no-op.
 *
 *  Reference equality needs no extra bookkeeping: `pending`'s values are a fresh object per edit, so
 *  the identity `readMetaPreferringPark` handed back already IS a version stamp for that entry — a
 *  monotonic counter would only track information the map already carries for free.
 *
 *  ⚠️ That freshness is guaranteed by `parkMetaEdit` COPYING what it is handed — not by the call
 *  sites all happening to pass object literals, which is how it started and is not a property a
 *  reader can check. See the warning on `parkMetaEdit` for what breaks if that copy is removed.
 *
 *  ⚠️ **Deliberately NOT `dirtyAssets.ts`'s `assetWrittenToDisk` shape (no `pendingRef` argument,
 *  unconditional drop + a loud `console.warn`).** That sibling fires for a CREATE/one-shot write
 *  where nothing sensible could already be parked, so an unconditional drop is correct and a warn
 *  is honest ("I just discarded something"). This fires after an ordinary read-modify-write, which
 *  an Inspector edit can land in the middle of — an unconditional drop would silently reintroduce
 *  the exact clobber this exists to close, and a warn on the common, correct case (nothing raced)
 *  would be alarming noise for a routine event, not a discovery. */
export function metaWrittenToDisk(path: string, pendingRef: unknown): boolean {
  // #874: the baseline goes FIRST, and UNCONDITIONALLY — before the park bookkeeping and
  // regardless of what it decides. Those are two different questions about two different maps:
  // "did this write already incorporate the park I read?" (below, and it can legitimately be no)
  // versus "does this editor still know what is on disk?" (here, and the answer after a wholesale
  // write is always NO — WE changed the file). Getting that wrong is how a stale baseline caused
  // a 409 on a path nothing external had touched: a Make-2D / 9-slice Save / model import writes
  // the sidecar, the Inspector still holds the pre-write hash, and the human's very next Cmd+S is
  // refused with "changed on disk since it was read" — #844's class, a refusal naming no true
  // cause, and its advice ("reopen the asset") is not something the human knows to do.
  //
  // FORGET rather than advance: these callers post the document and never read the reply's
  // `sha256` (several are raw `backendFetch` calls), so the new hash is not in hand here. An
  // absent baseline means UNCONDITIONAL, which is the honest reading — the next panel read
  // re-seeds it via `noteMetaReadResult`. Never leave the OLD one, which is the only actively
  // wrong option of the three.
  //
  // ⚠️ The superseded case still forgets. A newer park writing against a hash for content this
  // write already replaced is exactly the failure above, just one edit later.
  forgetMetaBaseline(path);
  if (pendingRef === undefined || pending.get(path) !== pendingRef) return false;
  pending.delete(path);
  bump();
  return true;
}

/** Is a `.meta.json` edit parked for exactly this path? A panel's dirty indicator. */
export function isMetaDirty(path: string | undefined): boolean {
  return !!path && pending.has(path);
}

/** True if any `.meta.json` edit is pending a save. Folded into `hasUnsavedChanges()`. */
export function hasPendingMeta(): boolean { return pending.size > 0; }

/** The pending paths, for `get_editor_state` — an agent must be able to SEE what a discard or a
 *  scene swap would cost, the same way `dirtyAssetPaths`/`getPendingBaseScenePaths` already do. */
export function getPendingMetaPaths(): string[] { return [...pending.keys()]; }

/** Test-only: drop every pending entry without writing it. The hard reload on a project switch is
 *  what tears this map down in production — see `clearMetaBaselines`' note (#871 half ②) for why
 *  that is correct and what would make it false. */
export function clearPendingMeta(): void { pending.clear(); bump(); }

/** Drop pending `.meta.json` edits WITHOUT writing them. `paths` omitted = drop everything.
 *
 *  Mirrors `discardPendingBaseScenes`/`discardDirtyAssets`, including telling a caller apart from
 *  a typo: "I dropped your edit" and "there was nothing to drop" are different answers. */
export function discardPendingMeta(paths?: readonly string[]): { discarded: string[]; notPending: string[] } {
  if (!paths) {
    const discarded = [...pending.keys()];
    // A baseline describes bytes at a path this editor is tracking. Dropping the park without it
    // leaves a hash for content nobody is looking at any more, which would make a LATER unrelated
    // edit to the same path conflict against it.
    for (const p of discarded) baselines.delete(p);
    pending.clear();
    if (discarded.length) bump();
    return { discarded, notPending: [] };
  }
  const discarded: string[] = [];
  const notPending: string[] = [];
  for (const p of paths) {
    if (pending.delete(p)) { discarded.push(p); baselines.delete(p); } else notPending.push(p);
  }
  if (discarded.length) bump();
  return { discarded, notPending };
}

export interface MetaFlushResult {
  /** Paths written successfully. */
  saved: string[];
  /** Paths whose write was rejected or threw — RE-PARKED, so still pending and still counted by
   *  `hasUnsavedChanges()`. A failed flush is never silently dropped: report, do not revert (see
   *  `persist.ts`'s `reportWriteFailed` note — the edited value is still correct as an intention,
   *  and snapping the panel back would destroy the human's work to resolve a failure that is
   *  usually transient). */
  failed: Array<{
    path: string;
    error: string;
    /** The write was REFUSED by the `ifMatch` precondition (409), not merely failed — a DIFFERENT
     *  remedy, which is why it is a structured flag and not something a reader greps out of
     *  `error`. A plain failure should be retried; a conflict must not be, because the retry is
     *  unconditional (the batch flush drops the baseline) and would overwrite whatever changed the
     *  file. `toastForSave` splits on this, and the two sentences it produces say opposite things. */
    conflict?: boolean;
  }>;
}

/** Set for the duration of a `flushPendingMeta()` call, so `flushPendingMetaFor` can wait for it
 *  instead of racing it. Without this, a re-import landing WHILE a Cmd+S flush is mid-write could
 *  read the sidecar before that flush's own write for the SAME path lands — the read gets the
 *  pre-flush bytes, and whatever it feeds (a merge-write, a conversion) is built on a doc the flush
 *  is about to overwrite out from under it a moment later. */
let inFlight: Promise<unknown> | null = null;

/** Write every pending `.meta.json` edit through `writeMetaOrWarn` (the existing `/api/write-meta`
 *  wrapper — no second fetch implementation). Called alongside every `flushDirtyAssets()` call in
 *  `saveCommand.ts`/`serialize.ts`; the position relative to those does not matter (see this
 *  module's header) so there is no "run last" invariant to preserve here the way
 *  `pendingBaseScene.ts` has one.
 *
 *  Independent failures: one rejected write does not block the others. */
export async function flushPendingMeta(): Promise<MetaFlushResult> {
  const saved: string[] = [];
  const failed: Array<{ path: string; error: string }> = [];
  // Take the whole batch out BEFORE issuing anything — the dirty-asset/base-scene flushes both do
  // this, and for the same reason here: a `flushPendingMetaFor` call landing mid-flush must see an
  // empty map for every path this flush is already holding, not a doc it is about to overwrite.
  const batch = [...pending.entries()];
  if (!batch.length) return { saved, failed };
  pending.clear();
  bump();

  const run = (async (): Promise<MetaFlushResult> => {
    // Re-parked entries, collected and applied AFTER the loop — never inside it. `/api/write-meta`
    // carries no unsaved-work refusal (unlike `/api/scene-mutate`), so the specific 409-poisons-
    // the-rest cascade `pendingBaseScene.ts` guards against cannot happen here today. The shape is
    // kept anyway: it is the one that stays correct the moment a precondition (phase 2's `ifMatch`)
    // is added to `/api/write-meta`, which is exactly what is coming next.
    const toRepark: Array<[string, unknown]> = [];
    for (const [path, meta] of batch) {
      const r = await writeMetaConditional(path, meta, baselines.get(path));
      if (r.ok) {
        saved.push(path);
        // Advance the baseline to what the server says it actually wrote, so a panel still mounted
        // on this path can keep editing. Without this its next save carries the PRE-flush hash and
        // 409s under "the file changed on disk" — when the only thing that changed it was us.
        if (r.sha256) baselines.set(path, r.sha256);
        continue;
      }
      // A CONFLICT is reported differently from a failure, because the remedy differs: a failed
      // request is worth retrying, a refused one is not — the file moved under this edit, and
      // writing it again without re-reading is the clobber the precondition exists to stop.
      // Either way the entry is RE-PARKED below: report, never revert (see `persist.ts`).
      //
      // ⚠️ …and the BASELINE IS DROPPED, which is what stops a refusal becoming a permanent wedge.
      // `readMetaPreferringPark` returns early whenever a park exists, so it never re-reads the
      // file and never refreshes the baseline; `baselines` is written in only two places, an ok
      // GET and a successful write. So without this line a stale baseline has NO path back: every
      // later Cmd+S 409s, `hasUnsavedChanges()` stays true forever, and with it every refusal it
      // drives — `modoki_build`, `load_scene`, the file-direct `scene-mutate`, and the game-code
      // reload countdown. The toast even tells the human to reopen the asset, which cannot help,
      // because reopening hits that same early return. Restarting the editor was the only exit,
      // and it discards the edit.
      //
      // Dropping it makes the NEXT save unconditional, and that is a deliberate semantic rather
      // than a loophole: the human has been shown one refusal naming the path, so a second,
      // explicit Cmd+S is them choosing to overwrite. Refuse once and report; do not refuse
      // forever and offer no way out.
      if (r.conflict) baselines.delete(path);
      failed.push({
        path,
        error: r.conflict
          ? 'the .meta.json changed on disk since this edit was based on it — the edit is still pending, reopen the asset to see the current values'
          : (r.error ?? 'the /api/write-meta request failed — see the console for the reason'),
        ...(r.conflict ? { conflict: true } : {}),
      });
      toRepark.push([path, meta]);
    }
    for (const [path, meta] of toRepark) {
      // Only if nothing newer claimed the path while the flush was in flight — the same rule
      // `flushDirtyAssets`/`flushPendingBaseScenes` apply to their own re-parks, and for the same
      // reason: an edit made during the save is on screen, is not on disk, and must not be
      // replaced by the older value this flush was carrying.
      if (!pending.has(path)) pending.set(path, meta);
    }
    if (failed.length) bump();
    return { saved, failed };
  })();

  inFlight = run;
  try {
    return await run;
  } finally {
    if (inFlight === run) inFlight = null;
  }
}

/** Flush ONE path — the re-import callers need (see this module's header). Awaits any
 *  `flushPendingMeta()` already in flight before it reads the map, so it can never observe (or
 *  write on top of) a half-finished full flush.
 *
 *  A no-op (`{saved:[], failed:[]}`) when nothing is pending for `path` — the common case, since
 *  most re-imports fire with no unsaved edit in front of them. */
export async function flushPendingMetaFor(path: string): Promise<MetaFlushResult> {
  if (inFlight) {
    // Swallow a rejection from the OTHER flush — its own caller is responsible for reporting it;
    // this call only needs to know the map is quiescent again before it reads `path`.
    await inFlight.catch(() => {});
  }
  const meta = pending.get(path);
  if (meta === undefined) return { saved: [], failed: [] };
  pending.delete(path);
  bump();
  // Register in `inFlight` too, not just READ it above. Without this, two concurrent
  // `flushPendingMetaFor` calls for the same path do not see each other: A takes the entry and
  // awaits its write; B finds an empty map, returns `{saved:[],failed:[]}` immediately, and lets
  // its re-import read the sidecar BEFORE A's write lands — failure mode (a) from this module's
  // header, reached through the very mechanism meant to prevent it. Hard to drive from the UI (the
  // import overlay blocks a double-click) but free to close, and the asymmetry was the bug.
  let settle: () => void = () => {};
  const gate = new Promise<void>((res) => { settle = res; });
  const prior = inFlight;
  inFlight = gate;
  if (prior) await prior.catch(() => {});
  let r;
  try {
    r = await writeMetaConditional(path, meta, baselines.get(path));
  } finally {
    // Always clear, and only if we are still the registered gate — a later flush may have replaced
    // it, and stomping that would let a third caller through while its write is in flight.
    if (inFlight === gate) inFlight = null;
    settle();
  }
  if (r.ok) {
    if (r.sha256) baselines.set(path, r.sha256);
    return { saved: [path], failed: [] };
  }
  if (!pending.has(path)) pending.set(path, meta);
  bump();
  // ⚠️ **NO baseline drop here, deliberately — unlike the batch flush.** The batch flush drops it
  // because a refusal there is REPORTED: `toastForSave` names the path and says the file changed,
  // so a second, explicit Cmd+S is the human choosing to overwrite. That premise does not hold on
  // this path — **all eight callers `await` this and discard the result** (the six asset views'
  // Apply handlers, `reimport.ts`'s loop, `makeTexture2D`), so a conflict here reaches no UI at
  // all. Dropping the baseline would therefore disarm the compare-and-swap SILENTLY, and the next
  // Cmd+S would write unconditionally over the external change and report success — a worse
  // outcome than the wedge the drop exists to prevent, reached with the human told nothing.
  //
  // The wedge is still closed, because both functions read the same `baselines` map: the path
  // stays parked, and the next Cmd+S goes through `flushPendingMeta`, which conflicts ONCE, tells
  // the human, and drops it there. Nothing can be permanently unsaveable; the refusal just has to
  // happen where somebody sees it.
  // ⚠️ The CONFLICT case here is worth knowing about at the call site: this flush exists so a
  // re-import reads the human's pending settings rather than the pre-edit disk copy, and a refusal
  // means it will now read neither — the file was changed by something else entirely. The edit
  // stays parked (never reverted), and the re-import proceeds against whatever is actually on
  // disk, which is the honest answer; the caller surfaces the failed path the same way a failed
  // write is surfaced.
  return {
    saved: [],
    failed: [{
      path,
      error: r.conflict
        ? 'the .meta.json changed on disk since this edit was based on it — the edit is still pending, reopen the asset to see the current values'
        : (r.error ?? 'the /api/write-meta request failed — see the console for the reason'),
      ...(r.conflict ? { conflict: true } : {}),
    }],
  };
}
