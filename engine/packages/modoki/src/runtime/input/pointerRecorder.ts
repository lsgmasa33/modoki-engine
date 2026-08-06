/** Input WATCH — a bounded record of what the POINTER actually did, and what it resolved to.
 *
 *  WHY THIS EXISTS (#134). The journal answers "what did the game do". It cannot answer "what did
 *  the player's finger do", and those become different questions the moment a gesture fails: a
 *  press that resolves to nothing emits nothing — no journal event, no commit, no coordinates — so
 *  the failure mode with the LEAST evidence is the one a player reports most often ("I tried to
 *  drag it and nothing happened"). Diagnosing one such bug on a Galaxy A23 took a whole session of
 *  inference from ABSENCES, reached the right answer, and still could not produce a number; the
 *  number turned out to be the whole ballgame (a 27.6 px miss against a 22.76 px radius, which the
 *  fix about to ship would have missed by 0.3 px).
 *
 *  So: `moves` and `maxD` are not padding. They are the two fields that separated "the touch target
 *  is too small" from "the device dropped pointer samples and the drag never passed the slop
 *  threshold" — 64 move samples over 1216 ms killed the frame-rate hypothesis outright.
 *
 *  ── THE THREE DESIGN RULES ──
 *
 *  1. **CAPTURE phase, on `window`.** `pointerSource` listens in the bubble phase, applies the
 *     primary-touch rule, and drops a blocked press at ingestion — all correct for INPUT, all
 *     wrong for EVIDENCE. This module attaches its own capture-phase listeners so it sees the
 *     press regardless of what any layer downstream does with it: blocked, `stopPropagation`'d,
 *     a second finger the engine deliberately ignores. A recorder that only sees what the engine
 *     accepted cannot explain a press the engine rejected.
 *
 *  2. **Gated, like `@contact`** (`core/journal.ts`). Raw pointer traffic is high-frequency; a
 *     permanently-armed recorder would either dominate a ring buffer or cost every shipped game a
 *     listener it never reads. Nothing is recorded — and no listener is even attached — until a
 *     window is opened, and only from that point forward. Closed is genuinely free, not
 *     cheap-but-nonzero.
 *
 *  3. **"Could not look" is never reported as "nothing is there"** (`docs/mcp-tool-conventions.md`
 *     §5). `resolved` is a three-way answer, deliberately the same three-way `screenPick.pickAt`
 *     already makes: something was hit, an authority looked and found nothing, or NOBODY could
 *     look. The engine cannot hit-test a canvas game — Court runs its own `hitTest`, and no game
 *     surface registers a pick provider — so collapsing those would answer the one question this
 *     whole module exists for with a confident lie.
 *
 *  A game closes that gap in one line: call `noteInputResolution()` from its own hit-test and the
 *  record carries the real target. Without it the record still says, honestly, that nothing on
 *  this surface was able to answer.
 *
 *  Headless-safe (guards `typeof window`), no RNG, and wall-clock only through the sanctioned
 *  `core/clock.ts` wrapper — so a test can pin `heldMs` exactly. */

import { rawNow } from '../core/clock';
import { journalTick } from '../core/journal';
import { nearestPointerBlocker } from '../core/pointerBlockers';
import { pickAt, pickableSurfaces } from '../core/screenPick';
import type { BoundsSurface } from '../core/screenBounds';

/** What a press resolved to — a discriminated union, because the three cases are genuinely
 *  different answers and the whole value of this record is keeping them apart.
 *
 *  - `game` — the game's own hit-test told us, via `noteInputResolution()`. Authoritative: it IS
 *    the code that decides, not a prediction of it.
 *  - `ui`   — the press landed on a DOM node the engine's `UIRenderer` owns (`data-entity-id`).
 *  - `pick` — a registered pick provider answered (today: the editor's SceneView only).
 *  - `none` — an authority looked and found nothing there. `checked` says which ones.
 *  - `unknown` — nothing on this surface could answer. NOT the same as `none`, and the reason
 *    says so in words a reader can act on. */
export type InputResolution =
  | { by: 'game'; kind: string; id?: string | number; label?: string }
  | { by: 'ui'; entityId: number; label?: string }
  | { by: 'pick'; entityId: number; surface: BoundsSurface }
  | { by: 'none'; checked: Array<'game' | 'ui' | 'pick'> }
  | { by: 'unknown'; reason: string };

/** One press, from pointerdown to pointerup/cancel. Coordinates are viewport CSS px — the same
 *  space `InputFrame`, `collectScreenBounds` and every Enact aim use, so a record can be compared
 *  against `get_layout_bounds` output without a transform. */
export interface InputPressRecord {
  /** 1-based, monotonic within a window. Gaps mean the ring dropped older presses. */
  seq: number;
  /** Journal tick at pointerdown — the SAME clock `journalEvents()` stamps, so correlating a
   *  press against what the game did next is an integer comparison rather than a guess. */
  tick: number;
  pointerType: string;
  /** True for the pointer that owns the gesture as far as `pointerSource` is concerned. A press
   *  with `primary:false` was recorded here but deliberately ignored by the engine (the
   *  primary-touch rule) — which is itself a bug report an agent could not otherwise see. */
  primary: boolean;
  /** Down point. */
  x: number;
  y: number;
  /** Last known point (the release point once `ended` is `up`/`cancel`). */
  upX: number;
  upY: number;
  /** Greatest distance travelled from the down point. Compare against the game's drag-slop
   *  threshold to tell "never dragged" from "dragged and the drop missed". */
  maxD: number;
  /** pointermove events seen for this pointer. A low count over a long hold means samples were
   *  dropped; a high count means the gesture was real and something else rejected it. */
  moves: number;
  heldMs: number;
  /** `open` = still held when the record was read. */
  ended: 'up' | 'cancel' | 'open';
  /** A short description of the event target at pointerdown, for eyeballing which layer got it. */
  target: string;
  /** Set when a registered pointer-block root swallowed the press before `pointerSource` could
   *  latch it — with WHICH root, the field `input.pointer.blocked` never carried. */
  blocked: { by: string } | null;
  /** What the PRESS resolved to. */
  resolved: InputResolution;
  /** What a hit-test reported AFTER the release, when the game runs one there (a drop target).
   *  Null when the game never asked. This is how "the press grabbed the piece but the drop landed
   *  nowhere" is told apart from "the press never grabbed anything". */
  dropResolved: InputResolution | null;
}

/** In-flight press state, before it becomes a record. */
interface InFlight extends InputPressRecord {
  downMs: number;
}

const DEFAULT_MAX = 40;
const MAX_CEIL = 500;
/** Guards against unbounded growth if `pointerup` is never delivered for some pointer (a browser
 *  reclaiming a touch without a cancel). Real multi-touch never approaches this. */
const MAX_IN_FLIGHT = 10;
/** A game reads input a frame or more behind the event, so a few presses can legitimately be
 *  awaiting their resolution at once. Anything beyond this is a game that never calls the hook. */
const MAX_AWAITING = 16;
/** How late a game's resolution may arrive and still be believed. A game reads the press from a
 *  system on the NEXT frame — 100 ms even at 10 fps — so a second is generous by an order of
 *  magnitude while still being far below "a press from a previous interaction entirely". */
const STALE_NOTE_MS = 1000;

let open = false;
let max = DEFAULT_MAX;
let seqCounter = 0;
let dropped = 0;
const ring: InputPressRecord[] = [];
const inFlight = new Map<number, InFlight>();
/** Records awaiting their press-time resolution, oldest first.
 *
 *  WHY A QUEUE, and not "whatever press is currently in flight". A game does NOT hit-test inside
 *  the pointer event — it reads the `Input` trait from a SYSTEM, on the next frame. So a game's
 *  `noteInputResolution()` for a press routinely arrives after that press has already been
 *  released and finalized here, and a fast tap can be fully over before the game looks at it at
 *  all. Attaching a note to "the press in flight" therefore mis-assigns under exactly the rapid
 *  input a missed-gesture investigation involves — and a resolution attached to the wrong press is
 *  a wrong thing stated authoritatively, the worst outcome on this surface.
 *
 *  FIFO + an explicit `phase` makes the mapping independent of when the note arrives: presses are
 *  claimed in the order they happened, and a drop note names the gesture whose press was claimed
 *  last. Bounded, so a game that never calls the hook cannot grow this without limit. */
const awaitingPressNote: InFlight[] = [];
/** The gesture a `phase:'drop'` note belongs to — the one whose press was most recently claimed. */
let lastPressNoted: InFlight | null = null;

function describeNode(n: unknown): string {
  const el = n as { tagName?: string; id?: string; className?: unknown; getAttribute?: (a: string) => string | null } | null;
  if (!el || typeof el.tagName !== 'string') {
    // Not an element. Name the constructor rather than `typeof` — "object" tells a reader nothing,
    // while "Window"/"Document" tells them the press never landed on markup at all.
    if (n === null || n === undefined) return String(n);
    const ctor = (n as { constructor?: { name?: string } }).constructor?.name;
    return ctor || typeof n;
  }
  let s = el.tagName.toLowerCase();
  if (el.id) s += `#${el.id}`;
  // An engine UI node carries its entity id, and that is the only handle a reader can act on: a
  // bare "div" names nothing, while `div[entity=23]` can be looked up in get_scene_state. Measured
  // on the live gate — Court's tutorial catcher reported as a plain "div" and had to be identified
  // by cross-referencing the resolution, which a blocker that is not also the resolved target
  // would not have offered.
  const entityId = el.getAttribute?.('data-entity-id');
  if (entityId) s += `[entity=${entityId}]`;
  const testid = el.getAttribute?.('data-testid');
  if (testid) s += `[data-testid="${testid}"]`;
  else if (typeof el.className === 'string' && el.className.trim()) {
    s += `.${el.className.trim().split(/\s+/)[0]}`;
  }
  return s;
}

/** The engine's own best answer at press time — a FALLBACK, overridden by a game hook. */
function engineResolve(target: unknown, x: number, y: number): InputResolution {
  const checked: Array<'game' | 'ui' | 'pick'> = [];

  // UI: the DOM node UIRenderer stamps with its entity id (`ui/UINode.tsx`).
  const el = target as { closest?: (s: string) => { getAttribute: (a: string) => string | null } | null } | null;
  const uiNode = el?.closest?.('[data-entity-id]') ?? null;
  if (uiNode) {
    const raw = uiNode.getAttribute('data-entity-id');
    const entityId = raw === null ? NaN : Number(raw);
    if (Number.isFinite(entityId)) return { by: 'ui', entityId };
  }
  // A UI MISS is deliberately NOT recorded as an authority that looked. "This press was not on a
  // UI node" says nothing whatsoever about whether it hit something in the game — and counting it
  // would let a canvas game's every press answer `none` ("we looked, nothing there") when the
  // truth is `unknown` ("nobody who could answer was asked"). That is the precise substitution
  // this module exists to prevent, and it shipped in the first draft of this function.

  // Pick providers: ask every surface that has one. `undefined` means nobody answered — keep that
  // apart from `null` ("looked, nothing there"), which is the entire point of `pickAt`'s contract.
  let anyPicker = false;
  for (const surface of pickableSurfaces()) {
    const hit = pickAt(surface, x, y);
    if (hit === undefined) continue;
    anyPicker = true;
    if (hit !== null) return { by: 'pick', entityId: hit, surface };
  }
  if (anyPicker) checked.push('pick');

  if (checked.length === 0) {
    return {
      by: 'unknown',
      reason: 'no pick provider is registered for any surface and the game published no resolution '
        + '— call noteInputResolution() from the game hit-test to record what this press hit',
    };
  }
  return { by: 'none', checked };
}

function onDown(e: PointerEvent): void {
  if (inFlight.size >= MAX_IN_FLIGHT) return;
  const now = rawNow();
  const rec: InFlight = {
    seq: ++seqCounter,
    tick: journalTick(),
    pointerType: e.pointerType || 'unknown',
    // A real PointerEvent always carries `isPrimary`; a synthetic one (an injected/trusted event,
    // a test) may not. Absent reads as primary — the alternative would label every injected press
    // "the engine ignored this", which is a false accusation in the exact record an agent consults
    // to decide whether the engine ignored it.
    primary: (e as { isPrimary?: boolean }).isPrimary ?? true,
    x: e.clientX,
    y: e.clientY,
    upX: e.clientX,
    upY: e.clientY,
    maxD: 0,
    moves: 0,
    heldMs: 0,
    ended: 'open',
    target: describeNode(e.target),
    blocked: null,
    resolved: { by: 'none', checked: [] },
    dropResolved: null,
    downMs: now,
  };
  const blocker = nearestPointerBlocker(e.target);
  if (blocker) rec.blocked = { by: describeNode(blocker) };
  rec.resolved = engineResolve(e.target, e.clientX, e.clientY);
  inFlight.set(e.pointerId, rec);
  // ONLY a press the game can actually receive joins the resolution queue. A blocked press is
  // swallowed by `pointerSource` at ingestion and a non-primary one loses to the primary-touch
  // rule, so in both cases the game will NEVER hit-test it — and an entry nothing ever claims
  // poisons the FIFO permanently, handing the next real press's resolution to a press that was
  // never resolved at all.
  //
  // Found by the live gate, not by a test: four taps swallowed by Court's tutorial catcher left
  // the queue stuck at the first of them, so the fifth press's genuine `cell b1` resolution was
  // reported against a press that had been eaten by an overlay. Every unit test had the game
  // claim every press, so none of them could see it — and the wrong record is exactly the one an
  // investigator would have chased.
  if (!rec.blocked && rec.primary) {
    awaitingPressNote.push(rec);
    // Drop the OLDEST unclaimed press, not the newest: a game that never calls the hook at all
    // would otherwise pin the queue at its first-ever press.
    while (awaitingPressNote.length > MAX_AWAITING) awaitingPressNote.shift();
  }
}

function onMove(e: PointerEvent): void {
  const rec = inFlight.get(e.pointerId);
  if (!rec) return;
  rec.moves++;
  rec.upX = e.clientX;
  rec.upY = e.clientY;
  const d = Math.hypot(e.clientX - rec.x, e.clientY - rec.y);
  if (d > rec.maxD) rec.maxD = d;
}

function finish(e: PointerEvent, ended: 'up' | 'cancel'): void {
  const rec = inFlight.get(e.pointerId);
  if (!rec) return;
  inFlight.delete(e.pointerId);
  rec.upX = e.clientX;
  rec.upY = e.clientY;
  const d = Math.hypot(e.clientX - rec.x, e.clientY - rec.y);
  if (d > rec.maxD) rec.maxD = d;
  rec.heldMs = rawNow() - rec.downMs;
  rec.ended = ended;
  push(rec);
  // Deliberately NOT removed from `awaitingPressNote`: the game has very likely not looked at this
  // press yet (it samples input on the next frame), and a finalized record is still the right home
  // for that resolution when it arrives.
}

function onUp(e: PointerEvent): void { finish(e, 'up'); }
function onCancel(e: PointerEvent): void { finish(e, 'cancel'); }

function push(rec: InFlight): void {
  ring.push(rec);
  while (ring.length > max) { ring.shift(); dropped++; }
}

/** The wire shape, copied field by field rather than spread-minus-deletes. Explicit is the point:
 *  the in-flight record carries bookkeeping (`downMs`, `gameNoted`) that means nothing to a reader,
 *  and a future field added to `InFlight` must not reach an agent by default. */
function publish(r: InputPressRecord | InFlight): InputPressRecord {
  return {
    seq: r.seq,
    tick: r.tick,
    pointerType: r.pointerType,
    primary: r.primary,
    x: r.x,
    y: r.y,
    upX: r.upX,
    upY: r.upY,
    maxD: r.maxD,
    moves: r.moves,
    // An in-flight press has no final duration yet — report how long it has been held SO FAR,
    // which is what makes a stuck gesture legible ("held 8 s, never released").
    heldMs: r.ended === 'open' ? rawNow() - (r as InFlight).downMs : r.heldMs,
    ended: r.ended,
    target: r.target,
    blocked: r.blocked,
    resolved: r.resolved,
    dropResolved: r.dropResolved,
  };
}

/** Open the window. Records nothing that happened before this call — by design, same contract as
 *  the journal's `@contact` gating: no history, only what follows. Re-opening an already-open
 *  window is reported rather than silently treated as a fresh start, because a caller who thinks
 *  it just cleared the ring would misread every older press as belonging to its own probe. */
export function startInputWatch(opts?: { max?: number }): {
  ok: true; max: number; alreadyOpen: boolean; recorded: number;
} {
  const wasOpen = open;
  const requested = opts?.max;
  if (typeof requested === 'number' && Number.isFinite(requested) && requested > 0) {
    max = Math.min(Math.floor(requested), MAX_CEIL);
  } else if (!wasOpen) {
    max = DEFAULT_MAX;
  }
  while (ring.length > max) { ring.shift(); dropped++; }
  if (!wasOpen) {
    open = true;
    if (typeof window !== 'undefined') {
      window.addEventListener('pointerdown', onDown, true);
      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
      window.addEventListener('pointercancel', onCancel, true);
    }
  }
  return { ok: true, max, alreadyOpen: wasOpen, recorded: ring.length };
}

/** Close the window and detach every listener — closed is free, not cheap. Recorded presses are
 *  KEPT, so a caller can stop first and read afterwards without racing its own probe. */
export function stopInputWatch(): void {
  if (!open) return;
  open = false;
  if (typeof window !== 'undefined') {
    window.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('pointermove', onMove, true);
    window.removeEventListener('pointerup', onUp, true);
    window.removeEventListener('pointercancel', onCancel, true);
  }
  inFlight.clear();
  awaitingPressNote.length = 0;
  lastPressNoted = null;
}

export function isInputWatchOpen(): boolean { return open; }

/** Drop retained presses without closing the window. Returns how many were dropped.
 *
 *  `seq` is NOT rewound, and that is deliberate: it is an identity, not a counter. Resetting it
 *  while a press was still in flight let that press finalize as `seq 5` while the next new press
 *  started again at 1 — two records claiming the same seq in one ring, which silently breaks both
 *  the ordering and "a gap means the ring dropped something". Only presses already in the ring are
 *  dropped; one still being held is still happening, so it survives and keeps its identity.
 *
 *  Cleared records join `dropped` for the same reason ring evictions do — from a reader's side
 *  both mean "recorded, no longer available", which is what keeps `totalCount` reconcilable
 *  against what came back. */
export function clearInputPresses(): number {
  const cleared = ring.length;
  ring.length = 0;
  dropped += cleared;
  return cleared;
}

/** Read the ring. In-flight presses are included with `ended:'open'` — a press still held IS
 *  evidence, and omitting it would make a stuck gesture look like no gesture at all. */
export function readInputPresses(): {
  open: boolean;
  max: number;
  returnedCount: number;
  totalCount: number;
  dropped: number;
  presses: InputPressRecord[];
} {
  const held = [...inFlight.values()].map(publish);
  const presses = [...ring.map(publish), ...held].sort((a, b) => a.seq - b.seq);
  return {
    open,
    max,
    returnedCount: presses.length,
    totalCount: seqCounter,
    dropped,
    presses,
  };
}

/** Publish what the game's OWN hit-test resolved this press to — the one field no engine-side
 *  observer can compute for a canvas game, and the field a whole diagnosis session was spent
 *  inferring from absences.
 *
 *  Call it from the hit-test itself, so the record reports what the game really decided rather
 *  than a second implementation that agrees today (the same rule `screenPick`'s header states).
 *  Pass `null` for "my hit-test ran and found nothing" — which is a genuinely different, and much
 *  more useful, answer than staying silent.
 *
 *  Free to call unconditionally: it returns immediately when no window is open, so a game leaves
 *  the call in place permanently rather than guarding it.
 *
 *  `phase` says WHICH hit-test this is, and is not inferred from timing — a game hit-tests from a
 *  system on a later frame, so "which press is in flight right now" is not a reliable answer (see
 *  `awaitingPressNote`). `'press'` claims the oldest press not yet resolved; `'drop'` records the
 *  release-time hit-test (the drop target) against that same gesture. */
export function noteInputResolution(
  hit: { kind: string; id?: string | number; label?: string } | null,
  phase: 'press' | 'drop' = 'press',
): void {
  if (!open) return;
  const res: InputResolution = hit
    ? { by: 'game', kind: hit.kind, ...(hit.id !== undefined ? { id: hit.id } : {}), ...(hit.label ? { label: hit.label } : {}) }
    : { by: 'none', checked: ['game'] };

  if (phase === 'drop') {
    if (lastPressNoted) lastPressNoted.dropResolved = res;
    return;
  }
  // Expire presses the game was never going to claim. Not being blocked is not the same as being
  // DELIVERED: the sim may be stopped, a host input gate closed, or the game simply may not
  // hit-test every press. A game that does hit-test reads the press on the very next frame, so
  // anything this old is not late — it is never coming, and letting it stay would mis-attribute
  // the resolution that just arrived to a press it has nothing to do with.
  const now = rawNow();
  while (awaitingPressNote.length && now - awaitingPressNote[0].downMs > STALE_NOTE_MS) {
    awaitingPressNote.shift();
  }
  const rec = awaitingPressNote.shift();
  if (!rec) return;
  rec.resolved = res;
  lastPressNoted = rec;
}

/** Test/teardown escape hatch — closes the window and drops every record.
 *
 *  Unlike `clearInputPresses` this DOES rewind `seq` and `dropped`: an agent's clear happens
 *  mid-session, where press identity has to stay unique, whereas this is a full teardown between
 *  sessions where nothing survives to collide with. */
export function __resetInputRecorder(): void {
  stopInputWatch();
  clearInputPresses();
  ring.length = 0;
  seqCounter = 0;
  dropped = 0;
  max = DEFAULT_MAX;
}
