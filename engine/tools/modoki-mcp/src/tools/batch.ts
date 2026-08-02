/** modoki_batch — ordered, decision-free sequence of calls in ONE turn.
 *
 *  Registered by `registerAllTools` (`../registerAll.ts`). Side-effect-free on import:
 *  nothing here runs until the register function is called, which is what lets a test
 *  build a context against a stub backend and call these handlers. See `../context.ts`.
 */

import { z } from 'zod';
import type { ToolDef } from '../toolDef.js';
import type { ToolContext } from '../context.js';
import { runBatch, DENIED, XY_AIMED_TOOLS, MAX_STEPS, MAX_WAIT_MS } from '../batch.js';
import { reportBatch } from '../batchReport.js';
import { MAX_PAYLOAD_CHARS } from '../result.js';

export function registerBatchTool(tool: ToolDef, ctx: ToolContext): void {
  const { ok, fail, ensureIdentity, getIdentityWarning } = ctx;

  // ── batch — ordered, decision-free sequence of calls in ONE turn ──
  tool(
    'modoki_batch',
    'Run several modoki_* calls IN ORDER, in one turn. Use it when you already know the whole ' +
      'sequence: create → transform → save, or tap → wait → capture. It exists because ordering ' +
      'cannot be expressed any other way — issuing several tool calls in one message does NOT ' +
      'guarantee they run in order — and because it lets you DROP the intermediate responses.\n\n' +
      'DO NOT use it when you need a step\'s response to decide a later step. There is no way to ' +
      'branch mid-batch; pre-flight rejects the whole batch if any step is malformed, and ' +
      'execution stops at the first failure.\n\n' +
      'Each step is {tool, args, result}. `result` controls what comes back: "none" (omit — for ' +
      'steps whose output you will not read), "ack" (default: small payloads verbatim, large ones ' +
      'summarized), "full" (everything; automatic for the LAST step, so a batch ending in a read ' +
      'needs no annotation). `resultDefault` sets the default for all non-terminal steps — pass ' +
      '"none" for a pure input macro. A FAILED step is always reported in full whatever its mode, ' +
      'and a failure also un-suppresses the steps before it: they already applied, and a batch is ' +
      'NOT a transaction — nothing is rolled back.\n\n' +
      '`{"tool":"wait","args":{"ms":100}}` is a pseudo-step that lets the renderer settle between ' +
      'an input step and a capture (max ' + MAX_WAIT_MS + 'ms).\n\n' +
      'REFUSED at pre-flight (nothing runs): raw {x,y} aiming on ' + XY_AIMED_TOOLS.join('/') + ' — ' +
      'aim by `entity` ({guid|name|id}), `selector`, a handle id, or (drag_handle) toId/delta, which ' +
      'resolve inside their own call and cannot go stale mid-batch; and ' +
      [...DENIED].filter((t) => t !== 'modoki_batch').sort().join(' / ') +
      ', and a nested modoki_batch — all of which belong in their own call. Max ' + MAX_STEPS + ' steps.\n\n' +
      'UNDO: each step is a separate undoable action, so a human\'s Cmd-Z unwinds a batch one ' +
      'step at a time rather than all at once.',
    {
      // STRICT on the STEP OBJECT, not just on its args. The args were already re-parsed strictly
      // per tool, but the step wrapper was not — so `{tool, arg:{…}}` (singular) had `arg` STRIPPED
      // by this schema before pre-flight could see it, and the step then ran with NO arguments at
      // all. Measured: `{tool:'modoki_get_scene_state', arg:{name:'cube'}}` returned the whole
      // 136-entity index instead of one entity, `ok:true`. A dropped `args` is the worst possible
      // key to lose silently — the step becomes a different, usually much broader, operation.
      steps: z.array(z.object({
        tool: z.string().describe('Tool name, e.g. "modoki_set_transform" — or "wait".'),
        args: z.record(z.any()).optional().describe("That tool's own arguments, validated against its real schema before ANY step runs."),
        result: z.enum(['none', 'ack', 'full']).optional().describe('How much of this step to return. Default: "ack", or "full" for the last step.'),
      }).strict('a batch step accepts only: tool, args, result (note `args` is PLURAL).')).describe('Steps, executed in array order.'),
      stopOnError: z.boolean().optional().describe('Stop at the first failing step (default true). false runs them all and reports every failure.'),
      resultDefault: z.enum(['none', 'ack', 'full']).optional().describe('Default `result` for non-terminal steps (default "ack").'),
    },
    async ({ steps, stopOnError, resultDefault }) => {
      await ensureIdentity();
      const outcome = await runBatch({ steps: steps as never, stopOnError, resultDefault });
      // A pre-flight rejection means NOTHING RAN — distinguish it from a mid-batch failure, where
      // the earlier steps already applied and are not rolled back.
      if ('rejected' in outcome) {
        return fail({
          code: 'REFUSED_BY_OP',
          what: `run a ${steps.length}-step batch`,
          why: `pre-flight refused the batch, so NO step ran and nothing changed: ${outcome.rejected}`,
          options: [
            'fix the named step and re-send the whole batch — no partial state to clean up',
            'aim by entity/selector/handle rather than raw {x,y}; run build / ota_publish / a nested batch as their own call',
          ],
        });
      }
      const body = reportBatch(outcome, getIdentityWarning());
      // The batch's own `ok:false` must surface as a FAILED tool call (the C7 rule) — a caller
      // keying off isError would otherwise read a half-applied batch as a clean success.
      if (outcome.ok) return ok(body);
      // `outcome.ok` is false when the DEADLINE fired even with zero failures, so a purely
      // time-truncated batch was told "at least one step FAILED" and pointed at a failing step that
      // does not exist — while its own report body said `stoppedBy:'deadline'` and listed no
      // failure. Two different situations, two different next moves.
      const anyFailed = !!outcome.failed?.length;
      return fail({
        code: 'PARTIAL',
        what: `run a ${steps.length}-step batch`,
        why: anyFailed
          ? 'at least one step FAILED. A batch is NOT a transaction: the steps before the failure already applied and were NOT rolled back. The per-step report below says which ran.'
          : `the whole-batch DEADLINE stopped the run before step ${outcome.stoppedAt} — NO step failed. The steps that ran applied normally and were NOT rolled back; the rest never started.`,
        got: body,
        // The report was already shrunk to fit the RESPONSE budget with the failing step's error
        // deliberately preserved (reportBatch); re-cutting it at the default 8k `got` budget would
        // discard exactly that.
        gotBudget: MAX_PAYLOAD_CHARS,
        options: anyFailed
          ? [
              'read the failing step\'s own error, fix it, and re-send ONLY the remaining steps',
              'undo is per STEP, not per batch — a human Cmd-Z unwinds one step at a time',
            ]
          : [
              're-send only the steps in `notRun` — the applied prefix is correct, not suspect',
              'split the batch, or run the slow step on its own',
            ],
      });
    },
  );
}
