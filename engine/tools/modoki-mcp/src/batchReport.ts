/** Turning a `BatchOutcome` into the thing the model actually reads.
 *
 *  This is where the token saving of `modoki_batch` is realized, and it is NOT the same job as
 *  running the batch — hence a separate module from `batch.ts`. Naive concatenation would be a
 *  REGRESSION: `result.ts` caps a single tool result at 60 000 chars, so eight steps emitted
 *  verbatim is eight times the ceiling the response budget exists to enforce.
 *
 *  The licence to drop payloads comes from the batch contract itself: a batch is only valid when
 *  no step's response is needed to decide a later step, so a non-terminal step's payload is BY
 *  DEFINITION unread. The only question it answers is "did it work".
 *
 *  Three rules keep that from becoming a lie:
 *
 *  1. **A FAILED step is always reported in full**, whatever its mode. Silence means success and
 *     nothing else — otherwise `'none'` becomes a way to swallow errors, the worst possible
 *     outcome for an agent-first engine.
 *  2. **A failure cancels `'none'` RETROACTIVELY.** If step 5 of 10 fails, steps 1–4 already
 *     applied and there is no cross-call rollback, so the envelope must list them even though
 *     their mode said `'none'`. Reporting only the failure and the not-run tail would describe a
 *     scene state that does not exist, and whoever cleans up needs to know how far it got.
 *  3. **The identity banner is emitted ONCE, on the envelope.** `result.ts` prepends it OUTSIDE
 *     the cap on purpose — it says "you are driving the other clone's editor", which makes every
 *     other byte a lie — but repeating it per step is pure noise, so it is stripped from each
 *     step's text and re-attached by the caller's `ok()`.
 *
 *  Full reference: `docs/mcp-response-budget.md` (the `modoki_batch` section). */

import { encode, summarize } from './result.js';
import type { BatchOutcome, StepOutcome } from './batch.js';

/** Below this, a step's payload is small enough to include verbatim under `'ack'`. Above it, the
 *  ack degrades to `summarize()` (shapes and counts, never values) rather than being cut — the
 *  same "a small honest answer beats a severed one" rule `result.ts` follows. */
export const ACK_VERBATIM_CHARS = 1_500;

/** Parse a step's text back to data when it is JSON, so `summarize()` has something to describe
 *  and the envelope nests as real JSON instead of embedding a quoted blob. Non-JSON payloads
 *  (build logs, plain messages) pass through as strings. */
function asData(text: string): unknown {
  try { return JSON.parse(text); } catch { return text; }
}

function ackOf(step: StepOutcome): unknown {
  const data = asData(step.text);
  if (step.text.length <= ACK_VERBATIM_CHARS) return data;
  return { elided: true, bytes: step.text.length, preview: summarize(data) };
}

/** Strip a leading identity banner from a step's text, if present. Exact-prefix only: the banner
 *  is a known literal, and a fuzzy match could eat a legitimate payload that merely resembles it. */
function stripBanner(text: string, banner: string | null): string {
  if (!banner) return text;
  const withSep = `${banner}\n\n`;
  return text.startsWith(withSep) ? text.slice(withSep.length) : text;
}

export interface BatchReport {
  ok: boolean;
  ran: number;
  /** Steps that ran clean and were suppressed by `'none'` — index + tool only. Present only on a
   *  fully successful batch; a failure promotes them into `steps` (rule 2). */
  quiet?: { i: number; tool: string }[];
  steps?: unknown[];
  failedAt?: number;
  failed?: number[];
  stoppedAt?: number;
  stoppedBy?: 'deadline';
  notRun?: { i: number; tool: string }[];
  /** Indexes whose payload the default `ack` mode summarized rather than included. */
  summarized?: number[];
  summarizedHint?: string;
  hint?: string;
}

/** Build the response body for a completed batch. */
export function reportBatch(outcome: BatchOutcome, banner: string | null = null): unknown {
  const failed = !outcome.ok;
  const shown: unknown[] = [];
  const quiet: { i: number; tool: string }[] = [];
  // Steps whose payload was summarized away by the default `ack`. Worth naming ONCE: only the
  // LAST step defaults to `full`, so a batch that ends in teardown (restore the timescale, stop
  // play) has its interesting read in the middle, where `ack` quietly trims it to a shape
  // summary. That is the right default and a trap at the same time — MEASURED while running use
  // case 4, where `modoki_journal` came back as `{elided:true,bytes:1579,preview:…}` and the
  // verification the batch existed to do was not in the response. The envelope now says how to
  // get it, instead of leaving the reader to re-read the tool docs.
  const ackElided: number[] = [];

  for (const raw of outcome.steps) {
    const step: StepOutcome = { ...raw, text: stripBanner(raw.text, banner) };
    // Rule 1 + rule 2: a failed step, or ANY step once the batch has failed, is reported.
    const suppressed = step.mode === 'none' && step.ok && !failed;
    if (suppressed) { quiet.push({ i: step.i, tool: step.tool }); continue; }
    if (!step.ok) {
      shown.push({ i: step.i, tool: step.tool, ok: false, error: asData(step.text) });
      continue;
    }
    // A 'none' step promoted by a later failure reports at ACK detail, not full: the caller needs
    // to know it RAN and succeeded, not to re-read a payload it already declared uninteresting.
    const mode = step.mode === 'none' ? 'ack' : step.mode;
    const result = mode === 'full' ? asData(step.text) : ackOf(step);
    if (mode === 'ack' && step.text.length > ACK_VERBATIM_CHARS) ackElided.push(step.i);
    shown.push({ i: step.i, tool: step.tool, ok: true, result });
  }

  const body: BatchReport = {
    ok: outcome.ok,
    ran: outcome.ran,
    ...(quiet.length ? { quiet } : {}),
    ...(shown.length ? { steps: shown } : {}),
    ...(outcome.failedAt !== undefined ? { failedAt: outcome.failedAt } : {}),
    ...(outcome.failed?.length ? { failed: outcome.failed } : {}),
    ...(outcome.stoppedAt !== undefined ? { stoppedAt: outcome.stoppedAt } : {}),
    ...(outcome.stoppedBy ? { stoppedBy: outcome.stoppedBy } : {}),
    ...(outcome.notRun?.length ? { notRun: outcome.notRun } : {}),
  };
  if (ackElided.length && outcome.ok) {
    body.summarized = ackElided;
    body.summarizedHint =
      `Step(s) ${ackElided.join(', ')} exceeded ${ACK_VERBATIM_CHARS} chars and are reported as a ` +
      "shape summary. Only the LAST step defaults to full detail — mark any earlier step you " +
      "actually need to READ with `result:'full'` (typical when the batch ends with teardown).";
  }
  if (outcome.stoppedBy === 'deadline') {
    // A different situation from a failing step, and the caller must not confuse them: nothing
    // went wrong, the run was simply cut off — so the applied prefix is CORRECT, not suspect.
    //
    // …unless a step ALSO failed before the cut-off, which stopOnError:false makes possible. The
    // hint used to assert "No step failed" unconditionally, contradicting the very steps[] it was
    // attached to. Report both facts when both happened.
    body.hint = outcome.failed?.length
      ? `The whole-batch deadline stopped the run before step ${outcome.stoppedAt}, AND step(s) ` +
        `${outcome.failed.join(', ')} FAILED before that. Steps up to \`ran\` applied; the rest never ` +
        'started. Fix the failure(s), then re-run the remaining steps — a batch is not a transaction.'
      : `The whole-batch deadline stopped the run before step ${outcome.stoppedAt}. No step failed: ` +
        'steps up to `ran` applied normally and the rest never started. Split the batch, or run the ' +
        'slow step on its own.';
  } else if (failed) {
    // The hint must match the MODE. It read "steps after `failedAt` did NOT run" unconditionally,
    // which is false with stopOnError:false — there, every step ran, and a caller acting on that
    // sentence re-sends work that already applied.
    body.hint = outcome.failedAt !== undefined
      ? 'Fail-fast: steps after `failedAt` did NOT run, and steps before it ALREADY APPLIED — ' +
        'a batch is not a transaction, so verify state before retrying rather than re-running the ' +
        'whole batch.'
      : `stopOnError:false — EVERY step ran. \`failed\` lists the ${outcome.failed?.length ?? 0} that ` +
        'did not succeed; the rest APPLIED. Retry only the failures — a batch is not a transaction ' +
        'and nothing was rolled back.';
  }

  // ONE encode over the whole envelope, so MAX_PAYLOAD_CHARS bounds the batch rather than each
  // step. Round-tripping through `encode` unconditionally is deliberate: under the cap it returns
  // the compact JSON (parsing it back yields `body` unchanged), and over the cap it returns the
  // `{elided:true,…}` envelope — a valid document either way, never a severed blob.
  //
  // Do NOT "optimize" this into a length check on `encode`'s OUTPUT. That output is SHORT exactly
  // when it elided, so `encode(body).length > CAP` is false in the one case that needs handling
  // and the oversized body sails through. (Written that way first; the 10-full-step test caught
  // it at 200 540 chars.)
  // ── OVER THE CAP, DROP PAYLOADS — NEVER THE VERDICT. ──
  // `encode` degrades an oversized document to `{elided, bytes, hint, preview}`, and `summarize`
  // is one level deep — so `steps` collapsed to the string 'array(N)'. On a FAILED batch that
  // erased which step failed and why, i.e. exactly the information the report exists to carry,
  // and the generic hint then advised narrowing with `trait=`/`limit=`/`full=1`, none of which
  // modoki_batch has.
  //
  // So shed weight in priority order instead: the successful steps' payloads are the bulk and the
  // least load-bearing (they succeeded — nothing to act on), while ok/ran/failedAt/failed/notRun
  // and the FAILING step's error text are what the caller needs to reconcile state.
  const encoded = encode(body);
  if (!isElided(encoded)) return asData(encoded);

  const steps = Array.isArray(body.steps) ? (body.steps as Array<Record<string, unknown>>) : [];
  const trimmed = {
    ...body,
    steps: steps.map((st) => (st.ok === false ? st : { ...st, result: undefined, text: undefined, dropped: 'payload omitted — over the response cap' })),
    payloadsDropped: steps.filter((st) => st.ok !== false).length,
    hint:
      `${body.hint ? `${body.hint} ` : ''}The successful steps' payloads were dropped to fit the ` +
      'response cap — the failure detail, `ran`, and `notRun` are intact. Re-run any step whose ' +
      'output you need as its OWN call.',
  };
  const retry = encode(trimmed);
  if (!isElided(retry)) return asData(retry);

  // Still too big (a single enormous failure message). Keep the verdict skeleton and say so,
  // rather than handing back a shape summary with no step in it at all.
  return asData(encode({
    ok: body.ok, ran: body.ran,
    ...(body.failedAt !== undefined ? { failedAt: body.failedAt } : {}),
    ...(body.failed ? { failed: body.failed } : {}),
    ...(body.stoppedAt !== undefined ? { stoppedAt: body.stoppedAt } : {}),
    ...(body.notRun ? { notRun: body.notRun } : {}),
    elidedSteps: true,
    hint: 'The per-step detail exceeded the response cap even after dropping successful payloads. ' +
      'Re-run the failing step on its own to see its error in full.',
  }));
}

/** Did `encode` degrade this to an elision envelope? Checked by PARSING, not by length — the
 *  elided form is SHORT precisely when it fired, so a length test is false in the one case that
 *  matters (the trap the comment above records). */
function isElided(encoded: string): boolean {
  try { return (JSON.parse(encoded) as { elided?: unknown }).elided === true; } catch { return false; }
}
