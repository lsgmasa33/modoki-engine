/** T3 LIVE TIER — call EVERY safe tool against a running editor, in its ergonomic form.
 *
 *  WHY THIS TIER EXISTS AT ALL. `modoki_prefab` 400'd on every call for MONTHS while having unit
 *  tests, a contract, and a good description: nothing ever called it against a real editor. That is
 *  lesson 1 of this audit — **a tool is not covered until a live call in its ergonomic form passes**
 *  — and no amount of stub-backend testing can produce it, because the stub answers whatever the
 *  test wants.
 *
 *  WHY IT IS A SCRIPT AND NOT A VITEST FILE. It needs a live editor, so it can never run in CI or
 *  in `npm test`; making it a test file would either fail the suite for everyone or be skipped into
 *  uselessness. It is a deliberate gate, like `verify:packaged`.
 *
 *  WHO RUNS IT. **Claude does.** The repo owner does not drive MCP tools — the whole surface exists
 *  for the agent — so "a human will notice a dead tool" is not a real safety net. Run this after any
 *  change to `engine/tools/**`, the `/api/*` routes, or the agent ops:
 *
 *      MODOKI_BACKEND_PORT=5181 engine/scripts/launch-editor.sh games/<id>
 *      MODOKI_BACKEND=http://127.0.0.1:5181 npm --prefix engine/tools/modoki-mcp run test:live
 *
 *  THE ARGUMENTS ARE `minimalArgs` FROM THE CONTRACT TABLE — deliberately. That is the SMALLEST
 *  VALID call, i.e. the lazy form an agent actually writes, which is where all nine of the original
 *  batch bugs hid. A defensive fixture that passes every parameter would have found none of them.
 *
 *  WHAT IT DOES NOT CALL, and why that is not a cop-out: every MUTATING tool is excluded (it runs
 *  against whatever project the human has open, and a sweep that edits scenes, saves files, swaps
 *  the world or starts a 30-minute build would be a menace). Those are covered by the 9 live use
 *  cases in `test-smoke.mjs`, which create/verify/clean up deliberately. The split is asserted:
 *  every tool must be in exactly one of the two, so a new tool cannot escape both.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CONTRACTS } from './src/contracts.js';
// The buckets live in `src/` so a CI-safe vitest guard can assert the split is TOTAL — see
// `src/liveCoverage.ts` for why that separation matters.
import { COVERED_BY_SMOKE as SMOKE_LIST, LIVE_UNCOVERED } from './src/liveCoverage.js';

const COVERED_BY_SMOKE = new Set<string>(SMOKE_LIST);

const BACKEND = process.env.MODOKI_BACKEND || 'http://127.0.0.1:5179';

const transport = new StdioClientTransport({
  command: 'npx', args: ['tsx', 'src/index.ts'], env: { ...process.env, MODOKI_BACKEND: BACKEND },
});
const client = new Client({ name: 'live-tools', version: '1.0.0' });
await client.connect(transport);

const listed = new Set((await client.listTools()).tools.map((t) => t.name));

// ── The DYNAMIC tail (#270): tools the OPEN PROJECT's game registers. They are legitimately on
// the server and legitimately absent from CONTRACTS — a contract is a static fact about the
// engine's surface, and these are declared at runtime by whichever project happens to be open.
//
// Their names come from the backend, NOT from sniffing the `[game tool]` description prefix: the
// prefix is presentation, and a guard keyed to presentation breaks the moment the wording changes
// while still looking like it works.
const gameTools = new Map<string, { mutates: boolean; requiresPlaying: boolean }>();
try {
  const res = await fetch(`${BACKEND}/api/game-tools`);
  if (res.ok) {
    const body = await res.json() as { tools?: { name: string; mutates: boolean; requiresPlaying?: boolean }[] };
    for (const t of body.tools ?? []) gameTools.set(t.name, { mutates: t.mutates, requiresPlaying: t.requiresPlaying === true });
  }
} catch { /* no editor / older backend: there is simply no dynamic tail to account for */ }

// ── The split must be TOTAL: every tool is swept, smoke-covered, or listed as uncovered. ──
const declared = Object.keys(CONTRACTS);
const missingFromServer = declared.filter((n) => !listed.has(n));
const missingFromTable = [...listed].filter((n) => !declared.includes(n) && !gameTools.has(n));
if (missingFromServer.length || missingFromTable.length) {
  console.error(`contract/server mismatch — table-only: ${missingFromServer.join(', ') || '(none)'}; server-only: ${missingFromTable.join(', ') || '(none)'}`);
  process.exit(1);
}

// Sweep on whether the SMALLEST CALL is safe, not on the tool-level `mutating` flag — see
// `minimalArgsMutates` in contracts.ts. Deriving both the sweep set and the coverage partition
// from one flag was circular: a tool declared non-mutating was swept as safe AND exempt from the
// ledger, so a mis-declaration hid itself from both tiers.
const sweep = declared.filter((n) => !(CONTRACTS[n].minimalArgsMutates ?? CONTRACTS[n].mutating));
const unaccounted = declared.filter((n) =>
  CONTRACTS[n].mutating && !COVERED_BY_SMOKE.has(n) && !(n in LIVE_UNCOVERED));
if (unaccounted.length) {
  console.error(
    `\nThese tools are in NO live-coverage bucket: ${unaccounted.join(', ')}\n`
    + 'Add each to COVERED_BY_SMOKE (with a real case in test-smoke.mjs) or to LIVE_UNCOVERED with '
    + 'the reason it cannot be swept. A tool in neither is a tool nobody ever calls for real — which '
    + 'is exactly how modoki_prefab stayed dead for months.');
  process.exit(1);
}
// The reverse direction too: a stale entry claims coverage that no longer exists.
const staleBuckets = [...COVERED_BY_SMOKE, ...Object.keys(LIVE_UNCOVERED)].filter((n) => !declared.includes(n));
if (staleBuckets.length) {
  console.error(`\nStale live-coverage entries (no such tool): ${staleBuckets.join(', ')}`);
  process.exit(1);
}
// …and an entry for a tool the sweep ALREADY calls is worse than dead weight: it reads as "this is
// not live-covered" about a tool that is, so the ledger of gaps stops being true.
const overclaimed = [...COVERED_BY_SMOKE, ...Object.keys(LIVE_UNCOVERED)].filter((n) => !CONTRACTS[n].mutating);
if (overclaimed.length) {
  console.error(`\nThese are NON-MUTATING, so the sweep below calls them directly — remove them from the coverage buckets: ${overclaimed.join(', ')}`);
  process.exit(1);
}

// The dynamic tail gets swept too, on the same rule as the static surface: call what is safe,
// declare what is not. `mutates` is REQUIRED on every game tool precisely so this is answerable
// without a contract — a read-only game tool takes a bare `{}` (its params are optional by
// construction unless declared required, and a required param would make the bare call a refusal,
// which is still a live answer rather than a crash).
const gameSweep = [...gameTools].filter(([, g]) => !g.mutates).map(([n]) => n);
const gameSkipped = [...gameTools].filter(([, g]) => g.mutates).map(([n]) => n);
if (gameTools.size) {
  console.log(`[live] dynamic tail: ${gameTools.size} game tool(s) — sweeping ${gameSweep.join(', ') || '(none)'}`
    + `${gameSkipped.length ? `; skipping ${gameSkipped.join(', ')} (declared mutating — would change the human's open project)` : ''}`);
}

console.log(`[live] backend ${BACKEND}`);
console.log(`[live] sweeping ${sweep.length} non-mutating tools in their ERGONOMIC form (minimalArgs)`);
console.log(`[live] ${COVERED_BY_SMOKE.size} mutating tools covered by test-smoke.mjs · ${Object.keys(LIVE_UNCOVERED).length} declared un-sweepable\n`);

type Row = {
  tool: string; verdict: 'ok' | 'env' | 'DEFECT'; detail: string;
  /** Did an EXPECTED_REFUSALS entry actually MATCH this row? Recorded as a fact at the moment the
   *  branch fires, rather than re-derived from `detail` afterwards.
   *
   *  It used to be re-derived — `detail.startsWith('REFUSED_BY_OP (expected')` — which quietly
   *  assumed every expected refusal carries that one code. The first entry that did not
   *  (`modoki_scene_query`, NOT_AVAILABLE_HERE) was reported as STALE in the same run whose own
   *  output line said `(expected: …)` two lines above. A staleness guard that reads a rendered
   *  string instead of the fact it is about will keep finding new ways to be wrong; this cannot. */
  expectationFired?: boolean;
};
const rows: Row[] = [];

/** Structural codes that describe the EDITOR'S STATE rather than the tool's health. A NOT_FOUND for
 *  a fixture path that does not exist in THIS project is the obvious one: `minimalArgs` carries a
 *  plausible path, not a guaranteed one. */
const ENV_CODES = new Set(['NOT_FOUND', 'NO_RENDERER', 'REQUIRES_SAVE', 'AMBIGUOUS_SURFACE']);

// `modoki_render_sequence`'s REFUSED_BY_OP only fires when the editor is STOPPED (`runMode`, not the
// 3-value `playState` — see editorBackendRouter.ts's own comment on why). While Playing the ergonomic
// call succeeds normally, which is correct behaviour, not a defect — so fetch `runMode` up front to
// gate that one expectation on the state actually observed THIS run, rather than assuming stopped.
let observedRunMode: string | undefined;
let editorStateBody = '';
try {
  editorStateBody = (await client.callTool({ name: 'modoki_get_editor_state', arguments: {} })).content
    .map((c) => (c as { text?: string }).text ?? '').join('');
  const editorStateForGate = JSON.parse(editorStateBody) as { runMode?: string; playState?: string };
  observedRunMode = editorStateForGate.runMode ?? editorStateForGate.playState;
} catch (e) {
  // Same V3 shape as the sweep loop's own "returned HTML, not JSON" check below, but this call runs
  // BEFORE the sweep and outside its per-tool try/catch — a throw here used to kill the whole T3
  // tier with zero rows reported. Degrade instead: every downstream use of `observedRunMode` already
  // treats it as optional (a `when()` gate and two `!== 'playing'`/`=== 'stopped'` comparisons), so
  // `undefined` just means those state-gated expectations don't fire this run.
  console.error(`[live] WARNING: could not read the run-mode gate from modoki_get_editor_state (${e instanceof Error ? e.message : String(e)}) — proceeding with observedRunMode=undefined, so run-mode-gated expectations will not fire this run. Response was: ${editorStateBody.slice(0, 200)}`);
}

/** Tools whose ergonomic call legitimately REFUSES depending on the editor/project state, matched
 *  on the refusal text. Being explicit is the point: without this the sweep either flags three
 *  correct refusals as defects every run (and gets ignored), or blanket-accepts REFUSED_BY_OP and
 *  stops being able to see a real one. Each entry says WHY the refusal is correct — and any OTHER
 *  refusal from the same tool is still a defect. Shrink-only.
 *
 *  `when` is optional and defaults to "always expected" — add it only when the refusal itself
 *  depends on editor state observed at sweep time (as opposed to project/asset state, which the
 *  ENV_CODES/NOT_FOUND path already covers generically). When `when()` is false, the entry is not
 *  expected to fire THIS run, and its absence from the results is not flagged as stale below. */
const EXPECTED_REFUSALS: Record<string, { match: RegExp; why: string; when?: () => boolean }> = {
  modoki_render_sequence: {
    match: /editor is STOPPED/i,
    why: 'S2.33 by design — with time not advancing every frame would be identical, so a sequence is refused unless Playing (or forceRender:true). The refusal IS the correct behaviour here.',
    when: () => observedRunMode === 'stopped',
  },
  modoki_ota_status: {
    match: /could not derive a gs:\/\/ bucket|gcloud not found/i,
    why: 'the swept project has no OTA bucket configured; the route refuses rather than answering "nothing is published", which is the §5 could-not-look-vs-nothing-there rule working.',
  },
  modoki_scene_query: {
    match: /no (2D|3D) physics world exists on this surface/i,
    why: 'the swept scene has no physics colliders, so no Rapier world is ever built — measured on tropical-island, which has ZERO Collider3D entities whether playing or stopped. The op refuses rather than answering hit:null, which is §5 working: a query that could not run is not a query that found nothing. The MATCH here is the discriminator that keeps this honest — a genuinely dead route also answers NOT_AVAILABLE_HERE, but with the route-is-absent text, not this one. Smoke UC12 builds a real world and casts against it, because this entry proves the route is alive and nothing about the casting.',
  },
  modoki_read_asset_def: {
    match: /not in the live .* cache/i,
    why: 'minimalArgs names a plausible particle path, and the op reads the LIVE cache — an asset the open scene has not loaded is a state answer, and the message names the fix.',
  },
};

// The static surface first, then the dynamic tail. A game tool has no contract to take
// `minimalArgs` from — a bare `{}` IS its ergonomic form, since declared params are optional
// unless marked required.
for (const name of [...sweep, ...gameSweep]) {
  const args = CONTRACTS[name]?.minimalArgs ?? {};
  let verdict: Row['verdict'] = 'ok';
  let detail: string;
  let expectationFired = false;
  try {
    const r = await client.callTool({ name, arguments: args as Record<string, unknown> });
    const body = r.content.map((c) => (c as { text?: string }).text ?? '').join('');
    if (r.isError) {
      let code = '';
      try { code = (JSON.parse(body) as { error?: { code?: string } }).error?.code ?? ''; } catch { /* not an envelope */ }
      let why = '';
      try { why = (JSON.parse(body) as { error?: { why?: string } }).error?.why ?? ''; } catch { /* handled below */ }
      const expected = EXPECTED_REFUSALS[name];
      const expectedActive = expected && (expected.when ? expected.when() : true);
      // A game tool that DECLARED it needs Play, refusing while the editor is stopped, is giving a
      // state answer — the dynamic-tail equivalent of an EXPECTED_REFUSALS entry, which cannot
      // list a tool this harness has never heard of. Any OTHER refusal from it is still a defect,
      // and so is this one while the editor IS playing.
      const gameStateRefusal = gameTools.get(name)?.requiresPlaying === true
        && observedRunMode !== 'playing' && code === 'REFUSED_BY_OP';
      if (!code) { verdict = 'DEFECT'; detail = `failed WITHOUT a §5 envelope: ${body.slice(0, 160)}`; }
      else if (ENV_CODES.has(code)) { verdict = 'env'; detail = code; }
      else if (expectedActive && expected.match.test(why)) { verdict = 'env'; expectationFired = true; detail = `${code} (expected: ${why.slice(0, 70)}…)`; }
      else if (gameStateRefusal) { verdict = 'env'; detail = `${code} (declares requiresPlaying; editor is ${observedRunMode})`; }
      else { verdict = 'DEFECT'; detail = `${code}: ${body.slice(0, 200)}`; }
    } else {
      // A success still has to be a PARSEABLE payload — a severed blob or raw HTML is a defect the
      // envelope exists to prevent (V3: a missing route answered 200 with index.html).
      const trimmed = body.trimStart();
      if (trimmed.startsWith('<')) { verdict = 'DEFECT'; detail = 'returned HTML, not JSON (route fell through to the SPA)'; }
      else {
        try { JSON.parse(body); detail = `${body.length} chars`; }
        catch { detail = `${body.length} chars (non-JSON — fine for a log/text tool)`; }
      }
    }
  } catch (e) {
    verdict = 'DEFECT';
    detail = `threw: ${e instanceof Error ? e.message : String(e)}`;
  }
  rows.push({ tool: name, verdict, detail, expectationFired });
  const mark = verdict === 'ok' ? '✓' : verdict === 'env' ? '·' : '✗';
  console.log(`  ${mark} ${name.padEnd(34)} ${detail.slice(0, 110)}`);
}

await client.close();

// A stale expectation is its own bug: it silences a tool that is no longer refusing, so a real
// refusal later reads as "expected". Same shrink-only discipline as the coverage buckets.
const unusedExpectations = Object.keys(EXPECTED_REFUSALS).filter((n) => {
  const entry = EXPECTED_REFUSALS[n];
  if (entry.when && !entry.when()) return false; // not expected to fire THIS run — see `when` above
  const row = rows.find((r) => r.tool === n);
  return row && !row.expectationFired;
});
if (unusedExpectations.length) {
  console.error(`\nEXPECTED_REFUSALS entries that did NOT fire: ${unusedExpectations.join(', ')} — the tool stopped refusing, so delete the entry (it would silence a real refusal later).`);
  process.exit(1);
}

const defects = rows.filter((r) => r.verdict === 'DEFECT');
const env = rows.filter((r) => r.verdict === 'env');
console.log(`\n[live] ${rows.length - defects.length - env.length} ok · ${env.length} environmental · ${defects.length} DEFECT`);
if (env.length) console.log(`[live] environmental (editor state, not tool health): ${env.map((r) => `${r.tool}=${r.detail}`).join(', ')}`);
if (defects.length) {
  console.error('\nLIVE DEFECTS:');
  for (const d of defects) console.error(`  ✗ ${d.tool} — ${d.detail}`);
  process.exit(1);
}
console.log('LIVE TOOLS OK');
process.exit(0);
