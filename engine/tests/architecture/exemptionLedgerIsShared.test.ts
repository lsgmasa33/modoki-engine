/** ⚠️ **A pardon that filters a detector's hits goes through `assertExemptionLedger` — never a
 *  hand-rolled membership test (#1140, closing #1123 → #1128).**
 *
 *  The helper (`@modoki/engine/testing/exemptionLedger`) exists because a hand-rolled pardon keeps
 *  getting its GRAIN wrong in the same few ways: keyed by file over a per-occurrence ban, matched
 *  with `.some()` instead of spent, consulted by two rules, or never re-checked at all. The census
 *  behind #1140 re-read 63 of them; a third were inert, several hid real detector bugs, and two made
 *  their guard unfalsifiable (`moduleTogglesWired`, `adbTargeting`). The whole account is
 *  `docs/verify-and-ci.md` § "Exemption GRAIN". Nothing made the helper non-optional, so every new
 *  guard re-rolled the choice. This file is that missing half — the structural twin of
 *  `commentStripperIsShared` and `corpusProducerIsShared`, one mechanism over.
 *
 *  ## What it detects — the SHAPE, never the constant's NAME
 *
 *  A name-based marker (`ALLOW*`/`EXEMPT*`) already missed `DIRECT_ESBUILD_ALLOWED`, and a migrated
 *  guard simply drops out of such a census. So the detector is structural, over the TypeScript AST
 *  of every test file in every test root:
 *
 *   - a COLLECTION: an identifier declared `const X = <array literal | object literal | new Set/Map(
 *     <nothing, an array literal, or such an X>)>`, and never mutated in the file (`.add`/`.set`/
 *     `.push`/…, or an element assignment) — a mutated collection is a working set (`seen`), not a
 *     list somebody wrote. An EMPTY `new Set()` counts: "empty today, add a type here" is a pardon;
 *   - consulted by a MEMBERSHIP test (`X.has(k)` / `X.includes(k)` / `X.some(…)` / `X.find(…)` /
 *     `X.get(k)` / `k in X` / a bare `X[k]`) that SKIPS a hit: the condition of an `if` whose branch
 *     ends in `continue` (`{ skipped.push(x); continue; }` too), or inside a `.filter(…)` callback
 *     either negated (`!…`) or the condition of an `if` whose branch ends in `return false`.
 *
 *  ## The false-positive count, measured before the grain was chosen (as #1140 asked)
 *
 *  Across 1,850 test files the broad shape matched 55 sites; about 30 were real pardons (13 of them in
 *  guards the #1140 census never listed) and about 25 were ordinary data — extension lists, expected
 *  tables, vocab sets. Restricting the match to collections that CARRY REASONS cut it to 9 but missed
 *  ~20 pardons written as a bare `new Set([...])` with their reason in a comment — and a guard that
 *  only sees reasoned pardons rewards leaving the reason out. The owner chose the broad shape
 *  (2026-09-13): the real pardons were migrated first, and what remains is `RESIDUE` below, each row
 *  saying which kind of not-a-pardon it is. Every row is SPENT per consulting site, so a list that is
 *  migrated or deleted reports its row as blessing more than exists.
 *
 *  The close-out review found two real pardons the first cut missed — an EMPTY `new Set<string>()`
 *  (`assetTypeOrder`) and a skip branch of more than one statement (`getParamParity`, where a route
 *  that moved into the router would have stayed skipped) — so those arms were widened, and the
 *  `if (…) return false` form inside `.filter` with them. Both pardons were migrated; the widening
 *  added four non-pardons to RESIDUE (two scanner classifiers, one #1144 window — deleted when #1144
 *  moved that classifier onto the AST — and one Court partition).
 *
 *  ## What it does NOT see — stated, not implied
 *
 *   - a pardon built dynamically (`new Set(rows.map(…))` over a non-literal, a `Map` filled in a loop);
 *   - a membership test that skips by `return` from a named function or a `forEach` callback
 *     (`if (PRIMITIVES.has(v)) return null;` in a classifier), by a ternary, or in a `for` condition;
 *   - a pardon IMPORTED from another module (`liveCoverage`'s `COVERED_BY_SMOKE`) — identity is per file;
 *   - a membership test spelled as an index comparison (`X.indexOf(k) >= 0`, `X.indexOf(k) < 0`);
 *   - a skip on a non-collection comparison (`rel === SELF`, `rel.startsWith(…)`);
 *   - production code: the scope is test files, where guards live.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { repoFiles } from '../../scripts/repoCorpus.mjs';
import { assertExemptionLedger } from '@modoki/engine/testing/exemptionLedger';
import { REPO_ROOT, hasInternalGames, hasPublishScripts } from '../helpers/repoLayout';

/** Every test root vitest collects — engine, the package, the scaffolder template, each project, and a
 *  project's own packages (the last two were missing until the #1140 close-out; 0 sites there today). */
const isTestSource = (rel: string): boolean =>
  /\.(ts|tsx|mts)$/.test(rel) && !rel.endsWith('.d.ts')
  && (rel.startsWith('engine/tests/') || rel.startsWith('engine/packages/modoki/tests/')
    || rel.startsWith('engine/templates/starter/tests/')
    || /^(games|demos)\/[^/]+\/tests\//.test(rel)
    || /^(games|demos)\/[^/]+\/packages\/.+\.test\.(ts|tsx|mts)$/.test(rel));

/** Identifiers declared as a literal collection and never mutated in `sf`. */
function literalCollections(sf: ts.SourceFile): Set<string> {
  const literal = new Set<string>();
  const mutated = new Set<string>();
  const computed = new Set<string>();
  // A literal someone WROTE: no spread element, because `[...A, ...B]` / `new Set([...xs])` is data
  // derived from elsewhere (measured: six such working sets were matched before this rule).
  const written = (arr: ts.ArrayLiteralExpression): boolean => !arr.elements.some(ts.isSpreadElement);
  const unwrap = (x: ts.Expression): ts.Expression => {
    let e = x;
    while (ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isParenthesizedExpression(e)) e = e.expression;
    return e;
  };
  const isLiteralInit = (init: ts.Expression | undefined): boolean => {
    if (!init) return false;
    const e = unwrap(init);
    if (ts.isArrayLiteralExpression(e)) return written(e);
    if (ts.isObjectLiteralExpression(e)) return !e.properties.some(ts.isSpreadAssignment);
    if (ts.isNewExpression(e) && ts.isIdentifier(e.expression) && /^(Set|Map)$/.test(e.expression.text)) {
      const raw = e.arguments?.[0];
      const arg = raw && unwrap(raw);
      return !arg || (ts.isArrayLiteralExpression(arg) && written(arg)) || (ts.isIdentifier(arg) && literal.has(arg.text));
    }
    return false;
  };
  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) {
      const isConst = ts.isVariableDeclarationList(n.parent) && (n.parent.flags & ts.NodeFlags.Const) !== 0;
      // Identity is by NAME across the file (no scope resolution), so a name also declared with a
      // computed value somewhere else is not trusted as a written list.
      if (isConst && isLiteralInit(n.initializer)) literal.add(n.name.text);
      else computed.add(n.name.text);
    }
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.expression)
      && /^(add|set|push|delete|splice|unshift|clear)$/.test(n.expression.name.text)) mutated.add(n.expression.expression.text);
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isElementAccessExpression(n.left) && ts.isIdentifier(n.left.expression)) mutated.add(n.left.expression.text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  for (const m of [...mutated, ...computed]) literal.delete(m);
  return literal;
}

/** The collection a membership test consults, or null. A property read OFF a row (`X[k].reason`) is
 *  not membership, so it is not followed. */
function membershipOf(expr: ts.Expression, literal: ReadonlySet<string>): string | null {
  let e = expr;
  while (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
  if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && ts.isIdentifier(e.expression.expression)
    && /^(has|includes|some|find|get)$/.test(e.expression.name.text) && literal.has(e.expression.expression.text)) {
    return e.expression.expression.text;
  }
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.InKeyword
    && ts.isIdentifier(e.right) && literal.has(e.right.text)) return e.right.text;
  // `Object.hasOwn(X, k)` — the `in` test spelled safely.
  if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && ts.isIdentifier(e.expression.expression)
    && e.expression.expression.text === 'Object' && e.expression.name.text === 'hasOwn'
    && e.arguments[0] && ts.isIdentifier(e.arguments[0]) && literal.has(e.arguments[0].text)) return e.arguments[0].text;
  if (ts.isElementAccessExpression(e) && ts.isIdentifier(e.expression) && literal.has(e.expression.text)) return e.expression.text;
  return null;
}

/** Every site in `src` where a literal collection's membership test skips a hit. */
function handRolledPardons(src: string, file: string): Array<{ collection: string; line: number }> {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const literal = literalCollections(sf);
  const out: Array<{ collection: string; line: number }> = [];
  const at = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const terms = (expr: ts.Expression): ts.Expression[] => {
    let e = expr;
    while (ts.isParenthesizedExpression(e)) e = e.expression;
    if (ts.isBinaryExpression(e) && (e.operatorToken.kind === ts.SyntaxKind.BarBarToken
      || e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)) return [...terms(e.left), ...terms(e.right)];
    return [e];
  };
  /** The branch's final statement, looking through a block: `continue` and `{ log(x); continue; }` alike. */
  const lastOf = (t: ts.Statement): ts.Statement | undefined =>
    ts.isBlock(t) ? t.statements[t.statements.length - 1] : t;
  const returnsFalse = (t: ts.Statement): boolean => {
    const last = lastOf(t);
    return !!last && ts.isReturnStatement(last) && !!last.expression && last.expression.kind === ts.SyntaxKind.FalseKeyword;
  };
  const pushTerms = (n: ts.IfStatement): void => {
    for (const term of terms(n.expression)) {
      const c = membershipOf(term, literal);
      if (c) out.push({ collection: c, line: at(n) });
    }
  };
  const visit = (n: ts.Node): void => {
    if (ts.isIfStatement(n)) {
      const last = lastOf(n.thenStatement);
      if (last && ts.isContinueStatement(last)) pushTerms(n);
    }
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'filter') {
      const cb = n.arguments[0];
      if (cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb))) {
        // `ownScope`: a `return false` answers the FILTER only in the callback's own body — inside a
        // nested `.every(…)` it answers that. A nested `.filter(…)` is not descended into at all: the
        // outer visit reaches it on its own, and scanning it here too counted its sites twice.
        const isFilterCall = (m: ts.Node): boolean => ts.isCallExpression(m)
          && ts.isPropertyAccessExpression(m.expression) && m.expression.name.text === 'filter';
        const scan = (m: ts.Node, ownScope: boolean): void => {
          if (isFilterCall(m)) return;
          if (ts.isPrefixUnaryExpression(m) && m.operator === ts.SyntaxKind.ExclamationToken) {
            const c = membershipOf(m.operand, literal);
            if (c) out.push({ collection: c, line: at(m) });
          }
          if (ownScope && ts.isIfStatement(m) && returnsFalse(m.thenStatement)) pushTerms(m);
          const inner = ownScope && !ts.isFunctionLike(m);
          ts.forEachChild(m, (child) => scan(child, inner));
        };
        scan(cb.body, true);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** Hand-rolled membership tests that are NOT a pardon to migrate, keyed `file::COLLECTION` and SPENT
 *  per consulting site. Each reason opens with its KIND: DATA / VOCABULARY / CLASSIFIER / MODEL /
 *  SCAN SCOPE (a list that selects, not excuses); DECLARED LIST / EXPECTED / FIXTURE TABLE (a #830
 *  completeness list); TWO-WAY EXACT (already both directions); REGISTRY; STRUCTURAL; GENERATION SKIP
 *  (skips generating a per-item test, so there is no scan population to spend); DEFERRED (another
 *  lane). A pardon that FILTERS a detector's hits is none of these — migrate it. */
const RESIDUE: ReadonlyArray<{ item: string; count?: number; reason: string }> = [
  { item: 'engine/tests/architecture/projectWritersTakeBuildClaim.test.ts::CLAIMS', reason: 'DATA — the claim spellings a project writer may use, each wrapper proven to reach acquireBuildClaim( by the same file (#1160)' },
  { item: 'engine/packages/modoki/tests/editor/devicePresets.test.ts::ANDROID_TABLETS', reason: 'DATA — partitions the Android presets into phones and tablets' },
  { item: 'engine/packages/modoki/tests/editor/uiAuthoring.test.ts::specially_handled', reason: 'DATA — narrows the expected pinned-field list' },
  { item: 'engine/packages/modoki/tests/runtime/uiTreeReuse.test.ts::nested', reason: 'DATA — the non-scalar node keys, so only scalar fields are compared' },
  { item: 'engine/tests/architecture/agentDefinitions.test.ts::KNOWN_MODELS', reason: 'VOCABULARY — the model names an agent definition may declare; an unknown one is the offence' },
  { item: 'engine/tests/architecture/corpusConsumerPins.test.ts::PINS', reason: 'CLASSIFIER — the patterns that count as a non-vacuity pin' },
  { item: 'engine/packages/modoki/tests/helpers/sourceScanner.ts::REGEX_PRECEDERS', reason: 'CLASSIFIER — the characters after which `/` opens a regex literal; the branch that ends in `continue` CONSUMES it' },
  { item: 'engine/packages/modoki/tests/helpers/sourceScanner.ts::REGEX_KEYWORDS', reason: 'CLASSIFIER — the keywords after which `/` opens a regex literal; same branch as REGEX_PRECEDERS' },
  { item: 'engine/tests/architecture/pluginMethodParity.test.ts::BUILTIN_LISTENER_METHODS', reason: 'VOCABULARY — Capacitor\'s built-in listener methods, never plugin methods to pair' },
  { item: 'engine/tests/architecture/qaCaseReferences.test.ts::DERIVED_FAMILY_TEMPLATES', reason: 'CLASSIFIER — id templates whose members are derived rather than typed' },
  { item: 'engine/tests/architecture/qaCaseReferences.test.ts::PROJECT_SETTINGS_UNTAGGED_CONTROL_KINDS', reason: 'MODEL — control kinds handed whole to a sub-editor with no uiId, so they emit no id' },
  { item: 'engine/tests/architecture/qaCaseReferences.test.ts::TARGETS', reason: 'DECLARED LIST — compared against the documented targets for completeness' },
  { item: 'engine/tests/architecture/toolchainPins.test.ts::EXPECTED', reason: 'EXPECTED TABLE — every pinned toolchain file must be declared with its pin' },
  { item: 'engine/tests/architecture/docCitations.test.ts::LINE_CITATION_CORPUS_EXCLUDED', reason: 'SCAN SCOPE — the directories and specs the line-citation corpus does not read (#1124, owner ruling: every tracked .md minus a named list). Whole-file by design: a plan is deleted when it lands and a review is immutable, so an occurrence count there would churn on every edit; a row kept for its hits must still pardon one, a convention row must still cover a file' },
  { item: 'engine/tests/architecture/docCitations.test.ts::SOURCE_PATH_CORPUS_EXCLUDED', reason: 'SCAN SCOPE — the trees rule 2\'s source-path corpus does not read (#1124): qa/cases/ and every top-level qa/*.md are resolved by their own gate (tools-scratch harness READMEs are per-(doc, path) SOURCE_CITATION_EXEMPT rows instead); each row must still cover a file' },
  { item: 'engine/tests/electron/mainBundleExternals.test.ts::SCANNABLE', reason: 'SCAN SCOPE — the file extensions the bundle scan can read' },
  { item: 'engine/tests/electron/packagingManifest.test.ts::TABLE', reason: 'EXPECTED TABLE — every reachable ignore pattern must carry a packaging verdict' },
  { item: 'engine/tests/tools/mcpToolContracts.test.ts::ACTION_PROBES', reason: 'FIXTURE TABLE — every multi-action tool must have a probe' },
  { item: 'games/court/tests/hintPanelFit.test.ts::HORIZONTAL', reason: 'DATA — the horizontal anchor fields the check skips' },
  { item: 'games/court/tests/storeChrome.test.ts::ACCOUNT_ROW_NAMES', reason: 'DATA — partitions the text calls into account rows and the rest' },
  { item: 'games/court/tests/chromeFixture.ts::ANIMATED_CHROME', reason: 'DATA — partitions the spawned chrome into animated and plain; the branch spawns, then continues' },
  { item: 'games/wordweave/tests/authoredLabelBudget.test.ts::TEMPLATE_NAMED', reason: 'DATA — narrows the named-entity list (work-ai lane)' },
  { item: 'engine/tests/architecture/editorStoreActionsReachable.test.ts::knownOrphans', reason: 'TWO-WAY EXACT (empty) — new orphans and stale rows are both asserted' },
  { item: 'engine/tests/assets/gamePortability.test.ts::KNOWN_ESCAPES', reason: 'TWO-WAY EXACT — new escapes and stale rows both asserted, at the same file::specifier grain' },
  { item: 'engine/tests/tools/routeCoverage.test.ts::NO_TOOL_BY_DESIGN', reason: 'TWO-WAY EXACT — undeclared, stale and newly-covered routes are all asserted' },
  { item: 'engine/tests/tools/routeCoverage.test.ts::AGENT_GAPS', reason: 'TWO-WAY EXACT (empty on purpose, docs/mcp-tool-conventions.md §10) — same checks as NO_TOOL_BY_DESIGN' },
  { item: 'engine/tests/architecture/worldSwapTeardownFalsifiable.test.ts::BASELINE', reason: 'REGISTRY — producer → covering test, proven by the named wiring test; spending it would demand deleting a row when a mock goes away (#1140 Phase 2)' },
  { item: 'engine/tests/architecture/docCitations.test.ts::exempt', count: 3, reason: 'STRUCTURAL — SELF_QUOTING: this guard must quote its subject; whole-file by design, and load-bearing in each of its three scans (its own test)' },
  { item: 'engine/tests/helpers/layoutConditionalScan.ts::SELF', reason: 'STRUCTURAL — the scanner excludes the files that implement and pin it' },
  { item: 'engine/tests/tools/deviceToolCoverage.test.ts::NOT_DATA_PLANE', count: 3, reason: 'GENERATION SKIP — no scan population; each control-plane exemption is measured by the reverse relay probe' },
  { item: 'engine/tests/tools/deviceToolCoverage.test.ts::NOT_A_JSON_ENVELOPE', reason: 'GENERATION SKIP — ⚠️ no staleness check: a tool that starts answering {ok,…} keeps its row (stated gap)' },
  { item: 'engine/tests/tools/liveCoverage.test.ts::NO_OK_FLAG', reason: 'GENERATION SKIP — load-bearing asserted by its own test (still a POST route tool)' },
];

/** Files a checkout can legitimately lack: `games/` without the internal games, and the one scanned
 *  file `scripts/publish-engine-oss.sh` strips from the snapshot.
 *
 *  ⚠️ Both are keyed on a LAYOUT predicate, never on the file itself (#1140 close-out): a
 *  `fs.existsSync` here would silently drop the row of a stripped file somebody deleted or renamed
 *  in a checkout that still HAS the publisher. The snapshot is the layout without the publish scripts. */
const PUBLISHER_STRIPPED = ['engine/tests/helpers/layoutConditionalScan.ts'];
const absentByLayout = (rel: string): boolean =>
  (rel.startsWith('games/') && !hasInternalGames())
  || (PUBLISHER_STRIPPED.includes(rel) && !hasPublishScripts());

describe('a pardon that filters a detector goes through assertExemptionLedger (#1140)', () => {
  const files = repoFiles({ match: isTestSource, floor: 1000 });
  const population = files.flatMap(({ rel, abs }) =>
    handRolledPardons(fs.readFileSync(abs, 'utf8'), rel)
      .map((h) => ({ item: `${rel}::${h.collection}`, site: `${rel}:${h.line} (${h.collection})` })));

  it('PUBLISHER_STRIPPED is still stripped by the publisher — the layout exception is real', (ctx) => {
    const publisher = path.join(REPO_ROOT, 'scripts/publish-engine-oss.sh');
    if (!hasPublishScripts()) { ctx.skip(); return; }
    const text = fs.readFileSync(publisher, 'utf8');
    for (const rel of PUBLISHER_STRIPPED) {
      // The STRIPPING line, not just the path: a comment or an unrelated mention must not satisfy it.
      const strip = `grep -vE '^${rel.replace(/\./g, '\\.')}$'`;
      expect(text.split('\n').some((l) => !l.trim().startsWith('#') && l.includes(strip)),
        `${rel} is no longer stripped from the snapshot (no \`${strip}\` line) — drop it from PUBLISHER_STRIPPED`).toBe(true);
    }
  });

  it('scans every test root', () => {
    // Per root, so dropping one cannot hide behind the total.
    for (const root of ['engine/tests/', 'engine/packages/modoki/tests/']) {
      expect(files.filter((f) => f.rel.startsWith(root)).length, root).toBeGreaterThan(300);
    }
    // The scaffolder template ships in every layout, and is a root the first cut missed.
    expect(files.some((f) => f.rel.startsWith('engine/templates/starter/tests/')), 'engine/templates/starter/tests/').toBe(true);
  });

  it('no hand-rolled pardon outside RESIDUE', () => {
    assertExemptionLedger({
      label: 'RESIDUE in exemptionLedgerIsShared',
      population,
      // ⚠️ Absent by LAYOUT, not by existence: the public snapshot ships no `games/`, and the publisher
      // strips `layoutConditionalScan.ts` with its ledger. Dropping a row because its file is merely
      // missing would silence the staleness of a file deleted or renamed in a root that ships.
      exempt: RESIDUE.filter(({ item }) => !absentByLayout(item.split('::')[0]!)),
      floor: 1,
      fix: 'these filter a detector\'s hits with a hand-rolled membership test on a literal list. Put the '
        + 'pardon through assertExemptionLedger (@modoki/engine/testing/exemptionLedger) — rows SPENT per '
        + 'occurrence, staleness checked, `sanctioned` for a structural exclusion — see docs/verify-and-ci.md '
        + '§ "Exemption GRAIN". If the list is not a pardon at all (data, an expected table, a two-way '
        + 'exact baseline), add a RESIDUE row saying which.',
    });
  });
});

describe('the detector — both sides, on synthetic source (a clean tree reports only RESIDUE either way)', () => {
  const found = (src: string) => handRolledPardons(src, 'synthetic.ts').map((h) => h.collection);

  it('REJECTS each hand-rolled pardon shape', () => {
    expect(found("const EXEMPT = new Set(['a.ts']);\nfor (const f of files) { if (EXEMPT.has(f)) continue; }")).toEqual(['EXEMPT']);
    expect(found("const ALLOW: Record<string, string> = { a: 'x' };\nhits.filter((h) => !(h in ALLOW));")).toEqual(['ALLOW']);
    expect(found("const ROWS = [{ file: 'a', why: 'x' }];\nhits.filter((h) => !ROWS.some((r) => r.file === h));")).toEqual(['ROWS']);
    expect(found("const BY = { a: 'x' };\nhits.filter((c) => !BY[c.near]);")).toEqual(['BY']);
    expect(found("const L = ['a'];\nconst E = new Set(L);\nfor (const x of xs) { if (other(x) || E.has(x)) continue; }")).toEqual(['E']);
    // Each arm below survived its own deletion until the #1140 close-out review — one case per arm.
    // `&&` terms
    expect(found("const E = new Set(['a']);\nfor (const x of xs) { if (ready && E.has(x)) continue; }")).toEqual(['E']);
    // a `{ continue; }` block, and a multi-statement block that ends in one (getParamParity's shape)
    expect(found("const E = new Set(['a']);\nfor (const x of xs) { if (E.has(x)) { continue; } }")).toEqual(['E']);
    expect(found("const E = new Set(['a']);\nfor (const x of xs) { if (E.has(x)) { skipped.push(x); continue; } }")).toEqual(['E']);
    // an EMPTY constructor — "empty today, add one here" (assetTypeOrder's shape)
    expect(found('const E = new Set<string>();\nxs.filter((x) => !E.has(x));')).toEqual(['E']);
    // `get` and `find`, and a non-null assertion on the test
    expect(found("const BY = new Map([['a', 1]]);\nxs.filter((x) => !BY.get(x)!);")).toEqual(['BY']);
    expect(found("const ROWS = ['a'];\nxs.filter((x) => !ROWS.find((r) => r === x));")).toEqual(['ROWS']);
    // `includes`, and a `satisfies`-wrapped initializer
    expect(found("const L = ['a'] satisfies string[];\nxs.filter((x) => !L.includes(x));")).toEqual(['L']);
    // `if (…) return false` inside a filter callback (commentStripperIsShared's shape)
    expect(found("const E = ['a'];\nxs.filter((x) => { if (E.includes(x)) return false; return true; });")).toEqual(['E']);
    // an `as const` constructor argument, and `Object.hasOwn` (close-out §2d)
    expect(found("const E = new Set<string>(['a'] as const);\nxs.filter((x) => !E.has(x));")).toEqual(['E']);
    expect(found("const BY = { a: 'x' };\nfor (const x of xs) { if (Object.hasOwn(BY, x)) continue; }")).toEqual(['BY']);
    // a nested filter is ONE site, not two
    expect(found("const E = ['a'];\ngroups.filter((g) => g.items.filter((x) => !E.includes(x)).length > 0);")).toEqual(['E']);
  });

  it('ACCEPTS what only looks like one — the measured false-positive classes', () => {
    // a working set: no literal initializer, and mutated
    expect(found('const seen = new Set<string>();\nfor (const x of xs) { if (seen.has(x)) continue; seen.add(x); }')).toEqual([]);
    // a literal that was mutated after all
    expect(found("const L = ['a'];\nL.push('b');\nxs.filter((x) => !L.includes(x));")).toEqual([]);
    // derived data: a spread is not a list somebody wrote
    expect(found('const known = new Set([...A, ...B]);\nxs.filter((x) => !known.has(x));')).toEqual([]);
    // selecting, not skipping: no negation inside the filter
    expect(found("const ALLOW = new Set(['a']);\nxs.filter((x) => ALLOW.has(x));")).toEqual([]);
    // reading a field OFF a row is not membership
    expect(found("const T = { a: { why: 'x' } };\nxs.filter((x) => !T[x].why);")).toEqual([]);
    // a name also declared with a computed value is not trusted as a written list
    expect(found("const S = new Set(['a']);\nfunction f() { const S = compute(); for (const x of xs) { if (S.has(x)) continue; } }")).toEqual([]);
    // a `let` is not a list somebody wrote once
    expect(found("let L = ['a'];\nxs.filter((x) => !L.includes(x));")).toEqual([]);
    // an object spread is derived data, like an array spread
    expect(found("const O = { ...base, a: 'x' };\nxs.filter((x) => !(x in O));")).toEqual([]);
    // an `if` whose branch does NOT end in the skip is not a skip
    expect(found("const E = new Set(['a']);\nfor (const x of xs) { if (E.has(x)) { continue_like(); } }")).toEqual([]);
    expect(found("const E = ['a'];\nxs.filter((x) => { if (E.includes(x)) return true; return false; });")).toEqual([]);
    // a `return false` that answers a NESTED callback, not the filter
    expect(found("const E = new Set(['a']);\nxs.filter((x) => x.rows.every((r) => { if (E.has(r)) return false; return true; }));")).toEqual([]);
  });
});
