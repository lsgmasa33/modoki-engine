import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { readScannedSource } from '@modoki/engine/testing';
import {
  boundIdentifier, enclosingNamedFunction, findNodes, importBindings, importsIn, lineOf, objectLiteralKeys, parseSource, readsOf, siteText, ts, unwrapValue, valueCarrier,
} from '@modoki/engine/testing/sourceAst';
import { assertExemptionLedger } from '@modoki/engine/testing/exemptionLedger';
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

/** The stub's module-level declarations, parsed once. */
const stubFile = (): ts.SourceFile => parseSource(readScannedSource(STUB).code, STUB);

const hasModifier = (s: ts.Statement, kind: ts.SyntaxKind): boolean =>
  !!ts.canHaveModifiers(s) && !!ts.getModifiers(s)?.some((m) => m.kind === kind);
const isExported = (s: ts.Statement): boolean => hasModifier(s, ts.SyntaxKind.ExportKeyword);
/** The name a declaration is exported UNDER: `export default function register` exports `default`, not
 *  `register` — a game's `import { register }` fails the playable build with [MISSING_EXPORT]. */
const exportedName = (s: ts.Statement, own: string): string => (hasModifier(s, ts.SyntaxKind.DefaultKeyword) ? 'default' : own);

/** One name the stub exports, and what it IS: a function or class (a top-level export Rollup checks), a
 *  namespace OBJECT (whose members `stubNamespaceMembers` reads), or anything else. */
type StubExport = { name: string; is: 'function' | 'namespace' | 'other'; members?: Set<string> };

/**
 * Every name the stub exports, read from its top-level statements (#1195): `export function`/`class`,
 * `export const/let/var` (each declarator), and a local `export { a, b as c }` list — which the column-0
 * `^export\s+(function|const|let|class)` regexes this replaces could not see at all.
 *
 * ⚠️ **ONE table for both checks, and a listed name resolves to its LOCAL declaration** (#1195 P1
 * review). The first cut widened the export reader to the list form and left the member reader on
 * `export const X = {` alone, so `const auth = {…}; export { auth };` counted as exported while its members
 * were never checked: `auth.getServerTimeMs` deleted, green. The two readers must see the same exports.
 */
function stubExportTable(sf: ts.SourceFile = stubFile()): StubExport[] {
  const local = new Map<string, StubExport['is'] | Set<string>>();
  const classify = (d: ts.VariableDeclaration): StubExport['is'] | Set<string> => {
    const keys = objectLiteralKeys(d.initializer);
    if (keys) return new Set(keys);
    const init = d.initializer && unwrapValue(d.initializer);
    return init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) ? 'function' : 'other';
  };
  const out: StubExport[] = [];
  const add = (name: string, what: StubExport['is'] | Set<string> | undefined) => out.push(
    what instanceof Set ? { name, is: 'namespace', members: what } : { name, is: what ?? 'other' });
  for (const s of sf.statements) {
    if ((ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s)) && s.name) {
      local.set(s.name.text, 'function');
      if (isExported(s)) add(exportedName(s, s.name.text), 'function');
    }
    if (ts.isVariableStatement(s)) {
      for (const d of s.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) continue;
        local.set(d.name.text, classify(d));
        if (isExported(s)) add(d.name.text, classify(d));
      }
    }
  }
  for (const s of sf.statements) {
    if (!ts.isExportDeclaration(s) || s.isTypeOnly || s.moduleSpecifier || !s.exportClause || !ts.isNamedExports(s.exportClause)) continue;
    for (const e of s.exportClause.elements) if (!e.isTypeOnly) add(e.name.text, local.get((e.propertyName ?? e.name).text));
  }
  return out;
}

/** Names the stub actually exports. */
function stubExports(sf: ts.SourceFile = stubFile()): Set<string> {
  return new Set(stubExportTable(sf).map((e) => e.name));
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
function dynamicMembers(importCall: ts.Node, rel: string): Array<{ imported: string; local?: string; localId?: ts.Identifier }> {
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
      localId: el.name as ts.Identifier,
    }));
  }
  throw new Error(`${rel}: an import() of app-services used in a shape this guard cannot read — teach it `
    + '(it reads `.then((m) => m.x)` and `.then(({ x }) => …)`) rather than letting the use pass unread');
}

/** One binding a game file holds of an app-services export: the IDENTIFIER that declares it locally (an
 *  import specifier's name, or a destructured `.then` parameter's), and the name the package exports. */
type ServiceBinding = { id: ts.Identifier; imported: string };

function requiredNames(files: readonly string[]): { required: Map<string, string[]>; aliases: Map<string, ServiceBinding[]> } {
  const out = new Map<string, string[]>();
  const aliases = new Map<string, ServiceBinding[]>(); // file -> the bindings it holds
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
      const id = findNodes(b.edge.node, ts.isIdentifier).find((n) => n.text === b.local && ts.isImportSpecifier(n.parent) && n.parent.name === n);
      if (!id) throw new Error(`${rel}: could not locate the binding of \`${b.local}\` in its import — the member scan could not resolve its reads`);
      aliases.set(rel, [...(aliases.get(rel) ?? []), { id, imported: b.imported }]);
    }
    for (const e of importsIn(sf)) {
      if (e.kind !== 'dynamic' || !APP_SERVICES.test(e.spec)) continue;
      for (const { imported, localId } of dynamicMembers(e.node, rel)) {
        add(imported, rel);
        // A destructured member is used by its LOCAL binding, like a static named import — so the
        // namespace-member scan below must resolve it (`({ analytics }) => analytics.logEvent(…)`).
        if (localId !== undefined) aliases.set(rel, [...(aliases.get(rel) ?? []), { id: localId, imported }]);
      }
    }
  }
  return { required: out, aliases };
}

/**
 * For each exported namespace OBJECT in the stub (see `stubExportTable`), the top-level member names it
 * defines — the object literal's own keys, from the parser (#1195): `foo: v`, `foo() {}`, `async foo() {}`, a
 * `{ foo }` shorthand. It was a brace count from a column-0 `export const X = {` plus a member regex at each
 * statement start, which a brace inside a string moved and which also credited parameter names, `return`
 * and nested literals' keys as members. A spread comes back as `'...'`, which no call names — so a member
 * supplied only through one reads as missing, loudly, rather than as present on a guess.
 */
function stubNamespaceMembers(sf: ts.SourceFile = stubFile()): Map<string, Set<string>> {
  return new Map(stubExportTable(sf).filter((e) => e.members).map((e) => [e.name, e.members!]));
}

/** What `scanMemberCalls` found: the members each export is called with, and every read of a binding it
 *  could NOT follow — which the guard counts on a ledger rather than letting pass as "no members". */
type MemberScan = {
  required: Map<string, Map<string, string[]>>; // export -> member -> files
  handedOn: Array<{ item: string; site: string }>;
};

/** A `<receiver>.<member>(…)` call on `receiver` — through `?.`, and past `!`/`as`/parentheses around the
 *  receiver — returns the member's name. */
function calledMemberOf(receiver: ts.Expression): string | undefined {
  const carrier = valueCarrier(receiver);
  const access = carrier.parent;
  return access && ts.isPropertyAccessExpression(access) && access.expression === carrier
    && ts.isCallExpression(access.parent) && access.parent.expression === access ? access.name.text : undefined;
}

/** The function a read is RETURNED from, when its value flows straight out: `return x`, `return c ? { ...x } : x`,
 *  a concise arrow's body — so the calls on that function's result are calls on `x`. Only the NAMED function the
 *  `return` belongs to: a `return` inside an anonymous callback (`registerProvider(() => auth)`) returns to that
 *  callback's caller, not from the named function around it (#1195 P2 close-out review). */
function returnedBy(read: ts.Expression): { name: string; node: ts.Node } | undefined {
  let cur: ts.Node = valueCarrier(read);
  for (;;) {
    const p = cur.parent;
    if (!p) return undefined;
    if (ts.isConditionalExpression(p) && (p.whenTrue === cur || p.whenFalse === cur)) cur = p;
    else if (ts.isSpreadAssignment(p)) cur = p.parent;
    else if (ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isSatisfiesExpression(p) || ts.isNonNullExpression(p)) cur = p;
    else if (ts.isReturnStatement(p) || (ts.isArrowFunction(p) && p.body === cur)) {
      const own = ts.isReturnStatement(p) ? ts.findAncestor(p.parent, ts.isFunctionLike) : p;
      const named = enclosingNamedFunction(ts.isReturnStatement(p) ? p : cur);
      return named && named.node === own ? named : undefined;
    }
    else return undefined;
  }
}

/**
 * `<export>.<member>(…)` calls in the games, for each binding a file holds of an export in `exported`: every
 * READ of that binding, by symbol (`readsOf`), that is the object of a called member.
 *
 * ⚠️ **By symbol, not by name (#1195 P1 re-review).** This was `\b<local>\.(\w+)\s*\(` over the whole
 * file, restricted to the stub's namespace OBJECTS so that "an unrelated local variable that happens to be
 * called `auth` can't false-positive". The restriction also skipped every namespace written any other way
 * (`export class serverTime {}`), whose calls then went unchecked. Widened to every export, the name regex
 * credited Court's `track: string` PARAMETER's `track.slice(…)` and `track.toUpperCase(…)` to the imported
 * `track` function. Resolved by symbol, a shadowing local is not the import, so no restriction is needed.
 *
 * ⚠️ **One rule for every place the value goes, and whatever it cannot follow is COUNTED** (#1195 P1, four
 * review rounds). Each round found one more path the value took — returned from `accountAuth()`, then that
 * result stored in `const a` — and each was a SILENT drop, because a shape the scan did not model yielded
 * no members and no report. So a value (the binding's read, or anything it flows into) is:
 * - the object of a member call (`auth.x()`, `auth?.x()`, `auth!.x()`) — the member is required;
 * - called directly (`track(…)`) or in a `typeof` — no member;
 * - bound by `const a = …` — then each read of `a` is followed the same way;
 * - RETURNED from a named function (`return c ? { ...auth, ...o } : auth`, a concise arrow's body) — then each
 *   call of that function is followed the same way. Wordweave's account calls go through `accountAuth()` and a
 *   `const a = accountAuth()` from it. Only while every call can be SEEN: a returner with no call in the file (an
 *   accessor, one reached through an alias), or one the file exports (its other callers are in other files), is
 *   handed on instead — following zero calls would yield no members and no row (#1195 P2 close-out review);
 * - anything else, or deeper than `MAX_HOPS` — HANDED ON (`{ auth, cloudSave }`, an argument, an element
 *   access). It is counted on a ledger so a new one fails until someone reads it — `dynamicMembers`' rule: a
 *   use this cannot read must not pass as no use — and its binding is also followed by NAME over the file,
 *   which finds calls through a receiver spelled like the import and nothing else.
 */
function scanMemberCalls(aliases: Map<string, ServiceBinding[]>, exported: ReadonlySet<string>): MemberScan {
  const required = new Map<string, Map<string, string[]>>();
  const add = (name: string, member: string, where: string) => {
    let byMember = required.get(name);
    if (!byMember) { byMember = new Map(); required.set(name, byMember); }
    const list = byMember.get(member) ?? [];
    if (!list.includes(where)) list.push(where);
    byMember.set(member, list);
  };
  const handedOn: MemberScan['handedOn'] = [];
  for (const [rel, bindings] of aliases) {
    for (const { id, imported } of bindings) {
      if (!exported.has(imported)) continue; // a missing export is the top-level check's to report
      const sf = id.getSourceFile();
      let byName = false;
      const follow = (value: ts.Expression, hops: number): void => {
        if (ts.findAncestor(value, ts.isTypeQueryNode)) return;
        const member = calledMemberOf(value);
        if (member !== undefined) { add(imported, member, rel); return; }
        const carrier = valueCarrier(value);
        if (ts.isCallExpression(carrier.parent) && carrier.parent.expression === carrier) return;
        if (hops < MAX_HOPS) {
          const bound = boundIdentifier(value);
          if (bound) { for (const read of readsOf(bound)) follow(read, hops + 1); return; }
          const fn = returnedBy(value);
          const calls = fn ? returnerCalls(fn.node) : undefined;
          if (calls) { for (const call of calls) follow(call, hops + 1); return; }
        }
        byName = true;
        const where = enclosingNamedFunction(value)?.name ?? '<module>';
        handedOn.push({ item: `${rel}::${imported} in ${where} > \`${siteText(value)}\``, site: `${rel}:${lineOf(value)}` });
      };
      for (const use of readsOf(id)) follow(use, 0);
      if (byName) {
        const name = id.text.replace(/[$]/g, '\\$&');
        for (const m of sf.text.matchAll(new RegExp(`(?<![\\w$])${name}\\s*\\.\\s*([A-Za-z_$][\\w$]*)\\s*\\(`, 'g'))) add(imported, m[1]!, rel);
      }
    }
  }
  return { required, handedOn };
}

/** Every call of returner `fn`, when ALL of its calls can be seen: it is bound to a name in this file (a
 *  declaration, or `const f = () => …`), not visible outside the file, and EVERY read of that binding — resolved by
 *  symbol — is a direct call. Otherwise `undefined`, and the value is handed on: an object-literal member or a
 *  getter has no binding to resolve, and a read that is not a call (`export default f`, `const g = f`,
 *  `registerProvider(f)`) takes the function somewhere this file cannot follow (#1195 P2 §2d re-review: a by-NAME
 *  `callsTo` also followed `firebase.auth()` as a call of a getter named `auth`). */
function returnerCalls(fn: ts.Node): ts.CallExpression[] | undefined {
  const id = ts.isFunctionDeclaration(fn) ? fn.name
    : (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name) ? fn.parent.name
      : undefined;
  if (!id || isVisibleOutsideFile(fn)) return undefined;
  const reads = readsOf(id);
  const calls = reads.map((r) => { const c = valueCarrier(r); return ts.isCallExpression(c.parent) && c.parent.expression === c ? c.parent : undefined; });
  return reads.length > 0 && calls.every((c) => c !== undefined) ? calls as ts.CallExpression[] : undefined;
}

/** Whether the function `fn` is visible outside its file: `export function`, `export const f = …`, a class member
 *  of an exported class, or named in an `export { … }` list. */
function isVisibleOutsideFile(fn: ts.Node): boolean {
  const hasExport = (n: ts.Node | undefined) => !!n && ts.canHaveModifiers(n) && !!ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  const holder = ts.isVariableDeclaration(fn.parent) ? fn.parent.parent.parent : ts.isClassLike(fn.parent) ? fn.parent : fn;
  if (hasExport(holder)) return true;
  const name = ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name) ? fn.parent.name.text
    : (fn as ts.Node & { name?: ts.Node }).name && ts.isIdentifier((fn as ts.Node & { name: ts.Node }).name) ? ((fn as ts.Node & { name: ts.Identifier }).name).text : undefined;
  return !!name && findNodes(fn.getSourceFile(), ts.isExportSpecifier).some((sp) => (sp.propertyName ?? sp.name).text === name);
}

/** The member calls the stub cannot answer: a required member absent from that export's object literal —
 *  which includes EVERY member of an export that is not an object literal at all. */
function missingMembers(required: MemberScan['required'], namespaceMembers: Map<string, Set<string>>): string[] {
  const missing: string[] = [];
  for (const [name, byMember] of required) {
    const exportedMembers = namespaceMembers.get(name) ?? new Set<string>();
    for (const [member, where] of byMember) {
      if (!exportedMembers.has(member)) missing.push(`${name}.${member} (called by ${where.join(', ')})`);
    }
  }
  return missing;
}

/** How many times a value is followed through a `const` or a returning function before it counts as handed
 *  on — wordweave's deepest real path is two (`accountAuth()` returns it, `const a = accountAuth()`). */
const MAX_HOPS = 3;

/** The whole member check over one stub: scan the member calls on EVERY export the stub has, and report the
 *  ones it cannot answer. The real test and the fixtures both go through this, so the choice of names
 *  scanned is pinned — restricting it to the namespace objects again is red on a fixture. */
function memberCheck(aliases: Map<string, ServiceBinding[]>, stub: ts.SourceFile = stubFile()): MemberScan & { missing: string[] } {
  const scan = scanMemberCalls(aliases, stubExports(stub));
  return { ...scan, missing: missingMembers(scan.required, stubNamespaceMembers(stub)) };
}

const flatMembers = (scan: MemberScan): string[] =>
  [...scan.required].flatMap(([name, byMember]) => [...byMember.keys()].map((m) => `${name}.${m}`)).sort();

/** Hand-ons that were read by a person — each pardons ONE read, keyed by its function and site.
 *
 *  ⚠️ **A pardon here means "UNCHECKED, knowingly", not "checked by name".** The name fallback only finds a
 *  call whose receiver is still spelled like the import; rename the receiver and those calls leave the
 *  guard with nothing failing (probed in review: `makeTransport(store)` + `store.pushSaveNope()`, green).
 *  Both rows below hold today only because Court also calls every one of these members directly, so the
 *  stub is required to have them anyway. */
const HANDED_ON_REVIEWED = [
  {
    item: "games/court/runtime/cloudSyncWiring.ts::auth in startCloudSync > `auth`",
    reason: 'the default of `options.services ?? { auth, cloudSave }` (#674 injection). Its calls go through '
      + '`services.auth.<member>(…)`, which the name fallback happens to read; a renamed receiver would not be.',
  },
  {
    item: "games/court/runtime/cloudSyncWiring.ts::cloudSave in startCloudSync > `cloudSave`",
    reason: 'the same default. `makeTransport(services.cloudSave)` calls it through a parameter spelled `cloudSave`, '
      + 'which the name fallback happens to read; a renamed parameter would not be.',
  },
  {
    item: "games/wordweave/runtime/cloudSyncWiring.ts::auth in startCloudSync > `auth`",
    reason: 'Weaveling\'s port of the same default (#679). Its calls go through `services.auth.<member>(…)`, which the '
      + 'name fallback happens to read; a renamed receiver would not be.',
  },
  {
    item: "games/wordweave/runtime/cloudSyncWiring.ts::cloudSave in startCloudSync > `cloudSave`",
    reason: 'the same default. `makeTransport(services.cloudSave)` calls it through a parameter spelled `cloudSave`, '
      + 'which the name fallback happens to read; a renamed parameter would not be.',
  },
  {
    item: "games/court/runtime/debugTab.tsx::ads in <module> > `export const CourtAdsTab = createAdsDebugTab(ads.adsDebug);`",
    reason: 'the Ads debug tab (#1501). `ads.adsDebug` is handed to the ENGINE\'s `createAdsDebugTab`, which calls it '
      + 'through the `AdDebug` interface (`debug.status()` …) — outside every game file, so no scan here can follow it. '
      + 'The stub carries `ads.adsDebug` with every `AdDebug` member; they run only when a debug menu renders the tab, '
      + 'which a playable never has.',
  },
  {
    item: "games/wordweave/runtime/debugTab.tsx::ads in <module> > `export const WordweaveAdsTab = createAdsDebugTab(ads.adsDebug);`",
    reason: 'Weaveling\'s copy of the same tab (#1474, shared since #1501) — the same handoff into the engine, safe for the same reason.',
  },
] as const;

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

  it('reads a namespace object\'s OWN members and every export form — not a parameter, a `return` or a nested literal\'s key (#1195)', () => {
    // Measured on the real stub when this moved to the parser: the per-statement regex credited `auth` with
    // `ok`, `user` and `return`, `notifications` with `scheduled`, and three namespaces with a parameter name
    // (`_value`, `_doc`) — so a game calling `auth.user(…)` passed against a stub with no such member.
    const sf = parseSource([
      'export const auth = {',
      "  async signIn(_value: string) { return { ok: true, user: null }; },",
      "  label: '} not the end',",
      '  currentUser,',
      '};',
      'const local = 1;',
      'export { local as renamed };',
      'export async function track() {}',
      'const listed = { ping() {} };',
      'export { listed as cloud };',
      'export default function register() {}',
      'interface Shape { id: string }',
      'export type { Shape };',
      'export { type Shape as ShapeAlias };',
    ].join('\n'), 'stub.ts');
    expect([...stubNamespaceMembers(sf).get('auth')!].sort()).toEqual(['currentUser', 'label', 'signIn']);
    // A default export is `default`, not its declaration's name; a type-only export is no runtime export.
    expect([...stubExports(sf)].sort()).toEqual(['auth', 'cloud', 'default', 'renamed', 'track']);
    // A namespace exported through a LIST is a namespace too, under its exported name — its members
    // are checked like any other (#1195 P1 review: they were not, and a deleted member stayed green).
    expect([...stubNamespaceMembers(sf).get('cloud')!]).toEqual(['ping']);
    expect(stubExportTable(sf).find((e) => e.name === 'renamed')?.is).toBe('other');
  });

  it('reads member calls by symbol — a shadowing local is not the import; a binding handed on is followed by name (#1195)', () => {
    const sf = parseSource([
      "import { track, auth, cloudSave, serverTime } from '@g/app-services';",
      "function label(track: string) { return track.toUpperCase(); }", // a PARAMETER spelled like the import
      "track('boot');",
      "serverTime.getDateHeaderTimeMs();",
      "type T = typeof auth.currentUser;",
      "const services = { auth, cloudSave };",                         // handed on: followed by name
      "services.auth.currentUser();",
      "function load(cloudSave: { loadSave(): void }) { cloudSave.loadSave(); }",
    ].join('\n'), 'game.ts');
    const bindings = importBindings(sf, APP_SERVICES).map((b) => ({
      id: findNodes(b.edge.node, ts.isIdentifier).find((n) => n.text === b.local && ts.isImportSpecifier(n.parent))!,
      imported: b.imported,
    }));
    const found = scanMemberCalls(new Map([['game.ts', bindings]]), new Set(['track', 'auth', 'cloudSave', 'serverTime']));
    expect(flatMembers(found)).toEqual(['auth.currentUser', 'cloudSave.loadSave', 'serverTime.getDateHeaderTimeMs']);
    expect(found.handedOn.map((h) => h.item)).toEqual(['game.ts::auth in <module> > `auth`', 'game.ts::cloudSave in <module> > `cloudSave`']);
  });

  it('follows a binding RETURNED from a function, peels ! and as, and reports what it cannot follow (#1195)', () => {
    const scan = (lines: string[], names: string[]) => {
      const sf = parseSource(["import { auth, $a } from '@g/app-services';", ...lines].join('\n'), 'game.ts');
      const bindings = importBindings(sf, APP_SERVICES).map((b) => ({
        id: findNodes(b.edge.node, ts.isIdentifier).find((n) => n.text === b.local && ts.isImportSpecifier(n.parent))!,
        imported: b.imported,
      }));
      return scanMemberCalls(new Map([['game.ts', bindings]]), new Set(names));
    };
    // Wordweave's shape: every call goes through the function that returns the binding — directly, or
    // through a `const` holding its result (the second review found that path dropped).
    const returned = scan(['function acc(): typeof auth { return o ? { ...auth, ...o } : auth; }', 'acc().currentUserResult();', 'acc()?.signOut();',
      'function signIn() { const a = acc(); return p ? a.signInWithApple() : a.signInWithGoogle(); }'], ['auth']);
    expect([flatMembers(returned), returned.handedOn]).toEqual([['auth.currentUserResult', 'auth.signInWithApple', 'auth.signInWithGoogle', 'auth.signOut'], []]);
    // A parenthesised return and a concise arrow are returns too, attributed to the arrow's OWN name.
    const shapes = scan(['function outer() { return (c ? { ...auth } : auth); }', 'const arrow = () => auth;', 'outer().x();', 'arrow().y();'], ['auth']);
    expect([flatMembers(shapes), shapes.handedOn]).toEqual([['auth.x', 'auth.y'], []]);
    // A returner whose calls cannot all be SEEN is handed on, never followed into zero calls (#1195 P2 close-out):
    // exported (its callers live in other files), never called here, an accessor, or reached through an alias.
    // And a `return` inside an anonymous callback returns to that callback's caller, not from `install`.
    for (const lines of [
      ['export function getAuth() { return auth; }', 'getAuth().signIn();'],
      ['function getAuth() { return auth; }', 'export { getAuth as authOf };', 'getAuth().signIn();'],
      ['function getAuth() { return auth; }'],
      ['const svc = { get auth() { return auth; } };', 'svc.auth.signIn();'],
      ['function f() { return auth; }', 'const g = f;', 'g().signIn();'],
      ['function install() { registerProvider(() => auth); }', 'install();'],
      // Every read must be a call: a default export, a re-bind, a hand-off by reference, or an object member each
      // takes the returner out of reach — even with an in-file call beside it (§2d re-review).
      ['function getAuth() { return auth; }', 'getAuth().init();', 'export default getAuth;'],
      ['function f() { return auth; }', 'f().init();', 'export const getAuth = f;'],
      ['function f() { return auth; }', 'f().init();', 'registerProvider(f);'],
      ['export const svc = { getAuth: () => auth };', 'svc.getAuth().init();'],
      ['const svc = { getAuth() { return auth; } };', 'svc.getAuth().init();'],
    ]) {
      // Counted on the ledger (the by-name fallback may still find a member through `svc.auth`).
      expect(scan(lines, ['auth']).handedOn.length, lines.join(' ')).toBe(1);
    }
    // A same-named call elsewhere is not a call of the returner: `firebase.auth()` is not the getter `auth`.
    const collide = scan(['const svc = { get auth() { return auth; } };', 'svc.auth.signIn();', 'firebase.auth().onReady();'], ['auth']);
    expect([flatMembers(collide).includes('auth.onReady'), collide.handedOn.length]).toEqual([false, 1]);
    expect(scan(['function install() { registerProvider(() => auth); }', 'install();'], ['auth']).handedOn.map((h) => h.item))
      .toEqual(['game.ts::auth in install > `registerProvider(() => auth);`']);
    // Past MAX_HOPS the value is counted, not dropped.
    const deep = scan(['const a1 = auth;', 'const a2 = a1;', 'const a3 = a2;', 'const a4 = a3;', 'a4.z();'], ['auth']);
    expect([flatMembers(deep), deep.handedOn.map((h) => h.item)]).toEqual([[], ['game.ts::auth in <module> > `const a4 = a3;`']]);
    // A `typeof` alone hands nothing on — the symbol reads stand.
    const typed = scan(['type T = typeof auth;', 'auth.a();'], ['auth']);
    expect([flatMembers(typed), typed.handedOn]).toEqual([['auth.a'], []]);
    // Wrappers around the receiver are the same call.
    expect(flatMembers(scan(['auth!.b();', '(auth as any).c();'], ['auth']))).toEqual(['auth.b', 'auth.c']);
    // An element access cannot be read: counted, never silently nothing.
    expect(scan(["auth['d']();"], ['auth']).handedOn.map((h) => h.item)).toEqual(["game.ts::auth in <module> > `auth['d']();`"]);
    // A `$` in a handed-on binding's name is not a regex anchor.
    expect(flatMembers(scan(['const svc = { $a };', 'svc.$a.e();'], ['$a']))).toEqual(['$a.e']);
  });

  it('a member call on an export that is NOT an object literal is missing — a class or a factory has no members to read', () => {
    const stub = parseSource('export class serverTime {}\nexport const auth = { currentUser() {} };', 'stub.ts');
    const game = parseSource("import { serverTime, auth } from '@g/app-services';\nserverTime.getDateHeaderTimeMs();\nauth.currentUser();", 'game.ts');
    const bindings = importBindings(game, APP_SERVICES).map((b) => ({
      id: findNodes(b.edge.node, ts.isIdentifier).find((n) => n.text === b.local && ts.isImportSpecifier(n.parent))!,
      imported: b.imported,
    }));
    expect(memberCheck(new Map([['game.ts', bindings]]), stub).missing).toEqual(['serverTime.getDateHeaderTimeMs (called by game.ts)']);
  });

  it('every namespace object exports every MEMBER a game calls on it', () => {
    const namespaceMembers = stubNamespaceMembers();
    // Guard the guard: the stub currently has several `export const <namespace> = { … }` objects
    // (`auth`, `ads`, `crashlytics`, `serverTime`, `cloudSave`) — if the brace-balanced parser
    // above finds none, every assertion below is vacuous.
    expect(namespaceMembers.size, 'stubNamespaceMembers found no namespace objects — the parser has gone stale').toBeGreaterThan(0);

    // EVERY exported name, not only the namespace objects (#1195 P1 re-review): a namespace written any
    // other way — `export class serverTime {}`, `export const auth = makeAuth()` — yields no members, and a
    // scan restricted to the object literals skipped its calls entirely. Scanned, a member call on an
    // export that is not an object literal finds no member below, and fails.
    const { required: requiredMembers, handedOn, missing } = memberCheck(aliases);
    assertExemptionLedger({
      label: 'HANDED_ON_REVIEWED in playableAppServicesStub',
      population: handedOn,
      exempt: HANDED_ON_REVIEWED,
      // 6 measured (4 cloudSyncWiring, 2 Ads debug tabs), all pardoned; wiring either through a followable shape trips this floor.
      floor: 1,
      fix: 'an app-services binding is used as a VALUE here, so its member calls happen through a receiver this guard '
        + 'cannot follow by symbol. Read the file: if its calls are spelled `<import name>.<member>(` the name fallback '
        + 'already counts them and a row with that reason is enough; otherwise teach scanMemberCalls the shape.',
    });
    // Guard the guard, the other direction: the games DO call members on these namespaces
    // (`auth.getServerTimeMs`, `auth.currentUser`, `cloudSave.deleteSave`, `ads.showInterstitial`,
    // `crashlytics.crash`, …) — a scan that found none has gone stale, not a codebase that stopped
    // using them.
    expect(requiredMembers.size, 'the namespace-member scan matched nothing — the queries have gone stale').toBeGreaterThan(0);
    // A destructured dynamic member is scanned by its LOCAL alias (#1193).
    expect(requiredMembers.get('analytics')?.get('logEvent'), 'analytics.logEvent in 3d-test was not scanned — the '
      + 'destructured alias did not reach the member scan').toContain('games/3d-test/runtime/config.ts');

    // Wordweave's account calls go through `accountAuth()`, which returns the binding (#1195 P1 re-review).
    expect(requiredMembers.get('auth')?.get('currentUserResult'), 'wordweave\'s accountAuth().currentUserResult() was not scanned')
      .toContain('games/wordweave/runtime/systems.ts');
    expect(
      missing,
      'these calls would fail a --target playable build at RUNTIME with "is not a function" — ' +
      'Rollup cannot catch a missing namespace MEMBER the way it catches a missing top-level export',
    ).toEqual([]);
  });
});
