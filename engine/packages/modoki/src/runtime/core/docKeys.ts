/**
 * Document-supplied strings used as object keys (#986) — the engine's two primitives.
 *
 * ── THE MECHANISM ────────────────────────────────────────────────────────────────────────
 * A string read out of a scene, prefab, `.spriteanim.json`, `.anim.json`, shader manifest or an
 * agent-tool payload is used as a key on a PLAIN object, so `Object.prototype`'s own members
 * become indistinguishable from real entries — in BOTH directions:
 *
 *  - **write** — `bag[k] = v` for `k === '__proto__'` hits `Object.prototype`'s SETTER. No own key
 *    is created, the value is silently lost, and the bag's prototype is replaced by document data.
 *  - **read** — `k in bag` / `bag[k]` answers for all **eight** member names (`__proto__`,
 *    `constructor`, `toString`, `valueOf`, `hasOwnProperty`, `isPrototypeOf`,
 *    `propertyIsEnumerable`, `toLocaleString`) even when absent, so the caller takes the wrong arm
 *    — and `bag[k]` hands back a FUNCTION where a value was expected.
 *
 * ⚠️ **It is not `__proto__`-specific, and a sweep that looks only for that name under-reports it.**
 * Only `__proto__` uses a setter; the other seven are ordinary own keys on assignment and already
 * reach every `in`/`[]` site. The read half is the majority of the sites in this engine.
 *
 * ── WHICH PRIMITIVE: *ask where the object came from* ────────────────────────────────────
 * That question is the whole decision procedure (docs/format-versioning.md § 4b):
 *
 *  - **A bag WE build** → start it with {@link emptyDocMap}. Every downstream `bag[k]` and
 *    `k in bag` then becomes correct where it stands and needs no edit, which is why this is
 *    preferred: the rule cannot be forgotten rather than merely being available.
 *  - **A bag that ARRIVES** — a caller's argument, a code-declared lookup table (`WRAP`, `SHAPE`,
 *    a koota trait schema), an `Object.fromEntries` result — → a null prototype cannot help, and
 *    the fix is {@link hasDocKey} at the read.
 *
 * ── ⚠️ THE ONE THING A NULL PROTOTYPE GENUINELY BREAKS ───────────────────────────────────
 * A DIRECT method call on the bag: `bag.hasOwnProperty(k)`, `bag.toString()`. Those throw. Every
 * engine site converted in #986 was checked for this first, and the convention that keeps it safe
 * is `Object.prototype.hasOwnProperty.call(bag, k)` — which is what {@link hasDocKey} is. **A new
 * direct method call on a doc map is the thing that would break this.**
 *
 * Everything else survives, and this is measured rather than assumed (#912 § 4b):
 * `JSON.stringify` is unaffected; `JSON.parse(JSON.stringify(x))` and `structuredClone` both keep
 * the keys and hand back an ORDINARY prototype, so nothing null-prototyped reaches storage;
 * `{ ...bag }`, `Object.keys/entries/assign` and `for…of Object.entries` all behave identically.
 *
 * ⚠️ **#813 rejected this shape on an argument nobody had tested** — that these bags are
 * `JSON.stringify`d and uploaded, so a null prototype might not survive. That inherited rejection
 * kept the class alive through four review rounds and is **refuted by measurement** in § 4b. Do not
 * re-inherit it.
 *
 * ── NAMING ───────────────────────────────────────────────────────────────────────────────
 * {@link emptyDocMap} deliberately matches `games/court/runtime/saveSync.ts`'s helper name (#912,
 * landed first). A game cannot import from the engine's internals nor from another game, so the
 * two cannot literally share code today — but one vocabulary across the repo is worth more than two
 * accurate-but-different names, and it is what lets Court and wordweave converge on this later.
 */

/**
 * An empty bag whose keys will come from a document.
 *
 * `Object.create(null)` has no prototype, so `'__proto__'`, `'toString'` and the other six are
 * ordinary absent keys: assignment creates a real own key and `in`/`[]` answer honestly.
 */
export function emptyDocMap<T = unknown>(): Record<string, T> {
  return Object.create(null) as Record<string, T>
}

/**
 * Does `bag` have `key` as its OWN property?
 *
 * Use at every read of a document-supplied key against a bag this code did not build with
 * {@link emptyDocMap} — `key in bag` and a truthiness test on `bag[key]` are both wrong there.
 *
 * Works on ordinary AND null-prototype objects, which is why it is safe to reach for without first
 * establishing which kind you have.
 */
export function hasDocKey(bag: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(bag, key)
}

/**
 * Write `value` onto `bag` under a document-supplied `key` as an OWN data property.
 *
 * ⚠️ For the bag you did NOT build and cannot convert — one that is handed to you already made
 * (a spread of a live object, an `Object.fromEntries` result), or one that must keep an ordinary
 * prototype because it crosses into a third-party library. {@link emptyDocMap} is still preferred
 * wherever the bag is yours: there the rule cannot be forgotten, whereas this one has to be
 * reached for.
 *
 * `bag[key] = value` is the wrong tool there and it fails SILENTLY: for `key === '__proto__'` it
 * hits `Object.prototype`'s setter, so no own key is created, the value is lost, and the bag's
 * prototype becomes document data. `defineProperty` DEFINES instead of setting, so the key
 * round-trips and the prototype is untouched — which is what lets the bag stay ordinary.
 *
 * Mirrors `putOwn` in `games/court/runtime/saveSync.ts` (#912), deliberately — see § NAMING.
 */
export function putOwn<T>(bag: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(bag, key, { value, writable: true, enumerable: true, configurable: true })
}
