/** The shared format-version classifier — one verdict, computed the same way everywhere.
 *
 *  **Read `docs/format-versioning.md` before changing anything here.** That doc is the design
 *  for every versioned document in the repo; this module is its § 2a.
 *
 *  ## Why this exists
 *
 *  The question "is this document newer than my build?" was answered five times in four different
 *  shapes (#630, #734, #730, #629) before anyone wrote the rule down, and a census of all eight
 *  versioned-document sites found eight *different* collapses of the same four-way distinction.
 *  Exactly one site compared correctly (`plugins/meta-sidecar.ts`, strictly-greater); exactly one
 *  had the union shape (`storage/playerPrefs.ts`); none had both.
 *
 *  The root cause was never the comparison. It was that every site fused **the verdict** (*what is
 *  this document relative to my build?*) with **the disposition** (*what do I do about it?*) into a
 *  single boolean expression — so each site re-derived both at once and collapsed whichever
 *  verdicts its chosen disposition happened not to need. The collapse is the damage: once `absent`
 *  and `unreadable` are the same answer, the write path can no longer tell a document that is safe
 *  to replace from one that must be preserved, and #778's `writeAssetGuid` destroyed authored
 *  sidecar fields for exactly that reason.
 *
 *  So: **this module computes the verdict and nothing else.** It deliberately does not decide, log,
 *  throw or write. The disposition is the caller's, chosen from the bounded menu in § 2b-bis of
 *  the doc (REFUSE for machine-generated artifacts that are a unit; PRESERVE for documents holding
 *  the player's own data), and the *channel* it speaks through stays local per § 2c.
 *
 *  ## The one invariant that binds both dispositions
 *
 *  **Never stamp your version onto a document you could not fully read.** REFUSE honours it by not
 *  writing at all; PRESERVE honours it via {@link preservedVersion}. A reader that merely fails to
 *  understand a document is harmless — a writer that re-stamps its own number over one it could not
 *  read has silently destroyed the only signal a future migration has.
 */

/** Why a document could not be classified. Kept distinct from the *verdict* so a caller can say
 *  something useful; all three mean "this build cannot trust the version field". */
export type UnreadableReason =
  /** The bytes are not JSON at all — a truncated write, or (the case #778 was filed for) a
   *  `.meta.json` carrying unresolved `<<<<<<<` conflict markers. */
  | 'unparsable'
  /** Parsed, but the document is not a JSON object (a bare array, string, number or `null`). */
  | 'not-an-object'
  /** An object, but the version field is present and is not a finite integer (`"2"`, `2.5`, `NaN`).
   *  A format version is an integer by construction; a non-integer is malformed data, not a
   *  version this build merely does not know. */
  | 'non-numeric-version';

/** What a stored document is, relative to the build that is reading it.
 *
 *  ⚠️ **Five verdicts, where `docs/format-versioning.md` § 2a originally defined four.** `too-old`
 *  is not a refinement — `games/wordweave/runtime/store.ts` already needs it
 *  (`MIN_READABLE_PURCHASES_VERSION`), and #767's IAP ledger needs it too. Folding "below the
 *  readable floor" into `unreadable` would rebuild the exact verdict/disposition fusion this module
 *  exists to remove: a floor is a deliberate, bounded refusal to read, whereas `unreadable` is
 *  "these bytes are damaged". They call for opposite handling. */
export type FormatVerdict =
  /** At or below this build's version, and at or above the caller's floor — readable, possibly
   *  after a migration. */
  | { kind: 'ok'; version: number }
  /** **Strictly** greater than this build's version. Structurally intact, semantically unknown —
   *  protect it. */
  | { kind: 'too-new'; version: number }
  /** Below the caller's `minReadable` floor. Only ever returned when a floor was passed. */
  | { kind: 'too-old'; version: number }
  /** No version field at all — legacy, or a document this build just created. Readable. */
  | { kind: 'absent' }
  /** Corrupt or malformed. Safe to replace ONLY if the caller's document has no authored content
   *  worth preserving — see #778 for what that assumption cost once. */
  | { kind: 'unreadable'; reason: UnreadableReason };

export interface ClassifyOptions {
  /** The property holding the format version. Defaults to `'version'`; the OTA and sub-game
   *  manifests use `'schema'`, and the IAP documents use `'v'`. */
  field?: string;
  /** Lowest version this build is willing to read. Omit for "read anything not too new" — the
   *  common case. Passing it opts into the `too-old` verdict. */
  minReadable?: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Classify an already-parsed document against this build's format constant.
 *
 * ⚠️ **Strictly greater only.** `too-new` is `stored > current`, never `>=` and never `!==`. A `>=`
 * refuses every document including the ones this build just wrote; a `!==` (the shape found at four
 * of the eight sites) additionally reports every OLDER document as unreadable, which is how a
 * migration ladder's own inputs get rejected.
 *
 * `current` is this build's constant. It is a required argument rather than a lookup because the
 * module that owns a format owns its number (§ 2b) — there is deliberately no registry here to fall
 * out of date.
 */
export function classifyFormatVersion(
  raw: unknown,
  current: number,
  opts: ClassifyOptions = {},
): FormatVerdict {
  const { field = 'version', minReadable } = opts;
  if (!isRecord(raw)) return { kind: 'unreadable', reason: 'not-an-object' };

  const v = raw[field];
  // An explicit `undefined` and a missing key are the same thing to JSON, and both mean "this
  // document predates the field" — which is readable, not damaged.
  if (v === undefined) return { kind: 'absent' };
  if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v)) {
    return { kind: 'unreadable', reason: 'non-numeric-version' };
  }

  // Floor before ceiling: they cannot both apply for a sane `minReadable <= current`, and checking
  // the floor first keeps a nonsensical floor from silently reporting `ok`.
  if (minReadable !== undefined && v < minReadable) return { kind: 'too-old', version: v };
  if (v > current) return { kind: 'too-new', version: v };
  return { kind: 'ok', version: v };
}

/**
 * Classify a document straight from its bytes, mapping a parse failure to
 * `unreadable`/`'unparsable'`.
 *
 * This is the entry point every on-disk caller should use. Reading the text and parsing it
 * separately is what produced #778: `versionOnDisk` swallowed `JSON.parse`'s throw and returned
 * `undefined`, the same value it returned for "no version field" — so the guard above it read a
 * corrupt sidecar as an absent version and **failed open on precisely the input it existed to
 * catch**.
 */
export function classifyJsonFormatVersion(
  text: string,
  current: number,
  opts: ClassifyOptions = {},
): FormatVerdict {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: 'unreadable', reason: 'unparsable' };
  }
  return classifyFormatVersion(parsed, current, opts);
}

/** True when the verdict says this build may read the document's known fields. `absent` and `ok`
 *  are readable; `too-new` is readable only under the PRESERVE disposition, which is why that
 *  choice is the caller's and is not encoded here. */
export function isReadable(verdict: FormatVerdict): boolean {
  return verdict.kind === 'ok' || verdict.kind === 'absent';
}

/**
 * The version a PRESERVE-disposition writer must stamp back.
 *
 * Returns the higher of what was stored and what this build writes, so a `v2` document read by a
 * `v1` build still says `v2` on disk afterwards — otherwise the newer build sees `v1` and cannot
 * tell that its document was stripped by an older one (#735).
 *
 * ⚠️ **This rule does NOT transfer to a document with a version-GATED field, and that is not a
 * hypothetical.** #763's close-out caught exactly this: `readProgress` keeps `activeGuid` only when
 * the stored version is readable, so preserving the higher `v` while rewriting that field made the
 * document claim semantics the writing build did not implement — it disarmed the version floor for
 * the one field the floor exists to protect. **Before calling this, check that every field you are
 * about to write is one this build actually implements at the version being claimed.** If any field
 * is conditional on the version, this helper is the wrong tool and the document needs its own
 * decision.
 *
 * A malformed or absent version normalizes to `current` rather than being preserved: it is not
 * "the higher of the two", it is damaged data, and normalizing it is correct.
 */
export function preservedVersion(verdict: FormatVerdict, current: number): number {
  if (verdict.kind === 'ok' || verdict.kind === 'too-new') {
    return Math.max(verdict.version, current);
  }
  return current;
}

/**
 * Collect the keys this build does not know about, so a writer can carry them through.
 *
 * Returns `undefined` — not `{}` — when there is nothing unknown, so an ordinary document's
 * serialized shape is unchanged and a round trip produces a minimal diff.
 *
 * The additive rule (owner, 2026-09-05): an old build reading a document a NEWER build wrote must
 * read the fields it understands and carry the rest through untouched. #735 and #763 each
 * hand-rolled this bag, **in the same game**, and review still caught a real defect in the second
 * one — which is why it is shared now rather than transcribed a third time.
 */
export function collectUnknownFields(
  raw: unknown,
  known: readonly string[],
): Record<string, unknown> | undefined {
  if (!isRecord(raw)) return undefined;
  const knownSet = new Set(known);
  const bag: Record<string, unknown> = {};
  let any = false;
  for (const [key, value] of Object.entries(raw)) {
    if (knownSet.has(key)) continue;
    bag[key] = value;
    any = true;
  }
  return any ? bag : undefined;
}

/**
 * Merge a preserved bag back under the fields this build owns.
 *
 * ⚠️ **The bag spreads FIRST and the known fields LAST**, so a key this build understands always
 * wins over a stale copy of itself in the bag. Getting this backwards would let a document's own
 * unknown-key bag overwrite the values the build just computed — including, in the IAP case, the
 * coin balance.
 */
export function mergeUnknownFields(
  known: Record<string, unknown>,
  bag: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return bag ? { ...bag, ...known } : { ...known };
}
