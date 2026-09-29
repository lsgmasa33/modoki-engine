/** The undo/redo of an asset-DOCUMENT edit — a material, clip, particle effect, sprite animation, timeline, rig or
 *  shader edited in its panel or by an agent op (`_isFileDirect`) — checks that the asset still holds the document on
 *  its own side before moving it to the other (#1710).
 *
 *  WHY. These entries outlive the world they were recorded in: `parkSurvivors` keeps them across every discarding
 *  history swap (#1409), leaving prefab edit included (#1704, prefabs.md U27). So by the time one runs, the asset can
 *  have been changed by another scene's history, a save, an agent op or an outside write — and the step used to re-park
 *  its whole old document regardless, reverting that change, which the next save then wrote. Tint M in S1 and save,
 *  change M's roughness in S2 and save, Cmd+Z in S1: the roughness went too.
 *
 *  WHAT "HOLDS" MEANS. These steps PARK (#831) — the save is the write — so the asset's document is the one the next
 *  save would leave on disk:
 *   - **parked**: the parked doc. It must equal the expected side (key order ignored — it is what the flush writes).
 *   - **not parked**: the file. Its CURRENT bytes are hashed and must equal the hash of bytes known to encode the
 *     expected side. Two such records exist, and both are real written bytes, never a re-serialisation:
 *       - the route's hash of this session's last flush of the path, when that flush wrote the expected doc
 *         (`getLastFlushedWrite`);
 *       - the file's hash when the entry was RECORDED, when nothing was parked then — the file held `before` — and the
 *         expected side is `before` (`captureAssetDocBaseline`, which is why it runs before the forward edit parks).
 *     Not "the file parses to the expected doc": a loader can migrate what it reads (a legacy particle `gravity: 6`
 *     loads as `[0,-6,0]`), so the doc a panel holds need not be the one its file parses to, and every step on such an
 *     asset would refuse.
 *  An absent or unreadable file holds nothing. A mismatch throws `assetChangedRefusal` (#1664/#1679's
 *  `UndoRefusedError`): nothing is applied and the entry is dropped with a toast saying why.
 *
 *  AND THE SAVE AFTER IT. A check at step time says nothing about the minutes until Cmd+S, so the target is parked with
 *  `ifMatch` = the file's hash as the step read it, and the flush makes it `/api/asset-write`'s precondition: an outside
 *  write in between is refused at the route, the park stays, and the save toast names the file (`DirtyAsset.ifMatch`).
 *
 *  AND WHETHER TO PARK AT ALL. The step parks its target itself rather than leaving it to the panel. The five hook
 *  editors (`useParkedAssetDoc`) park reactively, only while open on that path, so an undo with the editor closed moved
 *  the cache and left the undone doc parked, which the next save wrote back. When the file already holds the target —
 *  an edit undone back to the saved state — the park is DISCARDED instead, so that reads as clean, as the hook's own
 *  identity check made it read while the editor was open. */

import type { UndoAction } from './undoManager';
import { UndoRefusedError } from './undoFailure';
import {
  peekDirtyAsset, isAssetDirty, markAssetDirty, discardDirtyAssets, getLastFlushedWrite, getAssetWriteEpoch,
  assetWritesSettled, assetWriteInFlight, assetCacheDiverged, type AssetWriteOrigin,
} from '../scene/dirtyAssets';
import type { AssetSchemaType } from '../../runtime/assets/assetSchemas';
import { sha256OfBytes } from '../utils/contentHash';
import { assetUrl } from '../../runtime/loaders/assetUrl';
import { isHtmlFallthrough } from '../../runtime/loaders/assetFetch';
import { currentAssetPath, assetMoveMark } from '../utils/assetMoveLog';

/** What the file held when an entry was recorded: its hash, when nothing was parked for it — the file then holds the
 *  entry's `before`. Null when something was parked (the file is some older doc) or the read failed. */
export interface AssetDocBaseline {
  path: string; before: unknown; diskHash: Promise<string | null> | null;
  /** The Assets move log's length when this was taken (`assetMoveMark`): a step follows only the moves made after it. */
  moveMark: number;
}

/** The file's current bytes as the route hashes them (`ifMatchRefusal`: BOM stripped), or null when it is absent, the
 *  SPA fallback, or unreadable. A hash that cannot be computed (no `crypto.subtle`) is a REFUSAL, not a null — the
 *  caller has not checked anything yet. */
async function currentFileHash(path: string): Promise<string | null> {
  let bytes: Uint8Array;
  try {
    const res = await fetch(assetUrl(path), { cache: 'no-store' });
    if (!res.ok) return null;
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch { return null; }
  if (isHtmlFallthrough(new TextDecoder().decode(bytes.subarray(0, 512)))) return null;
  try {
    return await sha256OfBytes(bytes);
  } catch (e) {
    throw new UndoRefusedError(
      `${path} was left as it is: its bytes could not be hashed to check them (${e instanceof Error ? e.message : String(e)}).`,
      `${path.split('/').pop()} could not be checked before changing it (see console)`,
    );
  }
}

/** Take `path`'s baseline. Call it BEFORE the forward edit parks, or `isAssetDirty` answers for the edit itself. */
export function captureAssetDocBaseline(path: string, before: unknown): AssetDocBaseline {
  // Parked, or the cache kept a discarded edit: either way the file does not hold `before`.
  const moveMark = assetMoveMark();
  if (isAssetDirty(path) || assetCacheDiverged(path)) return { path, before, diskHash: null, moveMark };
  // A save of this path that STARTS before the read resolves may have been read instead of `before`'s bytes: drop it.
  const epoch = getAssetWriteEpoch(path);
  const diskHash = currentFileHash(path).then((h) => (getAssetWriteEpoch(path) === epoch ? h : null)).catch(() => null);
  return { path, before, diskHash, moveMark };
}

/** Equality of two asset documents as their files would hold them: key order ignored, `undefined` members dropped
 *  (JSON's own rules — the flush serialises with `JSON.stringify`). */
export function sameAssetDoc(a: unknown, b: unknown): boolean {
  return a === b || canonical(a) === canonical(b);
}
function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) => (x && typeof x === 'object' && !Array.isArray(x)
    ? Object.fromEntries(Object.keys(x as object).sort().map((k) => [k, (x as Record<string, unknown>)[k]]))
    : x));
}

/** Does the NOT-parked file hold `doc`? `fileHash` is its current bytes' hash (null: absent/unreadable); `baseHash`
 *  the file's hash when the entry was recorded (null: something was parked then, or the read failed). Synchronous on
 *  purpose — see `runAssetDocStep`. */
function fileHolds(path: string, doc: unknown, fileHash: string | null, baseline: AssetDocBaseline, baseHash: string | null): boolean {
  if (fileHash === null) return false;
  const flushed = getLastFlushedWrite(path);
  if (flushed && flushed.sha256 === fileHash && sameAssetDoc(flushed.data, doc)) return true;
  return baseHash !== null && baseHash === fileHash && sameAssetDoc(baseline.before, doc);
}

/** The refusal for an asset-doc step whose asset no longer holds its side (#1710). `fileChangedRefusal`'s sibling —
 *  its wording says "on disk", which is false for a parked doc another edit replaced. */
export function assetChangedRefusal(paths: readonly string[]): UndoRefusedError {
  const one = paths.length === 1;
  const name = one ? paths[0].split('/').pop() : `${paths.length} assets`;
  return new UndoRefusedError(
    `${paths.join(', ')} ${one ? 'does' : 'do'} not hold what this step left there — changed since by another edit, ` +
    'a save from elsewhere, or a write outside the editor — so nothing was applied.',
    `${name} changed since, and ${one ? 'was' : 'were'} left as ${one ? 'it is' : 'they are'}`,
  );
}

export interface AssetDocSide {
  path: string;
  type: AssetSchemaType;
  baseline: AssetDocBaseline;
  /** The doc this step expects the asset to hold now. A thunk: a coalescing editor moves its `_after` after the push. */
  expected: () => unknown;
  /** The doc this step moves the asset to. */
  target: () => unknown;
}

/** Run one asset-doc step over every side: check them ALL (one mismatch refuses the whole step, so a batch edit is
 *  never half-undone), then `apply` each target to the live cache/panel and settle its park. */
export async function runAssetDocStep(
  recordedSides: readonly AssetDocSide[], apply: (path: string, doc: unknown) => void, origin: AssetWriteOrigin,
): Promise<void> {
  // Where each asset is NOW (#1868): an Assets Rename or move is not undoable, so it no longer unwinds before this step,
  // and the step follows the asset as Unity's does. A deleted one refuses, saying so — "changed since" would be false.
  const now = (s: AssetDocSide) => currentAssetPath(s.path, s.baseline.moveMark);
  const gone = recordedSides.filter((s) => now(s) === null).map((s) => s.path);
  if (gone.length) {
    throw new UndoRefusedError(
      `${gone.join(', ')} ${gone.length === 1 ? 'was' : 'were'} deleted since, so nothing was applied.`,
      `${gone.length === 1 ? gone[0].split('/').pop() : `${gone.length} assets`} ${gone.length === 1 ? 'was' : 'were'} deleted since`,
    );
  }
  const sides = recordedSides.map((s) => ({ ...s, path: now(s)! }));
  // Every read first — the file's bytes and the recorded baseline's — so from the checks through the last apply there
  // is no await: nothing (a panel edit, another step) can land between "holds" and "moved".
  //
  // ⚠️ And never a read a SAVE of the same path overlaps (#1710 close-out review): read while the flush is in flight,
  // the pre-save bytes let the step discard its park as "the file holds the target", and the flush then landed the
  // other doc. So wait for any flush writing these paths to end, read, and read again if one started meanwhile.
  const paths = sides.map((s) => s.path);
  let hashes: Array<string | null> = [];
  let baseHashes: Array<string | null> = [];
  for (let attempt = 0; ; attempt++) {
    await assetWritesSettled(paths);
    const epochs = paths.map(getAssetWriteEpoch);
    [hashes, baseHashes] = await Promise.all([
      Promise.all(paths.map((p) => currentFileHash(p))),
      Promise.all(sides.map((s) => s.baseline.diskHash ?? null)),
    ]);
    // A flush that started after the wait (epoch moved), or is still writing (it started between the wait resuming and
    // the snapshot), may have been read instead of the settled file: read again.
    if (paths.every((p, i) => getAssetWriteEpoch(p) === epochs[i] && !assetWriteInFlight(p))) break;
    if (attempt === 2) {
      throw new UndoRefusedError(
        `${paths.join(', ')} kept being saved while this step read it, so nothing was applied.`,
        `${paths.length === 1 ? paths[0].split('/').pop() : `${paths.length} assets`} was being saved — try again once the save is done`,
      );
    }
  }
  const plans: Array<{ side: AssetDocSide; wasParked: boolean; target: unknown; hash: string | null; holdsTarget: boolean }> = [];
  const refused: string[] = [];
  sides.forEach((side, i) => {
    const parked = peekDirtyAsset(side.path);
    const expected = side.expected();
    const target = side.target();
    const holdsTarget = fileHolds(side.path, target, hashes[i], side.baseline, baseHashes[i]);
    // Nothing parked and the file ALREADY holds the target: the step moves nothing on disk, only the live cache back
    // to the file — the edit was discarded, say (`discardDirtyAssets` keeps the cache on the edit). Refusing there
    // stranded the cache on a doc no save writes and no undo reaches (#1710 close-out review).
    const holds = parked ? sameAssetDoc(parked.data, expected)
      : fileHolds(side.path, expected, hashes[i], side.baseline, baseHashes[i]) || holdsTarget;
    if (!holds) { refused.push(side.path); return; }
    plans.push({ side, wasParked: !!parked, target, hash: hashes[i], holdsTarget });
  });
  // All or nothing: one side that moved refuses the whole step, so a batch edit is never half-undone.
  if (refused.length) throw assetChangedRefusal(refused);
  for (const { side, wasParked, target, hash, holdsTarget } of plans) {
    apply(side.path, target);
    if (holdsTarget) discardDirtyAssets([side.path]);
    // Over the FILE, the save is conditional on the bytes this step checked. Over a park, that park's own `ifMatch`
    // (if any) stands: replacing it with the current hash would erase a conflict the park is already carrying.
    else markAssetDirty(side.path, side.type, target, origin, wasParked ? undefined : hash ?? undefined);
  }
}

/** The whole `_isFileDirect` entry for an edit of ONE asset document from `before` to `after()`. Take it BEFORE the
 *  forward edit parks (see `captureAssetDocBaseline`). `apply` moves the live cache and panel only — parking is this
 *  module's. */
export function assetDocAction<T>(o: {
  label: string; path: string; type: AssetSchemaType; before: T; after: () => T;
  /** Moves the live cache and panel to `doc` for the asset at `path` — where it is NOW, which a Rename since the edit
   *  moved (#1868); use it, not a path captured at the edit. */
  apply: (doc: T, path: string) => void; origin?: AssetWriteOrigin; kind?: UndoAction['kind'];
  /** A baseline taken EARLIER, for an edit whose document was parked before its entry could be pushed: a gesture that
   *  moves the live doc on every pointer move and pushes one entry at pointer-up (the rig canvas's drags). Taken at the
   *  gesture's start, where it names the same `before`; one for another path is ignored. */
  baseline?: AssetDocBaseline | null;
}): UndoAction {
  const baseline = o.baseline && o.baseline.path === o.path && o.baseline.before === o.before
    ? o.baseline : captureAssetDocBaseline(o.path, o.before);
  const origin = o.origin ?? 'panel';
  const step = (expected: () => T, target: () => T) => () => runAssetDocStep(
    [{ path: o.path, type: o.type, baseline, expected, target }], (p, d) => o.apply(d as T, p), origin,
  );
  return {
    label: o.label,
    _isFileDirect: true,
    undo: step(o.after, () => o.before),
    redo: step(() => o.before, o.after),
    ...(o.kind !== undefined ? { kind: o.kind } : {}),
  };
}
