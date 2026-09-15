/** ⚠️ **A number-keyed `Map`/`Set` in engine `runtime/**`, the editor, `engine/app`, the starter template,
 *  `games/` or `demos/` uses `EntityTable`/`PackedEntity`, or spends a ledger row saying why it may not
 *  (#868, widened #1198).** Games reach both through `@modoki/engine/runtime`.
 *
 *  koota's `entity.id()` is a recycled INDEX, and a despawn+respawn reclaims it — in bulk, every
 *  one. State held across frames under that index hands a newcomer the dead entity's state. The
 *  rule and its incidents are in `docs/engine-concepts.md` § Entity; the census that found the same
 *  mechanism patched in five different shapes, and more real sites waiting (the `pending:` rows), is #868. This guard
 *  exists because the census was a one-off sweep and the NEXT site is the actual failure mode.
 *
 *  ## What it flags
 *
 *  A `Map`, `Set`, `ReadonlyMap` or `ReadonlySet` whose FIRST type argument is the `number` keyword
 *  — anywhere inside the declared type or the initializer, so `WeakMap<World, Map<number, …>>` is
 *  caught — declared as:
 *  - a module-scope variable,
 *  - a class property, or
 *  - an interface / type-literal property.
 *
 *  The last two are not optional (owner, 2026-09-14): every REAL defect #868 found was a field —
 *  `RenderState.skinned`, `AudioState.sources`, `ParticleSyncState.recs` — so a module-scope-only
 *  guard would have caught none of them.
 *
 *  Not flagged: anything inside a function, method or arrow — locals, parameters, return types and
 *  the type literals inside them (none can outlive the call) — and a `Map<PackedEntity, …>` — the brand is not the `number` keyword, which is the
 *  point of the brand.
 *
 *  ## Known blind spots — say them rather than let a green run imply otherwise
 *
 *  - An UNTYPED `new Map()` whose element type is inferred from use. The parser sees no type
 *    argument, and resolving the inferred type needs a full program, not a parse.
 *  - A string key that embeds a bare id (`` `${id}` ``, `` `${id}:${clip}` ``). The type is `string`.
 *    So is a GUID key, and **a guid is an address, not a lifetime key**: `spawnPrefabInstance`'s
 *    `guidSeed` mints the SAME guid on every respawn by design (timeline scrub, Entries rows), and an
 *    entity without `EntityAttributes` has none. Per-entity state keyed by guid inherits exactly as a
 *    bare id does; read such a map by hand.
 *  - **Component state holding an entity id (`useState<Set<number>>`) stays BY HAND** (owner,
 *    2026-09-14, re-confirmed 2026-09-15). It is a call, not a declaration, and a check aimed at it
 *    could not tell an entity id from any other number in state. `core/ecs/entityPin.ts` is the
 *    shape for it. A NAMED props interface at module scope that carries such state is a declaration
 *    and is flagged; an inline props type in the component's parameter list is inside a function and
 *    is not (the `okLiteralParam` fixture pins that).
 *  - Ids held as an ARRAY or a scalar (`editorStore.selectedEntityIds: number[]`, `selectedEntityId`).
 *    Only `Map`/`Set`/`Record` are collections here; #1221 is that shape.
 *  - A number-keyed map reachable only through an inferred type (`{ routing: ReturnType<typeof f> }`):
 *    no type argument appears at the declaration. SceneView's routing memo was one until #1220 moved it
 *    to `sceneView2DGraph.ts` behind a declared `Canvas2DRoutingMaps`, which the scan now reads.
 *  - State kept alive by a CLOSURE or a component scope rather than a declaration: a function-local
 *    `new Map<number, …>()` captured by the callback it returns (`Scene3D.tsx`'s per-mount `ecsLights`
 *    is one — read by hand 2026-09-14: lights rebuild on a type change and every field is re-applied
 *    each frame, so it is mirrored state). Functions are skipped whole; an IIFE is not.
 *  - Aliases are resolved by NAME (`type PoseMap = Map<number, …>`, `type SceneId = number`), since a
 *    parse cannot follow an import. The scope is `runtime/**` for LEDGER; for WIDENED_LEDGER it is
 *    runtime plus the engine side (editor, app, three, starter) or runtime plus ONE project
 *    (`aliasScopes`). An alias declared outside its scope is invisible.
 *  - Unscanned: `engine/electron`, `engine/plugins`, `engine/tools`, `engine/packages/capacitor-*`, which
 *    run outside the ECS world; their number-keyed maps are request/port ids (read 2026-09-15). A
 *  project's OWN `packages/**` (e.g. `games/3d-test/packages/app-services`) IS scanned, as project code.
 *  - A game COPIED OUT of the repo (#29) takes no copy of this guard with it.
 *
 *  ## The ledgers
 *
 *  `LEDGER` covers `runtime/**`, keyed `file::Owner.name` relative to runtime. `WIDENED_LEDGER` covers
 *  the editor, `src/three`, `engine/app`, the starter template and every project `discoverProjects`
 *  finds, keyed REPO-relative so a row names its tree. A `games/`/`demos/` row is owed only where the
 *  checkout carries that PROJECT (`rowIsOwedInLayout`): the OSS snapshot ships no games and a curated
 *  subset of demos.
 *  Every reason starts with a tag, so the list can be read by kind:
 *  - `not-entity:` — the number is something else (a glyph code, a texture uid, a pointer id).
 *  - `scratch:` — cleared and refilled inside one synchronous pass before it is read.
 *  - `revalidated:` — held across frames, but every entry is re-checked against a value recomputed
 *    from the live entity, so a recycled index re-derives rather than inherits.
 *  - `gen-in-value:` — the generation is stored beside the payload and checked, rebuilt on mismatch.
 *  - `owner-checked:` — id-keyed, guarded by a SIBLING owner-stamp map that purges every map on a
 *    mismatch or a missing stamp before any read (`videoSystem`). The guard is in another container
 *    (#873's warning), so the row must say why the owner map cannot be the shorter lifetime.
 *  - `packed-key:` — typed `number` but keyed by `entity.valueOf()`.
 *  - `per-world-index:` — rebuilt from the live world, read only by ids taken from live entities.
 *  - `despawn-evicted:` — a frame-derived cache read by id after the pass that fills it; its entry is
 *    deleted inside `destroy()` by `core/ecs/despawnEviction.ts`, and the owner rebuilds it next pass.
 *  - `pending: #N` — a real recycled-index defect whose fix is bigger than a key swap, tracked by the
 *    issue it names. ⚠️ A fix that keeps the `number` key (a version stamp, a prune, a pin) still
 *    matches the declaration, so this guard will NOT go red when it lands: **the fixer retags the row**
 *    with the line that now makes it safe.
 *  - `uncertain:` — not yet settled, with the test that would settle it. */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { parseSource } from '@modoki/engine/testing/sourceAst';
import { assertExemptionLedger } from '@modoki/engine/testing/exemptionLedger';
import { repoFiles } from '../../scripts/repoCorpus.mjs';
import { discoverProjects } from '../../scripts/projectRoots.mjs';
import { REPO_ROOT } from '../helpers/repoLayout';

const RUNTIME = 'engine/packages/modoki/src/runtime';
const COLLECTIONS = new Set(['Map', 'Set', 'ReadonlyMap', 'ReadonlySet', 'Record']);

/** Type aliases found across the scanned corpus: names that stand for a number-keyed collection
 *  (`type PoseMap = Map<number, PoseEntry>`) and names that stand for `number` (`type SceneId = number`).
 *  Resolved by NAME within a scope (see `aliasScopes`) — a parse cannot follow an import. A same-named
 *  alias with a different meaning inside ONE scope would add a false row; across projects it did, which
 *  is why the widened scan does not pool them. */
export interface Aliases { collections: ReadonlySet<string>; numbers: ReadonlySet<string> }
const NO_ALIASES: Aliases = { collections: new Set(), numbers: new Set() };

function isNumberKey(t: ts.TypeNode | undefined, aliases: Aliases): boolean {
  if (!t) return false;
  if (t.kind === ts.SyntaxKind.NumberKeyword) return true;
  return ts.isTypeReferenceNode(t) && !t.typeArguments && aliases.numbers.has(t.typeName.getText());
}

/** Does `node` contain a `Map`/`Set`/`Record`-family type reference or `new` expression keyed by
 *  `number` (or a `number` alias), or a reference to an alias that is one? */
function holdsNumberKeyed(node: ts.Node, aliases: Aliases = NO_ALIASES): boolean {
  let hit = false;
  const visit = (n: ts.Node): void => {
    if (hit) return;
    // A function's parameters, return type and locals die with its call — EXCEPT an immediately
    // invoked one, whose result is the value being declared (`const s = (() => ({ m: new Map<number, X>() }))()`).
    if (ts.isFunctionLike(n)) {
      if (isInvokedImmediately(n) && 'body' in n && n.body) visit(n.body as ts.Node);
      return;
    }
    let name: string | undefined;
    let args: ts.NodeArray<ts.TypeNode> | undefined;
    if (ts.isTypeReferenceNode(n)) { name = n.typeName.getText(); args = n.typeArguments; }
    else if (ts.isNewExpression(n)) { name = n.expression.getText(); args = n.typeArguments; }
    if (name && ((COLLECTIONS.has(name) && isNumberKey(args?.[0], aliases)) || (ts.isTypeReferenceNode(n) && aliases.collections.has(name)))) {
      hit = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return hit;
}

function isInvokedImmediately(fn: ts.Node): boolean {
  let p = fn.parent;
  let child: ts.Node = fn;
  while (p && ts.isParenthesizedExpression(p)) { child = p; p = p.parent; }
  return !!p && ts.isCallExpression(p) && p.expression === child;
}

function ownerName(n: ts.Node): string {
  if (ts.isClassLike(n) || ts.isInterfaceDeclaration(n)) return n.name?.getText() ?? '<anonymous>';
  if (ts.isTypeLiteralNode(n)) {
    // A type literal has no name of its own; the nearest named declaration that holds it does.
    for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
      if ((ts.isTypeAliasDeclaration(p) || ts.isInterfaceDeclaration(p) || ts.isClassLike(p)
        || ts.isVariableDeclaration(p) || ts.isPropertySignature(p) || ts.isPropertyDeclaration(p)
        || ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p)) && p.name) {
        return `${p.name.getText()}{}`;
      }
    }
  }
  return '<anonymous>';
}

interface Declaration { item: string; site: string }

/** Inside a function, method, accessor or arrow — including its parameter and return types. A
 *  declaration there cannot outlive the call, so it is not a candidate. */
function insideFunction(n: ts.Node): boolean {
  for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
    if (ts.isFunctionLike(p)) return true;
  }
  return false;
}

/** Grow `into` with the aliases `code` declares. Returns whether anything was added, so the caller can
 *  iterate to a fixed point (an alias of an alias). */
/** Every alias the corpus declares, iterated to a fixed point so an alias of an alias declared ABOVE
 *  its target (or in a file scanned earlier) still resolves. */
export function collectCorpusAliases(sources: ReadonlyArray<{ file: string; code: string }>, base: Aliases = NO_ALIASES): Aliases {
  const aliases = { collections: new Set(base.collections), numbers: new Set(base.numbers) };
  for (let grew = true; grew;) {
    grew = false;
    for (const s of sources) if (collectAliases(s.code, s.file, aliases)) grew = true;
  }
  return aliases;
}

export function collectAliases(code: string, file: string, into: { collections: Set<string>; numbers: Set<string> }): boolean {
  const sf = parseSource(code, file);
  let grew = false;
  for (const st of sf.statements) {
    if (!ts.isTypeAliasDeclaration(st)) continue;
    const name = st.name.getText();
    if (isNumberKey(st.type, into) && !into.numbers.has(name)) { into.numbers.add(name); grew = true; }
    else if (holdsNumberKeyed(st.type, into) && !into.collections.has(name)) { into.collections.add(name); grew = true; }
  }
  return grew;
}

/** Every flagged declaration in one file. Exported shape: `file::name` for a module variable,
 *  `file::Owner.name` for a field. Duplicates (two literals under one owner) stay separate rows. */
export function numberKeyedDeclarations(code: string, file: string, aliases: Aliases = NO_ALIASES): { scanned: number; found: Declaration[] } {
  const sf = parseSource(code, file);
  const found: Declaration[] = [];
  let scanned = 0;
  const at = (n: ts.Node) => `${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;

  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const d of st.declarationList.declarations) {
      scanned++;
      if ((d.type && holdsNumberKeyed(d.type, aliases)) || (d.initializer && holdsNumberKeyed(d.initializer, aliases))) {
        found.push({ item: `${file}::${d.name.getText()}`, site: at(d) });
      }
    }
  }
  const walk = (n: ts.Node): void => {
    if (ts.isPropertyDeclaration(n) && !insideFunction(n)) {
      scanned++;
      if ((n.type && holdsNumberKeyed(n.type, aliases)) || (n.initializer && holdsNumberKeyed(n.initializer, aliases))) {
        found.push({ item: `${file}::${ownerName(n.parent)}.${n.name.getText()}`, site: at(n) });
      }
    } else if (ts.isPropertySignature(n) && !insideFunction(n)) {
      scanned++;
      if (n.type && holdsNumberKeyed(n.type, aliases)) {
        found.push({ item: `${file}::${ownerName(n.parent)}.${n.name.getText()}`, site: at(n) });
      }
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return { scanned, found };
}

const isScannedSource = (rel: string): boolean => /\.tsx?$/.test(rel) && !rel.endsWith('.d.ts') && !rel.includes('.test.');

function readSources(under: string, floor: number, keyRelativeTo: string): Array<{ file: string; code: string }> {
  return repoFiles({ under, match: isScannedSource, floor })
    .map(({ rel, abs }) => ({ file: path.posix.relative(keyRelativeTo, rel), code: fs.readFileSync(abs, 'utf8') }));
}

function scan(sources: ReadonlyArray<{ file: string; code: string }>, aliases: Aliases): { scanned: number; found: Declaration[] } {
  let scanned = 0;
  const found: Declaration[] = [];
  for (const { file, code } of sources) {
    const r = numberKeyedDeclarations(code, file, aliases);
    scanned += r.scanned;
    found.push(...r.found);
  }
  return { scanned, found };
}

function runtimeSources(): Array<{ file: string; code: string }> {
  return readSources(RUNTIME, 400, RUNTIME);
}

function scanRuntime(): { scanned: number; found: Declaration[] } {
  const sources = runtimeSources();
  return scan(sources, collectCorpusAliases(sources));
}

/** The widened corpus (#1198): everything outside `runtime/**` that holds entity state. Keys are
 *  REPO-relative, so a row names its tree. Aliases come from runtime plus the source's own scope
 *  (`aliasScopes`) — the editor and every game declare their maps with runtime's aliases.
 *
 *  ⚠️ **Projects are enumerated from the checkout, per PROJECT, not per root.** The OSS snapshot ships
 *  no `games/` and only a curated subset of `demos/`, so a fixed `games/court` root would throw on its
 *  floor there. `discoverProjects` is the single source of which projects this layout carries. */
const ENGINE_ROOTS: ReadonlyArray<{ under: string; floor: number }> = [
  { under: 'engine/packages/modoki/src/editor', floor: 200 },
  { under: 'engine/packages/modoki/src/three', floor: 1 },
  { under: 'engine/app', floor: 50 },
  { under: 'engine/templates/starter', floor: 1 },
];

function widenedRoots(): Array<{ under: string; floor: number }> {
  // `floor: 0` per project: a project directory can legitimately carry no tracked source (a gitignored
  // leftover on one clone), and the declaration floor on the whole scan is what bounds vacuity.
  const projects = discoverProjects(REPO_ROOT).map((pr: { root: string; name: string }) => ({ under: `${pr.root}/${pr.name}`, floor: 0 }));
  return [...ENGINE_ROOTS, ...projects];
}

/** Does this checkout carry the project a ledger row's file lives in? A row under a project the layout
 *  does not ship (every `games/` project and any unpublished demo in the OSS snapshot) is not owed there.
 *
 *  ⚠️ Keyed on the PROJECT directory, never on the file (#1140): a renamed or deleted file inside a
 *  project that IS present must still read its row as stale. Same trade as `corpusProducerIsShared`'s
 *  `demoProjectIsPresent`: a whole project deleted reads as absent-by-layout rather than stale. */
export function rowIsOwedInLayout(item: string, presentProjects: ReadonlySet<string>): boolean {
  const project = /^((?:games|demos)\/[^/]+)\//.exec(item)?.[1];
  return !project || presentProjects.has(project);
}

const projectOf = (file: string): string | undefined => /^((?:games|demos)\/[^/]+)\//.exec(file)?.[1];

/** Group sources into alias SCOPES: the engine side (editor, app, three, starter) is one scope, and each
 *  project is its own. Every scope sees runtime's aliases, because everything imports the runtime.
 *
 *  ⚠️ Not one corpus-wide pool (#1198): Court's `type Placement = ReadonlyMap<number, Piece>` flagged
 *  Sling's and Wordweave's unrelated `interface Placement` fields, because a name lookup across games
 *  cannot tell them apart — and a game cannot import another game's types (#29), so per project is exact. */
export function aliasScopes(sources: ReadonlyArray<{ file: string; code: string }>, runtimeAliases: Aliases):
  Array<{ sources: Array<{ file: string; code: string }>; aliases: Aliases }> {
  const groups = new Map<string, Array<{ file: string; code: string }>>();
  for (const src of sources) {
    const key = projectOf(src.file) ?? '<engine>';
    let g = groups.get(key);
    if (!g) { g = []; groups.set(key, g); }
    g.push(src);
  }
  return [...groups.values()].map((g) => ({ sources: g, aliases: collectCorpusAliases(g, runtimeAliases) }));
}

function scanWidened(): { scanned: number; found: Declaration[] } {
  const widened = widenedRoots().flatMap(({ under, floor }) => readSources(under, floor, ''));
  const runtimeAliases = collectCorpusAliases(runtimeSources());
  let scanned = 0;
  const found: Declaration[] = [];
  for (const scope of aliasScopes(widened, runtimeAliases)) {
    const r = scan(scope.sources, scope.aliases);
    scanned += r.scanned;
    found.push(...r.found);
  }
  return { scanned, found };
}

const LEDGER: ReadonlyArray<{ item: string; reason: string }> = [
  { item: 'animation/deform2DBuffers.ts::deforms',
    reason: 'despawn-evicted: onRemove(EntityAttributes) — every deform target comes from the EntityAttributes index; bound by applyClipDeform and skin2DSystem, so a paused respawn no longer reads the dead deform; pinned by tests/runtime/skin2DIdReuse.test.ts; animation/deform2DBuffers.ts' },
  { item: 'animation/sampleClip.ts::_writes',
    reason: 'scratch: Batch map keyed entityId*stride+traitId, cleared at the top of applyClipAtTime and drained before it returns; never read across calls; animation/sampleClip.ts:73' },
  { item: 'core/bootStash.ts::ACCEPTED_VERSIONS',
    reason: 'not-entity: Accepted boot-stash envelope format versions {1,2}; core/bootStash.ts:63' },
  { item: 'core/ecs/entityIndex.ts::EntityIndex.byId',
    reason: 'per-world-index: Allocated fresh by each buildEntityIndex call from a live EntityAttributes query and used only within the calling pass; no caller keeps an index across frames; core/ecs/entityIndex.ts:38' },
  { item: 'core/ecs/entityIndex.ts::EntityIndex.childrenByParent',
    reason: 'per-world-index: Allocated fresh by each buildEntityIndex call (parentId -> name -> id) and used only within the calling pass; no caller keeps an index across frames; core/ecs/entityIndex.ts:39' },
  { item: 'core/ecs/world.ts::RuntimeAddresses.entityOf',
    reason: 'not-entity: Keyed by a runtime-guid ORDINAL (a per-world spawn counter that is never reused), not an entity id; the value is re-checked with isAlive() on every lookup and the row is deleted by unregisterEntity; the whole table is per-World in a WeakMap; core/ecs/world.ts' },
  { item: 'core/ecs/transformPropagationSystem.ts::worldTransforms',
    reason: 'despawn-evicted: onRemove(Transform), and the eviction forces the next pass past the unchanged short-circuit; cleared on world swap; pinned by tests/runtime/transformPropagationIdReuse.test.ts; core/ecs/transformPropagationSystem.ts' },
  { item: 'core/ecs/transformPropagationSystem.ts::deactivatedEntities',
    reason: 'despawn-evicted: onRemove(EntityAttributes), same forced recompute and world-swap clear as worldTransforms. Children of a destroyed parent keep their cascaded state until that pass (ordinary one-frame cache staleness, not identity); pinned by tests/runtime/transformPropagationIdReuse.test.ts; core/ecs/transformPropagationSystem.ts' },
  { item: 'core/ecs/transformPropagationSystem.ts::_selfInactive',
    reason: 'scratch: Cleared at the top of transformPropagationSystem and read only within that call; core/ecs/transformPropagationSystem.ts:175' },
  { item: 'core/ecs/transformPropagationSystem.ts::_parentIdMap',
    reason: 'scratch: Cleared at the top of transformPropagationSystem and read only within that call; core/ecs/transformPropagationSystem.ts:176' },
  { item: 'core/ecs/transformPropagationSystem.ts::_knownActive',
    reason: 'scratch: Negative memo cleared before the deactivation walk and read only within that call; core/ecs/transformPropagationSystem.ts:257' },
  { item: 'core/ecs/transformPropagationSystem.ts::_deactVisiting',
    reason: 'scratch: Cycle guard cleared before the deactivation walk and read only within that call; core/ecs/transformPropagationSystem.ts:258' },
  { item: 'core/ecs/transformPropagationSystem.ts::_seenWorldIds',
    reason: 'scratch: Seen set cleared before the write loop and consumed by the stale-entry delete at the end of the same call; core/ecs/transformPropagationSystem.ts:333' },
  { item: 'core/ecs/transformPropagationSystem.ts::_byId',
    reason: 'scratch: Cleared and refilled from this pass\'s pooled records before composition, read only within that call; core/ecs/transformPropagationSystem.ts:283' },
  { item: 'core/ecs/transformPropagationSystem.ts::_computed',
    reason: 'scratch: Matrix memo cleared before composition and read only within that call; core/ecs/transformPropagationSystem.ts:288' },
  { item: 'core/ecs/transformPropagationSystem.ts::_visited',
    reason: 'scratch: Recursion guard cleared before composition and read only within that call; core/ecs/transformPropagationSystem.ts:289' },
  { item: 'core/ecs/worldRegistry.ts::entityIndices',
    reason: 'per-world-index: id -> live Entity handle, set by registerEntity on spawn (overwriting a reused index) and deleted by destroyEntity; bare destroy() is lint-banned; core/ecs/world.ts:69' },
  { item: 'core/ecs/worldTransform.ts::_tfById',
    reason: 'scratch: Cleared and refilled by buildTransformMaps at the start of every on-demand accessor call, read only within it; core/ecs/worldTransform.ts:53' },
  { item: 'core/ecs/worldTransform.ts::_parentById',
    reason: 'scratch: Cleared and refilled by buildTransformMaps at the start of every on-demand accessor call, read only within it; core/ecs/worldTransform.ts:54' },
  { item: 'input/pointerRecorder.ts::inFlight',
    reason: 'not-entity: PointerEvent.pointerId -> in-flight press record; input/pointerRecorder.ts:255' },
  { item: 'input/touchControlSource.ts::presses',
    reason: 'not-entity: PointerEvent.pointerId -> active touch-control press; input/touchControlSource.ts:155' },
  { item: 'loaders/gpuMemoryReport.ts::seenTextureUidsEver',
    reason: 'not-entity: Pixi texture-source uids ever observed live (churn tally); loaders/gpuMemoryReport.ts:444' },
  { item: 'loaders/gpuMemoryReport.ts::previousLiveTextureUids',
    reason: 'not-entity: Previous sample\'s live Pixi texture-source uid set; loaders/gpuMemoryReport.ts:451' },
  { item: 'loaders/gpuMemoryReport.ts::previousLiveGeometryUids',
    reason: 'not-entity: Previous sample\'s live Pixi geometry uid set; loaders/gpuMemoryReport.ts:397' },
  { item: 'managers/NavigationManager.ts::NavigationManagerImpl.claims',
    reason: 'not-entity: Per-navigation-call claim id (claimSeq) -> {path, suppress}; managers/NavigationManager.ts:132' },
  { item: 'particles/cpuTslBackend.ts::CpuTslBackend.entries',
    reason: 'not-entity: Backend-minted monotonic particle handle id (nextId++); particles/cpuTslBackend.ts:120' },
  { item: 'particles/gpuComputeBackend.ts::GpuComputeBackend.entries',
    reason: 'not-entity: Backend-minted monotonic particle handle id (nextId++); particles/gpuComputeBackend.ts:413' },
  { item: 'particles/particleBackend.ts::RouterParticleBackend.entries',
    reason: 'not-entity: Router-minted monotonic particle handle id (nextId++); particles/particleBackend.ts:73' },
  { item: 'particles/pixiParticleBackend.ts::PixiParticleBackend.entries',
    reason: 'not-entity: Backend-minted monotonic 2D particle handle id (nextId++); particles/pixiParticleBackend.ts:148' },
  { item: 'physics/physics2DSystem.ts::_childScratch',
    reason: 'scratch: Compound-children buckets by parent id, cleared by collectCompoundChildren and consumed within the same physics tick; physics/physics2DSystem.ts:881' },
  { item: 'physics/physics2DSystem.ts::_seenBodies',
    reason: 'scratch: Seen set cleared before body reconcile and consumed by the cleanup sweep in the same tick; physics/physics2DSystem.ts:926' },
  { item: 'physics/physics2DSystem.ts::_seenSolo',
    reason: 'scratch: Seen set cleared before solo-collider reconcile and consumed by its cleanup in the same tick; physics/physics2DSystem.ts:986' },
  { item: 'physics/physics2DSystem.ts::_seenJoints',
    reason: 'scratch: Seen set cleared at the top of reconcileJoints and consumed by its cleanup in the same call; physics/physics2DSystem.ts:635' },
  { item: 'physics/physics2DSystem.ts::PhysicsWorldState.bodies',
    reason: 'gen-in-value: BodyRec.entityGen is checked by the reconcile (rebuild on mismatch) AND by bodyFor2D/bodyAndPpm2D, the by-entity control helpers (#868), pinned by physics2DControl.test.ts. Residual, accepted: raycast opts.exclude is a caller-supplied bare id with no generation, so before the reconcile it excludes the dead body on that index (physics2DSystem.ts:1159); physics/physics2DSystem.ts:1249' },
  { item: 'physics/physics2DSystem.ts::PhysicsWorldState.soloColliders',
    reason: 'gen-in-value: SoloColliderRec.entityGen is compared at reconcile (the only reader) and the collider rebuilt on mismatch; physics/physics2DSystem.ts:995' },
  { item: 'physics/physics2DSystem.ts::PhysicsWorldState.colliders',
    reason: 'not-entity: Rapier collider handle -> owning entity info; physics/physics2DSystem.ts:391' },
  { item: 'physics/physics2DSystem.ts::PhysicsWorldState.joints',
    reason: 'gen-in-value: JointRec.entityGen is compared at reconcile (the only reader) and the joint rebuilt on mismatch; physics/physics2DSystem.ts:659' },
  { item: 'physics/physics3DSystem.ts::_seenBodies',
    reason: 'scratch: Seen set cleared before body reconcile and consumed by the cleanup sweep in the same tick; physics/physics3DSystem.ts:886' },
  { item: 'physics/physics3DSystem.ts::_seenSolo',
    reason: 'scratch: Seen set cleared before solo-collider reconcile and consumed by its cleanup in the same tick; physics/physics3DSystem.ts:947' },
  { item: 'physics/physics3DSystem.ts::_seenJoints',
    reason: 'scratch: Seen set cleared at the top of joint reconcile and consumed by its cleanup in the same call; physics/physics3DSystem.ts:723' },
  { item: 'physics/physics3DSystem.ts::_childScratch',
    reason: 'scratch: Compound-children buckets by parent id, cleared by collectCompoundChildren and consumed within the same physics tick; physics/physics3DSystem.ts:843' },
  { item: 'physics/physics3DSystem.ts::PhysicsWorldState3D.bodies',
    reason: 'gen-in-value: BodyRec.entityGen is checked by the reconcile (rebuild on mismatch) AND by bodyFor/bodyAndUpm, the by-entity control helpers (#868), pinned by physics3DControl.test.ts. Residual, accepted: raycast opts.exclude is a caller-supplied bare id with no generation (physics3DSystem.ts:1161); physics/physics3DSystem.ts:1248' },
  { item: 'physics/physics3DSystem.ts::PhysicsWorldState3D.soloColliders',
    reason: 'gen-in-value: SoloColliderRec.entityGen is compared at reconcile (the only reader) and the collider rebuilt on mismatch; physics/physics3DSystem.ts:956' },
  { item: 'physics/physics3DSystem.ts::PhysicsWorldState3D.colliders',
    reason: 'not-entity: Rapier collider handle -> owning entity info; physics/physics3DSystem.ts:479' },
  { item: 'physics/physics3DSystem.ts::PhysicsWorldState3D.joints',
    reason: 'gen-in-value: JointRec3D.entityGen is compared at reconcile (the only reader) and the joint rebuilt on mismatch; physics/physics3DSystem.ts:745' },
  { item: 'physics/physicsContactIndex.ts::index',
    reason: 'gen-in-value: each body entry carries the packed entity it was recorded for, and getContactState returns nothing for one no longer alive (#868), pinned by physicsContactIndex.test.ts; physics/physicsContactIndex.ts:129' },
  { item: 'physics/physicsContactIndex.ts::BodyContacts.contacts',
    reason: 'gen-in-value: each partner count carries the partner\'s packed entity, and livePartners drops one no longer alive before the Percept fold resolves it to a GUID (#868); physics/physicsContactIndex.ts:121' },
  { item: 'physics/physicsContactIndex.ts::BodyContacts.overlaps',
    reason: 'gen-in-value: same stamp and live filter as BodyContacts.contacts (#868); physics/physicsContactIndex.ts:121' },
  { item: 'rendering/Scene2D.tsx::Scene2DRenderer.slots',
    reason: 'gen-in-value: display state is re-compared from the live entity each pass (snapshot gates); the two pieces a build or a clock SEEDS carry the packed owner on the slot — matGen for material uniforms (#873) and animOwner for the text-animation clock (textAnimElapsed, #868); rendering/Scene2D.tsx:2616' },
  { item: 'rendering/Scene2D.tsx::Scene2DRenderer.entityShaders',
    reason: 'gen-in-value: Value {shader, gen} re-stamped whenever the entity renders as a material; the broker returns an entry only when gen matches; rendering/sprite2DMaterialBroker.ts:125' },
  { item: 'rendering/Scene2D.tsx::Scene2DRenderer._materialIdsScratch',
    reason: 'scratch: Cleared before the material pass and consumed by the entityShaders/lastMaterialRender purge at the end of that pass; rendering/Scene2D.tsx:1930' },
  { item: 'rendering/Scene2D.tsx::Scene2DRenderer.activeIds',
    reason: 'gen-in-value: the value is the packed entity that claimed the id this pass; the slot-disposal sweep reads only its keys, and bounds2DProvider, which reads it between passes, refuses an owner no longer alive (#1197); rendering/Scene2D.tsx:2820' },
  { item: 'rendering/Scene2D.tsx::Scene2DRenderer.prevCanvasIds',
    reason: 'revalidated: Last pass\'s canvas ids; a same-index Canvas2D respawn keeps its pool slot, whose entity-derived scale/offset is rewritten from the live Canvas2D every pass; rendering/Scene2D.tsx:1683' },
  { item: 'rendering/Scene2D.tsx::Scene2DRenderer.currentCanvasIds',
    reason: 'scratch: Cleared at the top of renderFrame, filled by the Canvas2D query, copied into prevCanvasIds at pass end; rendering/Scene2D.tsx:1568' },
  { item: 'rendering/Scene2D.tsx::Scene2DRenderer.lastRender',
    reason: 'revalidated: Change-gate snapshot: every field is compared against values recomputed from the live entity this pass, so an identical respawn is indistinguishable from a live edit; rendering/Scene2D.tsx:1835' },
  { item: 'rendering/Scene2D.tsx::Scene2DRenderer.lastMeshRender',
    reason: 'revalidated: Change-gate snapshot: every field (incl. skin deform version) is compared against values recomputed from the live entity this pass; rendering/Scene2D.tsx:2310' },
  { item: 'rendering/Scene2D.tsx::Scene2DRenderer.lastTextRender',
    reason: 'revalidated: Change-gate snapshot: layout/style hashes and placement are compared against values recomputed from the live entity this pass; rendering/Scene2D.tsx:2655' },
  { item: 'rendering/Scene2D.tsx::Scene2DRenderer.lastMaterialRender',
    reason: 'revalidated: Change-gate snapshot compared against live values, and the dirty read is generation-checked (isEntity2DMaterialDirty(id, gen)); rendering/Scene2D.tsx:2181' },
  { item: 'rendering/Scene2D.tsx::Scene2DRenderer.lastCanvasScale',
    reason: 'revalidated: Per-canvas scaler snapshot compared against the scale recomputed from the live Canvas2D each pass; rendering/Scene2D.tsx:1690' },
  { item: 'rendering/Scene2D.tsx::Scene2DRenderer.dirtyCanvases',
    reason: 'scratch: Canvas ids to GPU-render: cleared at the top of renderFrame and consumed by renderAll at the end of the pass; rendering/Scene2D.tsx:1569' },
  { item: 'rendering/Scene2D.tsx::Scene2DRenderer.parentOfEntity',
    reason: 'scratch: Cleared and refilled from the EntityAttributes query at the top of renderFrame; read only by in-pass routing; rendering/Scene2D.tsx:1563' },
  { item: 'rendering/Scene2D.tsx::Scene2DRenderer.sortOrderOfEntity',
    reason: 'scratch: Cleared and refilled from the EntityAttributes query at the top of renderFrame; read only in-pass; rendering/Scene2D.tsx:1564' },
  { item: 'rendering/Scene2D.tsx::Scene2DRenderer.liveEntities',
    reason: 'scratch: Packed entities, cleared and refilled at the top of renderFrame; consumed by orphan2D.prune in the same pass; rendering/Scene2D.tsx:1570' },
  { item: 'rendering/Scene2D.tsx::Scene2DRenderer.paintOrderOf',
    reason: 'scratch: Reassigned from computePaintOrder every pass before any read; read only in-pass; rendering/Scene2D.tsx:1609' },
  { item: 'rendering/Scene2D.tsx::Scene2DRenderer.groupAlphaOf',
    reason: 'scratch: Reassigned from computeGroupAlpha every pass before any read; read only in-pass (incl. particle ctx); rendering/Scene2D.tsx:1617' },
  { item: 'rendering/Scene2D.tsx::Scene2DRenderer.maskGroupOf',
    reason: 'revalidated: Previous pass\'s grouping is compared with the grouping recomputed from the live hierarchy (a difference forces a full redraw), then replaced; rendering/Scene2D.tsx:1652' },
  { item: 'rendering/Scene2D.tsx::Scene2DRenderer.parentMaskOf',
    reason: 'scratch: Reassigned from computeMaskGroups before syncMaskSlots reads it; read only in-pass; rendering/Scene2D.tsx:1654' },
  { item: 'rendering/Scene2D.tsx::Scene2DRenderer.maskSlots',
    reason: 'revalidated: Mask slot rebuilt when its shape sig (recomputed from live Mask2D data) changes; placement/z/parent are rewritten every pass; rendering/Scene2D.tsx:1178' },
  { item: 'rendering/Scene2D.tsx::Scene2DRenderer.activeMaskIds',
    reason: 'scratch: Cleared at the top of renderFrame and consumed by the mask-slot sweep at the end of the pass; rendering/Scene2D.tsx:1562' },
  { item: 'rendering/Scene2D.tsx::Scene2DRenderer.canvasOfEntity',
    reason: 'per-world-index: Ancestor-canvas cache cleared each pass; its one post-pass reader (bounds2DProvider) pairs it with slots from the same pass; rendering/Scene2D.tsx:1565' },
  { item: 'rendering/Scene2D.tsx::Scene2DRenderer.canvasEntityIds',
    reason: 'scratch: Canvas2D id set cleared at the top of renderFrame and read only by in-pass routing; rendering/Scene2D.tsx:1566' },
  { item: 'rendering/Scene2D.tsx::Scene2DRenderer.canvasCompensate',
    reason: 'scratch: Per-canvas compensation cleared at the top of renderFrame and read only in-pass; rendering/Scene2D.tsx:1567' },
  { item: 'rendering/Scene2D.tsx::Scene2DRenderer.colliderOverlays',
    reason: 'revalidated: Per-canvas overlay Graphics is cleared and redrawn from the live Collider2D query every pass it is enabled; rendering/Scene2D.tsx:1488' },
  { item: 'rendering/autoLightCapFrame.ts::authoredCache',
    reason: 'not-entity: Authored renderable rendering-layer mask -> cached light bits for this pass; rendering/autoLightCapFrame.ts:227' },
  { item: 'rendering/autoLightCapFrame.ts::SurfaceMemory.previousGlobalMaskByBucket',
    reason: 'not-entity: Authored light bucket bits -> previous global mask (hysteresis); rendering/autoLightCapFrame.ts:236' },
  { item: 'rendering/blobShadowSync.ts::BlobShadowSyncState.recs',
    reason: 'revalidated: Blob mesh carries no per-entity build state; visibility, pose, scale, opacity and edge are rewritten from the live entity every pass; rendering/blobShadowSync.ts:236' },
  { item: 'rendering/canvas2DPool.ts::deadRendererUids',
    reason: 'not-entity: Pixi renderer uids of destroyed renderers; rendering/canvas2DPool.ts:429' },
  { item: 'rendering/canvas2DPool.ts::Canvas2DPool.entityMap',
    reason: 'revalidated: Canvas id -> GPU surface slot; everything entity-derived on it (container scale/offset) is rewritten from the live Canvas2D each pass; rendering/Scene2D.tsx:1683' },
  { item: 'rendering/canvas2DRouting.ts::Orphan2DTracker.frames',
    reason: 'packed-key: Scene2D passes entity.valueOf() to note/clear and prunes against the frame\'s live PACKED set, so a same-index respawn between two frames starts its own count; a guid-less fallback key is released through its recorded packed owner (#868); pinned by tests/runtime/Scene2D.test.ts; rendering/canvas2DRouting.ts' },
  { item: 'rendering/flameMeshSync.ts::_coneGeos',
    reason: 'not-entity: Radial segment count -> shared lathe geometry; rendering/flameMeshSync.ts:81' },
  { item: 'rendering/flameMeshSync.ts::FlameMeshSyncState.recs',
    reason: 'revalidated: additive/segments compared to the live trait and rebuilt in place; uniforms, transform, scale and layers rewritten every pass; the rec carries the packed owner re-stamped every visit, which the SceneView picker checks between passes (#1197); rendering/flameMeshSync.ts:194' },
  { item: 'rendering/maskGroups.ts::MaskGrouping.groupOf',
    reason: 'per-world-index: Freshly allocated by computeMaskGroups from the live hierarchy per call; the cross-frame holder is Scene2DRenderer.maskGroupOf; rendering/maskGroups.ts:40' },
  { item: 'rendering/maskGroups.ts::MaskGrouping.parentMaskOf',
    reason: 'per-world-index: Freshly allocated by computeMaskGroups from the live hierarchy per call; the holder Scene2DRenderer.parentMaskOf is reassigned before use; rendering/maskGroups.ts:41' },
  { item: 'rendering/materialInstanceSystem.ts::_defaultBaseCache',
    reason: 'gen-in-value: Entry stores the entity generation; resolvePropBase uses the cached base only when it matches and re-reads the mesh otherwise; rendering/materialInstanceSystem.ts:197' },
  { item: 'rendering/particle2DRouting.ts::Canvas2DRoute.parentOf',
    reason: 'scratch: Cleared and refilled by buildCanvas2DRoute at the start of syncParticles and read only within that call; rendering/particle2DRouting.ts:28' },
  { item: 'rendering/particle2DRouting.ts::Canvas2DRoute.canvasIds',
    reason: 'scratch: Cleared and refilled by buildCanvas2DRoute at the start of syncParticles and read only within that call; rendering/particle2DRouting.ts:29' },
  { item: 'rendering/scene3DSync.ts::_activeLightIds',
    reason: 'scratch: Cleared at the top of syncLights and consumed by its removal sweep in the same call; rendering/scene3DSync.ts:1095' },
  { item: 'rendering/scene3DSync.ts::_activeRenderIds',
    reason: 'scratch: Cleared at the top of syncRenderables and consumed by its removal sweep in the same call; rendering/scene3DSync.ts:2856' },
  { item: 'rendering/scene3DSync.ts::_activeSkinnedIds',
    reason: 'scratch: Cleared at the top of syncSkinnedModels and consumed by its reap and mixer loop in the same call; rendering/scene3DSync.ts:2265' },
  { item: 'rendering/scene3DSync.ts::_boneParentMap',
    reason: 'scratch: Cleared and refilled at the top of syncBones, read by the bone walks within that call; rendering/scene3DSync.ts:2731' },
  { item: 'rendering/scene3DSync.ts::_boneIds',
    reason: 'scratch: Cleared and refilled in syncBones, read by isUnderBone within that call; rendering/scene3DSync.ts:2742' },
  { item: 'rendering/scene3DSync.ts::_boneAffected',
    reason: 'scratch: Cleared then filled and consumed inside the same syncBones re-propagation block; rendering/scene3DSync.ts:2840' },
  { item: 'rendering/scene3DSync.ts::_billboardActive',
    reason: 'scratch: Cleared at the top of syncBillboardSprites and consumed by its sweep in the same call; rendering/scene3DSync.ts:3393' },
  { item: 'rendering/scene3DSync.ts::_activeText',
    reason: 'scratch: Cleared at the top of syncText3D and consumed by its sweep in the same call; rendering/scene3DSync.ts:3617' },
  { item: 'rendering/scene3DSync.ts::RenderState.ecsObjects',
    reason: 'owner-checked: the kept THREE object is re-compared against the live entity each pass, and ownedEcsObject evicts it through removeEcsObject when RenderState.ecsOwners names a different packed entity, so userData overrides and bound clones cannot reach a newcomer (#868); rendering/scene3DSync.ts:3170' },
  { item: 'rendering/scene3DSync.ts::RenderState.ecsOwners',
    reason: 'gen-in-value: the packed entity each ecsObjects entry was built for, stamped at every ecsObjects.set and removed with it by removeEcsObject; pinned by syncSceneRenderables3D + skinnedShadowFlags tests (#868); rendering/scene3DSync.ts:1348' },
  { item: 'rendering/scene3DSync.ts::RenderState.ecsSprites',
    reason: 'revalidated: Mesh-ref mirror compared against the live Renderable3D/Primitive mesh every pass, rebuilding on mismatch; rendering/scene3DSync.ts:2992' },
  { item: 'rendering/scene3DSync.ts::RenderState.ecsMaterials',
    reason: 'revalidated: Material-ref mirror compared against the live ref every pass by syncMaterial, rebinding on mismatch; rendering/scene3DSync.ts:1614' },
  { item: 'rendering/scene3DSync.ts::RenderState.ecsColors',
    reason: 'revalidated: Colour mirror compared against the live Renderable3DPrimitive.color every pass; rendering/scene3DSync.ts:3110' },
  { item: 'rendering/scene3DSync.ts::RenderState.ecsSizes',
    reason: 'revalidated: Size mirror compared against the live primitive size every pass, rebuilding the mesh on mismatch; rendering/scene3DSync.ts:2991' },
  { item: 'rendering/scene3DSync.ts::RenderState.ecsShadowFlags',
    reason: 'revalidated: Shadow-key mirror compared against the live cast/receive fields every pass; rendering/scene3DSync.ts:2940' },
  { item: 'rendering/scene3DSync.ts::RenderState.skinnedShadowFlags',
    reason: 'revalidated: Mirrors the flags applied to the kept skinned root, compared to live fields every pass and deleted with that entry; its hazard belongs to the skinned row; rendering/scene3DSync.ts:2368' },
  { item: 'rendering/scene3DSync.ts::RenderState.ownsGeometry',
    reason: 'revalidated: Marks that the kept object\'s geometry is engine-owned; describes the object, and is deleted with it on every rebuild/sweep; rendering/scene3DSync.ts:3036' },
  { item: 'rendering/scene3DSync.ts::RenderState.billboards',
    reason: 'revalidated: Rig ref and topology sig compared against the live buffer (rebuild); tint/opacity/visibility/flip/deform version/transform rewritten every pass; rendering/scene3DSync.ts:3329' },
  { item: 'rendering/scene3DSync.ts::RenderState.textMeshes',
    reason: 'gen-in-value: the mesh is rebuilt on a layout/style signature change recomputed each pass; the one time-accumulated piece, the text-animation clock, carries its packed owner (animOwner via textAnimElapsed, #868); rendering/scene3DSync.ts:3796' },
  { item: 'rendering/scene3DSync.ts::TextMeshEntry.pages',
    reason: 'not-entity: Font atlas page number -> page mesh; rendering/scene3DSync.ts:3756' },
  { item: 'rendering/shadowCasterCapFrame.ts::kept',
    reason: 'scratch: Reassigned at the top of every syncLights and read only by shadowCasterAllowed in that call\'s light loop; rendering/shadowCasterCapFrame.ts:49' },
  { item: 'rendering/sprite2DMaterialBroker.ts::shaderMaps',
    reason: 'not-entity: Set of registered per-renderer maps (members are Map objects); their entries are gen-checked on read; rendering/sprite2DMaterialBroker.ts:49' },
  { item: 'rendering/sprite2DMaterialBroker.ts::dirtyEntities',
    reason: 'gen-in-value: Stores the marking entity\'s generation; isEntity2DMaterialDirty returns true only when it matches the reader\'s; rendering/sprite2DMaterialBroker.ts:70' },
  { item: 'rendering/text/atlasAllocator.ts::AtlasAllocator.slots',
    reason: 'not-entity: Glyph codepoint -> atlas cell slot; rendering/text/atlasAllocator.ts:106' },
  { item: 'rendering/text/dynamicFontProvider.ts::DynamicFontProvider.glyphMap',
    reason: 'not-entity: Glyph codepoint -> glyph; rendering/text/dynamicFontProvider.ts:205' },
  { item: 'rendering/text/dynamicFontProvider.ts::DynamicFontProvider.kern',
    reason: 'not-entity: Packed codepoint pair -> kerning advance; rendering/text/dynamicFontProvider.ts:206' },
  { item: 'rendering/text/dynamicFontProvider.ts::DynamicFontProvider.requested',
    reason: 'not-entity: Codepoints already requested for generation; rendering/text/dynamicFontProvider.ts:228' },
  { item: 'rendering/text/dynamicFontProvider.ts::DynamicFontProvider.pending',
    reason: 'not-entity: Codepoints queued for the next generation batch; rendering/text/dynamicFontProvider.ts:229' },
  { item: 'rendering/text/dynamicFontProvider.ts::DynamicFontProvider.retryBatch',
    reason: 'not-entity: Codepoints awaiting a flush retry; rendering/text/dynamicFontProvider.ts:247' },
  { item: 'rendering/text/glyphAtlas.ts::GlyphAtlas.glyphs',
    reason: 'not-entity: Unicode codepoint -> glyph; rendering/text/glyphAtlas.ts:66' },
  { item: 'rendering/text/glyphAtlas.ts::GlyphAtlas.kerning',
    reason: 'not-entity: Packed codepoint pair (kerningKey) -> advance; rendering/text/glyphAtlas.ts:68' },
  { item: 'rendering/videoTextureSync.ts::bindings',
    reason: 'revalidated: Binding kept only while its element still equals videoElementFor(id) (owner-checked in videoSystem) and its clone is on the mesh; else rebound; rendering/videoTextureSync.ts:212' },
  { item: 'rendering/videoTextureSync2D.ts::SurfaceState.table',
    reason: 'revalidated: Binding kept only while both element and Sprite identity still match the live lookups this pass; otherwise detached and rebound; rendering/videoTextureSync2D.ts:209' },
  { item: 'skinning/skin2DBuffers.ts::buffers',
    reason: 'despawn-evicted: onRemove(SkinnedSprite2D) bound by skin2DSystem, which rebuilds on a missing buffer (needBuild = !buf); pinned by tests/runtime/skin2DIdReuse.test.ts; skinning/skin2DSystem.ts' },
  { item: 'skinning/skin2DSystem.ts::lastRigKeyByEntity',
    reason: 'revalidated: Compared to the live SkinnedSprite2D.rig each pass, rebuilding the buffer on mismatch; pinned by tests/runtime/skin2DIdReuse.test.ts; skinning/skin2DSystem.ts:185' },
  { item: 'skinning/skin2DSystem.ts::lastSkinMatsByEntity',
    reason: 'revalidated: Compared to skin matrices recomputed from live bones this pass (idle skip only on equality); pinned by tests/runtime/skin2DIdReuse.test.ts; skinning/skin2DSystem.ts:226' },
  { item: 'skinning/skin2DSystem.ts::lastDeformVerByEntity',
    reason: 'revalidated: Compared to the deform version read this pass (idle skip only on equality); pinned by tests/runtime/skin2DIdReuse.test.ts; skinning/skin2DSystem.ts:226' },
  { item: 'skinning/skin2DSystem.ts::lastRigObjByEntity',
    reason: 'revalidated: Compared to the parsed rig object resolved this pass, forcing a rebuild on change; pinned by tests/runtime/skin2DIdReuse.test.ts; skinning/skin2DSystem.ts:181' },
  { item: 'skinning/skin2DSystem.ts::lastBuildUnresolvedByEntity',
    reason: 'revalidated: Unresolved-sprite count of the last build of the SAME rig (rig change rebuilds anyway); retry decision recomputed this pass; skinning/skin2DSystem.ts:190' },
  { item: 'skinning/skin2DSystem.ts::trackedRootIds',
    reason: 'revalidated: Last pass\'s root ids, used only to delete buffers of vanished roots; a kept same-index root is revalidated by the rig/pose compares; skinning/skin2DSystem.ts:257' },
  { item: 'skinning/skin2DSystem.ts::_parentOf',
    reason: 'scratch: Cleared and refilled from the EntityAttributes query at the top of skin2DSystem, read only in that call; skinning/skin2DSystem.ts:108' },
  { item: 'skinning/skin2DSystem.ts::_boneById',
    reason: 'scratch: Cleared and refilled from the Bone2D query at the top of skin2DSystem, read only in that call; skinning/skin2DSystem.ts:114' },
  { item: 'skinning/skin2DSystem.ts::_seen',
    reason: 'scratch: Cycle guard cleared before each bone traversal, read only within it; skinning/skin2DSystem.ts:169' },
  { item: 'timeline/timelineSystem.ts::_EMPTY_SLAVED',
    reason: 'scratch: Immutable empty result of collectSlavedDirectors (never written); the non-empty result is allocated per call and used in that timelineSystem pass; timeline/timelineSystem.ts:789' },
  { item: 'ui/uiTreeStore.ts::_nodes',
    reason: 'scratch: Cleared at the start of each tree build and read only within that build; ui/uiTreeStore.ts:387' },
  { item: 'ui/uiTreeStore.ts::_parentMap',
    reason: 'scratch: Cleared at the start of each tree build and read only within that build; ui/uiTreeStore.ts:388' },
  { item: 'ui/uiTreeStore.ts::_sortMap',
    reason: 'scratch: Cleared at the start of each tree build and read only within that build; ui/uiTreeStore.ts:389' },
  { item: 'ui/uiTreeStore.ts::_prevById',
    reason: 'revalidated: Previous node object reused only when nodesEqual matches every field of the node rebuilt from the live entity; ui/uiTreeStore.ts:301' },
  { item: 'video/UIVideoMount.tsx::claims',
    reason: 'revalidated: Multiset of mounted host priorities, added and dropped by each host\'s own effect; every host re-polls videoElementFor each frame; video/UIVideoMount.tsx:104' },
  { item: 'video/videoSystem.ts::live',
    reason: 'gen-in-value: the reconcile forgets on an owner mismatch, and the by-id readers (videoElementFor/seekEntityVideo/claimVideoEndEmit) go through ownedLive, which requires the owner alive (#868); video/videoSystem.ts:161' },
  { item: 'video/videoSystem.ts::pending',
    reason: 'owner-checked: Read only inside the reconcile after the owner check forgets a reused id (an ABSENT owner stamp forgets too, so the owner map cannot be the shorter lifetime); the async download is cancelled by forget; video/videoSystem.ts:228' },
  { item: 'video/videoSystem.ts::progress',
    reason: 'owner-checked: Read only inside the reconcile after the owner check forgets a reused id (an ABSENT owner stamp forgets too, so the owner map cannot be the shorter lifetime); async writes are guarded by rec.cancelled; video/videoSystem.ts:228' },
  { item: 'video/videoSystem.ts::readyUrls',
    reason: 'owner-checked: Read only inside the reconcile after the owner check forgets a reused id (an ABSENT owner stamp forgets too, so the owner map cannot be the shorter lifetime); async writes are guarded by rec.cancelled; video/videoSystem.ts:228' },
  { item: 'video/videoSystem.ts::failed',
    reason: 'owner-checked: Sticky failure read only inside the reconcile after the owner check forgets a reused id (an ABSENT owner stamp forgets too, so the owner map cannot be the shorter lifetime); video/videoSystem.ts:228' },
  { item: 'video/videoSystem.ts::owner',
    reason: 'gen-in-value: Stores each id\'s owning packed entity; a mismatch runs forget(id) before any other map is read; video/videoSystem.ts:228' },
  { item: 'loaders/audioBufferCache.ts::audioOwners',
    reason: 'not-entity: asset key → Set of owning SceneIds (`type SceneId = number`), the per-scene refcount; loaders/audioBufferCache.ts:29' },
  { item: 'loaders/fontAtlasLoader.ts::owners',
    reason: 'not-entity: asset key → Set of owning SceneIds (`type SceneId = number`), the per-scene refcount; loaders/fontAtlasLoader.ts:30' },
  { item: 'loaders/loadSceneFile.ts::AddedEntity.overrides',
    reason: 'not-entity: keyed by a prefab member\'s serialized localId (the prefab file\'s own id space), not a runtime entity id; loaders/loadSceneFile.ts:46' },
  { item: 'loaders/loadSceneFile.ts::AddedEntity.removedTraits',
    reason: 'not-entity: keyed by a prefab member\'s serialized localId (the prefab file\'s own id space), not a runtime entity id; loaders/loadSceneFile.ts:53' },
  { item: 'loaders/loadSceneFile.ts::AddedEntity.nestedOverrides',
    reason: 'not-entity: keyed by a prefab member\'s serialized localId (the prefab file\'s own id space), not a runtime entity id; loaders/loadSceneFile.ts:55' },
  { item: 'loaders/loadSceneFile.ts::SceneEntityEntry.overrides',
    reason: 'not-entity: keyed by a prefab member\'s serialized localId (the prefab file\'s own id space), not a runtime entity id; loaders/loadSceneFile.ts:69' },
  { item: 'loaders/loadSceneFile.ts::SceneEntityEntry.removedTraits',
    reason: 'not-entity: keyed by a prefab member\'s serialized localId (the prefab file\'s own id space), not a runtime entity id; loaders/loadSceneFile.ts:75' },
  { item: 'loaders/loadSceneFile.ts::SceneEntityEntry.nestedOverrides',
    reason: 'not-entity: keyed by a prefab member\'s serialized localId (the prefab file\'s own id space), not a runtime entity id; loaders/loadSceneFile.ts:79' },
  { item: 'loaders/loadSceneFile.ts::InstanceStructureData.removedTraits',
    reason: 'not-entity: keyed by a prefab member\'s serialized localId (the prefab file\'s own id space), not a runtime entity id; loaders/loadSceneFile.ts:499' },
  { item: 'loaders/loadSceneFile.ts::PrefabFileEntry{}.overrides',
    reason: 'not-entity: keyed by a prefab member\'s serialized localId (the prefab file\'s own id space), not a runtime entity id; loaders/loadSceneFile.ts:741' },
  { item: 'loaders/loadSceneFile.ts::PrefabFileEntry{}.removedTraits',
    reason: 'not-entity: keyed by a prefab member\'s serialized localId (the prefab file\'s own id space), not a runtime entity id; loaders/loadSceneFile.ts:744' },
  { item: 'loaders/loadSceneFile.ts::PrefabFileEntry{}.nestedOverrides',
    reason: 'not-entity: keyed by a prefab member\'s serialized localId (the prefab file\'s own id space), not a runtime entity id; loaders/loadSceneFile.ts:747' },
  { item: 'loaders/meshTemplateCache.ts::modelOwners',
    reason: 'not-entity: asset key → Set of owning SceneIds (`type SceneId = number`), the per-scene refcount; loaders/meshTemplateCache.ts:1684' },
  { item: 'loaders/meshTemplateCache.ts::meshAssetOwners',
    reason: 'not-entity: asset key → Set of owning SceneIds (`type SceneId = number`), the per-scene refcount; loaders/meshTemplateCache.ts:1685' },
  { item: 'loaders/meshTemplateCache.ts::materialOwners',
    reason: 'not-entity: asset key → Set of owning SceneIds (`type SceneId = number`), the per-scene refcount; loaders/meshTemplateCache.ts:1686' },
  { item: 'loaders/meshTemplateCache.ts::prefabOwners',
    reason: 'not-entity: asset key → Set of owning SceneIds (`type SceneId = number`), the per-scene refcount; loaders/meshTemplateCache.ts:1687' },
  { item: 'loaders/meshTemplateCache.ts::envOwners',
    reason: 'not-entity: asset key → Set of owning SceneIds (`type SceneId = number`), the per-scene refcount; loaders/meshTemplateCache.ts:1982' },
  { item: 'loaders/prefabOverrides.ts::EffectiveMemberOptions.overrides',
    reason: 'not-entity: keyed by a prefab member\'s serialized localId (the prefab file\'s own id space), not a runtime entity id; loaders/prefabOverrides.ts:138' },
  { item: 'loaders/prefabOverrides.ts::EffectiveMemberOptions.nestedOverrides',
    reason: 'not-entity: keyed by a prefab member\'s serialized localId (the prefab file\'s own id space), not a runtime entity id; loaders/prefabOverrides.ts:140' },
  { item: 'loaders/prefabOverrides.ts::EffectiveMemberOptions.removedTraits',
    reason: 'not-entity: keyed by a prefab member\'s serialized localId (the prefab file\'s own id space), not a runtime entity id; loaders/prefabOverrides.ts:142' },
  { item: 'loaders/riggedModelCache.ts::owners',
    reason: 'not-entity: asset key → Set of owning SceneIds (`type SceneId = number`), the per-scene refcount; loaders/riggedModelCache.ts:64' },
  { item: 'loaders/uiAnchorZIndexMigration.ts::MigratableEntry.overrides',
    reason: 'not-entity: keyed by a prefab member\'s serialized localId (the prefab file\'s own id space), not a runtime entity id; loaders/uiAnchorZIndexMigration.ts:52' },
  { item: 'loaders/uiAnchorZIndexMigration.ts::MigratableEntry.nestedOverrides',
    reason: 'not-entity: keyed by a prefab member\'s serialized localId (the prefab file\'s own id space), not a runtime entity id; loaders/uiAnchorZIndexMigration.ts:53' },
  { item: 'scene/SceneManager.ts::SceneManagerImpl.loadedScenes',
    reason: 'not-entity: SceneId → loaded scene entry; scene/SceneManager.ts:274' },
  { item: 'scene/sceneMutate.ts::MutableEntity.overrides',
    reason: 'not-entity: keyed by a prefab member\'s serialized localId (the prefab file\'s own id space), not a runtime entity id; scene/sceneMutate.ts:23' },
];

/** Rows for the widened corpus (#1198), keyed `repo/relative/file::Owner.name`. Same tags as LEDGER. */
const WIDENED_LEDGER: ReadonlyArray<{ item: string; reason: string }> = [
  { item: 'engine/packages/modoki/src/editor/panels/assetViews/VideoAssetView.tsx::QUALITY_LABELS',
    reason: 'not-entity: ffmpeg CRF value -> label; editor/panels/assetViews/VideoAssetView.tsx:48' },
  ...['PrefabEntity.overrides', 'PrefabEntity.removedTraits', 'PrefabEntity.nestedOverrides'].map((f) => ({
    item: `engine/packages/modoki/src/editor/scene/prefab.ts::${f}`,
    reason: 'not-entity: keyed by a prefab member\'s serialized localId (the prefab file\'s own id space), not a runtime entity id — the editor twin of loaders/loadSceneFile.ts PrefabFileEntry{}; editor/scene/prefab.ts:42' })),
  ...['SerializedEntity.overrides', 'SerializedEntity.removedTraits', 'SerializedEntity.nestedOverrides'].map((f) => ({
    item: `engine/packages/modoki/src/editor/scene/serialize.ts::${f}`,
    reason: 'not-entity: keyed by a prefab member\'s serialized localId, not a runtime entity id — the written twin of loaders/loadSceneFile.ts SceneEntityEntry; editor/scene/serialize.ts:41' })),
  { item: 'engine/packages/modoki/src/editor/scene/prefab.ts::InstanceStructure.removedTraits',
    reason: 'not-entity: keyed by a prefab member\'s serialized localId, not a runtime entity id; editor/scene/prefab.ts:1159' },
  { item: 'engine/packages/modoki/src/editor/scene/prefab.ts::InstanceReference.overrides',
    reason: 'not-entity: keyed by a prefab member\'s serialized localId, not a runtime entity id; editor/scene/prefab.ts:1395' },
  { item: 'engine/packages/modoki/src/editor/scene/prefab.ts::InstanceReference.removedTraits',
    reason: 'not-entity: keyed by a prefab member\'s serialized localId, not a runtime entity id; editor/scene/prefab.ts:1395' },
  { item: 'engine/packages/modoki/src/editor/scene/prefab.ts::NestedInstanceCapture.overrides',
    reason: 'not-entity: keyed by a nested prefab member\'s localId, addressed by the parentLocalId chain precisely because runtime ids churn across the rebuild; editor/scene/prefab.ts:2047' },
  { item: 'engine/packages/modoki/src/editor/scene/prefab.ts::RevertResult.fullOverrides',
    reason: 'not-entity: keyed by a prefab member\'s serialized localId, not a runtime entity id; editor/scene/prefab.ts:2351' },
  { item: 'engine/packages/modoki/src/editor/scene/prefab.ts::RevertResult.reducedOverrides',
    reason: 'not-entity: keyed by a prefab member\'s serialized localId, not a runtime entity id; editor/scene/prefab.ts:2351' },
  { item: 'engine/packages/modoki/src/editor/scene/prefab.ts::InstanceStructure.consumedEcsIds',
    reason: 'scratch: built by captureInstanceStructure from a live query and read by serialize/serializePrefab in the same call; the structures kept by ApplyPrefabDialog\'s undo closures and engine/app/editor/agentEditorOps.ts:2409 never read it (rebuildInstance recomputes live members, editor/scene/prefab.ts:2186); editor/scene/prefab.ts:1159' },
  { item: 'engine/packages/modoki/src/editor/scene/prefab.ts::InstanceReference.memberEcsIds',
    reason: 'scratch: built by captureInstanceReference from a live PrefabInstance query and consumed as a skip set by the serializer that asked for it, in the same call; editor/scene/prefab.ts:1395' },
  { item: 'engine/packages/modoki/src/editor/scene/prefab.ts::InstanceReference.consumedEcsIds',
    reason: 'scratch: same capture-and-consume call as InstanceReference.memberEcsIds; editor/scene/prefab.ts:1395' },
  { item: 'engine/packages/modoki/src/editor/undo/undoManager.ts::_restoringSessions',
    reason: 'not-entity: preview session ids, the same space as _previewSession; editor/undo/undoManager.ts:155' },
  { item: 'engine/packages/modoki/src/editor/panels/SceneView.tsx::dominantBoneFieldCache',
    reason: 'not-entity: WeakMap keyed by the ParsedRig2D object, inner key a rig part index; editor/panels/SceneView.tsx:170' },
  { item: 'engine/packages/modoki/src/editor/animation/entityIndex.ts::AnimEntityIndex.byId',
    reason: 'per-world-index: rebuilt from getAllEntities() whenever getStructureVersion() moved OR the current world changed. Every index reuse bumps the version (spawnEntity → registerEntity → markStructureDirty, runtime/core/ecs/world.ts:72), and the world stamp covers the global counter moving in a staging world before the swap and a swap back that registers nothing (#1198 review), pinned by animEntityIndex.test.ts; editor/animation/entityIndex.ts:33' },
  { item: 'engine/packages/modoki/src/editor/animation/entityIndex.ts::AnimEntityIndex.childrenByParent',
    reason: 'per-world-index: same build and invalidation as AnimEntityIndex.byId; editor/animation/entityIndex.ts:25' },
  { item: 'engine/packages/modoki/src/editor/panels/sceneViewResources.ts::SceneViewEntityObjects.outlineMeshes',
    reason: 'revalidated: syncOutlineFor rebuilds (and stores back) when the source geometry resolved from the live object this frame differs from the one the edges were traced from, and colour/TRS are rewritten every frame (#1198), pinned by sceneViewMath.test.ts; the owner-evicted ecsObjects also clears it through onMeshRemoved; editor/scene/sceneViewMath.ts' },
  { item: 'engine/packages/modoki/src/editor/panels/sceneViewResources.ts::SceneViewEntityObjects.descOutlineMeshes',
    reason: 'revalidated: same syncOutlineFor source-geometry stamp as outlineMeshes, rebuilt each frame from subtreeIds of the live selection (#1198); editor/panels/SceneView.tsx' },
  { item: 'engine/packages/modoki/src/editor/panels/sceneViewResources.ts::SceneViewEntityObjects.colliderWires',
    reason: 'revalidated: drawCollider resolves the id to a live Collider3D first, then rebuilds the wire when colliderOutlineSig3D (every field colliderWireframeGeometry reads, plus the mesh geometry uuid) or the colour differs; pose rewritten every frame; editor/panels/SceneView.tsx' },
  { item: 'engine/packages/modoki/src/editor/panels/sceneViewResources.ts::SceneViewEntityObjects.colliderWireSigs',
    reason: 'revalidated: the signature half of colliderWires, compared against the live Collider3D every frame and deleted with the wire; editor/panels/SceneView.tsx' },
  { item: 'engine/packages/modoki/src/editor/panels/sceneViewResources.ts::SceneViewEntityObjects.ecsLights',
    reason: 'revalidated: runtime syncLights rebuilds on a light-type mismatch and rewrites colour, intensity, shadow, range/cone, pose and layer mask from the live Light every frame; layers are identical for every light — the mirrored-state reading Scene3D\'s per-mount ecsLights already has; runtime/rendering/scene3DSync.ts:1108' },
  { item: 'engine/packages/modoki/src/editor/panels/SceneView.tsx::_pick2DByCanvas',
    reason: 'revalidated: canvas entity id -> pick callback; the callback holds only that id and live element/scale getters, and re-queries routing, paint order and the world on every call; editor/panels/SceneView.tsx:1436' },
  { item: 'engine/packages/modoki/src/editor/scene/sceneViewBus.ts::ecsObjectsRegistry',
    reason: 'owner-checked: a reference to SceneView\'s live RenderState.ecsObjects, registered with its ecsOwners stamp map; the one reader, isEcsObjectVisible, refuses an entry whose packed owner is no longer alive before reading it (#1198 review), pinned by sceneViewBus.test.ts; editor/scene/sceneViewBus.ts' },
  { item: 'engine/packages/modoki/src/editor/scene/sceneViewBus.ts::ecsOwnersRegistry',
    reason: 'gen-in-value: SceneView\'s RenderState.ecsOwners, the packed entity each ecsObjects entry was built for (runtime LEDGER row); read only by isEcsObjectVisible, which checks it alive; editor/scene/sceneViewBus.ts:127' },
  { item: 'engine/packages/modoki/src/editor/panels/Hierarchy.tsx::NO_COLLAPSE',
    reason: 'not-entity: an empty sentinel substituted for the collapsed set while filtering; never written, so it holds no id; editor/panels/Hierarchy.tsx:81' },
  { item: 'engine/packages/modoki/src/editor/panels/sceneView2DGraph.ts::_paintOrderCache',
    reason: 'per-world-index: rebuilt from the live world whenever the structure version moves, which every registerEntity AND unregisterEntity bumps (#1220), so a recycled index is never served the dead entity\'s rank; editor/panels/sceneView2DGraph.ts:92, runtime/core/ecs/world.ts:224' },
  { item: 'engine/packages/modoki/src/editor/panels/sceneView2DGraph.ts::_paintOrderCache{}.order',
    reason: 'per-world-index: the id -> rank map inside _paintOrderCache, rebuilt on the same structure-version stamp (#1220); editor/panels/sceneView2DGraph.ts:92' },
  { item: 'engine/packages/modoki/src/editor/panels/sceneView2DGraph.ts::Canvas2DRoutingMaps.parentOf',
    reason: 'per-world-index: id -> parentId, built only by buildCanvas2DRouting from the live world and served only through getCanvas2DRouting, whose stamp includes the structure version every spawn and destroy bumps (#1220); editor/panels/sceneView2DGraph.ts:79' },
  { item: 'engine/packages/modoki/src/editor/panels/sceneView2DGraph.ts::Canvas2DRoutingMaps.sortOrderOf',
    reason: 'per-world-index: id -> sortOrder, built only by buildCanvas2DRouting from the live world and served only through getCanvas2DRouting, whose stamp includes the structure version every spawn and destroy bumps (#1220); editor/panels/sceneView2DGraph.ts:79' },
  { item: 'engine/packages/modoki/src/editor/panels/sceneView2DGraph.ts::Canvas2DRoutingMaps.orderInLayerOf',
    reason: 'per-world-index: id -> Renderable2D.orderInLayer, built only by buildCanvas2DRouting from the live world and served only through getCanvas2DRouting, whose stamp includes the structure version every spawn and destroy bumps (#1220); editor/panels/sceneView2DGraph.ts:79' },
  { item: 'engine/packages/modoki/src/editor/panels/sceneView2DGraph.ts::Canvas2DRoutingMaps.canvasIds',
    reason: 'per-world-index: the Canvas2D id set, built only by buildCanvas2DRouting from the live world and served only through getCanvas2DRouting, whose stamp includes the structure version every spawn and destroy bumps (#1220); editor/panels/sceneView2DGraph.ts:79' },
  { item: 'engine/packages/modoki/src/editor/panels/gizmoBounds.ts::GizmoBoundsDeps.parentOf',
    reason: 'per-world-index: every caller passes getCanvas2DRouting()\'s map, rebuilt from the live world on each spawn/destroy via the structure version (#1220); editor/panels/sceneView2DGraph.ts:79' },
  { item: 'engine/packages/modoki/src/editor/panels/Hierarchy.tsx::EntityNodeProps.collapsed',
    reason: 'pending: #1221 — collapse component state held across user time by bare id and never pruned on destroy; a replacement on the index renders collapsed; editor/panels/Hierarchy.tsx:550' },
  { item: 'engine/packages/modoki/src/editor/panels/Hierarchy.tsx::EntityNodeProps.selectedIds',
    reason: 'pending: #1221 — a per-render memo of editorStore.selectedEntityIds, whose bare ids survive a destroy with no prune; editor/panels/Hierarchy.tsx:855' },
  // ── games/ (owed only where the layout carries the project — see rowIsOwedInLayout) ──
  { item: 'games/court/runtime/knowledge.ts::EMPTY_ASSIGNED',
    reason: 'not-entity: an empty region -> candidate map; its filled twin is keyed by region index (knowledge.ts:184); games/court/runtime/knowledge.ts:178' },
  { item: 'games/court/runtime/rules.ts::Board.holes',
    reason: 'not-entity: a Court board cell index, not an entity id; games/court/runtime/rules.ts:51' },
  { item: 'games/court/runtime/rules.ts::Level.civilians',
    reason: 'not-entity: a Court board cell index, not an entity id; games/court/runtime/rules.ts:59' },
  { item: 'games/court/runtime/session.ts::SessionState.placements',
    reason: 'not-entity: a Court board cell index, not an entity id; cell -> piece; games/court/runtime/session.ts:146' },
  { item: 'games/court/runtime/session.ts::SessionState.paint',
    reason: 'not-entity: a Court board cell index, not an entity id; cell -> painted glyphs; games/court/runtime/session.ts:148' },
  { item: 'games/court/runtime/session.ts::SessionState.regionNotes',
    reason: 'not-entity: keyed by a Piece letter, flagged for its Set<number> of REGION indices; games/court/runtime/session.ts:191' },
  { item: 'games/court/runtime/session.ts::EMPTY_REGIONS',
    reason: 'not-entity: an empty set of region indices; games/court/runtime/session.ts:265' },
  { item: 'games/court/runtime/solver.ts::PropagateOptions.start',
    reason: 'not-entity: region index -> assigned candidate (from assignedFromPlacements); games/court/runtime/solver.ts:479' },
  { item: 'games/court/runtime/solver.ts::PropagateResult.placement',
    reason: 'not-entity: Court\'s own `type Placement = ReadonlyMap<number, Piece>`, cell -> piece; games/court/runtime/rules.ts:141' },
  { item: 'games/court/runtime/systems.ts::PaintStroke.touched',
    reason: 'not-entity: a Court board cell index, not an entity id; cells a paint stroke already visited; games/court/runtime/systems.ts:14064' },
  { item: 'games/court/runtime/systems.ts::pieceRevealMs',
    reason: 'not-entity: a Court board cell index, not an entity id; cell -> reveal clock; games/court/runtime/systems.ts:12926' },
  { item: 'games/court/runtime/systems.ts::revealedFlagCells',
    reason: 'not-entity: a Court board cell index, not an entity id; games/court/runtime/systems.ts:12310' },
  { item: 'games/court/runtime/systems.ts::flagInstances',
    reason: 'not-entity: a Court board cell index, not an entity id; the VALUE is the flag\'s Entity HANDLE since #1224, which syncFlags asks entityAlive before retiring; games/court/runtime/systems.ts:2052' },
  { item: 'games/court/runtime/systems.ts::wheelWedgeMismatchWarned',
    reason: 'not-entity: wedge COUNTS already warned about; games/court/runtime/systems.ts:20765' },
  { item: 'games/court/runtime/systems.ts::cellCenters',
    reason: 'not-entity: a Court board cell index, not an entity id; games/court/runtime/systems.ts:11044' },
  { item: 'games/court/runtime/systems.ts::cellGeometry',
    reason: 'not-entity: a Court board cell index, not an entity id; games/court/runtime/systems.ts:10977' },
  { item: 'games/court/tests/courtSweepPass.ts::BeatsRecord.byKind',
    reason: 'not-entity: action kind -> (beat count -> stories); games/court/tests/courtSweepPass.ts:114' },
  { item: 'games/court/tests/hintKit.ts::Board.placements',
    reason: 'not-entity: a Court board cell index, not an entity id; the test kit\'s board; games/court/tests/hintKit.ts:83' },
  { item: 'games/court/tests/hintKit.ts::Board.paint',
    reason: 'not-entity: a Court board cell index, not an entity id; the test kit\'s board; games/court/tests/hintKit.ts:84' },
  { item: 'games/sling/runtime/field/rebuildField.ts::registeredKeys',
    reason: 'revalidated: field root id -> the runtime-mesh keys registered for it, and every key EMBEDS that same root id (capTopKey/dirtKey/rampShellKey), so a newcomer on the index owns exactly the key strings it would register itself; clearField unregisters them before a rebuild re-registers. Not an inheritance hazard; a root whose id CHANGES across a reload leaves its keys registered (a leak, outside this guard); games/sling/runtime/field/rebuildField.ts:253' },
  { item: 'games/sling/runtime/fish.ts::rootInfo',
    reason: 'scratch: cleared and refilled from the live query at the top of every frame; games/sling/runtime/fish.ts:141' },
  { item: 'games/sling/runtime/fish.ts::parentOf',
    reason: 'scratch: cleared and refilled from the live EntityAttributes query every frame; games/sling/runtime/fish.ts:208' },
  { item: 'games/wordweave/runtime/systems.ts::wheelWedgeMismatchWarned',
    reason: 'not-entity: wedge COUNTS already warned about; games/wordweave/runtime/systems.ts:2618' },
  { item: 'games/wordweave/runtime/systems.ts::NO_CELLS',
    reason: 'not-entity: an empty set of Wordweave board cell indices; games/wordweave/runtime/systems.ts:4797' },
  { item: 'games/wordweave/tools/generate.ts::TierPool.byLength',
    reason: 'not-entity: word length -> words; games/wordweave/tools/generate.ts:159' },
];

describe('entity-keyed maps — runtime/** state keyed by a recycled index (#868)', () => {
  it('flags module-scope, class-field and interface-field declarations, including nested ones', () => {
    const src = [
      "import type { PackedEntity } from './entityTable';",
      'const a = new Map<number, string>();',
      'export const b: ReadonlySet<number> = new Set();',
      'const c = new WeakMap<object, Map<number, string>>();',
      'class K { d = new Set<number>(); private e: Map<number, number[]> = new Map(); }',
      'interface I { f: Map<number, string>; g: { h: Set<number> } }',
      'type T = { i: ReadonlyMap<number, string> };',
      '',
      '// Accept side: none of these may be flagged.',
      'const okPacked = new Map<PackedEntity, string>();',
      'const okString = new Map<string, number>();',
      'const okValue = new Map<string, Set<string>>();',
      'const okUntyped = new Map();',
      'function local() { const m = new Map<number, string>(); return m; }',
      'function param(m: Map<number, string>): Set<number> { return new Set(m.keys()); }',
      'class OkK { method() { const s = new Set<number>(); return s; } }',
      'function okLiteralParam(p: { ids: Set<number> }): { out: Map<number, string> } { const l: { m: Map<number, string> } = { m: new Map() }; void l; return { out: new Map() }; }',
      'interface OkMethod { run(arg: { s: Set<number> }): void; }',
      'const okArrowParam = (m: Map<number, string>): Set<number> => new Set(m.keys());',
      'const iife = (() => ({ held: new Map<number, string>() }))();',
    ].join('\n');
    const { found, scanned } = numberKeyedDeclarations(src, 'fixture.ts');
    expect(found.map((d) => d.item)).toEqual([
      'fixture.ts::a',
      'fixture.ts::b',
      'fixture.ts::c',
      'fixture.ts::iife',
      'fixture.ts::K.d',
      'fixture.ts::K.e',
      'fixture.ts::I.f',
      'fixture.ts::I.g',
      'fixture.ts::g{}.h',
      'fixture.ts::T{}.i',
    ]);
    expect(scanned).toBeGreaterThanOrEqual(found.length + 4);
  });

  it('resolves corpus aliases — a number-keyed collection alias, a number alias as a key, and Record', () => {
    const lib = [
      'export type Nested = PoseMap;',               // an alias of an alias ABOVE its target: needs the fixed point
      'export type PoseMap = Map<number, string>;',
      'export type SceneId = number;',
      'export type Brand = number & { __b: true };',  // a branded number is NOT `number`
    ].join('\n');
    const use = [
      'const viaAlias: PoseMap = new Map();',
      'const viaNested = new Map<string, Nested>();',
      'const viaIdAlias = new Map<SceneId, string>();',
      'const viaRecord: Record<number, string> = {};',
      'const okBrand = new Map<Brand, string>();',
      'const okStringRecord: Record<string, number> = {};',
    ].join('\n');
    const aliases = collectCorpusAliases([{ file: 'lib.ts', code: lib }]);
    expect([...aliases.collections].sort()).toEqual(['Nested', 'PoseMap']);
    expect([...aliases.numbers]).toEqual(['SceneId']);
    expect(numberKeyedDeclarations(use, 'use.ts', aliases).found.map((d) => d.item)).toEqual([
      'use.ts::viaAlias', 'use.ts::viaNested', 'use.ts::viaIdAlias', 'use.ts::viaRecord',
    ]);
  });

  it('every flagged declaration uses EntityTable/PackedEntity, or spends a ledger row', () => {
    const { scanned, found } = scanRuntime();
    assertExemptionLedger({
      label: 'LEDGER in entityKeyedMaps',
      population: found,
      exempt: LEDGER,
      sanctioned: ['core/ecs/entityTable.ts::EntityTable.entries'],
      floor: 1000,
      scanned,
      fix: 'number-keyed Map/Set(s) in runtime/** with no ledger row. If the number is an entity id '
        + 'and the state survives the frame, use `EntityTable` (id is an addressing contract, or entries '
        + 'own something to release) or key a private map by `packedOf(entity)` — both in '
        + '`core/ecs/entityTable.ts`, rule in docs/engine-concepts.md § Entity. Otherwise add a LEDGER '
        + 'row whose reason starts with its tag and cites the line that makes it safe.',
    });
  });

  it('aliases are scoped per project: one game\'s number-keyed alias does not flag another game\'s same-named type (#1198)', () => {
    const runtime = collectCorpusAliases([{ file: 'core/ids.ts', code: 'export type SceneId = number;' }]);
    const sources = [
      { file: 'games/court/rules.ts', code: 'export type Placement = ReadonlyMap<number, string>;\ninterface R { placement: Placement | null }' },
      { file: 'games/sling/floor.ts', code: 'export interface Placement { tx: number }\ninterface M { placements: Placement[] }' },
      { file: 'engine/app/x.ts', code: 'interface E { owners: Map<SceneId, string> }' },
    ];
    const found = aliasScopes(sources, runtime)
      .flatMap((sc) => sc.sources.flatMap((src) => numberKeyedDeclarations(src.code, src.file, sc.aliases).found.map((d) => d.item)));
    // Reject side: court's own alias still flags court's field, and a runtime alias reaches every scope.
    expect(found).toContain('games/court/rules.ts::R.placement');
    expect(found).toContain('engine/app/x.ts::E.owners');
    // Accept side: sling's unrelated Placement is not court's.
    expect(found).not.toContain('games/sling/floor.ts::M.placements');
  });

  it('a games/ or demos/ row is owed only when this layout carries its PROJECT — never judged by the file (#1198)', () => {
    const present = new Set(['demos/shipped', 'games/court']);
    // Reject side: a project the layout does not ship.
    expect(rowIsOwedInLayout('demos/unpublished/game.ts::m', present)).toBe(false);
    expect(rowIsOwedInLayout('games/sling/runtime/fish.ts::rootInfo', present)).toBe(false);
    // Accept side: a present project's row is owed even if its FILE is gone — that is a stale row.
    expect(rowIsOwedInLayout('demos/shipped/renamed-away.ts::m', present)).toBe(true);
    expect(rowIsOwedInLayout('games/court/runtime/systems.ts::x', present)).toBe(true);
    // Engine rows are always owed; a prefix look-alike is not a project.
    expect(rowIsOwedInLayout('engine/packages/modoki/src/editor/x.ts::m', present)).toBe(true);
    expect(rowIsOwedInLayout('games-archive/x.ts::m', new Set())).toBe(true);
  });

  it('the editor, engine/app, the starter template, games/ and demos/: every flagged declaration uses EntityTable/PackedEntity, or spends a WIDENED_LEDGER row (#1198)', () => {
    const { scanned, found } = scanWidened();
    const presentProjects = new Set(discoverProjects(REPO_ROOT).map((pr: { root: string; name: string }) => `${pr.root}/${pr.name}`));
    assertExemptionLedger({
      label: 'WIDENED_LEDGER in entityKeyedMaps',
      population: found,
      exempt: WIDENED_LEDGER.filter(({ item }) => rowIsOwedInLayout(item, presentProjects)),
      floor: 1500,
      scanned,
      fix: 'number-keyed Map/Set(s) outside runtime/** with no WIDENED_LEDGER row. Same rule as the runtime '
        + 'ledger: if the number is an entity id and the state survives the frame (or the user\'s click), use '
        + '`EntityTable` or key by `packedOf(entity)` (`core/ecs/entityTable.ts`); otherwise add a row whose '
        + 'reason starts with its tag and cites the line that makes it safe. Keys are repo-relative.',
    });
  });
});
