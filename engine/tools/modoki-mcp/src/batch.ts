/** `modoki_batch` — run an ORDERED, decision-free sequence of MCP calls in one turn.
 *
 *  WHY (docs/debug-tools-mcp.md, `modoki_batch`). Batching saves nothing on transport: every tool is
 *  a local fetch to 127.0.0.1, so ten of them cost ~0.3 s of HTTP. What it saves is model TURNS.
 *  Independent calls already collapse — a model can emit several `tool_use` blocks in one message
 *  — but those have NO GUARANTEED EXECUTION ORDER, so any sequence where order is semantically
 *  load-bearing (`create_entity` → `set_transform` → `save_all`) has to be serialized one turn at
 *  a time today. That is the common shape of authoring work, and it is the gap this closes.
 *
 *  THE CONTRACT, and the fact that it cannot be enforced:
 *
 *    Do not batch when a step's RESPONSE is needed to decide a later step.
 *
 *  That lives in the tool description and will occasionally be violated; nothing can check it.
 *  So the design makes a violation cheap rather than impossible — pre-flight validation means a
 *  bad batch mutates nothing, and fail-fast reports exactly how far it got.
 *
 *  The contract is also what licenses the token saving: if a step's response cannot influence a
 *  later step, it does not need to be returned. `result:'none'` drops it entirely (Phase 4).
 *
 *  BUFFERING IS STRUCTURAL, NOT AN OPTIMIZATION. `result` is a PRESENTATION choice decided once,
 *  at the end — never a capture choice made as we go. If step 5 of 10 fails, steps 1–4 already
 *  applied (there is no rollback across calls), so the envelope must be able to list them even
 *  though their mode said `'none'`. Reporting only the failure and the not-run tail would
 *  describe a scene state that does not exist. The obvious streaming loop gets this wrong, and
 *  gets it wrong only on the failure path — the path nobody exercises by hand. */

import { z, type ZodRawShape } from 'zod';
import type { ToolResult } from './result.js';
import { getTool as defaultGetTool, toolNames } from './registry.js';
import { CONTRACTS } from './contracts.js';

/** How much of a step's payload comes back. See the module header for why `'none'` is safe. */
export type ResultMode = 'none' | 'ack' | 'full';

export interface BatchStep {
  tool: string;
  args?: Record<string, unknown>;
  result?: ResultMode;
}

export interface BatchInput {
  steps: BatchStep[];
  /** Stop at the first failing step (default true). `false` runs on and records every failure. */
  stopOnError?: boolean;
  /** Default `result` mode for steps that do not set one. The LAST step still defaults to
   *  `'full'` — the terminal read is usually the point of the batch. */
  resultDefault?: ResultMode;
}

/** One step's outcome. `text` is the raw tool result; the caller decides how much to emit. */
export interface StepOutcome {
  i: number;
  tool: string;
  ok: boolean;
  mode: ResultMode;
  text: string;
}

export interface BatchOutcome {
  ok: boolean;
  ran: number;
  steps: StepOutcome[];
  /** Index of the step that failed, when one did. */
  failedAt?: number;
  /** Indices of every step that failed. Always present when anything failed. */
  failed?: number[];
  /** Where the whole-batch DEADLINE cut the run off. Distinct from `failedAt`: nothing failed
   *  here, the run simply ran out of time before this step started. */
  stoppedAt?: number;
  /** Steps that never executed because an earlier one failed (or the deadline hit). */
  notRun?: { i: number; tool: string }[];
  /** Set when the whole-batch deadline stopped the run rather than a failing step. Distinct from
   *  `failedAt` because NO step failed — the run was cut short, and the step at `failedAt` never
   *  ran at all (it is in `notRun`). */
  stoppedBy?: 'deadline';
}

/** A pre-flight rejection: nothing ran. */
export interface BatchRejection { rejected: string }

export const MAX_STEPS = 20;
export const MAX_WAIT_MS = 2_000;
export const BATCH_DEADLINE_MS = 90_000;

/** The `wait` pseudo-step — not a registered tool, handled here.
 *
 *  Exists so a batch can let the renderer settle between an input step and a capture. It is the
 *  one capability the rejected input-only design (`modoki_input_sequence`) would have given for
 *  free, so it is folded in rather than lost. */
export const WAIT = 'wait';

/** Tools a batch refuses to run (owner decision, plan §7 Q2).
 *
 *  `modoki_batch` itself: no nesting. `modoki_build` / `modoki_ota_publish`: they carry 65 s
 *  timeouts against everything else's 30 s, a real iOS build outruns both, and their output is a
 *  log you ALWAYS read — which is the definition of a step that does not belong under the
 *  decision-free contract. Denying beats leaning on the deadline, which could kill a build
 *  mid-flight and leave a state more ambiguous than either outcome.
 *
 *  DERIVED FROM THE CONTRACT TABLE, not hand-written. It was a literal listing 2 of the 3
 *  build-family tools, and the one it missed — `modoki_add_native_target`, a 15-MINUTE SSE that
 *  scaffolds native folders — was fully batchable. The whole-batch deadline provably cannot stop
 *  it either, because the deadline is only checked BETWEEN steps. `contracts.ts` already tags
 *  every build-family tool `kind:'build'`, so deriving the set means a NEW long-running tool is
 *  denied the day it is declared rather than the day someone remembers this literal. */
export const DENIED = new Set<string>([
  'modoki_batch', // no nesting — not a build, so not covered by the derivation below
  // `modoki_capture_gesture`'s from/to are REQUIRED raw viewport coordinates — it has no
  // selector/entity/handle aim at all, so unlike the tools in XY_AIMED below it cannot be
  // *re-aimed* to satisfy the no-raw-coordinates rule; there is nothing to steer it to. That makes
  // it the one aimed-input tool that does not fit the batch's decision-free contract, so it is
  // denied outright rather than refused per-call with advice it cannot follow (S3.4).
  'modoki_capture_gesture',
  ...Object.entries(CONTRACTS).filter(([, c]) => c.kind === 'build').map(([name]) => name),
]);

/** Aimed-input tools, and where their point specs live.
 *
 *  Raw `{x,y}` is REFUSED inside a batch (owner decision, plan §7 Q1). A batch is precisely where
 *  coordinates are most stale — step 7's were computed before step 1 moved anything — and where
 *  a mis-aimed tap is least visible. `entity`, `selector`, and handle ids all resolve
 *  server-side INSIDE their call and are unaffected. */
const XY_AIMED: Record<string, 'top' | 'endpoints' | 'to'> = {
  modoki_tap: 'top',
  modoki_hover: 'top',
  modoki_scroll: 'top',
  modoki_pointer: 'top',
  modoki_drag: 'endpoints',
  // S3.4 — these two were coordinate-aimable INSIDE a batch while the docs promised raw {x,y}
  // was refused: `modoki_dnd`'s from/to take viewport px, and `modoki_drag_handle`'s destination
  // can be `to:{x,y}`. Both have a non-coordinate alternative (`selector` endpoints; `toId`/
  // `delta`), so both belong under the rule rather than outside it.
  modoki_dnd: 'endpoints',
  modoki_drag_handle: 'to',
};

/** The tools the raw-{x,y} refusal covers, for the tool description — so the doc names the exact
 *  set instead of an unqualified promise the guard did not keep (S3.4). Short names: the reader is
 *  looking at `modoki_*` tools already. */
export const XY_AIMED_TOOLS = Object.keys(XY_AIMED).map((t) => t.replace(/^modoki_/, '')).sort();

const AIM_HINT =
  'aim by `entity` ({guid|name|id}), `selector`, a handle id, or (drag_handle) `toId`/`delta` ' +
  'instead — those resolve inside the call, so they cannot go stale mid-batch. Run a ' +
  'coordinate-aimed call on its own if you genuinely need one.';

/** Resolve a step's `tool` string to a registered name, treating the `modoki_` prefix as
 *  OPTIONAL. An EXACT match always wins; only a name nothing answers to is retried prefixed.
 *
 *  WHY (#295). Pre-flight validates every step before `runBatch` executes any, so an unresolvable
 *  name does not fail its own step — it voids the WHOLE batch, including the valid steps ahead of
 *  it. And a bare name is the natural thing to write: the docs, this file, and the tool
 *  descriptions all refer to these tools as `tap` / `save_all` / `scroll` in prose, so a batch of
 *  ten steps had ten chances to spend a turn on a prefix. Accepting the shorthand costs one Map
 *  lookup and removes the whole failure.
 *
 *  Exact-first is what keeps this safe for the DYNAMIC tail: a game registers `<gameId>_<verb>`
 *  (#270), so `court_load_level` resolves as itself and is never re-read as `modoki_court_...`.
 *
 *  `DENIED` is consulted here too, so a shorthand for a denied tool reports the DENIAL — the
 *  actionable answer ("run it as its own call") — instead of "unknown tool", which would send the
 *  caller off to fix a name that is spelled fine.
 *
 *  PRECEDENCE, exactly. The bare `wait` pseudo-step is the ONE thing that outranks a registered
 *  tool, because it is the documented spelling and is not a registry entry at all. Everything
 *  after it is exact-match-first. (A game tool named bare `wait` would therefore be unreachable
 *  from a batch, so `registerAgentTool` refuses that one name.) */
export function resolveToolName(name: string, getTool: typeof defaultGetTool): string {
  if (name === WAIT) return WAIT;
  // Exact registration beats the `modoki_wait` alias below: if the engine ever ships a real tool
  // by that name, a step naming it must reach the TOOL, not silently become a sleep — the
  // wrong-handler substitution `registerTool`'s duplicate-throw exists to prevent.
  if (getTool(name)) return name;
  // `modoki_wait` is the mirror-image slip of the one this function exists for — left alone it
  // would void a batch for the same reason — so it means the pseudo-step too.
  if (name === `modoki_${WAIT}`) return WAIT;
  const prefixed = `modoki_${name}`;
  if (getTool(prefixed) || DENIED.has(prefixed)) return prefixed;
  return name; // unresolvable — pre-flight reports it under the name as written
}

function usesRawXY(tool: string, args: Record<string, unknown>): string | null {
  const where = XY_AIMED[tool];
  if (!where) return null;
  const hasXY = (o: unknown): boolean =>
    !!o && typeof o === 'object' && typeof (o as { x?: unknown }).x === 'number'
      && typeof (o as { y?: unknown }).y === 'number';
  // An entity/selector aim WINS over stray coordinates in `resolvePoint`, so coordinates
  // sitting beside one are inert and must not trip this. Only a call that would actually BE
  // coordinate-aimed is refused.
  const aimed = (o: unknown): boolean =>
    !!o && typeof o === 'object'
      && (!!(o as { selector?: string }).selector
        || (!!(o as { entity?: object }).entity && Object.keys((o as { entity: object }).entity ?? {}).length > 0));
  if (where === 'top') return hasXY(args) && !aimed(args) ? 'x/y' : null;
  // `drag_handle` aims its SOURCE by handle id (never coordinates); only the destination can be
  // raw, and `toId`/`delta` are the stale-proof alternatives.
  if (where === 'to') return hasXY(args.to) ? 'to.x/y' : null;
  for (const end of ['from', 'to'] as const) {
    const spec = args[end];
    if (hasXY(spec) && !aimed(spec)) return `${end}.x/y`;
  }
  return null;
}

export interface BatchDeps {
  getTool?: typeof defaultGetTool;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Validate EVERY step before executing ANY of them.
 *
 *  This is what rescues schema validation. A batch envelope must type its steps as
 *  `args: z.record(z.any())` — there is no way to express "75 different shapes depending on a
 *  sibling field" — so without re-parsing against each tool's REAL zod shape, a batch would
 *  forfeit all 75 hand-written schemas at exactly the moment the model is authoring ten argument
 *  objects with no per-call feedback. It also means a typo in step 9 cannot leave steps 1–8
 *  applied: the whole class of half-mutated batches simply never happens. */
/** Pre-flight's answer: a refusal (nothing ran), or the RESOLVED tool name for every step.
 *
 *  Handing the names back is what makes resolution happen exactly ONCE. Resolving again in the
 *  executor would re-decide it against a registry that MUTATES mid-run — `gameTools.ts` polls and
 *  re-registers as the human opens and closes a project, and a batch may sit in a `wait` or a slow
 *  handler for a long time. A name that resolved via the `modoki_` prefix at pre-flight could then
 *  hit the exact-match branch on the second pass and run a DIFFERENT handler — one whose schema
 *  never saw these args, silently bypassing the strict re-parse that is the whole reason the
 *  registry exists. Resolve once, carry the answer. */
type PreflightResult = { rejected: string } | { tools: string[] };

function preflight(input: BatchInput, getTool: typeof defaultGetTool): PreflightResult {
  const { steps } = input;
  if (!Array.isArray(steps) || steps.length === 0) return { rejected: 'batch: `steps` must be a non-empty array.' };
  if (steps.length > MAX_STEPS) return { rejected: `batch: ${steps.length} steps exceeds the cap of ${MAX_STEPS}.` };

  /** The resolved name PER STEP, handed to the executor — see PreflightResult. */
  const resolved: string[] = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    // `at` names the tool AS WRITTEN, not as resolved — it is there to help the caller find the
    // step in the array they sent.
    const at = `step ${i} (${step?.tool ?? 'no tool'})`;
    if (!step || typeof step.tool !== 'string' || !step.tool) return { rejected: `batch: ${at}: every step needs a \`tool\` name.` };
    // Everything below keys off the RESOLVED name, so the `modoki_` prefix is optional for the
    // denial and raw-{x,y} rules too — a shorthand cannot slip past a refusal (#295).
    const tool = resolveToolName(step.tool, getTool);
    resolved[i] = tool;
    // Unknown keys on the STEP WRAPPER, checked here as well as in the tool's zod shape. Belt and
    // braces on purpose: `runBatch` is called directly (tests, and any future caller), and the one
    // key worth protecting most is `args` — a step written `{tool, arg:{…}}` had the singular
    // silently stripped and then ran with NO arguments, i.e. as a much broader operation reported
    // as success.
    const unknownStepKeys = Object.keys(step).filter((k) => k !== 'tool' && k !== 'args' && k !== 'result');
    if (unknownStepKeys.length) {
      return { rejected: `batch: ${at}: unknown step key(s) ${unknownStepKeys.map((k) => `\`${k}\``).join(', ')} — a step accepts only \`tool\`, \`args\` (PLURAL), \`result\`. Nothing ran.` };
    }
    if (step.result && !['none', 'ack', 'full'].includes(step.result)) {
      return { rejected: `batch: ${at}: result must be 'none' | 'ack' | 'full'.` };
    }
    const args = (step.args ?? {}) as Record<string, unknown>;

    if (tool === WAIT) {
      const ms = args.ms;
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return { rejected: `batch: ${at}: wait needs {ms: <number ≥ 0>}.` };
      if (ms > MAX_WAIT_MS) return { rejected: `batch: ${at}: wait ms ${ms} exceeds the cap of ${MAX_WAIT_MS}.` };
      continue;
    }
    if (DENIED.has(tool)) {
      return { rejected: `batch: ${at}: this tool is not allowed in a batch — run it as its own call.` };
    }
    const entry = getTool(tool);
    if (!entry) {
      const known = toolNames().length;
      return { rejected: `batch: ${at}: unknown tool — ${known} tools are registered, and nothing ran. `
        + `Check the name; the \`modoki_\` prefix is optional, so this is not a prefix problem.` };
    }
    const rawXY = usesRawXY(tool, args);
    if (rawXY) return { rejected: `batch: ${at}: raw ${rawXY} aiming is not allowed inside a batch — ${AIM_HINT}` };

    // STRICT: an unknown key is an error here, not something to strip.
    //
    // zod's default behaviour silently DROPS keys the shape doesn't declare, and for a tool whose
    // params are all optional that turns a typo into a different operation. MEASURED on batch use
    // case 8: `modoki_set_selection {name:'Capsule'}` — `name` is not a parameter — parsed to `{}`,
    // which that tool documents as "no refs at all = clear", so it CLEARED the selection and
    // reported `ok`. A misspelling that succeeds at doing something else is the worst outcome for a
    // batch, because there is no intermediate response to notice it in. (The
    // `timeScale`-instead-of-`scale` typo WAS caught the same day — but only because `scale` is
    // required; an all-optional schema catches nothing.)
    const parsed = z.object(entry.shape as ZodRawShape).strict().safeParse(args);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue.path.join('.') || '(root)';
      const known = Object.keys(entry.shape).join(', ');
      // Name the accepted keys on an unrecognized-key error: the whole failure is "you used a name
      // this tool doesn't have", so the answer is the list of names it does.
      const extra = issue.code === 'unrecognized_keys' ? ` — accepted params: ${known}` : '';
      return { rejected: `batch: ${at}: invalid args — ${where}: ${issue.message}${extra}` };
    }
  }
  return { tools: resolved };
}

/** Which `result` mode a step gets when it did not choose one. The LAST step defaults to `full`
 *  because the terminal read is usually the point of the batch — so the common case needs no
 *  annotation at all. */
function modeFor(step: BatchStep, i: number, total: number, fallback: ResultMode): ResultMode {
  if (step.result) return step.result;
  return i === total - 1 ? 'full' : fallback;
}

/** Run the batch. Returns a rejection (nothing ran) or an outcome. Never throws. */
export async function runBatch(input: BatchInput, deps: BatchDeps = {}): Promise<BatchOutcome | BatchRejection> {
  const getTool = deps.getTool ?? defaultGetTool;
  const sleep = deps.sleep ?? realSleep;
  const now = deps.now ?? Date.now;

  const pf = preflight(input, getTool);
  if ('rejected' in pf) return { rejected: pf.rejected };
  /** Resolved ONCE, at pre-flight. Never re-resolve here — see PreflightResult. */
  const resolved = pf.tools;

  const { steps } = input;
  const stopOnError = input.stopOnError !== false;
  const fallback = input.resultDefault ?? 'ack';
  const started = now();

  const out: StepOutcome[] = [];
  let failedAt: number | undefined;
  /** EVERY failing step index. In fail-fast mode this is at most one; with stopOnError:false the
   *  run continues, and the set is the only honest summary (see the return below). */
  const failed: number[] = [];
  let stoppedBy: 'deadline' | undefined;
  /** Where the whole-batch deadline cut the run off. NOT a failure index — see the deadline check. */
  let stoppedAt: number | undefined;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const mode = modeFor(step, i, steps.length, fallback);

    if (now() - started > BATCH_DEADLINE_MS) {
      // Do NOT push a step outcome here. A synthetic entry would land in `steps` and be counted
      // by `ran`, claiming a step executed when it provably did not — and it would also be
      // missing from `notRun`, so BOTH numbers would lie in the same direction. Record the cause
      // instead and let this step fall into `notRun` with the rest of the tail.
      // `stoppedAt` is where the run was CUT OFF; `failedAt` is where a step FAILED. They are
      // different facts and used to share one field: this assigned `failedAt = i` unconditionally
      // (unlike the failure path's `??=`), so with stopOnError:false a real earlier failure index
      // was clobbered by the index of a step the deadline merely skipped — and the report then
      // said "No step failed" over a steps[] that showed one.
      stoppedAt = i;
      stoppedBy = 'deadline';
      break;
    }

    const tool = resolved[i];
    if (tool === WAIT) {
      await sleep((step.args as { ms: number }).ms);
      out.push({ i, tool: WAIT, ok: true, mode, text: JSON.stringify({ waited: (step.args as { ms: number }).ms }) });
      continue;
    }

    // Pre-flight proved this name resolved THEN; the registry can still lose it (a project close
    // unregisters game tools mid-run), so the deref stays inside the try below and a vanished tool
    // becomes a failed STEP rather than an escaped throw. `runBatch` never throws.
    const entry = getTool(tool)!;
    let res: ToolResult;
    try {
      res = await entry.handler(step.args ?? {});
    } catch (e) {
      // A handler that THROWS must be a failed step, not a failed batch — otherwise the applied
      // prefix is lost along with the stack, and the caller cannot tell what already happened.
      res = { content: [{ type: 'text', text: `threw: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
    }
    const ok = res.isError !== true;
    // Report the RESOLVED name: the report says what actually ran, and a caller who wrote the
    // shorthand sees the full name they can re-send as a single call.
    out.push({ i, tool, ok, mode, text: res.content.map((c) => c.text).join('\n') });
    if (!ok) {
      failed.push(i);
      failedAt ??= i;
      if (stopOnError) break;
    }
  }

  const ranTo = out.length;
  // Resolved names here too. A report that named the ran steps `modoki_save_all` and the skipped
  // one `save_all` describes one batch in two vocabularies — and `notRun` is precisely the list a
  // caller re-sends from.
  const notRun = steps.slice(ranTo).map((_s, k) => ({ i: ranTo + k, tool: resolved[ranTo + k] }));
  // `failedAt` MEANS "the run stopped here". That is only true in fail-fast mode — with
  // stopOnError:false the run continues, so reporting `failedAt:0` alongside a hint reading
  // "steps after failedAt did NOT run" described a batch that had in fact run every step. The
  // caller then re-sends work that already applied. In continue mode the honest answer is the SET
  // of failures, so `failed` is reported instead and `failedAt` is withheld.
  //
  // A deadline stop is still a genuine "stopped here" and keeps `failedAt` in either mode.
  const stoppedHere = stopOnError || stoppedBy === 'deadline';
  // A deadline cut-off does not erase a failure that happened before it — report BOTH.
  return {
    ok: failed.length === 0 && stoppedBy === undefined,
    ran: ranTo,
    steps: out,
    ...(failedAt !== undefined && stoppedHere ? { failedAt } : {}),
    ...(stoppedAt !== undefined ? { stoppedAt } : {}),
    ...(failed.length ? { failed } : {}),
    ...(stoppedBy ? { stoppedBy } : {}),
    ...(notRun.length ? { notRun } : {}),
  };
}
