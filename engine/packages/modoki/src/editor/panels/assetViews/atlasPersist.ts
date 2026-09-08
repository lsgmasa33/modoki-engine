/** AtlasAssetView's load-state + document-building decision logic, extracted (#308 close-out,
 *  part D-2; #430) so it is unit-testable without mounting the component — editor `.tsx` carries
 *  no tests, its `.ts` neighbour does (CLAUDE.md § Panels).
 *
 *  ⚠️ **This file used to own the WRITE as well, and no longer does (#831).** `persistAtlasDoc`,
 *  `persistAtlasDocIfUnchanged` and `createAtlasWriteQueue` are gone: the panel PARKS its edit in
 *  the dirty-asset registry like every other asset view, and `flushDirtyAssets` writes it at
 *  Cmd+S. What each of them existed for, and where that guarantee lives now:
 *
 *   - **`createAtlasWriteQueue`** (#469 review finding 1) serialized this panel's own in-flight
 *     writes so two rapid edits could not 409 each other with the same stale baseline. Parking is
 *     synchronous and last-write-wins in a `Map`, so there are no concurrent writes left to
 *     serialize — the race is not mitigated, it is structurally absent.
 *   - **`persistAtlasDocIfUnchanged`** (#439, made atomic server-side by #469) refused to write on
 *     top of a file that had changed underneath. That guarantee is STILL NEEDED and still exists:
 *     the panel parks a `sha256` baseline as `DirtyAsset.ifMatch`, and `/api/asset-write` applies
 *     it as a precondition. It matters MORE than it did — the read-to-write window used to be one
 *     keystroke and is now however long the human takes to press Cmd+S.
 *   - **`persistAtlasDoc`**'s failure reporting is `flushDirtyAssets`' now; the panel surfaces it
 *     through `getAssetFlushError`.
 *
 *  Do not reintroduce a write here. A second path from an atlas edit to disk is the SECOND
 *  PERSISTENCE CONTRACT the registry's own header describes, and it is what #831 removed. */

import { defaultAtlasSource, ATLAS_FORMAT_VERSION } from '../../../runtime/loaders/spriteAtlas';
import { classifyFormatVersion } from '../../../runtime/core/formatVersion';

// ---------------------------------------------------------------------------------------------
// Load-state decision logic (#430).
//
// AtlasAssetView's load effect used to keep DEFAULT_DOC silently on any failed/aborted fetch,
// with `rawDoc.current = {}` — so the FIRST edit after a failed load persisted a default
// document, overwriting the real `.atlas.json` (losing `members`, `texture`, the `id` GUID).
// This half — classifying a fetch outcome into a load state + normalized doc, and
// gating whether a write may proceed — is pure decision logic, extracted here for the same
// reason the write logic once was (#308): editor `.tsx` carries no tests (CLAUDE.md § Panels).

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

// 'refused' (docs/format-versioning.md § 2b-bis) is distinct from 'failed': a `.atlas.json`
// written by a NEWER build parsed FINE — it is `editingDisabled` for the same reason a network
// failure is (there is no real document this panel understands to edit onto), but the banner
// text is not the same story. "Could not load" reads as transient (retry the network); a
// too-new format version is a standing fact about THIS build until it is updated, and telling
// the user to retry a bad network read would be a wrong diagnosis for a right symptom.
export type AtlasLoadState = 'loading' | 'ok' | 'failed' | 'refused';

/** What the load effect actually observed, reduced to the four cases that matter. An abort is
 *  the effect's own cleanup firing (path changed again, or unmount) — never a load failure. */
export type AtlasLoadOutcome =
  | { kind: 'aborted' }
  | { kind: 'httpError' }
  | { kind: 'networkError' }
  | { kind: 'ok'; body: unknown };

/** Normalize a fetched `.atlas.json` body the same tolerant way the load effect always did:
 *  EXPORTED because the load effect is no longer the only entry point — an agent's
 *  `modoki_write_asset {type:'atlas'}` parks a doc the panel must adopt without re-fetching, and
 *  it must arrive through the same tolerant normalization rather than a second one.
 *  a missing/malformed field falls back to `DEFAULT_ATLAS_DOC`'s value rather than failing the
 *  load — a response that parses but is missing fields is a valid (if sparse) atlas, not a
 *  load failure. */
export function normalizeAtlasBody(body: Record<string, unknown>): AtlasSourceDoc {
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
 *  `buildAtlasDocToPark` and the `Partial<AtlasSourceDoc>` cast in `normalizeAtlasBody` both assume
 *  an object, so a body of that shape must not be classified 'ok' — it has no `id` to lose and no
 *  real fields to normalize, and treating it as an editable document is the same data loss #430
 *  fixed, just reached through a different response shape (review finding 4). */
export function classifyAtlasLoad(outcome: AtlasLoadOutcome):
  | { loadState: 'ok'; doc: AtlasSourceDoc; raw: Record<string, unknown> }
  | { loadState: 'failed' }
  | { loadState: 'refused'; message: string }
  | null {
  switch (outcome.kind) {
    case 'aborted': return null;
    case 'httpError': return { loadState: 'failed' };
    case 'networkError': return { loadState: 'failed' };
    case 'ok': {
      const body = outcome.body;
      if (typeof body !== 'object' || body === null || Array.isArray(body)) return { loadState: 'failed' };
      const raw = body as Record<string, unknown>;
      // REFUSE a too-new / unreadable format version BEFORE normalizing (docs/format-versioning.md
      // § 2b-bis — `.atlas.json` is a machine-generated sidecar, not player data, so REFUSE not
      // PRESERVE). `raw` is already known to be a plain object here, so `classifyFormatVersion`
      // can only report `ok`/`absent`/`too-new`/`unreadable('non-numeric-version')` — never
      // `unreadable('not-an-object')`, which the check above already ruled out.
      const verdict = classifyFormatVersion(raw, ATLAS_FORMAT_VERSION);
      if (verdict.kind === 'too-new') {
        return {
          loadState: 'refused',
          message: `its format version (${verdict.version}) is newer than this build supports ` +
            `(ATLAS_FORMAT_VERSION ${ATLAS_FORMAT_VERSION})`,
        };
      }
      if (verdict.kind === 'unreadable') {
        return { loadState: 'refused', message: `its version field is unreadable (${verdict.reason})` };
      }
      return { loadState: 'ok', doc: normalizeAtlasBody(raw), raw };
    }
  }
}

/** Whether `update()` may write right now. Kept as a standalone predicate (rather than folded
 *  into the park) because the guard also gates `setDoc` — the component must skip the
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

/** Build the next in-memory `AtlasSourceDoc` from a control edit. Extracted so the ONE thing
 *  `update()` must not do is unit-testable without mounting `AtlasAssetView` (CLAUDE.md §
 *  Panels).
 *
 *  `update()` used to build `{ ...prev, ...patch, version: 1 as const }`, which CLOBBERED an
 *  already-versioned document's own value on every edit (#784, docs/format-versioning.md § 2b:
 *  "never echo back what you read" cuts both ways — never clobber it either). The straight fix
 *  (dropping the `version` key entirely) went too far the other way (#784 phase C adversarial
 *  review, finding 3): `normalizeAtlasBody` sets `version: d.version` — `undefined` for a
 *  versionless file — and `buildAtlasDocToPark` deletes `undefined`-valued keys, so a
 *  versionless atlas now stayed versionless through every edit, where it used to get stamped on
 *  the first one. § 2b: "doing only the refusal produces an unstamped document, which is the
 *  same defect wearing a different face." Stamp ONLY when the merged result has no version to
 *  clobber — merge first (`patch`'s own explicit `version`, if any, still wins over `prev`'s,
 *  same as a bare spread), THEN fall back to `ATLAS_FORMAT_VERSION` only if that merge left no
 *  version at all. Do not "simplify" this back to a bare spread (loses the stamp) or a literal
 *  `version: ATLAS_FORMAT_VERSION` (reclobbers a real value, including one `patch` just set). */
export function buildNextAtlasDoc(prev: AtlasSourceDoc, patch: Partial<AtlasSourceDoc>): AtlasSourceDoc {
  const merged = { ...prev, ...patch };
  return { ...merged, version: merged.version ?? ATLAS_FORMAT_VERSION };
}
