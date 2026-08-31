/** Phase 8 COVERAGE GUARD — every tool is accounted for in all three tiers.
 *
 *  The tiers, and what each can and cannot prove:
 *
 *    T1  registry + contract conformance (`mcpRegistry`, `mcpToolContracts`) — the tool EXISTS,
 *        is strict, is documented, and declares a contract. Cannot prove the route is real.
 *    T2  real handler against a STUB backend (`mcpSurface`) — the tool builds the right request and
 *        handles a failure body. Cannot prove the other end exists: the stub answers whatever the
 *        test wants.
 *    T3  live, against a running editor (`test-live-tools.ts` sweep + `test-smoke.mjs` use cases) —
 *        the ONLY tier that can catch a dead tool. `modoki_prefab` 400'd on every call for months
 *        with T1 and T2 both green.
 *
 *  T1 and T2 are table-driven over the whole registry already, so they cannot miss a tool. T3 is
 *  the one with holes, because a sweep must not damage the human's open project — so its buckets are
 *  DECLARED (`src/liveCoverage.ts`) and this asserts the declaration stays total and honest.
 *
 *  WHY IT IS HERE AND NOT IN THE LIVE SCRIPT: the script cannot run in CI. A bucket list that is
 *  only checked when someone happens to run a live script is exactly the kind of guard that fails
 *  open — see F2 in the ledger.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { CONTRACTS } from '../../tools/modoki-mcp/src/contracts';
import { COVERED_BY_SMOKE, LIVE_UNCOVERED } from '../../tools/modoki-mcp/src/liveCoverage';
import { loadSurface, type Surface } from './mcpSurface';

let surface: Surface | undefined;
afterEach(() => { surface?.restore(); surface = undefined; });

const names = Object.keys(CONTRACTS);
const nonMutating = names.filter((n) => !CONTRACTS[n].mutating);
const mutating = names.filter((n) => CONTRACTS[n].mutating);

describe('T3 live coverage is declared, total, and honest', () => {
  it('every MUTATING tool is either smoke-covered or listed as un-sweepable, with a reason', () => {
    const unaccounted = mutating.filter((n) => !COVERED_BY_SMOKE.includes(n) && !(n in LIVE_UNCOVERED));
    expect(unaccounted,
      'a tool in NEITHER bucket is a tool no live call ever makes — which is exactly how modoki_prefab '
      + 'stayed dead for months. Add a real case to test-smoke.mjs, or list it in LIVE_UNCOVERED with '
      + 'the reason calling it would disrupt the human\'s project.').toEqual([]);
  });

  it('every LIVE_UNCOVERED reason is a real sentence, not a placeholder', () => {
    // A bucket whose reasons are empty strings is a list of exemptions, not a ledger.
    for (const [tool, why] of Object.entries(LIVE_UNCOVERED)) {
      expect(why.length, `${tool} needs a real reason`).toBeGreaterThan(15);
    }
  });

  it('no bucket entry names a tool that no longer exists', () => {
    const stale = [...COVERED_BY_SMOKE, ...Object.keys(LIVE_UNCOVERED)].filter((n) => !names.includes(n));
    expect(stale, 'stale entries silently shrink the guard').toEqual([]);
  });

  it('no bucket entry names a NON-mutating tool — the sweep already calls those', () => {
    // Over-claiming is its own bug: it reads as "not live-covered" about a tool that IS, so the
    // ledger of gaps stops being true. Caught exactly this way while building the sweep
    // (capture_viewport / render_scene / render_sequence were listed AND swept).
    const overclaimed = [...COVERED_BY_SMOKE, ...Object.keys(LIVE_UNCOVERED)].filter((n) => !CONTRACTS[n].mutating);
    expect(overclaimed).toEqual([]);
  });

  it('the two buckets do not overlap — a tool is covered or it is not', () => {
    expect(COVERED_BY_SMOKE.filter((n) => n in LIVE_UNCOVERED)).toEqual([]);
  });

  /** `COVERED_BY_SMOKE`'s own doc comment: "Each entry is a claim that a real case exists there —
   *  not an exemption." A name can sit in the bucket with NO case at all, and nothing above catches
   *  it — this is exactly the `modoki_prefab` failure mode (T1+T2 green, dead route) wearing a
   *  different hat: a ledger entry claiming coverage that isn't there.
   *
   *  This check is TEXT-based (does the tool name appear anywhere in test-smoke.mjs), which is a
   *  weak proxy for "a real, EXECUTING case exists" — a bare mention in a comment, or in an argument
   *  list of a step whose batch never runs, would satisfy it too. That gap is exactly what
   *  `modoki_set_selection` below exploits, and why its exemption spells out that the trap is real.
   *
   *  KNOWN_UNCOVERED is a holding pen, not a home: each entry silences this guard for one specific
   *  tool, so each earns its place with a written reason and the issue tracking the fix. Found
   *  2026-08-31 in #483's close-out review — verified by hand that neither name has a real call site.
   */
  const KNOWN_UNCOVERED: Readonly<Record<string, string>> = {
    // Zero occurrences of 'modoki_dispatch_action' in test-smoke.mjs at all — COVERED_BY_SMOKE's
    // claim is simply false. See #496.
    modoki_dispatch_action: 'no call site of any kind in test-smoke.mjs — see #496',
    // One TEXT occurrence (in the batch pre-flight-refusal case), but the assertion there is that
    // the batch is REFUSED before any step runs — the modoki_set_selection step never executes.
    // A bare grep match is NOT coverage; this exemption is about the call never EXECUTING. Fixing
    // it means adding a real, executing call, not just a second textual mention. See #496.
    modoki_set_selection: 'its one occurrence is inside a pre-flight-REFUSED batch step that never runs — see #496',
  };

  it('every COVERED_BY_SMOKE entry has a real call site in test-smoke.mjs (or a written exemption)', () => {
    const smokeSrc = readFileSync(join(__dirname, '../../tools/modoki-mcp/test-smoke.mjs'), 'utf8');
    const missing = COVERED_BY_SMOKE.filter((n) => !(n in KNOWN_UNCOVERED) && !smokeSrc.includes(n));
    expect(missing,
      'COVERED_BY_SMOKE claims a real case exists in test-smoke.mjs for these tools, but the name '
      + "does not appear there at all — add a real case, or add a KNOWN_UNCOVERED entry with a reason "
      + 'and a tracked issue.').toEqual([]);
  });

  it('KNOWN_UNCOVERED does not silently grow stale — every entry still names a real gap', () => {
    // Each entry here is a claim of its own ("this tool has no real coverage"). If the name stops
    // appearing in COVERED_BY_SMOKE, or a real case is added, the exemption should be deleted, not
    // left behind as dead weight.
    const staleExemptions = Object.keys(KNOWN_UNCOVERED).filter((n) => !COVERED_BY_SMOKE.includes(n));
    expect(staleExemptions, 'a KNOWN_UNCOVERED entry for a tool no longer in COVERED_BY_SMOKE is dead weight').toEqual([]);
  });

  it('the live tier reaches a MAJORITY of the surface (the gap list cannot quietly become the plan)', () => {
    const covered = nonMutating.length + COVERED_BY_SMOKE.length;
    expect(covered / names.length, `only ${covered}/${names.length} tools are live-covered`).toBeGreaterThan(0.45);
  });

  /** THE CIRCULARITY GUARD (independent review, 2026-07-30).
   *
   *  Everything above partitions on `CONTRACTS[n].mutating`, and the live sweep used to take
   *  `!mutating` as "safe to call". Both derived from the SAME hand-maintained boolean, so a tool
   *  declared non-mutating was swept as safe AND structurally exempt from the ledger: its write
   *  half sat in no bucket and no guard could see the hole. `modoki_project_settings` — whose own
   *  contract notes say `action:'set'` rewrites project.config.json — was exactly that.
   *
   *  A partition keyed off a boolean is only as total as the boolean, so this checks the boolean
   *  itself against OBSERVATION: what request does the tool actually make? A tool that POSTs to a
   *  write route while declaring `mutating:false` is caught here regardless of what any bucket says. */
  it('the `mutating` flag matches what the tool OBSERVABLY does', async () => {
    // Routes that change project/editor state. A GET is not automatically safe (modoki_journal
    // clears by GET), so this is a one-way check: POST-to-a-write-route ⇒ must be declared mutating.
    const WRITE_ROUTE = /\/api\/(scene-mutate|asset-write|create-asset|write-file|duplicate-asset|delete-asset|import-file|reimport|project-settings|editor-action|input\/|capture-gesture|build|add-native-target|ota\/(publish|keygen)|watch\/(start|clear)|save|persistence)/;
    const liars: string[] = [];
    for (const name of names) {
      const c = CONTRACTS[name];
      if (c.mutating || c.route === null) continue;
      const s2 = loadSurface();
      try {
        await s2.call(name, c.minimalArgs).catch(() => undefined);
        const wrote = s2.requests.some((q) => q.method !== 'GET' && WRITE_ROUTE.test(q.path));
        if (wrote) liars.push(`${name} (${s2.requests.filter((q) => q.method !== 'GET').map((q) => `${q.method} ${q.path.split('?')[0]}`).join(', ')})`);
      } finally { s2.restore(); }
    }
    expect(
      liars,
      'declared mutating:false but POSTs to a state-changing route — which also makes it swept as ' +
      '"safe" and exempt from the coverage ledger, so nothing else can catch it',
    ).toEqual([]);
  });

  it('a tool whose smallest call is safe is still SWEPT, even when the tool is mutating', () => {
    // The other half of the split: making `mutating` honest must not cost a tool its safe-form
    // coverage, or the next author is incentivised to under-declare again. Both tools with a
    // read half and a write half opt in explicitly.
    for (const name of ['modoki_project_settings', 'modoki_watch']) {
      expect(CONTRACTS[name].mutating, `${name} has a mutating form`).toBe(true);
      expect(CONTRACTS[name].minimalArgsMutates, `${name}'s smallest call is a read and must stay swept`).toBe(false);
    }
  });
});

describe('T2 is total: every tool handles a backend failure through the envelope', () => {
  // Table-driven over the WHOLE registry rather than per-tool by hand. The audit found the same
  // failure reported four different ways precisely because each call site was written on its own.
  for (const name of names) {
    if (CONTRACTS[name].route === null) continue;   // modoki_batch/identity make no call of their own
    it(`${name} turns a backend 500 into an isError envelope`, async () => {
      const s = (surface = loadSurface(() => ({ status: 500, body: { error: 'backend exploded' } })));
      const r = await s.call(name, CONTRACTS[name].minimalArgs);
      expect(r.isError, `${name} reported a 500 as success`).toBe(true);
      const text = s.text(r);
      // Must be the §5 envelope, not free prose — a test cannot assert on prose, and neither can a
      // caller branch on it.
      const parsed = JSON.parse(text) as { error?: { code?: string; tool?: string; why?: string } };
      expect(parsed.error?.code, `${name} failure has no code`).toBeTruthy();
      expect(parsed.error?.tool, `${name} failure does not name the tool`).toBe(name);
      expect(parsed.error?.why, `${name} failure has no cause`).toBeTruthy();
    });
  }
});

describe('T2: a POST tool never reports a 200 {ok:false} as success', () => {
  // The C7 class. GETs are exempt BY DESIGN (`ok:false` can be the answer — diagnose /
  // validate_scene), and the mutating GETs are covered separately in mcpToolContracts.
  //
  // `modoki_eval` is exempt for a different and better reason: `/api/eval` CANNOT emit that shape.
  // It answers `{result}` on success, a non-2xx `{error}` on a relay failure, and a 200 whose
  // `result` is an `Error: …` STRING when the evaluated code throws (the renderer safe-stringifies
  // it). Asserting `{ok:false}` there would test a state the route cannot reach — the harness sin
  // this audit already paid for once, when a stub bypassing zod manufactured nine unreachable
  // findings. Its two REAL failure shapes are asserted instead: the 500 sweep above, and the
  // `Error:` string below.
  const NO_OK_FLAG = new Set(['modoki_eval']);
  for (const name of names) {
    const c = CONTRACTS[name];
    if (c.method !== 'POST' || c.route === null || NO_OK_FLAG.has(name)) continue;
    it(`${name} fails on {ok:false}`, async () => {
      const s = (surface = loadSurface((req) =>
        req.path.split('?')[0] === c.route ? { body: { ok: false, error: 'the op refused' } } : undefined));
      const r = await s.call(name, c.minimalArgs);
      expect(r.isError, `${name} reported an ok:false refusal as success`).toBe(true);
    });
  }
});

describe('T2: modoki_eval\'s own failure shapes (the ones its route can actually produce)', () => {
  it('a 200 whose `result` is an `Error: …` string is a FAILED call, not a string value', async () => {
    // The renderer safe-stringifies a throw, so the transport sees a perfectly successful HTTP 200
    // carrying an error message. Reported as a value, an agent would go on to parse "Error:
    // foo is not defined" as data.
    const s = (surface = loadSurface((req) =>
      req.path === '/api/eval' ? { body: { result: 'Error: foo is not defined' } } : undefined));
    const r = await s.call('modoki_eval', { code: 'return foo' });
    expect(r.isError).toBe(true);
    const e = (JSON.parse(s.text(r)) as { error: { code: string; why: string; options?: string[] } }).error;
    expect(e.code).toBe('REFUSED_BY_OP');
    expect(e.why).toMatch(/the code threw/);
    // The refusal has to carry the thing that actually trips people up here.
    expect(e.options?.join(' ')).toMatch(/FUNCTION BODY|explicit `return`/);
  });

  it('a genuine string RESULT is still a success — the check must not swallow values', async () => {
    const s = (surface = loadSurface((req) =>
      req.path === '/api/eval' ? { body: { result: 'ErrorBoundary' } } : undefined));
    const r = await s.call('modoki_eval', { code: 'return name' });
    expect(r.isError).toBeFalsy();
    expect(s.text(r)).toContain('ErrorBoundary');
  });
});
