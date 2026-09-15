import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { readScannedSource } from '@modoki/engine/testing';
import { importBindings, importsIn, parseSource, readsOf, ts } from '@modoki/engine/testing/sourceAst';
import { hasInternalGames } from '../helpers/repoLayout';
import { repoFiles } from '../../scripts/repoCorpus.mjs';

/**
 * A `--target playable` build ALIASES every `@<game>/app-services` import to
 * `engine/plugins/playable-appservices-stub.ts` (see `engine/vite.config.ts`), so an ad creative
 * ships none of the native SDK weight. The stub therefore has to export every name a game's
 * runtime imports from that package — and when it does not, Rollup fails the build outright:
 *
 *   [MISSING_EXPORT] "track" is not exported by "engine/plugins/playable-appservices-stub.ts"
 *
 * ⚠️ IT FAILS ONLY ON `--target playable`, WHICH NOTHING ROUTINELY RUNS. `npm run verify` cannot
 * see it, the web and native builds are fine, and the whole test suite is green. That is exactly
 * how it broke: `track`/`setTrackProperty` were added to `games/court/runtime/systems.ts` and
 * nothing told the stub. This guard derives the required set from the games rather than from a
 * hand-kept list, so the next export cannot slip through the same gap.
 *
 * It is a CHEAP proxy for the real thing (running the playable build), which costs minutes — so
 * it checks the one failure mode that has actually happened, not that a playable build succeeds.
 *
 * ⚠️ **A SECOND failure mode has actually happened, and the top-level check above cannot see it.**
 * `games/court/runtime/systems.ts` called `auth.getServerTimeMs()` unconditionally; the stub's
 * `auth` namespace object existed (so `stubExports()` — which only matches top-level
 * `export function`/`export const` — was satisfied) but had no `getServerTimeMs` MEMBER. Rollup
 * cannot catch this at all (`auth.getServerTimeMs` is a property read the bundler doesn't verify),
 * so it throws at RUNTIME in the ad: `TypeError: auth.getServerTimeMs is not a function`. The
 * `stubExports`/`requiredNames` check below is therefore extended to also cross-check MEMBERS of
 * each `export const <namespace> = { … }` object in the stub against `<namespace>.<member>` call
 * sites the games actually use — same idea, one level deeper.
 */

const repoRoot = path.resolve(__dirname, '../../..');
const STUB = path.join(repoRoot, 'engine/plugins/playable-appservices-stub.ts');

/** Names the stub actually exports. */
function stubExports(): Set<string> {
  const src = readScannedSource(STUB).code;
  const names = new Set<string>();
  for (const m of src.matchAll(/^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^export\s+(?:const|let|class)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  return names;
}

/** ⚠️ Listed broadly and filtered HERE, not with a `**` pathspec. git's wildmatch made
 *  `games/*\/runtime/**\/*.ts` require an intermediate directory, so it silently skipped
 *  `games/court/runtime/systems.ts` — the very file that broke the build. The first draft of
 *  this guard passed happily with the stub's `track` export renamed away.
 *
 *  `includeUntracked: false` — this guard's own reasoning (below, `git ls-files` lists what is
 *  TRACKED) is a statement about tracked-only semantics being deliberate, not incidental: a
 *  brand-new, not-yet-committed game file legitimately has nothing wired to it yet. `repoFiles()`
 *  already drops a tracked-but-deleted file via its own `statSync().isFile()` filter, which is
 *  what the removed explicit `existsSync` re-check used to do by hand. */
function scannableFiles(): string[] {
  return repoFiles({
    under: ['games', 'demos'],
    match: /\.tsx?$/,
    // The app-services package DEFINES these names; it is not a consumer of the stub.
    exclude: ['packages', 'tests'],
    floor: 0,
    includeUntracked: false,
  }).map((f) => f.rel);
}

/**
 * Names the games ask for, in the two shapes that actually appear:
 *   `import { track } from '@court/app-services'`            — static named import
 *   `import('@court/app-services').then((m) => m.register())` — dynamic member access
 * The second is how `game.ts` wires `registerAppServices`, and it is NOT caught by Rollup at
 * build time — it fails at RUNTIME in the ad, which is worse. Both are covered.
 *
 * Also returns each name's LOCAL alias per file (`import { auth as a }`), keyed the same way,
 * because {@link requiredNamespaceMembers} has to know what a namespace is called INSIDE the file
 * it's scanning, not what the stub calls it.
 */
const APP_SERVICES = /^@[^/]+\/app-services$/;

/** The members a game reads off `import('@x/app-services')`, from the call's own `.then` callback (#1193):
 *  `.then((m) => m.register())` and `.then(({ analytics }) => …)`. The regex this replaced looked for
 *  `m.<name>` within 120 characters of the `import(`, so a callback parameter not called `m`, a member
 *  read past the window and a destructured parameter were each invisible — `games/3d-test`'s
 *  `({ analytics })` was. Any other shape THROWS — a non-`.then` use, a destructure with a rest or a
 *  nested pattern, and a callback parameter read as anything but a CALL of its member, `m.<name>(…)`:
 *  `use(m)`, `const { x } = m`, `const a = m.analytics`, `m.analytics.logEvent()`, `m.analytics!.x()` —
 *  each hands on a member whose OWN members the namespace scan below could not see. A use this cannot
 *  read must not pass as no use. Reads are resolved by symbol (`readsOf`), so a same-named property, key
 *  or shadowing inner binding is not one. NOT read: a static
 *  `export { x } from '@x/app-services'` in game runtime, which binds nothing here (see `importBindings`). */
function dynamicMembers(importCall: ts.Node, rel: string): Array<{ imported: string; local?: string }> {
  const then = importCall.parent;
  const call = then?.parent;
  const cb = call && ts.isCallExpression(call) && ts.isPropertyAccessExpression(then) && then.name.text === 'then'
    ? call.arguments[0] : undefined;
  const param = cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) ? cb.parameters[0]?.name : undefined;
  if (param && ts.isIdentifier(param)) {
    const uses = readsOf(param);
    const calledMember = (u: ts.Identifier): boolean => ts.isPropertyAccessExpression(u.parent) && u.parent.expression === u
      && ts.isCallExpression(u.parent.parent) && u.parent.parent.expression === u.parent;
    const unread = uses.filter((u) => !calledMember(u));
    if (unread.length === 0) return uses.map((u) => ({ imported: (u.parent as ts.PropertyAccessExpression).name.text }));
  }
  if (param && ts.isObjectBindingPattern(param)
    && param.elements.every((el) => !el.dotDotDotToken && ts.isIdentifier(el.name) && (!el.propertyName || ts.isIdentifier(el.propertyName)))) {
    return param.elements.map((el) => ({
      imported: ((el.propertyName ?? el.name) as ts.Identifier).text,
      local: (el.name as ts.Identifier).text,
    }));
  }
  throw new Error(`${rel}: an import() of app-services used in a shape this guard cannot read — teach it `
    + '(it reads `.then((m) => m.x)` and `.then(({ x }) => …)`) rather than letting the use pass unread');
}

function requiredNames(files: readonly string[]): { required: Map<string, string[]>; aliases: Map<string, Map<string, string>> } {
  const out = new Map<string, string[]>();
  const aliases = new Map<string, Map<string, string>>(); // file -> localName -> originalName
  const add = (name: string, where: string) => {
    const list = out.get(name) ?? [];
    if (!list.includes(where)) list.push(where);
    out.set(name, list);
  };

  for (const rel of files) {
    const sf = parseSource(readScannedSource(path.join(repoRoot, rel)).code, rel);
    // Static imports from the parse (#1193). ERASED ones are skipped: `import type { AuthResult }`
    // names nothing the stub must export at runtime, and the regex this replaced never saw them either
    // (`import\s*\{` does not match `import type {`) — but it also missed a wrapped or double-quoted
    // import and a default/namespace one, which would need the whole module.
    for (const b of importBindings(sf, APP_SERVICES)) {
      if (b.typeOnly) continue;
      if (b.imported === '*' || b.imported === 'default') {
        throw new Error(`${rel}: a namespace/default import of app-services (\`${b.local}\`) — this guard reads named `
          + 'imports and `import(…).then(…)` only; teach it this shape rather than letting it pass unread');
      }
      add(b.imported, rel);
      let fileAliases = aliases.get(rel);
      if (!fileAliases) { fileAliases = new Map(); aliases.set(rel, fileAliases); }
      fileAliases.set(b.local, b.imported);
    }
    for (const e of importsIn(sf)) {
      if (e.kind !== 'dynamic' || !APP_SERVICES.test(e.spec)) continue;
      for (const { imported, local } of dynamicMembers(e.node, rel)) {
        add(imported, rel);
        // A destructured member is used by its LOCAL name, like a static named import — so the
        // namespace-member scan below must resolve it (`({ analytics }) => analytics.logEvent(…)`).
        if (local !== undefined) {
          let fileAliases = aliases.get(rel);
          if (!fileAliases) { fileAliases = new Map(); aliases.set(rel, fileAliases); }
          fileAliases.set(local, imported);
        }
      }
    }
  }
  return { required: out, aliases };
}

/**
 * For each `export const <Name> = { … }` object in the stub, the top-level method/property names
 * it defines. Brace-balanced (not a single-line regex) because `crashlytics`/`ads`/`auth` all span
 * many lines and several members return object literals of their own (`PLAYABLE_NO_AUTH`).
 */
function stubNamespaceMembers(): Map<string, Set<string>> {
  const src = readScannedSource(STUB).code;
  const out = new Map<string, Set<string>>();
  for (const m of src.matchAll(/^export const ([A-Za-z_$][\w$]*)\s*=\s*\{/gm)) {
    const name = m[1];
    const bodyStart = m.index! + m[0].length;
    let depth = 1;
    let i = bodyStart;
    while (i < src.length && depth > 0) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') depth--;
      i++;
    }
    const body = src.slice(bodyStart, i - 1);
    const members = new Set<string>();
    // A member declaration line: `foo(...)`, `async foo(...)`, or `foo: value`. Matched against
    // the START of each statement (after a `,`/`{`/newline), not anywhere in the body, so a
    // parameter or a return value never gets mistaken for a member name.
    for (const mm of body.matchAll(/(?:^|[,{]|\n)\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*[(:]/g)) {
      members.add(mm[1]);
    }
    out.set(name, members);
  }
  return out;
}

/**
 * `<namespace>.<member>(` call sites in the games, restricted to namespaces the stub actually
 * defines (so an unrelated local variable that happens to be called `auth` can't false-positive),
 * and resolved through each file's own import aliases.
 */
function requiredNamespaceMembers(
  files: readonly string[],
  aliases: Map<string, Map<string, string>>,
  namespaces: ReadonlySet<string>,
): Map<string, Map<string, string[]>> {
  const out = new Map<string, Map<string, string[]>>(); // namespace -> member -> files
  const add = (namespace: string, member: string, where: string) => {
    let byMember = out.get(namespace);
    if (!byMember) { byMember = new Map(); out.set(namespace, byMember); }
    const list = byMember.get(member) ?? [];
    if (!list.includes(where)) list.push(where);
    byMember.set(member, list);
  };

  for (const rel of files) {
    const fileAliases = aliases.get(rel);
    if (!fileAliases) continue;
    const src = readScannedSource(path.join(repoRoot, rel)).code;
    for (const [localName, originalName] of fileAliases) {
      if (!namespaces.has(originalName)) continue; // not one of the stub's namespace objects
      const re = new RegExp(`\\b${localName}\\.([A-Za-z_$][\\w$]*)\\s*\\(`, 'g');
      for (const m of src.matchAll(re)) add(originalName, m[1], rel);
    }
  }
  return out;
}

describe('dynamicMembers — what an import() of app-services is read as (#1193)', () => {
  const read = (code: string) => {
    const sf = parseSource(code, 'fixture.ts');
    return importsIn(sf).filter((e) => e.kind === 'dynamic').flatMap((e) => dynamicMembers(e.node, 'fixture.ts'))
      .map(({ imported, local }) => (local && local !== imported ? `${imported} as ${local}` : imported));
  };

  it('reads a member off the callback parameter, whatever it is called, and a destructure with aliases', () => {
    expect(read("import('@g/app-services').then(async (svc) => { await svc.register(); svc.track('x'); });")).toEqual(['register', 'track']);
    expect(read("import('@g/app-services').then(({ analytics, auth: a }) => analytics.logEvent(a));")).toEqual(['analytics', 'auth as a']);
  });

  it('does not mistake a same-named property, key or shadowing binding for a read of the parameter', () => {
    expect(read("import('@g/app-services').then((m) => { cfg.m = { m: 1 }; [1].forEach((m) => use(m)); m.register(); });"))
      .toEqual(['register']);
  });

  it.each([
    ['the parameter handed on whole', "import('@g/app-services').then((m) => use(m));"],
    ['the parameter destructured in the body', "import('@g/app-services').then((m) => { const { analytics } = m; analytics.logEvent('x'); });"],
    ['a rest destructure', "import('@g/app-services').then(({ ...rest }) => rest.x());"],
    ['no .then at all', "const m = await import('@g/app-services'); m.register();"],
    ['a chained member, which the namespace scan cannot see', "import('@g/app-services').then((m) => m.analytics.logEvent('x'));"],
    ['a chained member behind a non-null assertion', "import('@g/app-services').then((m) => m.analytics!.logEvent('x'));"],
    ['a member held in a variable', "import('@g/app-services').then((m) => { const a = m.analytics; a.logEvent('x'); });"],
  ])('THROWS on %s — a use it cannot read must not pass as no use', (_label, code) => {
    expect(() => read(code)).toThrow(/cannot read/);
  });
});

/** ⚠️ Gated on `hasInternalGames()`, and the gate is load-bearing rather than defensive.
 *  This guard DERIVES its required set by scanning `games/**` — which is exactly why it is
 *  a good guard here and why it cannot run in the public snapshot, where `games/` is not
 *  shipped at all. There the scan matches nothing, the "guard the guard" assertion below
 *  fires, and a test that is merely inapplicable reads as a real failure on the public gate.
 *  `hasInternalGames()` (not `hasAnyProject()`) is the correct predicate: the snapshot does
 *  ship demos, and no demo has an app-services package for this to find. */
describe.skipIf(!hasInternalGames())('the playable app-services stub keeps up with the games (#269)', () => {
  const files = scannableFiles();
  const { required, aliases } = requiredNames(files);

  it('exports every name a game imports from its app-services package', () => {
    // Guard the guard: if the scan finds nothing, every assertion below is vacuous. At least
    // `register` is always imported — `game.ts` cannot wire `registerAppServices` without it.
    expect(required.size, 'the import scan matched nothing — the queries have gone stale').toBeGreaterThan(0);
    expect([...required.keys()]).toContain('register');
    // …and each READER separately (#1193): `register` arrives only through `game.ts`'s dynamic
    // `import()`, so it proves nothing about the static-import reader — which a mutation emptied with
    // this test still green. `track` is a static named import in Court's systems.ts.
    expect(required.get('track'), 'the static-import scan found no `track` — the reader has gone stale, '
      + 'or Court stopped importing it (then pin another static name)').toContain('games/court/runtime/systems.ts');
    // …and the DESTRUCTURED `.then(({ analytics }) => …)` branch, the one that found the stub missing
    // `analytics` (#1193) — a review emptied it with both tests green.
    expect(required.get('analytics'), 'the destructured-callback scan found no `analytics` in 3d-test — the '
      + 'reader has gone stale, or 3d-test stopped reading it (then pin another destructured use)')
      .toContain('games/3d-test/runtime/config.ts');

    const exported = stubExports();
    const missing = [...required.entries()].filter(([name]) => !exported.has(name));
    expect(
      missing.map(([name, where]) => `${name} (imported by ${where.join(', ')})`),
      'these names would fail a --target playable build with [MISSING_EXPORT]',
    ).toEqual([]);
  });

  it('every namespace object exports every MEMBER a game calls on it', () => {
    const namespaceMembers = stubNamespaceMembers();
    // Guard the guard: the stub currently has several `export const <namespace> = { … }` objects
    // (`auth`, `ads`, `crashlytics`, `serverTime`, `cloudSave`) — if the brace-balanced parser
    // above finds none, every assertion below is vacuous.
    expect(namespaceMembers.size, 'stubNamespaceMembers found no namespace objects — the parser has gone stale').toBeGreaterThan(0);

    const requiredMembers = requiredNamespaceMembers(files, aliases, new Set(namespaceMembers.keys()));
    // Guard the guard, the other direction: the games DO call members on these namespaces
    // (`auth.getServerTimeMs`, `auth.currentUser`, `cloudSave.deleteSave`, `ads.showInterstitial`,
    // `crashlytics.crash`, …) — a scan that found none has gone stale, not a codebase that stopped
    // using them.
    expect(requiredMembers.size, 'the namespace-member scan matched nothing — the queries have gone stale').toBeGreaterThan(0);
    // A destructured dynamic member is scanned by its LOCAL alias (#1193).
    expect(requiredMembers.get('analytics')?.get('logEvent'), 'analytics.logEvent in 3d-test was not scanned — the '
      + 'destructured alias did not reach the member scan').toContain('games/3d-test/runtime/config.ts');

    const missing: string[] = [];
    for (const [namespace, byMember] of requiredMembers) {
      const exportedMembers = namespaceMembers.get(namespace) ?? new Set<string>();
      for (const [member, where] of byMember) {
        if (!exportedMembers.has(member)) {
          missing.push(`${namespace}.${member} (called by ${where.join(', ')})`);
        }
      }
    }
    expect(
      missing,
      'these calls would fail a --target playable build at RUNTIME with "is not a function" — ' +
      'Rollup cannot catch a missing namespace MEMBER the way it catches a missing top-level export',
    ).toEqual([]);
  });
});
