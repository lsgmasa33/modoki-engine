/** The tag that marks a `.meta.json` document as BUILT ON A FAILED READ (#880), and the two
 *  functions that produce and test it.
 *
 *  ## Why this is its own module and not part of `pendingMeta.ts`
 *
 *  Because the endpoint it protects does not live there. The panels' `/api/write-meta` POSTs all
 *  go through ONE shared helper — `writeMetaConditional` (`panels/assetViews/widgets.tsx`) — and
 *  `pendingMeta.ts` IMPORTS that, so `widgets.tsx` cannot import back without a cycle
 *  (`architecture/noNewCycles.test.ts` would fail it, correctly). A leaf both can depend on is
 *  what lets the guard sit at that helper instead of being re-implemented at each caller.
 *
 *  ⚠️ **"One shared helper" is NOT "the only POST".** `scene/modelImport.ts` posts the route
 *  directly with a raw `backendFetch`, three times, and does not pass through the helper at all —
 *  it consumes this predicate itself and ABORTS the import (see `metaCameFromFailedRead` below for
 *  why refusing its write would not be enough). Read the guard at the helper as covering the
 *  panels, not as closing the endpoint.
 *
 *  ⚠️ **That re-implementation is exactly what went wrong, twice, and is why this exists.** The
 *  #880 close-out review found the tag consumed in three separate places while there was one POST
 *  implementation — and it was the place NOT consuming it (`writeMetaOrWarn`, called directly by
 *  `SpriteEditor.save` and `NineSliceEditor.save`) that stayed unguarded. Those two are safe only
 *  because each hand-rolls its own `metaLoadedRef` boolean; a third modal editor copying their
 *  shape and forgetting that line would destroy an asset's GUID with every guard silent.
 *
 *  ## What the tag protects against
 *
 *  `/api/write-meta` replaces the sidecar WHOLESALE — it does not merge with disk — and a panel
 *  whose load failed is showing its own defaults with no `id` in hand. Write a document built on
 *  that and the scanner's heal pass MINTS A FRESH GUID, dangling every scene/prefab reference to
 *  the asset. A transient 500 on a GET destroys the asset's identity.
 *
 *  ⚠️ **THE TAG IS ON THE DOCUMENT, NOT ON THE PATH — that keying IS the fix.** This was a
 *  `Set<string>` of failed paths for three revisions, and a path cannot answer the question the
 *  guard actually asks. What matters is *"is the document about to be written the `{}`
 *  fallback?"*, which is a property of one COMPONENT's object; *"has some read of this path
 *  failed?"* is not the same question the moment two components read one path — and two do
 *  (`Inspector.tsx`'s postprocessor row and `ModelAssetView`, both on the model's path, on
 *  mount). The path-keyed version failed in both directions at once: any component's ok read
 *  CLEARED the flag a different component still needed (so the id-less park was accepted, in
 *  either response order), and while a park was live nothing could clear it at all, because
 *  `readMetaPreferringPark` returns early on a park and never reaches the network — wedging the
 *  path, and punishing the panel whose read had SUCCEEDED. Tagging the document answers per
 *  component by construction, and leaves no armed state to need clearing: a component recovers
 *  when its OWN read next succeeds.
 *
 *  ⚠️ **A SYMBOL, and every property of one is load-bearing here** (measured, not assumed):
 *   - `{...doc, field: v}` and `Object.assign` COPY own enumerable symbol keys, so the tag rides
 *     the spread every park site already does — no call site knows this exists. (No count: the
 *     old "18" went stale the first time a site was refactored, and #903 moved two of them behind
 *     `planMetaBatchWrite`, whose mutate callback does the spread instead.)
 *     ⚠️ **That propagation is TRUE BY INSPECTION, and it is NOT fully enforced — do not read
 *     `metaMergeNotClobber.test.ts` as guaranteeing it.** That rule (`clobberingMetaPayloads`)
 *     accepts a payload containing `...` ANYWHERE — a nested `{ texture: { ...cur, ...patch } }`
 *     passes with a fresh top-level object — and accepts any payload carrying a literal `id:`
 *     with no spread at all. So a 19th site written as
 *     `parkMetaEdit(p, { id: meta.id, texture: { ...settings, ...patch } })` would satisfy the
 *     merge rule, carry no tag, and on a failed read post `id: undefined` (dropped by
 *     `JSON.stringify`) — this exact destruction, with the guard silent. Every current site does
 *     spread the loaded document at the TOP level, which is what makes the tag arrive; the merge
 *     rule narrows the space a new site can occupy without closing it.
 *     ⚠️ **`READ_FOR_PATH` (below) closes that residual on the PARK route, and only there.** The
 *     hypothetical 19th site carries no stamp either, so `parkMetaEdit` refuses it — the property
 *     stopped being "every site happens to spread" and became "a site that does not spread cannot
 *     park". It is still open on the WHOLESALE-WRITE route (`writeMetaConditional`), deliberately:
 *     an explicit-action writer legitimately builds a document no read produced, so a stamp check
 *     there would refuse `ModelAssetView`'s collision-mesh write —
 *     `writeMetaWholesale(glbPath, { id: modelGuid, generated: … })`, which targets a GENERATED
 *     glb that panel never read and carries the identity the import already minted.
 *     ⚠️ `modelImport`'s three writes are NOT the example, though an earlier draft of this line
 *     said they were: that file POSTs `/api/write-meta` with a raw `backendFetch` and reaches
 *     `writeMetaConditional` at no point, so a check there would not touch it either way. What
 *     covers the wholesale route is each writer's OWN provenance gate, declared and checked in
 *     `tests/architecture/wholesaleMetaWriteProvenance.test.ts` — because the one writer that
 *     reasoned from this TAG instead of from "did a read land" had exactly the #890 hole.
 *   - `JSON.stringify` ignores symbol keys, so the tag cannot reach `/api/write-meta`, the
 *     sidecar, or a diff even if some future writer skips every guard.
 *   - `Object.keys`/`for...in` cannot see it, so no consumer of a meta document can trip over it.
 *     (vitest's `toEqual` DOES compare symbol keys — deliberate: it makes the tag assertable, and
 *     it is why the fallback assertions in `pendingMeta.test.ts` name it.)
 *   - A symbol cannot collide with a sidecar field, now or after any schema change — a sidecar is
 *     JSON, and `JSON.parse` cannot produce a symbol-keyed property at all, so no file on disk
 *     (corrupt, hand-edited or hostile) can forge the tag and make an asset permanently
 *     unsaveable.
 *
 *  ⚠️ **`Symbol.for`, not `Symbol` — the identity has to survive a second module instance.**
 *  An unregistered symbol is unique per module EVALUATION, so the guard would have been correct
 *  only because every importer happens to use a relative specifier that resolves to one id. That
 *  is an invariant held by nothing, invisible to every test, and it fails OPEN: the day someone
 *  writes `import { metaCameFromFailedRead } from '@modoki/engine'` and gets a second instance,
 *  the producer's symbol and the consumer's predicate stop matching and every tagged document is
 *  silently accepted — with the suites still green, because each loads one instance. The global
 *  registry is per-realm, so `Symbol.for` makes two instances resolve to the SAME symbol and the
 *  failure stops being representable rather than merely being absent today.
 *
 *  The key is namespaced (`modoki.`) for the one property registration costs: a registered symbol
 *  CAN collide, on its string key, with any other code calling `Symbol.for` with the same string.
 *  Everything else above survives unchanged — measured, not assumed: spread and `Object.assign`
 *  still copy it, `JSON.stringify` still drops it, `Object.keys` still cannot see it, and vitest's
 *  `toEqual` still compares it. */
const FROM_FAILED_READ = Symbol.for('modoki.pendingMeta.fromFailedRead');

/** The document a FAILED `/api/read-meta` yields — `{}`, tagged so a park or a write built on it
 *  is refused.
 *
 *  ⚠️ **A declared raw-read exemption must not hand back a bare `{}`.**
 *  `readMetaPreferringPark` uses this for the blessed path; a file exempted from that helper
 *  (`VideoAssetView`, which keeps a third piece of state that must reflect DISK) builds its own
 *  fallback, which without this would be untagged and free to park an id-less document — the
 *  exact shape of #871's trap, where an exemption from the READ HELPER was read as an exemption
 *  from what the response teaches. `metaReadPreferringPark.test.ts` enforces that every exempted
 *  raw reader calls this rather than writing `{}` itself. */
export function metaReadFallback(): Record<string, unknown> {
  return { [FROM_FAILED_READ]: true };
}

/** Was `doc` built on a failed read — i.e. does it carry the tag, directly or through any number
 *  of the spreads its panel made on the way here?
 *
 *  Consumed in three places, and they are three different QUESTIONS rather than three copies of
 *  one guard — check that distinction before adding a fourth:
 *
 *   - `writeMetaConditional` (`assetViews/widgets.tsx`) — **the endpoint.** The last thing before
 *     the POST, so it covers every writer including ones that reach it directly.
 *   - `parkMetaEdit` (`pendingMeta.ts`) — **earlier, on purpose.** It refuses at EDIT time rather
 *     than at save time, so the human is told while they are looking at the control instead of
 *     N edits later at Cmd+S. Not redundant with the endpoint check; it is a better moment.
 *   - `readMeta` (`scene/modelImport.ts`) — **a different consequence.** That file POSTs
 *     `/api/write-meta` with a raw `backendFetch` and reads the sidecar to PRESERVE the model's
 *     guid (`existingMeta.id ?? newGuid()`), so a failed read does not write a document with no
 *     `id` — it writes one with a DIFFERENT id, which the heal pass never flags because the
 *     sidecar looks complete. Refusing the write is not enough there; the whole import aborts. */
export function metaCameFromFailedRead(doc: unknown): boolean {
  return typeof doc === 'object' && doc !== null && (doc as Record<symbol, unknown>)[FROM_FAILED_READ] === true;
}

/** The path a `.meta.json` document was READ FOR (#890/#891/#897) — the same mechanism as
 *  `FROM_FAILED_READ` one notch wider, and deliberately in the same module because it answers the
 *  same question at the same seam.
 *
 *  ## What it is for
 *
 *  `FROM_FAILED_READ` asks *"was this document built on a failed read?"*. Two destructions slip
 *  past that, and both were driven or confirmed on `main`:
 *
 *   - **no read at all** (#890). `readMetaPreferringPark` does not swallow a THROWN fetch, so the
 *     panel's `.catch(() => {})` leaves `meta === null` and its next field change parks
 *     `{ ...(meta ?? {}), … }` — a document with no `id` and **no tag**, because a rejected fetch
 *     produces no response to tag. Cmd+S writes it wholesale, the scanner's heal pass mints a
 *     fresh GUID, and every scene/prefab ref to that asset dangles.
 *   - **a read of the WRONG PATH** (#891, and #897 on the sibling registry). Nothing remounts an
 *     asset panel when the selection changes, so the instance keeps asset A's document while
 *     `path` is already asset B; an edit then parks A's document — `id` included — under B's path.
 *     That document was genuinely read and is correctly untagged, so `FROM_FAILED_READ` is blind
 *     to it by construction. It is the WORSE of the two: two assets claim one GUID.
 *
 *  Both are the same sentence: **the panel parked a document it never read for that path.** So the
 *  document carries the path it was read for, and `parkMetaEdit` refuses anything else.
 *
 *  ## Why this is one predicate and not two guards
 *
 *  A missing stamp and a foreign stamp are the same failure at different distances, and `!== path`
 *  covers both with no branch to get wrong. It also fails CLOSED on the hole `FROM_FAILED_READ`'s
 *  own docblock documents above: a 19th park site written as
 *  `parkMetaEdit(p, { id: meta.id, texture: { ...settings, ...patch } })` satisfies
 *  `clobberingMetaPayloads` (a nested spread, a literal `id:`) and carries no top-level spread —
 *  so it would carry no tag, and on a failed read post `id: undefined`. It carries no STAMP
 *  either, so it is now refused rather than silently destructive. The spread convention stops
 *  being documented and starts being enforced.
 *
 *  ## Properties — the same ones `FROM_FAILED_READ` establishes, and for the same reasons
 *
 *  A `Symbol.for` key: it rides the top-level spread every park site already does, `JSON.stringify`
 *  drops it so it can never reach `/api/write-meta` or the sidecar, `Object.keys`/`for...in` cannot
 *  see it, no file on disk can forge it, and the global registry makes it survive a second module
 *  instance (an unregistered `Symbol` would fail OPEN across two copies of this module — see the
 *  `Symbol.for` note above, which is this key's reasoning verbatim).
 *
 *  ⚠️ **A COPY, not a mutation.** `readMetaPreferringPark` returns the registry's own object as
 *  `pendingRef` when a park exists, and that reference IS `metaWrittenToDisk`'s version stamp —
 *  stamping in place would write through to the registry entry. Copying costs one shallow spread
 *  per read and makes the aliasing question not arise. */
const READ_FOR_PATH = Symbol.for('modoki.pendingMeta.readForPath');

/** `doc`, stamped as having been read for `path`. Returns a COPY (see above).
 *
 *  Called by `readMetaPreferringPark` — the blessed reader — and by the two callers that
 *  legitimately produce a document outside it:
 *
 *   - `VideoAssetView`, the declared raw-read exemption, which must stamp its own read exactly as
 *     it must call `metaReadFallback()` for its own failure (`metaReadPreferringPark.test.ts`
 *     enforces both);
 *   - `applyMovesToParkedMeta` (`assetEditorBindings.ts`), which re-parks a live edit under its
 *     NEW path after a rename — the one place a document legitimately changes which path it
 *     belongs to, and it says so by re-stamping rather than by an exemption in the guard. */
export function stampMetaReadPath(doc: Record<string, unknown>, path: string): Record<string, unknown> {
  // ⚠️ A FAILED-READ FALLBACK IS NEVER STAMPED, and this is enforced rather than documented.
  // "Subsumes the tag" is an argument several consumers now lean on — `EnvironmentAssetView.apply`
  // dropped its own `metaCameFromFailedRead` check on the strength of it — and it holds only
  // because no producer stamps a fallback today. That is a coincidence between two call sites, and
  // this function's own docblock invites the collision: it tells an exempted raw reader to stamp
  // its read exactly as it must call `metaReadFallback()` for its failure, so a reader obeying
  // both sentences literally would write `stampMetaReadPath(metaReadFallback(), path)` and produce
  // a document that is tagged AND correctly stamped — accepted by every consumer that trusted the
  // subsumption. Returning it unstamped makes that state unrepresentable for one line.
  if (metaCameFromFailedRead(doc)) return doc;
  return { ...doc, [READ_FOR_PATH]: path };
}

/** The path `doc` was read for, or `undefined` when it carries no stamp — which means nothing was
 *  ever read for it (the `null`-seeded panel of #890, or a document built by hand).
 *
 *  ⚠️ `undefined` is NOT "unknown, so proceed". `parkMetaEdit` compares it against the path being
 *  parked and refuses on any mismatch, absent included: a document nobody read is exactly the
 *  id-less document that costs an asset its GUID. */
export function metaReadPathOf(doc: unknown): string | undefined {
  if (typeof doc !== 'object' || doc === null) return undefined;
  const v = (doc as Record<symbol, unknown>)[READ_FOR_PATH];
  return typeof v === 'string' ? v : undefined;
}
