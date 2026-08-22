/** Conformance: every tool matches its declared CONTRACT (`src/contracts.ts`), and the surface
 *  obeys the cross-tool rules.
 *
 *  This is the table-driven half of the MCP audit (`docs/reviews/2026-07-30-mcp-tool-audit.md`;
 *  the rules it enforces are `docs/mcp-tool-conventions.md`).
 *  It exists because per-tool facts were being re-derived by hand in four places — the batch
 *  pre-flight, the docs catalog, the tests, and the GET/POST guard — and drifting in all of them.
 *
 *  The load-bearing idea: a declaration is CHECKED AGAINST OBSERVATION. Each tool is invoked with
 *  its own `minimalArgs` against a stub backend, and the request it actually makes must be the
 *  route it claims. A declaration alone can lie (that is how a tool ends up documented but dead);
 *  an observation alone has nothing to check against.
 */

import fs from 'node:fs';
import path from 'node:path';
import { z } from '../../tools/modoki-mcp/node_modules/zod';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CONTRACTS, contractFor } from '../../tools/modoki-mcp/src/contracts';
import { getTool } from '../../tools/modoki-mcp/src/registry';
import { loadSurface, realRequests, type Surface } from './mcpSurface';

describe('tool contracts', () => {
  let s: Surface;
  beforeEach(() => { s = loadSurface(); });
  afterEach(() => s.restore());

  it('every registered tool has a contract, and every contract has a tool', () => {
    // Both directions. A missing contract means a tool escaped the table (and therefore the docs
    // and the convention guards); a stale contract means a tool was renamed or removed and the
    // table still advertises it.
    const registered = [...s.names].sort();
    const declared = Object.keys(CONTRACTS).sort();
    expect(declared.filter((n) => !registered.includes(n)), 'contracts with no tool').toEqual([]);
    expect(registered.filter((n) => !declared.includes(n)), 'tools with no contract').toEqual([]);
  });

  describe('declared route matches the request the tool actually makes', () => {
    for (const [name, c] of Object.entries(CONTRACTS)) {
      if (c.route === null) {
        it(`${name} makes no backend call of its own`, async () => {
          // `modoki_batch`'s minimalArgs is a `wait` pseudo-step precisely so nothing is
          // delegated: any request here would be the tool's OWN, which it must not make.
          await s.call(name, c.minimalArgs).catch(() => {/* a refusal is fine; we assert on I/O */});
          expect(realRequests(s).map((r) => `${r.method} ${r.path}`)).toEqual([]);
        });
        continue;
      }
      it(`${name} → ${c.method} ${c.route}`, async () => {
        await s.call(name, c.minimalArgs);
        const made = realRequests(s);
        // `route` must be AMONG the requests, not necessarily the only one: a scene-editing tool
        // legitimately probes /api/editor-state first to resolve the active scene.
        const match = made.find((r) => r.path.split('?')[0] === c.route);
        expect(match, `${name} never called ${c.route}; it called: ${made.map((r) => `${r.method} ${r.path}`).join(', ') || '(nothing)'}`).toBeDefined();
        expect(match!.method, `${name} method`).toBe(c.method);
      });
    }
  });

  /** `varies` OBSERVED, not just declared (2026-08-21).
   *
   *  `method`/`route`/`op` were checked against observation from the start; `varies` was not, and
   *  it is the field that DISARMS the mutating-GET guards below (they all filter on `!c.varies`).
   *  So a tool could exempt itself from them by declaring a variance it did not have — and
   *  `modoki_hit_regions` did exactly that, with `varies:'both'` on a route with one arm, for as
   *  long as the field existed. A refused `action:'show'` came back as a SUCCESSFUL tool call.
   *
   *  Nothing could have caught it: `minimalArgs` is one call, and one call cannot show variance.
   *  Seeing it needs EVERY action driven and the method+route recorded for each. That is what this
   *  does, so the class is now un-declarable rather than merely fixed once.
   *
   *  The action list is EXPLICIT rather than read off the zod enum: the enum is the vocabulary,
   *  and some actions need a companion param to be valid at all (`watch action:'start'` needs a
   *  `component`). A synthesized call would refuse before making a request and this would assert
   *  nothing — the vacuous-guard failure mode the audit found four of. Totality is asserted
   *  below, so a new multi-action tool cannot skip the table. */
  const ACTION_PROBES: Record<string, Array<Record<string, unknown>>> = {
    modoki_hit_regions: [{ action: 'read' }, { action: 'show' }, { action: 'hide' }],
    modoki_watch: [
      { action: 'list' }, { action: 'start', component: 'Transform' },
      { action: 'read', id: 'w1' }, { action: 'clear' },
    ],
    modoki_input_watch: [{ action: 'read' }, { action: 'start' }, { action: 'stop' }, { action: 'clear' }],
    modoki_profiler: [{ action: 'read' }, { action: 'boot' }, { action: 'capture-start' }, { action: 'reset' }],
    modoki_project_settings: [{ action: 'get' }, { action: 'set', values: { app: { appName: 'X' } } }],
    // The rest of the multi-action surface, which varies in NEITHER method nor route. Probing them
    // is not busywork: it PINS that, so a future action added on a new route (the natural way
    // `varies` becomes true) fails here instead of quietly making the declaration stale.
    // Bare `{}` IS the read here — `action` is the capture-window control (start|stop only), and
    // both halves need the `type` they gate on.
    modoki_journal: [{}, { action: 'start', type: '@contact' }, { action: 'stop', type: '@contact' }],
    modoki_pointer: [
      { action: 'down', x: 1, y: 2 }, { action: 'move', x: 3, y: 4 }, { action: 'up', x: 3, y: 4 },
    ],
    modoki_play_control: [{ action: 'play' }, { action: 'stop' }, { action: 'pause' }, { action: 'resume' }, { action: 'step' }],
    modoki_history: [{ action: 'undo' }, { action: 'redo' }],
    modoki_prefab: [
      { action: 'instantiate', path: '/assets/prefabs/probe.prefab.json' },
      { action: 'overrides', entityGuid: '00000000-0000-0000-0000-000000000000' },
      { action: 'detach', entityGuid: '00000000-0000-0000-0000-000000000000' },
    ],
    modoki_write_player_prefs: [
      { action: 'flush' }, { action: 'set', key: 'k', value: 1 },
      { action: 'delete', key: 'k' }, { action: 'clear', confirm: true },
    ],
  };

  describe('a declared `varies` matches what the actions actually do', () => {
    for (const [name, probes] of Object.entries(ACTION_PROBES)) {
      it(`${name} varies exactly as declared`, async () => {
        const seen: Array<{ method: string; route: string }> = [];
        for (const args of probes) {
          const before = realRequests(s).length;
          await s.call(name, args).catch(() => {/* a refusal makes no request; the gap shows below */});
          for (const r of realRequests(s).slice(before)) seen.push({ method: r.method, route: r.path.split('?')[0] });
        }
        // Every probe must actually reach the backend, or the observation is vacuous.
        expect(seen.length, `${name}: some action made no request — the probe args are wrong, not the contract`)
          .toBeGreaterThanOrEqual(probes.length);
        const methodVaries = new Set(seen.map((r) => r.method)).size > 1;
        const routeVaries = new Set(seen.map((r) => r.route)).size > 1;
        const observed = methodVaries && routeVaries ? 'both' : methodVaries ? 'method' : routeVaries ? 'route' : undefined;
        expect(CONTRACTS[name].varies, `${name}: observed ${JSON.stringify(seen)}`).toBe(observed);
      });
    }

    it('every multi-action tool is probed — the table cannot silently omit one', () => {
      // Totality, the same rule `liveCoverage.ts` uses: a guard whose input list can quietly miss a
      // tool is a guard that stops covering the surface one addition at a time. "Multi-action" is
      // read off the schema (an `action` enum with more than one value), so a NEW such tool fails
      // here until it is probed, rather than being assumed single-shaped.
      const multiAction = Object.keys(CONTRACTS).filter((name) => {
        const field = (getTool(name)?.shape as Record<string, unknown> | undefined)?.action as
          { _def?: { innerType?: { _def?: { values?: unknown[] } }; values?: unknown[] } } | undefined;
        const values = field?._def?.values ?? field?._def?.innerType?._def?.values;
        return Array.isArray(values) && values.length > 1;
      });
      expect(multiAction.filter((n) => !(n in ACTION_PROBES)), 'multi-action tools with no probe').toEqual([]);
      expect(Object.keys(ACTION_PROBES).filter((n) => !multiAction.includes(n)), 'probes for tools that are no longer multi-action').toEqual([]);
    });

    it('…and THAT check can fail (mutation-tested against the pre-fix declaration)', () => {
      // `modoki_hit_regions` declared 'both' and observed neither. Feed the classifier the shape it
      // actually had, so this guard is known to fail rather than merely known to pass.
      const preFix = [
        { method: 'GET', route: '/api/hit-regions' },
        { method: 'GET', route: '/api/hit-regions' },
        { method: 'GET', route: '/api/hit-regions' },
      ];
      const mv = new Set(preFix.map((r) => r.method)).size > 1;
      const rv = new Set(preFix.map((r) => r.route)).size > 1;
      expect(mv && rv ? 'both' : mv ? 'method' : rv ? 'route' : undefined).toBeUndefined();
    });
  });

  describe('`minimalArgsMutates` is OBSERVED, not trusted', () => {
    /** The sibling of the `varies` defect, found by sweeping for the PATTERN rather than the
     *  symptom: a contract field that is declared, never verified, and then trusted by a safety
     *  mechanism.
     *
     *  This one is trusted by the most consequential mechanism on the surface.
     *  `test-live-tools.ts:79` picks what to fire at the HUMAN'S OPEN EDITOR with
     *  `!(minimalArgsMutates ?? mutating)` — so a tool that under-declares gets its smallest call
     *  run for real against the human's project. The only existing check
     *  (`liveCoverage.test.ts`) asserts the DECLARATION equals false, which is circular: it
     *  confirms the tool says "safe", not that it is.
     *
     *  Failure it prevents: a tool whose default action later changes from a read to a write keeps
     *  `minimalArgsMutates: false`, and the next live sweep silently mutates the human's project.
     *
     *  GET is the right proxy HERE specifically. It is not true surface-wide — `capture_viewport`
     *  and `render_scene` are POST reads — but every tool that DECLARES this field is a
     *  method-splitting tool whose read half is the GET half, which is the whole reason the field
     *  exists. A POST from a call declared non-mutating is "do this" by §4, and wants a look. */
    const declarers = Object.entries(CONTRACTS).filter(([, c]) => c.minimalArgsMutates === false);

    it('the field is actually in use — this guard is not vacuous', () => {
      expect(declarers.length, 'nothing declares minimalArgsMutates; the field or its consumers moved').toBeGreaterThan(0);
    });

    for (const [name] of declarers) {
      it(`${name}'s smallest call really is a read (GET)`, async () => {
        await s.call(name, CONTRACTS[name].minimalArgs);
        const made = realRequests(s);
        expect(made.length, `${name} made no request, so nothing was observed`).toBeGreaterThan(0);
        const methods = [...new Set(made.map((r) => r.method))];
        expect(
          methods,
          `${name} declares minimalArgsMutates:false — the live sweep fires this at the human's `
          + `open editor on that basis — but its smallest call issued ${methods.join('/')}.`,
        ).toEqual(['GET']);
      });
    }
  });

  describe('the editor-action relay', () => {
    for (const [name, c] of Object.entries(CONTRACTS)) {
      if (c.route !== '/api/editor-action' || !c.op || c.opVaries) continue;
      it(`${name} sends op '${c.op}' as the routing key`, async () => {
        await s.call(name, c.minimalArgs);
        const relay = realRequests(s).find((r) => r.path === '/api/editor-action');
        const body = relay?.body as { action?: string } | undefined;
        // `modoki_prefab` 400'd on EVERY call for months because its own `action` param replaced
        // the op name here. This asserts the op that actually goes on the wire.
        expect(body?.action, `${name} routing key`).toBe(c.op);
      });
    }
  });

  /** IMPURE READS — tools whose primary job is answering a question, but which carry an optional
   *  DESTRUCTIVE mode: `modoki_journal` (action:'start'/'stop' + clear:true empties a 10,000-event
   *  ring), `modoki_editor_journal` (clear:true empties the activity buffer). Both reach it by GET.
   *
   *  `read` is the promise Percept makes, and `modoki_get_console_logs` keeps it for the same job —
   *  so this is a real inconsistency, not a necessity. Phase 3 decides whether a read may destroy
   *  (probably: split the clear into its own call); the list may only SHRINK. */
  const IMPURE_READS = ['modoki_journal', 'modoki_editor_journal'];

  it('a `read` tool never mutates', () => {
    // A read that mutates is the worst thing on an agent surface — it makes VERIFICATION itself
    // destructive, and verification is the one thing an agent must be able to do freely.
    const offenders = Object.entries(CONTRACTS)
      .filter(([, c]) => c.kind === 'read' && c.mutating)
      .map(([n]) => n);
    expect(offenders.filter((n) => !IMPURE_READS.includes(n)), 'new impure read').toEqual([]);
    expect(IMPURE_READS.filter((n) => !offenders.includes(n)), 'fixed — delete from IMPURE_READS').toEqual([]);
  });

  it('a tool that DISPATCHES INPUT is never declared a non-mutating read', () => {
    // modoki_capture_gesture was `kind:'read', mutating:false` while POSTing a real trusted drag
    // against a running game — so the "a read never mutates" guard above passed VACUOUSLY for the
    // one tool that could have violated it. A guard whose only possible offender is mis-declared
    // out of its own scope is not a guard.
    const gesture = CONTRACTS.modoki_capture_gesture;
    expect(gesture.kind, 'capture_gesture dispatches a real drag').toBe('input');
    expect(gesture.mutating).toBe(true);
    // …and the rule generally: nothing that DISPATCHES input may claim to be a read.
    //
    // The route list is narrow on purpose. A first cut matched /enact/ and flagged
    // `modoki_handles` — which POSTs to `/api/enact-handles` but only READS handle geometry
    // (it computes where the draggable handles are so `tap_handle` can aim). That is a legitimate
    // read, so the guard was wrong, not the contract. Match dispatch routes, not the `enact`
    // family by name.
    const inputRoutes = /\/api\/(input\/|capture-gesture)/;
    const liars = Object.entries(CONTRACTS)
      .filter(([, c]) => c.kind === 'read' && !c.mutating && inputRoutes.test(c.route ?? ''))
      .map(([n]) => n);
    expect(liars, 'declared a non-mutating read while posting to an input route').toEqual([]);
  });

  it('a mutating tool that reaches disk says so, and a live-only one is undoable or explains why', () => {
    for (const [name, c] of Object.entries(CONTRACTS)) {
      if (!c.mutating) expect(c.persists, `${name} does not mutate, so it cannot persist`).toBe('none');
      // `session` counts: selection/gizmo/view-mode are undoable without being scene data.
      if (c.undoable) expect(['live', 'both', 'session'], `${name} is undoable, so it must have an undoable effect`).toContain(c.persists);
    }
  });

  it('no tool DESCRIPTION contradicts its declared undoability', () => {
    // S3.2/S3.16: `modoki_set_selection` was declared `undoable:true` while its own description
    // said "Does NOT push an undo entry" — so an agent could not predict whether `modoki_history
    // undo` would unwind its selection or the edit before it. Whichever side is wrong, the two
    // must not be allowed to say opposite things: the table is what the docs catalog and the batch
    // pre-flight read, and the description is what the model reads.
    const denies = /\b(no undo entry|not push an undo|does not push an undo|not undoable)\b/i;
    const offenders: string[] = [];
    for (const [name, c] of Object.entries(CONTRACTS)) {
      const d = getTool(name)?.description ?? '';
      if (c.undoable && denies.test(d)) offenders.push(`${name}: undoable:true but description denies it`);
    }
    expect(offenders, 'contract vs description disagree about undo').toEqual([]);
  });

  it('…and THAT check can fail (mutation-tested against a synthetic contradiction)', () => {
    // A guard never seen to fail is not known to work — four of the review's findings were
    // vacuous tests. Feed it the exact pre-fix pair.
    const denies = /\b(no undo entry|not push an undo|does not push an undo|not undoable)\b/i;
    expect(denies.test('Set the editor selection. Does NOT push an undo entry. Returns state.')).toBe(true);
    expect(denies.test('Create an entity. Pushes ONE undo entry.')).toBe(false);
  });

  /** `undoable` OBSERVED against the op that implements it (2026-08-21).
   *
   *  The description check above is ONE-DIRECTIONAL — it fails on `undoable:true` + a description
   *  that DENIES undo. The opposite pairing is the one that actually happened, and it is invisible
   *  to that check twice over: `modoki_particle_set` and its four asset-authoring siblings declared
   *  `undoable:false` (by omission) while their ops called `pushAssetUndo`, and their descriptions
   *  said NOTHING about undo — so there was no sentence to contradict.
   *
   *  Nothing agent-facing was merely cosmetic about it. The generated catalog is rendered FROM this
   *  table, so it stated the opposite of the truth for five tools in the doc that "cannot drift" —
   *  the drift was upstream of the generator. And an agent that had just made a bad write could not
   *  see that `modoki_history` was the way back.
   *
   *  So this reads the OP source, the same trick `mcpRegistry.test.ts` uses for its registration
   *  guards. Direction matters: an op that pushes undo MUST be declared undoable. Not the converse
   *  — a tool can be undoable through a mechanism that is not a literal `pushAssetUndo` call here
   *  (the entity ops go through the editor store), and asserting that way round would produce false
   *  failures instead of catching real ones. */
  it('an agent op that pushes an undo entry is DECLARED undoable', () => {
    const opsSrc = fs.readFileSync(
      path.join(__dirname, '../../app/editor/agentEditorOps.ts'), 'utf-8',
    );
    // Split on the op registrations: each chunk runs from one op's name to the next registration,
    // so it IS that op's body. `.slice(1)` drops the preamble, which is where `pushAssetUndo` is
    // DEFINED — counting its own definition would mark the first op as pushing.
    const chunks = opsSrc.split(/registerAgentOp\(\s*'/).slice(1);
    const pushesUndo = new Set<string>();
    for (const chunk of chunks) {
      const op = chunk.slice(0, chunk.indexOf("'"));
      if (/push(Asset)?Undo\(/.test(chunk)) pushesUndo.add(op);
    }
    // Pin the SET, not just its size. A `> 0` floor survives a source reshape that quietly drops
    // four of the five — which would leave this green while covering almost nothing.
    expect([...pushesUndo].sort(), 'the undo-pushing ops changed — extend the contracts, do not relax this')
      .toEqual(['anim-add-key', 'anim-set-clip', 'particle-set', 'timeline-add-clip', 'timeline-set']);

    const offenders: string[] = [];
    for (const [name, c] of Object.entries(CONTRACTS)) {
      if (c.op && pushesUndo.has(c.op) && !c.undoable) {
        offenders.push(`${name} (op '${c.op}') pushes an undo entry but declares undoable:false`);
      }
    }
    expect(offenders, 'contract vs the op it routes to disagree about undo').toEqual([]);
  });

  it('…and THAT check can fail (mutation-tested against the pre-fix declaration)', () => {
    // The five were `undoable:false` with ops in the pushing set. Re-run the comparison with the
    // declaration they actually had, so this guard is known to fail rather than known to pass.
    const pushesUndo = new Set(['particle-set', 'anim-set-clip', 'anim-add-key', 'timeline-set', 'timeline-add-clip']);
    const preFix = [{ name: 'modoki_particle_set', op: 'particle-set', undoable: false }];
    expect(preFix.filter((c) => pushesUndo.has(c.op) && !c.undoable).map((c) => c.name))
      .toEqual(['modoki_particle_set']);
  });

  /** F3 — MUTATING operations reachable by GET. `getJson` deliberately does not run
   *  `isFailureBody` (a GET's `ok` may be the ANSWER — `diagnose`/`validate_scene` return
   *  `ok:false` to mean "unhealthy"), so a mutating GET's failure is structurally unchecked.
   *
   *  PHASE 6 RESOLUTION (2026-07-30): the split is now deliberate, and the two halves are policed
   *  differently rather than merged.
   *   - The BUILD FAMILY (`build`, `add_native_target`, `ota_publish`) stays GET because it is an SSE
   *     stream — the live-log ergonomics (EventSource, `curl -N`) are GET-only. F3's concern does not
   *     apply to them: they never touch `getJson`. `consumeBuildStream` fails on a non-2xx open, an
   *     `event:status FAILED`, a mid-run break, and a close with NO final status (outcome unknown is
   *     a failure, not a success).
   *   - `journal` / `editor_journal` keep their mutating GET (the `curl` ergonomics are the point)
   *     but now pass `checkFailure` at the call site, so a `200 {ok:false}` refusal IS a failed tool
   *     call. Asserted behaviourally below, not just declared.
   *  The list may only SHRINK. */
  const MUTATING_GETS = [
    'modoki_build', 'modoki_add_native_target', 'modoki_ota_publish',
    // Found while writing this table, and NOT in the original route inventory — these mutate
    // through QUERY PARAMS on a GET (`?clear=1`, `?action=start`), so a scan of route methods
    // alone missed them.
    'modoki_journal', 'modoki_editor_journal',
    // Added 2026-08-21. It was ALWAYS a mutating GET — `action:'show'|'hide'` flips the overlay
    // and `/api/hit-regions` has one arm, `method === 'GET'` — but it declared `varies:'both'`,
    // and the filter below excludes `varies` tools, so it was in none of the three guards here
    // and its refusals reached the agent as successes. The declaration was the bug; see the
    // `observes` block above, which now makes that class un-declarable.
    'modoki_hit_regions',
  ];

  it('no NEW mutating operation hides behind GET', () => {
    const offenders = Object.entries(CONTRACTS)
      // `varies` tools are excluded because their MUTATING variant is a POST — `modoki_watch`
      // start/clear and `modoki_project_settings` action:'set' all POST; the declared GET is the
      // read variant. Their risk is the naming (one tool, two methods), logged separately, not an
      // unchecked mutating GET.
      .filter(([, c]) => c.mutating && c.method === 'GET' && !c.varies)
      .map(([n]) => n);
    expect(offenders.filter((n) => !MUTATING_GETS.includes(n)), 'new mutating GET').toEqual([]);
    expect(MUTATING_GETS.filter((n) => !offenders.includes(n)),
      'fixed — delete from MUTATING_GETS').toEqual([]);
  });

  /** The args that make each non-build MUTATING GET actually mutate. Explicit because "which
   *  argument turns this read into a write" is exactly the fact that must not be inferred. */
  const MUTATING_GET_ARGS: Record<string, Record<string, unknown>> = {
    modoki_journal: { action: 'start', type: '@contact' },
    modoki_editor_journal: { clear: true },
    modoki_hit_regions: { action: 'show' },
  };

  it('every mutating GET (outside the build family) has a mutating-args fixture', () => {
    // Keeps the behavioural check below honest: a new mutating GET must be listed here, or this
    // fails rather than the tool silently escaping the assertion that follows.
    const expected = Object.entries(CONTRACTS)
      .filter(([, c]) => c.mutating && c.method === 'GET' && !c.varies && c.kind !== 'build')
      .map(([n]) => n).sort();
    expect(Object.keys(MUTATING_GET_ARGS).sort()).toEqual(expected);
  });

  it('…and the READ half of a split tool keeps C7 — `ok:false` stays an ANSWER', async () => {
    // The other direction of the `modoki_hit_regions` fix, and the one a careless version would
    // break: the check is armed per ACTION (`action !== 'read'`), not for the whole tool. Arming it
    // wholesale would make every plain read of a route that answers `ok:false` a failed call —
    // exactly what §4 says not to "fix". Without this, that regression passes silently, because the
    // mutating assertion above would still be green.
    const s2 = loadSurface(() => ({ body: { ok: false, regions: [], providers: [] } }));
    try {
      const r = await s2.call('modoki_hit_regions', { action: 'read' });
      expect(r.isError, 'a plain read must not turn ok:false into a failed call').toBeFalsy();
    } finally { s2.restore(); }
  });

  it('a mutating GET treats a 200 `ok:false` as a FAILURE (Phase 6)', async () => {
    // `getJson` deliberately does not check `isFailureBody` — for `diagnose`/`validate_scene`,
    // `ok:false` is the ANSWER. But for a GET that MUTATES, `ok` is a success flag, and without the
    // check a route's refusal reached the agent as a successful call. Measured live: `modoki_journal
    // {action:'start'}` with no `type` answers `200 {ok:false, reason:…}`.
    for (const [name, args] of Object.entries(MUTATING_GET_ARGS)) {
      const s2 = loadSurface(() => ({ body: { ok: false, error: 'the op refused' } }));
      try {
        const r = await s2.call(name, args);
        expect(r.isError, `${name} reported a route refusal as success`).toBe(true);
      } finally { s2.restore(); }
    }
  });

  it('a read tool with a filterable payload declares its filters', () => {
    // `docs/mcp-response-budget.md`: summary-first, and the over-cap hint tells the caller which
    // filter to reach for. A filter the table does not know about cannot be named in that hint.
    const bigReads = ['modoki_get_scene_state', 'modoki_get_layout_bounds', 'modoki_journal',
      'modoki_editor_journal', 'modoki_list_assets', 'modoki_list_traits', 'modoki_get_console_logs'];
    for (const name of bigReads) {
      expect(contractFor(name)!.filters.length, `${name} must declare its narrowing params`).toBeGreaterThan(0);
    }
  });

  it('every declared filter is a real parameter of that tool', () => {
    // A filter named in the table but absent from the schema would be advertised in a hint and
    // then rejected as an unknown key — a dead end that reads as the agent's mistake.
    for (const [name, c] of Object.entries(CONTRACTS)) {
      const shape = getTool(name)!.shape;
      for (const f of c.filters) {
        expect(Object.keys(shape), `${name} declares filter '${f}' which is not a parameter`).toContain(f);
      }
    }
  });

  /** REGRESSION (independent review, 2026-07-30). "Is a real parameter" is too weak a check, and
   *  six tools shipped a wrong `filters` because of it. `filters` is what `retargetNarrowHint`
   *  rewrites an over-cap hint from, so a wrong entry sends the agent to a param that does not
   *  narrow — or that its own handler refuses. Two failure shapes, both found in the surface:
   *
   *   - **Grows, not narrows.** `get_scene_state` declared `full`/`world`/`bounds`/`contacts`/
   *     `resources`; `get_layout_bounds` declared `entities` and `overlaps` (the description of
   *     `overlaps` literally says O(n² ) and it dominated the response); `list_traits`/
   *     `list_assets` declared `all` ("Large — prefer name="); `editor_journal` declared `merged`
   *     ("ALSO include…"). Every one of them makes the payload BIGGER. In this surface a
   *     narrowing param always carries a value (an id, a name, a cap) and an expanding one is a
   *     boolean flag, so a boolean filter is the reliable tell.
   *   - **Refused by the handler.** `modoki_watch` declared three START-time params, but the only
   *     action that can over-cap is `read`, which refuses them as start-only.
   */
  it('no declared filter is a payload-EXPANDING boolean flag', () => {
    const offenders: string[] = [];
    for (const [name, c] of Object.entries(CONTRACTS)) {
      const shape = getTool(name)!.shape as Record<string, { _def?: { typeName?: string } }>;
      for (const f of c.filters) {
        // A boolean that NARROWS, declared as such in the contract. The heuristic below is a
        // heuristic — `modoki_input_watch.unresolvedOnly` is the first param in the surface to
        // break it — so the exception is declared and reviewable rather than hidden by dropping a
        // real filter from the contract to keep this green. See `narrowingFlags` in contracts.ts.
        if (c.narrowingFlags?.includes(f)) continue;
        const def = shape[f];
        if (!def) continue; // covered by the test above
        // Unwrap ZodOptional/ZodDefault to reach the inner type name.
        let inner: unknown = def;
        for (let i = 0; i < 4; i++) {
          const d = (inner as { _def?: { typeName?: string; innerType?: unknown } })._def;
          if (d?.innerType) { inner = d.innerType; continue; }
          break;
        }
        const typeName = (inner as { _def?: { typeName?: string } })._def?.typeName;
        if (typeName === 'ZodBoolean') offenders.push(`${name}.${f}`);
      }
    }
    expect(
      offenders,
      'these are declared as narrowing filters but are boolean flags that ADD to the response — ' +
      'the over-cap hint would tell the agent to make an oversized payload larger',
    ).toEqual([]);
  });

  it('every declared filter is ACCEPTED by the tool on its minimalArgs call (not refused)', async () => {
    // The `modoki_watch` case: a filter that exists in the flat schema but belongs to a different
    // action, so the handler answers UNKNOWN_PARAM. `f in shape` cannot see that — only calling can.
    const SAMPLE: Record<string, unknown> = {
      // Typed sample values per param name, so the call validates. Anything unlisted falls back
      // to a string, which is right for the majority (name/type/folder/editor/kind/source/…).
      limit: 1, ids: [1], guids: ['00000000-0000-0000-0000-000000000000'], id: 1,
      since: 1, precision: 6, maxSeries: 1, fields: ['x'], names: ['a'],
    };
    const offenders: string[] = [];
    for (const [name, c] of Object.entries(CONTRACTS)) {
      if (!c.filters.length) continue;
      for (const f of c.filters) {
        const s2 = loadSurface();
        try {
          const shape = getTool(name)!.shape as Record<string, unknown>;
          if (!(f in shape)) continue;
          const sample = SAMPLE[f] ?? 'x';
          let r;
          try {
            r = await s2.call(name, { ...(c.filterArgs ?? c.minimalArgs), [f]: sample });
          } catch {
            // The sample did not validate — try the other obvious primitive before giving up.
            try { r = await s2.call(name, { ...(c.filterArgs ?? c.minimalArgs), [f]: typeof sample === 'string' ? 1 : 'x' }); }
            catch { continue; } // cannot construct a valid call for this param; the schema test covers existence
          }
          if (!r.isError) continue;
          const code = (() => {
            try { return (JSON.parse(s2.text(r)) as { error?: { code?: string } }).error?.code; } catch { return undefined; }
          })();
          if (code === 'UNKNOWN_PARAM') offenders.push(`${name}.${f}`);
        } finally { s2.restore(); }
      }
    }
    expect(
      offenders,
      'these filters are advertised in the over-cap hint but the tool REFUSES them as unknown for ' +
      'the action that can actually over-cap',
    ).toEqual([]);
  });

  it('every declared minimalArgs is VALID against the tool\'s own schema', async () => {
    // `call()` validates, so this is really asserting the fixtures are usable at all — a fixture
    // that cannot be sent is a fixture that never tested anything.
    //
    // It was `expect(() => s.call(...)).not.toThrow()` on an ASYNC function, which can never
    // observe a rejection — the call returns a promise, nothing throws synchronously, and the
    // assertion passed for every contract no matter how broken the fixture. Validate directly
    // instead of relying on the shape of a thrown error.
    const bad: string[] = [];
    for (const name of Object.keys(CONTRACTS)) {
      const entry = getTool(name);
      if (!entry) { bad.push(`${name}: not registered`); continue; }
      const parsed = z.object(entry.shape).strict().safeParse(CONTRACTS[name].minimalArgs ?? {});
      if (!parsed.success) bad.push(`${name}: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
    }
    expect(bad, 'these contracts declare minimalArgs their own tool would refuse').toEqual([]);
  });

  it('…and that check can actually FAIL (a deliberately bad fixture is caught)', () => {
    // Guard the guard: the previous version of the assertion above was vacuous for two years of
    // fixtures. Prove this one observes a bad one.
    const entry = getTool('modoki_set_transform')!;
    const parsed = z.object(entry.shape).strict().safeParse({ entity: { name: 'X' }, nonsense__: 1 });
    expect(parsed.success).toBe(false);
  });
});
