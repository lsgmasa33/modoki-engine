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
import { getCurrentWorld, peekCurrentWorld } from './ecs/worldRegistry';
import { EntityAttributes } from './traits/EntityAttributes';
import { hasDocKey } from './docKeys';
import { warnVocabOnce } from './warnVocab';
import { rawEpochNow } from './clock';

/** Triage severity for a journal event — the axis Claude filters on first when hunting
 *  a bug ("show me warn+ in the last N ticks") rather than reading the full trace.
 *  Ordered `info < warn < error`; `journalEvents({level})` returns that level AND ABOVE. */
export type JournalLevel = 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<JournalLevel, number> = { info: 0, warn: 1, error: 2 };

/** The level vocabulary, DERIVED from the rank table — so a caller that wants to REFUSE an
 *  unknown level (the `journal-events` op does) cannot list a fourth one by hand (#993). */
export const JOURNAL_LEVELS = Object.keys(LEVEL_RANK) as ReadonlyArray<JournalLevel>;

/** Is `level` one this journal ranks? Exported for the op, which must answer the CALLER rather
 *  than warn into an editor console the caller never reads. */
export function isJournalLevel(level: string): level is JournalLevel {
  return hasDocKey(LEVEL_RANK, level);
}

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
  /** Triage severity, defaulting to `'info'`. Set via `gameJournal.ts`'s `journalWarn`/
   *  `journalError` helpers, or the raw `emit()` 4th arg. */
  level: JournalLevel;
  /** This one emission came from an app-level service's boot, not from the scene (#1527,
   *  `EmitOptions.appLifetime`). Absent otherwise. */
  appLifetime?: true;
}

/** Per-emission options for `emit()` and the `gameJournal.ts` helpers. */
export interface EmitOptions {
  /** Mark THIS emission as the app boot's (#1527). The gameplay recorder's replay check skips it and
   *  still counts the same type's other emissions. For a type that only the boot ever emits,
   *  declaring the type with `appLifetimeEvent` says the same thing once. */
  appLifetime?: boolean;
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
/** The newest capture value issued so far — every later event's `cap` is greater. */
export function currentCaptureSeq(): number { return _captureSeq; }

// ── The counter's LIFE, so a `cap` can be a read cursor (#1561) ──────────────
// `cap` is module state: a renderer reload (every game-code edit force-reloads) restarts it at 0,
// and so does the harness reset below. A cursor from an earlier life is then either AHEAD of every
// new event (a forward read returns nothing, forever) or, once the new counter passes it, silently
// in the middle of events it never saw. The epoch names the life, so a stale cursor is DETECTED
// rather than guessed at — the same contract as the editor journal's `epoch` (#1214 B-3). A wall
// timestamp through the sanctioned clock wrapper is enough: it only has to differ between loads,
// and it is never read back into the simulation.
const _loadStamp = rawEpochNow().toString(36);
let _captureLife = 0;
/** Which life of the capture counter a `cap` belongs to. Replies carry it; callers send it back. */
export function captureEpoch(): string { return `${_loadStamp}-${_captureLife}`; }

/** The capture-counter part of an epoch. The editor journal's epoch is `<capture life>~<its own seq
 *  life>` because its cursors live on BOTH counters, while the game journal's names only the
 *  capture life — and a `cap` cursor is legitimately carried from one tool to the other (a
 *  `modoki_journal` baseline, then `modoki_editor_journal {merged, sinceCap}`). So a cap cursor is
 *  checked against this part alone; two epochs for one counter reported a reload that never
 *  happened (#1561 review). */
export function capturePartOf(epoch: string): string {
  const i = epoch.indexOf('~');
  return i < 0 ? epoch : epoch.slice(0, i);
}

/** Test-only: reset the shared capture counter (harness teardown). Starts a new life too, so a
 *  cursor taken before the reset is recognised as stale. */
export function _resetCaptureSeq(): void { _captureSeq = 0; _captureLife++; }

export interface ResolvedCapCursor {
  sinceCap: number | undefined;
  /** Set when the caller's cursor belonged to an earlier life and was replaced with 0. */
  cursorReset?: string;
}

/** Turn a caller's `sinceCap` (+ the `epoch` it was read under) into a cursor valid for THIS life.
 *  - `epoch` given and different → from before a restart: replay this life from 0.
 *  - no `epoch`, but `sinceCap` past the newest cap ever issued → it cannot be from this life
 *    either (a cursor never runs ahead of the counter): same reset.
 *  An old cursor sent WITHOUT its epoch and still below the new counter cannot be told apart from a
 *  current one — which is why replies carry `epoch` and the tools say to send it back. */
export function resolveCapCursor(sinceCap: number | undefined, callerEpoch: string | undefined): ResolvedCapCursor {
  if (sinceCap == null) return { sinceCap };
  const epoch = captureEpoch();
  // A blank epoch is ABSENT, not a different life: `device_journal` forwards `""` where the editor
  // route drops it, and reading it as a mismatch replayed the whole ring on one surface only.
  if (callerEpoch && capturePartOf(callerEpoch) !== epoch) {
    return { sinceCap: 0, cursorReset: `sinceCap=${sinceCap} was issued under epoch ${callerEpoch}; the journal has restarted since (epoch ${epoch} — a renderer reload, e.g. a game-code edit), so this read replays everything from the restart. Use the returned nextCap from now on.` };
  }
  if (sinceCap > _captureSeq) {
    return { sinceCap: 0, cursorReset: `sinceCap=${sinceCap} is past the newest event this journal has issued (${_captureSeq}), so it is from before a restart (a renderer reload, e.g. a game-code edit); this read replays everything from the restart. Send \`epoch\` back with \`sinceCap\` so a restart is always detected.` };
  }
  return { sinceCap };
}

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
  /** The newest `cap` this ring has LOST — evicted past the cap, or removed by a clear. A cursor at
   *  or below it has a gap it cannot see: caps are shared with the editor stream and other worlds,
   *  so a jump in the returned caps is normal and proves nothing (#1561 review). 0 = nothing lost. */
  droppedThroughCap: number;
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

// ── App-lifetime events (#1524, #1527) ───────────────────────────────────────
// Some events are emitted once per PAGE LOAD by an app-level service's boot (an IAP catalogue,
// a server-clock fetch), not by anything a scene does. The gameplay recorder has to know which. A
// game's boot system runs on the first frame the sim runs, so in the editor that is the page's FIRST
// Play: a take recorded then has them, and a take from any later Play does not. Every replay boots
// a fresh page and always has them. Compared by count, a later-Play take read as a replay that
// `diverged` when it did exactly what was played (`compareTakeEvents` skips them instead).
//
// Two ways to say it, both at the emit site so neither can drift from the code that emits:
// - **Per emission** (`emit(..., { appLifetime: true })`), for a type the boot AND the scene emit.
//   Court's price fetch is one: the boot asks once, and every board build past the ad unlock asks
//   again. Declaring that type would stop the check counting the board builds' fetches (#1527).
// - **Per type** (`appLifetimeEvent`), for a type only the boot emits, or one whose boot emissions
//   the emit site cannot tell apart (`iap.not-configured`: any call made before the boot configured
//   the store).
const APP_LIFETIME_TYPES = new Set<string>();

/** Declare `type` as emitted once per page load rather than by the scene, and return it, so the
 *  declaration sits where the event is emitted: `const PRODUCTS = appLifetimeEvent('court.iap.products')`.
 *  ⚠️ The whole TYPE is declared, so the replay check also skips any later, scene-driven emission
 *  of it. For a type the scene emits too, mark the boot's emissions instead
 *  (`EmitOptions.appLifetime`, #1527). */
export function appLifetimeEvent<T extends string>(type: T): T {
  APP_LIFETIME_TYPES.add(type);
  return type;
}
/** Every type declared by `appLifetimeEvent` in this page. */
export function appLifetimeEventTypes(): string[] { return [...APP_LIFETIME_TYPES]; }

function journalStateFor(world: World): JournalState {
  let s = journalStates.get(world);
  if (!s) {
    s = { events: [], head: 0, tick: 0, names: new Map(), droppedThroughCap: 0 };
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

/** Record that every live event is about to be removed (a clear or a drain), so a cursor reader
 *  learns it has a gap rather than reading a quiet ring as "nothing happened". */
function markDropped(s: JournalState): void {
  const last = s.events[s.events.length - 1];
  if (last && s.events.length > s.head) s.droppedThroughCap = Math.max(s.droppedThroughCap, last.cap);
}

/** The one sentence both journal readers attach when a cursor has a gap (#1561). Scoped to THIS
 *  world's ring on purpose: a scene load or Play starts a new world with a ring of its own, and the
 *  previous world's events are simply not in it — that is not tracked as a loss here. */
export function journalGapNote(sinceCap: number, droppedThroughCap: number): string {
  return `events after sinceCap=${sinceCap} up to cap ${droppedThroughCap} were lost before this read (the game ring keeps the newest 10,000 per world, the editor ring 2,000, or one was cleared), so the counts cover only what survived. Read more often, or narrow the capture. (A scene load or Play starts a new world whose ring never held the previous world's events; that is not reported here.)`;
}

/** The newest `cap` this world's ring has lost — to eviction past the 10,000-event cap, or to a
 *  clear. A `sinceCap` below it means events after the cursor are gone. 0 when nothing was lost. */
export function journalDroppedThroughCap(world: World = getCurrentWorld()): number {
  return journalStateFor(world).droppedThroughCap;
}

/** Set the current tick used to stamp subsequent emits. Wired from `timeSystem`
 *  (`Time.frame`); tests/headless can set it directly. */
export function setJournalTick(tick: number, world: World = getCurrentWorld()): void {
  journalStateFor(world).tick = tick;
}

/** The tick subsequent emits WILL be stamped with — so a non-journal observer can stamp its own
 *  records on the same clock and correlate them by integer comparison. Added for the input watch
 *  (`input/pointerRecorder.ts`), where lining a press up against what the game did next was
 *  otherwise guesswork against wall-clock timestamps from two different sources (#134).
 *
 *  Uses `peek`, not `getCurrentWorld()`: an observer can run before a world exists (a press on a
 *  loading screen is still evidence), and throwing there would make the recorder's own robustness
 *  depend on scene lifecycle. 0 is the honest answer when nothing is keeping time yet. */
export function journalTick(world: World | null = peekCurrentWorld()): number {
  if (!world) return 0;
  return journalStates.get(world)?.tick ?? 0;
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

type EntityLike = { id(): number; get(t: unknown): unknown; has(t: unknown): boolean; isAlive(): boolean };

/** Stable journal/Percept reference for an entity: its GUID when it has one
 *  (survives scene hot-reloads), else its current numeric id as a fallback for an
 *  un-guidable (fresh, unsaved) entity. Call this on entities before emitting them
 *  in a payload — a raw entity is a primitive number the journal cannot safely
 *  auto-detect.
 *
 *  **`null` for a handle that is no longer alive** (#1227). koota's `has()`/`get()`/`id()` mask the
 *  generation off, so a dead handle whose index a new entity reclaimed would otherwise answer with
 *  the NEWCOMER's guid — a live entity that never took part in the event. Nothing about the dead
 *  entity can be derived from its handle any more, so this refuses rather than guesses. A caller
 *  that needs the dead entity's ref must have taken it while the entity was alive: an exit
 *  callback reads `otherRef` (`ctx.params`, or the event bus's `refs`), which the producer cached. */
export function entityRef(entity: EntityLike): string | number | null {
  try { if (!entity.isAlive()) return null; } catch { return null; } // a destroyed world's handle throws
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
      // ONE key: the ref this call returns. There used to be a second, numeric-id alias, because
      // the synthesized despawn-exit (physicsContactEvents/zoneTriggerCore `refOf`) emitted the
      // cached numeric id; it now emits the ref cached from a live call, so every journaled ref
      // was recorded here under exactly that string (#1225).
      recordRefName(w, ref, name);
    } catch { /* no current world */ }
  }
  return ref;
}

/** Record a semantic event. No-op when disabled. The payload is stored verbatim —
 *  wrap any entity refs with `entityRef()` first (see the note above). `level` defaults
 *  to `'info'`; prefer `gameJournal.ts`'s `journalWarn`/`journalError` over passing it
 *  here directly — this 4th positional arg exists mainly so those helpers stay thin
 *  wrappers over `emit()` instead of a parallel recording path. */
export function emit(
  type: string, payload?: unknown, world: World = getCurrentWorld(), level: JournalLevel = 'info', options?: EmitOptions,
): void {
  if (!_enabled) return;
  // Tier-2 (watch-gated) diagnostic events are dropped unless their capture window is open.
  if (VERBOSE_TYPES.has(type) && !activeVerbose.has(type)) return;
  const s = journalStateFor(world);
  s.events.push({ tick: s.tick, type, payload, cap: nextCaptureSeq(), level, ...(options?.appLifetime ? { appLifetime: true } : {}) });
  if (s.events.length - s.head > MAX_EVENTS) {
    s.droppedThroughCap = s.events[s.head].cap;
    s.head++; // drop the oldest (logically) — no array re-index
    if (s.head > MAX_EVENTS) { s.events = s.events.slice(s.head); s.head = 0; } // periodic compaction
  }
}

/** Read recorded events, optionally filtered by `type` (exact match) and/or `level`
 *  (that severity AND ABOVE — e.g. `level: 'warn'` returns `warn` and `error`). Returns
 *  a copy. */
export function journalEvents(filter?: { type?: string; level?: JournalLevel }, world: World = getCurrentWorld()): GameEvent[] {
  let out = liveEvents(journalStateFor(world));
  if (filter?.type) out = out.filter((e) => e.type === filter.type);
  // ⚠️ `hasDocKey` (#993). `filter.level` arrives on the `device_journal` agent payload and
  // `LEVEL_RANK` is a code-declared literal, so `level:"toString"` yields the inherited FUNCTION:
  // every `>=` against it is false and the journal silently returns ZERO events — which an agent
  // reads as "nothing happened". An unknown level filters nothing instead.
  if (filter?.level) {
    if (isJournalLevel(filter.level)) {
      const min = LEVEL_RANK[filter.level];
      out = out.filter((e) => LEVEL_RANK[e.level] >= min);
    } else {
      // ⚠️ This warn is the LAST resort, not the fix. It reaches an editor console the calling
      // agent never reads, so `journal-events` REFUSES an unknown level outright (see
      // `isJournalLevel` there) — without that, `level:"wran"` returned the whole ring under a
      // `filtered: true` framing, which is indistinguishable from "there really were N warn+
      // events". This branch stays for the non-op callers (JournalTab, game code).
      warnVocabOnce('journal', 'level', filter.level, 'level filter IGNORED (every level returned)');
    }
  }
  return out;
}

/** Read AND clear — useful for "what happened since I last looked". */
export function drainJournal(world: World = getCurrentWorld()): GameEvent[] {
  const s = journalStateFor(world);
  const out = liveEvents(s);
  markDropped(s);
  s.events = [];
  s.head = 0;
  return out;
}

/** Clear the journal (call at the start of a playtest scenario for a clean run). */
export function clearJournal(world: World = getCurrentWorld()): void {
  const s = journalStateFor(world);
  markDropped(s);
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
