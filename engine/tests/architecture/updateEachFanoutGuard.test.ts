/** Guard: no `world.query(...).updateEach(...)` callback synchronously reaches a
 *  SUBSCRIBER FAN-OUT — a call that invokes game-registered handlers (#445).
 *
 *  koota's `updateEach` snapshots each queried trait into a local BEFORE the callback runs and
 *  writes that local back UNCONDITIONALLY once the callback returns. So if the callback
 *  synchronously runs game-registered code that does `entity.set(SomeTrait, ...)` on a trait in
 *  the SAME query, the write lands, then koota's own post-callback write-back clobbers it with
 *  the stale pre-callback snapshot — silently. Nothing throws; the handler's write just never
 *  happened. `timelineSystem.ts:752`'s "PASS 1 — collect ... never emit/dispatch/set-on-other-
 *  entities inside the query" comment states the rule; this test enforces it.
 *
 *  The sanctioned fix is collect-during-query, flush-after-close: stage a record inside
 *  `updateEach`, then loop over the staged records AFTER the query has closed and fan out there.
 *  `timelineSystem.ts`'s PASS 1 / PASS 2, the zone systems' `runZoneTriggers`, and `videoSystem.ts`
 *  (#432)'s `emits` array all do this — see those for the pattern to copy.
 *
 *  DETECTION, and its depth (stated plainly per the brief this test was written against):
 *  - A seed set of known fan-out entry points: `dispatchGameAction`/`dispatchUIAction`
 *    (`core/actionRegistry`); the physics/zone event buses' `__emitCollision`/`__emitSensor`/
 *    `__emitContact`/`__emitZone` (member calls); `timelineEvents.__emitStart`/`__emitEnd`/
 *    `__emitMarker`; `emitVideoStart`/`emitVideoEnd`/`emitVideoSkip` (`video/VideoEvents`);
 *    `cueClip` (`audio/audioCues`); `fireOnCollision`/`fireOnSequence`; and two verified
 *    one-hop-resolved siblings, `synthesizeContactExits`/`routeContactEvents`
 *    (`physicsContactEvents.ts`) — both call `routePair`, which calls `bus.__emitSensor`/
 *    `__emitCollision` AND the injected `fire` (OnCollision) callback, so a call to either IS a
 *    fan-out even though this guard never opens their (different-file) body to see that. Plus a
 *    `/^(fire|route)[A-Z]/` pattern on bare identifier calls, to catch an un-seeded sibling
 *    (`fireOnZone2D`-shaped names) before it needs a manual add.
 *  - Journal's own `emit()` (`core/journal`) is deliberately NOT in any of the above sets — it
 *    only pushes onto a ring buffer, no subscriber fan-out, and legitimately runs from inside
 *    `updateEach` all over `scene3DSync.ts`. Exact-name matching (not a substring/prefix test)
 *    is what keeps `emit` from colliding with `emitVideoStart`/`emitVideoEnd`/`emitVideoSkip`.
 *  - Transitivity: **same-file only, to the required floor.** A call inside an `updateEach`
 *    body to a function DEFINED IN THE SAME FILE (a top-level `function` or a
 *    `const x = (...) => ...`) is followed into that function's body, recursively (cycle-
 *    guarded), looking for a seed match. This is what catches the physics violation: the
 *    `updateEach` body calls `removeBody` (same file), which calls `synthesizeContactExits`
 *    (a seed name) — two hops, both resolved. A call reaching into a DIFFERENT file that is
 *    not itself a seed name is invisible to this guard; the two pre-resolved physics helpers
 *    above are how that gap is closed for the one call chain known to need it, without making
 *    every guard hit require a fragile cross-file body walk.
 *
 *  ALLOWLIST: exactly the two known violations (#445, unfixed — see each entry), matched by
 *  (file, the DIRECT call made from inside the `updateEach` body that starts the offending
 *  chain) so a new, unrelated violation in the same file still surfaces. Mirrors
 *  `editorStoreActionsReachable.test.ts`'s `knownOrphans`: an allowlist entry that stops
 *  matching a real violation fails the suite too, so the list can't rot into cover. */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';

const engineRoot = path.resolve(__dirname, '../..');
const repoRoot = path.resolve(engineRoot, '..');

/** Bare-identifier calls that ARE the fan-out (or are verified — see the file banner — to
 *  reach one within their own, different-file body). Exact match only. */
const SEED_NAMES = new Set([
  'dispatchGameAction',
  'dispatchUIAction',
  'emitVideoStart',
  'emitVideoEnd',
  'emitVideoSkip',
  'cueClip',
  'fireOnCollision',
  'fireOnSequence',
  'synthesizeContactExits',
  'routeContactEvents',
]);

/** A human note appended to the reported chain for a seed that is itself a one-hop stand-in for
 *  a fan-out this guard does not open the (different-file) body of — see the file banner. */
const SEED_NOTES = new Map<string, string>([
  ['synthesizeContactExits', '__emitCollision/__emitSensor (via routePair, physicsContactEvents.ts) '
    + '+ fireOnCollision -> dispatchGameAction'],
  ['routeContactEvents', '__emitCollision/__emitSensor (via routePair, physicsContactEvents.ts) '
    + '+ fireOnCollision -> dispatchGameAction'],
]);

/** `x.NAME(...)` member calls that are the fan-out, regardless of what `x` is (the event buses
 *  are injected/module-scoped under different names at different call sites). */
const SEED_MEMBER_NAMES = new Set([
  '__emitCollision', '__emitSensor', '__emitContact', '__emitZone',
  '__emitStart', '__emitEnd', '__emitMarker',
]);

/** Catches an un-seeded sibling before it needs a manual add — see the file banner. Applied to
 *  bare identifier calls only (a `.fireEvent()` method on an unrelated object is not this). */
const SEED_PATTERN = /^(fire|route)[A-Z]/;

/** KNOWN VIOLATIONS, tracked not hidden — see #445. Matched by (file, the direct call made
 *  from inside the offending `updateEach` body). Do NOT add to this to make a red build green:
 *  the fix is #445's, and a new match here needs its own investigation, not a suppression. */
interface AllowlistEntry { file: string; rootCall: string; reason: string }
const ALLOWLIST: AllowlistEntry[] = [
  {
    file: 'packages/modoki/src/runtime/physics/physics2DSystem.ts',
    rootCall: 'removeBody',
    reason: '#445: the body-reconcile query rebuilds a body on a structural/generation change by '
      + 'calling removeBody(st, world, rec) INSIDE world.query(Transform, RigidBody2D).updateEach(...) '
      + '— removeBody synthesizes contact exits (H1) before freeing colliders, which fans out. Known, '
      + 'awaiting a fix; NOT an approved pattern.',
  },
  {
    file: 'packages/modoki/src/runtime/physics/physics3DSystem.ts',
    rootCall: 'removeBody',
    reason: '#445: same shape as physics2DSystem.ts — see that entry.',
  },
];

interface Violation { file: string; line: number; chain: string[] }

/** Every top-level (any-depth) `function name(...) {}` / `const name = (...) => ...` /
 *  `const name = function(...) {}` in the file, keyed by name -> its body node(s). Depth-
 *  agnostic on purpose: a helper local to one system function (not just module-level) still
 *  needs to be followed. */
function collectLocalFunctions(sf: ts.SourceFile): Map<string, ts.Node[]> {
  const map = new Map<string, ts.Node[]>();
  const add = (name: string, body: ts.Node | undefined) => {
    if (!body) return;
    const arr = map.get(name) ?? [];
    arr.push(body);
    map.set(name, arr);
  };
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      add(node.name.text, node.body);
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const init = node.initializer;
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) add(node.name.text, init.body);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return map;
}

/** Every `<expr>.updateEach(...)` call, with the 0-based source line of the call itself (for
 *  the "which updateEach it sits in" part of the failure message). */
function findUpdateEachCalls(sf: ts.SourceFile): { call: ts.CallExpression; line: number }[] {
  const out: { call: ts.CallExpression; line: number }[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'updateEach'
    ) {
      out.push({ call: node, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** DFS from `node` for the first call reaching a seed (directly, or transitively through a
 *  same-file local function — see the file banner for the exact floor). Returns the call chain
 *  from the point of the search (nearest call first) to the seed match, or `null`. */
function findFanoutChain(
  node: ts.Node,
  localFns: Map<string, ts.Node[]>,
  visited: Set<string>,
): string[] | null {
  let result: string[] | null = null;
  const visit = (n: ts.Node) => {
    if (result) return;
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      if (ts.isIdentifier(callee)) {
        const name = callee.text;
        if (SEED_NAMES.has(name) || SEED_PATTERN.test(name)) { result = [name]; return; }
        if (localFns.has(name) && !visited.has(name)) {
          visited.add(name);
          for (const body of localFns.get(name)!) {
            const sub = findFanoutChain(body, localFns, visited);
            if (sub) { result = [name, ...sub]; break; }
          }
          if (result) return;
        }
      } else if (ts.isPropertyAccessExpression(callee) && SEED_MEMBER_NAMES.has(callee.name.text)) {
        result = [callee.name.text];
        return;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return result;
}

const SCAN_EXT = /\.tsx?$/;
const EXCLUDE_DIRS = new Set(['node_modules', 'dist']);

function walk(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDE_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (SCAN_EXT.test(e.name) && !e.name.endsWith('.d.ts') && !/\.test\.tsx?$/.test(e.name)) {
      out.push(p);
    }
  }
}

function scanRoots(): string[] {
  const roots = [
    path.join(engineRoot, 'packages/modoki/src/runtime'),
    path.join(engineRoot, 'app'),
  ];
  const gamesDir = path.join(repoRoot, 'games');
  if (fs.existsSync(gamesDir)) {
    for (const e of fs.readdirSync(gamesDir, { withFileTypes: true })) {
      if (e.isDirectory()) roots.push(path.join(gamesDir, e.name, 'runtime'));
    }
  }
  return roots;
}

function sourceFiles(): string[] {
  const out: string[] = [];
  for (const r of scanRoots()) walk(r, out);
  return out;
}

function findViolations(): Violation[] {
  const violations: Violation[] = [];
  for (const file of sourceFiles()) {
    const raw = fs.readFileSync(file, 'utf8');
    const sf = ts.createSourceFile(
      file, raw, ts.ScriptTarget.Latest, /* setParentNodes */ true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const localFns = collectLocalFunctions(sf);
    for (const { call, line } of findUpdateEachCalls(sf)) {
      const cb = call.arguments[call.arguments.length - 1];
      if (!cb || !(ts.isArrowFunction(cb) || ts.isFunctionExpression(cb))) continue;
      const chain = findFanoutChain(cb.body, localFns, new Set());
      if (chain) violations.push({ file: path.relative(engineRoot, file), line, chain });
    }
  }
  return violations;
}

// Memoized so both `it`s below run the same scan without one test depending on the other's
// execution (no beforeAll) — the scan is a full-corpus TS parse, worth not repeating twice.
let cachedViolations: Violation[] | null = null;
function getViolations(): Violation[] {
  if (!cachedViolations) cachedViolations = findViolations();
  return cachedViolations;
}

function formatChain(chain: string[]): string {
  const note = SEED_NOTES.get(chain[chain.length - 1]);
  return chain.join(' -> ') + (note ? ` -> ${note}` : '');
}

describe('updateEach callbacks never synchronously reach a subscriber fan-out (#445)', () => {
  it('the query finds a plausible corpus (sanity — a silently-empty scan is a vacuous pass)', () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(50);
    const callSites = files.flatMap((f) => {
      const raw = fs.readFileSync(f, 'utf8');
      const sf = ts.createSourceFile(
        f, raw, ts.ScriptTarget.Latest, true, f.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      return findUpdateEachCalls(sf);
    });
    expect(callSites.length).toBeGreaterThan(50);
  });

  it('no updateEach callback reaches dispatchGameAction/dispatchUIAction/an event-bus emit/cueClip', () => {
    const violations = getViolations();

    const unexpected = violations.filter((v) => !ALLOWLIST.some(
      (a) => a.file === v.file && a.rootCall === v.chain[0],
    ));
    expect(
      unexpected.map((v) => `${v.file}:${v.line}  ${formatChain(v.chain)}\n`
        + `  BUG: koota's updateEach snapshots the queried trait BEFORE this callback runs and writes\n`
        + `  that snapshot back UNCONDITIONALLY after it returns — a handler reached synchronously from\n`
        + `  in here that does entity.set(...) on a trait in this same query has its write silently\n`
        + `  clobbered by that write-back. Nothing throws.\n`
        + `  FIX: collect-during-query, flush-after-close — stage a record inside updateEach, fan out\n`
        + `  in a loop AFTER the query closes. See videoSystem.ts's \`emits\` array (#432) or\n`
        + `  timelineSystem.ts's PASS 1 (collect) / PASS 2 (apply, ~line 796).`),
      'updateEach callback(s) synchronously reach a subscriber fan-out (#445)',
    ).toEqual([]);
  });

  it('every ALLOWLIST entry still matches a real violation (a stale suppression hides the next regression)', () => {
    const violations = getViolations();

    // Keep the allowlist HONEST: an entry that no longer matches a real violation (fixed, or the
    // code moved) must leave, or a future real regression could hide behind a stale name.
    const stale = ALLOWLIST.filter(
      (a) => !violations.some((v) => v.file === a.file && v.chain[0] === a.rootCall),
    );
    expect(
      stale.map((a) => `${a.file}: rootCall ${JSON.stringify(a.rootCall)} no longer reproduces — delete this allowlist entry (#445)`),
      'ALLOWLIST entries that are no longer violations',
    ).toEqual([]);
  });
});
