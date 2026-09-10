/** authoredWrites — records trait writes that a SYSTEM makes to an AUTHORED entity while the
 *  simulation is stopped, so a save can say so out loud instead of silently baking them in.
 *
 *  The #124 class: a stopped editor has the authored scene on screen, and Cmd+S writes that
 *  world back to disk. An entity SPAWNED by a system while stopped is already handled — it is
 *  tagged `Transient` and the serializer skips it. What transience cannot reach is a system
 *  MUTATING an entity the human authored: chess's `chessStateProjection` driving the LLM
 *  download's progress onto the authored `ProgressBarFill`, whose new value then lands in
 *  chess.scene.json. `pauseWhileStopped` fixes that projection; this records whatever the NEXT
 *  one does, because the class stays open by design (the alternative — serializing the last
 *  loaded values instead of the live world — can silently discard a real edit, which is a worse
 *  bug than the one it fixes).
 *
 *  Deliberately warn-only. It reports; it never suppresses a write or blocks a save.
 *
 *  KNOWN COVERAGE BOUNDARY — **LATENT, not live** (#1042, owner 2026-09-10): the probe hooks
 *  `writeTraitField`, which is the choke point game code normally uses. A system that writes via
 *  koota's `entity.set(Trait, {...})` directly bypasses it and will NOT warn. That is not fixable
 *  here — `set` is koota's own API, not something the engine funnels — so the boundary is stated
 *  rather than papered over.
 *
 *  ⚠️ **Nothing BAKES through it today, but not for the reason you would guess — and the wrong
 *  reason was written here first.** It is NOT that "every `entity.set` sits below `TRANSFORM` and
 *  is skipped while stopped". `entriesSystem` runs at `UI_ENTRIES (270)`, which is ABOVE
 *  `TRANSFORM (200)`, so `runPipeline`'s `priority < TRANSFORM` gate does not skip it; it carries
 *  no sim check of its own, and it calls `entity.set` on the AUTHORED scroll-view entity
 *  (`entriesSystem.ts` ~`:741`/`:744`/`:1017`). Three further vectors sit outside the pipeline
 *  entirely: the DOM scroll handler's `driveEntriesFromScroll`, the Timeline editor's preview, and
 *  action dispatch during preview.
 *
 *  **The actual reason a save stays clean: every field written that way is `runtimeOnly`**
 *  (`registerTraits.ts` — the `UIScrollView` and `UIEntries` window state), so the serializer skips
 *  it regardless of who wrote it or when.
 *
 *  That is why #1042's proposal to extend the probe to `entity.set` was declined: the writes it
 *  would newly see are ones a save already cannot persist, so it would add noise rather than
 *  coverage. (#1042 cited `timelineSystem.ts:164`/`:264` as the live sites; those two really are
 *  sim-gated, at `ANIMATION-1 (149)` — but they were never the whole population.)
 *
 *  **What would make this boundary live:** an `entity.set` on a field that is NOT `runtimeOnly`,
 *  from anything that can run while stopped. Then a save can bake it and the probe cannot see it.
 *
 *  Note that mutating the object returned by `entity.get(Trait)` in place is NOT a write at all —
 *  koota returns a copy — so that pattern needs no coverage; it silently does nothing.
 *
 *  Zero imports on purpose: the recorder is called from `writeTraitField` (L0 `core/ecs/`), so
 *  it must not pull anything down with it. The CONDITION (in a system tick + sim stopped + not
 *  Transient) is evaluated at the call site, which already holds the entity. */

/** One (entity, trait, field) that a system wrote while stopped. `count` collapses a projection
 *  that rewrites the same field every frame into a single record. */
export interface AuthoredWriteRecord {
  entityId: number;
  /** Entity name at first write — for a message a human can act on without a GUID lookup. */
  name: string;
  trait: string;
  field: string;
  count: number;
}

/** Distinct (entity, trait, field) keys retained. A cap, not a policy: the map is only read by
 *  a save, so a long editing session must not grow it without bound. Repeat writes to an
 *  already-recorded key still count past the cap — only NEW keys are dropped. */
const MAX_RECORDS = 200;

const _records = new Map<string, AuthoredWriteRecord>();
let _dropped = 0;

/** Record one write. Cheap enough for a per-frame projection: one string join + a Map hit.
 *
 *  The key separator is U+0000 — it cannot occur in an entity id, trait name or field name, so
 *  the composite key is unambiguous. It MUST stay written as a unicode ESCAPE, never as the raw
 *  byte: a source file holding a literal NUL is classified binary by git, which costs the file
 *  its textual diff, its `git blame` and its line-level merge — a real hazard on a repo whose
 *  five clones integrate through a shared remote (#133). Guarded by
 *  `engine/tests/architecture/noNulBytesInSource.test.ts`. */
export function noteAuthoredWriteWhileStopped(entityId: number, name: string, trait: string, field: string): void {
  const key = `${entityId}\u0000${trait}\u0000${field}`;
  const existing = _records.get(key);
  if (existing) { existing.count++; return; }
  if (_records.size >= MAX_RECORDS) { _dropped++; return; }
  _records.set(key, { entityId, name, trait, field, count: 1 });
}

/** Everything recorded since the last clear, plus how many distinct keys the cap dropped. */
export function getAuthoredWritesWhileStopped(): { records: AuthoredWriteRecord[]; dropped: number } {
  return { records: [..._records.values()], dropped: _dropped };
}

/** Drop everything. Called on a world swap (a new scene's warnings are its own) and after a
 *  save has reported them. */
export function clearAuthoredWritesWhileStopped(): void {
  _records.clear();
  _dropped = 0;
}
