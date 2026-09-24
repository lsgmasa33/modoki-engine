/** A recorded TAKE — the gameplay recorder's input script (#1479).
 *
 *  The owner plays a take in the editor's GameView; the recorder saves what the game needs to
 *  play it again: where it started (the saved-data snapshot and the RNG seed) and every pointer
 *  transition, stamped in SIM seconds since the take began. A headless renderer then replays it at
 *  a fixed dt and captures each frame, so one take can be rendered at any quality, and rendered
 *  again after an art change without anyone replaying it.
 *
 *  ⚠️ **Stamped in sim time, not in frames.** A live take runs at whatever frame rate the editor
 *  managed, and the replay runs at the video's fps — the frame numbers of the two runs never line up,
 *  but the sim clock does. An event is dispatched before the first replay frame whose sim time has
 *  reached its stamp, which is the same place the live run processed it: `pointerSource` queues a
 *  DOM event and drains it in the NEXT frame's sample.
 *
 *  ⚠️ **Positions are in the game root's LAYOUT pixels**, the unscaled size the game was laid out
 *  at (`viewport`). The editor GameView lays the game out at the device preset's logical size and
 *  then CSS-scales it to fit the panel, so a raw clientX would bake the panel's size into the take.
 *  The replay must lay out at the same `viewport` for a position to hit the same thing; the output
 *  resolution is chosen separately, as a device scale factor on top of it.
 *
 *  Dependency-free on purpose: the CLI renderer (plain Node) imports this file directly. */

export const TAKE_FORMAT = 'modoki-take';
export const TAKE_VERSION = 1;

export type TakePointerKind = 'down' | 'move' | 'up';

export interface TakePointerEvent {
  /** Sim seconds since the take began. Non-decreasing across the list. */
  t: number;
  kind: TakePointerKind;
  /** Layout px relative to the game root's top-left. */
  x: number;
  y: number;
}

export interface Take {
  format: typeof TAKE_FORMAT;
  version: typeof TAKE_VERSION;
  /** The game id (`GameDefinition.id`) the take was played in. */
  game: string;
  /** The file name of the scene open when the take began (`main.scene.json`) — what the game
   *  route's `?scene=` resolves. The bare name `main` does NOT resolve (the matcher strips `.json`
   *  only), and an unresolved `?scene=` silently boots the default scene instead. */
  scene: string;
  /** The game root's layout size in CSS px — the replay's viewport. */
  viewport: { width: number; height: number };
  /** RNG seed installed when the take began. */
  seed: number;
  /** Sim seconds from the first frame to the moment recording stopped. */
  duration: number;
  /** Wall-clock epoch ms when the take began. Games read the real clock directly (Court's daily
   *  puzzle and boot menu key off today's LOCAL date), so the replay pins `Date` to this, advanced
   *  by sim time — otherwise a take recorded yesterday replays into a different day. */
  epochMs: number;
  /** IANA time zone the take was played in — the other half of "today's local date". */
  timezone: string;
  /** `navigator.language` — localised text in the frame depends on it. */
  locale: string;
  /** The preset's safe-area insets in layout px. The editor fakes them with `--ui-sa-*` CSS
   *  variables; a headless page has none, so anchored UI would sit somewhere else. */
  safeArea: { top: number; right: number; bottom: number; left: number };
  /** Saved data when the take began: each PlayerPrefs key → its RAW stored string (the envelope,
   *  unparsed), restored under the game's runtime namespace before the replay boots. Raw rather
   *  than parsed so the replay stores byte-for-byte what the editor had, envelope version and all. */
  prefs: Record<string, string>;
  events: TakePointerEvent[];
  /** The game's own journal events while the take was played (#1488), stamped on the take clock.
   *  Optional: a take recorded before it existed has none, and its replay is reported `unchecked`.
   *  The render compares them with what the replay emitted (`compareTakeEvents`). */
  expectedEvents?: TakeGameEvent[];
}

/** One game journal event, as a take stores it and a render reports it. */
export interface TakeGameEvent {
  /** Take-clock seconds when it was drained. Informational: the comparison ignores it, because
   *  pointer timing is quantised to the video's frame rate and would shift it by up to a frame. */
  t: number;
  type: string;
  payload: unknown;
}

const KINDS: ReadonlySet<string> = new Set(['down', 'move', 'up']);

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Validate an untrusted JSON value as a Take. Throws with EVERY problem found, not just the
 *  first, so a hand-edited take is fixed in one pass. */
export function parseTake(raw: unknown): Take {
  const problems: string[] = [];
  const o = (raw ?? {}) as Record<string, unknown>;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('take: expected a JSON object');
  }
  if (o.format !== TAKE_FORMAT) problems.push(`format must be "${TAKE_FORMAT}" (got ${JSON.stringify(o.format)})`);
  if (o.version !== TAKE_VERSION) problems.push(`version must be ${TAKE_VERSION} (got ${JSON.stringify(o.version)})`);
  if (typeof o.game !== 'string' || !o.game) problems.push('game must be a non-empty string');
  if (typeof o.scene !== 'string' || !o.scene) problems.push('scene must be a non-empty string');
  const vp = o.viewport as Record<string, unknown> | undefined;
  if (!vp || !isFiniteNumber(vp.width) || !isFiniteNumber(vp.height) || vp.width <= 0 || vp.height <= 0) {
    problems.push('viewport must be { width, height } with positive numbers');
  }
  if (!Number.isInteger(o.seed)) problems.push('seed must be an integer');
  if (!isFiniteNumber(o.duration) || o.duration < 0) problems.push('duration must be a number >= 0');
  if (!isFiniteNumber(o.epochMs) || o.epochMs <= 0) problems.push('epochMs must be a positive number');
  if (typeof o.timezone !== 'string' || !o.timezone) problems.push('timezone must be a non-empty string');
  if (typeof o.locale !== 'string' || !o.locale) problems.push('locale must be a non-empty string');
  const sa = o.safeArea as Record<string, unknown> | undefined;
  if (!sa || !(['top', 'right', 'bottom', 'left'] as const).every((k) => isFiniteNumber(sa[k]) && (sa[k] as number) >= 0)) {
    problems.push('safeArea must be { top, right, bottom, left } with numbers >= 0');
  }
  if (typeof o.prefs !== 'object' || o.prefs === null || Array.isArray(o.prefs)) {
    problems.push('prefs must be an object');
  } else {
    for (const [k, v] of Object.entries(o.prefs)) {
      if (typeof v !== 'string') problems.push(`prefs["${k}"] must be the raw stored string`);
    }
  }
  if (!Array.isArray(o.events)) {
    problems.push('events must be an array');
  } else {
    let prevT = 0;
    o.events.forEach((e: unknown, i: number) => {
      const ev = (e ?? {}) as Record<string, unknown>;
      if (!isFiniteNumber(ev.t) || ev.t < 0) { problems.push(`events[${i}].t must be a number >= 0`); return; }
      if (ev.t < prevT) problems.push(`events[${i}].t (${ev.t}) is earlier than the event before it (${prevT})`);
      prevT = ev.t;
      if (typeof ev.kind !== 'string' || !KINDS.has(ev.kind)) problems.push(`events[${i}].kind must be down, move or up`);
      if (!isFiniteNumber(ev.x) || !isFiniteNumber(ev.y)) problems.push(`events[${i}] needs numeric x and y`);
    });
  }
  if (o.expectedEvents !== undefined) {
    if (!Array.isArray(o.expectedEvents)) {
      problems.push('expectedEvents must be an array when present');
    } else {
      o.expectedEvents.forEach((e: unknown, i: number) => {
        const ev = (e ?? {}) as Record<string, unknown>;
        if (!isFiniteNumber(ev.t) || ev.t < 0) problems.push(`expectedEvents[${i}].t must be a number >= 0`);
        if (typeof ev.type !== 'string' || !ev.type) problems.push(`expectedEvents[${i}].type must be a non-empty string`);
      });
    }
  }
  if (problems.length) throw new Error(`take: ${problems.length} problem(s):\n  - ${problems.join('\n  - ')}`);
  return raw as Take;
}

/** Number of frames a replay at `fps` renders to cover the whole take.
 *
 *  Frame `f` is drawn after dispatching every event due by `f / fps`, so the LAST frame must be one
 *  whose dispatch time reaches `duration` — otherwise an event stamped at the very end (the closing
 *  `up` the recorder synthesises when a take is stopped mid-gesture) is never sent. Hence one frame
 *  more than `duration × fps`: the frames span [0, duration] inclusive. */
export function frameCountFor(take: Pick<Take, 'duration'>, fps: number): number {
  if (!(fps > 0)) throw new Error(`fps must be > 0 (got ${fps})`);
  return Math.ceil(Math.max(0, take.duration) * fps - 1e-9) + 1;
}

/** Walks a take's events in order and hands out the ones due by a given sim time. One instance per
 *  replay; `due` must be called with a non-decreasing time, exactly as the replay advances. */
export class TakeCursor {
  private next = 0;
  private readonly events: readonly TakePointerEvent[];
  constructor(events: readonly TakePointerEvent[]) { this.events = events; }

  /** Every not-yet-dispatched event stamped at or before `simTime`. */
  due(simTime: number): TakePointerEvent[] {
    const out: TakePointerEvent[] = [];
    // A float tolerance, not `<=` alone: a stamp of 0.5 recorded from a sum of 1/60 steps and a
    // replay time of 30 × (1/60) can differ in the last bit, and an event held back one frame by
    // that is a drag that lands a frame late on every replay.
    while (this.next < this.events.length && this.events[this.next].t <= simTime + 1e-9) {
      out.push(this.events[this.next++]);
    }
    return out;
  }

  /** Events not yet handed out. */
  get remaining(): number { return this.events.length - this.next; }
}

/** A GAME event, as opposed to an engine one (`@audio`, `@scene-loaded`, …). The replay check
 *  compares only these: the engine's own events describe how a scene was loaded and torn down, and
 *  the editor's Play press and the replay's page boot legitimately differ there. */
export function isTakeGameEvent(type: string): boolean { return !type.startsWith('@'); }

/** One payload field that differs between the played and the replayed copy of an event. */
export interface ReplayFieldDifference { path: string; played: unknown; replayed: unknown }

/** The replay check's verdict, as `render.json` reports it.
 *  - `diverged`: some event type happened a different number of times — the replay went somewhere
 *    else (a piece never placed, a second heart lost).
 *  - `differs`: every event happened, the same number of times, but some payloads differ. Often
 *    input measurement the replay cannot reproduce (a gesture's travel or hold time — pointer moves
 *    are coalesced per frame and dispatched at the video's frame rate); a differing OUTCOME field
 *    (a cell, a score) means the replay did go elsewhere. The fields are listed so it can be told apart. */
export type ReplayCheck =
  | { status: 'unchecked'; reason: string }
  | { status: 'matched'; events: number }
  | {
    status: 'diverged' | 'differs'; expected: number; replayed: number;
    /** Types whose COUNT differs. Empty for `differs`. */
    counts: { type: string; played: number; replayed: number }[];
    /** Per type, the first occurrence whose payload differs, and its differing fields (up to 5). */
    details: { type: string; occurrence: number; fields: ReplayFieldDifference[] }[];
  };

/** Whether two payloads say the same thing. Structural, so key order does not matter.
 *
 *  Numbers compare within an ABSOLUTE 0.01: a layout measurement differs in its last digits between
 *  the editor, which lays the game out inside a CSS-scaled div, and the headless page (Court's
 *  `court.relayout` measured 269.4687568551177 and 269.46875 for the same board). Absolute, so two
 *  integers are equal only when they are equal — a count, a score, a date key or an epoch either
 *  matches or the replay went elsewhere. A tolerance RELATIVE to the size was tried first, and
 *  review showed it calling 12345 vs 12346, and 20260924 vs 20260925, the same. */
export function samePayload(x: unknown, y: unknown): boolean {
  if (typeof x === 'number' && typeof y === 'number') {
    return Math.abs(x - y) <= 0.01;
  }
  if (Array.isArray(x) || Array.isArray(y)) {
    return Array.isArray(x) && Array.isArray(y) && x.length === y.length && x.every((v, i) => samePayload(v, y[i]));
  }
  if (x && y && typeof x === 'object' && typeof y === 'object') {
    const kx = Object.keys(x);
    const ky = Object.keys(y);
    return kx.length === ky.length && kx.every((k) => Object.hasOwn(y, k) && samePayload((x as Record<string, unknown>)[k], (y as Record<string, unknown>)[k]));
  }
  return (x ?? null) === (y ?? null);
}

type Ev = { type: string; payload: unknown };

/** The leaf fields where `x` and `y` differ (by `samePayload`), as dotted paths. */
export function payloadDifferences(x: unknown, y: unknown, at = '', out: ReplayFieldDifference[] = [], limit = 5): ReplayFieldDifference[] {
  if (out.length >= limit || samePayload(x, y)) return out;
  const bothObjects = x && y && typeof x === 'object' && typeof y === 'object' && Array.isArray(x) === Array.isArray(y);
  if (!bothObjects) { out.push({ path: at || '(payload)', played: x, replayed: y }); return out; }
  const keys = [...new Set([...Object.keys(x as object), ...Object.keys(y as object)])];
  for (const k of keys) {
    payloadDifferences((x as Record<string, unknown>)[k], (y as Record<string, unknown>)[k], at ? `${at}.${k}` : k, out, limit);
  }
  return out;
}

/** Compare the game events a take was played with against the ones its replay emitted: for EACH
 *  event type, how many happened, and whether each occurrence's payload matches its counterpart
 *  (the k-th of that type on each side). Engine events are skipped (`isTakeGameEvent`), and timing
 *  is ignored (see `TakeGameEvent.t`). A take with no `expectedEvents` is `unchecked`.
 *
 *  ⚠️ **Per type, not one global order.** Events from independent async work interleave by timing:
 *  measured on Court, `court.iap.trusted-clock` (a network fetch) landed after `court.session.restored`
 *  in the editor and before it in the replay, in a replay that was otherwise identical — the same
 *  placement, the same heart lost. A global order called every such take diverged. */
export function compareTakeEvents(expected: readonly Ev[] | undefined, replayed: readonly Ev[]): ReplayCheck {
  if (!expected) return { status: 'unchecked', reason: 'the take has no expectedEvents (recorded before the replay check existed)' };
  const group = (list: readonly Ev[]) => {
    const m = new Map<string, Ev[]>();
    for (const e of list) if (isTakeGameEvent(e.type)) (m.get(e.type) ?? m.set(e.type, []).get(e.type)!).push(e);
    return m;
  };
  const a = group(expected);
  const b = group(replayed);
  // Types in the order the owner first saw them, then any only the replay had.
  const types = [...new Set([...a.keys(), ...b.keys()])];
  const counts: { type: string; played: number; replayed: number }[] = [];
  const details: { type: string; occurrence: number; fields: ReplayFieldDifference[] }[] = [];
  for (const type of types) {
    const xs = a.get(type) ?? [];
    const ys = b.get(type) ?? [];
    if (xs.length !== ys.length) counts.push({ type, played: xs.length, replayed: ys.length });
    const k = xs.findIndex((x, i) => i < ys.length && !samePayload(x.payload, ys[i].payload));
    if (k >= 0) details.push({ type, occurrence: k + 1, fields: payloadDifferences(xs[k].payload, ys[k].payload) });
  }
  const total = (m: Map<string, Ev[]>) => [...m.values()].reduce((n, l) => n + l.length, 0);
  if (!counts.length && !details.length) return { status: 'matched', events: total(a) };
  return { status: counts.length ? 'diverged' : 'differs', expected: total(a), replayed: total(b), counts, details };
}
