/** Unit: the `modoki_batch` executor — pre-flight, ordering, fail-fast, and the buffering rule.
 *
 *  Every test here is about a FAILURE path, and that is deliberate. The happy path of a batch is
 *  trivial (call things in order); what earns the complexity is behaving correctly when a step is
 *  wrong, and doing so without leaving the caller with a description of a scene state that does
 *  not exist. The executor takes its registry by injection precisely so this can be asserted with
 *  no editor, no network, and no MCP transport.
 *
 *  See `docs/debug-tools-mcp.md` (`modoki_batch`). */

import { describe, it, expect, beforeEach, vi } from 'vitest';
// NOT the bare 'zod' specifier: the repo root is on zod 4 and `modoki-mcp` pins zod 3, and the
// two instances are not interchangeable — a shape built by one and `safeParse`d by the other
// dies with `keyValidator._parse is not a function`. The executor parses with the MCP package's
// zod (as does `index.ts`, which builds the real shapes), so a fake registry must build its
// shapes with that same instance or it is testing a configuration that cannot occur.
import { z } from '../../tools/modoki-mcp/node_modules/zod';
import { runBatch, MAX_STEPS, MAX_WAIT_MS, type BatchOutcome, type BatchRejection } from '../../tools/modoki-mcp/src/batch';
import type { RegisteredTool } from '../../tools/modoki-mcp/src/registry';
import { reportBatch } from '../../tools/modoki-mcp/src/batchReport';

/** Ordered log of what actually executed — the point of a batch is SEQUENCE, so the assertions
 *  are on order, not merely on "everything ran". */
let ran: string[];

const okResult = (text = '{}') => ({ content: [{ type: 'text' as const, text }] });
const errResult = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });

function fakeRegistry(): (name: string) => RegisteredTool | undefined {
  const tools: Record<string, RegisteredTool> = {
    modoki_set_transform: {
      name: 'modoki_set_transform', description: '', shape: { entity: z.object({ guid: z.string() }), position: z.array(z.number()).length(3).optional() },
      handler: async (a: { entity: { guid: string } }) => { ran.push(`set_transform(${a.entity.guid})`); return okResult('{"changed":1}'); },
    },
    modoki_save_all: {
      name: 'modoki_save_all', description: '', shape: {},
      handler: async () => { ran.push('save_all'); return okResult('{"saved":true}'); },
    },
    // All-optional params — the shape class that made the unknown-key bug dangerous: with nothing
    // required, a misspelled key parses to `{}` and this tool documents `{}` as "clear the
    // selection", so a typo succeeded at doing something else entirely.
    modoki_set_selection: {
      name: 'modoki_set_selection', description: '',
      shape: { guid: z.string().optional(), guids: z.array(z.string()).optional(), entityId: z.number().nullable().optional() },
      handler: async () => { ran.push('set_selection'); return okResult('{"ok":true}'); },
    },
    modoki_boom: {
      name: 'modoki_boom', description: '', shape: {},
      handler: async () => { ran.push('boom'); return errResult('backend 500: exploded'); },
    },
    modoki_throws: {
      name: 'modoki_throws', description: '', shape: {},
      handler: async () => { ran.push('throws'); throw new Error('socket hung up'); },
    },
    modoki_tap: {
      name: 'modoki_tap', description: '',
      shape: {
        x: z.number().optional(), y: z.number().optional(), selector: z.string().optional(),
        entity: z.object({ guid: z.string().optional(), name: z.string().optional() }).optional(),
      },
      handler: async () => { ran.push('tap'); return okResult('{"ok":true}'); },
    },
    modoki_drag: {
      name: 'modoki_drag', description: '',
      shape: { from: z.record(z.any()), to: z.record(z.any()) },
      handler: async () => { ran.push('drag'); return okResult('{"ok":true}'); },
    },
    modoki_build: {
      name: 'modoki_build', description: '', shape: {},
      handler: async () => { ran.push('build'); return okResult(); },
    },
    // S3.4 — the three tools the raw-{x,y} rule used to MISS.
    modoki_dnd: {
      name: 'modoki_dnd', description: '',
      shape: { from: z.record(z.any()), to: z.record(z.any()) },
      handler: async () => { ran.push('dnd'); return okResult('{"accepted":true}'); },
    },
    modoki_drag_handle: {
      name: 'modoki_drag_handle', description: '',
      shape: {
        id: z.string(), to: z.object({ x: z.number(), y: z.number() }).optional(),
        toId: z.string().optional(), delta: z.object({ dx: z.number(), dy: z.number() }).optional(),
      },
      handler: async () => { ran.push('drag_handle'); return okResult('{"ok":true}'); },
    },
    modoki_capture_gesture: {
      name: 'modoki_capture_gesture', description: '',
      shape: { from: z.object({ x: z.number(), y: z.number() }), to: z.object({ x: z.number(), y: z.number() }) },
      handler: async () => { ran.push('capture_gesture'); return okResult('{"samples":[]}'); },
    },
  };
  return (name: string) => tools[name];
}

let getTool: (name: string) => RegisteredTool | undefined;
const run = (input: Parameters<typeof runBatch>[0], extra: Parameters<typeof runBatch>[1] = {}) =>
  runBatch(input, { getTool, sleep: async () => {}, ...extra });

const isRejection = (r: BatchOutcome | BatchRejection): r is BatchRejection => 'rejected' in r;

beforeEach(() => { ran = []; getTool = fakeRegistry(); });

describe('pre-flight — nothing runs until everything validates', () => {
  it('rejects an unknown tool and executes NOTHING', async () => {
    const r = await run({ steps: [{ tool: 'modoki_save_all' }, { tool: 'modoki_nope' }] });
    expect(isRejection(r)).toBe(true);
    expect((r as BatchRejection).rejected).toContain('unknown tool');
    // The load-bearing half: step 0 was valid and still must not have run.
    expect(ran).toEqual([]);
  });

  it('rejects bad args against the tool REAL schema — not a loose record', async () => {
    const r = await run({ steps: [{ tool: 'modoki_set_transform', args: { entity: { guid: 42 } } }] });
    expect((r as BatchRejection).rejected).toMatch(/invalid args/);
    expect(ran).toEqual([]);
  });

  it('rejects an UNKNOWN arg key instead of silently dropping it', async () => {
    // zod strips undeclared keys by default, and for an all-optional schema that turns a typo into
    // a DIFFERENT operation. MEASURED on batch use case 8: `set_selection {name:'Capsule'}` parsed
    // to `{}`, which that tool documents as "no refs = clear" — so it cleared the selection and
    // reported ok. In a batch there is no intermediate response in which to notice.
    const r = await run({ steps: [{ tool: 'modoki_set_selection', args: { name: 'Capsule' } }] });
    expect(isRejection(r)).toBe(true);
    expect((r as BatchRejection).rejected).toMatch(/invalid args/);
    // The message must carry the fix: the parameter names this tool actually has.
    expect((r as BatchRejection).rejected).toMatch(/accepted params:.*guid/);
    expect(ran).toEqual([]);
  });

  it('names the offending step index', async () => {
    const r = await run({
      steps: [{ tool: 'modoki_save_all' }, { tool: 'modoki_save_all' }, { tool: 'modoki_set_transform', args: {} }],
    });
    expect((r as BatchRejection).rejected).toContain('step 2');
  });

  it('refuses the denied tools, pointing at the single-call escape', async () => {
    const r = await run({ steps: [{ tool: 'modoki_build' }] });
    expect((r as BatchRejection).rejected).toContain('run it as its own call');
    expect(ran).toEqual([]);
  });

  it('refuses a nested batch', async () => {
    expect((await run({ steps: [{ tool: 'modoki_batch', args: {} }] }) as BatchRejection).rejected)
      .toContain('not allowed in a batch');
  });

  it('caps the step count and an over-long wait', async () => {
    const many = Array.from({ length: MAX_STEPS + 1 }, () => ({ tool: 'modoki_save_all' }));
    expect((await run({ steps: many }) as BatchRejection).rejected).toContain(`cap of ${MAX_STEPS}`);
    expect((await run({ steps: [{ tool: 'wait', args: { ms: MAX_WAIT_MS + 1 } }] }) as BatchRejection).rejected)
      .toContain(`cap of ${MAX_WAIT_MS}`);
  });
});

describe('the `modoki_` prefix is optional on a step\'s tool name (#295)', () => {
  // WHY this matters more than an ordinary ergonomic nicety: pre-flight validates EVERY step
  // before `runBatch` executes ANY, so one unresolvable name does not fail its own step — it
  // voids the whole batch, discarding the valid steps ahead of it too. `scroll` for
  // `modoki_scroll` is the natural slip, because prose everywhere names these tools bare.

  it('runs a bare name, and reports the RESOLVED name', async () => {
    const r = await run({ steps: [{ tool: 'set_transform', args: { entity: { guid: 'g1' } } }, { tool: 'save_all' }] });
    // The load-bearing assertion is that the handlers actually RAN — a rejection would also
    // leave `ok` unread, and an outcome that merely resolved the name would leave `ran` empty.
    expect(ran).toEqual(['set_transform(g1)', 'save_all']);
    expect((r as BatchOutcome).ok).toBe(true);
    expect((r as BatchOutcome).steps.map((st) => st.tool)).toEqual(['modoki_set_transform', 'modoki_save_all']);
  });

  it('validates a bare-named step against that tool\'s REAL schema', async () => {
    // The shorthand must not buy its way past the strict re-parse — that re-parse is the whole
    // reason the registry exists.
    const r = await run({ steps: [{ tool: 'set_selection', args: { name: 'Capsule' } }] });
    expect(isRejection(r)).toBe(true);
    expect((r as BatchRejection).rejected).toMatch(/invalid args/);
    expect(ran).toEqual([]);
  });

  it('still refuses raw {x,y} when the tool is named bare', async () => {
    const r = await run({ steps: [{ tool: 'tap', args: { x: 10, y: 20 } }] });
    expect(isRejection(r)).toBe(true);
    expect((r as BatchRejection).rejected).toMatch(/raw x\/y aiming is not allowed/);
    expect(ran).toEqual([]);
  });

  it('reports a DENIED tool named bare as a DENIAL, not as an unknown name', async () => {
    // "unknown tool" would send the caller off to fix a name that is spelled fine.
    //
    // The two cases reach the denial by DIFFERENT branches, which is the point of testing both:
    // `modoki_build` IS in the fake registry, so `getTool(prefixed)` short-circuits first;
    // `modoki_batch` is NOT registered here, so only the `DENIED.has(prefixed)` fallback can
    // resolve it. Without that fallback the second case would read "unknown tool".
    for (const name of ['build', 'batch']) {
      ran = [];
      const r = await run({ steps: [{ tool: name }] });
      expect(isRejection(r), name).toBe(true);
      expect((r as BatchRejection).rejected, name).toMatch(/not allowed in a batch/);
      expect(ran, name).toEqual([]);
    }
  });

  it('lets an EXACT match win, so a game tool is never re-read as a modoki_ one', async () => {
    // The dynamic tail registers `<gameId>_<verb>` (#270). If the prefixed form were tried first,
    // a game tool that happened to shadow one would silently run the wrong handler.
    const base = fakeRegistry();
    getTool = (name: string) => (name === 'court_load_level'
      ? { name, description: '', shape: {}, handler: async () => { ran.push('court'); return okResult(); } }
      : name === 'modoki_court_load_level'
        ? { name, description: '', shape: {}, handler: async () => { ran.push('WRONG'); return okResult(); } }
        : base(name));
    const r = await run({ steps: [{ tool: 'court_load_level' }] });
    expect((r as BatchOutcome).ok).toBe(true);
    expect(ran).toEqual(['court']);
  });

  it('accepts `modoki_wait` as the wait pseudo-step — the mirror-image slip', async () => {
    const r = await run({ steps: [{ tool: 'modoki_wait', args: { ms: 5 } }, { tool: 'save_all' }] });
    expect((r as BatchOutcome).ok).toBe(true);
    expect((r as BatchOutcome).steps[0].tool).toBe('wait');
    expect(ran).toEqual(['save_all']);
  });

  it('resolves ONCE — a registry that mutates DURING the run cannot swap in another handler', async () => {
    // The registry is not static: `gameTools.ts` polls and re-registers as the human opens and
    // closes a project, and a batch can sit in a `wait` or a slow handler meanwhile. The mutation
    // therefore has to land BETWEEN pre-flight and the step — which is why step 0's handler is
    // what arms it. If the executor re-resolved, step 1's bare `save_all` would resolve to
    // `modoki_save_all` at pre-flight (validated against ITS schema) and then hit the exact-match
    // branch on the second pass, running a tool whose schema never saw these args.
    const base = fakeRegistry();
    let impostor: RegisteredTool | undefined;
    const arm: RegisteredTool = {
      name: 'modoki_arm', description: '', shape: {},
      handler: async () => {
        ran.push('arm');
        impostor = { name: 'save_all', description: '', shape: {}, handler: async () => { ran.push('IMPOSTOR'); return okResult(); } };
        return okResult();
      },
    };
    getTool = (name: string) => (name === 'modoki_arm' ? arm : name === 'save_all' ? impostor : base(name));

    const r = await run({ steps: [{ tool: 'arm' }, { tool: 'save_all' }] });
    expect((r as BatchOutcome).ok).toBe(true);
    // The distinguishing assertion: the real tool ran, not the one that appeared mid-batch.
    expect(ran).toEqual(['arm', 'save_all']);
    expect((r as BatchOutcome).steps[1].tool).toBe('modoki_save_all');
  });

  it('lets a REGISTERED modoki_wait beat the pseudo-step alias', async () => {
    // The alias must not outrank an exact registration, or a step naming a real tool would
    // silently become a sleep. No such tool exists today, which is exactly why the ORDER of the
    // checks needs pinning rather than trusting.
    const base = fakeRegistry();
    getTool = (name: string) => (name === 'modoki_wait'
      ? { name, description: '', shape: {}, handler: async () => { ran.push('real_wait_tool'); return okResult(); } }
      : base(name));
    const r = await run({ steps: [{ tool: 'modoki_wait', args: {} }] });
    expect((r as BatchOutcome).ok).toBe(true);
    expect(ran).toEqual(['real_wait_tool']);
    expect((r as BatchOutcome).steps[0].tool).toBe('modoki_wait');
  });

  it('reports notRun with RESOLVED names too, so one batch is not described in two vocabularies', async () => {
    const r = await run({ steps: [
      { tool: 'save_all' },
      { tool: 'boom' },
      { tool: 'set_transform', args: { entity: { guid: 'g1' } } },
    ] }) as BatchOutcome;
    expect(r.ok).toBe(false);
    expect(r.steps.map((st) => st.tool)).toEqual(['modoki_save_all', 'modoki_boom']);
    // The skipped tail is the list a caller re-sends from — it must speak the same names.
    expect(r.notRun).toEqual([{ i: 2, tool: 'modoki_set_transform' }]);
  });

  it('still voids the batch on a genuinely unknown name, and says the prefix is not the problem', async () => {
    const r = await run({ steps: [{ tool: 'save_all' }, { tool: 'nope' }] });
    expect(isRejection(r)).toBe(true);
    expect((r as BatchRejection).rejected).toMatch(/unknown tool/);
    expect((r as BatchRejection).rejected).toMatch(/prefix is optional/);
    expect(ran).toEqual([]);
  });
});

describe('raw {x,y} aiming is refused inside a batch', () => {
  it('refuses coordinate-aimed input and explains the alternatives', async () => {
    const r = await run({ steps: [{ tool: 'modoki_tap', args: { x: 10, y: 20 } }] });
    expect((r as BatchRejection).rejected).toMatch(/raw x\/y aiming is not allowed/);
    expect((r as BatchRejection).rejected).toContain('entity');
    expect(ran).toEqual([]);
  });

  it('allows entity- and selector-aimed input', async () => {
    const r = await run({ steps: [
      { tool: 'modoki_tap', args: { entity: { guid: 'g-1' } } },
      { tool: 'modoki_tap', args: { selector: '#go' } },
    ] });
    expect(isRejection(r)).toBe(false);
    expect(ran).toEqual(['tap', 'tap']);
  });

  it('does NOT trip on coordinates sitting beside a winning aim', async () => {
    // `resolvePoint` gives entity/selector precedence, so stray x/y here is inert. Refusing it
    // would reject a call that is already aimed correctly.
    const r = await run({ steps: [{ tool: 'modoki_tap', args: { entity: { guid: 'g-1' }, x: 1, y: 2 } }] });
    expect(isRejection(r)).toBe(false);
  });

  it('covers modoki_dnd, whose endpoints also take viewport px (S3.4)', async () => {
    // The docs promised "raw {x,y} aiming is refused" unqualified while the guard listed five
    // tools; dnd was not one of them, so the stale-coordinate case the refusal exists for ran
    // happily inside a batch.
    const bad = await run({ steps: [{ tool: 'modoki_dnd', args: { from: { selector: '#row' }, to: { x: 10, y: 20 } } }] });
    expect((bad as BatchRejection).rejected).toContain('to.x/y');
    expect(ran).toEqual([]);
    const good = await run({ steps: [{ tool: 'modoki_dnd', args: { from: { selector: '#row' }, to: { selector: '#folder' } } }] });
    expect(isRejection(good)).toBe(false);
  });

  it('covers modoki_drag_handle\'s `to`, but not its handle-id source or toId/delta (S3.4)', async () => {
    const bad = await run({ steps: [{ tool: 'modoki_drag_handle', args: { id: 'bone.0', to: { x: 5, y: 6 } } }] });
    expect((bad as BatchRejection).rejected).toContain('to.x/y');
    for (const args of [{ id: 'bone.0', toId: 'bone.1' }, { id: 'bone.0', delta: { dx: 4, dy: 0 } }]) {
      expect(isRejection(await run({ steps: [{ tool: 'modoki_drag_handle', args }] })), JSON.stringify(args)).toBe(false);
    }
  });

  it('DENIES modoki_capture_gesture outright — it has no non-coordinate aim to offer (S3.4)', async () => {
    const r = await run({ steps: [{ tool: 'modoki_capture_gesture', args: { from: { x: 1, y: 2 }, to: { x: 3, y: 4 } } }] });
    expect(isRejection(r)).toBe(true);
    expect((r as BatchRejection).rejected).toMatch(/capture_gesture/);
    expect(ran).toEqual([]);
  });

  it('checks BOTH drag endpoints', async () => {
    const bad = await run({ steps: [{ tool: 'modoki_drag', args: { from: { selector: '#a' }, to: { x: 5, y: 6 } } }] });
    expect((bad as BatchRejection).rejected).toContain('to.x/y');
    const good = await run({ steps: [{ tool: 'modoki_drag', args: { from: { selector: '#a' }, to: { entity: { name: 'Slot' } } } }] });
    expect(isRejection(good)).toBe(false);
  });
});

describe('execution', () => {
  it('runs steps in ARRAY ORDER — the whole reason the tool exists', async () => {
    await run({ steps: [
      { tool: 'modoki_set_transform', args: { entity: { guid: 'a' } } },
      { tool: 'modoki_set_transform', args: { entity: { guid: 'b' } } },
      { tool: 'modoki_save_all' },
    ] });
    expect(ran).toEqual(['set_transform(a)', 'set_transform(b)', 'save_all']);
  });

  it('waits without consulting the registry', async () => {
    const sleep = vi.fn(async () => {});
    const r = await run({ steps: [{ tool: 'wait', args: { ms: 100 } }, { tool: 'modoki_save_all' }] }, { sleep });
    expect(sleep).toHaveBeenCalledWith(100);
    expect((r as BatchOutcome).steps[0]).toMatchObject({ tool: 'wait', ok: true });
  });

  it('stops at the first failure and reports what did NOT run', async () => {
    const r = await run({ steps: [
      { tool: 'modoki_save_all' }, { tool: 'modoki_boom' }, { tool: 'modoki_set_transform', args: { entity: { guid: 'x' } } },
    ] }) as BatchOutcome;
    expect(ran).toEqual(['save_all', 'boom']);
    expect(r).toMatchObject({ ok: false, ran: 2, failedAt: 1 });
    expect(r.notRun).toEqual([{ i: 2, tool: 'modoki_set_transform' }]);
  });

  it('stopOnError:false runs on and reports the SET of failures, not a `failedAt`', async () => {
    // `failedAt` MEANS "the run stopped here", and in this mode it did not. Reporting `failedAt:0`
    // — alongside a hint reading "steps after failedAt did NOT run" — described a batch that had
    // in fact run every step, so a caller acting on it re-sends work that already applied.
    const r = await run({ steps: [{ tool: 'modoki_boom' }, { tool: 'modoki_save_all' }], stopOnError: false }) as BatchOutcome;
    expect(ran).toEqual(['boom', 'save_all']);
    expect(r).toMatchObject({ ok: false, ran: 2, failed: [0] });
    expect(r.failedAt).toBeUndefined();
    expect(r.notRun).toBeUndefined();
  });

  it('stopOnError:false reports EVERY failure, not just the first', async () => {
    const r = await run({ steps: [{ tool: 'modoki_boom' }, { tool: 'modoki_save_all' }, { tool: 'modoki_boom' }], stopOnError: false }) as BatchOutcome;
    expect(r.failed).toEqual([0, 2]);
    expect(r.ran).toBe(3);
  });

  it('fail-fast still reports `failedAt` — that mode really did stop there', async () => {
    const r = await run({ steps: [{ tool: 'modoki_boom' }, { tool: 'modoki_save_all' }] }) as BatchOutcome;
    expect(r).toMatchObject({ ok: false, ran: 1, failedAt: 0, failed: [0] });
    expect(r.notRun).toHaveLength(1);
  });

  it('a step wrapper key that is not tool/args/result is REFUSED — nothing runs', async () => {
    // `{tool, arg:{…}}` (singular) had `arg` stripped by the outer schema and the step then ran
    // with NO arguments — measured live: get_scene_state returned the whole 136-entity index
    // instead of one entity, ok:true. Losing `args` silently turns a step into a different, much
    // broader operation.
    const r = await run({ steps: [{ tool: 'modoki_save_all', arg: { x: 1 } } as never] });
    expect(r).toHaveProperty('rejected');
    expect((r as { rejected: string }).rejected).toMatch(/unknown step key\(s\) `arg`/);
    expect((r as { rejected: string }).rejected).toMatch(/PLURAL/);
    expect(ran).toEqual([]);   // pre-flight: nothing ran
  });

  it('turns a THROWING handler into a failed step, not a failed batch', async () => {
    // A throw must not lose the applied prefix — that is what the caller needs to clean up.
    const r = await run({ steps: [{ tool: 'modoki_save_all' }, { tool: 'modoki_throws' }] }) as BatchOutcome;
    expect(r).toMatchObject({ ok: false, failedAt: 1 });
    expect(r.steps[0]).toMatchObject({ ok: true, tool: 'modoki_save_all' });
    expect(r.steps[1].text).toContain('socket hung up');
  });

  it('stops on the whole-batch deadline instead of hanging the session', async () => {
    let t = 0;
    const now = () => (t += 60_000); // two steps in, we are past the 90s deadline
    const r = await run({ steps: [{ tool: 'modoki_save_all' }, { tool: 'modoki_save_all' }, { tool: 'modoki_save_all' }] }, { now }) as BatchOutcome;
    expect(r.ok).toBe(false);
    expect(r.stoppedBy).toBe('deadline');
    expect(ran.length).toBeLessThan(3);
  });

  it('does NOT count a deadline-skipped step as having run', async () => {
    // The honesty bug this exists to prevent: pushing a synthetic outcome for the step the
    // deadline cut off would inflate `ran` AND omit that step from `notRun`, so both numbers
    // would lie in the same direction — claiming work happened that provably did not.
    let t = 0;
    const now = () => (t += 60_000);
    const r = await run({ steps: [{ tool: 'modoki_save_all' }, { tool: 'modoki_save_all' }, { tool: 'modoki_save_all' }] }, { now }) as BatchOutcome;
    expect(r.ran).toBe(ran.length);
    expect(r.steps).toHaveLength(ran.length);
    // Everything that did not execute is accounted for, including the step the deadline hit.
    expect(r.ran + (r.notRun?.length ?? 0)).toBe(3);
    // The cut-off index is `stoppedAt`, NOT `failedAt` — nothing failed here, the run ran out of
    // time. They used to share one field, which is how a deadline could overwrite a real failure
    // index and produce a report whose hint said "No step failed" over a steps[] that showed one.
    expect(r.stoppedAt).toBeDefined();
    expect(r.failedAt).toBeUndefined();
    expect(r.notRun!.map((n) => n.i)).toContain(r.stoppedAt);
  });

  it('a deadline that lands AFTER a real failure reports BOTH, and does not claim "no step failed"', async () => {
    let t = 0;
    const now = () => (t += 60_000);
    const r = await run(
      { steps: [{ tool: 'modoki_boom' }, { tool: 'modoki_save_all' }, { tool: 'modoki_save_all' }], stopOnError: false },
      { now },
    ) as BatchOutcome;
    expect(r.failed).toEqual([0]);        // the genuine failure survives…
    expect(r.stoppedAt).toBeDefined();    // …alongside the cut-off
    const body = reportBatch(r, null) as { hint?: string };
    expect(body.hint).toMatch(/FAILED before that/);
    expect(body.hint).not.toMatch(/No step failed/);
  });
});

describe('result modes are recorded, and the LAST step defaults to full', () => {
  it('defaults non-terminal steps to ack and the terminal step to full', async () => {
    const r = await run({ steps: [{ tool: 'modoki_save_all' }, { tool: 'modoki_save_all' }] }) as BatchOutcome;
    expect(r.steps.map((s) => s.mode)).toEqual(['ack', 'full']);
  });

  it('resultDefault applies to non-terminal steps only', async () => {
    const r = await run({ steps: [
      { tool: 'modoki_save_all' }, { tool: 'modoki_save_all' }, { tool: 'modoki_save_all' },
    ], resultDefault: 'none' }) as BatchOutcome;
    expect(r.steps.map((s) => s.mode)).toEqual(['none', 'none', 'full']);
  });

  it('an explicit mode wins everywhere, including on the last step', async () => {
    const r = await run({ steps: [
      { tool: 'modoki_save_all', result: 'full' }, { tool: 'modoki_save_all', result: 'none' },
    ] }) as BatchOutcome;
    expect(r.steps.map((s) => s.mode)).toEqual(['full', 'none']);
  });

  it('BUFFERS every step\'s payload regardless of mode — presentation is decided later', async () => {
    // The structural rule. If step 5 of 10 fails, steps 1-4 already applied and are not rolled
    // back, so the envelope must be ABLE to describe them even though their mode said 'none'.
    // An executor that discarded as it went could not, and would report a scene state that does
    // not exist. Asserting the text survives is how that stays true.
    const r = await run({ steps: [
      { tool: 'modoki_set_transform', args: { entity: { guid: 'a' } }, result: 'none' },
      { tool: 'modoki_boom' },
    ] }) as BatchOutcome;
    expect(r.failedAt).toBe(1);
    expect(r.steps[0]).toMatchObject({ mode: 'none', ok: true });
    expect(r.steps[0].text).toBe('{"changed":1}');
  });
});
