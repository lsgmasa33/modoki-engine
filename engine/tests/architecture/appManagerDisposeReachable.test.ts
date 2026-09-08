/**
 * Every app-scoped `ManagerDef` that declares a `dispose` has a real production caller for it (#517).
 *
 * `managerRegistry.deactivate()` — the only thing that runs `def.dispose?.()` — is reached from
 * `unregisterManager(name)` (or `unregisterManagers([...])`, its plural form) or from re-registering
 * the same name. An app-scoped manager (`scope: 'app'`) is activated once at register and, unlike a
 * scene-/game-scoped one, has NO other trigger that tears it down. So a `dispose` on an app-scoped
 * `ManagerDef` is dead code unless something in production actually calls
 * `unregisterManager('<name>')` — otherwise the disposer *looks* wired (it reads like a real
 * teardown) while nothing ever reaches it, exactly the `inputSourcesManager` defect filed in #517.
 *
 * This guard enumerates every `ManagerDef` object literal / class declaration in the runtime with
 * `scope: 'app'` and a `dispose`, directly from source, and requires each one to be either wired to
 * a real `unregisterManager('<name>')` call in production, or named in an explicit allowlist below
 * with a verified reason. Same discipline as this file's sibling, `invalidatorsAreReachable.test.ts`.
 *
 * ⚠️ **This guard has been wrong twice in the same direction** — it enumerated one declaration form,
 * missed another (the object-literal-only scan was blind to `class X implements ManagerDef`), and
 * was widened. A third missed form (a sub-interface `extends ManagerDef`, `implements ManagerDef, Y`,
 * a generic class, `satisfies`/`as ManagerDef`, a factory, a `const arr: ManagerDef[]`, …) would ship
 * the same way — silently, because a scanner that doesn't recognize a form doesn't know it missed
 * anything. Rather than chase every syntactic form the two scanners might miss, the CENSUS test
 * below is a structural backstop: it counts every textual `ManagerDef` reference in the scanned tree
 * and requires each one to be accounted for by a scanner hit or a verified, named allowlist entry —
 * so an unrecognized form fails LOUD instead of silently passing.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { stripComments } from '@modoki/engine/testing';
import { repoFiles } from '../../scripts/repoCorpus.mjs';

const REPO = path.resolve(__dirname, '../../..');
const RUNTIME_DIR = path.join(REPO, 'engine/packages/modoki/src/runtime');

/** All .ts/.tsx files under RUNTIME_DIR, git-enumerated (#771/#799) rather than a hand-rolled
 *  recursive walk, excluding test files. `.tsx` matters: there are 10+ runtime `.tsx` files (UI
 *  components etc.), and a `ManagerDef` declared in one of them used to be invisible to this scan
 *  entirely. */
function listRuntimeFiles(dir: string): string[] {
  return repoFiles({
    under: dir,
    match: (rel) => /\.tsx?$/.test(rel) && !rel.includes('.test.'),
    floor: 0,
  }).map(({ abs }) => abs);
}

/** Given source and the index of an object literal's opening `{`, return the matching closing
 *  `}` index via brace balancing that skips braces inside string/template literals (a `'}'` or
 *  `` `}` `` in any string in a class/object body used to truncate the scanned body before this
 *  fix). LIMITATION, noted rather than chased: a `${...}` interpolation inside a template literal
 *  re-enters real code (real braces), which this simple quote-tracking state machine does not
 *  model — a manager body containing a template literal with an interpolated `{`/`}` could still
 *  mis-balance. Believed rare enough in this codebase's manager bodies to accept; the CENSUS test
 *  below covers the risk (a body ManagerDef reference. */
function matchingBrace(src: string, openIdx: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\') { i++; continue; } // skip the escaped character, whatever it is
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return src.length - 1;
}

interface AppManagerWithDispose {
  name: string;
  file: string;
  /** Local identifier(s) this manager instance is bound to, e.g. `timeManager` for
   *  `export const timeManager: TimeManager = new TimeManagerImpl()`, or the object-literal's own
   *  binding identifier (`inputSourcesManager`). Used to recognize the `unregisterManager(x.name)`
   *  idiom without matching an unrelated manager's `.name` call — see `hasProductionUnregisterCaller`. */
  idents: string[];
  /** Which scanner found this — gates whether `idents` is trusted for the var-form
   *  `unregisterManager(<ident>.name)` match. See `hasProductionUnregisterCaller`. */
  kind: 'object-literal' | 'class';
}

/** Every raw `<ident>: ManagerDef = {` object-literal declaration in `src`, regardless of scope or
 *  dispose — used both to build the dispose-reachability list (filtered further by the caller) and
 *  by the CENSUS test to know which `ManagerDef` references are legitimately accounted for. */
function scanObjectLiteralDecls(src: string): Array<{ ident: string; openIdx: number; closeIdx: number; matchIdx: number }> {
  const out: Array<{ ident: string; openIdx: number; closeIdx: number; matchIdx: number }> = [];
  const declRe = /(\w+)\s*:\s*ManagerDef\s*=\s*\{/g;
  for (const m of src.matchAll(declRe)) {
    const openIdx = m.index! + m[0].length - 1; // index of the `{`
    out.push({ ident: m[1], openIdx, closeIdx: matchingBrace(src, openIdx), matchIdx: m.index! });
  }
  return out;
}

/** Every raw `class <Ident> implements ManagerDef {` declaration in `src`, regardless of scope or
 *  dispose — same split-for-reuse reasoning as `scanObjectLiteralDecls`. */
function scanClassDecls(src: string): Array<{ className: string; openIdx: number; closeIdx: number; matchIdx: number }> {
  const out: Array<{ className: string; openIdx: number; closeIdx: number; matchIdx: number }> = [];
  const declRe = /class\s+(\w+)\s+implements\s+ManagerDef\s*\{/g;
  for (const m of src.matchAll(declRe)) {
    const openIdx = m.index! + m[0].length - 1; // index of the class body's opening `{`
    out.push({ className: m[1], openIdx, closeIdx: matchingBrace(src, openIdx), matchIdx: m.index! });
  }
  return out;
}

/** Every `ManagerDef` object literal (`<ident>: ManagerDef = {`) that declares BOTH `scope: 'app'`
 *  and a `dispose`, with the manager's `name`, its binding identifier, and the file it's defined
 *  in. */
function findObjectLiteralManagers(src: string, file: string): AppManagerWithDispose[] {
  const out: AppManagerWithDispose[] = [];
  for (const { ident, openIdx, closeIdx } of scanObjectLiteralDecls(src)) {
    const body = src.slice(openIdx, closeIdx + 1);
    if (!/scope:\s*'app'/.test(body)) continue;
    if (!/dispose\s*[:(]/.test(body)) continue;
    const nameMatch = body.match(/name:\s*'([^']+)'/);
    if (!nameMatch) {
      throw new Error(
        `Found an app-scoped ManagerDef with a dispose in ${file} but couldn't parse its ` +
          `\`name:\` field — the scan regex needs updating, not the allowlist.`,
      );
    }
    // Object-literal bindings are commonly a generic local name (`const manager: ManagerDef = {`,
    // used identically by three separate runtime factories) — trusting it for the var-form
    // `unregisterManager(<ident>.name)` match would let ANY file's unrelated `unregisterManager
    // (manager.name)` "prove" this one is wired. `kind: 'object-literal'` tells
    // `hasProductionUnregisterCaller` to drop the ident form and require the exact string-literal
    // name instead (#517 follow-up — reviewer-verified).
    out.push({ name: nameMatch[1], file, idents: [ident], kind: 'object-literal' });
  }
  return out;
}

/** Every `class <Ident> implements ManagerDef { ... }` that declares BOTH `scope = 'app'`
 *  (optionally `as const`) and a `dispose(` method, with the manager's `name`, the identifier(s)
 *  any `new <Ident>()` instance is exported as, and the file it's defined in. This is the OTHER
 *  declaration form in the repo — `TimeManagerImpl` / `NavigationManagerImpl` use it, and the
 *  object-literal-only scan above is blind to it (#517 follow-up: the guard itself had the same
 *  "looks wired, isn't reached" shape as the bug it polices). */
function findClassManagers(src: string, file: string): AppManagerWithDispose[] {
  const out: AppManagerWithDispose[] = [];
  for (const { className, openIdx, closeIdx } of scanClassDecls(src)) {
    const body = src.slice(openIdx, closeIdx + 1);
    // Quote-agnostic: a `scope = "app"` in double quotes is the same declaration, and a
    // single-quote-only regex would drop the whole manager silently (#534).
    if (!/scope\s*=\s*['"]app['"](\s+as\s+const)?/.test(body)) continue;
    // ⚠️ `dispose(` OR `dispose =` — a CLASS-FIELD ARROW (`dispose = () => { ... }`) is a real
    // ManagerDef dispose and the `dispose\s*\(` form alone is blind to it (#534, recorded during
    // #517's close-out). And the census does NOT backstop this: the census counts `ManagerDef`
    // TYPE references, and such a class still writes `implements ManagerDef`, so `scanClassDecls`
    // finds it, the census counts it as accounted, and only this predicate decides whether it is
    // ever checked for reachability. A member-shape gap is invisible to a declaration-form census.
    if (!/dispose\s*[(=]/.test(body)) continue;
    const nameMatch = body.match(/name\s*=\s*['"]([^'"]+)['"]/);
    if (!nameMatch) {
      throw new Error(
        `Found an app-scoped class ManagerDef (${className}) with a dispose in ${file} but ` +
          `couldn't parse its \`name = '...'\` field — the scan regex needs updating, not the ` +
          `allowlist.`,
      );
    }
    // The singleton this class is instantiated as — e.g. `export const timeManager: TimeManager =
    // new TimeManagerImpl();` binds identifier `timeManager` to `class TimeManagerImpl`. Class-bound
    // idents are specific to this manager (derived from a `new <ClassName>()` call), unlike the
    // generic object-literal binding name above, so the var-form match stays trusted here.
    const idents = [...src.matchAll(new RegExp(`const\\s+(\\w+)\\s*[:=][^;]*new\\s+${className}\\s*\\(`, 'g'))]
      .map((im) => im[1]);
    out.push({ name: nameMatch[1], file, idents, kind: 'class' });
  }
  return out;
}

/** Every app-scoped `ManagerDef` with a `dispose`, from EITHER declaration form the repo uses
 *  (`x: ManagerDef = { ... }` object literals, or `class X implements ManagerDef { ... }`), with
 *  the manager's `name` and the file it's defined in. Comments are stripped first so a `scope:
 *  'app'`/`dispose` mentioned only in prose can't create a false positive or negative — the same
 *  discipline `scanForMatch` below already applies. */
function findAppScopedManagersWithDispose(): AppManagerWithDispose[] {
  const out: AppManagerWithDispose[] = [];
  for (const file of listRuntimeFiles(RUNTIME_DIR)) {
    const rel = path.relative(REPO, file);
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    out.push(...findObjectLiteralManagers(src, rel));
    out.push(...findClassManagers(src, rel));
  }
  return out;
}

/** Whether ANY production (non-test) source under the repo calls `unregisterManager('<name>')` (or
 *  its plural form `unregisterManagers([...])`) — or `unregisterManager(<ident>.name)` for one of
 *  this manager's own CLASS-bound binding identifiers — as actual code, not merely mentions it in a
 *  comment. */
function hasProductionUnregisterCaller(name: string, idents: string[], kind: 'object-literal' | 'class'): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Two idioms cover every real call site: a string literal (`unregisterManager('foo')`), and the
  // variable idiom every one of the five current production callers actually uses
  // (`unregisterManager(someManager.name)`). The variable form is tied to THIS manager's own
  // binding identifier(s) (not just any `\w+.name` call) — a bare identifier match would collide
  // across unrelated managers, e.g. `unregisterManager(chessManager.name)` would otherwise "prove"
  // engine.time is wired too. It is FURTHER restricted to `kind: 'class'` — an object-literal's
  // binding is commonly a generic local name (`manager`, shared verbatim by three separate runtime
  // factories: zoneEventBus.ts, physicsEventBus.ts, timelineEventBus.ts), so trusting it here would
  // let any unrelated file's `unregisterManager(manager.name)` "prove" every one of them wired
  // (#517 follow-up, reviewer-verified). A false NEGATIVE (guard stays green when a teardown
  // exists) is the safe direction if an identifier is renamed without updating this list; matching
  // a bare `unregisterManager(` with no argument shape at all would be too loose and isn't done
  // here.
  const identAlts = kind === 'class' ? idents.map((i) => i.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') : '';
  const varForm = identAlts ? `|(?:${identAlts})\\.name\\s*\\)` : '';
  const nameOrIdent = `(?:['"\`]${escaped}['"\`]${varForm})`;
  // Singular: `unregisterManager('foo')` / `unregisterManager(someManager.name)`.
  // Plural: `unregisterManagers([..., 'foo', ...])` / `unregisterManagers([..., x.name, ...])` — the
  // array can hold other elements before this manager's own, so allow up to 500 chars of anything-
  // but-`]` between the opening bracket and the match. Zero production callers use the plural form
  // today (verified), but a manager torn down that way must not report unreachable and invite a
  // wrong allowlist entry.
  const re = new RegExp(`unregisterManagers?\\(\\s*(?:\\[[^\\]]{0,500})?${nameOrIdent}`);
  // Same scope as the issue's own audit: engine app/game code, excluding tests. `floor: 0`
  // deliberately — a checkout shipping no games/demos (the public OSS snapshot) must still scan
  // `engine/` alone rather than fail COLLECTION; this helper has no module-scope non-vacuity pin
  // of its own because the found-a-match / found-nothing question it answers is only ever "does
  // any caller's own manager-name regex appear somewhere in this scan", which the guard's OTHER
  // sanity test (`found a plausible number of app-scoped managers with dispose`) already backstops.
  return scanForMatch(re);
}

function scanForMatch(re: RegExp): boolean {
  const files = repoFiles({
    under: ['engine', 'games', 'demos'],
    match: (rel) => /\.tsx?$/.test(rel) && !rel.includes('.test.') && !rel.includes('/tests/'),
    floor: 0,
  });
  for (const { abs } of files) {
    const src = stripComments(fs.readFileSync(abs, 'utf8'));
    if (re.test(src)) return true;
  }
  return false;
}

/**
 * App-scoped managers with a `dispose` that nothing in production calls `unregisterManager` for,
 * each with the VERIFIED reason it's fine — a list of managers confirmed app-lifetime by design,
 * NOT a list of exemptions. Adding a name here without verifying (by reading the register/
 * unregister call sites, same as this file's own scan) defeats the guard: it makes the test green
 * while the underlying defect — a disposer nothing ever reaches — still exists.
 *
 * ⚠️ THESE THREE ARE PERMANENT, and #534 is the reason to stop re-litigating them. That issue
 * built the missing inverse — a `teardownAll()` unregistering all three by name and re-arming the
 * latch — wired it to `App`'s unmount cleanup, and then REMOVED it, because the measurement showed
 * the trigger could never fire with anything registered and, more fundamentally, that this
 * architecture has no surviving-realm shutdown for such a path to serve:
 *
 *   Every end-of-lifetime here is a REALM DEATH. The OS kills the process on mobile; the tab
 *   closes on web; restart and OTA go through `location.reload()` (`engine.reload`,
 *   runtime/actions/engineActions.ts); even the editor's project switch is a `webContents.reload()`
 *   (`setProject`, engine/electron/main.ts). None of them leave a realm behind, so none of them
 *   want a teardown. There is one `createRoot` (main.tsx) and no `.unmount()` anywhere in the repo.
 *
 * So `dispose` on these three is unreachable in production BY DESIGN, not by omission, and this
 * list is the honest record of that rather than a backlog. Do NOT empty it by wiring a new
 * teardown path; that was tried, measured and reverted. It would only become emptiable if a SOFT
 * restart is ever built (tear down and re-register in place, instead of reloading) — and then the
 * bar is to assert the teardown observes `registered === true`, not merely that it was called.
 * Reasoning: docs/managers-and-systems.md.
 */
const APP_LIFETIME_BY_DESIGN: Record<string, string> = {
  // Window-level input listeners (keyboard/gamepad/pointer/touch-control/gesture) are one fixed
  // set for the whole process. `dispose` exists for the `ManagerDef` contract and for
  // `__resetManagersForTesting`. Nothing in production unregisters it, and nothing should — see
  // the block above (#517, re-measured and settled in #534).
  Input: 'engine/packages/modoki/src/runtime/input/inputSources.ts — verified app-lifetime, #517/#534',
  // dispose() unsubscribes the onPlayStateChange/onWorldSwap listeners init() installed and drops
  // its three read sources (deltaTime, timeSinceGameStart, timeSinceSceneLoad) — process-global
  // state, same shape as 'Input'.
  'engine.time':
    'engine/packages/modoki/src/runtime/managers/TimeManager.ts — verified app-lifetime, #517/#534',
  // dispose() drops the 'canGoBack' read source and clears the history stack — again process-global.
  'engine.navigation':
    'engine/packages/modoki/src/runtime/managers/NavigationManager.ts — verified app-lifetime, #517/#534',
};// ── CENSUS: every textual `ManagerDef` reference must be accounted for (#517 follow-up 2) ────────
//
// The two scanners above only recognize two specific declaration SHAPES. Any OTHER shape — a
// sub-interface (`interface FooManager extends ManagerDef`) with `class X implements FooManager`,
// `implements ManagerDef, Y`, a generic class, `satisfies ManagerDef`, `as ManagerDef`, a factory
// function returning a `ManagerDef`, a `const arr: ManagerDef[] = [...]` — is invisible to them,
// and a scanner blind to a form has no way to know it missed something. The census below is the
// structural backstop: it finds every textual `ManagerDef` reference in the scanned tree (comments
// stripped) and requires each one to be either a hit from a scanner above, or named in
// `NOT_A_MANAGER_DECLARATION` with a verified reason (a type-only re-export, a function signature
// that merely ACCEPTS/RETURNS a `ManagerDef`, not one that declares an instance). An unaccounted
// reference fails LOUD — see the assertion message below — rather than silently doing nothing,
// which is exactly the failure mode that let this guard go wrong twice already.

/** Every match of the five textual forms the reviewer's audit named: `implements ManagerDef`,
 *  `: ManagerDef` (a bare type-annotation, catching factories/params/fields/generics alike),
 *  `satisfies ManagerDef`, `as ManagerDef`, `extends ManagerDef`. Deliberately broad — the point of
 *  the census is to see EVERYTHING, then explain each one, not to pre-filter. */
const CENSUS_REF_RE = /\b(?:implements|satisfies|as|extends)\s+ManagerDef\b|:\s*ManagerDef\b/g;

/** How many raw `ManagerDef` references appear in `src`, per the broad census regex above. */
function countCensusRefs(src: string): number {
  return [...src.matchAll(CENSUS_REF_RE)].length;
}

/** How many of those references fall inside a span the two scanners above already recognize as a
 *  declaration (the object-literal's `ident: ManagerDef = {` match, or the class's
 *  `implements ManagerDef {` match) — regardless of scope/dispose, since the census is about
 *  ACCOUNTING for the reference textually, not about whether it happens to be app-scoped. */
function countScannerAccountedRefs(src: string): number {
  let n = 0;
  // Each object-literal declaration's own `: ManagerDef =` is exactly one census match, at the
  // declaration's matchIdx.
  n += scanObjectLiteralDecls(src).length;
  // Each class declaration's own `implements ManagerDef` is exactly one census match.
  n += scanClassDecls(src).length;
  return n;
}

/** References that are legitimately NOT a manager declaration, keyed by file (relative to REPO)
 *  with the exact count of such references in that file and a verified reason. A file's total
 *  census references minus its scanner-accounted references must equal EXACTLY this count — a
 *  mismatch (fewer OR more) fails loud: fewer means this allowlist entry is stale (someone removed
 *  a reference — tighten the count), more means an unrecognized declaration form appeared (teach
 *  the scanner that form, don't just bump the count).
 *
 *  Verified by reading each file at the time this census was added (#517 follow-up 2) — every entry
 *  below is a plain type-signature usage (a function accepting/returning `ManagerDef`, or an
 *  `interface X extends ManagerDef` that is a type-only re-export whose actual class declares
 *  `implements ManagerDef` directly and IS caught by the class scanner). */
const NOT_A_MANAGER_DECLARATION: Record<string, { count: number; reason: string }> = {
  'engine/packages/modoki/src/runtime/managers/managerRegistry.ts': {
    count: 5,
    reason:
      "the registry's own type signatures — `Entry.def`, `sceneMatches`/`gameMatches`/" +
      '`registerManager` params, and `registerManagers(defs: ManagerDef[])` — accept/hold a ' +
      '`ManagerDef`, they do not declare one. ' +
      // ⚠️ 6 → 5 when #518 met this guard in a merge, and NOT by tuning a number to green:
      // `addActions` used to be the sixth, taking `(def: ManagerDef)`. #518 changed it to
      // `(entry: Entry)` so it can read `entry.pendingInit`, which removed the reference. This
      // guard was written on `main` against the OLD signature while #518 changed it on a worker
      // branch — each side green alone, red only once merged. That is this allowlist's structural
      // hazard, not a one-off: it freezes a MEASUREMENT of code another branch is free to change.
      'ADDING to this count needs the same scrutiny as adding a file — say which reference and why.',
  },
  'engine/packages/modoki/src/runtime/zones/zoneEventBus.ts': {
    count: 1,
    reason:
      "`createZoneEventBus`'s return-type annotation (`{ events: ZoneEventBus; manager: ManagerDef }`) " +
      "— the actual declaration is the `const manager: ManagerDef = {` a few lines below, which the " +
      'object-literal scanner already accounts for.',
  },
  'engine/packages/modoki/src/runtime/physics/physicsEventBus.ts': {
    count: 1,
    reason: "`createPhysicsEventBus`'s return-type annotation — same shape as zoneEventBus.ts.",
  },
  'engine/packages/modoki/src/runtime/timeline/timelineEventBus.ts': {
    count: 1,
    reason: "`createTimelineEventBus`'s return-type annotation — same shape as zoneEventBus.ts.",
  },
  'engine/packages/modoki/src/runtime/managers/TimeManager.ts': {
    count: 1,
    reason:
      "`export interface TimeManager extends ManagerDef` is a type-only re-export for callers that " +
      'want the richer public type; the actual manager instance is `class TimeManagerImpl implements ' +
      "ManagerDef`, which the class scanner already accounts for. This is exactly the sub-interface " +
      'shape the reviewer flagged as the likely next miss (#517 follow-up) — verified NOT a second, ' +
      'independent manager declaration.',
  },
  'engine/packages/modoki/src/runtime/managers/NavigationManager.ts': {
    count: 1,
    reason: '`export interface NavigationManager extends ManagerDef` — same shape as TimeManager.ts.',
  },
};

describe('every ManagerDef textual reference is accounted for (#517 follow-up 2 — census backstop)', () => {
  it('every ManagerDef reference in runtime/** is either a recognized declaration or a verified non-declaration', () => {
    const mismatches: string[] = [];
    for (const file of listRuntimeFiles(RUNTIME_DIR)) {
      const rel = path.relative(REPO, file).split(path.sep).join('/');
      const src = stripComments(fs.readFileSync(file, 'utf8'));
      const total = countCensusRefs(src);
      if (total === 0) continue;
      const accounted = countScannerAccountedRefs(src);
      const allowed = NOT_A_MANAGER_DECLARATION[rel]?.count ?? 0;
      const unexplained = total - accounted - allowed;
      if (unexplained !== 0) {
        mismatches.push(
          `${rel}: ${total} textual ManagerDef reference(s), ${accounted} recognized as a ` +
            `declaration, ${allowed} allowlisted — ${unexplained > 0 ? unexplained : -unexplained} ` +
            `${unexplained > 0 ? 'UNEXPLAINED' : 'MISSING (allowlist count is now too high — tighten it)'}.`,
        );
      }
    }
    expect(
      mismatches,
      'A `ManagerDef` was declared/referenced in a form the scanners above do not recognize — this ' +
        'is this guard\'s known weak point (it has been wrong in this exact direction twice before, ' +
        '#517). The fix is to teach the relevant scanner (findObjectLiteralManagers / ' +
        'findClassManagers / scanObjectLiteralDecls / scanClassDecls) that declaration form, NOT to ' +
        'add the file to NOT_A_MANAGER_DECLARATION unless the reference is verified to genuinely not ' +
        'be a manager declaration (read the file, same discipline as this guard\'s own scan).',
    ).toEqual([]);
  });
});

describe('every app-scoped ManagerDef.dispose is reachable from production (#517)', () => {
  const found = findAppScopedManagersWithDispose();

  it('found a plausible number of app-scoped managers with dispose (sanity: the parse works)', () => {
    expect(found.length).toBeGreaterThan(0);
  });

  it('every app-scoped manager.dispose is wired to unregisterManager or verified in the allowlist', () => {
    const unreachable = found.filter(
      (mgr) =>
        !(mgr.name in APP_LIFETIME_BY_DESIGN) && !hasProductionUnregisterCaller(mgr.name, mgr.idents, mgr.kind),
    );
    expect(
      unreachable,
      'These app-scoped ManagerDefs (name + defining file) declare a `dispose` that nothing in ' +
        'production reaches: managerRegistry.deactivate() only runs dispose via unregisterManager(name) ' +
        'or a re-register of the same name, and an app-scoped manager has no other teardown trigger. ' +
        'Fix it one of two ways: (1) wire a real `unregisterManager(\'<name>\')` call into the ' +
        'appropriate app-teardown path, or (2) if the manager is genuinely app-lifetime by design, add ' +
        'it to APP_LIFETIME_BY_DESIGN above with a one-line verified reason — never add a name on ' +
        'assumption.',
    ).toEqual([]);
  });
});
