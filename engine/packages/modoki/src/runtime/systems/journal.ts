/** Event journal (Phase 3 — verification harness).
 *
 *  The observability counterpart to the action registry: where `dispatchUIAction`
 *  is named INPUT, the journal is named OUTPUT. Game systems `emit(type, payload)`
 *  whatever is worth asserting — `match`, `score`, `spawn`, `win`, `lose`,
 *  `phase-change` — and the harness reads back an ORDERED, tick-stamped trace of
 *  *what happened*, not just the end state. This is the thing Claude reads to
 *  self-correct game logic; it also doubles as a human debugging log (the editor
 *  Console can surface it).
 *
 *  Tick comes from `Time.frame` automatically (wired in `timeSystem`), so callers
 *  just pass type + payload. The buffer is capped (ring-drop oldest) so a
 *  long-running production session can't leak memory if nobody drains it.
 *
 *  WORLD-SCOPED (determinism-harness F1): the event buffer + current tick live in
 *  a `WeakMap<World>` keyed off the active world (like `worldRegistry`'s per-world
 *  indices), NOT module globals. So two coexisting worlds (editor dual-viewport, a
 *  future multi-world game, parallel test files) keep SEPARATE traces instead of
 *  interleaving events from world A under world B's ticks. The free functions
 *  resolve the current world by default; pass an explicit `world` to target one.
 *  Disposing a world drops its trace via GC. The on/off recording switch
 *  (`setJournalEnabled`) stays process-global — it's a build-level concern (drop
 *  all journaling overhead in shipped games), not per-world state. */

import { type World } from 'koota';
import { getCurrentWorld } from '../ecs/worldRegistry';
import { EntityAttributes } from '../traits/EntityAttributes';

export interface GameEvent {
  /** `Time.frame` when emitted — ordered, monotonic within a run. */
  tick: number;
  /** Semantic event name, e.g. 'match', 'score', 'win'. */
  type: string;
  /** Arbitrary structured detail. */
  payload?: unknown;
  /** Process-global capture sequence (Percept V3) — a single monotonic counter
   *  shared with the EDITOR journal, so the two streams (game `tick`-stamped, editor
   *  `seq`-stamped) can be interleaved on ONE axis for the unified timeline. Unlike
   *  `tick` (per-world sim frame) this is unique across worlds AND the editor stream. */
  cap: number;
}

// ── Shared capture sequence (Percept V3) ─────────────────────────────────────
// One process-global monotonic counter, bumped on EVERY journal emit — game (here)
// and editor (editorJournal.ts imports nextCaptureSeq). It gives both streams a
// common total order so a merged read can interleave them on a single axis, which
// neither `tick` (per-world) nor editor `seq` (editor-only) can do alone. It is NOT
// game state and is never read back into the simulation, so it doesn't affect
// determinism (the guard only forbids wall-clock/Math.random); in a fixed-dt headless
// run the emit order — and thus the counter — is reproducible, and the harness resets
// it on teardown.
let _captureSeq = 0;
/** Next value of the shared game+editor capture counter. */
export function nextCaptureSeq(): number { return ++_captureSeq; }
/** Test-only: reset the shared capture counter (harness teardown). */
export function _resetCaptureSeq(): void { _captureSeq = 0; }

const MAX_EVENTS = 10_000; // ring cap — drop oldest beyond this

/** Ring cap on the ref→name side-table (LRU by insertion order). Exported for the LRU unit test. */
export const MAX_NAMES = 5_000;

interface JournalState {
  // Backing store + a logical head index. emit() only ever push()es and bumps `head`
  // (O(1)); the live window is `events[head..]`. Past the cap we advance `head` to
  // "drop" the oldest, and compact (slice off the dead prefix) once per MAX_EVENTS emits
  // — so emit is amortized O(1) instead of an O(n) `shift()` per event past the cap,
  // while memory stays bounded at ≤ 2·MAX_EVENTS. (determinism-harness F2)
  events: GameEvent[];
  head: number;
  tick: number;
  // Percept identity side-table: ref (guid or numeric id) → the entity's display name
  // as of the LAST time `entityRef` saw it alive. Captured at emit time precisely so a
  // journal reader can name an entity that has since been DESPAWNED — a projectile, a
  // matched gem, a killed enemy — which a live-world lookup can no longer find. Deduped
  // by ref (a re-seen ref just refreshes its name + recency) and ring-capped LRU, so a
  // long session spawning thousands of transient entities stays bounded.
  names: Map<string | number, string>;
}

// Per-world trace. WeakMap so old worlds GC cleanly.
const journalStates = new WeakMap<World, JournalState>();

// Recording is ON by default (process-global) so the editor Console + headless harness
// see events with zero setup; emit() is O(1) so the always-on cost is a single push.
// Shipped games that never drain can call setJournalEnabled(false) to drop even that.
let _enabled = true;

// ── Journal tiers: watch-gated DIAGNOSTIC events ─────────────────────────────
// Two tiers control journal VOLUME (the journal is Percept's largest payload). Tier 1
// (always-on) is semantic game events + the LEAN enter/exit transitions (@collision/
// @sensor/@zone) — all low-rate, so a bare read always sees them. Tier 2 is a small set
// of high-frequency DIAGNOSTIC types (`@contact`, the rich per-contact manifold event)
// that emit() DROPS unless a watch is actively open for them — so they never fill the
// always-on ring and cost nothing in production. "No history before start": a Tier-2
// type is captured only from the moment its watch opens.
//
// Process-global (a debugging-session concern, like `_enabled`) — a watch applies to
// whichever world is being emitted into. Defaults empty (all Tier-2 dropped); the
// headless harness turns them on for full observability, and the editor AI panel can
// auto-start them on game launch.
const VERBOSE_TYPES = new Set<string>(['@contact']);
const activeVerbose = new Set<string>();

/** Is this a Tier-2 (watch-gated) diagnostic event type? */
export function isVerboseType(type: string): boolean { return VERBOSE_TYPES.has(type); }
/** Open/close a Tier-2 capture window for a diagnostic type (e.g. '@contact'). While
 *  open, emit() records that type; while closed, emit() drops it. No-op for a type that
 *  isn't Tier-2 (those are always-on). */
export function setVerboseCapture(type: string, on: boolean): void {
  if (!VERBOSE_TYPES.has(type)) return;
  if (on) activeVerbose.add(type); else activeVerbose.delete(type);
}
/** Cheap boolean: is a capture window open for this Tier-2 type? For hot-path emit
 *  sites (e.g. @contact) to skip building a payload before calling emit(). */
export function isVerboseCaptureActive(type: string): boolean { return activeVerbose.has(type); }
/** All Tier-2 (watch-gated) types + which are currently active — for tool discovery. */
export function verboseCaptureState(): { types: string[]; active: string[] } {
  return { types: [...VERBOSE_TYPES], active: [...activeVerbose] };
}

function journalStateFor(world: World): JournalState {
  let s = journalStates.get(world);
  if (!s) {
    s = { events: [], head: 0, tick: 0, names: new Map() };
    journalStates.set(world, s);
  }
  return s;
}

/** Record a ref→name mapping captured at emit time (from `entityRef`, while the
 *  entity is still alive). LRU: a re-seen ref refreshes its name AND its recency, so
 *  the ring evicts genuinely-cold refs, not ones that keep recurring. Bounded so a
 *  session spawning thousands of transient entities can't leak. */
function recordRefName(world: World, ref: string | number, name: string): void {
  const m = journalStateFor(world).names;
  if (m.has(ref)) m.delete(ref); // move to newest on refresh
  m.set(ref, name);
  if (m.size > MAX_NAMES) {
    const oldest = m.keys().next().value; // Map preserves insertion order → first key is coldest
    if (oldest !== undefined) m.delete(oldest);
  }
}

/** Resolve a journal ref (GUID or numeric id) to the display name captured at emit
 *  time — works even after the entity has been DESPAWNED, which a live-world lookup
 *  cannot. Undefined if the ref was never seen with a name. Backs the `resolve-refs`
 *  agent op; callers layer a live-world lookup on top for still-alive entities whose
 *  name was never journaled. */
export function resolveRefName(ref: string | number, world: World = getCurrentWorld()): string | undefined {
  return journalStates.get(world)?.names.get(ref);
}

/** The live event window (everything from `head` on). Always a fresh array so callers
 *  can't mutate the backing store. */
function liveEvents(s: JournalState): GameEvent[] {
  return s.events.slice(s.head);
}

/** Set the current tick used to stamp subsequent emits. Wired from `timeSystem`
 *  (`Time.frame`); tests/headless can set it directly. */
export function setJournalTick(tick: number, world: World = getCurrentWorld()): void {
  journalStateFor(world).tick = tick;
}

// ── Entity → GUID references (Percept identity) ──────────────────────────────
// Runtime entity ids are reassigned on every scene hot-reload, so a journal entry
// that references an entity by its numeric id can point at a DIFFERENT entity by
// the time it's read back. Convert an entity to its stable GUID with `entityRef`
// BEFORE putting it in a payload: `emit('hit', { body: entityRef(other) })`.
//
// Why this is explicit and NOT auto-applied inside emit(): koota entities are
// primitive numbers with their methods on Number.prototype, so a bare entity
// handle is INDISTINGUISHABLE from an ordinary scalar (a `score`, a coordinate,
// a `1` in a contact normal). Probing every payload number with
// `has(EntityAttributes)` would silently rewrite scalars that happen to match a
// live entity index into that entity's GUID — corrupting the very trace Percept
// exists to make trustworthy. So conversion happens at the call site, where the
// caller actually knows the value is an entity.

type EntityLike = { id(): number; get(t: unknown): unknown; has(t: unknown): boolean };

/** Stable journal/Percept reference for an entity: its GUID when it has one
 *  (survives scene hot-reloads), else its current numeric id as a fallback for an
 *  un-guidable (fresh, unsaved) entity. Call this on entities before emitting them
 *  in a payload — a raw entity is a primitive number the journal cannot safely
 *  auto-detect. */
export function entityRef(entity: EntityLike): string | number {
  const nid = entity.id();
  let ref: string | number = nid;
  let name = '';
  try {
    if (entity.has(EntityAttributes)) {
      const ea = entity.get(EntityAttributes) as { guid?: string; name?: string } | undefined;
      name = ea?.name ?? '';
      const g = ea?.guid ?? '';
      if (g) ref = g;
    }
  } catch {
    return nid; // not a live/valid entity handle — bail without caching
  }
  // Stash the name in the per-world side-table so a reader can name this entity even
  // after it despawns (see recordRefName). Only when journaling is on (skip the whole
  // cost in a shipped game) and a world is current (entityRef runs inside a tick).
  if (name && _enabled) {
    try {
      const w = getCurrentWorld();
      recordRefName(w, ref, name);
      // Dual-key: also alias under the NUMERIC id. A guidable entity emits its GUID here (while
      // alive), but the synthesized-exit path (physicsContactEvents `refOf`) emits the cached
      // numeric `entityId` once the entity is DEAD — so a reader resolving that numeric ref would
      // miss the name recorded only under the GUID. Aliasing both key forms keeps a despawned
      // guidable entity nameable (the feature's headline case) and lets enter (guid) correlate
      // with exit (numeric id). No-op when ref already IS the numeric id.
      if (ref !== nid) recordRefName(w, nid, name);
    } catch { /* no current world */ }
  }
  return ref;
}

/** Record a semantic event. No-op when disabled. The payload is stored verbatim —
 *  wrap any entity refs with `entityRef()` first (see the note above). */
export function emit(type: string, payload?: unknown, world: World = getCurrentWorld()): void {
  if (!_enabled) return;
  // Tier-2 (watch-gated) diagnostic events are dropped unless their capture window is open.
  if (VERBOSE_TYPES.has(type) && !activeVerbose.has(type)) return;
  const s = journalStateFor(world);
  s.events.push({ tick: s.tick, type, payload, cap: nextCaptureSeq() });
  if (s.events.length - s.head > MAX_EVENTS) {
    s.head++; // drop the oldest (logically) — no array re-index
    if (s.head > MAX_EVENTS) { s.events = s.events.slice(s.head); s.head = 0; } // periodic compaction
  }
}

/** Read recorded events, optionally filtered by `type`. Returns a copy. */
export function journalEvents(filter?: { type?: string }, world: World = getCurrentWorld()): GameEvent[] {
  const live = liveEvents(journalStateFor(world));
  return filter?.type ? live.filter((e) => e.type === filter.type) : live;
}

/** Read AND clear — useful for "what happened since I last looked". */
export function drainJournal(world: World = getCurrentWorld()): GameEvent[] {
  const s = journalStateFor(world);
  const out = liveEvents(s);
  s.events = [];
  s.head = 0;
  return out;
}

/** Clear the journal (call at the start of a playtest scenario for a clean run). */
export function clearJournal(world: World = getCurrentWorld()): void {
  const s = journalStateFor(world);
  s.events = [];
  s.head = 0;
}

/** Enable/disable recording (e.g. to drop all overhead in production). Process-global. */
export function setJournalEnabled(on: boolean): void {
  _enabled = on;
}

/** Is recording currently on? Cheapest guard for callers that want to skip building
 *  a payload (entityRef, object alloc) before calling emit() when journaling is off. */
export function isJournalEnabled(): boolean {
  return _enabled;
}
