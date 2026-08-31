/** AtlasAssetView's write+report, extracted (#308 close-out, part D-2) so it is
 *  unit-testable without mounting the component. `AtlasAssetView.tsx`'s `update` callback used
 *  to inline `void writeAssetFile(...).then((ok) => { if (!ok) reportWriteFailed(...) })` —
 *  which is plain logic, but it lived INSIDE the component, so covering it meant mounting the
 *  panel (forbidden — see CLAUDE.md § Panels: editor `.tsx` carries no tests, `.ts` does).
 *  Minimal extraction: same write, same order, same failure message; the component now just
 *  calls this instead of inlining the write+report itself. */

import { writeAssetFile } from '../assetOps';
import { reportWriteFailed } from './persist';
import { defaultAtlasSource } from '../../../runtime/loaders/spriteAtlas';
import { sha256Hex } from '../../utils/contentHash';

/** Write an atlas document's serialized content to `path` and report (console + toast) if the
 *  write did not land. Fire-and-forget by design — the caller does not await this, matching the
 *  optimistic-update-then-report shape every sibling asset view uses (see `persist.ts`'s
 *  `reportWriteFailed` header). Returns the write's own boolean so a test can await it. */
export async function persistAtlasDoc(path: string, content: string): Promise<boolean> {
  const ok = await writeAssetFile(path, content);
  if (!ok) reportWriteFailed(path, 'the atlas write was rejected');
  return ok;
}

// ---------------------------------------------------------------------------------------------
// Load-state decision logic (#430).
//
// AtlasAssetView's load effect used to keep DEFAULT_DOC silently on any failed/aborted fetch,
// with `rawDoc.current = {}` — so the FIRST edit after a failed load called `persistAtlasDoc`
// with a default document, overwriting the real `.atlas.json` (losing `members`, `texture`, the
// `id` GUID). This half — classifying a fetch outcome into a load state + normalized doc, and
// gating whether a write may proceed — is pure decision logic, extracted here for the same
// reason `persistAtlasDoc` above was (#308): editor `.tsx` carries no tests (CLAUDE.md § Panels).

export interface AtlasSourceDoc {
  id?: string;
  version?: number;
  members: string[];
  pageSize: number;
  padding: number;
  extrude: number;
  maxPages?: number;
}

export const DEFAULT_ATLAS_DOC: AtlasSourceDoc = defaultAtlasSource();

export type AtlasLoadState = 'loading' | 'ok' | 'failed';

/** What the load effect actually observed, reduced to the four cases that matter. An abort is
 *  the effect's own cleanup firing (path changed again, or unmount) — never a load failure. */
export type AtlasLoadOutcome =
  | { kind: 'aborted' }
  | { kind: 'httpError' }
  | { kind: 'networkError' }
  | { kind: 'ok'; body: unknown };

/** Normalize a fetched `.atlas.json` body the same tolerant way the load effect always did:
 *  a missing/malformed field falls back to `DEFAULT_ATLAS_DOC`'s value rather than failing the
 *  load — a response that parses but is missing fields is a valid (if sparse) atlas, not a
 *  load failure. */
function normalizeAtlasBody(body: Record<string, unknown>): AtlasSourceDoc {
  const d = body as Partial<AtlasSourceDoc>;
  return {
    id: d.id, version: d.version,
    members: Array.isArray(d.members) ? d.members.filter((m): m is string => typeof m === 'string') : [],
    pageSize: typeof d.pageSize === 'number' ? d.pageSize : DEFAULT_ATLAS_DOC.pageSize,
    padding: typeof d.padding === 'number' ? d.padding : DEFAULT_ATLAS_DOC.padding,
    extrude: typeof d.extrude === 'number' ? d.extrude : DEFAULT_ATLAS_DOC.extrude,
    ...(typeof d.maxPages === 'number' ? { maxPages: d.maxPages } : {}),
  };
}

/** The load effect's next state given a fetch outcome. `null` means "aborted" — the caller does
 *  nothing at all (no state change, no banner): the effect's own cleanup already fired because a
 *  newer load (a path change, or a retry) superseded this one. A non-ok HTTP status or a network
 *  throw is `'failed'` — everything else (including a body missing every field) is `'ok'`, EXCEPT
 *  a parsed body that isn't a plain object (`null`, an array, a string, a number): `{...raw}` in
 *  `serializeAtlasDoc` and the `Partial<AtlasSourceDoc>` cast in `normalizeAtlasBody` both assume
 *  an object, so a body of that shape must not be classified 'ok' — it has no `id` to lose and no
 *  real fields to normalize, and treating it as an editable document is the same data loss #430
 *  fixed, just reached through a different response shape (review finding 4). */
export function classifyAtlasLoad(outcome: AtlasLoadOutcome):
  | { loadState: 'ok'; doc: AtlasSourceDoc; raw: Record<string, unknown> }
  | { loadState: 'failed' }
  | null {
  switch (outcome.kind) {
    case 'aborted': return null;
    case 'httpError': return { loadState: 'failed' };
    case 'networkError': return { loadState: 'failed' };
    case 'ok': {
      const body = outcome.body;
      if (typeof body !== 'object' || body === null || Array.isArray(body)) return { loadState: 'failed' };
      const raw = body as Record<string, unknown>;
      return { loadState: 'ok', doc: normalizeAtlasBody(raw), raw };
    }
  }
}

/** Whether `update()` may write right now. Kept as a standalone predicate (rather than folded
 *  into `persistAtlasDoc`) because the guard also gates `setDoc` — the component must skip the
 *  OPTIMISTIC state update too, not just the write, so the caller needs to ask the question
 *  before it does anything at all.
 *
 *  Compares IDENTITY, not just state (review findings 1 + 3): `loadState === 'ok'` alone is true
 *  in the window between a `path` prop change (A → B) and the load effect for B actually landing
 *  — React can defer a passive effect past paint, and a selection change re-renders the whole
 *  Inspector, so that window is real. `loadedPath` is set only alongside a successful load's
 *  `rawDoc`/`doc`, so `loadedPath !== path` catches exactly that window: the panel is still
 *  painted with A's loaded document but is now asking about B's path. */
export function canPersistAtlasDoc(loadState: AtlasLoadState, loadedPath: string | null, path: string): boolean {
  return loadState === 'ok' && loadedPath === path;
}

// ---------------------------------------------------------------------------------------------
// Compare-and-swap write guard (#439, made atomic by #469).
//
// The panel writes the WHOLE document on every control interaction. Nothing reliably notifies
// this panel of a same-path content change on disk (`assetsVersion` is keyed on the asset PATH
// SET — see assetSetSignature.ts's header — not content), so a `git checkout` under a live
// editor (CLAUDE.md's documented hazard) can change the file's content at the same path with no
// signal reaching this panel. The next edit would then serialize on top of a stale read and
// silently revert whatever changed. The guarantee has to sit on the WRITE.
//
// #439's original fix did this as a client-side read → compare → write, which closed the
// `git checkout` race but opened a NARROWER one of its own kind: two rapid edits (e.g. two
// clicks of the Padding stepper) both capture the same `loadedText`, both re-read the same
// unchanged baseline, both pass the compare, and both write — the second silently overwrites
// the first. #469 moves the compare-and-write into ONE server-side operation
// (`POST /api/write-file`'s `ifMatch` precondition) so there is no gap between them for a
// second write to land in. This function now just hashes what it read and hands the
// precondition to the server; it no longer re-reads the file itself.

/** Re-read-and-write `path` with `content`, but only if the file on disk still hashes to
 *  `loadedText` (#439, #469). Returns 'written' | 'conflict' | 'failed'. `loadedText === null`
 *  means this panel has no baseline to write against (never loaded, or a load failed) — refuse
 *  without even asking the server. Takes the conditional writer as a parameter (rather than a
 *  reader, as #439's version did) so a test can drive it without a backend; production passes
 *  `writeAssetFileIfMatch`. */
export async function persistAtlasDocIfUnchanged(
  path: string,
  content: string,
  loadedText: string | null,
  writeIfMatch: (path: string, content: string, expectedSha256: string) => Promise<'written' | 'conflict' | 'failed'>,
): Promise<'written' | 'conflict' | 'failed'> {
  if (loadedText === null) return 'conflict';
  const expectedSha256 = await sha256Hex(loadedText);
  const outcome = await writeIfMatch(path, content, expectedSha256);
  // Match `persistAtlasDoc`'s own reporting (#308): a write that failed for a reason OTHER than
  // the precondition (network error, a non-409 rejection) must still surface — silently keeping
  // the optimistic `doc` state while the disk write never landed is the exact lie #308 fixed.
  // A 'conflict' is reported differently (the caller's disk-conflict banner + reload), not here.
  if (outcome === 'failed') reportWriteFailed(path, 'the atlas write was rejected');
  return outcome;
}

// ---------------------------------------------------------------------------------------------
// Client-side write serialization (#469 review finding 1).
//
// The server-side `ifMatch` precondition (#469) closed the two-rapid-edits race by making the
// compare-and-write ATOMIC — but it did not, on its own, stop the panel from ISSUING two writes
// at once. `AtlasAssetView.update()` fires on every control interaction with no debounce, and
// each write captures `loadedText` at the moment it's QUEUED. Two edits that fire before the
// first write's response lands (fast typing into a `<input type=number>`, or a held stepper
// arrow at auto-repeat rate) both carry the SAME pre-write `ifMatch`. The server has already
// written the first by the time the second arrives, so the second correctly 409s — but that
// 409 is SELF-INFLICTED, not a real third-party change, and the panel cannot tell the
// difference: it discards the second edit and reloads from disk, under a banner that falsely
// claims the file "changed on disk". Under the OLD client-side CAS (#439) this raced too, but
// benignly — last-write-wins, and since every write is the FULL document, the last write already
// carries the earlier edit. #469 turned that benign race into active data loss.
//
// #469's own review dismissed client-side serialization as "a cheaper mitigation that narrows
// the window without closing it, and should not be mistaken for a fix" — true of serialization
// INSTEAD OF a server CAS (it would still lose to a genuine external writer, e.g. `git
// checkout`). Combined WITH the server CAS, the two are complementary, not redundant: this queue
// removes the SELF-inflicted false conflicts (our own writes racing each other) by only ever
// having one write in flight; the server precondition still catches the genuine third-party
// change the atomic CAS exists for (#439's actual data-loss class). Neither alone is sufficient.

/** A single-flight, latest-wins write queue for one `AtlasAssetView` instance.
 *
 *  `enqueue(path, content)` never issues a write itself — it records `{path, content}` as the
 *  most recently requested write and chains a link onto the queue's promise, so the actual
 *  writes always run ONE AT A TIME, in order. If a second `enqueue` call lands while the first's
 *  write is still in flight, the first's own queued link (not yet started) finds the pending job
 *  already overwritten by the second and does nothing — it was superseded before it ever ran.
 *  Collapsing to the newest is deliberate and safe: every write is the FULL serialized document,
 *  so the newest one already carries whatever the superseded one would have written.
 *
 *  `getLoadedText()` is called at the moment a queued write actually ISSUES, not when it was
 *  enqueued — so a write chained behind an earlier one picks up whatever baseline that earlier
 *  write left behind (via `onWritten`), rather than the stale baseline that was current when it
 *  was queued. Reading `loadedText` eagerly at enqueue time would just move the staleness bug
 *  from "two writes race" to "the second write's precondition is already wrong before it's ever
 *  sent" — same failure, one queue-hop later.
 *
 *  **Path-aware (review finding 2).** `Inspector.tsx` mounts `AtlasAssetView` with no
 *  `key={asset.path}`, so a selection change (atlas A → atlas B) is a prop change on the SAME
 *  instance — this queue, and any job already chained onto it, survives the switch. A job
 *  queued for A that hasn't issued yet by the time the panel moves to B must not run against B's
 *  `getLoadedText()`/`onConflict` at all: `getCurrentPath()` is checked right before the job
 *  issues, and a mismatch DROPS the job outright (no write, no conflict report) rather than
 *  writing A's content against B's baseline or reporting a false conflict on B. */
export function createAtlasWriteQueue(
  writeIfMatch: (path: string, content: string, expectedSha256: string) => Promise<'written' | 'conflict' | 'failed'>,
  callbacks: {
    /** The panel's current CAS baseline. Called fresh for every write this queue actually issues. */
    getLoadedText: () => string | null;
    /** The path the panel is showing RIGHT NOW. Called fresh for every job this queue is about to
     *  issue — a job whose own `path` no longer matches belongs to an asset the panel has since
     *  navigated away from and is dropped (review finding 2). */
    getCurrentPath: () => string;
    /** A write landed — the caller should advance its baseline to `content` (this queue does not
     *  hold that state itself; `AtlasAssetView`'s `loadedText` ref is the single source of it). */
    onWritten: (content: string) => void;
    /** A GENUINE conflict came back from the server (the file changed underneath for a reason
     *  other than this queue's own in-flight write) — never fired for a superseded/collapsed job,
     *  and never fired for a job dropped because the panel has moved to a different path. */
    onConflict: () => void;
  },
): { enqueue: (path: string, content: string) => void } {
  let pending: { path: string; content: string } | null = null;
  let chain: Promise<void> = Promise.resolve();

  function enqueue(path: string, content: string): void {
    pending = { path, content };
    chain = chain.then(async () => {
      const job = pending;
      if (!job) return; // superseded — a later enqueue() already claimed this link's turn
      // Claim it BEFORE awaiting the write, so an enqueue() that fires WHILE this write is in
      // flight queues a genuinely NEW job rather than being silently folded into this one.
      pending = null;
      // The panel has since moved to a different asset — this job's baseline/conflict target
      // both belong to the OLD path, so neither writing nor reporting against the new one is
      // correct. Drop it silently (review finding 2).
      if (job.path !== callbacks.getCurrentPath()) return;
      const outcome = await persistAtlasDocIfUnchanged(job.path, job.content, callbacks.getLoadedText(), writeIfMatch);
      if (outcome === 'written') callbacks.onWritten(job.content);
      else if (outcome === 'conflict') callbacks.onConflict();
    }).catch((err) => {
      // A link that THROWS (rather than resolving to 'failed') would otherwise leave `chain`
      // permanently rejected — every `chain.then(...)` chained by a LATER enqueue() would then
      // never run at all, silently ending persistence for the rest of this mount, plus an
      // unhandled rejection (review finding 3). `persistAtlasDocIfUnchanged` already reports a
      // 'failed' outcome through `reportWriteFailed`; a hard throw (e.g. `sha256Hex` rejecting in
      // a non-secure context) has no `path`/`content` to report through that same path here, so
      // it goes to console instead — the point is keeping the chain alive, not double-reporting.
      console.error('[AtlasAssetView] write queue link threw, chain recovered:', err);
    });
  }

  return { enqueue };
}
