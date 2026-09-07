/** The tag that marks a `.meta.json` document as BUILT ON A FAILED READ (#880), and the two
 *  functions that produce and test it.
 *
 *  ## Why this is its own module and not part of `pendingMeta.ts`
 *
 *  Because the endpoint it protects does not live there. `/api/write-meta` has exactly ONE POST
 *  implementation in the package — `writeMetaConditional` (`panels/assetViews/widgets.tsx`) —
 *  and `pendingMeta.ts` IMPORTS that, so `widgets.tsx` cannot import back without a cycle
 *  (`architecture/noNewCycles.test.ts` would fail it, correctly). A leaf both can depend on is
 *  what lets the guard sit at the endpoint instead of being re-implemented at each caller.
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
 *     the spread all 18 park sites already do — no call site knows this exists.
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
 *   - `JSON.stringify` ignores symbol keys, so the tag cannot reach `/api/write-meta`, the
 *     sidecar, or a diff even if some future writer skips every guard.
 *   - `Object.keys`/`for...in` cannot see it, so no consumer of a meta document can trip over it.
 *     (vitest's `toEqual` DOES compare symbol keys — deliberate: it makes the tag assertable, and
 *     it is why the fallback assertions in `pendingMeta.test.ts` name it.)
 *   - A symbol cannot collide with a sidecar field, now or after any schema change. */
const FROM_FAILED_READ = Symbol('pendingMeta.fromFailedRead');

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
