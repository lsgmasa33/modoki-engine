/** `wait-for` (#1154): park until a CONDITION holds, instead of sleeping a guessed number of ms.
 *
 *  Measured over five clones' transcripts: 890 `modoki_eval` bodies hard-coded a sleep, and 1,061
 *  of 4,044 batch steps were the fixed `wait` step, with a p90 pinned at its 2 s cap. A fixed sleep
 *  is wrong both ways — too long wastes every run, too short reads early — and a one-shot read after
 *  it cannot tell "not yet" from "never". This checks immediately, then polls, and answers with what
 *  it SAW: the observation that satisfied it, or the last one before the deadline.
 *
 *  Pure: the op (`agentEditorOps.ts`) injects the readers, each of which is the resolver an existing
 *  read tool already uses, so a wait and the matching read cannot disagree:
 *  - chrome  → `collectHandles({editor:'chrome'})`, the handles `modoki_handles` reports (#1152);
 *  - entity  → `dumpSceneState`, i.e. `get_scene_state`'s own `guid`/`name`/`where`;
 *  - console → the renderer console ring, entries logged AFTER the wait began;
 *  - editor  → `readEditorState()`, the fields `get_editor_state` returns.
 *
 *  It polls rather than subscribing because two of the four have nothing to subscribe to (a DOM
 *  attribute, a trait field), and a poll keeps working while `advancing:false` freezes frames —
 *  a frame callback would not. */

export const WAIT_FOR_DEFAULT_MS = 5_000;
export const WAIT_FOR_MIN_MS = 50;
/** Same ceiling as `wait-for-edit`: long enough for a scene load or a human, short enough that a
 *  wedged renderer does not hold an HTTP request open indefinitely. Call again to keep waiting. */
export const WAIT_FOR_MAX_MS = 120_000;
export const WAIT_FOR_POLL_MS = 50;

export const CONSOLE_LEVELS = ['log', 'info', 'warn', 'error'] as const;
/** How far before the call a `console.lookbackMs` may reach. */
export const CONSOLE_LOOKBACK_MAX_MS = 60_000;
const TEXT_CAP = 300;

export interface ChromeCondition {
  label?: string;
  id?: string;
  /** Wait for NO handle to match (a dialog closing, a spinner going away). */
  absent?: boolean;
  disabled?: boolean;
  value?: string;
  checked?: boolean;
  expanded?: boolean;
  mixed?: boolean;
  /** The control's `data-ui-state`. */
  state?: string;
}
export interface EntityCondition {
  guid?: string;
  name?: string;
  /** `get_scene_state`'s grammar: `Trait.field <op> value`. */
  where?: string;
  absent?: boolean;
}
export interface ConsoleCondition {
  /** Case-sensitive substring of the entry's text. */
  match: string;
  level?: (typeof CONSOLE_LEVELS)[number];
  /** Also accept a line logged up to this many ms BEFORE the call. Without it a batch of
   *  `[tap, wait_for console]` can never see the line the tap's own handler logged: it landed
   *  before the wait took its watermark (close-out review). */
  lookbackMs?: number;
}
export interface EditorCondition {
  playState?: string;
  runMode?: string;
  advancing?: boolean;
  scenePath?: string;
}
export interface WaitCondition {
  chrome?: ChromeCondition;
  entity?: EntityCondition;
  console?: ConsoleCondition;
  editor?: EditorCondition;
}

export interface ChromeHandleLike {
  id: string;
  label?: string;
  meta?: Record<string, unknown>;
}
export interface ConsoleEntryLike {
  seq: number;
  level: string;
  args: string[];
}
export interface WaitReaders {
  chrome(filter: { label?: string; id?: string }): ChromeHandleLike[];
  /** `null` when the expression parses; the parse error otherwise. */
  whereError(where: string): string | null;
  entities(q: { guid?: string; name?: string; where?: string }): { count: number; first?: unknown };
  consoleSince(seq: number): ConsoleEntryLike[];
  /** The newest seq logged more than `lookbackMs` ago (0 = the newest seq of all): entries after
   *  it are the ones the wait may match. */
  consoleWatermark(lookbackMs: number): number;
  editorState(): Record<string, unknown>;
}

export type WaitResult =
  | { satisfied: true; elapsedMs: number; condition: string; observation: unknown }
  | { satisfied: false; timedOut: true; elapsedMs: number; condition: string; lastObservation: unknown };

const KINDS = ['chrome', 'entity', 'console', 'editor'] as const;
type Kind = (typeof KINDS)[number];
const FIELDS: Record<Kind, readonly string[]> = {
  chrome: ['label', 'id', 'absent', 'disabled', 'value', 'checked', 'expanded', 'mixed', 'state'],
  entity: ['guid', 'name', 'where', 'absent'],
  console: ['match', 'level', 'lookbackMs'],
  editor: ['playState', 'runMode', 'advancing', 'scenePath'],
};
const CHROME_STATE_FIELDS = ['disabled', 'value', 'checked', 'expanded', 'mixed', 'state'] as const;
const BOOL_FIELDS = new Set(['absent', 'disabled', 'checked', 'expanded', 'mixed', 'advancing']);
const NUMBER_FIELDS = new Set(['lookbackMs']);
const typeOfField = (f: string) => (BOOL_FIELDS.has(f) ? 'boolean' : NUMBER_FIELDS.has(f) ? 'number' : 'string');

export function clampWaitTimeout(requested: unknown): number {
  const n = typeof requested === 'number' && Number.isFinite(requested) ? requested : WAIT_FOR_DEFAULT_MS;
  return Math.max(WAIT_FOR_MIN_MS, Math.min(WAIT_FOR_MAX_MS, Math.floor(n)));
}

/** Why this condition can never be evaluated, or null. Checked BEFORE parking: a typo'd trait or a
 *  missing label would otherwise sit out the whole timeout and come back looking like "not yet". */
export function conditionError(cond: unknown, readers: Pick<WaitReaders, 'whereError'>): string | null {
  if (!cond || typeof cond !== 'object') return 'a condition object is required';
  const c = cond as Record<string, unknown>;
  const given = KINDS.filter((k) => c[k] !== undefined);
  const stray = Object.keys(c).filter((k) => !(KINDS as readonly string[]).includes(k));
  if (stray.length) return `unknown condition kind(s): ${stray.join(', ')} — use exactly one of ${KINDS.join(', ')}`;
  if (given.length !== 1) return `exactly one of ${KINDS.join(', ')} is required (got ${given.length ? given.join(' + ') : 'none'})`;
  const kind = given[0];
  const body = c[kind];
  if (!body || typeof body !== 'object' || Array.isArray(body)) return `${kind} must be an object`;
  const b = body as Record<string, unknown>;
  const unknownFields = Object.keys(b).filter((f) => !FIELDS[kind].includes(f));
  if (unknownFields.length) return `unknown ${kind} field(s): ${unknownFields.join(', ')} — valid: ${FIELDS[kind].join(', ')}`;
  for (const [f, v] of Object.entries(b)) {
    if (v === undefined) continue;
    if (typeof v !== typeOfField(f)) return `${kind}.${f} must be a ${typeOfField(f)}`;
  }
  switch (kind) {
    case 'chrome':
      if (!b.label && !b.id) return 'chrome needs a label or an id to aim at';
      if (b.absent && CHROME_STATE_FIELDS.some((f) => b[f] !== undefined)) return 'chrome.absent cannot be combined with a state field — an absent control has no state';
      return null;
    case 'entity':
      if (!b.guid && !b.name && !b.where) return 'entity needs a guid, a name or a where';
      return typeof b.where === 'string' ? readers.whereError(b.where) : null;
    case 'console':
      if (!b.match) return 'console.match (a non-empty substring) is required';
      if (b.level !== undefined && !(CONSOLE_LEVELS as readonly string[]).includes(b.level as string)) {
        return `console.level must be one of ${CONSOLE_LEVELS.join(', ')}`;
      }
      if (b.lookbackMs !== undefined && !((b.lookbackMs as number) >= 0 && (b.lookbackMs as number) <= CONSOLE_LOOKBACK_MAX_MS)) {
        return `console.lookbackMs must be within [0, ${CONSOLE_LOOKBACK_MAX_MS}]`;
      }
      return null;
    case 'editor':
      if (!FIELDS.editor.some((f) => b[f] !== undefined)) return `editor needs at least one of ${FIELDS.editor.join(', ')}`;
      return null;
  }
}

interface Evaluation { satisfied: boolean; observation: unknown }

function evalChrome(c: ChromeCondition, readers: WaitReaders): Evaluation {
  const matches = readers.chrome({ label: c.label, id: c.id });
  const summary = (h: ChromeHandleLike) => ({ id: h.id, ...(h.label ? { label: h.label } : {}), ...(h.meta ? { meta: h.meta } : {}) });
  if (c.absent) return { satisfied: matches.length === 0, observation: { matches: matches.length, ...(matches.length ? { first: summary(matches[0]) } : {}) } };
  const wanted = CHROME_STATE_FIELDS.filter((f) => c[f] !== undefined);
  if (!wanted.length) return { satisfied: matches.length > 0, observation: { matches: matches.length, ...(matches.length ? { first: summary(matches[0]) } : {}) } };
  // A state test needs ONE control. Two matches is not "either will do": they are different
  // controls, and the reader could not tell which one satisfied the wait. Say so and keep polling.
  if (matches.length !== 1) {
    return {
      satisfied: false,
      observation: matches.length
        ? { matches: matches.length, ambiguous: 'a state test needs exactly one match — aim by id', ids: matches.slice(0, 5).map((h) => h.id) }
        : { matches: 0 },
    };
  }
  const meta = matches[0].meta ?? {};
  // `disabled`/`mixed` are only ever PRESENT as true (chromeHandles omits a false flag), so absence
  // reads as false; `checked`/`expanded`/`value`/`state` are compared as reported.
  const actual = (f: (typeof CHROME_STATE_FIELDS)[number]) => (f === 'disabled' || f === 'mixed' ? meta[f] === true : meta[f]);
  return { satisfied: wanted.every((f) => actual(f) === c[f]), observation: { matches: 1, ...summary(matches[0]) } };
}

/** One matched entity, as small as the answer needs: who it is, plus the ONE trait `where` reads.
 *  The scene-state row carries every curated trait — measured live, a plain `Fog` entity came back
 *  as a full Transform/EntityAttributes/… record on every poll's observation (§6 budget). */
function entitySummary(row: unknown, where: string | undefined): unknown {
  if (!row || typeof row !== 'object') return row;
  const r = row as { guid?: unknown; name?: unknown; traits?: Record<string, unknown> };
  const trait = where ? /^\s*(\w+)\./.exec(where)?.[1] : undefined;
  return {
    guid: r.guid, name: r.name,
    ...(trait && r.traits && trait in r.traits ? { [trait]: r.traits[trait] } : {}),
  };
}

function evalEntity(c: EntityCondition, readers: WaitReaders): Evaluation {
  const r = readers.entities({ guid: c.guid, name: c.name, where: c.where });
  const observation = { matches: r.count, ...(r.first !== undefined ? { first: entitySummary(r.first, c.where) } : {}) };
  return { satisfied: c.absent ? r.count === 0 : r.count > 0, observation };
}

function evalEditor(c: EditorCondition, readers: WaitReaders): Evaluation {
  const state = readers.editorState();
  const keys = FIELDS.editor.filter((f) => (c as Record<string, unknown>)[f] !== undefined);
  const observation = Object.fromEntries(keys.map((k) => [k, state[k]]));
  return { satisfied: keys.every((k) => state[k] === (c as Record<string, unknown>)[k]), observation };
}

function describeCondition(cond: WaitCondition): string {
  const kind = KINDS.find((k) => cond[k] !== undefined)!;
  return `${kind} ${JSON.stringify(cond[kind])}`;
}

export interface WaitDeps {
  readers: WaitReaders;
  timeoutMs: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Evaluate now, then every `pollMs` until the condition holds or `timeoutMs` passes. The caller
 *  validates with `conditionError` first. A reader that THROWS (a world swapping mid-read) is a
 *  transient observation, not the end of the wait — waiting across a scene load is a normal use. */
export async function waitForCondition(cond: WaitCondition, deps: WaitDeps): Promise<WaitResult> {
  const now = deps.now ?? (() => performance.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = deps.pollMs ?? WAIT_FOR_POLL_MS;
  const { readers } = deps;
  const condition = describeCondition(cond);
  const start = now();
  // Entries at or before this seq were logged before the wait's window: a line that already
  // happened must not satisfy "wait until it is logged", or a stale line from the last run reads as
  // this one. `lookbackMs` widens the window backwards on purpose, for the step that just ran.
  const consoleFrom = cond.console ? readers.consoleWatermark(cond.console.lookbackMs ?? 0) : 0;
  for (;;) {
    let ev: Evaluation;
    try {
      if (cond.chrome) ev = evalChrome(cond.chrome, readers);
      else if (cond.entity) ev = evalEntity(cond.entity, readers);
      else if (cond.editor) ev = evalEditor(cond.editor, readers);
      else {
        const c = cond.console!;
        const fresh = readers.consoleSince(consoleFrom);
        const hit = fresh.find((e) => (!c.level || e.level === c.level) && e.args.join(' ').includes(c.match));
        ev = hit
          ? { satisfied: true, observation: { seq: hit.seq, level: hit.level, text: hit.args.join(' ').slice(0, TEXT_CAP) } }
          : { satisfied: false, observation: { newEntries: fresh.length } };
      }
    } catch (e) {
      ev = { satisfied: false, observation: { readError: e instanceof Error ? e.message : String(e) } };
    }
    const elapsed = now() - start;
    if (ev.satisfied) return { satisfied: true, elapsedMs: Math.round(elapsed), condition, observation: ev.observation };
    if (elapsed >= deps.timeoutMs) {
      return { satisfied: false, timedOut: true, elapsedMs: Math.round(elapsed), condition, lastObservation: ev.observation };
    }
    await sleep(Math.min(pollMs, deps.timeoutMs - elapsed));
  }
}
