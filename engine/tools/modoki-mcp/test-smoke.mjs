// Smoke test: spawn the Modoki MCP server over stdio, list tools, call a few
// against the running editor backend (MODOKI_BACKEND). Not a unit test — a
// quick end-to-end check that the server speaks MCP and reaches the backend.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: 'npx',
  args: ['tsx', 'src/index.ts'],
  env: { ...process.env, MODOKI_BACKEND: process.env.MODOKI_BACKEND || 'http://localhost:5173' },
});
const client = new Client({ name: 'smoke', version: '1.0.0' });
await client.connect(transport);

const tools = await client.listTools();
console.log('TOOLS:', tools.tools.map((t) => t.name).join(', '));

const text = (r) => r.content.map((c) => c.text).join('\n');

/** Cases that did NOT run. The final verdict accounts for these (F12) — see the exit below. */
const skipped = [];

const assets = await client.callTool({ name: 'modoki_list_assets', arguments: { type: 'scene' } });
console.log('list_assets(scene) →', text(assets).slice(0, 120).replace(/\n/g, ' '));

// Bare list_traits is summary-first: names by category + traitCount, no field schemas.
const traits = await client.callTool({ name: 'modoki_list_traits', arguments: {} });
const tj = JSON.parse(text(traits));
const categories = Object.keys(tj.byCategory || {}).length;
console.log('list_traits → schemaAvailable:', tj.schemaAvailable, ' traitCount:', tj.traitCount, ` (${categories} categories, no schemas)`);
if (tj.traits) throw new Error('bare list_traits leaked full trait schemas');

// ...and the drill-down returns exactly one schema.
//
// GUARDED, and the guard is load-bearing (#459). This file is ONE linear script with no top-level
// catch, so an unguarded read here does not fail this case — it kills every case below it, and the
// runner sees a stack trace instead of a verdict. That is not hypothetical: while #459 stands,
// `list_traits` serves only the open project's GAME traits, `Transform` is absent, and this line
// threw — silently taking with it the 13 call sites that are the ONLY live coverage of
// `modoki_set_game_view_device` and `modoki_set_animation_view_mode` (both `COVERED_BY_SMOKE` in
// `liveCoverage.ts`, hence deliberately excluded from the T3 sweep). The sweep still printed
// `0 DEFECT`, so the surface looked verified when two tools had been exercised by nothing.
// Skipping instead keeps the rest of the run alive and still fails the verdict (F12) — a skipped
// case can never pass. Do NOT "simplify" this back to a bare read.
const one = await client.callTool({ name: 'modoki_list_traits', arguments: { name: 'Transform' } });
const oj = JSON.parse(text(one));
const transformFields = oj?.traits?.Transform?.fields;
// The bare call above is the independent witness: it already listed every trait name the pushed
// schema carries. Only attribute a missing drill-down schema to #459 when Transform is genuinely
// absent from THAT list — otherwise this is a different failure (a 400/isError envelope, or a
// filter that returned {traits:{}} despite the bare call including Transform) and blaming #459
// would point F12's remediation ("relaunch on games/3d-test") at the wrong fix.
const bareTraitNames = Object.values(tj.byCategory || {}).flat();
const transformInBareCall = bareTraitNames.includes('Transform');
if (!transformFields) {
  const reason = !transformInBareCall
    ? `list_traits(name=Transform) returned no schema — bare list_traits reported traitCount=${tj.traitCount}`
      + ` (${bareTraitNames.join(', ') || 'nothing'}). Engine traits missing from the pushed schema: see #459.`
    : `list_traits(name=Transform) returned no schema even though the bare call listed Transform`
      + ` among ${bareTraitNames.length} traits — drill-down failed for an UNKNOWN reason (not #459).`
      + ` Raw response: ${text(one).slice(0, 200)}`;
  skipped.push(`list_traits drill-down — ${reason}`);
  console.log(`list_traits(name=Transform) SKIPPED — ${reason}`);
} else {
  // The case's own contract: the drill-down returns EXACTLY one schema, not "at least Transform".
  const drillDownKeys = Object.keys(oj.traits);
  if (drillDownKeys.length !== 1 || drillDownKeys[0] !== 'Transform') {
    throw new Error(`list_traits(name=Transform) must return exactly {traits:{Transform}} — got keys [${drillDownKeys.join(', ')}]`);
  }
  console.log('list_traits(name=Transform) → fields:', Object.keys(transformFields).join(','));
}

// Every tool result must be parseable JSON — including a capped one, which is why the
// size cap emits an `{elided:true}` envelope rather than slicing the blob (result.ts).
// Since Phase 3 the bare call is a names-only index and comfortably fits, so the elided
// branch should NOT fire here — but accept it, because that is the point of the envelope:
// a capped answer still parses and still tells you how to narrow.
const state = await client.callTool({ name: 'modoki_get_scene_state', arguments: {} });
const sj = JSON.parse(text(state));
if (sj.elided) {
  console.log(`get_scene_state → ELIDED (${sj.bytes} chars, over cap) — envelope still parsed`);
  const narrowed = await client.callTool({ name: 'modoki_get_scene_state', arguments: { limit: 5 } });
  const nj = JSON.parse(text(narrowed));
  console.log('get_scene_state?limit=5 → scenePath:', nj.scenePath, ' entityCount:', nj.entityCount);
} else {
  console.log('get_scene_state → scenePath:', sj.scenePath, ' entityCount:', sj.entityCount);
}

/** Run `check`, then ALWAYS run `cleanup` — and report `check`'s failure in preference to
 *  `cleanup`'s. A bare `finally { throw }` (which is what these were) lets a cleanup failure MASK
 *  the assertion failure that caused it, i.e. it hides the finding this harness exists to produce.
 *  A cleanup failure with no primary failure still throws: leaving test entities in the human's
 *  scene is itself a bug. */
/** UC9's created guids, shared with its cleanup (which must undo exactly as many creates as
 *  landed, even when the check failed part-way). */
let smokeGuids = [];

async function withCleanup(check, cleanup) {
  let failure = null;
  try { await check(); } catch (e) { failure = e; }
  try {
    await cleanup();
  } catch (e) {
    if (failure) console.log(`  (cleanup ALSO failed: ${e.message})`);
    else failure = e;
  }
  if (failure) throw failure;
}

// ── modoki_batch (plan Phase 5) ──────────────────────────────────────────────
// Unit tests drive the executor over a FAKE registry, which cannot prove the batch
// actually reaches the editor, and cannot prove ORDER — a fake registry would happily
// pass with steps executed backwards. So the checks below are the ones only a live
// editor can answer. They are deliberately READ-ONLY: this runs against whatever
// project the human has open, and a smoke test must never write to it.

// 1. Pre-flight rejects BEFORE anything runs — asserted here too because the refusal
//    text is what an agent has to act on, and it must survive schema/wording drift.
for (const [label, steps, expect] of [
  ['unknown tool', [{ tool: 'modoki_nope' }], 'unknown tool'],
  ['denied build', [{ tool: 'modoki_build', args: {} }], 'its own call'],
  ['raw x/y', [{ tool: 'modoki_tap', args: { x: 1, y: 2 } }], 'not allowed inside a batch'],
]) {
  const r = await client.callTool({ name: 'modoki_batch', arguments: { steps } });
  if (!r.isError || !text(r).includes(expect)) throw new Error(`batch pre-flight (${label}) did not reject: ${text(r)}`);
  console.log(`batch pre-flight rejects ${label} ✓`);
}

// 2. Ordering + the `wait` pseudo-step over the real HTTP path.
const chain = await client.callTool({ name: 'modoki_batch', arguments: { steps: [
  { tool: 'modoki_get_editor_state', args: {} },
  { tool: 'wait', args: { ms: 100 } },
  { tool: 'modoki_list_scenes', args: {} },
] } });
const cj = JSON.parse(text(chain));
if (!cj.ok || cj.ran !== 3) throw new Error(`batch chain did not run 3 steps: ${text(chain)}`);
if (cj.steps.map((s) => s.i).join() !== '0,1,2') throw new Error('batch steps came back out of order');
console.log('batch runs an ordered chain (incl. wait) →', cj.ran, 'steps ✓');

// 2b. The `modoki_` prefix is OPTIONAL on a step's tool name (#295). Read-only, and asserted
//     LIVE because the resolution happens server-side against the REAL registry — a fake one
//     proves only that the helper agrees with itself. The distinguishing part is that the
//     reported names come back RESOLVED: a batch that merely refused more politely would not
//     produce them.
const bare = JSON.parse(text(await client.callTool({ name: 'modoki_batch', arguments: { steps: [
  { tool: 'get_editor_state', args: {} },
  { tool: 'modoki_wait', args: { ms: 1 } },
  { tool: 'list_scenes', args: {} },
] } })));
if (!bare.ok || bare.ran !== 3) throw new Error(`bare-named batch did not run: ${JSON.stringify(bare)}`);
const bareNames = (bare.steps ?? []).concat(bare.quiet ?? []).sort((a, b) => a.i - b.i).map((s) => s.tool).join();
if (bareNames !== 'modoki_get_editor_state,wait,modoki_list_scenes') {
  throw new Error(`bare names did not resolve to full ones: ${bareNames}`);
}
console.log('batch accepts a bare tool name and reports it resolved →', bareNames, '✓');

// 3. `resultDefault:'none'` suppresses clean steps into `quiet` — the token saving.
const quiet = JSON.parse(text(await client.callTool({ name: 'modoki_batch', arguments: {
  steps: [{ tool: 'modoki_get_editor_state', args: {} }, { tool: 'modoki_list_scenes', args: {} }, { tool: 'modoki_list_traits', args: {} }],
  resultDefault: 'none',
} })));
if (quiet.quiet?.length !== 2 || quiet.steps?.length !== 1) throw new Error(`result:none did not suppress: ${JSON.stringify(quiet)}`);
console.log('batch resultDefault:none → quiet:', quiet.quiet.map((q) => q.i).join(), '+ terminal read ✓');

// 4. A FAILURE un-suppresses the steps before it. This is the invariant that makes
//    `result:'none'` safe to offer: steps 0-1 already APPLIED and are not rolled back,
//    so an envelope that mentioned only the failure would describe a state that does
//    not exist. Only a live backend produces a genuine mid-batch failure.
const failed = await client.callTool({ name: 'modoki_batch', arguments: { steps: [
  { tool: 'modoki_get_editor_state', args: {}, result: 'none' },
  { tool: 'modoki_list_scenes', args: {}, result: 'none' },
  { tool: 'modoki_validate_scene', args: { path: '/assets/scenes/does-not-exist.json' }, result: 'none' },
  { tool: 'modoki_list_traits', args: {} },
] } });
if (!failed.isError) throw new Error('a failing batch must surface as isError (C7)');
// The failure is a §5 envelope now (conventions §5): the batch report lives at `error.got`, and
// `code` says WHICH kind of failure it was — PARTIAL means "some of it applied", as against the
// pre-flight REFUSED_BY_OP above where nothing ran. That distinction is the whole point.
const fe = JSON.parse(text(failed)).error;
if (fe?.code !== 'PARTIAL') throw new Error(`expected code PARTIAL, got ${fe?.code}: ${text(failed)}`);
if (fe.tool !== 'modoki_batch') throw new Error(`the envelope must name the tool, got ${fe.tool}`);
// `got` must be a STRUCTURED object, not JSON nested inside JSON. It was the latter on the first
// cut of the envelope — `error.got.failedAt` needed a second JSON.parse to reach, which is how a
// well-shaped error ends up harder to read than the free text it replaced.
if (typeof fe.got !== 'object') throw new Error('error.got must be structured, not a JSON string');
const fj = fe.got;
if (fj.ok !== false || fj.failedAt !== 2) throw new Error(`expected failedAt=2: ${text(failed)}`);
if (fj.quiet) throw new Error('a failed batch must NOT leave steps suppressed in `quiet`');
if (fj.steps.filter((s) => s.i < 2).length !== 2) throw new Error("the 'none' steps before the failure were not promoted");
if (!fj.notRun?.length) throw new Error('the un-run tail was not reported');
// The FAILING step's own error is an envelope too, and its code must describe what really went
// wrong. A missing SCENE is NOT_FOUND; the first cut of `httpFailure` mapped every 404 onto
// "the route is absent — relaunch the editor", which sent the reader after a phantom editor
// problem over a typo'd path. "Could not look" is never reported as "nothing is there" (§5).
const inner = fj.steps.find((s) => s.i === 2)?.error?.error;
if (inner?.code !== 'NOT_FOUND') throw new Error(`a missing scene must be NOT_FOUND, got ${inner?.code}`);
if (!/does-not-exist/.test(inner.why)) throw new Error('the failing step must name WHICH scene was missing');
console.log('batch failure → code:', fe.code, ' failedAt:', fj.failedAt, ' step2:', inner.code, '✓');

// ── Case preconditions (Issue #41) ───────────────────────────────────────────
// UC3/UC5/UC6/UC8 below depend on state that only games/3d-test provides — a scene, a prefab, a
// particle def, an entity named 'cube'. Probed ONCE up front via the TOOL SURFACE (never the
// filesystem: the harness may be pointed at a remote/packaged editor), so an unmet precondition
// reports itself as one instead of failing case-by-case with errors that read like BROKEN TOOLS —
// `load-scene FAILED for …skinned-test.scene.json`, `tap: no entity named "cube"`. That misread is the
// bug this block exists to fix: per CLAUDE.md the repo owner never drives MCP tools, so the agent
// is the only one who ever runs this gate, and a wrong-state failure costs a debugging detour
// every time — plus the opposite error, "fixing" a tool that was fine.
//
// Gated PER CASE, not on one shared boolean. Two of these preconditions read the CURRENTLY OPEN
// SCENE, not the project, so a shared gate would disable cases that need nothing from it. That is
// not hypothetical: measured on games/3d-test with skinned-test.scene.json open, only UC3's precondition
// fails — a shared gate would have silently dropped UC5/UC6/UC8 too, and the tempting "fix" for
// that is to delete the probe. Each case declares exactly what it uses.
const FIXTURE_SCENE = '/assets/scenes/skinned-test.scene.json';
const FIXTURE_PREFAB = '/assets/models/skinned-test/cone.prefab.json';
const FIXTURE_PARTICLE = '/assets/particles/confetti.particle.json';
const [scenesR, prefabsR, particlesR, cubeR, coneR, identityR] = await Promise.all([
  client.callTool({ name: 'modoki_list_scenes', arguments: {} }),
  client.callTool({ name: 'modoki_list_assets', arguments: { type: 'prefab' } }),
  client.callTool({ name: 'modoki_list_assets', arguments: { type: 'particle' } }),
  client.callTool({ name: 'modoki_get_scene_state', arguments: { name: 'cube' } }),
  client.callTool({ name: 'modoki_get_scene_state', arguments: { name: 'Cone' } }),
  // get_editor_state carries no project-identifying field (only the open SCENE path) — the open
  // PROJECT's root comes from modoki_identity instead.
  client.callTool({ name: 'modoki_identity', arguments: {} }),
]);
const OPEN_PROJECT = JSON.parse(text(identityR)).projectRoot ?? '(unknown)';
const cubeState = JSON.parse(text(cubeR));
// UC3 frames the cube before aiming at it (see the batch below) — focus_entity addresses by
// guid/id, not by name, so capture the guid here off the probe we already ran.
const CUBE_GUID = (cubeState.entities ?? [])[0]?.guid;
const OPEN_SCENE = cubeState.scenePath ?? '(unknown)';
const conesAlready = (JSON.parse(text(coneR)).entities ?? []).length;
// Which viewports are actually mounted right now. Read once, here, because it gates a precondition
// below AND is asserted on later — one read, one truth.
const mountedSurfaces = JSON.parse(text(await client.callTool({ name: 'modoki_get_editor_state', arguments: {} }))).surfaces;

/** Each precondition: is it met, and how to describe it when it is not. Keyed so a case can
 *  declare only what it actually uses — a case gated on a precondition it does not need is the
 *  over-skipping this table exists to prevent. */
const PRECOND = {
  scene: { ok: (JSON.parse(text(scenesR)).scenes ?? []).some((s) => s.path === FIXTURE_SCENE), need: `the scene ${FIXTURE_SCENE}` },
  prefab: { ok: (JSON.parse(text(prefabsR)).assets ?? []).some((a) => a.path === FIXTURE_PREFAB), need: `the prefab ${FIXTURE_PREFAB}` },
  particle: { ok: (JSON.parse(text(particlesR)).assets ?? []).some((a) => a.path === FIXTURE_PARTICLE), need: `the particle def ${FIXTURE_PARTICLE}` },
  cube: { ok: (cubeState.entities ?? []).length > 0, need: "an entity named 'cube' in the OPEN scene" },
  // UC5 aims by NAME on purpose (the ergonomic form is what finds bugs), so it needs 'Cone' to be
  // unambiguous AFTER its instantiate adds one. Any pre-existing Cone makes the name ambiguous,
  // and an ambiguous name is REFUSED everywhere by design — so the case cannot run, and the
  // refusal is the tool being right. Found by running this gate against skinned-test.scene.json, which
  // ships 3 Cones: without this probe UC5 failed with a wall of REFUSED_BY_OP that reads exactly
  // like modoki_set_transform being broken. Rewriting UC5 to aim by guid would "fix" the failure
  // by deleting the coverage — the by-name path is the thing under test.
  coneFree: { ok: conesAlready === 0, need: `NO pre-existing entity named 'Cone' in the OPEN scene (found ${conesAlready}; UC5 aims by name, and an ambiguous name is correctly refused)` },
  // UC3 aims at `surface: 'scene-view'`, so the SceneView must actually be MOUNTED. FlexLayout only
  // mounts the SELECTED tab, so a perfectly healthy editor booted with the Game panel in front has
  // surfaces ['game-2d','game-3d'] and no scene-view — measured on BOTH games/3d-test and
  // games/sling from a default launch. Without this probe UC3 ran anyway and died on
  // `focus_entity`'s "no SceneView viewport is mounted", which reads like modoki_focus_entity being
  // broken; it is the tool correctly refusing an impossible request. The suite already comments
  // that `get_editor_state.surfaces` is how you know what is mounted — this makes it act on it.
  sceneView: {
    ok: Array.isArray(mountedSurfaces) && mountedSurfaces.includes('scene-view'),
    need: `the SceneView tab to be MOUNTED (open/select it in the editor) — mounted now: ${(mountedSurfaces ?? []).join(', ') || 'none'}`,
  },
  // `set_game_view_device`'s panelMounted/panelSize assertions are only meaningful with the Game
  // tab MOUNTED — per agentEditorOps.ts, FlexLayout only mounts the SELECTED tab, so a layout with
  // the Game tab closed or a re-docked layout with it unselected reports `panelMounted: false` and
  // omits `panelSize` even for Free, which is correct behaviour, not a defect.
  gameView: {
    ok: Array.isArray(mountedSurfaces) && (mountedSurfaces.includes('game-2d') || mountedSurfaces.includes('game-3d')),
    need: `the Game tab to be OPEN and SELECTED (open/select it in the editor) — mounted now: ${(mountedSurfaces ?? []).join(', ') || 'none'}`,
  },
};
const CASE_NEEDS = { UC3: ['cube', 'sceneView'], UC5: ['prefab', 'coneFree'], UC6: ['particle'], UC8: ['scene'], gameViewDevice: ['gameView'] };

/** True when `uc`'s preconditions all hold. Otherwise pushes ONE skip reason — naming the open
 *  project AND scene, since either can be the cause — and logs it, so the F12 verdict at the end
 *  of this file turns the run into `SMOKE INCOMPLETE` + exit 1. A skipped case can never pass. */
function preconditionsFor(uc) {
  const unmet = CASE_NEEDS[uc].filter((k) => !PRECOND[k].ok).map((k) => PRECOND[k].need);
  if (!unmet.length) return true;
  const reason = `unmet precondition in the open editor (project ${OPEN_PROJECT}, scene ${OPEN_SCENE}) — needs: ${unmet.join('; ')}`;
  skipped.push(`${uc} — ${reason}`);
  console.log(`${uc} SKIPPED — ${reason}`);
  return false;
}
const canUC3 = preconditionsFor('UC3'), canUC5 = preconditionsFor('UC5'),
      canUC6 = preconditionsFor('UC6'), canUC8 = preconditionsFor('UC8'),
      canGameViewDevice = preconditionsFor('gameViewDevice');

// ── Real use cases (plan Usability 1) ────────────────────────────────────────
// Each of these is a workflow written the way an agent would naturally write it, and each one
// FOUND a bug in that form. They are here so the bug cannot come back quietly. Two rules they
// obey deliberately: no hand-written scene `path` (the ergonomic form is the one that gets used,
// and `set_transform`/`mutate_scene` both had a broken-or-absent default that only the explicit
// form hid), and any mutation is undone before the next case runs.

// UC8 — a SCENE SWAP mid-batch. The hypothesis going in was that a reload reassigns runtime ids,
// so later steps would break; addressed by NAME/PATH they do not, and the swap-back works too.
// What it actually found was worse and unrelated: an unknown arg KEY was silently dropped, so
// `set_selection {name:'Capsule'}` (there is no `name` param) parsed to `{}` — which that tool
// documents as "no refs = clear" — and it CLEARED the selection while reporting ok.
// Runs FIRST of the mutating cases, and only against a CLEAN editor. `load_scene` refuses while
// the live world has unsaved changes (correctly — a swap destroys them), and the later cases here
// leave the world dirty by design (manual persistence: they mutate live and never save). Forcing
// past it is not an option for a harness pointed at a live editor: the unsaved work might be the
// human's. So: check, and skip out loud rather than either failing or discarding.
const pre = JSON.parse(text(await client.callTool({ name: 'modoki_get_editor_state', arguments: {} })));
// Whatever scene is open RIGHT NOW, so the harness restores the human's editor rather than
// assuming a particular project's default.
const SCENE = pre.scenePathRef;
if (!canUC8 || pre.unsavedChanges || !SCENE) {
  // `canUC8` already pushed its own reason (missing fixture) above — only push the
  // unsaved-changes/no-scene reason here, so one case never contributes two skip entries.
  if (canUC8) {
    skipped.push(`UC8 — ${pre.unsavedChanges ? 'the editor has unsaved live-world changes (a scene swap would destroy them)' : 'no resolvable scenePathRef to restore'}`);
    console.log(`UC8 SKIPPED — ${skipped[skipped.length - 1]}`);
  }
} else {
const uc8 = JSON.parse(text(await client.callTool({ name: 'modoki_batch', arguments: { steps: [
  { tool: 'modoki_load_scene', args: { path: FIXTURE_SCENE }, result: 'none' },
  { tool: 'modoki_get_editor_state', args: {} },
  { tool: 'modoki_get_scene_state', args: { name: 'Cylinder' } },
] } })));
await withCleanup(() => {
  if (!uc8.ok) throw new Error(`UC8 scene swap failed: ${JSON.stringify(uc8)}`);
  const st = uc8.steps.find((s2) => s2.tool === 'modoki_get_editor_state')?.result;
  // ⚠️ A step's ack is VERBATIM only under `ACK_VERBATIM_CHARS` (1500); above it, `batchReport.ts`
  // degrades it to `{elided, bytes, preview}` where every leaf is JSON-STRINGIFIED. That is the
  // batch budget working as designed, not a failure — but reading `st.scenePathRef` straight off
  // the envelope made this assertion depend on how big the editor state happened to be, i.e. on
  // how many panels the human left open. Measured: 1733 chars standalone (verbatim, fine) vs 1726
  // inside the batch (elided) on an editor with the skin editor and 6 panels open, so UC8 failed
  // with "did not see the swapped scene" while the swap had worked perfectly. Read through the
  // preview when elided; the assertion still fails for a real regression.
  const scenePathRefOf = (s) => {
    if (!s?.elided) return s?.scenePathRef;
    try { return JSON.parse(s.preview?.scenePathRef ?? 'null'); } catch { return undefined; }
  };
  if (scenePathRefOf(st) !== FIXTURE_SCENE) {
    throw new Error(`UC8 later step did not see the swapped scene: ${JSON.stringify(st)}`);
  }
  // A NAME resolved AFTER the swap: this is what proves the reload did not invalidate the step.
  // `name` is a SUBSTRING filter, so the rig's children match too — assert on what it means (every
  // hit is a Cylinder, and there is at least one), not on a count that depends on the rig.
  const found = uc8.steps.at(-1).result.entities ?? [];
  if (!found.length || !found.every((e) => e.name.includes('Cylinder'))) {
    throw new Error(`UC8 name lookup after the swap returned ${JSON.stringify(found.map((e) => e.name))}`);
  }
  console.log('UC8 scene swap mid-batch → later steps see the new scene, names still resolve ✓');
}, async () => {
  const back = JSON.parse(text(await client.callTool({ name: 'modoki_batch', arguments: { steps: [
    { tool: 'modoki_load_scene', args: { path: SCENE }, result: 'none' },
    { tool: 'modoki_get_editor_state', args: {} },
  ] } })));
  const now = back.steps?.at(-1)?.result?.scenePathRef;
  if (now !== SCENE) throw new Error(`UC8 failed to restore ${SCENE} (now ${now})`);
  console.log('UC8 restores the original scene ✓');
});
}

// UC2 — lay out several entities in ONE batch, then verify, then clean up.
// The `path`-less form is load-bearing: a batch cannot read a step's response, so a tool that
// demands a path an agent has to look up first is not batchable at all.
const uc2 = (ops, extra = []) => ({
  resultDefault: 'none',
  steps: [{ tool: 'modoki_mutate_scene', args: { ops } }, ...extra],
});
const UC2 = ['UC2_a', 'UC2_b', 'UC2_c'];
const placed = JSON.parse(text(await client.callTool({ name: 'modoki_batch', arguments: {
  resultDefault: 'none',
  steps: [
    ...UC2.map((name) => ({ tool: 'modoki_mutate_scene', args: { ops: [{ op: 'addEntity', name, parentId: 0,
      traits: { Transform: { x: 0, y: 0, z: 0 }, EntityAttributes: { layer: '3d' } } }] } })),
    ...UC2.map((name, i) => ({ tool: 'modoki_set_transform', args: { entity: { name }, space: 'local', position: [i + 1, 2, 3] } })),
    { tool: 'modoki_get_scene_state', args: { name: 'UC2_', trait: 'Transform' }, result: 'full' },
  ],
} })));
await withCleanup(() => {
  if (!placed.ok || placed.ran !== 7) throw new Error(`UC2 did not run 7 steps: ${JSON.stringify(placed)}`);
  if (placed.quiet?.length !== 6) throw new Error(`UC2 should suppress 6 steps: ${JSON.stringify(placed.quiet)}`);
  const got = placed.steps.at(-1).result.entities;
  if (got?.length !== 3) throw new Error(`UC2 expected 3 entities, got ${got?.length}`);
  // The ORDER matters: each set_transform must have found the entity its earlier sibling added.
  const xs = got.map((e) => e.traits.Transform.x).join();
  if (xs !== '1,2,3') throw new Error(`UC2 transforms did not apply in order: x = ${xs}`);
  console.log('UC2 places 3 entities in one path-less batch →', got.length, 'placed in order ✓');
}, async () => {
  const cleaned = JSON.parse(text(await client.callTool({ name: 'modoki_batch', arguments: uc2(
    UC2.map((name) => ({ op: 'removeEntity', entity: { name } })),
    [{ tool: 'modoki_get_scene_state', args: { name: 'UC2_' }, result: 'full' }],
  ) })));
  const left = cleaned.steps?.at(-1)?.result?.entities?.length;
  if (left !== 0) throw new Error(`UC2 left ${left} entities behind`);
  console.log('UC2 cleans up after itself ✓');
});

// UC3 — the input macro: focus a panel, click a scene ENTITY by name, let a frame land, look.
// `surface` is REQUIRED for a 2D/3D aim — even when one viewport has it. Without it the call would
// succeed without ever stating which viewport was meant, so a wrong assumption would be confirmed
// rather than corrected. `get_editor_state.surfaces` is how you know what's mounted.
if (canUC3) {
const uc3 = JSON.parse(text(await client.callTool({ name: 'modoki_batch', arguments: { steps: [
  { tool: 'modoki_focus', args: { panel: 'scene' }, result: 'none' },
  // Frame the target FIRST. Without this the tap aims through whatever camera pose the human
  // last left in this project, and the SceneView camera is remembered per project per clone —
  // so whether `cube` is clickable varied by clone, and the gate failed for a reason that had
  // nothing to do with the tools. MEASURED on games/3d-test: at one remembered pose the pick
  // legitimately returns "Boat Hull" for every one of the 25 sampled points, and #15's
  // occlusion check correctly REFUSES. That is the tool being right and the fixture being
  // unreproducible. focus_entity makes the precondition something this suite controls.
  //
  // ⚠️ The SCENE is not controlled the same way, and a failed run poisons the next one. UC8 swaps
  // scenes and restores at the end — so a run that DIES before that restore (UC3 itself throwing,
  // say) leaves the editor remembering the swapped scene, and the next `launch-editor.sh` reopens
  // it. UC3 then SKIPS ("no entity named 'cube' in the OPEN scene") and later cases fail on a
  // fixture nobody chose. Measured 2026-08-19, three runs to work out. Launch the gate with the
  // scene PINNED — `launch-editor.sh games/3d-test --scene tropical-island` — and it is
  // reproducible.
  { tool: 'modoki_focus_entity', args: { guid: CUBE_GUID }, result: 'none' },
  { tool: 'wait', args: { ms: 200 }, result: 'none' },
  { tool: 'modoki_tap', args: { entity: { name: 'cube', surface: 'scene-view' } } },
  { tool: 'wait', args: { ms: 200 }, result: 'none' },
  { tool: 'modoki_capture_viewport', args: {} },
  { tool: 'modoki_get_editor_state', args: {} },
] } })));
if (!uc3.ok) throw new Error(`UC3 input macro failed: ${JSON.stringify(uc3)}`);
const tapped = uc3.steps.find((s) => s.tool === 'modoki_tap')?.result;
if (tapped?.surface !== 'scene-view') throw new Error(`UC3 tap did not report its surface: ${JSON.stringify(tapped)}`);
if (tapped?.occluded !== false) throw new Error(`UC3 tap was occluded: ${JSON.stringify(tapped)}`);
// The click must have LANDED, not merely been dispatched — the editor selecting the entity is
// the only evidence of that, and it is what distinguishes this from a plausible no-op.
const sel = uc3.steps.find((s) => s.tool === 'modoki_get_editor_state')?.result?.selection;
if (sel?.entityId !== tapped.entity.id) {
  throw new Error(`UC3 tap did not select the entity it aimed at: selection=${JSON.stringify(sel)}`);
}
if (!uc3.steps.find((s) => s.tool === 'modoki_capture_viewport')?.result?.path) {
  throw new Error('UC3 capture returned no path');
}
console.log('UC3 focus → tap by entity → wait → capture, and the tap SELECTED the target ✓');

// …and the same aim WITHOUT `surface` must be refused, naming the mounted surfaces. This is the
// half that matters: it is refused even when only one viewport has the entity.
const noSurface = await client.callTool({ name: 'modoki_tap', arguments: { entity: { name: 'cube' } } });
if (!noSurface.isError || !/must say WHICH on-screen surface/.test(text(noSurface))) {
  throw new Error(`a 2D/3D aim without \`surface\` must be refused: ${text(noSurface)}`);
}
if (!/scene-view/.test(text(noSurface))) throw new Error('the refusal must name the mounted surfaces');
// And the editor must publish the mounted set, so a batch can be authored right the first time.
const mounted = JSON.parse(text(await client.callTool({ name: 'modoki_get_editor_state', arguments: {} }))).surfaces;
if (!Array.isArray(mounted) || !mounted.includes('scene-view')) {
  throw new Error(`get_editor_state must list the mounted surfaces, got ${JSON.stringify(mounted)}`);
}
console.log('a 2D/3D aim without `surface` is refused; editor_state lists', mounted.join(', '), '✓');
}

// UC4 — can a batch DRIVE gameplay and verify it? play → fast-forward → let it run → read the
// journal → put everything back. The teardown tail is the realistic shape, and it is what showed
// that a mid-batch read is summarized by default (hence `result:'full'` on the journal, and the
// `summarized`/`summarizedHint` fields that now say so).
const uc4 = JSON.parse(text(await client.callTool({ name: 'modoki_batch', arguments: { steps: [
  { tool: 'modoki_play_control', args: { action: 'play' }, result: 'none' },
  { tool: 'modoki_set_timescale', args: { scale: 2 } },
  { tool: 'wait', args: { ms: 500 }, result: 'none' },
  { tool: 'modoki_journal', args: {}, result: 'full' },
  { tool: 'modoki_set_timescale', args: { scale: 1 }, result: 'none' },
  { tool: 'modoki_play_control', args: { action: 'stop' }, result: 'none' },
] } })));
if (!uc4.ok) throw new Error(`UC4 play-mode batch failed: ${JSON.stringify(uc4)}`);
const ts = uc4.steps.find((st) => st.tool === 'modoki_set_timescale')?.result;
if (ts?.timeScale !== 2) throw new Error(`UC4 timescale did not apply: ${JSON.stringify(ts)}`);
// The journal at FULL detail is the deliverable: a batch that drives play but cannot report what
// happened is not a verification loop. `events` must be a real array, not a shape summary.
const jr = uc4.steps.find((st) => st.tool === 'modoki_journal')?.result;
if (!Array.isArray(jr?.events)) throw new Error(`UC4 journal was not readable: ${JSON.stringify(jr)}`);
if (uc4.summarized) throw new Error(`UC4 should not have summarized anything: ${uc4.summarizedHint}`);
console.log('UC4 drives play + timescale and reads the journal in one batch →', jr.events.length, 'events ✓');

// …and a mid-batch read WITHOUT `result:'full'`: the envelope must volunteer why the payload is
// missing. This is the self-fixing half — the trap is fine, silence about it is not.
// `list_traits({all})` and not `journal`: the journal's size depends on what has happened this
// session (measured 1579 chars mid-play, 620 after a stop), so asserting on it would pass or fail
// by run order. Every trait SCHEMA is fixed by the project and comfortably over the ack ceiling
// (the names-only form is ~1.4k — under it, which is how this assertion first failed).
const uc4b = JSON.parse(text(await client.callTool({ name: 'modoki_batch', arguments: { steps: [
  { tool: 'modoki_list_traits', args: { all: true } },
  { tool: 'modoki_get_editor_state', args: {}, result: 'none' },
] } })));
if (uc4b.summarized?.[0] !== 0 || !/result:'full'/.test(uc4b.summarizedHint ?? '')) {
  throw new Error(`a summarized mid-batch read must say how to get it: ${JSON.stringify(uc4b)}`);
}
console.log('a summarized mid-batch read reports `summarized` + the fix ✓');

// UC5 — prefab: instantiate → override a field → verify the override took. This one found that
// `modoki_prefab` was broken for ALL THREE of its actions: it spread its args over
// `editorAction`'s routing key, so `action:'instantiate'` replaced the op name `'prefab'` and the
// backend answered 400 with a list of valid ops. Nothing in the batch had run.
if (canUC5) {
const CONE = '/assets/models/skinned-test/cone.prefab.json';
const uc5 = JSON.parse(text(await client.callTool({ name: 'modoki_batch', arguments: { steps: [
  { tool: 'modoki_prefab', args: { action: 'instantiate', path: CONE } },
  { tool: 'modoki_set_transform', args: { entity: { name: 'Cone' }, space: 'local', position: [5, 6, 7] } },
  { tool: 'modoki_get_scene_state', args: { name: 'Cone', trait: 'Transform' } },
] } })));
const spawned = uc5.steps?.[0]?.result?.guid;
await withCleanup(() => {
  if (!uc5.ok) throw new Error(`UC5 prefab batch failed: ${JSON.stringify(uc5)}`);
  if (!spawned) throw new Error(`UC5 instantiate returned no guid: ${JSON.stringify(uc5.steps?.[0])}`);
  const root = uc5.steps.at(-1).result.entities.find((e) => e.name === 'Cone');
  const tr = root?.traits?.Transform;
  if (!tr || tr.x !== 5 || tr.y !== 6 || tr.z !== 7) throw new Error(`UC5 override did not apply: ${JSON.stringify(tr)}`);
  // The prefab's own authored scale must SURVIVE the override — that is the difference between
  // routing an edit into the instance's overrides and overwriting its Transform wholesale.
  if (Math.abs(tr.sx - 2 / 3) > 1e-6) throw new Error(`UC5 clobbered the prefab's authored scale: sx=${tr.sx}`);
  console.log('UC5 instantiate → override → verify, prefab scale preserved ✓');
}, async () => {
  if (spawned) {
    const cleaned = JSON.parse(text(await client.callTool({ name: 'modoki_batch', arguments: { steps: [
      { tool: 'modoki_delete_entities', args: { guid: spawned }, result: 'none' },
      { tool: 'modoki_get_scene_state', args: { name: 'Cone' }, result: 'full' },
    ] } })));
    const left = cleaned.steps?.at(-1)?.result?.entities?.length;
    if (left !== 0) throw new Error(`UC5 left ${left} prefab entities behind`);
    console.log('UC5 cleans up after itself ✓');
  }
});
}

// UC6 — an ASSET edit in a batch: change a particle def, confirm it applied LIVE, confirm the file
// write was PARKED (manual persistence) rather than silently hitting disk. This one found that the
// asset surface was WRITE-ONLY: `particle_set` demands a full def, and nothing returned one — so a
// one-field tweak meant reading the .particle.json off disk (impossible for a packaged/remote
// editor) and the edit could not be verified by data at all. `modoki_read_asset_def` is the fix,
// and this case is now expressible entirely inside the tool surface.
if (canUC6) {
const PART = '/assets/particles/confetti.particle.json';
const asset0 = JSON.parse(text(await client.callTool({ name: 'modoki_read_asset_def', arguments: { path: PART } })));
if (!asset0.ok || typeof asset0.def?.maxParticles !== 'number') {
  throw new Error(`UC6 could not read the particle def: ${JSON.stringify(asset0).slice(0, 300)}`);
}
await withCleanup(async () => {
  const uc6 = JSON.parse(text(await client.callTool({ name: 'modoki_batch', arguments: { steps: [
    { tool: 'modoki_particle_set', args: { path: PART, def: { ...asset0.def, maxParticles: 137 } } },
    { tool: 'modoki_read_asset_def', args: { path: PART } },
  ] } })));
  if (!uc6.ok) throw new Error(`UC6 particle edit failed: ${JSON.stringify(uc6)}`);
  const wrote = uc6.steps.find((s2) => s2.tool === 'modoki_particle_set')?.result;
  // Persistence is manual: the write must be PARKED, never silently on disk.
  if (wrote?.saved !== false) throw new Error(`UC6 particle_set reported saved=${wrote?.saved} — manual persistence must park the write`);
  const readBack = uc6.steps.at(-1).result;
  if (readBack?.def?.maxParticles !== 137) throw new Error(`UC6 edit did not apply live: ${JSON.stringify(readBack?.def?.maxParticles)}`);
  // The pending write must be VISIBLE, or an unsaved asset edit is a silent loss waiting to happen.
  if (readBack?.unsaved !== true) throw new Error('UC6 read-back did not report the pending write as unsaved');
  console.log('UC6 read def → edit → read back (137), write parked not saved ✓');
}, async () => {
  // Restore the LIVE def…
  await client.callTool({ name: 'modoki_particle_set', arguments: { path: PART, def: asset0.def } });
  const now = JSON.parse(text(await client.callTool({ name: 'modoki_read_asset_def', arguments: { path: PART } })));
  if (now?.def?.maxParticles !== asset0.def.maxParticles) {
    throw new Error(`UC6 failed to restore maxParticles=${asset0.def.maxParticles} (now ${now?.def?.maxParticles})`);
  }
  // …and then DISCARD the write that restoring just re-parked. This used to be the whole cleanup,
  // and it was not enough — it was cleanup in the live cache only:
  //
  //   • the restore re-marks the asset dirty, so the suite ended with a PENDING WRITE against a
  //     committed game asset. Nothing had touched disk yet, which is what made it look clean —
  //     but the next `save_all` by anyone (a human, a later UC, the next session) committed it.
  //   • and that write is not the file that was there: the def readable through this surface is
  //     the MIGRATED one, so `confetti.particle.json`'s legacy `"gravity": 6` came back as
  //     `[0,-6,0]`. Measured 2026-07-30 — the check above could not see it, because it compared
  //     the one field the test had changed.
  //   • meanwhile `hasUnsavedChanges()` stayed true, so every file-direct route (load_scene,
  //     new_scene, a file-path mutate_scene) 409'd for whatever ran next.
  //
  // A harness that reports "cleans up after itself" has to mean the WORKING TREE, the way the e2e
  // suite does (docs/build.md) — not just the value it happened to assert on.
  const dropped = JSON.parse(text(await client.callTool({
    name: 'modoki_discard_asset_edits', arguments: { paths: [PART] },
  })));
  if (!dropped.ok || !dropped.discarded?.includes(PART)) {
    throw new Error(`UC6 failed to discard the parked write for ${PART}: ${JSON.stringify(dropped).slice(0, 300)}`);
  }
  const st = JSON.parse(text(await client.callTool({ name: 'modoki_get_editor_state', arguments: {} })));
  if (st.dirtyAssetPaths?.includes(PART)) {
    throw new Error(`UC6 left ${PART} pending a save: dirtyAssetPaths=${JSON.stringify(st.dirtyAssetPaths)}`);
  }
  console.log('UC6 restores the def and discards the parked write — no asset left dirty ✓');
});
}

// UC10 — the ASSET LIFECYCLE: scaffold a probe asset, prove it is REACHABLE, trash it, prove it is
// GONE. This closes the gap that made #288 gap 3 a QA finding: an agent could create an asset and
// had nothing to remove it with, so the flagship animation case cleaned up with `rm` — a shell-out
// that neither the tool surface nor this suite can see.
//
// It is written as one modoki_batch on purpose. The delete route used to reply `ok` BEFORE the
// file watcher's 150ms debounce rebuilt the asset manifest, so the most natural verification there
// is — delete, then list — could still see the asset, and read as "the delete silently failed".
// Inside a batch there is no wall-clock gap at all, which is the tightest possible version of that
// race and the reason the route now rebuilds the manifest inline. A `sleep` before the read would
// hide exactly the bug this case exists to catch.
//
// The probe lives under the OPEN project's own asset root and is trashed (recoverable) rather than
// unlinked, so a mid-run failure leaves one file in the OS trash, not a stray committed into
// games/** (CLAUDE.md #18).
const PROBE = '/assets/particles/mcp-smoke-probe.particle.json';
const PROBE_NAME = 'mcp-smoke-probe';
/** The manifest rows matching the probe, from one modoki_list_assets result.
 *  Throws rather than answering `[]` when the step was SUMMARIZED: a batch reports
 *  any non-terminal step over 1500 chars as a shape summary with no `assets` key,
 *  and reading that absence as "the asset is gone" would make this case pass
 *  whether or not the delete worked. Measured — an unfiltered particle list is
 *  ~2.5KB and was summarized exactly this way on the first live run. */
const probeRows = (step, label) => {
  if (!Array.isArray(step?.assets)) {
    throw new Error(`UC10 ${label}: list_assets returned no \`assets\` array (summarized? ${JSON.stringify(step).slice(0, 200)}) — cannot tell present from absent`);
  }
  return step.assets.filter((a) => a.path === PROBE);
};
if (probeRows(JSON.parse(text(await client.callTool({ name: 'modoki_list_assets', arguments: { type: 'particle', name: PROBE_NAME } }))), 'precheck').length) {
  throw new Error(`UC10 cannot run: ${PROBE} already exists — a previous run left it behind. Trash it and re-run.`);
}
await withCleanup(async () => {
  // The reads are NAME-FILTERED, which is both the ergonomic form and what keeps
  // each step small enough to come back in full (see probeRows).
  const uc9 = JSON.parse(text(await client.callTool({ name: 'modoki_batch', arguments: { steps: [
    { tool: 'modoki_create_asset', args: { type: 'particle', path: PROBE } },
    { tool: 'modoki_list_assets', args: { type: 'particle', name: PROBE_NAME }, result: 'full' },
    { tool: 'modoki_delete_asset', args: { paths: [PROBE] }, result: 'full' },
    { tool: 'modoki_list_assets', args: { type: 'particle', name: PROBE_NAME } },
  ] } })));
  if (!uc9.ok) throw new Error(`UC10 asset lifecycle batch failed: ${JSON.stringify(uc9).slice(0, 400)}`);
  const [created, after1, deleted, after2] = uc9.steps.map((s2) => s2.result);
  if (!created?.ok || !created?.id) throw new Error(`UC10 create_asset returned no fresh GUID: ${JSON.stringify(created)}`);
  // The create half: a scaffolded asset the manifest cannot see is not usable by anything.
  if (probeRows(after1, 'after create').length !== 1) {
    throw new Error(`UC10 the created probe is NOT in the asset manifest — create-asset did not register its GUID: ${JSON.stringify(after1).slice(0, 300)}`);
  }
  // The delete half. `trashed:1` counts files that really existed, so it distinguishes
  // "trashed it" from "there was nothing there" — which `ok:true` alone cannot.
  if (deleted?.trashed !== 1) throw new Error(`UC10 delete_asset reported trashed=${deleted?.trashed}, expected 1: ${JSON.stringify(deleted)}`);
  if ((deleted?.missing ?? []).length !== 0) throw new Error(`UC10 delete_asset reported the probe missing: ${JSON.stringify(deleted?.missing)}`);
  // The race. `manifestRebuilt` is the tool's own claim that the read below is answerable NOW.
  if (deleted?.manifestRebuilt !== true) {
    throw new Error(`UC10 delete_asset did not rebuild the manifest inline (manifestRebuilt=${deleted?.manifestRebuilt}) — a verification issued straight after can still see the asset`);
  }
  if (probeRows(after2, 'after delete').length !== 0) {
    throw new Error('UC10 the probe is STILL in the manifest immediately after the delete — the 150ms debounce race is back');
  }
  console.log('UC10 create → listed → delete → gone, in ONE batch (no debounce gap) ✓');
}, async () => {
  // Belt-and-braces: if the batch failed anywhere after the create, the probe is still
  // on disk. A delete of an already-gone path is `trashed:0, missing:[…]`, not an error,
  // so this is safe to run unconditionally — which is the point of the route's
  // skip-missing behaviour.
  const swept = JSON.parse(text(await client.callTool({ name: 'modoki_delete_asset', arguments: { paths: [PROBE] } })));
  if (swept.trashed > 0) console.log('UC10 cleanup trashed a leftover probe (the case failed after creating it)');
});

// UC11 — PlayerPrefs round-trip: read the index, set a probe key, read the VALUE back, delete it,
// confirm it is gone. #288 gap 4 — until now the only way to reach the store was modoki_eval + a
// dynamic import, which is not a tool and cannot be swept.
//
// ⚠️ It never calls action:'clear'. That wipes the whole namespace, and the namespace here is the
// HUMAN's editor playtest saves (`<gameId>@editor`) — for a smoke suite pointed at a live editor
// that is not a risk worth any coverage. `clear`'s refusal path is unit-tested instead, where the
// store is a fixture; its success path is deliberately un-swept.
const PREF_KEY = '__mcp_smoke_probe';
const prefs0 = JSON.parse(text(await client.callTool({ name: 'modoki_player_prefs', arguments: {} })));
if (!prefs0.ok || !Array.isArray(prefs0.keys)) {
  throw new Error(`UC11 could not read the prefs index: ${JSON.stringify(prefs0).slice(0, 300)}`);
}
// The namespace is on every reply for a reason — an editor reads `<gameId>@editor`, not the store
// a shipped build sees. Assert it is THERE, so a reply that silently dropped it is a failure
// rather than something a later reader has to notice.
if (typeof prefs0.namespace !== 'string' || !prefs0.namespace) {
  throw new Error(`UC11 the prefs read did not name its namespace: ${JSON.stringify(prefs0).slice(0, 300)}`);
}
if (prefs0.keys.includes(PREF_KEY)) {
  throw new Error(`UC11 cannot run: ${PREF_KEY} already exists in ${prefs0.namespace} — a previous run left it behind`);
}
await withCleanup(async () => {
  const wrote = JSON.parse(text(await client.callTool({
    name: 'modoki_write_player_prefs', arguments: { action: 'set', key: PREF_KEY, value: { n: 7, tag: 'smoke' } },
  })));
  // saved:true is the claim that the BACKEND accepted the durable write, not merely that the
  // in-memory cache changed — the distinction a read-back structurally cannot make.
  if (!wrote.ok || wrote.saved !== true) throw new Error(`UC11 set did not report a durable write: ${JSON.stringify(wrote)}`);
  const readBack = JSON.parse(text(await client.callTool({ name: 'modoki_player_prefs', arguments: { key: PREF_KEY } })));
  if (readBack.present !== true || readBack.value?.n !== 7) {
    throw new Error(`UC11 read-back did not return the written value: ${JSON.stringify(readBack).slice(0, 300)}`);
  }
  if (readBack.namespace !== prefs0.namespace) {
    throw new Error(`UC11 the write landed in a DIFFERENT namespace than the index read (${readBack.namespace} vs ${prefs0.namespace})`);
  }
  // A delete that hits nothing is a refusal listing the real keys, not a silent no-op — the
  // difference between "removed it" and "there was nothing to remove".
  const typo = JSON.parse(text(await client.callTool({
    name: 'modoki_write_player_prefs', arguments: { action: 'delete', key: `${PREF_KEY}_nope` },
  })));
  if (!/NOT_FOUND/.test(JSON.stringify(typo))) throw new Error(`UC11 a delete of an absent key must be refused, got: ${JSON.stringify(typo).slice(0, 300)}`);
  console.log(`UC11 prefs set → read back → typo'd delete refused, in namespace ${prefs0.namespace} ✓`);
}, async () => {
  const gone = JSON.parse(text(await client.callTool({
    name: 'modoki_write_player_prefs', arguments: { action: 'delete', key: PREF_KEY },
  })));
  // The probe may never have been written (the case can fail before the set), and a delete of an
  // absent key is CORRECTLY a refusal — so only a delete that reports something else is a problem.
  if (!gone.ok && !/NOT_FOUND/.test(JSON.stringify(gone))) {
    throw new Error(`UC11 failed to remove the probe key: ${JSON.stringify(gone).slice(0, 300)}`);
  }
  const after = JSON.parse(text(await client.callTool({ name: 'modoki_player_prefs', arguments: { key: PREF_KEY } })));
  if (after.present !== false) throw new Error(`UC11 left ${PREF_KEY} behind in the human's editor prefs`);
  console.log('UC11 removes its probe key — the human\'s prefs end as they started ✓');
});

// UC12 — a real scene query against a real Rapier world (#288 gap 1).
//
// ⚠️ THE SWEEP CANNOT COVER THIS, and the reason is worth stating rather than discovering. A
// Rapier world is built by the physics system on its first tick, so a scene with NO physics
// colliders never has one — and `tropical-island`, the scene this whole gate pins itself to, has
// exactly zero (measured: `scene-state?trait=Collider3D` returns 0 entities, playing or stopped).
// So `modoki_scene_query`'s ergonomic form correctly refuses NOT_AVAILABLE_HERE there, forever,
// and an EXPECTED_REFUSALS entry covers it. That entry proves the ROUTE is alive; it proves
// nothing whatsoever about the casting path. This case builds a world so something does.
//
// It spawns its own floor rather than looking for one, plays, casts, stops, and removes it.
const UC12_FLOOR = 'UC12_floor';
const UC12_PHYS = 'UC12_physics';
await withCleanup(async () => {
  const built = JSON.parse(text(await client.callTool({ name: 'modoki_batch', arguments: {
    resultDefault: 'none',
    steps: [
      // A Physics3D config entity is what makes the system build a world at all.
      { tool: 'modoki_mutate_scene', args: { ops: [{ op: 'addEntity', name: UC12_PHYS, parentId: 0,
        traits: { Transform: { x: 0, y: 0, z: 0 }, Physics3D: { gravityX: 0, gravityY: -9.81, gravityZ: 0 } } }] } },
      // A static box centred at y=-500, far below anything the scene already has, so the cast
      // below cannot accidentally hit island geometry and pass for the wrong reason.
      { tool: 'modoki_mutate_scene', args: { ops: [{ op: 'addEntity', name: UC12_FLOOR, parentId: 0,
        traits: {
          Transform: { x: 0, y: -500, z: 0 },
          EntityAttributes: { layer: '3d' },
          RigidBody3D: { bodyType: 'static' },
          Collider3D: { shape: 'box', halfW: 50, halfH: 1, halfD: 50 },
        } }] } },
      { tool: 'modoki_play_control', args: { action: 'play' } },
      { tool: 'wait', args: { ms: 400 } },
      // Straight down from just above the floor's top surface (y = -499).
      { tool: 'modoki_scene_query', args: { kind: 'raycast', dim: '3d', origin: [0, -400, 0], direction: [0, -1, 0], maxDistance: 200 }, result: 'full' },
      { tool: 'modoki_scene_query', args: { kind: 'point', dim: '3d', point: [0, -500, 0] }, result: 'full' },
      // A cast the same length in the OPPOSITE direction — the distinguishing observation. Without
      // it, a tool that reported a hit unconditionally would pass every assertion above.
      { tool: 'modoki_scene_query', args: { kind: 'raycast', dim: '3d', origin: [0, -400, 0], direction: [0, 1, 0], maxDistance: 200 }, result: 'full' },
    ],
  } })));
  if (!built.ok) throw new Error(`UC12 setup/query batch failed: ${JSON.stringify(built).slice(0, 500)}`);
  const [down, pick, up] = built.steps.slice(-3).map((s2) => s2.result);
  if (!down?.ok) throw new Error(`UC12 the raycast did not run: ${JSON.stringify(down).slice(0, 400)}`);
  if (!down.hit) throw new Error(`UC12 the downward ray MISSED a floor directly beneath it — the physics world was not built, or the cast is broken: ${JSON.stringify(down)}`);
  if (down.hit.name !== UC12_FLOOR) throw new Error(`UC12 hit '${down.hit.name}', expected ${UC12_FLOOR}`);
  // §3 — the guid is the address, and a hit that only carries a runtime id is a hit an agent
  // cannot safely act on.
  if (!down.hit.guid) throw new Error(`UC12 the hit carries no guid: ${JSON.stringify(down.hit)}`);
  // ~99 units from y=-400 to the floor's top at y=-499. A tolerance, never ===.
  if (Math.abs(down.hit.distance - 99) > 1) throw new Error(`UC12 distance ${down.hit.distance}, expected ~99`);
  if (pick?.hit?.name !== UC12_FLOOR) throw new Error(`UC12 the point pick did not find the floor: ${JSON.stringify(pick).slice(0, 300)}`);
  // A point result must NOT carry a zeroed distance/normal — same field name, same meaning, or absent.
  if ('distance' in (pick.hit ?? {})) throw new Error(`UC12 the point result padded a distance field: ${JSON.stringify(pick.hit)}`);
  if (!up?.ok) throw new Error(`UC12 the upward cast did not run: ${JSON.stringify(up).slice(0, 300)}`);
  if (up.hit !== null) throw new Error(`UC12 the upward ray HIT something (${up.hit?.name}) — the two casts differ only in sign, so a hit here means the result does not depend on the query`);
  console.log(`UC12 raycast + point pick against a real Rapier world → ${down.hit.name} at ${down.hit.distance} ✓`);
}, async () => {
  await client.callTool({ name: 'modoki_play_control', arguments: { action: 'stop' } });
  const cleaned = JSON.parse(text(await client.callTool({ name: 'modoki_batch', arguments: { steps: [
    { tool: 'modoki_mutate_scene', args: { ops: [
      { op: 'removeEntity', entity: { name: UC12_FLOOR } },
      { op: 'removeEntity', entity: { name: UC12_PHYS } },
    ] }, result: 'none' },
    { tool: 'modoki_get_scene_state', args: { name: 'UC12_' }, result: 'full' },
  ] } })));
  const left = cleaned.steps?.at(-1)?.result?.entities?.length;
  if (left !== 0) throw new Error(`UC12 left ${left} entities behind`);
  console.log('UC12 stops the sim and removes its physics fixture ✓');
});

// UC13 — the "New X" registry (#288 gap 5): discover the kinds, create one at an explicit path,
// verify it registered, and trash it. Phase 1's modoki_delete_asset is the cleanup — which is why
// that phase came first.
//
// The path an agent would take is exactly this one, and it exists because the panel's own flow
// opens a BLOCKING osascript save panel on macOS before writing anything.
const REG_PROBE = '/assets/materials/mcp-smoke-registered';   // extension deliberately OMITTED
const REG_PROBE_FULL = `${REG_PROBE}.mat.json`;
const kinds = JSON.parse(text(await client.callTool({ name: 'modoki_list_creatable_assets', arguments: {} })));
if (!kinds.ok || !Array.isArray(kinds.kinds)) throw new Error(`UC13 could not list creatable kinds: ${JSON.stringify(kinds).slice(0, 300)}`);
const sceneKind = kinds.kinds.find((k) => k.kind === 'scene');
// The single most important property of this surface, asserted BEFORE anything is created: the
// kind that would discard the human's live world advertises itself as not agent-creatable.
if (!sceneKind || sceneKind.agentCreatable !== false) {
  throw new Error(`UC13 the 'scene' kind must be flagged agentCreatable:false — it DISCARDS the live world: ${JSON.stringify(sceneKind)}`);
}
if (!kinds.kinds.some((k) => k.kind === 'material' && k.agentCreatable === true)) {
  throw new Error(`UC13 the 'material' kind should be agent-creatable: ${JSON.stringify(kinds.kinds).slice(0, 300)}`);
}
// …and the refusal really refuses, against the LIVE editor rather than a fixture. A `scene` create
// here would throw away whatever the human has open, so this asserts the guard exists rather than
// exercising what it prevents.
const refused = text(await client.callTool({ name: 'modoki_create_registered_asset', arguments: { kind: 'scene', path: '/assets/scenes/mcp-smoke-NEVER.json' } }));
if (!/REFUSED_BY_OP/.test(refused) || !/modoki_new_scene/.test(refused)) {
  throw new Error(`UC13 a scene create must be refused and point at modoki_new_scene, got: ${refused.slice(0, 400)}`);
}
const stillThere = JSON.parse(text(await client.callTool({ name: 'modoki_get_editor_state', arguments: {} })));
if (stillThere.scenePath !== pre.scenePath) {
  throw new Error(`UC13 the refused scene create CHANGED the open scene (${pre.scenePath} -> ${stillThere.scenePath}) — the refusal did not happen before the override ran`);
}
await withCleanup(async () => {
  const made = JSON.parse(text(await client.callTool({
    name: 'modoki_create_registered_asset', arguments: { kind: 'material', path: REG_PROBE },
  })));
  if (!made.ok || !made.guid) throw new Error(`UC13 create failed: ${JSON.stringify(made).slice(0, 300)}`);
  // The extension is appended server-side. Without it the file would be written as a plain .json
  // and registered as a material — an asset whose type the manifest disagrees with.
  if (made.path !== REG_PROBE_FULL) throw new Error(`UC13 expected the .mat.json extension to be appended, got ${made.path}`);
  // The claim the read below rests on. Registering the guid happens in the RENDERER; list_assets
  // reads the BACKEND's scanned map, and /api/write-file suppresses the watcher for the editor's
  // own saves — so without an explicit rescan the reply is ahead of every verification there is.
  if (made.manifestRebuilt !== true) throw new Error(`UC13 the create did not rebuild the backend manifest (manifestRebuilt=${made.manifestRebuilt}) — a list_assets issued now can still miss it`);
  // Registered, not merely WRITTEN — that distinction is the whole point of going through the
  // registry rather than write-file, and only the manifest can answer it.
  //
  // ⚠️ `modoki_resolve_refs` looks like the read for this and is NOT: it resolves ENTITY refs from
  // journal payloads, so an asset guid comes back `unresolved` — including the guid of a material
  // that has been in the project for months (measured, which is what ruled out "the new one just
  // has not registered yet"). Three descriptions named it as an asset verification; all three were
  // corrected in the same commit.
  const listed = JSON.parse(text(await client.callTool({ name: 'modoki_list_assets', arguments: { type: 'material', name: 'mcp-smoke-registered' } })));
  if (!Array.isArray(listed.assets)) throw new Error(`UC13 list_assets returned no assets array (summarized?): ${JSON.stringify(listed).slice(0, 200)}`);
  const row = listed.assets.find((a) => a.path === REG_PROBE_FULL);
  if (!row) throw new Error(`UC13 the new asset is not in the manifest: ${JSON.stringify(listed).slice(0, 300)}`);
  if (row.guid !== made.guid) throw new Error(`UC13 the manifest guid ${row.guid} differs from the one reported (${made.guid}) — the reply names an identity the project does not have`);
  console.log(`UC13 list kinds → scene refused → create material at an explicit path → in the manifest ✓`);
}, async () => {
  const swept = JSON.parse(text(await client.callTool({ name: 'modoki_delete_asset', arguments: { paths: [REG_PROBE_FULL] } })));
  if (swept.trashed > 0) console.log('UC13 trashed its probe material ✓');
});

// UC7 — a batch that fails MID-WAY, on real tools, after a MUTATING step already applied. The
// harness's earlier failure check uses read tools against a fixture-ish path; this one proves the
// contract against real state: the applied prefix is reported (even though it was marked
// `result:'none'`), the un-run tail is named, and the entity is genuinely THERE afterwards.
const uc7 = await client.callTool({ name: 'modoki_batch', arguments: { steps: [
  { tool: 'modoki_mutate_scene', args: { ops: [{ op: 'addEntity', name: 'UC7_probe', parentId: 0,
    traits: { Transform: { x: 9, y: 0, z: 0 }, EntityAttributes: { layer: '3d' } } }] }, result: 'none' },
  { tool: 'modoki_set_transform', args: { entity: { name: 'UC7_nonexistent' }, space: 'local', position: [1, 1, 1] } },
  { tool: 'modoki_save_all', args: {} },
] } });
await withCleanup(async () => {
  if (!uc7.isError) throw new Error('UC7: a failing batch must surface as isError (C7)');
  const j = JSON.parse(text(uc7)).error?.got;   // §5 envelope; the report is at error.got
  if (j?.ok !== false || j.failedAt !== 1) throw new Error(`UC7 expected failedAt=1: ${text(uc7)}`);
  // The failing step must say WHICH entity was missing, by name — a refusal that lists the real
  // problem is what turns the dead end into the next move.
  const why = j.steps.find((st) => st.i === 1)?.error?.error?.why ?? '';
  if (!/UC7_nonexistent/.test(why)) throw new Error(`UC7 step 1 must name the missing entity: ${why}`);
  // The mutating step was marked 'none' and MUST still be reported — it applied and is not rolled
  // back, so an envelope that hid it would describe a scene that does not exist.
  if (j.quiet) throw new Error('UC7: a failed batch must not leave steps suppressed');
  if (!j.steps.some((st) => st.i === 0 && st.ok)) throw new Error(`UC7 applied prefix not promoted: ${text(uc7)}`);
  // save_all must NOT have run: the half-applied state must not have reached disk.
  if (!j.notRun?.some((n) => n.tool === 'modoki_save_all')) throw new Error('UC7: save_all should be in notRun');
  // "ALREADY APPLIED" has to be literally true, not just a warning. This is the assertion that
  // makes the hint trustworthy.
  const live = JSON.parse(text(await client.callTool({ name: 'modoki_get_scene_state', arguments: { name: 'UC7_', trait: 'Transform' } })));
  const probe = live.entities?.find((e) => e.name === 'UC7_probe');
  if (probe?.traits?.Transform?.x !== 9) throw new Error(`UC7 the "already applied" prefix is not actually there: ${JSON.stringify(live.entities)}`);
  console.log('UC7 mid-batch failure → prefix promoted + verified live, save_all not run ✓');
}, async () => {
  const cleaned = JSON.parse(text(await client.callTool({ name: 'modoki_batch', arguments: {
    resultDefault: 'none',
    steps: [
      { tool: 'modoki_mutate_scene', args: { ops: [{ op: 'removeEntity', entity: { name: 'UC7_probe' } }] } },
      { tool: 'modoki_get_scene_state', args: { name: 'UC7_' }, result: 'full' },
    ],
  } })));
  const left = cleaned.steps?.at(-1)?.result?.entities?.length;
  if (left !== 0) throw new Error(`UC7 left ${left} entities behind`);
  console.log('UC7 cleans up after itself ✓');
});

// An AMBIGUOUS entity name must be refused, not first-matched. Duplicate names are ordinary (three
// entities called "Enemy"), and this was a live-path-only gap: the FILE resolver always refused it,
// and the live path was unreachable until the canGoLive fix earlier the same day — so un-deadening
// that path surfaced the bug it had been hiding. Mutating, so it cleans up by GUID (the only
// addressing that works when the name is ambiguous — which is the point).
const DUP = 'DUP_probe';
const mkDup = () => client.callTool({ name: 'modoki_mutate_scene', arguments: { ops: [0, 1].map((i) => ({
  op: 'addEntity', name: DUP, parentId: 0,
  traits: { Transform: { x: i + 1, y: 0, z: 0 }, EntityAttributes: { layer: '3d' } },
})) } });
await mkDup();
await withCleanup(async () => {
  const amb = await client.callTool({ name: 'modoki_set_transform', arguments: { entity: { name: DUP }, space: 'local', position: [7, 7, 7] } });
  if (!amb.isError || !/2 LIVE entities are named/.test(text(amb))) {
    throw new Error(`an ambiguous name must be refused: ${text(amb)}`);
  }
  if (!/address by guid/.test(text(amb))) throw new Error('the refusal must name the way out');
  // Neither entity may have moved — a partial application is what this is protecting against.
  const after = JSON.parse(text(await client.callTool({ name: 'modoki_get_scene_state', arguments: { name: DUP, trait: 'Transform' } })));
  const xs = after.entities.map((e) => e.traits.Transform.x).sort().join();
  if (xs !== '1,2') throw new Error(`an ambiguous ref moved something: x = ${xs}`);
  console.log('an ambiguous entity name is refused, and nothing moves ✓');
}, async () => {
  const st = JSON.parse(text(await client.callTool({ name: 'modoki_get_scene_state', arguments: { name: DUP } })));
  const guids = st.entities.map((e) => e.traits?.EntityAttributes?.guid).filter(Boolean);
  if (guids.length) {
    await client.callTool({ name: 'modoki_mutate_scene', arguments: { ops: guids.map((g) => ({ op: 'removeEntity', entity: { guid: g } })) } });
  }
  const left = JSON.parse(text(await client.callTool({ name: 'modoki_get_scene_state', arguments: { name: DUP } }))).entities?.length;
  if (left !== 0) throw new Error(`ambiguity case left ${left} entities behind`);
  console.log('ambiguity case cleans up after itself ✓');
});

// ── UC9 (Phase 7) — UNDO IS PER STEP, not per batch ──────────────────────────
// The tool description and docs/debug-tools-mcp.md both promise this, and an agent plans its
// cleanup around it ("I'll just undo the batch" is WRONG advice if it is per step). Nothing could
// verify it: the unit tests drive a fake registry, which has no undo stack at all. Only a live
// editor can answer, and it is a read-then-restore case — every entity it creates is undone again.
await withCleanup(async () => {
  const mk = { tool: 'modoki_create_entity', args: { kind: 'empty' }, result: 'full' };
  const b = await client.callTool({ name: 'modoki_batch', arguments: { steps: [mk, mk] } });
  if (b.isError) throw new Error(`the 2-step create batch failed: ${text(b)}`);
  const guids = (JSON.parse(text(b)).steps ?? []).map((st) => st.result?.guid);
  if (guids.length !== 2 || guids.some((g) => !g)) throw new Error(`expected two created guids, got ${JSON.stringify(guids)}`);
  // Assigned as soon as the guids are known to be real, NOT at the end of this function — cleanup
  // "must undo exactly as many creates as landed, even when the check failed part-way" (see :79-81).
  // A late assignment leaves `smokeGuids` at `[]` for every assertion below that throws, and the
  // cleanup loop then runs zero times, leaking these entities into the human's live scene.
  smokeGuids = guids;
  const alive = async () => {
    const out = [];
    for (const g of guids) {
      const r = JSON.parse(text(await client.callTool({ name: 'modoki_get_scene_state', arguments: { guid: g } })));
      out.push((r.entities ?? []).length > 0);
    }
    return out;
  };
  const j = (a) => a.join(',');
  if (j(await alive()) !== 'true,true') throw new Error('the batch did not create both entities');
  // ONE undo must remove exactly the LAST step's entity. A per-BATCH undo would remove both here,
  // which is precisely the wrong mental model the docs are protecting the caller from.
  await client.callTool({ name: 'modoki_history', arguments: { action: 'undo' } });
  const afterOne = j(await alive());
  if (afterOne !== 'true,false') throw new Error(`undo is not per step — after ONE undo, alive = ${afterOne} (expected true,false)`);
  await client.callTool({ name: 'modoki_history', arguments: { action: 'undo' } });
  if (j(await alive()) !== 'false,false') throw new Error('the second undo did not remove the first step\'s entity');
  // …and redo restores them one at a time, in order — the same property from the other side.
  await client.callTool({ name: 'modoki_history', arguments: { action: 'redo' } });
  if (j(await alive()) !== 'true,false') throw new Error('redo is not per step either');
  await client.callTool({ name: 'modoki_history', arguments: { action: 'redo' } });
  if (j(await alive()) !== 'true,true') throw new Error('the second redo did not restore the second entity');
  console.log('UC9 undo/redo inside a batch is PER STEP (2 creates, one undo removes one) ✓');
}, async () => {
  // Undo both creates back off the stack — the scene ends as it started.
  for (const _ of smokeGuids) await client.callTool({ name: 'modoki_history', arguments: { action: 'undo' } });
  for (const g of smokeGuids) {
    const r = JSON.parse(text(await client.callTool({ name: 'modoki_get_scene_state', arguments: { guid: g } })));
    if ((r.entities ?? []).length > 0) throw new Error(`UC9 left ${g} in the scene`);
  }
  console.log('UC9 cleans up after itself ✓');
});

// An unknown arg KEY must be REFUSED, not dropped. All-optional schemas are the dangerous case:
// nothing is missing, so a typo parses clean and the tool does something else. Pre-flight, so
// nothing in the batch runs.
const typo = await client.callTool({ name: 'modoki_batch', arguments: { steps: [
  { tool: 'modoki_set_selection', args: { name: 'Capsule' } },
] } });
if (!typo.isError || !/Unrecognized key/.test(text(typo))) {
  throw new Error(`an unknown arg key must be refused: ${text(typo)}`);
}
if (!/accepted params:/.test(text(typo))) throw new Error('the refusal must name the accepted params');
console.log('batch pre-flight refuses an unknown arg key and lists the real ones ✓');

// ── modoki_hit_regions (#139) ────────────────────────────────────────────────
// The mutating half is show/hide — an SVG overlay on the human's editor. Fully restorable, so
// this is smoke-covered rather than declared un-sweepable: it flips the overlay on, proves the
// tool actually reached the renderer (`visible:true` read back, not just a cheerful ok), and
// restores whatever the overlay was set to before. The read half is swept by the per-tool sweep.
//
// Deliberately does NOT assert that regions were RETURNED: whether any exist depends entirely on
// the open project (a game with no provider correctly reports none), and asserting on it would
// make this case fail for the honest answer. What is asserted is the contract that holds for every
// project — `providers` is present, so an empty list can be read correctly.
{
  const before = JSON.parse(text(await client.callTool({ name: 'modoki_hit_regions', arguments: { action: 'read' } })));
  if (!Array.isArray(before.providers)) throw new Error('hit_regions read must always report `providers` — it is what tells "nobody could answer" from "nothing is there"');
  await withCleanup(async () => {
    await client.callTool({ name: 'modoki_hit_regions', arguments: { action: 'show' } });
    const shown = JSON.parse(text(await client.callTool({ name: 'modoki_hit_regions', arguments: { action: 'read' } })));
    if (shown.visible !== true) throw new Error(`hit_regions show did not take: visible=${shown.visible}`);
    // A read-time filter on show/hide must be REFUSED by name, not silently dropped — the same
    // per-action allowlist modoki_input_watch enforces.
    const stray = await client.callTool({ name: 'modoki_hit_regions', arguments: { action: 'hide', limit: 5 } });
    if (!/UNKNOWN_PARAM/.test(text(stray))) throw new Error('hit_regions must refuse a read-time param on action:hide');
    console.log(`hit_regions show/hide reaches the overlay ✓ (providers: ${before.providers.join(', ') || 'none'}, regions: ${before.totalCount})`);
  }, async () => {
    await client.callTool({ name: 'modoki_hit_regions', arguments: { action: before.visible ? 'show' : 'hide' } });
  });
}

// ── modoki_set_game_view_device (#367) ───────────────────────────────────────────
// Smoke-covered rather than declared un-sweepable: the Game panel's preview size is editor-session
// state, fully restorable, and nothing in the human's project changes. What only a live call can
// prove is that `set-game-view-device` is on the /api/editor-action allowlist AND registered in the
// renderer — a tool can be perfect on both static tiers and 400 on every call (modoki_prefab did,
// for months). The read-back is asserted from modoki_get_editor_state, i.e. from a DIFFERENT route
// than the write, so a setter that answered cheerfully without reaching the store would fail here.
if (canGameViewDevice) {
  const catalog = JSON.parse(text(await client.callTool({ name: 'modoki_game_view_devices', arguments: {} })));
  if (!Array.isArray(catalog.presets) || catalog.presets.length === 0) throw new Error('game_view_devices returned no presets');
  if (!catalog.current || typeof catalog.current.device !== 'string') throw new Error('game_view_devices must report the CURRENT selection, not just the catalog');
  const before = catalog.current;

  await withCleanup(async () => {
    const target = catalog.presets.find((p) => p.name === 'iPhone 16 Pro') ?? catalog.presets.find((p) => !p.free);
    if (!target) throw new Error('the catalog carries no non-Free preset to test with');

    const set = JSON.parse(text(await client.callTool({
      name: 'modoki_set_game_view_device', arguments: { device: target.name, orientation: 'landscape' },
    })));
    if (set.device !== target.name) throw new Error(`set did not resolve the named device: ${JSON.stringify(set)}`);
    // Landscape is a FLIP, not a catalog row — so the logical size must come back swapped. This is
    // the assertion that would catch an orientation silently dropped on the wire.
    if (set.logical.w !== target.logical.h || set.logical.h !== target.logical.w) {
      throw new Error(`landscape did not flip the logical size: ${JSON.stringify(set.logical)} vs portrait ${JSON.stringify(target.logical)}`);
    }
    // Read it back through the OTHER route. A write that reports its own argument back is not
    // evidence it reached the store.
    const st = JSON.parse(text(await client.callTool({ name: 'modoki_get_editor_state', arguments: {} })));
    if (!st.gameView || st.gameView.device !== target.name || st.gameView.orientation !== 'landscape') {
      throw new Error(`editor-state does not report the device that was just set: ${JSON.stringify(st.gameView)}`);
    }

    // An explicit size the catalog has no entry for — the half the human UI cannot do at all.
    // NOTE the orientation is still 'landscape' from the call above, and is deliberately NOT
    // passed here: an explicit size must be taken LITERALLY (640 wide means 640 wide), not flipped
    // by whatever orientation the panel happened to be left in. Measured against a live editor
    // before this defaulted — it came back 480x640.
    const custom = JSON.parse(text(await client.callTool({
      name: 'modoki_set_game_view_device', arguments: { logicalWidth: 640, logicalHeight: 480, dpr: 2 },
    })));
    if (custom.orientation !== 'portrait') throw new Error(`an explicit size must default to portrait so its numbers are literal, got ${custom.orientation}`);
    if (custom.logical.w !== 640 || custom.logical.h !== 480) throw new Error(`custom size did not take: ${JSON.stringify(custom.logical)}`);
    if (custom.physical.w !== 1280 || custom.physical.h !== 960) throw new Error(`dpr did not reach the physical size: ${JSON.stringify(custom.physical)}`);
    // Zeros with no device behind them must SAY they are zeros by construction — four bare zeros
    // are indistinguishable from a measured "this screen has no notch".
    if (custom.safeAreaBasis !== 'custom-none') throw new Error(`a custom size must report safeAreaBasis:'custom-none', got ${custom.safeAreaBasis}`);

    // An unknown name is refused WITH the real list, never fuzzy-matched onto a nearby screen.
    const unknown = await client.callTool({ name: 'modoki_set_game_view_device', arguments: { device: 'iPhone 16 Pruo' } });
    if (!unknown.isError) throw new Error('an unknown device name must be refused, not fuzzy-matched');
    if (!/iPhone 16 Pro/.test(text(unknown))) throw new Error('the refusal must list the real preset names');

    // Two addresses at once is ambiguous — refused rather than resolved by precedence.
    const both = await client.callTool({ name: 'modoki_set_game_view_device', arguments: { device: 'Free', logicalWidth: 100, logicalHeight: 100 } });
    if (!both.isError) throw new Error('device + an explicit size together must be refused as ambiguous');

    // A dpr that cannot round-trip is refused rather than silently rounded: the read-back derives
    // dpr from the ROUNDED physical size, so accepting this would answer a dpr nobody asked for.
    const badDpr = await client.callTool({ name: 'modoki_set_game_view_device', arguments: { logicalWidth: 3, logicalHeight: 3, dpr: 0.5 } });
    if (!badDpr.isError) throw new Error('a dpr whose product is fractional must be refused, not rounded away');

    // The Game panel's mounted-ness is reported: the store accepts a device whether or not GameView
    // is mounted, but NOTHING derived (preview size, insets, letterbox) moves while it is not — so
    // a measurement attributed to this screen would be measured at the previous one.
    // `=== true`, not `typeof === 'boolean'`: the weak form passes when the field is always false,
    // so it would have stayed green under a miscased panel-id lookup or a hardcoded constant. The
    // smoke runs the default layout, where the Game tab is alone in its tabset and therefore
    // mounted — so true is the only correct answer here.
    if (custom.panelMounted !== true) throw new Error(`panelMounted must be true with the Game panel open — got ${custom.panelMounted}`);
    // Free reports the real measured panel area; a fixed device does not (its `logical` IS the size).
    if (custom.panelSize !== undefined) throw new Error('panelSize must be omitted for a fixed device — logical is the answer there');
    const freeBack = JSON.parse(text(await client.callTool({ name: 'modoki_set_game_view_device', arguments: { device: 'Free' } })));
    if (!freeBack.panelSize || !(freeBack.panelSize.w > 0) || !(freeBack.panelSize.h > 0)) {
      throw new Error(`Free must report a MEASURED panelSize, not the device it just left: ${JSON.stringify(freeBack.panelSize)}`);
    }
    // The regression that matters: panelSize must not echo the phone we were just on.
    if (freeBack.panelSize.w === custom.logical.w && freeBack.panelSize.h === custom.logical.h) {
      throw new Error('panelSize returned the PREVIOUS device size — it is reading gameViewSize, not the measured area');
    }

    console.log(`set_game_view_device sets by name, by explicit size, and refuses an unknown one ✓ (${catalog.presets.length} presets)`);
  }, async () => {
    await client.callTool({
      name: 'modoki_set_game_view_device',
      arguments: { device: before.device === 'Custom' ? 'Free' : before.device, orientation: before.orientation },
    });
  });
}

// ── modoki_set_animation_view_mode (#369) ────────────────────────────────────────
// Smoke-covered, not declared un-sweepable: the Animation panel's view is editor-session state and
// the case restores whatever it found. What only a live call proves is that
// `set-animation-view-mode` is BOTH on the /api/editor-action allowlist and registered in the
// renderer — the modoki_prefab failure mode, green on T1+T2 and 400 on every real call.
{
  const st0 = JSON.parse(text(await client.callTool({ name: 'modoki_get_editor_state', arguments: {} })));
  const before = st0.animationViewMode;
  if (before !== 'dopesheet' && before !== 'curves') {
    throw new Error(`editor-state must report animationViewMode, got ${JSON.stringify(before)}`);
  }

  await withCleanup(async () => {
    // Set the view the caller is NOT already in, so a no-op setter cannot pass by coincidence —
    // the store's setter early-returns on an unchanged value, so asserting the current value back
    // would be true whether or not the op reached it.
    const target = before === 'curves' ? 'dopesheet' : 'curves';
    await client.callTool({ name: 'modoki_set_animation_view_mode', arguments: { mode: target } });
    // Read back through the OTHER route: the op returns its own state read, so asserting on its
    // reply alone cannot separate "reached the store" from "echoed the argument".
    const st1 = JSON.parse(text(await client.callTool({ name: 'modoki_get_editor_state', arguments: {} })));
    if (st1.animationViewMode !== target) {
      throw new Error(`the view did not change: asked ${target}, editor-state says ${st1.animationViewMode}`);
    }
    // And back, so both arms are exercised rather than only the one that happened to differ.
    await client.callTool({ name: 'modoki_set_animation_view_mode', arguments: { mode: before } });
    const st2 = JSON.parse(text(await client.callTool({ name: 'modoki_get_editor_state', arguments: {} })));
    if (st2.animationViewMode !== before) throw new Error(`the view did not switch back to ${before}`);

    // A bad mode is REFUSED, not dropped. NOTE what this does and does not prove: the tool's
    // z.enum rejects 'curve' before the request is ever made, so this asserts the SCHEMA arm only.
    // The op's own refusal (agentEditorOps set-animation-view-mode) guards the raw /api/editor-action
    // route, which no tool call can reach — it is covered by the T1/T2 tiers, not here. Both exist
    // because the failure is silent either way: a typo'd mode that reports success leaves the caller
    // reading an empty `modoki_handles editor=curves` as "this clip has no tangents".
    const bad = await client.callTool({ name: 'modoki_set_animation_view_mode', arguments: { mode: 'curve' } });
    if (!bad.isError) throw new Error("an unknown view mode must be refused, not ignored");
    // ...and the refusal must not have moved the view on its way out.
    const st3 = JSON.parse(text(await client.callTool({ name: 'modoki_get_editor_state', arguments: {} })));
    if (st3.animationViewMode !== before) throw new Error('a refused mode changed the view anyway');

    console.log(`set_animation_view_mode switches dopesheet<->curves and refuses an unknown mode \u2713 (was ${before})`);
  }, async () => {
    await client.callTool({ name: 'modoki_set_animation_view_mode', arguments: { mode: before } });
  });
}

// ── modoki_profiler (#166 P6) ────────────────────────────────────────────────
// Self-cleaning, so it is smoke-covered rather than listed as un-sweepable: the capture buffer is
// profiler state, not the human's project, and the case restores GPU timing to how it found it.
// The one thing only a live call proves is that /api/profiler exists on the other end at all —
// which is exactly the class modoki_prefab sat in for months with T1+T2 green.
{
  const read = JSON.parse(text(await client.callTool({ name: 'modoki_profiler', arguments: {} })));
  if (!read || typeof read !== 'object') throw new Error('profiler read returned nothing');

  await withCleanup(async () => {
    const started = JSON.parse(text(await client.callTool({ name: 'modoki_profiler', arguments: { action: 'capture-start' } })));
    if (started.capturing !== true) throw new Error(`profiler capture-start did not take: ${JSON.stringify(started)}`);
    await new Promise((r) => setTimeout(r, 300));
    const stopped = JSON.parse(text(await client.callTool({ name: 'modoki_profiler', arguments: { action: 'capture-stop' } })));
    if (stopped.capturing !== false) throw new Error(`profiler capture-stop did not take: ${JSON.stringify(stopped)}`);
    const frames = JSON.parse(text(await client.callTool({ name: 'modoki_profiler', arguments: { action: 'capture-read', limit: 3 } })));
    if (!Array.isArray(frames.worst)) throw new Error('profiler capture-read returned no `worst` array');
    // Assert the LIMIT was honoured, not merely that an array came back. `Array.isArray` alone
    // passes even when the route silently drops the query param (a typo'd query.get would look
    // identical), which is the one thing this live tier is here to catch.
    if (frames.worst.length > 3) throw new Error(`profiler capture-read ignored limit:3 — got ${frames.worst.length} frames, so the query param never reached the op`);
    if (frames.frameCount > 0 && frames.worst.length === 0) throw new Error(`profiler capture-read returned 0 frames from a capture of ${frames.frameCount}`);
    // Ranked by COST, not recency — the property that makes a hitch findable after the fact.
    for (let i = 1; i < frames.worst.length; i++) {
      if (frames.worst[i].frameMs > frames.worst[i - 1].frameMs) throw new Error('profiler capture-read is not sorted worst-first');
    }

    // A read-side filter on a MUTATING action must be refused BY NAME, not silently dropped —
    // the same per-action hazard hit_regions and input_watch enforce (S3.19).
    const stray = await client.callTool({ name: 'modoki_profiler', arguments: { action: 'reset', markers: 5 } });
    if (!/UNKNOWN_PARAM/.test(text(stray))) throw new Error('profiler must refuse a read-side filter on action:reset');
    console.log(`profiler capture round-trip ✓ (frames captured: ${frames.frameCount})`);

    // action:boot (#238) — the boot-phase read. Only a LIVE call can prove it: the timeline is
    // written during the real boot path, so a unit test would be asserting against spans it
    // opened itself. The editor has by definition already loaded a scene, so a zero-span answer
    // here means the instrumentation never ran.
    const boot = JSON.parse(text(await client.callTool({ name: 'modoki_profiler', arguments: { action: 'boot', limit: 4 } })));
    if (typeof boot.spanCount !== 'number') throw new Error(`profiler boot returned no spanCount: ${JSON.stringify(boot)}`);
    if (boot.spanCount === 0) throw new Error('profiler boot recorded ZERO spans — the boot path is not instrumented on this build');
    if (!Array.isArray(boot.top)) throw new Error('profiler boot returned no `top` array');
    if (boot.top.length > 4) throw new Error(`profiler boot ignored limit:4 — got ${boot.top.length} rows, so the query param never reached the op`);
    // Longest first: the ranking is the point, exactly as with capture-read.
    for (let i = 1; i < boot.top.length; i++) {
      if (boot.top[i].durMs > boot.top[i - 1].durMs) throw new Error('profiler boot `top` is not sorted longest-first');
    }
    // `all` is a boot-only filter and must be refused elsewhere by name, not dropped.
    const strayAll = await client.callTool({ name: 'modoki_profiler', arguments: { action: 'read', all: true } });
    if (!/UNKNOWN_PARAM/.test(text(strayAll))) throw new Error('profiler must refuse `all` on action:read');
    console.log(`profiler boot read ✓ (${boot.spanCount} spans, longest ${boot.top[0]?.name} ${boot.top[0]?.durMs}ms)`);
  }, async () => {
    await client.callTool({ name: 'modoki_profiler', arguments: { action: 'capture-clear' } });
  });
}

// ── modoki_set_selection (#496) ───────────────────────────────────────────────
// COVERED_BY_SMOKE claimed this was smoke-covered, but its only occurrence (the batch pre-flight
// case near :977) is a step inside a batch asserted to be REFUSED before any step runs — that
// step never EXECUTES. This is the first real, executing call.
//
// Gated on UC3's `cube` precondition — it already guarantees exactly one entity named 'cube' in
// the open scene, and CUBE_GUID (captured in the precondition probe above) is a real guid to aim
// at. There is no `name` param on this tool (that gap is exactly what UC8 found, see :302-303), so
// aiming is by guid.
if (canUC3) {
  const before = JSON.parse(text(await client.callTool({ name: 'modoki_get_editor_state', arguments: {} }))).selection;
  await withCleanup(async () => {
    await client.callTool({ name: 'modoki_set_selection', arguments: { guid: CUBE_GUID } });
    // Read back through the OTHER route (get_editor_state), not the op's own reply — an op that
    // echoes its argument back is not evidence it reached the store.
    const st = JSON.parse(text(await client.callTool({ name: 'modoki_get_editor_state', arguments: {} })));
    if (st.selection?.entityId == null || !st.selection.entityIds?.length) {
      throw new Error(`set_selection did not take: ${JSON.stringify(st.selection)}`);
    }
    // Confirm the SELECTED id really IS the cube, not merely that something got selected —
    // resolve the cube's live id by guid (a different route again) and compare.
    const cubeNow = JSON.parse(text(await client.callTool({ name: 'modoki_get_scene_state', arguments: { guid: CUBE_GUID } })));
    const cubeId = (cubeNow.entities ?? [])[0]?.id;
    if (cubeId == null || st.selection.entityId !== cubeId) {
      throw new Error(`set_selection selected id ${st.selection.entityId}, but the cube's live id is ${cubeId}`);
    }
    console.log(`set_selection selects by guid, read back via get_editor_state ✓ (entityId: ${st.selection.entityId})`);
  }, async () => {
    // Restore exactly what was selected before — an asset selection, an entity selection, or
    // nothing (a bare call CLEARS the selection, per the tool's own contract note). Checked, not
    // ignored: if the previously-selected ids no longer resolve, the restore fails silently and
    // the human's selection is left on the probe entity while the run still prints SMOKE OK.
    let restore;
    if (before?.asset) {
      restore = await client.callTool({ name: 'modoki_set_selection', arguments: { asset: before.asset } });
    } else if (before?.entityIds?.length) {
      restore = await client.callTool({ name: 'modoki_set_selection', arguments: { entityIds: before.entityIds } });
    } else {
      restore = await client.callTool({ name: 'modoki_set_selection', arguments: {} });
    }
    if (restore.isError) {
      console.warn(`  ⚠ set_selection cleanup failed to restore the prior selection: ${text(restore)}`);
    }
  });
}

// ── modoki_dispatch_action (#496) ─────────────────────────────────────────────
// COVERED_BY_SMOKE claimed this was smoke-covered too, but there was no call site of any kind.
// This is the first real one.
//
// ⚠️ Measured live, and load-bearing for this case's shape: dispatch-action refuses IDENTICALLY
// whether the sim is STOPPED or the action name is bogus.
//   stopped + real action ('haptics.toggle') → {"ok":false,"dispatched":false,"reason":"not
//     playing — press Play first","simRunning":false}
//   stopped + a bogus name                   → the BYTE-IDENTICAL refusal
//   playing + real action                    → {"dispatched":true,"simRunning":true}
//   playing + a bogus name                   → {"ok":false,"dispatched":false,"reason":"unknown
//     action '…'","known":[...]}
// So a stopped-only call proves NOTHING — it cannot tell a dead route from a stopped editor. This
// case must run inside a PLAY window, where the two arms actually diverge. Do not "simplify" this
// back to a stopped-only call.
{
  // Preconditions read through the SKIPPED mechanism, not a throw — this case is LAST in a linear
  // script with no top-level catch, so a thrown precondition here would skip client.close() too.
  const actions = JSON.parse(text(await client.callTool({ name: 'modoki_list_actions', arguments: {} })));
  const missingActions = !Array.isArray(actions.actions) || actions.actions.length === 0;
  // ENGINE-level actions, present regardless of which project is open.
  const missingHaptics = !missingActions && !actions.actions.some((a) => a.name === 'haptics.toggle');
  if (missingActions || missingHaptics) {
    const reason = missingActions
      ? `list_actions returned no actions: ${JSON.stringify(actions)}`
      : `list_actions is missing the engine-level 'haptics.toggle' action: ${JSON.stringify(actions.actions.map((a) => a.name))}`;
    skipped.push(`dispatch_action — ${reason}`);
    console.log(`dispatch_action SKIPPED — ${reason}`);
  } else {
    await withCleanup(async () => {
      await client.callTool({ name: 'modoki_play_control', arguments: { action: 'play' } });

      // `haptics.toggle` returns early (no-op) when the open scene authors no `HapticSettings`
      // entity, which is the common case — so dispatching it twice usually changes nothing on
      // disk or in the world. `dispatched:true` here proves the dispatch ROUTE and the Play gate
      // (a stopped sim refuses identically to a bogus name — see below), not that state changed.
      // The bogus-name arm below carries the real weight of this case.
      for (let i = 0; i < 2; i++) {
        const r = JSON.parse(text(await client.callTool({ name: 'modoki_dispatch_action', arguments: { name: 'haptics.toggle' } })));
        if (r.dispatched !== true) throw new Error(`dispatch_action did not dispatch a real action while PLAYING: ${JSON.stringify(r)}`);
      }

      // The half that actually catches a dead route: an unknown name must be refused BY NAME, with a
      // `known` list — not merely refused-somehow (a stopped-sim refusal would pass a bare isError
      // check too, and would not distinguish this tool from one that 400s on every call).
      const bogusRaw = await client.callTool({
        name: 'modoki_dispatch_action', arguments: { name: 'modoki.smoke.definitelyNotARealAction' },
      });
      if (!bogusRaw.isError) throw new Error(`a bogus action name must be refused, not silently accepted: ${text(bogusRaw)}`);
      const bogusErr = JSON.parse(text(bogusRaw)).error;
      if (!/unknown action 'modoki\.smoke\.definitelyNotARealAction'/.test(bogusErr?.why ?? '')) {
        throw new Error(`the refusal must NAME the unknown action, got: ${JSON.stringify(bogusErr)}`);
      }
      if (!Array.isArray(bogusErr?.got?.known) || bogusErr.got.known.length === 0) {
        throw new Error(`the refusal must carry a \`known\` action list, got: ${JSON.stringify(bogusErr)}`);
      }

      console.log(`dispatch_action dispatches a real action while PLAYING and names an unknown one ✓ (${actions.actions.length} actions known)`);
    }, async () => {
      // stop reverts the world to its authored snapshot — nothing else here needs undoing.
      await client.callTool({ name: 'modoki_play_control', arguments: { action: 'stop' } });
    });
  }
}

// ── modoki_save_all (#496, reopened) ─────────────────────────────────────────
// The third tool COVERED_BY_SMOKE claimed and nothing executed, and the worst of the three: it is
// the ONLY route from a live edit to disk. Its two prior occurrences were both in UC7 — a step in
// a batch the case asserts fails BEFORE reaching it, plus the assertion that it lands in `notRun`.
// A grep-based guard cannot tell that from a real call site, which is how it survived the pass
// that fixed set_selection and dispatch_action.
//
// ⚠️ WHY THIS SAVES TO AN EXPLICIT PROBE PATH, AND WHY THAT IS NOT A WEAKER TEST.
// A bare `save_all` writes the LIVE WORLD over the open scene FILE — the human's committed
// `games/<id>/assets/scenes/*.json`, in a working tree this harness must leave clean (CLAUDE.md
// #18). Worse, it is unconditional: `saveScene` does not check the dirty flag, and the serializer
// re-emits the whole file, so even a "no-op" save lands as a large diff (#500). The `path` param
// exists precisely so a save can name its own target, so the case uses it: the ONLY files this
// writes are two probes it created, and the human's scene is never opened for writing at all.
//
// ⚠️⚠️ AND WHY THE PROBE SCENE IS `/assets/mcp-smoke-save.json` — NOT `.scene.json`, and NOT in
// the scenes folder. This is a scar, measured on the first green run of this case, which left
// `games/3d-test/.../tropical-island.scene.json` MODIFIED with a brand-new `id`:
//   a save-as writes the CURRENT scene's own guid into the new file, so the probe and the human's
//   scene briefly share one guid. The dev asset scanner auto-HEALS a guid collision by keeping
//   the lexicographically-first path's id and REWRITING the other file's (vite-asset-scanner.ts,
//   `buildManifest(…, heal=true)`) — and `mcp-smoke-save` sorts before `tropical-island`, so the
//   healer re-minted the guid of the committed scene. Every ref to that scene by guid would have
//   broken, from a smoke test that reported OK.
//   The fix is to keep the probe OUT of the manifest entirely: `detectType` classifies a plain
//   `.json` as a scene only via the `.scene.json` suffix or the legacy `/scenes/` directory
//   convention, so a plain `.json` elsewhere under the asset root is not an asset at all — no
//   guid, nothing to collide with. `saveScene` writes whatever path it is handed, and
//   `validate_scene` reads by path, so nothing else cares about the extension.
//   Do NOT "tidy" this path to `/assets/scenes/mcp-smoke-save.scene.json`.
//
// It still exercises both halves of what `save-all` does, which is the whole point — but they are
// observed with DIFFERENT strength, and the difference is worth knowing before trusting this case:
//   • the SCENE serialize + write — verified FROM DISK via `modoki_validate_scene`, a different
//     route that does `fs.readFileSync` + `JSON.parse` on the path. This one does not rest on the
//     op's own word. (It proves existence + parseability, not content: a save that wrote `{}`
//     would pass. The stale-probe precheck removes the "it was already there" escape.)
//   • the PARKED-ASSET flush (`flushDirtyAssets`) — observed only through the editor's OWN
//     bookkeeping (`savedAssets`, `dirtyAssetPaths`, `read_asset_def.unsaved`), because
//     `read_asset_def` reads the LIVE CACHE by design and no route in the surface reads a particle
//     def from disk. So a flush that cleared the registry and reported success while the bytes
//     never landed would pass this half — narrower than it sounds (the realistic regression, the
//     #259 "flush never runs at all", IS caught), but it is not a disk proof and must not be
//     described as one.
//
// ⚠️ The save-as also repoints the human's scene GUID at the probe IN MEMORY: `saveScene` calls
// `registerAsset(scene.id, <probe path>, 'scene')`, and `registerAsset` drops the old path→guid
// entry. Nothing on disk changes (the probe carries no guid of its own — see above), and the
// cleanup's `load_scene` re-registers the real path. But if that reload ever fails, the editor is
// left with the human's scene guid resolving to a file this case is about to trash.
{
  const st0 = JSON.parse(text(await client.callTool({ name: 'modoki_get_editor_state', arguments: {} })));
  // Both probes sit at fixed locations under the asset ROOT, which every project has, so this runs
  // on whatever project is open without assuming a folder layout. The scene probe's location is
  // load-bearing, not a convenience — see the warning above. Named `mcp-smoke-save` so a leftover
  // is identifiable as this case's.
  const SAVE_SCENE = '/assets/mcp-smoke-save.json';   // see the extension/folder warning above
  const SAVE_PART = '/assets/particles/mcp-smoke-save.particle.json';

  // Four preconditions, each of which is about NOT damaging the human's editor — reported through
  // the SKIPPED mechanism (F12), never forced past.
  const blockers = [];
  if (!SCENE) blockers.push('no resolvable scenePathRef — there would be nothing to restore the editor to after the save-as re-points it');
  // `pre` is the snapshot taken at the TOP of this run, not now: by this point the suite's own
  // cases have left the live world dirty by design, so `st0.unsavedChanges` is expected to be true
  // and says nothing about the human. What matters is that the editor was CLEAN when we arrived,
  // because the cleanup below reloads the scene from disk and that discards the live world.
  if (pre.unsavedChanges) blockers.push('the editor already had unsaved live-world changes when this run STARTED — the cleanup reload would destroy them');
  // `saveScene` refuses outside 'stopped' (it would bake preview/runtime state into an authored
  // file). A refusal here is the tool being right, and would read as save_all being broken.
  if (st0.runMode !== 'stopped') blockers.push(`runMode is '${st0.runMode}', not 'stopped' — a save is correctly refused outside stopped`);
  // `flushDirtyAssets` runs FIRST and unconditionally inside save-all, and it flushes EVERY parked
  // doc — not just ours. If the human (or an earlier case) has one parked, this call would commit
  // their pending edit to disk as a side effect. That is exactly the kind of write this harness
  // must not make on their behalf.
  const parkedAlready = (st0.dirtyAssetPaths ?? []).filter((p) => p !== SAVE_PART);
  if (parkedAlready.length) blockers.push(`the editor has parked asset writes this save would flush to disk on the human's behalf: ${parkedAlready.join(', ')}`);

  if (blockers.length) {
    const reason = blockers.join('; ');
    skipped.push(`save_all — ${reason}`);
    console.log(`save_all SKIPPED — ${reason}`);
  } else {
    // A leftover from a previous run would make "the save wrote it" unfalsifiable — the file would
    // already be there. Same precheck UC10/UC11 make, for the same reason.
    // A leftover from a previous run would make "the save wrote it" unfalsifiable — the file would
    // already be there. Each probe is checked through the route that can SEE it: the particle is a
    // real asset (manifest), the probe scene deliberately is NOT (see above), so it is checked by
    // the same from-disk read the assertion below uses.
    // `isError` is NOT the same as "absent": /api/validate-scene answers 404 for a missing file but
    // 500 for one that fails JSON.parse, so a TRUNCATED leftover from a killed run would otherwise
    // read as a clean project. Only a not-found is proof there is nothing there.
    const staleScene = await client.callTool({ name: 'modoki_validate_scene', arguments: { path: SAVE_SCENE } });
    const staleWhy = staleScene.isError ? (JSON.parse(text(staleScene)).error?.why ?? '') : '';
    if (!staleScene.isError || !/not found/i.test(staleWhy)) {
      throw new Error(`save_all cannot run: something already exists at ${SAVE_SCENE} — a previous run left a probe behind. Trash it and re-run. (${staleScene.isError ? staleWhy.slice(0, 200) : 'it reads as a valid scene'})`);
    }
    const stale = JSON.parse(text(await client.callTool({ name: 'modoki_list_assets', arguments: { type: 'particle', name: 'mcp-smoke-save' } })));
    // A summarized reply has no `assets` key at all, and reading that absence as "nothing there"
    // is the UC10 trap — so an unreadable answer is a failure, not a pass.
    if (!Array.isArray(stale.assets)) {
      throw new Error(`save_all precheck: list_assets returned no \`assets\` array (summarized? ${JSON.stringify(stale).slice(0, 200)}) — cannot tell a leftover probe from a clean project`);
    }
    if (stale.assets.length) {
      throw new Error(`save_all cannot run: ${stale.assets.map((a) => a.path).join(', ')} already exists — a previous run left a probe behind. Trash it and re-run.`);
    }
    const made = JSON.parse(text(await client.callTool({ name: 'modoki_create_asset', arguments: { type: 'particle', path: SAVE_PART } })));
    if (!made.ok) throw new Error(`save_all could not scaffold its probe particle: ${JSON.stringify(made).slice(0, 300)}`);
    await withCleanup(async () => {
      // The def comes from `modoki_asset_schema`, not from reading the file back. ⚠️ Measured:
      // `read_asset_def` PEEKS the live cache and deliberately does not fetch, so a
      // freshly-scaffolded asset nothing has loaded is a refusal ("not in the live particle
      // cache") — correct behaviour, and it fails this case before it starts. `asset_schema`'s
      // `example` is `defaultParticleEffect()`, the same generator `/api/create-asset` scaffolds
      // from, so the def stays valid without this file hand-carrying a copy of the schema.
      const schema = JSON.parse(text(await client.callTool({ name: 'modoki_asset_schema', arguments: { type: 'particle' } })));
      if (!schema?.example) throw new Error(`save_all could not get a valid particle example: ${JSON.stringify(schema).slice(0, 300)}`);
      // Carry the scaffolded GUID through: the parked def is what reaches disk, so dropping `id`
      // would save the probe under a different identity than the one create_asset registered.
      const probeDef = { ...schema.example, id: made.id, maxParticles: 496 };

      // Park the write. `particle_set` must report `saved:false` — persistence is manual, and if
      // the edit went straight to disk there would be nothing for save_all to flush and this case
      // would be theatre (the UC6 assertion, made here because THIS case depends on it).
      //
      // ⚠️ BOUNDED RETRY, and it is not papering over this case's own flakiness — it is working
      // around a REAL defect found while writing it (#503): `create_asset` rebuilds the
      // BACKEND manifest inline (which is why UC10 can list the asset in the same batch), but
      // `particle-set`'s existence check is `getGuidForPath` in the RENDERER, whose manifest
      // arrives on a later push. So for ~1s after a create, every asset-def write op refuses with
      // "no particle asset exists at …" — and its hint says "create it first with
      // modoki_create_asset", which is exactly what was just done. Measured: refused immediately,
      // `{ok:true,saved:false}` after 1.5s.
      //
      // Retrying is safe HERE and nowhere else in this file: the refusal states that nothing was
      // applied and nothing was parked, so a refused call has no effect to repeat. A `sleep`
      // instead would be the UC10 mistake — this fails LOUDLY, naming the race, if it never lands.
      let parked, lastRefusal;
      for (let attempt = 0; attempt < 12; attempt++) {
        const r = await client.callTool({ name: 'modoki_particle_set', arguments: { path: SAVE_PART, def: probeDef } });
        if (!r.isError) { parked = JSON.parse(text(r)); break; }
        lastRefusal = text(r);
        if (!/no particle asset exists/.test(lastRefusal)) throw new Error(`save_all: particle_set refused for an unexpected reason: ${lastRefusal.slice(0, 400)}`);
        await new Promise((res) => setTimeout(res, 250));
      }
      if (!parked) throw new Error(`save_all: the renderer never saw the probe asset create_asset had already written (#503) — ${lastRefusal?.slice(0, 300)}`);
      if (parked.saved !== false) throw new Error(`save_all: particle_set reported saved=${parked.saved} — the write must be PARKED for this case to have anything to flush`);
      const dirty = JSON.parse(text(await client.callTool({ name: 'modoki_get_editor_state', arguments: {} })));
      if (!(dirty.dirtyAssetPaths ?? []).includes(SAVE_PART)) {
        throw new Error(`save_all: the probe write did not park (dirtyAssetPaths=${JSON.stringify(dirty.dirtyAssetPaths)}) — nothing to flush`);
      }
      // Applying the def loaded it into the live cache, so the peek answers now — and it must say
      // the write is UNSAVED. That is the state save_all has to change.
      const pending = JSON.parse(text(await client.callTool({ name: 'modoki_read_asset_def', arguments: { path: SAVE_PART } })));
      if (pending?.unsaved !== true || pending?.def?.maxParticles !== 496) {
        throw new Error(`save_all: the parked edit is not readable as pending: ${JSON.stringify(pending).slice(0, 300)}`);
      }

      // ── the call under test ──
      const saved = JSON.parse(text(await client.callTool({ name: 'modoki_save_all', arguments: { path: SAVE_SCENE } })));
      if (!saved.ok) throw new Error(`save_all did not report a write: ${JSON.stringify(saved).slice(0, 400)}`);
      if (saved.scenePath !== SAVE_SCENE) throw new Error(`save_all wrote ${saved.scenePath}, not the path it was given (${SAVE_SCENE})`);
      // The asset half is REPORTED — `savedAssets` is the only place a caller can see which parked
      // docs a save committed, and it was added because `saved:false` had been the last word on a
      // parked edit. A save that flushed it silently is a regression in its own right.
      if (!(saved.savedAssets ?? []).includes(SAVE_PART)) {
        throw new Error(`save_all did not name the flushed asset doc: savedAssets=${JSON.stringify(saved.savedAssets)}`);
      }
      // ⚠️ `path` REDIRECTS ONLY THE PRIMARY SCENE. After the primary saves, `saveAll` loops every
      // OTHER loaded scene in the chain and writes each dirty one to ITS OWN real path
      // (serialize.ts, the `extraSaved` loop) — so on a project whose open scene declares a
      // `baseScene`, a base dirtied by an earlier case in this run reaches a COMMITTED file that
      // no `path` argument can redirect.
      //
      // This is DETECTION, not prevention, and deliberately so: nothing in the tool surface
      // exposes the loaded-scene chain (`readEditorState` reports `unsavedChanges` and
      // `dirtyAssetPaths`, but no per-scene dirty list), so there is no precondition that could
      // see it coming. `extraSaved` is precisely the "committed files this save also wrote"
      // channel, and discarding it is what would turn real damage into a printed ✓. Fail loudly
      // and NAME the files, so whoever hits it knows exactly what to restore.
      if (saved.extraSaved?.length) {
        const paths = saved.extraSaved.map((e) => e.path ?? e).join(', ');
        throw new Error(
          `save_all ALSO wrote ${saved.extraSaved.length} other loaded scene(s) to their own committed paths: ${paths}. `
          + 'Those are real project files this case cannot redirect — check `git status` and restore them '
          + '(git checkout -- <path>). Run the smoke on a project whose open scene has no base-scene chain.',
        );
      }

      // Read back through OTHER routes — an op that echoes its own success is not evidence.
      const after = JSON.parse(text(await client.callTool({ name: 'modoki_get_editor_state', arguments: {} })));
      if ((after.dirtyAssetPaths ?? []).includes(SAVE_PART)) {
        throw new Error(`save_all left the probe parked: dirtyAssetPaths=${JSON.stringify(after.dirtyAssetPaths)}`);
      }
      if (after.unsavedChanges !== false) throw new Error(`save_all reported ok but the editor still has unsaved changes: ${JSON.stringify(after.unsavedChanges)}`);
      if (after.scenePathRef !== SAVE_SCENE) throw new Error(`save_all did not re-point the scene at ${SAVE_SCENE} (now ${after.scenePathRef}) — the tool documents that "the scene keeps it for later saves"`);
      // The asset's own view of itself, through the route the write tools point their callers at.
      // `unsaved:true` here after a reported save is the exact silent-loss shape manual
      // persistence exists to make visible.
      const flushed = JSON.parse(text(await client.callTool({ name: 'modoki_read_asset_def', arguments: { path: SAVE_PART } })));
      if (flushed?.unsaved !== false) throw new Error(`save_all reported the asset flushed, but read_asset_def still calls it unsaved: ${JSON.stringify(flushed).slice(0, 300)}`);

      // THE DISK PROOF, and the assertion this whole case exists for. Everything above is the
      // editor's own account of itself; `/api/validate-scene` does `fs.existsSync` +
      // `fs.readFileSync` + `JSON.parse` on the path (editorBackendRouter.ts) and 404s when the
      // file is not there. So this is the one read that can tell a real write from a route that
      // reports success and touches nothing — the `modoki_prefab` failure mode this issue is about.
      const onDisk = await client.callTool({ name: 'modoki_validate_scene', arguments: { path: SAVE_SCENE } });
      if (onDisk.isError) throw new Error(`save_all reported ok, but the file is NOT on disk — validate_scene could not read ${SAVE_SCENE}: ${text(onDisk)}`);
      const vj = JSON.parse(text(onDisk));
      if (vj.path !== SAVE_SCENE) throw new Error(`validate_scene answered about ${vj.path}, not ${SAVE_SCENE}`);
      console.log(`save_all writes the scene to an explicit path (verified on disk) and flushes ${saved.savedAssets.length} parked asset doc(s) ✓`);
    }, async () => {
      // 1. Put the editor back on the human's scene FIRST, so it is never left pointing at a file
      //    the next step deletes. Conditional: if the case failed before the save, the path was
      //    never re-pointed and a reload would only discard live state for nothing — and it would
      //    be REFUSED anyway, since the suite leaves the world dirty by design.
      const now = JSON.parse(text(await client.callTool({ name: 'modoki_get_editor_state', arguments: {} })));
      if (now.scenePathRef === SAVE_SCENE) {
        const back = JSON.parse(text(await client.callTool({ name: 'modoki_load_scene', arguments: { path: SCENE } })));
        const restored = JSON.parse(text(await client.callTool({ name: 'modoki_get_editor_state', arguments: {} })));
        if (restored.scenePathRef !== SCENE) {
          throw new Error(`save_all failed to restore the human's scene ${SCENE} (now ${restored.scenePathRef}): ${JSON.stringify(back).slice(0, 300)}`);
        }
        console.log('save_all restores the original scene ✓');
      }
      // 2. Drop any parked write still outstanding (the case failed between particle_set and the
      //    save), so the next save_all by anyone does not commit it — the UC6 lesson.
      if ((now.dirtyAssetPaths ?? []).includes(SAVE_PART)) {
        await client.callTool({ name: 'modoki_discard_asset_edits', arguments: { paths: [SAVE_PART] } });
      }
      // 3. Trash both probes. `delete_asset` on an absent path is `trashed:0`, not an error, so
      //    this is safe on every failure path.
      const sweptRaw = await client.callTool({ name: 'modoki_delete_asset', arguments: { paths: [SAVE_SCENE, SAVE_PART] } });
      // A REFUSED delete must fail the run. `trashed > 0` alone is silently false on an error
      // envelope (403 outside allowed dirs, 500 from a throwing moveToTrash), which would end the
      // suite at `SMOKE OK` with both probes still in the human's project — and the NEXT run would
      // then blame its own precheck on "a previous run", pointing at the wrong run.
      if (sweptRaw.isError) throw new Error(`save_all could not trash its probes — they are STILL in the project (${SAVE_SCENE}, ${SAVE_PART}): ${text(sweptRaw).slice(0, 300)}`);
      const swept = JSON.parse(text(sweptRaw));
      if (swept.trashed > 0) console.log(`save_all trashed its ${swept.trashed} probe file(s) ✓`);
    });
  }
}

await client.close();

// F12 — a SKIPPED case used to leave the verdict at a cheerful `SMOKE OK`, so the run reported
// success for coverage it never had. UC8 (the mid-batch scene swap) skips whenever the editor has
// unsaved work, which is most of the time in practice — the one case most likely to be silently
// absent was the one whose absence was invisible. UC3/UC5/UC6/UC8 each skip independently when the
// fixture THAT case needs is absent — which is what happens when the open project isn't
// games/3d-test (see the precondition block above; #41). A suite that can quietly test less than it
// claims is worse than no suite, because it is trusted. Relaunch on games/3d-test with no unsaved
// changes and re-run for a full pass.
if (skipped.length) {
  console.error(`\nSMOKE INCOMPLETE — ${skipped.length} case(s) did not run:`);
  for (const s of skipped) console.error(`  • ${s}`);
  console.error("\nRelaunch this clone's editor on games/3d-test / tropical-island, with no unsaved changes, then re-run:");
  console.error('  engine/scripts/launch-editor.sh games/3d-test --scene tropical-island   # set MODOKI_BACKEND_PORT on a worker clone');
  // The scene is named explicitly (via #43's `--scene`) rather than left to whatever the editor
  // remembered, because some preconditions above are about the OPEN SCENE, not the project.
  // Measured: tropical-island.json satisfies all of them (1 'cube', 0 'Cone'), while
  // skinned-test.scene.json — also in this project — fails two: no 'cube' (UC3) and 3 pre-existing
  // 'Cone's (UC5). "Open the right project" was never a sufficient instruction.
  process.exit(1);
}
console.log('SMOKE OK');
process.exit(0);
