/**
 * QA case references must point at things that actually exist.
 *
 * WHY THIS GUARD EXISTS
 * ---------------------
 * `qa/cases/**.md` (see qa/README.md) is the QA suite the Testboard renders. Its whole value
 * is that a human or an agent can pick up a case and execute it. A case that cites a path,
 * a script, or an MCP tool that does not exist fails in the worst possible way: it looks
 * completely fine on screen, and only wastes the runner's time once they try to follow it.
 *
 * That has already happened four times in this suite's first week, and NONE of them were
 * catchable by reading:
 *   - two `covers:` globs pointing at files that had moved (scene3DSync.ts is in
 *     runtime/rendering/, not editor/scene/) — so the case's staleness signal silently never
 *     fired;
 *   - `modoki_set_trait`, a tool that has never existed, as a case's only mutating step;
 *   - `modoki_history` asked to enumerate the undo stack, which no tool on the surface can do.
 *
 * Every one was a plausible-sounding reference that nobody checked mechanically. This test is
 * the mechanical check. It is deliberately CONSERVATIVE — it only inspects tokens inside
 * markdown code spans and fenced blocks, because a guard that cries wolf gets disabled, and a
 * disabled guard is worse than none.
 *
 * NOTE ON THE OSS SNAPSHOT: `tests/**` ships to the public engine repo, which does NOT contain
 * `qa/`. The suite therefore skips itself when the directory is absent rather than going red
 * on `ci/main` — the failure mode CLAUDE.md records having hit twice.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
// The repo's ONE vetted comment scanner (#419) — never write a private stripper here. See its
// own docblock for why a naive `//`/`/* */` regex has twice deleted real code from a guard's view.
// `stripCommentsAndStrings` additionally blanks string/template CONTENT (parser-driven) — used
// below to compute brace/bracket DEPTH safely, so a stray `(`/`{`/`[` inside a tooltip string
// cannot desync a balanced-span scan (#723 review finding H).
import { stripComments, stripCommentsAndStrings, findDamagedCodeTokens } from '@modoki/engine/testing';

/**
 * `node:path` yields `\` on Windows, but every path in this file's vocabulary — the `area`
 * directory, the cited repo paths, the failure messages — is repo-relative POSIX. Without this the
 * area check compared "animation" against "animation\some-case.md" and ALL 187 cases failed on
 * the `win` clone while a Mac clone stayed green. Normalise where paths enter.
 */
import {
  citesALine,
  citesALineByMarker,
  citesALineInProse,
  codeSpans,
  codeTokens,
  isBareLineSpan,
  nonCodeText,
  stripLineRef,
} from '../helpers/lineCitations.js';
// The panel's OWN slug function, so a derived id and the rendered one cannot drift apart.
import { particleFieldSlug } from '../../packages/modoki/src/editor/panels/particle/fieldIds.js';

const toPosix = (p: string) => p.replace(/\\/g, '/');

const REPO_ROOT = join(__dirname, '..', '..', '..');
const CASES_DIR = join(REPO_ROOT, 'qa', 'cases');
const HAS_CASES = existsSync(CASES_DIR);

/** Top-level directories a cited repo path may start with. */
const REPO_TOP_LEVEL =
  /^(engine|games|demos|docs|qa|scripts|server|build|layouts|site|tools-scratch)\//;

const CASE_TYPES = ['auto', 'agent', 'human'];
const TARGETS = [
  'editor',
  // The editor running on the WINDOWS clone. Deliberately distinct from `editor`: this repo has a
  // recurring class of Windows-only path bugs (drive letters, separators, `/@fs/` URLs, a
  // `:`-joined PATH), and a Mac session handed such a case would report a confident false PASS.
  'editor-win',
  'web',
  'ios-air',
  'ios-8',
  // Masaki's iPad (iPad11,1, an iPad mini 5). A THIRD iOS target rather than a variant of
  // `ios-air`, for the same reason `editor-win` is not `editor`: the phones differ in what they
  // can execute. The iPhone 8 cannot run WebDriverAgent at all (docs/trusted-device-input.md),
  // so a trusted-input case handed to it is unrunnable, not failing — and an iPad is neither of
  // the other two. Recording an iPad run under `ios-air` would be the false-pass this enum exists
  // to prevent.
  'ios-ipad',
  'android-s22',
  'android-a23',
  'packaged-mac',
  'packaged-win',
];
const SEVERITIES = ['critical', 'high', 'medium', 'low'];

interface Frontmatter {
  fields: Record<string, string | string[]>;
  /** Lines the parser refused — reported rather than silently mis-parsed. */
  unparsed: string[];
}

/**
 * A strict parser for the small YAML subset qa/README.md specifies: `key: scalar`, `key:`
 * followed by `  - item` lines, and inline `[a, b]`.
 *
 * Hand-rolled on purpose. A real YAML library is only available here TRANSITIVELY, and a
 * guard test that breaks when an unrelated dependency shifts is a guard nobody trusts.
 * Anything this cannot parse is surfaced as `unparsed` and fails the test loudly, so the
 * subset can never silently mis-read a case.
 */
export function parseFrontmatter(raw: string): Frontmatter | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!match) return null;

  const fields: Record<string, string | string[]> = {};
  const unparsed: string[] = [];
  let currentList: string[] | null = null;

  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;

    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item) {
      if (!currentList) {
        unparsed.push(line);
        continue;
      }
      currentList.push(stripQuotes(item[1].trim()));
      continue;
    }

    const kv = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (!kv) {
      unparsed.push(line);
      continue;
    }
    // Real YAML REJECTS a duplicate mapping key; this subset would keep the last silently, so a
    // stale copy-pasted `id:` or `covers:` would decide the case with no trace. Reported instead.
    if (Object.prototype.hasOwnProperty.call(fields, kv[1])) {
      unparsed.push(`duplicate key "${kv[1]}": ${line.trim()}`);
      continue;
    }
    // Scoped to the iteration: a key is consumed by the very next lines, never carried across.
    const currentKey = kv[1];
    const value = kv[2].trim();

    if (value === '') {
      currentList = [];
      fields[currentKey] = currentList;
    } else if (value.startsWith('[') && value.endsWith(']')) {
      currentList = null;
      fields[currentKey] = value
        .slice(1, -1)
        .split(',')
        .map((v) => stripQuotes(v.trim()))
        .filter(Boolean);
    } else if (value.startsWith('[')) {
      // An unquoted scalar starting with `[` but never CLOSING one (e.g. the unquoted
      // `title: [win] some prose` shape from #277) opens a YAML flow sequence with no valid
      // end — real YAML throws on the whole frontmatter block. This lenient parser could
      // otherwise happily store it as a bare string, which is exactly how the Testboard's
      // real parser choking on these 11 case files went unnoticed by `npm test` for a week.
      // Reported as unparsed instead, so this class can't regress silently again.
      unparsed.push(line);
      currentList = null;
    } else {
      currentList = null;
      fields[currentKey] = stripQuotes(value);
    }
  }
  return { fields, unparsed };
}

const stripQuotes = (v: string) => v.replace(/^['"]|['"]$/g, '');

/**
 * Minimal glob → RegExp for the patterns `covers:` uses.
 *
 * CONSECUTIVE `**\/` ARE COLLAPSED FIRST, and that is a correctness AND a safety fix, not tidying.
 * Each `**\/` compiles to the optional group `(?:.*\/)?`; chaining them made the regex backtrack
 * catastrophically against a deep non-matching path — measured 1ms / 8 / 52 / 306 / 1584ms for
 * 4..8 chained segments, i.e. roughly 6x per segment, unbounded beyond that. `a/**\/**\/b` means
 * exactly what `a/**\/b` means, so collapsing loses nothing and removes the chain.
 *
 * A leading `/` is also stripped: GitHub compare paths are repo-relative with no leading slash,
 * so `/src/foo.ts` could never match anything and the case could never go stale — silently.
 */
export function globToRegExp(glob: string): RegExp {
  // Collapse `**/**/` chains (see the note above) and drop a leading slash.
  let normalised = glob.replace(/^\/+/, '');
  let prev;
  do {
    prev = normalised;
    normalised = normalised.replace(/\*\*\/(?=\*\*\/)/g, '');
  } while (normalised !== prev);

  let out = '';
  for (let i = 0; i < normalised.length; i++) {
    const c = normalised[i];
    if (c === '*') {
      if (normalised[i + 1] === '*') {
        // `**/` spans zero or more directories; a trailing `**` spans anything.
        if (normalised[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}

interface CaseFile {
  /** Repo-relative path, for readable failure messages. */
  rel: string;
  /** Directory under qa/cases, which must match the `area` field. */
  dir: string;
  fm: Frontmatter | null;
  body: string;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

function loadCases(): CaseFile[] {
  return walk(CASES_DIR)
    .filter((f) => f.endsWith('.md') && !f.endsWith('README.md'))
    .map((f) => {
      const raw = readFileSync(f, 'utf8');
      const rel = toPosix(relative(REPO_ROOT, f));
      return {
        rel,
        dir: toPosix(relative(CASES_DIR, f)).split('/')[0],
        fm: parseFrontmatter(raw),
        body: raw,
      };
    })
    .sort((a, b) => a.rel.localeCompare(b.rel));
}


/**
 * The whitespace fragments of verified space-bearing spans — MINUS any fragment the case also cites
 * as a span in its OWN right.
 *
 * The exemption exists so the pieces of an already-verified path (`…/sprites/slime` +
 * `spritesheet.png`) are not re-checked as if they were two paths. Exempting them GLOBALLY per case
 * opened a false negative, and a real one: `games/sling/runtime/assets/sprites/slime spritesheet
 * calciumtrice.png.meta.json` exists, and truncating a copy at the space yields
 * `games/sling/runtime/assets/sprites/slime` — a broken citation that is ALSO the first fragment, so
 * the global set swallowed it and the guard reported nothing.
 *
 * Citing a fragment on its own is the author saying "this is a path"; that claim gets checked. Being
 * a fragment only excuses a token the case never made a claim about.
 */
export function exemptFragments(spans: string[], verifiedWhole: string[]): Set<string> {
  const claimed = new Set(spans);
  return new Set(
    verifiedWhole.flatMap((s) => s.split(/\s+/)).filter((frag) => !claimed.has(frag)),
  );
}


/**
 * The ONE citation allowed to carry a line number, and why.
 *
 * `cloud-sync-two-device-progress-fork.md` contains the paragraph that explains this whole
 * convention, and it needs a specimen to point at: "a `file.ts:123` citation rots silently on every
 * edit above line 123". The specimen is not a citation — `file.ts` is not a file — so exempting it
 * costs nothing, whereas deleting it would remove the rationale and invite the next author to
 * re-litigate #680 from scratch. Keyed to the exact file AND token so it cannot quietly widen.
 */
/**
 * The suite's own top-level docs, DERIVED rather than hardcoded.
 *
 * ⚠️ A guard is `collect()` then `assert()`, and a perfect assertion over a partial collection is
 * green and worthless. Both doc checks here used to hardcode `['qa/knowledge.md']`, so a new
 * top-level doc — `qa/playbook.md`, another `qa/findings-<date>.md` — would have been scanned by
 * NOTHING, silently, with every assertion still passing. That is not hypothetical: the comment on
 * the path check below records `qa/findings-2026-08-13.md` being deleted while `knowledge.md` still
 * cited it, undetected for exactly this reason.
 *
 * `README.md` stays out, and that exclusion is documented where the path check explains it: it is
 * the format SPEC, so it documents `creates:` by example and quotes the forbidden `file.ts:1745`
 * shape in order to forbid it. Scanning it would demand the opposite of two other guards.
 */
function suiteDocs(): Array<{ rel: string; body: string }> {
  const dir = join(REPO_ROOT, 'qa');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f !== 'README.md')
    .sort()
    .map((f) => ({ rel: `qa/${f}`, body: readFileSync(join(dir, f), 'utf8') }));
}

const PROSE_ALLOWED: ReadonlyArray<{ file: string; token: string }> = [
  { file: 'qa/cases/persistence/cloud-sync-two-device-progress-fork.md', token: 'line 123' },
];

const LINE_REF_ALLOWED: ReadonlyArray<{ file: string; token: string }> = [
  { file: 'qa/cases/persistence/cloud-sync-two-device-progress-fork.md', token: 'file.ts:123' },
];

/**
 * Every `data-ui-id="…"` a case or doc cites.
 *
 * #723: the character class used to admit a SPACE and PARENTHESES. Without them,
 * `contextmenu.item.Constant (stepped)"` and `gameView.devicePicker.device.iPhone SE"` were
 * captured TRUNCATED (`contextmenu.item.Constant`, `gameView.devicePicker.device.iPhone`) — a
 * citation that silently checked the wrong string. That was invisible before #723: the truncated
 * fragment still matched the family's shape pattern (`[^.]+` does not know what a name is
 * supposed to contain), so a fragment happened to "resolve" for the wrong reason. Deriving these
 * families exposed it — the deriver correctly does NOT produce the truncated form, so the bug had
 * to be fixed here rather than worked around in a deriver.
 *
 * ⚠️ **#723 review, item I: rewritten to match to the real closing DELIMITER instead of enumerating
 * allowed characters.** Three real device presets contain a literal `"` (`iPad Pro 11"`, `13"`,
 * `12.9"`), which a character class can never admit without also being able to stop correctly at
 * an attribute's own close — the two needs conflict for exactly the character that closes a
 * `"`-quoted attribute. Two forms are cited in this corpus, and each has an unambiguous close:
 *  - the ESCAPED form (used inside a `modoki_eval {code:"…"}` JSON payload, ~100 existing
 *    citations) opens `\"` and closes at the next literal `\"` — a bare `"` in between (a
 *    quote-bearing device name) is content, not a terminator, so matching NON-GREEDILY up to `\"`
 *    admits it correctly.
 *  - the BARE form opens `"` or `'` and must close on the SAME character (a backreference, `\2`,
 *    picks up whichever one) — so a bare `"` device name is written inside `'…'` and a bare `'`
 *    would be written inside `"…"`, exactly how HTML/JS already resolve this ambiguity.
 * Verified against a case-like sample of each form, including a quote-bearing device id, before
 * trusting it (no test corpus citation exercises the device-name case yet).
 */
const CITED_UI_ID_RE = /data-ui-id=(?:\\"([^\n]*?)\\"|(["'])([^\n]*?)\2)/g;


function git(args: string[]): string {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

/** True when `path` is `entry` or lives under it — `creates: games/x` covers `games/x/a/b.json`. */
export function isUnder(path: string, entry: string): boolean {
  return path === entry || path.startsWith(`${entry}/`);
}

/**
 * Every `data-ui-id` an editor source file exposes, in ALL THREE forms it is written in.
 *
 * A case that aims `modoki_tap` at a selector which does not exist wastes the runner's whole
 * session, and it is invisible to every other check — the tool exists, the parameter exists, only
 * the target does not. `modoki_tap`'s own docstring shipped exactly that mistake
 * (`inspector.header.kebab`, an Inspector kebab menu that has never existed), and it propagated into
 * a case brief before anyone checked. So the ids are extracted mechanically:
 *
 *  1. `data-ui-id="literal"` — the plain JSX attribute.
 *  2. `uiId="literal"` / `dataUiId="literal"` — passed as a prop to a component that renders it
 *     (`TreeSearchInput`, `TypeFilterMenu`, `QualityTiersEditor`'s field rows…).
 *  3. `uiId: 'literal'` — an object property inside an items array (`ViewOptionsMenu`'s options).
 *
 * Forms 2 and 3 are not decoration: leaving either out reported three PERFECTLY CORRECT citations
 * as missing on the first run of this check. A guard that cries wolf gets disabled.
 */
/**
 * `knownUiIds` (#723 review, item G) — swapped from `assertScanIsSane` to the shared
 * `findDamagedCodeTokens`/`assertEveryCodeTokenSurvives` MACHINERY, which actually verifies code
 * tokens survived rather than only checking length/line parity (true by construction for
 * `stripComments`, so it could never catch a scanner that is merely WRONG — only a regression to
 * a deleting regex-based one).
 *
 * ⚠️ **Not a bare call to `assertEveryCodeTokenSurvives`.** That helper parses by the label's file
 * EXTENSION, and `knownUiIds` receives raw source TEXT with no filename attached — the real corpus
 * is a mix of plain `.ts` files (some use generic-arrow syntax, `<T>(x: T) => …`, a parse ERROR
 * under TSX rules) and JSX-bearing `.tsx` panels, plus one-line test fixtures that are only valid
 * as a JSX fragment. Labelling everything `.tsx` broke a REAL file
 * (`runtime/harness/createTestWorld.ts`, 15 parse diagnostics, all `<T>` generics misread as JSX);
 * labelling everything `.ts` broke every JSX-bearing panel and fixture. Trying TSX FIRST (the
 * common case among editor sources) and falling back to `.ts` only when that failed to parse is
 * what makes this correct for both, without needing `knownUiIds` to carry filenames through its
 * many call sites (dozens of hand-typed fixtures across this file, plus both real corpus scans).
 */
function assertKnownUiIdsSourceSurvived(raw: string, stripped: string, label: string): void {
  const tsx = findDamagedCodeTokens(raw, stripped, `${label}.tsx`);
  const result = tsx.parseErrors === 0 ? tsx : findDamagedCodeTokens(raw, stripped, `${label}.ts`);
  expect(result.parseErrors, `${label}: did not parse as EITHER .tsx or .ts, so the token walk is `
    + 'measuring a stump — this check would pass while inspecting nothing').toBe(0);
  // `minTokens` floor deliberately not enforced here (unlike the shared helper's default of >10):
  // this runs once per SOURCE, and plenty of legitimate inputs are tiny — a one-line test fixture,
  // or a small real editor file (an `index.ts` barrel). The corpus-level vacuity floors
  // (`ids.size > 30`, `checked > 20`, …) already guard against a silently-empty scan; this call
  // only needs to know the walk found ANYTHING at all.
  expect(result.tokens, `${label}: 0 tokens were inspected — the walk is not reaching the tree`)
    .toBeGreaterThan(0);
  expect(result.damaged, `${label}: the stripper ate CODE, not comments — a count taken over this `
    + `is meaningless, and it lowers silently.\n${result.damaged.join('\n')}`).toEqual([]);
}

export function knownUiIds(sources: string[]): {
  ids: Set<string>;
  prefixes: string[];
  patterns: RegExp[];
  /** #723: EVERY template's shape pattern, INCLUDING the ones `patterns` excludes for a derived
   *  family. Only `shapeOnlyCitedIds` (below) reads this, to measure what a derived family's
   *  UNDERIVABLE citations (`contextmenu.item.Move to Trash`) would still shape-match — the
   *  baseline candidate set. Never use this for live "does X resolve" checks: that is exactly the
   *  shape-blanket rule 1 removes `patterns` to close. */
  allPatterns: RegExp[];
  /** #723 review, item E: the raw template STRINGS `DERIVED_FAMILY_TEMPLATES` filters against
   *  (same set that feeds `patterns`/`allPatterns` — before `.map(templateToIdPattern)`). Exposed
   *  so a test can assert every exclusion regex matches at least one LIVE template, rather than
   *  only being trusted by inspection. */
  templates: string[];
} {
  // A follow-up to #723: `topLevelObjectKeys`'s `^\s*` anchor cannot skip a `//` comment, so any
  // trait field whose declaration is preceded by one (`UIElement.width`, `Animator.time`,
  // `Renderable3DPrimitive.material`, 30 more — measured against registerTraits.ts) was silently
  // NOT derived, and a comma INSIDE such a comment split the entry at depth 0 and corrupted the
  // fields after it too. Stripped ONCE here, at the source, so both the literal/template
  // extraction below AND every deriver see comment-free text — including `contextMenuItemIds`,
  // which has the mirror-image (fail-OPEN) bug: unstripped, it would happily derive a
  // COMMENTED-OUT `label: '…'` as a real context-menu item.
  sources = sources.map((src, i) => {
    const stripped = stripComments(src);
    assertKnownUiIdsSourceSurvived(src, stripped, `knownUiIds source #${i}`);
    return stripped;
  });
  const ids = new Set<string>();
  const joined = sources.join('\n');
  // `\s*` around the `=`/`:` in all four, for the same reason as the prefix regex below: a JSX
  // prop is written tight (`uiId="a.b"`), but the identical id assigned to a local or a plain
  // object property is conventionally spaced (`const uiId = "a.b"`). Only the tight spelling was
  // matched, so the spaced one was invisible and any case citing such an id came back unknown.
  // Zero editor sources use the spaced LITERAL form today (checked 2026-08-22), so this half is
  // latent rather than a live fix — but the blind spot was identical in all five regexes and
  // fixing only the one that happened to bite would leave the same trap for the next id.
  // ⚠️ `["']?` before the separator admits the QUOTED OBJECT KEY — `{ 'data-ui-id': … }`. That
  // spelling is FORCED for the hyphenated name (`{ data-ui-id: … }` is not valid JS), so it is
  // not a stylistic variant the editor could simply stop using. Accepting `[=:]` uniformly also
  // collapses the old `uiId=` / `uiId:` pair into one entry: they differed only in the separator,
  // and keeping them apart is what let the third spelling fall between them.
  const literal = [
    /data-ui-id["']?\s*[=:]\s*["']([\w.:-]+)["']/g,
    /\buiId["']?\s*[=:]\s*["']([\w.:-]+)["']/g,
    /\bdataUiId["']?\s*[=:]\s*["']([\w.:-]+)["']/g,
  ];
  for (const re of literal) for (const m of joined.matchAll(re)) ids.add(m[1]);
  // A template-built id (`hierarchy.folder.${name}`) can only be checked to its static prefix.
  // `\s*` BEFORE the `=` as well as after it: a JSX prop is written `uiId={`a.${b}`}` with no
  // space, but the same id is often built in a local first — `const uiId = `projectSettings.${
  // field.key}`;` (ProjectSettingsDialog.tsx:55) — and without the leading `\s*` that whole
  // family of ids is invisible here. The symptom is a case correctly citing a selector that
  // demonstrably resolves in the live DOM being reported as unknown, which is the false alarm
  // qa/README.md warns turns a guard into one people disable. Verified 2026-08-21: every
  // `projectSettings.<section>.<key>` field id exists at runtime.
  // ⚠️ KNOWN LIMIT, deliberately not "fixed": an id whose template STARTS with its
  // interpolation — `uiId={uiId && `${uiId}.min`}` (ParticleEditor.tsx, 5 occurrences) — has no
  // static prefix at all. Widening this regex to admit the `ident &&` guard does not help: the
  // capture group then matches the empty string and `.filter(Boolean)` drops it anyway, because
  // the prefix genuinely comes from a parent prop and is unknowable here. Those ids are covered
  // only if a PARENT registers the prefix through one of the forms above. No case cites one
  // today (checked 2026-08-22), so this is latent, not a live false alarm — but if a future
  // particle-editor case cites e.g. `<prefix>.min` and is reported unknown, this is why, and the
  // fix is to make the parent's id statically visible rather than to loosen the matcher here.
  const templates = [
    ...joined.matchAll(/(?:data-ui-id|uiId|dataUiId)["']?\s*[=:]\s*\{?`([\w.:-]*\$\{[^`]*)`/g),
  ].map((m) => m[1]);
  const prefixes = templates.map((t) => t.slice(0, t.indexOf('$'))).filter(Boolean);
  // ⚠️ A PREFIX IS NOT A CHECK. This used to return only the static head and the caller asked
  // `id.startsWith(prefix)`, which accepts every suffix under it: `particle.bursts.row.` is
  // registered by ``data-ui-id={`particle.bursts.row.${i}.remove`}``, so the nonexistent
  // `particle.bursts.row.0.time` passed the guard green while resolving to nothing at runtime —
  // the same wasted-session cost this whole function exists to prevent, arrived at from the other
  // side. All ~49 registered prefixes had it. Matching the WHOLE template closes it, and
  // `templateToIdPattern`'s per-segment class is what makes that true for the 41 of 79 templates
  // that END in a placeholder rather than a literal — read the note there before widening it.
  //
  // The QUOTED OBJECT KEY spelling is now admitted (#705). `Hierarchy.tsx` writes its row id as
  // `{ 'data-ui-id': `hierarchy.entity.${entity.guid}` }` — quoted because the hyphenated name
  // cannot be a bare JS key — and every regex here required the bare name followed by `=` or `:`,
  // so `hierarchy.entity.*` was registered NOWHERE. It was latent only by luck of spelling: the
  // cases that aim these rows write the guid as a `<GUID>` placeholder, which the case-side id
  // tokeniser does not treat as an id, so the false alarm never fired. Substitute a real guid —
  // which is what a runner does — and the guard would have called a working selector unknown.
  // Fixed by admitting the spelling, NOT by loosening the matching: the id still has to match a
  // whole template, so `hierarchy.entity.<guid>.bogus` remains a red.
  // #723 rule 1: a template whose family now has a DERIVER (below) loses its shape pattern here —
  // see `DERIVED_FAMILY_TEMPLATES`'s docblock for why a surviving shape pattern would undo the fix.
  const nonPlaceholderTemplates = templates.filter((t) => !t.startsWith('$'));
  const patterns = nonPlaceholderTemplates
    .filter((t) => !DERIVED_FAMILY_TEMPLATES.some((re) => re.test(t)))
    .map(templateToIdPattern);
  const allPatterns = nonPlaceholderTemplates.map(templateToIdPattern);
  for (const src of sources) {
    for (const id of particleFieldIds(src)) ids.add(id);
    for (const id of traitFieldIds(src)) ids.add(id);
    for (const id of traitSectionIds(src)) ids.add(id);
    for (const id of addComponentItemIds(src)) ids.add(id);
    for (const id of traitSubSectionIds(src)) ids.add(id);
    for (const id of animationViewModeIds(src)) ids.add(id);
    for (const id of sceneViewGizmoIds(src)) ids.add(id);
    for (const id of devicePickerDeviceIds(src)) ids.add(id);
    for (const id of moduleToggleIds(src)) ids.add(id);
    for (const id of projectSettingsFieldIds(src)) ids.add(id);
    for (const id of contextMenuItemIds(src)) ids.add(id);
  }
  // `qualityTierIds` needs TWO files' content at once (see its docblock), so it takes the whole
  // array rather than being called once per file like every deriver above.
  for (const id of qualityTierIds(sources)) ids.add(id);
  return { ids, prefixes, patterns, allPatterns, templates: nonPlaceholderTemplates };
}

/**
 * The concrete ids `useFieldId` mints, derived the way the panel derives them.
 *
 * The Particle Editor tags ~60 property fields through a React context rather than a `uiId` at
 * each call site (see `particle/fieldIds.ts` for why), so none of them appears as a literal or as
 * a `data-ui-id={…}` template and every static scan above is blind to them. A case citing the
 * perfectly correct `particle.general.max-particles` was reported unknown.
 *
 * ⚠️ **This derives the ids; it does not pattern-match them.** A first attempt registered the
 * SHAPE instead (`/^particle\.[^.]+\.[^.]+$/`) and that was strictly worse than the blindness it
 * fixed: the `particle.*` namespace already holds 11 statically-visible literals
 * (`particle.bursts.add`, `particle.transport.play`, `particle.header.name`, …), so a shape
 * blanket waved through every typo of an id the guard used to check exactly — `particle.bursts.delete`
 * passed green. Deriving means `particle.general.max-particles` resolves and
 * `particle.general.max-partickles` does not, which is the whole point.
 *
 * The scan is linear because the JSX is: a `<Section title="…">` opens a section and every
 * labelled widget after it belongs to that section, exactly as `SectionIdContext` provides it at
 * runtime. It uses the panel's OWN `particleFieldSlug`, so the two cannot drift. A structural
 * change here fails LOUDLY (ids stop resolving, cases citing them go red) rather than silently
 * widening what the guard accepts — the right direction for this to break in.
 */
export function particleFieldIds(source: string): string[] {
  if (!source.includes('SectionIdContext.Provider')) return [];
  const out: string[] = [];
  let section = '';
  const re = /<Section\s+title="([^"]+)"|<(?:Num|Check|Enum|Color|MinMax|Vec3Row)\s[^>]*?\blabel="([^"]+)"/g;
  for (const m of source.matchAll(re)) {
    if (m[1] !== undefined) section = particleFieldSlug(m[1]);
    else if (section) out.push(`particle.${section}.${particleFieldSlug(m[2])}`);
  }
  return out;
}

// ── #723: derivers for the templated families that used to be verified by SHAPE alone ─────────
//
// `templateToIdPattern`'s `[^.]+` class checks a templated id resolves to the right SHAPE, but it
// cannot check the substituted VALUE — `contextmenu.item.Delelte` matches
// `/^contextmenu\.item\.[^.]+$/` exactly as well as the real `contextmenu.item.Delete` does. Every
// function below closes that for one family the same way `particleFieldIds` above already does:
// read the concrete values out of the source that actually builds the id, so a typo of a real
// value cannot pass and a renamed/removed value goes red instead of silently vouching for
// anything. `knownUiIds` folds each of these into `ids` AND removes the family's shape pattern
// from `patterns` — see the `DERIVED_FAMILY_TEMPLATES` list below for why leaving the shape
// pattern in place would undo the fix (rule 1 of #723's brief).
//
// Families with NO deriver here (`particle.bursts.row.${i}.*`, `spriteAnim.frames.${i}.*`,
// `uiActions.binding.${i}.*`, `spriteEditor.slice.${s.guid}`, every other `*.row.${i}.*`) keep
// their shape pattern on purpose: the substituted value is authored PROJECT DATA (an array index,
// a GUID) with no finite source-side vocabulary to derive from. A shape pattern is the honest
// answer there; it would be the dishonest one everywhere else in this list.

/**
 * `balancedBraceSpan`/`topLevelObjectKeys`/`splitTopLevelItems` below all need to know real
 * `{}[]()` DEPTH, but counting those characters wherever they appear TEXTUALLY breaks the moment
 * one appears inside a string — `tooltip: 'playing (or not'` has an unmatched `(` that is not a
 * bracket at all. Measured (#723 review, item H): injecting that exact string into
 * `registerTraits.ts` silently dropped 8 ids (every field of `SkeletalAnimator`, the trait whose
 * span the desynced counter then ran past).
 *
 * The fix is NOT to blank the source and scan the blanked text — `stripCommentsAndStrings` blanks
 * a string literal's content (the very field names and key names these functions extract) to
 * spaces. Instead: build a DEPTH-SAFE companion string of identical length via the shared,
 * parser-driven stripper, use IT to decide where a `{`/`[`/`(`/`,` is real, but slice/accumulate
 * the actual TEXT from the original — positions line up 1:1 because both stripping passes are
 * length-preserving.
 */

/** A generic helper the trait-registry derivers below share: given the index of an object
 *  literal's opening `{` (in `text`, whose depth-safe companion is `depthSafe` — same length, same
 *  offsets), return the text strictly between it and its MATCHING `}` (brace-depth aware, so a
 *  nested `{ }` inside a field's own config — `castShadow: { type: 'enum', ... }` — does not end
 *  the scan early, AND a `{`/`}` inside a STRING cannot desync it either — see the note above). */
function balancedBraceSpan(text: string, depthSafe: string, openBraceIndex: number): string {
  let depth = 0;
  for (let i = openBraceIndex; i < depthSafe.length; i++) {
    if (depthSafe[i] === '{') depth++;
    else if (depthSafe[i] === '}') {
      depth--;
      if (depth === 0) return text.slice(openBraceIndex + 1, i);
    }
  }
  return '';
}

/** The bracket-matching twin of `balancedBraceSpan`, for a `[ ... ]` array literal (used by
 *  `projectSettingsFieldIds` below to find a `fields: [ ... ]` array's body). */
function balancedBracketSpan(text: string, depthSafe: string, openBracketIndex: number): string {
  let depth = 0;
  for (let i = openBracketIndex; i < depthSafe.length; i++) {
    if (depthSafe[i] === '[') depth++;
    else if (depthSafe[i] === ']') {
      depth--;
      if (depth === 0) return text.slice(openBracketIndex + 1, i);
    }
  }
  return '';
}

/** Split an array/object literal's BODY into its top-level entries at DEPTH-0 commas — decided
 *  from `depthSafeBody` (same length as `body`), so a comma or bracket inside a string cannot
 *  fracture an entry or hide a real separator. Shared by `topLevelObjectKeys` (below) and
 *  `projectSettingsFieldIds`'s array-of-field-objects scan. */
function splitTopLevelItems(body: string, depthSafeBody: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < depthSafeBody.length; i++) {
    const d = depthSafeBody[i];
    if (d === '{' || d === '[' || d === '(') depth++;
    else if (d === '}' || d === ']' || d === ')') depth--;
    else if (d === ',' && depth === 0) {
      items.push(body.slice(start, i));
      start = i + 1;
    }
  }
  if (start < body.length) items.push(body.slice(start));
  return items;
}

/** The key of one top-level object-literal entry (`key: { ... }` or `key: value`), as split out by
 *  `splitTopLevelItems` — `undefined` when the entry does not start with a plain or quoted key. */
function entryKey(entry: string): string | undefined {
  const m = /^\s*(?:'([^']+)'|([A-Za-z_$][\w$]*))\s*:/.exec(entry);
  return m?.[1] ?? m?.[2];
}

interface TraitDecl {
  name: string;
  category: string;
  /** The text inside `fields: { ... }`, or '' when the trait has none (a tag). */
  fieldsBody: string;
  /** The depth-safe (string-blanked) companion of `fieldsBody`, same length/offsets — see the
   *  note above `balancedBraceSpan` for why `topLevelObjectKeys` needs this rather than
   *  `fieldsBody` itself to split fields safely. */
  depthSafeFieldsBody: string;
}

/** Every `registerTrait({ name: '…', category: '…', fields: {…} })` call in a source file,
 *  parsed with brace-depth tracking rather than a single regex — the fields object routinely
 *  contains its own nested `{ }` (an `options: [...]`, a per-field config object), which a
 *  non-greedy `[^}]*?` would stop at prematurely. Shared by `traitFieldIds`, `traitSectionIds` and
 *  `addComponentItemIds` below so the three cannot read the registry three different ways.
 *
 *  Gated on the literal substring `registerTrait(` before doing any work: `stripCommentsAndStrings`
 *  is a real TypeScript parse, and every other (non-registry) source in the corpus — plus dozens of
 *  hand-typed fixtures in the tests below — would otherwise pay that cost for nothing. */
// `traitFieldIds`/`traitSectionIds`/`addComponentItemIds` each call `traitDecls` independently on
// the SAME source, and it now does a real TS parse (not just a regex scan) — keyed on the exact
// source TEXT (immutable within one test run, and the `registerTrait(` gate already keeps this
// tiny: only a handful of files in the whole corpus ever populate it).
const traitDeclsCache = new Map<string, TraitDecl[]>();

function traitDecls(source: string): TraitDecl[] {
  if (!source.includes('registerTrait(')) return [];
  const cached = traitDeclsCache.get(source);
  if (cached) return cached;
  // Depth-safe companion, SOLELY to decide where a `{`/`}` is real (see the note above
  // `balancedBraceSpan`) — the actual name/category/field text is always sliced from `source`.
  //
  // The literal substring `registerTrait(` is not unique to `registerTraits.ts` — its own
  // DEFINITION (`traitRegistry.ts`) and one call site inside a `.tsx` panel (`createEditor.tsx`)
  // both contain it too, and `stripCommentsAndStrings` THROWS on whichever extension fails to
  // parse. Same two-attempt strategy as `assertKnownUiIdsSourceSurvived` above: try TSX (JSX is
  // the common case), fall back to plain TS.
  let depthSafe: string;
  try {
    depthSafe = stripCommentsAndStrings(source, 'traitDecls-source.tsx');
  } catch {
    depthSafe = stripCommentsAndStrings(source, 'traitDecls-source.ts');
  }
  const out: TraitDecl[] = [];
  const callRe = /registerTrait\(\{/g;
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(source))) {
    const openIdx = m.index + m[0].length - 1;
    const body = balancedBraceSpan(source, depthSafe, openIdx);
    if (!body) continue;
    const bodyStart = openIdx + 1;
    const depthSafeBody = depthSafe.slice(bodyStart, bodyStart + body.length);
    const name = /name:\s*'([^']+)'/.exec(body)?.[1];
    const category = /category:\s*'([^']+)'/.exec(body)?.[1];
    if (!name || !category) continue;
    let fieldsBody = '';
    let depthSafeFieldsBody = '';
    const fieldsIdx = body.indexOf('fields:');
    if (fieldsIdx !== -1) {
      const braceIdx = body.indexOf('{', fieldsIdx);
      if (braceIdx !== -1) {
        fieldsBody = balancedBraceSpan(body, depthSafeBody, braceIdx);
        const fieldsBodyStart = braceIdx + 1;
        depthSafeFieldsBody = depthSafeBody.slice(fieldsBodyStart, fieldsBodyStart + fieldsBody.length);
      }
    }
    out.push({ name, category, fieldsBody, depthSafeFieldsBody });
  }
  traitDeclsCache.set(source, out);
  return out;
}

/** Field `type`s `Inspector.tsx`'s `renderField`/`VecField` actually tag with a `data-ui-id` —
 *  plain/unit `number` (also every grouped Vec2/Vec3 member: `renderVecGroup` only groups
 *  `type: 'number'` fields, so no separate case is needed), plain/asset `string`, and `boolean`.
 *  `'enum'` (→ `DropdownField`), `'color'` (→ `ColorField`), `'entityRef'` (→ `EntityRefField`),
 *  `'bindings'` and `'materialOverrides'` all render through widgets with NO `data-ui-id` anywhere
 *  in their bodies (verified against `Inspector.tsx`/`widgets.tsx`/`inspectorFields.tsx`), and
 *  `renderField`'s terminal `return null` covers anything else. */
const INSPECTOR_TAGGED_FIELD_TYPES = new Set(['number', 'string', 'boolean']);

/**
 * `inspector.field.${traitName}.${f.key}` AND `inspector.field.${meta.name}.${key}` — TWO
 * templates in `Inspector.tsx`/`assetViews/widgets.tsx` that build the SAME id shape, so one
 * deriver serves both (see `DERIVED_FAMILY_TEMPLATES`, which removes both from `patterns`).
 *
 * Derived from `engine/app/ecs/registerTraits.ts` — the trait's OWN field declarations — rather
 * than shape-matching `inspector\.field\.[^.]+\.[^.]+`, which would (again) vouch for a typo'd
 * field name on a trait that has never had one.
 *
 * ⚠️ **#723 review finding A: deriving the KEY is not enough — the field's own `type` decides
 * whether `renderField` tags it at all.** Measured against the current
 * `engine/app/ecs/registerTraits.ts` (2026-09-06): 92 `enum`, 29 `color`, 11 `entityRef`, 1
 * `bindings` and 1 `materialOverrides` field declarations — 134 fields whose widget renders no
 * `data-ui-id`, all of which this deriver used to vouch for (`inspector.field.UIElement.
 * flexDirection`, an enum, and `inspector.field.Renderable2D.color`, a color, among them). Only
 * `INSPECTOR_TAGGED_FIELD_TYPES` above is derived.
 *
 * Two further STATIC suppressions `Inspector.tsx` applies before a field ever reaches
 * `renderField`, both measured the same way:
 *  - `hidden: true` (`Inspector.tsx`'s `topItems`/`sections` memo) — 28 fields, e.g.
 *    `EntityAttributes.sourceScene`.
 *  - claimed as ANOTHER field's `alphaField` (`Inspector.tsx`'s `renderField`, folded into that
 *    field's own color-picker alpha slider) — 10 fields, e.g. `Renderable2D.opacity`,
 *    `UIElement.backgroundOpacity`.
 *
 * ⚠️ **Engine built-ins ONLY, deliberately not widened to `games/**`.** A game calls
 * `registerTrait` too (`games/court/runtime/systems.ts` among others), but a QA case is pinned to
 * ONE `fixture_project` — pooling every game's traits into one id set would let a case pinned to
 * `wordweave` cite a `court` trait field and still go green, which is the exact fail-open #723
 * exists to close. A case citing a GAME trait's field falls through to the shape-only baseline
 * instead — "I cannot verify this" is the honest answer until this is refined per-fixture.
 */
export function traitFieldIds(source: string): string[] {
  const out: string[] = [];
  for (const d of traitDecls(source)) {
    const entries = splitTopLevelItems(d.fieldsBody, d.depthSafeFieldsBody);
    // A field claimed as ANOTHER field's alpha slider is never a standalone row, whatever ITS own
    // type is — collected first so the second pass can simply skip a claimed key.
    const alphaTargets = new Set<string>();
    for (const entry of entries) {
      const af = /\balphaField:\s*'([\w$]+)'/.exec(entry)?.[1];
      if (af) alphaTargets.add(af);
    }
    for (const entry of entries) {
      const key = entryKey(entry);
      if (!key || alphaTargets.has(key)) continue;
      if (/\bhidden:\s*true\b/.test(entry)) continue;
      const type = /\btype:\s*'([\w-]+)'/.exec(entry)?.[1];
      if (!type || !INSPECTOR_TAGGED_FIELD_TYPES.has(type)) continue;
      out.push(`inspector.field.${d.name}.${key}`);
    }
  }
  return out;
}

/**
 * `inspector.section.${title}.header` and `.menu` (`assetViews/widgets.tsx`). `title` is
 * `meta.name`, or `` `${meta.name} (resource)` `` for a resource trait (`Inspector.tsx`'s
 * `isResource` — `meta.category === 'resource'`) — both forms are derived here so a resource
 * trait's section id does not silently fall to the baseline.
 *
 * ⚠️ **#723 review finding B: `EntityAttributes` is excluded.** `Inspector.tsx` (its trait-section
 * filter, `t.meta.category === 'component' && t.meta.name !== 'EntityAttributes'`) never renders it
 * as a normal `<Section>` — it gets its own inline header (checkbox + name + id) above every other
 * component. `inspector.section.EntityAttributes.header`/`.menu` have never existed.
 */
export function traitSectionIds(source: string): string[] {
  const out: string[] = [];
  for (const d of traitDecls(source)) {
    if (d.name === 'EntityAttributes') continue;
    if (d.category !== 'component' && d.category !== 'resource') continue;
    const title = d.category === 'resource' ? `${d.name} (resource)` : d.name;
    out.push(`inspector.section.${title}.header`, `inspector.section.${title}.menu`);
  }
  return out;
}

/**
 * `inspector.addComponent.item.${t.name}` (`AddComponentPicker.tsx`) — one row per `component`
 * trait `Inspector.tsx` offers via `getAllTraits().filter(t => t.category === 'component' && …)`.
 * The second half of that filter (not already on the selected entity) is per-SCENE state this
 * static scan cannot see, so this derives the wider "could plausibly be addable" set rather than
 * the narrower "addable to entity X right now" one — the same kind of honest over-approximation
 * `knownUiIds` already makes for every other family (it verifies a selector CAN exist, not that
 * it is visible in the current DOM).
 *
 * ⚠️ **#723 review finding B: `EntityAttributes` is excluded**, for the same reason as
 * `traitSectionIds` above — it is never offered as an addable component (every entity already has
 * one), so `inspector.addComponent.item.EntityAttributes` has never existed either.
 */
export function addComponentItemIds(source: string): string[] {
  return traitDecls(source)
    .filter((d) => d.category === 'component' && d.name !== 'EntityAttributes')
    .map((d) => `inspector.addComponent.item.${d.name}`);
}

/**
 * `inspector.subsection.${subSectionSlug(title)}` (`assetViews/widgets.tsx`) — but only for the
 * LITERAL `<SubSection title="…">` call sites. `Inspector.tsx`'s own call
 * (`<SubSection title={sectionName} …>`) passes a name built from trait field metadata rather
 * than a string literal, so it has no static value to derive here and falls to the baseline
 * exactly like a `*.row.${i}.*` family would — a real gap, not an oversight, and the honest
 * answer until a future pass derives it from `registerTrait`'s per-field `group`/`section` too.
 *
 * `subSectionSlug` is REIMPLEMENTED here rather than imported from `widgets.tsx`, unlike
 * `particleFieldSlug` above — `widgets.tsx` is a full panel module (React, `ContextMenu`, the
 * backend fetch seam), not the small dependency-free module `particle/fieldIds.ts` was carved out
 * to be, and importing it into this architecture test would drag that whole graph in for a
 * five-line function. `engine/tests/editor/subSectionUiIds.test.ts` already establishes this exact
 * trade-off (mirror + a `toContain` check pinning the mirror to the source) — read there before
 * "fixing" this by switching to an import.
 */
export function traitSubSectionIds(source: string): string[] {
  const slug = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const out = new Set<string>();
  for (const m of source.matchAll(/<SubSection\s+title="([^"]+)"/g)) out.add(slug(m[1]));
  return [...out].map((s) => `inspector.subsection.${s}`);
}

/**
 * `animation.viewMode.${m}` (`animation/TrackList.tsx`) — derived from the `(['dopesheet',
 * 'curves'] as const).map(...)` tuple the tabs are built from, so a third view mode is picked up
 * automatically and a typo of either name (`animation.viewMode.dopesheat`) does not pass.
 *
 * ⚠️ Gated on the file containing the `animation.viewMode.` template text itself, and NOT just on
 * finding an `(X as const).map(...)` shape — that shape is common (`ConsoleTab.tsx`'s log-level
 * filter, `SceneView.tsx`'s view toggles, `TextureAssetView.tsx`'s edge picker all use it), so an
 * ungated match would derive `animation.viewMode.show3D` from a SceneView tuple that has nothing
 * to do with this family. Measured, not theorised: caught by running this over the real 3 scan
 * roots before trusting it.
 */
export function animationViewModeIds(source: string): string[] {
  if (!source.includes('animation.viewMode.')) return [];
  const m = /\(\[([^\]]*)\]\s*as const\)\.map/.exec(source);
  if (!m) return [];
  return [...m[1].matchAll(/'([^']+)'/g)].map((mm) => `animation.viewMode.${mm[1]}`);
}

/**
 * `sceneView.toolbar.gizmo.${m.value}` (`SceneView.tsx`) — derived from the module-level
 * `gizmoModes` array's `value` field, the same array the toolbar itself maps over.
 */
export function sceneViewGizmoIds(source: string): string[] {
  const m = /gizmoModes:\s*Array<[^>]*>\s*=\s*\[([\s\S]*?)\];/.exec(source);
  if (!m) return [];
  return [...m[1].matchAll(/value:\s*'([^']+)'/g)].map((mm) => `sceneView.toolbar.gizmo.${mm[1]}`);
}

/**
 * `gameView.devicePicker.device.${d.name}` (`DevicePicker.tsx`) — derived from every `name:` the
 * `DEVICE_PRESETS` catalog declares (`devicePresets.ts`), plus `FREE_PRESET`'s own `name: 'Free'`
 * (spread into the array by reference, not as a literal `{ name: … }` inside it, so it needs its
 * own read).
 */
export function devicePickerDeviceIds(source: string): string[] {
  const m = /DEVICE_PRESETS:\s*DevicePreset\[\]\s*=\s*\[([\s\S]*?)\n\];/.exec(source);
  if (!m) return [];
  const names = new Set<string>();
  for (const mm of m[1].matchAll(/name:\s*'([^']+)'/g)) names.add(mm[1]);
  const free = /FREE_PRESET[^=]*=\s*\{[^}]*name:\s*'([^']+)'/.exec(source)?.[1];
  if (free) names.add(free);
  return [...names].map((n) => `gameView.devicePicker.device.${n}`);
}

/**
 * `module-toggles.${m.key}.${o.slug}` (`ModuleTogglesEditor.tsx`) — a closed 5×3 cross-product of
 * `MODULES`' `key` and `OPTIONS`' `slug`, both module-level arrays in the same file.
 */
export function moduleToggleIds(source: string): string[] {
  const modules = /const MODULES:[^=]*=\s*\[([\s\S]*?)\n\];/.exec(source);
  const options = /const OPTIONS:[^=]*=\s*\[([\s\S]*?)\n\];/.exec(source);
  if (!modules || !options) return [];
  const keys = [...modules[1].matchAll(/key:\s*'([^']+)'/g)].map((mm) => mm[1]);
  const slugs = [...options[1].matchAll(/slug:\s*'([^']+)'/g)].map((mm) => mm[1]);
  const out: string[] = [];
  for (const key of keys) for (const slug of slugs) out.push(`module-toggles.${key}.${slug}`);
  return out;
}

/**
 * The whole `quality-tiers.*` namespace — four templates across TWO files
 * (`QualityTiersEditor.tsx`'s `TIER_COLUMNS`, and `qualityTiersModel.ts`'s `MATRIX_GROUPS` +
 * `POSTFX_LABELS`), so unlike every other deriver here this one takes the WHOLE `sources` array
 * and finds its own two files in it rather than being called once per file.
 *
 * ⚠️ Matching `MATRIX_GROUPS` requires the DECLARATION (`export const MATRIX_GROUPS`), not a bare
 * mention — `QualityTiersEditor.tsx` merely IMPORTS the name, and `sources.find` would otherwise
 * silently grab the wrong file (the editor, which has no `POSTFX_LABELS` or `field:` rows at all)
 * and derive nothing. Caught by running this against the real files before trusting it.
 *
 * `quality-tiers.field.${tier}.${row.field}` gets EVERY row's field (`TierCell` renders one for
 * every row regardless of `defaultPath`), but `quality-tiers.field.default.${row.field}` only
 * gets rows where `defaultPath !== null` (`DefaultCell` renders nothing else for `textureMaxSize`
 * or a `postfx` row) — that asymmetry is why `defaultPath` is read per field rather than just
 * collecting every `field:` literal once.
 */
export function qualityTierIds(sources: string[]): string[] {
  const editorSrc = sources.find((s) => s.includes('const TIER_COLUMNS'));
  const modelSrc = sources.find((s) => s.includes('export const MATRIX_GROUPS'));
  if (!editorSrc || !modelSrc) return [];

  const tierMatch = /const TIER_COLUMNS:[^=]*=\s*\[([^\]]*)\]/.exec(editorSrc);
  const tiers = tierMatch ? [...tierMatch[1].matchAll(/'([^']+)'/g)].map((mm) => mm[1]) : [];

  const postfxMatch = /export const POSTFX_LABELS[^=]*=\s*\{([^}]*)\}/.exec(modelSrc);
  const postfxFields = postfxMatch ? [...postfxMatch[1].matchAll(/(\w+):/g)].map((mm) => mm[1]) : [];

  const rowFields: string[] = [];
  const defaultableFields: string[] = [];
  for (const m of modelSrc.matchAll(/field:\s*'([\w-]+)'[\s\S]*?defaultPath:\s*(null|'[^']*')/g)) {
    rowFields.push(m[1]);
    if (m[2] !== 'null') defaultableFields.push(m[1]);
  }
  const allFields = [...new Set([...rowFields, ...postfxFields])];

  const out: string[] = [];
  for (const tier of tiers) {
    out.push(`quality-tiers.add.${tier}`, `quality-tiers.remove.${tier}`);
    for (const field of allFields) out.push(`quality-tiers.field.${tier}.${field}`);
  }
  for (const field of defaultableFields) out.push(`quality-tiers.field.default.${field}`);
  return out;
}

/** Control kinds `FieldControl` (`ProjectSettingsDialog.tsx`'s `switch (field.type)`) renders by
 *  handing the WHOLE control off to a dedicated sub-editor component with no `uiId` threaded
 *  through at all — no `data-ui-id` anywhere in the rendered output for these. */
const PROJECT_SETTINGS_UNTAGGED_CONTROL_KINDS = new Set([
  'scene-list', 'physics-layers', 'module-toggles', 'quality-tiers',
]);

/**
 * `projectSettings.${field.key}` (`ProjectSettingsDialog.tsx`'s `FieldControl`) — derived from
 * every field object's OWN top-level `key`/`type` in `engine/app/editor/setup.ts`'s `fields: [...]`
 * arrays (brace/bracket-depth aware — see the note above `balancedBraceSpan`: a `showIf`/
 * `disabledIf` guard nests its OWN `{ key: '…' }` pointing at ANOTHER field, and reading only each
 * array item's TOP-LEVEL key/type is what keeps that nested key from borrowing the outer field's
 * type, or vice versa).
 *
 * ⚠️ **#723 review finding C — two bugs, opposite directions.**
 *
 * **Over-derived:** `FieldControl` renders NO `data-ui-id` at all for `scene-list`,
 * `physics-layers`, `module-toggles` and `quality-tiers` (`PROJECT_SETTINGS_UNTAGGED_CONTROL_KINDS`
 * above) — each hands the control to a sub-editor with no `uiId` prop. `projectSettings.rendering`,
 * `.physics`, `.build.modules` and `.content.scenes` were ACCEPTED and impossible. Filtered by
 * control KIND, not by hardcoding these four keys, so a fifth untagged kind can't reopen this.
 *
 * **Under-derived:** the dialog also emits `${uiId}.select` (a `combo` field's known-values
 * dropdown, when `options.length > 0`), `.browse`/`.warning`/`.dropError` (every `path` field's
 * Browse button and validation text) and `.preview` (a `path` field whose value resolves to an
 * image). Every one of these is built as `` `${uiId}.suffix` `` — a template literal whose captured
 * content STARTS with `${`, which `knownUiIds`'s `t.startsWith('$')` guard drops from
 * `patterns`/`allPatterns` entirely (its own comment explains why: no static prefix to anchor a
 * shape pattern on). They were unresolvable by shape OR derivation —
 * `projectSettings.build.appleTeamId.select` and `projectSettings.app.iconSource.browse` both came
 * back REJECTED, though nothing cites them yet. Derived here as concrete ids (added straight to
 * `ids`, never to a shape pattern) by control kind, over-approximating the runtime condition
 * (`options.length > 0`, a validation message actually present) exactly as `addComponentItemIds`
 * above over-approximates "could plausibly be addable".
 *
 * ⚠️ Landing this deriver is what makes `templateToIdPattern`'s one-family `.+` allowlist (the
 * `projectSettings.${` special case) dead code — see that function's comment for why it is
 * deleted in the same change rather than left "just in case".
 */
export function projectSettingsFieldIds(source: string): string[] {
  if (!source.includes("key: 'app.appName'")) return [];
  const depthSafe = stripCommentsAndStrings(source, 'setup.ts');
  const out = new Set<string>();
  const fieldsRe = /fields:\s*\[/g;
  let m: RegExpExecArray | null;
  while ((m = fieldsRe.exec(source))) {
    const openIdx = m.index + m[0].length - 1;
    const arrayBody = balancedBracketSpan(source, depthSafe, openIdx);
    if (!arrayBody) continue;
    const bodyStart = openIdx + 1;
    const depthSafeArrayBody = depthSafe.slice(bodyStart, bodyStart + arrayBody.length);
    for (const entry of splitTopLevelItems(arrayBody, depthSafeArrayBody)) {
      const key = /\bkey:\s*'([\w.]+)'/.exec(entry)?.[1];
      if (!key) continue;
      const type = /\btype:\s*'([\w-]+)'/.exec(entry)?.[1];
      if (type && PROJECT_SETTINGS_UNTAGGED_CONTROL_KINDS.has(type)) continue;
      const uiId = `projectSettings.${key}`;
      out.add(uiId);
      if (type === 'combo') out.add(`${uiId}.select`);
      if (type === 'path') {
        out.add(`${uiId}.browse`);
        out.add(`${uiId}.warning`);
        out.add(`${uiId}.dropError`);
        out.add(`${uiId}.preview`);
      }
    }
  }
  return [...out];
}

/**
 * `contextmenu.item.${item.label}` (`ContextMenu.tsx`) — derived from every STATIC
 * `label: '…'` inside an object that also carries `onClick` or `children` (the two shapes a real
 * `ContextMenuItem` is built with). Measured against the current tree (2026-09-06): 52 unique
 * labels across the 4 files that actually contribute — `Hierarchy.tsx` (38), `Assets.tsx` (11),
 * `animation/CurvesView.tsx` (6) and `Inspector.tsx` (1). `SceneView.tsx` mentions no
 * `ContextMenuItem` at all (the gate below returns `[]` before scanning it) and
 * `assetViews/widgets.tsx` passes the gate but matches nothing — both scanned, both currently
 * contributing 0, kept in the corpus walk (not this function) rather than excluded, so a future
 * context menu added to either is picked up with no code change here.
 *
 * ⚠️ That `onClick|children` requirement is load-bearing, not decoration: without it this would
 * also catch `Hierarchy.tsx`'s `pushAction({ label: 'Paste Entity', undo: …, redo: … })` — an UNDO
 * HISTORY entry, not a context-menu row, and `contextmenu.item.Paste Entity` has never existed.
 * Vouching for a string that merely LOOKS like a menu label is exactly the shape-blanket failure
 * `particleFieldIds`'s docblock warns about, arrived at from a different direction.
 *
 * Deliberately does NOT attempt the interpolated labels (`` `Instantiate "${prefab.name}"` ``,
 * `` `Remove ${title}` ``, `` `Duplicate${suffix}` ``, `` `Detach prefab "${name}"` ``) — there is
 * no finite source-side vocabulary for a prefab/entity name, so those fall to the shape-only
 * baseline exactly like a `*.row.${i}.*` id would. Do not add a shape regex for this family "to
 * cover" them — that is the fix #723 exists to remove, not reinstate.
 *
 * ⚠️ Gated on the file mentioning `ContextMenuItem` at all, and that gate is load-bearing too:
 * without it this matched `engine/app/debug/hmrStaleness.ts`'s UNRELATED `BannerAction` items
 * (`{ label: 'Dismiss', onClick: … }`, `{ label: 'Reload now', onClick: … }`) — same object
 * shape, nothing to do with a context menu — and would have vouched for
 * `contextmenu.item.Dismiss`, a selector that has never existed. Measured, not theorised: caught
 * by running this deriver over the real 3 scan roots before trusting it.
 */
export function contextMenuItemIds(source: string): string[] {
  if (!source.includes('ContextMenuItem')) return [];
  const out = new Set<string>();
  for (const m of source.matchAll(/\{\s*label:\s*'([^']+)'[^}]*?(?:onClick|children)\s*:/g)) {
    out.add(m[1]);
  }
  return [...out].map((label) => `contextmenu.item.${label}`);
}

/**
 * Every templated family that now has a deriver above — matched against the RAW template string
 * `knownUiIds` captured (e.g. `` `sceneView.toolbar.gizmo.${m.value}` ``), not the compiled regex.
 *
 * This is rule 1 of #723's brief, and it is the part that actually fixes anything: a deriver that
 * adds concrete ids to `ids` while its template's SHAPE PATTERN survives in `patterns` changes
 * nothing — `contextmenu.item.Delelte` still matches `/^contextmenu\.item\.[^.]+$/` and the guard
 * is exactly as blind as before. Excluding the pattern is what makes a typo, or a deriver that
 * later under-derives (a panel refactor, a renamed literal), go RED instead of silently passing —
 * fail-closed, which is the direction this file wants to break in.
 */
const DERIVED_FAMILY_TEMPLATES: RegExp[] = [
  /^animation\.viewMode\.\$\{/,
  /^sceneView\.toolbar\.gizmo\.\$\{/,
  /^gameView\.devicePicker\.device\.\$\{/,
  /^module-toggles\.\$\{[^}]*\}\.\$\{/,
  /^quality-tiers\.field\.\$\{[^}]*\}\.\$\{/,
  /^quality-tiers\.add\.\$\{/,
  /^quality-tiers\.remove\.\$\{/,
  /^quality-tiers\.field\.default\.\$\{/,
  // #723 review, item E: anchored on the `projectSettings.` id NAMESPACE plus "this is a
  // template" (the same shape every other entry here uses), NOT on the destructured variable
  // name `field` in `ProjectSettingsDialog.tsx`'s `const uiId = `projectSettings.${field.key}`;`.
  // The old `/^projectSettings\.\$\{field/` was the one entry anchored on an IDENTIFIER rather
  // than the namespace — rename `field` to `f` there and it silently stops matching, which a
  // dead-exclusion test could not have caught without ALSO covering rename-immunity (`f.key`
  // still matches this one; verified against a scratch copy, not left in the tree).
  /^projectSettings\.\$\{/,
  /^inspector\.field\.\$\{/,
  /^inspector\.section\.\$\{[^}]*\}\.header$/,
  /^inspector\.section\.\$\{[^}]*\}\.menu$/,
  /^inspector\.subsection\.\$\{/,
  /^inspector\.addComponent\.item\.\$\{/,
  /^contextmenu\.item\.\$\{/,
];

/**
 * A template literal (`a.b.${x}.c`) as an anchored regex over a complete id.
 *
 * ⚠️ **`[^.]+`, not `.+`.** A placeholder stands for ONE id segment, and the difference is the
 * whole value of this function: 41 of the 79 templates in the editor END in a placeholder
 * (`sceneView.toolbar.gizmo.${m.value}`, `spriteEditor.slice.${s.guid}`, `skin.bones.row.${i}`),
 * so with `.+` there is no trailing literal to anchor against and the id matches anything under
 * the prefix — the exact hole this replaced prefix-matching to close, surviving for ~30 of the
 * ~49 families. Measured across all cases plus qa/README.md: narrowing to `[^.]+` false-alarms
 * ZERO live citations while rejecting `sceneView.toolbar.gizmo.0.time`,
 * `spriteEditor.slice.0.bogus`, `skin.bones.row.0.x` and `timeline.tracks.row.0.bogus`.
 */
function templateToIdPattern(template: string): RegExp {
  const literal = template
    .split(/\$\{[^}]*\}/)
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  // #723: this used to carry a one-family `.+` allowlist here for `projectSettings.${field.key}`
  // (a DOTTED settings key, not a single segment). `projectSettingsFieldIds` now derives that
  // family's concrete values instead, and `DERIVED_FAMILY_TEMPLATES` removes its shape pattern
  // from `patterns` entirely — so this function is never even CALLED for that template anymore,
  // and the allowlist was dead weight. Deleted rather than left "just in case": a second family
  // that legitimately needs a dotted placeholder should get its OWN deriver, not reopen this hole.
  return new RegExp(`^${literal.join('[^.]+')}$`);
}


/**
 * Paths that do not exist are acceptable when git IGNORES them — a build output like
 * `games/<id>/dist` is a legitimate thing for a build case to name, and it only exists after
 * the build the case is describing.
 *
 * check-ignore is asked about a CHILD path too: a `dist/` pattern matches directories, and
 * git answers "not ignored" for a directory path that is not on disk.
 */
function isIgnoredBuildOutput(path: string): boolean {
  for (const candidate of [path, `${path}/_probe`]) {
    try {
      git(['check-ignore', '-q', '--', candidate]);
      return true;
    } catch {
      /* exit 1 = not ignored; try the next candidate */
    }
  }
  return false;
}

/**
 * Unit cover for this guard's own helpers.
 *
 * These run unconditionally — they take no repo state, so they hold in the OSS snapshot too.
 * Both cases below are regressions found by reviewing this file AFTER it shipped green: a guard
 * that is wrong is worse than no guard, because it reports "clean" either way.
 */
describe('qa case guard helpers', () => {
  describe('codeTokens', () => {
    it('splits an inline span on whitespace so "script arg" citations are BOTH checked', () => {
      // The regression: this returned one token containing a space, which the caller's
      // placeholder filter then skipped entirely — silently un-checking both paths.
      const tokens = codeTokens('Run `engine/scripts/launch-editor.sh games/3d-test` now.');
      expect(tokens).toContain('engine/scripts/launch-editor.sh');
      expect(tokens).toContain('games/3d-test');
    });

    it('still returns a lone inline token', () => {
      expect(codeTokens('see `engine/scripts/solo.sh` here')).toEqual(['engine/scripts/solo.sh']);
    });

    it('splits fenced blocks and drops empty fragments', () => {
      const tokens = codeTokens('```bash\nnpm run build -- --target web\n```');
      expect(tokens).toContain('npm');
      expect(tokens).toContain('--target');
      expect(tokens).not.toContain('');
    });

    it('ignores prose outside code spans', () => {
      expect(codeTokens('engine/scripts/not-in-backticks.sh')).toEqual([]);
    });
  });

  describe('codeSpans', () => {
    it('returns whole spans, so a path containing a space can be checked as one path', () => {
      // The real case: `games/3d-test/runtime/assets/scenes/2D Animation.scene.json` exists on disk.
      // Split on whitespace it becomes `…/scenes/2D` + `Animation.scene.json`, and the checker
      // reports a correct citation as a missing path.
      const md = 'open `games/3d-test/runtime/assets/scenes/2D Animation.scene.json` now';
      expect(codeSpans(md)).toEqual(['games/3d-test/runtime/assets/scenes/2D Animation.scene.json']);
    });

    it('ignores fenced blocks (only inline spans carry space-bearing paths in practice)', () => {
      expect(codeSpans('```bash\nls games/x\n```')).toEqual([]);
    });
  });

  describe('exemptFragments', () => {
    const full = 'games/sling/runtime/assets/sprites/slime spritesheet calciumtrice.png.meta.json';
    const truncated = 'games/sling/runtime/assets/sprites/slime';

    it('exempts the pieces of a verified space-bearing path', () => {
      expect([...exemptFragments([full], [full])].sort()).toEqual([
        'calciumtrice.png.meta.json',
        truncated,
        'spritesheet',
      ]);
    });

    it('does NOT exempt a fragment the case also cites as a path in its own right', () => {
      // The false negative this closes: `<…>/slime` is both a broken citation AND the first
      // fragment of the valid full path, so a global exemption swallowed it silently.
      expect(exemptFragments([full, truncated], [full]).has(truncated)).toBe(false);
    });
  });

  describe('citesALine', () => {
    it('catches every shape a line citation is written in', () => {
      expect(citesALine('games/court/runtime/saveSync.ts:1745')).toBe(true);
      expect(citesALine('games/court/runtime/saveSync.ts:1381-1417')).toBe(true);
      expect(citesALine('engine/tools/modoki-mcp/src/tools/editor.ts:288,310,323,338')).toBe(true);
      expect(citesALine('docs/editor.md#L12')).toBe(true);
      expect(citesALine('games/court/accounts.md:762-775')).toBe(true);
    });

    it('catches NATIVE and shader files the old extension allowlist waved through', () => {
      // The allowlist named 10 web extensions; the suite cites all of these files today, so a line
      // number on one would have rotted with the gate green over it.
      expect(citesALine('engine/packages/capacitor-ota/ios/OtaPlugin.swift:88')).toBe(true);
      expect(citesALine('Package.swift:214')).toBe(true);
      expect(citesALine('index.html:41')).toBe(true);
      expect(citesALine('android/app/build.gradle:57')).toBe(true);
    });

    it('catches a PATH whatever its suffix, so the rule cannot go stale', () => {
      expect(citesALine('engine/some/new/thing.zigzag:12')).toBe(true);
    });

    it('catches Objective-C and the Class.method():NNN shape (#686)', () => {
      // Both were live in docs/native-and-sdks.md and docs/player-prefs.md until #686 removed
      // them; neither was reachable by the enumeration regexes that drove the sweeps, so the guard
      // found them, not the sweep.
      expect(citesALine('CAPPlugin.m:82-93')).toBe(true);
      expect(citesALine('CAPPlugin.h:40')).toBe(true);
      expect(citesALine('BridgeActivity.onStop():118')).toBe(true);
      expect(citesALine('onResume():97')).toBe(true);
    });

    it('does NOT fire on a JSON payload that merely contains a path and a :N', () => {
      // docs/debug-tools-mcp.md documents this exact payload. `"value":1` strips like a line ref
      // and the embedded asset path satisfied the slash shortcut.
      expect(
        citesALine('{"clipPath":"/assets/anim/probe.anim.json","trait":"Transform","value":1}'),
      ).toBe(false);
    });

    it('does NOT fire on a TRAIT FIELD, which is `Trait.field:value` by shape', () => {
      // Live in the corpus: nine-slice-corners-unstretched and
      // character-controller-geometry-and-ccd. A pure shape test flags both.
      expect(citesALine('UIElement.width:640')).toBe(false);
      expect(citesALine('Physics2D.gravityX:250')).toBe(false);
    });

    it('leaves the BARE `:NNN` shape alone — a token cannot tell it from a port', () => {
      expect(citesALine(':170')).toBe(false);
      expect(citesALine(':5198')).toBe(false);
    });

    it('does NOT fire on a port, a plain path, or a bare symbol', () => {
      // A port loses its digits to the stripper too — what saves it is that `http://localhost` is
      // not a source file. This is the false positive that would get the assertion disabled, and a
      // disabled guard is worse than none.
      expect(citesALine('http://localhost:5183')).toBe(false);
      expect(citesALine('localhost:9095')).toBe(false);
      expect(citesALine('games/court/runtime/saveSync.ts')).toBe(false);
      expect(citesALine('pendingSyncConflict()')).toBe(false);
      expect(citesALine('npm')).toBe(false);
    });

    it('sees through the trailing punctuation a sentence leaves on a citation', () => {
      expect(citesALine('games/court/runtime/systems.ts:7048,')).toBe(true);
      expect(citesALine('games/court/runtime/systems.ts:7048)')).toBe(true);
    });
  });

  describe('citesALineInProse', () => {
    it('catches both prose shapes, including the tilde hedge', () => {
      expect(citesALineInProse('the `onMove` handler (line 79) commits')).toEqual(['line 79']);
      expect(citesALineInProse('`resolveNav` (lines ~91–108)')).toEqual(['lines ~91']);
      expect(citesALineInProse('see line 1745 and lines 12-20')).toHaveLength(2);
    });

    it('does NOT fire on a RENDERED line measured in a unit', () => {
      // docs/ui-system.md describes autoFitText turning "a correct 2-line wrap (229px) into one
      // non-wrapping line 199px" — and the ui/rendering cases restate that kind of measurement.
      expect(citesALineInProse('one non-wrapping line 199px outside its 200px parent')).toEqual([]);
      expect(citesALineInProse('scan line 240 ms after start')).toEqual([]);
      expect(citesALineInProse('a divider line 32 px tall')).toEqual([]);
    });

    it('does NOT fire on the compound and single-digit false friends', () => {
      expect(citesALineInProse('a 40-line function')).toEqual([]);
      expect(citesALineInProse('the status line')).toEqual([]);
      expect(citesALineInProse('line height is 1.4')).toEqual([]);
      expect(citesALineInProse('line 3 of the table')).toEqual([]);
    });
  });

  describe('isBareLineSpan', () => {
    it('catches the bare citation that reuses a filename from earlier in the sentence', () => {
      // The shape the first #680 sweep missed entirely — its regex demanded a filename before the
      // colon, so nine survived a pass that reported itself clean.
      expect(isBareLineSpan(':170')).toBe(true);
      expect(isBareLineSpan(':14191')).toBe(true);
      expect(isBareLineSpan(':1381-1417')).toBe(true);
    });

    it('catches a two-digit RANGE — an index is a single number, a range is a citation', () => {
      // `docs/native-and-sdks.md` cited `:45-47`, which slipped the three-digit floor.
      expect(isBareLineSpan(':45-47')).toBe(true);
      expect(isBareLineSpan(':12,20')).toBe(true);
    });

    it('does NOT fire on a two-digit handle index — CurveEditor ids are unbounded', () => {
      // A 12-point size curve elides as `particle:curve:size:0` … `:11`. Under a two-digit floor
      // that failed the gate telling its author to "name the function" — impossible for an id.
      expect(isBareLineSpan(':11')).toBe(false);
      expect(isBareLineSpan(':42')).toBe(false);
    });

    it('does NOT fire on a PORT, which is why this takes a span and not a token', () => {
      // Real false positives, caught by this guard on its first full run: every clone has its own
      // port, so qa/ is full of these. Token-splitting `lsof -i :5198` yields a bare `:5198`.
      expect(isBareLineSpan('lsof -i :5198 | xargs kill')).toBe(false);
      expect(isBareLineSpan('http://127.0.0.1:5196/api/identity')).toBe(false);
      expect(isBareLineSpan('curl -s http://127.0.0.1:5197/api/device/connect')).toBe(false);
    });

    it('does NOT fire on a one-digit suffix — those are ids, not lines', () => {
      // `particle:curve:opacity:0` and its `:1`/`:2` siblings are modoki_handles curve-point ids.
      expect(isBareLineSpan(':0')).toBe(false);
      expect(isBareLineSpan(':2')).toBe(false);
      expect(isBareLineSpan('particle:curve:opacity:0')).toBe(false);
    });
  });

  describe('stripLineRef', () => {
    it('strips a single line and a range, keeping the path', () => {
      expect(stripLineRef('engine/app/editor/agentEditorOps.ts:525')).toBe(
        'engine/app/editor/agentEditorOps.ts',
      );
      expect(stripLineRef('engine/app/editor/agentEditorOps.ts:525-573')).toBe(
        'engine/app/editor/agentEditorOps.ts',
      );
      expect(stripLineRef('docs/editor.md#L12')).toBe('docs/editor.md');
    });

    it('strips a comma-separated line list, the shape that cites several call sites at once', () => {
      // Real citation this was added for: qa/knowledge.md named the four tools wiring SAVE_PARAM as
      // `engine/tools/modoki-mcp/src/tools/editor.ts:288,310,323,338`.
      //
      // ⚠️ This comment used to end "rejecting it would push the author to drop the line numbers —
      // making the doc vaguer to satisfy the tool". #680 overturned that: the numbers rot, and the
      // citation now names the four call sites in prose instead, which is what the four numbers
      // were standing in for. The STRIPPING behaviour asserted here is still wanted — see
      // stripLineRef's comment for why the helper outlives the convention it was built to tolerate.
      expect(stripLineRef('engine/tools/modoki-mcp/src/tools/editor.ts:288,310,323,338')).toBe(
        'engine/tools/modoki-mcp/src/tools/editor.ts',
      );
      expect(stripLineRef('foo.ts:10,20-30')).toBe('foo.ts');
    });

    it('leaves a path with no line reference alone', () => {
      expect(stripLineRef('games/anim-bug/project.config.json')).toBe(
        'games/anim-bug/project.config.json',
      );
    });
  });

  describe('knownUiIds', () => {
    it('collects the attribute, prop and object-property forms', () => {
      // All three appear in the real editor. Missing form 2 or 3 reported three CORRECT citations
      // as missing when this check first ran — which is how a guard earns a reputation for lying.
      const { ids } = knownUiIds([
        '<button data-ui-id="inspector.header.delete" />',
        '<TreeSearchInput uiId="assets.toolbar.search" />',
        '<Row dataUiId="quality-tiers.field.mid.shadows" />',
        // A full statement, not a bare JSX-attribute fragment (`items={[…]}`) — the latter is not
        // valid top-level TS/TSX on its own, and #723's `assertKnownUiIdsSourceSurvived` (item G)
        // now actually PARSES every source, which a bare attribute value fails.
        "const items = [{ key: 'grid', uiId: 'sceneView.toolbar.grid' }];",
      ]);
      expect([...ids].sort()).toEqual([
        'assets.toolbar.search',
        'inspector.header.delete',
        'quality-tiers.field.mid.shadows',
        'sceneView.toolbar.grid',
      ]);
    });

    it('exposes the static prefix of a template-built id', () => {
      const { prefixes } = knownUiIds(['<div data-ui-id={`hierarchy.folder.${name}`} />']);
      expect(prefixes).toEqual(['hierarchy.folder.']);
    });

    it('matches a templated id on the WHOLE template, not just its static head', () => {
      // The bug this pins: the check asked `id.startsWith(prefix)`, so `particle.bursts.row.`
      // vouched for every id under it — including a `.time` sibling that does not exist. A case
      // citing it went green and resolved to nothing against a live editor.
      const { patterns } = knownUiIds([
        '<button data-ui-id={`particle.bursts.row.${i}.remove`} />',
      ]);
      const matches = (id: string) => patterns.some((p) => p.test(id));
      expect(matches('particle.bursts.row.0.remove')).toBe(true);
      expect(matches('particle.bursts.row.12.remove')).toBe(true);
      expect(matches('particle.bursts.row.0.time')).toBe(false);
      expect(matches('particle.bursts.row.0')).toBe(false);
      expect(matches('particle.bursts.row.0.remove.extra')).toBe(false);
    });

    it('derives a dotted `projectSettings.*` id instead of shape-matching it (#723)', () => {
      // This family used to be verified by a one-family `.+` allowlist in `templateToIdPattern`,
      // wide enough to admit ANY dotted string typed after `projectSettings.` — a typo included.
      // `projectSettingsFieldIds` derives the real dotted keys from `setup.ts` instead, and
      // `DERIVED_FAMILY_TEMPLATES` removes the shape pattern entirely, so `patterns` no longer
      // covers this family at all — only `ids` does. Read from the REAL file, not a hand-typed
      // fixture, so a renamed/removed settings key goes red instead of the assertion testing
      // itself.
      const setupSrc = readFileSync(join(REPO_ROOT, 'engine/app/editor/setup.ts'), 'utf8');
      const { ids, patterns } = knownUiIds([setupSrc, 'const uiId = `projectSettings.${field.key}`;']);
      expect(ids.has('projectSettings.rendering.three.qualityTier')).toBe(true);
      const known = (id: string) => ids.has(id) || patterns.some((p) => p.test(id));
      // The `.+` allowlist this replaced would have waved this typo through.
      expect(known('projectSettings.rendering.three.qualityTierx')).toBe(false);
    });

    it('derives the ids `useFieldId` computes, from the REAL panel source', () => {
      // Deliberately not a hand-shaped fixture. An earlier version of this test called
      // `knownUiIds([])` and asserted a regex the author wrote against strings the author typed —
      // it passed whether the derivation worked or not, and it defended a shape blanket that let
      // `particle.bursts.delete` through. Reading the actual panel is what gives it power: if the
      // Section/label markup changes shape, this goes red.
      const panel = readFileSync(
        join(REPO_ROOT, 'engine/packages/modoki/src/editor/panels/ParticleEditor.tsx'),
        'utf8',
      );
      const derived = particleFieldIds(panel);
      expect(derived.length).toBeGreaterThan(40); // ~60 labelled fields; a broken scan returns []
      expect(derived).toContain('particle.general.max-particles');
      expect(derived).toContain('particle.general.looping');
      expect(derived).toContain('particle.emission.rate-sec');
      // A typo of a real id must NOT be produced — the point of deriving over shape-matching.
      expect(derived).not.toContain('particle.general.max-partickles');
      // And the derivation must not manufacture the row-repeater ids, which are NOT `useFieldId`'s.
      // Those `NumInput`s now carry an EXPLICIT `uiId` (#704) — `particle.bursts.row.<i>.time` and
      // friends — so they are registered by the literal/template extractors, not derived from a
      // `Section` label. The distinction still matters: `useFieldId` mints from a section context,
      // and a row repeater has no section, so a derivation that started producing these would be
      // inventing ids rather than reading them.
      expect(derived.some((id) => id.startsWith('particle.bursts.row.'))).toBe(false);
    });

    it('does not vouch for a typo of a statically-visible `particle.*` id', () => {
      // The regression a shape blanket caused: `particle.*` already holds 11 literal ids, so
      // `/^particle\.[^.]+\.[^.]+$/` waved through every misspelling of one the guard used to
      // check exactly.
      const { ids, patterns } = knownUiIds(['<button data-ui-id="particle.bursts.add" />']);
      const known = (id: string) => ids.has(id) || patterns.some((p) => p.test(id));
      expect(known('particle.bursts.add')).toBe(true);
      expect(known('particle.bursts.delete')).toBe(false);
      expect(known('particle.zzz.qqq')).toBe(false);
    });

    it('sees a template id built in a LOCAL first, not only the JSX prop form', () => {
      // `ProjectSettingsDialog.tsx:55` writes it as a local, with spaces around the `=`:
      //   const uiId = `projectSettings.${field.key}`;
      // The prefix regex required no space BEFORE the `=`, so that whole family was invisible
      // and every `projectSettings.<section>.<key>` a case cited came back unknown — a false
      // alarm on ids that demonstrably resolve in the live DOM, which is exactly how
      // qa/README.md says a guard gets disabled. Both spellings must be seen.
      expect(knownUiIds(['const uiId = `projectSettings.${field.key}`;']).prefixes)
        .toEqual(['projectSettings.']);
      expect(knownUiIds(['<Field uiId={`projectSettings.${k}`} />']).prefixes)
        .toEqual(['projectSettings.']);
    });

    it('admits the QUOTED object-key spelling, read from the REAL Hierarchy source (#705)', () => {
      // `Hierarchy.tsx` has no choice about the quotes — `data-ui-id` is hyphenated, so it cannot
      // be a bare JS key — and every extractor here used to require the bare name. Reading the
      // real panel rather than a hand-typed fixture is what gives this teeth: if the row's
      // spelling changes again, this goes red instead of the guard silently forgetting the
      // family. Same argument as the `useFieldId` test above.
      const panel = readFileSync(
        join(REPO_ROOT, 'engine/packages/modoki/src/editor/panels/Hierarchy.tsx'),
        'utf8',
      );
      const { prefixes, patterns } = knownUiIds([panel]);
      expect(prefixes).toContain('hierarchy.entity.');
      const known = (id: string) => patterns.some((p) => p.test(id));
      // A real guid, hyphens and all — that is what a runner substitutes for `<GUID>`.
      expect(known('hierarchy.entity.6f9c2b14-3d5a-4e77-9b0e-1a2c3d4e5f60')).toBe(true);
      // The whole-template rule still holds: admitting a SPELLING must not loosen the MATCHING.
      expect(known('hierarchy.entity.6f9c2b14-3d5a-4e77-9b0e-1a2c3d4e5f60.bogus')).toBe(false);
      expect(known('hierarchy.entity')).toBe(false);
    });

    it('still refuses a type annotation or a prop declaration — the widening is one quote, not a wildcard', () => {
      // MUTATION GUARD for #705. The fix inserted `["']?` before the separator; the careless
      // follow-up is to reach for `.*?` or to drop the trailing quote requirement the next time a
      // spelling does not match. These are the strings that start registering as ids if anyone
      // does, and every one of them is a DECLARATION, where the text after `:` is a type rather
      // than an id. A guard that vouches for `string` vouches for nothing.
      const { ids, prefixes, patterns } = knownUiIds([
        'function F({ uiId }: { uiId?: string; dataUiId?: string }) {}',
        'const uiId: string = compute();',
        'type P = { uiId: string };',
        'interface Q { dataUiId: string }',
        // This one specifically catches the `.*?` mutation, which the four above do NOT: they
        // contain no quoted literal at all, so a wildcard has nothing to run to. Here it reaches
        // past the `=` to the `key:` and registers `not.an.id`. The real regex stops at the `=`
        // because what follows is not a quote.
        'const uiId = opts.uiId ?? { key: "not.an.id" };',
      ]);
      expect([...ids]).toEqual([]);
      expect(prefixes).toEqual([]);
      expect(patterns).toEqual([]);
    });
  });

  /**
   * Mutation cover for #723's derivers, ONE PER FAMILY CLASS rather than a single test over all
   * of them — a typo of a real value must be rejected by each family independently, because each
   * reads a different file with its own quoting/regex shape and a single combined test could pass
   * by accident on the family it happens to check last. Every `it` below is verified RED without
   * its deriver (temporarily remove the `for (const id of …) ids.add(id)` line in `knownUiIds` and
   * re-run — each of these fails, which is what makes the green here mean something).
   */
  describe('#723 derived families reject a typo of a real cited value', () => {
    it('inspector.field — from the REAL trait registry', () => {
      const src = readFileSync(join(REPO_ROOT, 'engine/app/ecs/registerTraits.ts'), 'utf8');
      const { ids, patterns } = knownUiIds([src]);
      const known = (id: string) => ids.has(id) || patterns.some((p) => p.test(id));
      expect(known('inspector.field.Transform.x')).toBe(true);
      expect(known('inspector.field.VideoPlayer.loop')).toBe(true);
      expect(known('inspector.field.HapticSettings.masterIntensity')).toBe(true);
      // Typos of real, currently-cited values (qa/cases/**) that used to pass on shape alone.
      expect(known('inspector.field.Transform.xx')).toBe(false);
      expect(known('inspector.field.VideoPlayer.lop')).toBe(false);
      // A trait that has never existed must not be waved through by the `[^.]+` shape either.
      expect(known('inspector.field.NotATrait.foo')).toBe(false);
    });

    /**
     * The completeness direction the tests above never exercised: they only prove a TYPO is
     * REJECTED, which a stripper that silently drops fields would still pass — a dropped field's
     * id is unknown too. This proves every REAL field of a comment-heavy trait is still ACCEPTED.
     *
     * `UIElement`, `Animator` and `Renderable3DPrimitive` were picked because each has a field
     * whose declaration sits directly behind a `//` comment inside `fields: { … }` —
     * `topLevelObjectKeys`'s `^\s*` anchor cannot skip one, so the field was silently not derived.
     * Measured against `engine/app/ecs/registerTraits.ts` before the fix: 33 trait fields dropped
     * across the registry, these three among them. `Animator.time` is the first field after a
     * 4-line comment; `Renderable3DPrimitive.material` sits behind a 2-line comment.
     */
    it('inspector.field derives EVERY field of a comment-heavy trait, not just the ones after its last comment', () => {
      const src = readFileSync(join(REPO_ROOT, 'engine/app/ecs/registerTraits.ts'), 'utf8');
      const { ids, patterns } = knownUiIds([src]);
      const known = (id: string) => ids.has(id) || patterns.some((p) => p.test(id));
      // The two ids the brief names explicitly.
      expect(known('inspector.field.Animator.time')).toBe(true);
      expect(known('inspector.field.Renderable3DPrimitive.material')).toBe(true);
      // ⚠️ #723 review finding A: `flexDirection` (an `enum`, → `DropdownField`) and
      // `backgroundColor` (a `color`, → `ColorField`) render through widgets that emit NO
      // `data-ui-id` at all — this test used to pin BOTH as "known", which is the exact fail-open
      // finding A closes (an id the Inspector can never render, vouched for). Replaced below with
      // `borderWidth` and `fontFamily` — both still comment-heavy-trait fields (the same `UIElement`
      // block), both a TAGGED type (`number`, and `string` with `accept`, i.e. `AssetRefField`).
      expect(known('inspector.field.UIElement.flexDirection')).toBe(false);
      expect(known('inspector.field.UIElement.backgroundColor')).toBe(false);
      // Every other field of the same three comment-heavy traits.
      for (const id of [
        'inspector.field.UIElement.width',
        'inspector.field.UIElement.borderWidth',
        'inspector.field.UIElement.fontFamily',
        'inspector.field.UIElement.paddingTop',
        'inspector.field.Animator.speed',
        'inspector.field.Animator.playing',
        'inspector.field.Animator.loop',
        'inspector.field.Animator.fadeDuration',
        'inspector.field.Animator.activeClip',
        'inspector.field.Animator.fadeFrom',
        'inspector.field.Animator.fadeFromTime',
        'inspector.field.Animator.fadeElapsed',
        'inspector.field.Renderable3DPrimitive.isVisible',
      ]) {
        expect(known(id), id).toBe(true);
      }
    });

    it('inspector.section / inspector.addComponent.item — from the REAL trait registry', () => {
      const src = readFileSync(join(REPO_ROOT, 'engine/app/ecs/registerTraits.ts'), 'utf8');
      const { ids, patterns } = knownUiIds([src]);
      const known = (id: string) => ids.has(id) || patterns.some((p) => p.test(id));
      expect(known('inspector.section.Director.header')).toBe(true);
      expect(known('inspector.section.GroupAlpha.menu')).toBe(true);
      expect(known('inspector.addComponent.item.AudioSource')).toBe(true);
      // Cited today per qa/cases/** — real, unmutated.
      expect(known('inspector.addComponent.item.GroupAlpha')).toBe(true);
      // Typos.
      expect(known('inspector.section.Diretcor.header')).toBe(false);
      expect(known('inspector.addComponent.item.AudioSrouce')).toBe(false);
      // A resource trait is addressed by ITS name plus " (resource)", not the bare name.
      expect(known('inspector.section.HapticSettings.header')).toBe(false);
      expect(known('inspector.section.HapticSettings (resource).header')).toBe(true);
    });

    it('inspector.subsection — from a literal <SubSection title> call site', () => {
      expect(traitSubSectionIds('<SubSection title="Advanced" defaultOpen={x}>')).toEqual([
        'inspector.subsection.advanced',
      ]);
      // A dynamic call (`<SubSection title={sectionName}>`, Inspector.tsx's own) has no static
      // value — correctly derives nothing rather than guessing.
      expect(traitSubSectionIds('<SubSection title={sectionName} defaultOpen={x}>')).toEqual([]);
    });

    /**
     * #723 review, item I: `traitSubSectionIds`'s inline `subSectionSlug` copy had NO pin to the
     * source it mirrors — unlike `engine/tests/editor/subSectionUiIds.test.ts`'s OWN inline copy
     * of the same function, which is pinned to `widgets.tsx` by a `toContain` check (its own "the
     * slug helper matches the implementation it mirrors" test). This file's docblock above already
     * cites that precedent as the reason NOT to import `widgets.tsx` (a full panel module) for a
     * five-line function — the consistent choice is the SAME mirror-plus-pin shape, not switching
     * to an import, so this is that pin for the copy in THIS file.
     */
    it("traitSubSectionIds' inline subSectionSlug copy matches widgets.tsx (pin, not an import)", () => {
      const src = readFileSync(
        join(REPO_ROOT, 'engine/packages/modoki/src/editor/panels/assetViews/widgets.tsx'),
        'utf8',
      );
      expect(src).toContain("return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');");
    });

    it('animation.viewMode — from the REAL TrackList tuple', () => {
      const src = readFileSync(
        join(REPO_ROOT, 'engine/packages/modoki/src/editor/panels/animation/TrackList.tsx'),
        'utf8',
      );
      const { ids, patterns } = knownUiIds([src]);
      const known = (id: string) => ids.has(id) || patterns.some((p) => p.test(id));
      expect(known('animation.viewMode.dopesheet')).toBe(true);
      expect(known('animation.viewMode.curves')).toBe(true);
      expect(known('animation.viewMode.dopesheat')).toBe(false);
    });

    it('sceneView.toolbar.gizmo — from the REAL gizmoModes array', () => {
      const src = readFileSync(
        join(REPO_ROOT, 'engine/packages/modoki/src/editor/panels/SceneView.tsx'),
        'utf8',
      );
      const { ids, patterns } = knownUiIds([src]);
      const known = (id: string) => ids.has(id) || patterns.some((p) => p.test(id));
      expect(known('sceneView.toolbar.gizmo.translate')).toBe(true);
      expect(known('sceneView.toolbar.gizmo.rotate')).toBe(true);
      // The typo the brief names explicitly.
      expect(known('sceneView.toolbar.gizmo.rotat')).toBe(false);
    });

    it('gameView.devicePicker.device — from the REAL device catalog', () => {
      const src = readFileSync(
        join(REPO_ROOT, 'engine/packages/modoki/src/editor/scene/devicePresets.ts'),
        'utf8',
      );
      const { ids, patterns } = knownUiIds([src]);
      const known = (id: string) => ids.has(id) || patterns.some((p) => p.test(id));
      expect(known('gameView.devicePicker.device.Free')).toBe(true);
      expect(known('gameView.devicePicker.device.iPhone SE')).toBe(true);
      expect(known('gameView.devicePicker.device.iPhone 16 Pro Max')).toBe(true);
      expect(known('gameView.devicePicker.device.iPhone 16 Pro Maxx')).toBe(false);
      expect(known('gameView.devicePicker.device.Nokia 3310')).toBe(false);
    });

    it('module-toggles — from the REAL MODULES × OPTIONS arrays', () => {
      const src = readFileSync(
        join(REPO_ROOT, 'engine/packages/modoki/src/editor/panels/ModuleTogglesEditor.tsx'),
        'utf8',
      );
      const { ids, patterns } = knownUiIds([src]);
      const known = (id: string) => ids.has(id) || patterns.some((p) => p.test(id));
      expect(known('module-toggles.render3d.auto')).toBe(true);
      expect(known('module-toggles.video.off')).toBe(true);
      expect(known('module-toggles.render3d.maybe')).toBe(false);
      expect(known('module-toggles.audio.auto')).toBe(false);
    });

    it('quality-tiers.* — from the REAL editor + model files, mutation-checked exactly as named in the brief', () => {
      const editorSrc = readFileSync(
        join(REPO_ROOT, 'engine/packages/modoki/src/editor/panels/QualityTiersEditor.tsx'),
        'utf8',
      );
      const modelSrc = readFileSync(
        join(REPO_ROOT, 'engine/packages/modoki/src/editor/panels/qualityTiersModel.ts'),
        'utf8',
      );
      const { ids, patterns } = knownUiIds([editorSrc, modelSrc]);
      const known = (id: string) => ids.has(id) || patterns.some((p) => p.test(id));
      expect(known('quality-tiers.field.mid.pixelRatioCap')).toBe(true);
      expect(known('quality-tiers.field.default.pixelRatioCap')).toBe(true);
      expect(known('quality-tiers.add.mid')).toBe(true);
      expect(known('quality-tiers.remove.low')).toBe(true);
      // The exact typo the brief names.
      expect(known('quality-tiers.field.mid.pixelRatioCapp')).toBe(false);
      // `textureMaxSize` has NO Default cell (`defaultPath: null`) — the tier column exists, the
      // default one does not, and that asymmetry is the whole reason `defaultPath` is read
      // per-field instead of collecting every `field:` literal once for both templates.
      expect(known('quality-tiers.field.mid.textureMaxSize')).toBe(true);
      expect(known('quality-tiers.field.default.textureMaxSize')).toBe(false);
    });

    it('projectSettings.* — from the REAL setup.ts field declarations', () => {
      const src = readFileSync(join(REPO_ROOT, 'engine/app/editor/setup.ts'), 'utf8');
      const { ids, patterns } = knownUiIds([src]);
      const known = (id: string) => ids.has(id) || patterns.some((p) => p.test(id));
      expect(known('projectSettings.app.appName')).toBe(true);
      expect(known('projectSettings.rendering.three.qualityTier')).toBe(true);
      expect(known('projectSettings.app.appNam')).toBe(false);
    });

    it('contextmenu.item — from the REAL 4 contributing files, and does not vouch for an unrelated label', () => {
      // #723 review, item I: `SceneView.tsx` (mentions no `ContextMenuItem` at all — the gate
      // returns `[]` before it is ever scanned) and `assetViews/widgets.tsx` (passes the gate,
      // matches nothing) were both in this list contributing ZERO ids to what this test asserts —
      // measured, not assumed. Trimmed to the 4 files that actually produce a label, plus
      // `hmrStaleness.ts` below for the negative case.
      const files = [
        'engine/packages/modoki/src/editor/panels/Hierarchy.tsx',
        'engine/packages/modoki/src/editor/panels/Assets.tsx',
        'engine/packages/modoki/src/editor/panels/animation/CurvesView.tsx',
        'engine/packages/modoki/src/editor/panels/Inspector.tsx',
        // Ungated, this file's `BannerAction`s (`{ label: 'Dismiss', onClick: … }`) match the same
        // shape as a real ContextMenuItem — this is the false positive the deriver's docblock
        // names, reproduced here rather than only asserted about.
        'engine/app/debug/hmrStaleness.ts',
      ].map((f) => readFileSync(join(REPO_ROOT, f), 'utf8'));
      const { ids, patterns } = knownUiIds(files);
      const known = (id: string) => ids.has(id) || patterns.some((p) => p.test(id));
      expect(known('contextmenu.item.Delete')).toBe(true);
      expect(known('contextmenu.item.Rename')).toBe(true);
      expect(known('contextmenu.item.Create Prefab')).toBe(true);
      // The exact typo the brief names.
      expect(known('contextmenu.item.Delelte')).toBe(false);
      // The interpolated labels fall to the baseline by design — never derived, never shape-matched.
      expect(known('contextmenu.item.Move to Trash')).toBe(false);
      // The false positive an ungated scan would produce from hmrStaleness.ts.
      expect(known('contextmenu.item.Dismiss')).toBe(false);
    });

    /**
     * #723 review close-out — the consolidated verification the brief's items A/B/C-over/C-under/I
     * asked for: every named IMPOSSIBLE id now REJECTED, and the REAL cited ids the tightening must
     * not touch still ACCEPTED. Reads the two real registry/setup files directly rather than a
     * hand-typed fixture, so a future change to either can only make this MORE honest, not less.
     */
    it('#723 review close-out: impossible ids rejected, real cited ids still accepted', () => {
      const traitsSrc = readFileSync(join(REPO_ROOT, 'engine/app/ecs/registerTraits.ts'), 'utf8');
      const setupSrc = readFileSync(join(REPO_ROOT, 'engine/app/editor/setup.ts'), 'utf8');
      const { ids, patterns } = knownUiIds([traitsSrc, setupSrc]);
      const known = (id: string) => ids.has(id) || patterns.some((p) => p.test(id));

      // A: an enum/color field the Inspector can never tag with a data-ui-id.
      expect(known('inspector.field.UIElement.flexDirection')).toBe(false);
      expect(known('inspector.field.UIElement.backgroundColor')).toBe(false);
      expect(known('inspector.field.Renderable2D.color')).toBe(false);
      // A: an alpha field folded into its color picker's own alpha slider.
      expect(known('inspector.field.Renderable2D.opacity')).toBe(false);
      // A: a field marked `hidden: true`.
      expect(known('inspector.field.EntityAttributes.sourceScene')).toBe(false);
      // B: EntityAttributes is an inline header, never a normal Section or an addable component.
      expect(known('inspector.section.EntityAttributes.header')).toBe(false);
      expect(known('inspector.section.EntityAttributes.menu')).toBe(false);
      expect(known('inspector.addComponent.item.EntityAttributes')).toBe(false);
      // C (over): control kinds FieldControl hands off to a sub-editor with no uiId at all.
      expect(known('projectSettings.rendering')).toBe(false);
      expect(known('projectSettings.physics')).toBe(false);
      expect(known('projectSettings.build.modules')).toBe(false);
      expect(known('projectSettings.content.scenes')).toBe(false);

      // The six ids real qa/cases/** citations rely on — tightening the filter must not touch
      // these. All are `number`/`boolean` fields, so they were never at risk from finding A, but
      // this is the ACTUAL "did I break a live citation" check, not an inference from the source.
      expect(known('inspector.field.Transform.x')).toBe(true);
      expect(known('inspector.field.Transform.y')).toBe(true);
      expect(known('inspector.field.VideoPlayer.loop')).toBe(true);
      expect(known('inspector.field.GroupAlpha.alpha')).toBe(true);
      expect(known('inspector.field.HapticSettings.masterIntensity')).toBe(true);
      expect(known('inspector.field.Rotate3D.speed')).toBe(true);

      // C (under): the sub-id the dialog emits that the old `.+` allowlist covered and the
      // deriver's first version did not replace.
      expect(known('projectSettings.build.appleTeamId.select')).toBe(true);

      // I: a quote-bearing device name (`iPad Pro 11"`) — CITED_UI_ID_RE only, not `knownUiIds`
      // itself, so exercised against the REAL device catalog + the regex directly.
      const devicePresetsSrc = readFileSync(
        join(REPO_ROOT, 'engine/packages/modoki/src/editor/scene/devicePresets.ts'),
        'utf8',
      );
      const { ids: deviceIds, patterns: devicePatterns } = knownUiIds([devicePresetsSrc]);
      const knownDevice = (id: string) => deviceIds.has(id) || devicePatterns.some((p) => p.test(id));
      expect(knownDevice('gameView.devicePicker.device.iPad Pro 11"')).toBe(true);
      // The citation-side regex must extract the id WHOLE (trailing `"` included), not truncated.
      const cited = [...`data-ui-id='gameView.devicePicker.device.iPad Pro 11"'`.matchAll(CITED_UI_ID_RE)];
      expect(cited[0]?.[1] ?? cited[0]?.[3]).toBe('gameView.devicePicker.device.iPad Pro 11"');
    });

    it('an under-deriving family goes RED rather than silently passing (rule 1)', () => {
      // Simulates a panel refactor that renames the array `gizmoModes` reads from — the deriver
      // then returns [], and because `DERIVED_FAMILY_TEMPLATES` already removed the shape
      // pattern, a previously-good citation must now be UNKNOWN rather than quietly still passing
      // on the shape it used to fall back to. This is rule 1's whole point: fail closed, not open.
      const renamed = readFileSync(
        join(REPO_ROOT, 'engine/packages/modoki/src/editor/panels/SceneView.tsx'),
        'utf8',
      ).replace(/gizmoModes/g, 'renamedGizmoModes');
      const { ids, patterns } = knownUiIds([renamed]);
      const known = (id: string) => ids.has(id) || patterns.some((p) => p.test(id));
      expect(sceneViewGizmoIds(renamed)).toEqual([]);
      expect(known('sceneView.toolbar.gizmo.translate')).toBe(false);
    });
  });

  describe('isUnder', () => {
    it('matches the entry itself and anything below it', () => {
      expect(isUnder('games/qa-temp', 'games/qa-temp')).toBe(true);
      expect(isUnder('games/qa-temp/project.config.json', 'games/qa-temp')).toBe(true);
    });

    it('does not match a sibling that merely shares a prefix', () => {
      // The bug this pins: a naive startsWith would let `creates: games/qa` excuse every path
      // under `games/qa-something-else`, silently un-checking real citations.
      expect(isUnder('games/qa-temp-other/x.json', 'games/qa-temp')).toBe(false);
    });
  });

  describe('parseFrontmatter', () => {
    const fm = (body: string) => parseFrontmatter(`---\n${body}\n---\nbody`);

    it('reports a duplicate key instead of silently keeping the last', () => {
      // Real YAML throws on a duplicate mapping key. This subset used to keep the last value
      // with no trace, so a stale copy-pasted `id:` would decide the case invisibly.
      const out = fm('id: QA-A-0001\nid: QA-B-0002\ntitle: t');
      expect(out?.unparsed.some((u) => u.includes('duplicate key "id"'))).toBe(true);
    });

    it('parses scalars, inline lists and block lists', () => {
      const out = fm('id: QA-X-0001\ntargets: [editor, web]\ncovers:\n  - a/**\n  - b/c.ts');
      expect(out?.fields.id).toBe('QA-X-0001');
      expect(out?.fields.targets).toEqual(['editor', 'web']);
      expect(out?.fields.covers).toEqual(['a/**', 'b/c.ts']);
      expect(out?.unparsed).toEqual([]);
    });

    it('returns null when there is no frontmatter at all', () => {
      expect(parseFrontmatter('# just a heading')).toBeNull();
    });

    it('reports an unquoted value starting with "[" that never closes as unparsed (#277)', () => {
      // Real YAML: an unquoted scalar starting with `[` opens a flow sequence; prose after it
      // with no closing `]` is invalid syntax the Testboard's real parser throws on, even
      // though this subset could otherwise store it as a harmless bare string.
      const out = fm('id: QA-X-0001\ntitle: [win] npm run editor:stop actually stops it');
      expect(out?.unparsed.some((u) => u.includes('title'))).toBe(true);
      expect(out?.fields.title).toBeUndefined();
    });

    it('still parses a well-formed inline list starting with "["', () => {
      const out = fm('targets: [editor, web]');
      expect(out?.fields.targets).toEqual(['editor', 'web']);
      expect(out?.unparsed).toEqual([]);
    });

    it('accepts a quoted value starting with "[" as a plain string', () => {
      const out = fm('title: "[win] npm run editor:stop actually stops it"');
      expect(out?.fields.title).toBe('[win] npm run editor:stop actually stops it');
      expect(out?.unparsed).toEqual([]);
    });

    it('reports a line it cannot parse rather than dropping it', () => {
      const out = fm('id: QA-X-0001\nthis is not a key/value line');
      expect(out?.unparsed.length).toBe(1);
    });
  });
});

const describeCases = HAS_CASES ? describe : describe.skip;

describeCases('QA case references', () => {
  // NOTE: `describe.skip` still EXECUTES this body at collection time — it only suppresses the
  // tests. So every load here must survive `qa/` being absent, or the OSS snapshot (which does
  // not ship qa/) throws during collection and the "skip" protects nothing.
  const cases = HAS_CASES ? loadCases() : [];
  // #723: the committed grandfather list of citations that resolve only via a shape pattern for a
  // family that now has a deriver — see `shapeOnlyCitedIds` and the ratchet tests below.
  //
  // ⚠️ **#723 review, item D: a `{ "<id>": "<reason>" }` MAP, not a flat array.** A flat list let
  // `MODOKI_QA_WRITE_SHAPE_BASELINE=1` launder a typo silently: append a typo in a DERIVED family
  // to a case, regenerate, and the typo is permanently vouched for with no record anyone looked —
  // reproduced end-to-end during review. The reason string is the review `shapeOnlyCitedIds`'s own
  // docblock always asked for in prose but never enforced; `readShapeBaseline`'s "no empty reason"
  // ratchet below is what makes a human typing one part of getting green rather than optional.
  const SHAPE_BASELINE_PATH = join(REPO_ROOT, 'engine/tests/architecture/qa-shape-only-baseline.json');
  const readShapeBaseline = (): Record<string, string> =>
    JSON.parse(readFileSync(SHAPE_BASELINE_PATH, 'utf8'));
  /** Regenerates the baseline, carrying an EXISTING id's reason forward — only a truly NEW id gets
   *  the empty string the ratchet below rejects, so "why" survives a routine re-sort/reshuffle. */
  const writeShapeBaseline = (ids: string[]): void => {
    const existing = existsSync(SHAPE_BASELINE_PATH) ? readShapeBaseline() : {};
    const next: Record<string, string> = {};
    for (const id of ids) next[id] = existing[id] ?? '';
    writeFileSync(SHAPE_BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`);
  };
  // `--others --exclude-standard` includes files that are new but not yet staged, while still
  // excluding gitignored build output. Plain `ls-files` would fail a case whose `covers:`
  // names a source file added in the same edit — a confusing red for correct work.
  const trackedFiles = HAS_CASES
    ? git(['ls-files', '--cached', '--others', '--exclude-standard']).split('\n').filter(Boolean)
    : [];

  const readIfPresent = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
  const modokiTools = new Set(
    readIfPresent(join(REPO_ROOT, 'engine/tools/modoki-mcp/src/contracts.ts')).match(
      /modoki_[a-z0-9_]+/g,
    ) ?? [],
  );
  const deviceToolsDir = join(REPO_ROOT, 'engine/tools/game-debug-mcp/src');
  const deviceTools = new Set(
    existsSync(deviceToolsDir)
      ? walk(deviceToolsDir)
          .filter((f) => f.endsWith('.ts'))
          .flatMap((f) => readFileSync(f, 'utf8').match(/device_[a-z0-9_]+/g) ?? [])
      : [],
  );
  const npmScripts = new Set(
    Object.keys(JSON.parse(readIfPresent(join(REPO_ROOT, 'package.json')) || '{}').scripts ?? {}),
  );

  it('finds cases to check (a silently empty suite would pass vacuously)', () => {
    expect(cases.length).toBeGreaterThan(0);
    expect(modokiTools.size).toBeGreaterThan(20);
    expect(deviceTools.size).toBeGreaterThan(10);
  });

  it('every case has frontmatter this parser fully understands', () => {
    const broken = cases
      .filter((c) => !c.fm || c.fm.unparsed.length)
      .map((c) => `${c.rel}: ${c.fm ? `unparsed lines: ${c.fm.unparsed.join(' | ')}` : 'no frontmatter'}`);
    expect(broken).toEqual([]);
  });

  it('frontmatter obeys qa/README.md', () => {
    const problems: string[] = [];
    for (const c of cases) {
      const f = c.fm?.fields ?? {};
      const need = (k: string) => typeof f[k] === 'string' && (f[k] as string).length > 0;

      if (!need('id')) problems.push(`${c.rel}: missing id`);
      if (!need('title')) problems.push(`${c.rel}: missing title`);
      if (!need('area')) problems.push(`${c.rel}: missing area`);

      const type = f.type as string;
      if (!CASE_TYPES.includes(type)) problems.push(`${c.rel}: type "${type}" not in ${CASE_TYPES}`);
      if (type === 'auto' && !need('automated_by')) {
        problems.push(`${c.rel}: type auto requires automated_by`);
      }

      const severity = f.severity as string;
      if (!SEVERITIES.includes(severity)) {
        problems.push(`${c.rel}: severity "${severity}" not in ${SEVERITIES}`);
      }

      const targets = f.targets;
      if (!Array.isArray(targets) || targets.length === 0) {
        problems.push(`${c.rel}: targets must be a non-empty list`);
      } else {
        for (const t of targets) {
          if (!TARGETS.includes(t)) problems.push(`${c.rel}: unknown target "${t}"`);
        }

        // The `[win]` / `[mac+win]` TITLE TAG must agree with `targets` (qa/README.md § "Windows
        // cases carry a TITLE TAG"). `targets` is the machine-readable truth, but only the TITLE
        // is visible in a board listing or a grep — which is the whole reason the tag exists, and
        // also why it silently rots: nothing about editing `targets` makes you re-read the title.
        // A case that gains a Windows target and keeps a bare title drops out of the Windows queue
        // and is never run; one that loses it and keeps the tag sends a Windows session chasing a
        // case it cannot run. Both are the false-pass/never-run hazard the target split exists to
        // prevent, so the tag is derived here rather than trusted.
        // ⚠️ `f.title` is NOT guaranteed to be a string. `parseFrontmatter` treats any value that
        // starts with `[` and ends with `]` as an inline LIST — and this tag convention makes every
        // Windows case's title start with `[`, so one that also ends with `]` (a title closing on a
        // bracketed term, e.g. "… gated by the [OTA] flag") parses to an array. Calling a string
        // method on that throws and takes the WHOLE guard file down instead of reporting a scoped
        // problem — the "fails in the worst possible way" outcome this suite's header exists to
        // prevent. Report it as a problem rather than crashing on it.
        const rawTitle = f.title;
        if (rawTitle !== undefined && typeof rawTitle !== 'string') {
          problems.push(
            `${c.rel}: title parsed as ${Array.isArray(rawTitle) ? 'a list' : typeof rawTitle}, not a string — ` +
              `a title that starts with "[" and ends with "]" is read as inline YAML. Reword it so it ` +
              `does not end with "]".`,
          );
        }
        // ⚠️ A TAGGED TITLE MUST BE QUOTED, and this is the one check that keeps this guard
        // honest about its own limits. `parseFrontmatter` is a hand-rolled YAML SUBSET (see its
        // header) and is more permissive than real YAML: it happily accepted
        // `title: [win] Opening a project …`, while a real parser rejects it outright — `[`
        // opens a flow sequence that never closes, so the WHOLE frontmatter fails and every
        // required field reads as missing.
        //
        // That is not hypothetical. The Testboard parses with real YAML, and on 2026-08-20 it
        // was silently dropping ELEVEN cases — every `[win]` and `[mac+win]` one — reporting
        // them as `UNKNOWN:<path>` with no id, while `npm test` stayed green. The board and
        // this guard disagreed about what a case file says, and the lenient one was here.
        // Quoting makes both parsers agree, which is why it is required rather than advised.
        const titleLine = c.body.match(/^title:[ \t]*(.*)$/m)?.[1]?.trim() ?? '';
        if (/^\[/.test(titleLine)) {
          problems.push(
            `${c.rel}: a tagged title must be QUOTED — write \`title: "${titleLine}"\`. ` +
              `Unquoted, "[" opens a YAML flow sequence and a real parser rejects the entire ` +
              `frontmatter, so the case silently vanishes from the Testboard while this guard ` +
              `(a permissive YAML subset) still passes it.`,
          );
        }
        const title = typeof rawTitle === 'string' ? rawTitle : '';
        const hasWin = targets.includes('editor-win') || targets.includes('packaged-win');
        const hasMac = targets.includes('editor') || targets.includes('packaged-mac');
        const want = hasWin ? (hasMac ? '[mac+win] ' : '[win] ') : '';
        const got = title.startsWith('[mac+win] ') ? '[mac+win] ' : title.startsWith('[win] ') ? '[win] ' : '';
        if (want !== got) {
          problems.push(
            `${c.rel}: title tag ${got ? `"${got.trim()}"` : '(none)'} disagrees with targets ` +
              `[${targets.join(', ')}] — expected ${want ? `"${want.trim()}"` : 'no tag'}. ` +
              `See qa/README.md § "Windows cases carry a TITLE TAG".`,
          );
        }
      }

      const id = f.id as string;
      if (id && !/^QA-[A-Z]+-\d{4}$/.test(id)) {
        problems.push(`${c.rel}: id "${id}" is not QA-<AREA>-<NNNN>`);
      }
      // The directory IS the area, so a case cannot be filed under one and labelled another.
      if (need('area') && f.area !== c.dir) {
        problems.push(`${c.rel}: area "${f.area}" does not match directory "${c.dir}"`);
      }

      // A pinned fixture is only worth pinning if it still exists — a moved scene turns a
      // reproducible case back into "pick something and hope".
      for (const key of ['fixture_project', 'fixture_scene'] as const) {
        const value = f[key];
        if (typeof value !== 'string' || !value) continue;
        if (!existsSync(join(REPO_ROOT, value))) {
          problems.push(`${c.rel}: ${key} "${value}" does not exist`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('case ids are unique (a duplicate corrupts run history, which keys off the id)', () => {
    const seen = new Map<string, string>();
    const dupes: string[] = [];
    for (const c of cases) {
      const id = c.fm?.fields.id as string;
      if (!id) continue;
      const prior = seen.get(id);
      if (prior) dupes.push(`${id}: ${prior} and ${c.rel}`);
      else seen.set(id, c.rel);
    }
    expect(dupes).toEqual([]);
  });

  it('every `covers:` glob matches at least one tracked file', () => {
    const duds: string[] = [];
    for (const c of cases) {
      const covers = c.fm?.fields.covers;
      if (!Array.isArray(covers)) continue;
      for (const glob of covers) {
        const re = globToRegExp(glob);
        if (!trackedFiles.some((f) => re.test(f))) duds.push(`${c.rel}: "${glob}" matches nothing`);
      }
    }
    // A dud glob is SILENT — the case renders perfectly and its staleness signal never fires.
    expect(duds).toEqual([]);
  });

  it('every repo path cited in a code span exists (or is declared in `creates:`)', () => {
    const missing: string[] = [];
    for (const c of cases) {
      const creates = Array.isArray(c.fm?.fields.creates) ? (c.fm.fields.creates as string[]) : [];
      // A span that is ITSELF a real path (asset filenames in this repo contain spaces) is verified
      // whole; its fragments must not then be re-checked as if they were separate paths.
      const spans = codeSpans(c.body);
      const verifiedWhole = spans.filter(
        (s) => REPO_TOP_LEVEL.test(s) && existsSync(join(REPO_ROOT, s)),
      );
      const fragments = exemptFragments(spans, verifiedWhole);
      for (const token of codeTokens(c.body)) {
        if (fragments.has(token)) continue;
        const path = stripLineRef(token.replace(/[.,;:)\]]+$/, '').trim());
        if (!REPO_TOP_LEVEL.test(path)) continue;
        // Placeholders (`games/<id>/…`), globs and shell expansions are not literal paths.
        // `…` is in the class for the same reason `<>` is: an ELIDED path is not a claim about a
        // file, it is a claim about a family of them. Added 2026-08-21 alongside the qa-docs check
        // below, so both checkers accept the same citation shapes — this comment's neighbour claims
        // they cannot drift in precision, and that is only true if additions land in BOTH.
        if (/[<>{}*$…\s]/.test(path)) continue;
        if (existsSync(join(REPO_ROOT, path))) continue;
        if (isIgnoredBuildOutput(path)) continue;
        // A path the case CREATES is expected to be absent — that is the point of `creates:`.
        if (creates.some((entry) => isUnder(path, entry))) continue;
        missing.push(`${c.rel}: "${path}"`);
      }
    }
    expect(missing).toEqual([]);
  });

  /**
   * The same check over the SUITE'S OWN DOCS — `qa/knowledge.md` and `qa/README.md`.
   *
   * ⚠️ **These were unguarded until 2026-08-21, and the gap was demonstrated rather than theorised.**
   * `qa/findings-2026-08-13.md` was deleted after its triage while `qa/knowledge.md` still cited it
   * by path in the "where things live" table. Nothing failed: `CASES_DIR` is `qa/cases`, and the
   * loader skips `README.md`, so neither doc was ever read by this guard. The dangling citation was
   * caught by hand, which is exactly the thing this file exists so nobody has to do.
   *
   * They deserve the check at least as much as a case does. `knowledge.md` is ~1500 lines of dense
   * citations whose entire purpose is that a runner TRUSTS them mid-run — a stale path there
   * misleads every future run, whereas a stale path in one case misleads one. And unlike a case,
   * no `covers:` staleness signal will ever flag it: the Testboard does not track these docs, so a
   * rename under their feet is silent forever.
   *
   * ⚠️ This used to say "dense `file:line` citations". #680 removed every one of them and the
   * sibling rule below now forbids the shape, so the sentence described the corpus as full of the
   * thing its neighbour bans.
   *
   * ⚠️ **`qa/README.md` is deliberately NOT checked**, and that is not an oversight to fix later.
   * It is the format SPEC, so it documents `creates:` by example — `games/qa-scaffold-temp`, a
   * probe `.anim.json` — and those paths must NOT exist (the residue test below fails if they do).
   * Checking it would demand the exact opposite of that guard.
   *
   * No `creates:` equivalent here — a doc never scaffolds a path — so a cited path must simply
   * exist. Everything else (space-bearing spans, line refs, placeholders, gitignored build output)
   * reuses the case checker's extractor, so the two cannot drift apart in precision.
   */
  it("every repo path cited in the suite's own docs exists", () => {
    const missing: string[] = [];
    // Anti-vacuity, same reasoning as 'finds cases to check' above: counting the paths actually
    // checked makes a broken collection loud instead of invisible.
    //
    // ⚠️ This iterated the hardcoded `['qa/knowledge.md']` until #686. The `checked` floor below
    // covers a RENAME (it drops to 0 and fails) but was blind to an ADDITION: a new `qa/playbook.md`
    // would have had its paths checked by nothing, silently, which is the same collection defect
    // recorded for `qa/findings-2026-08-13.md` in this test's own comment above. `suiteDocs()`
    // derives the set instead, so a new top-level doc is covered the day it lands.
    let checked = 0;
    for (const { rel, body } of suiteDocs()) {
      const spans = codeSpans(body);
      const verifiedWhole = spans.filter(
        (sp) => REPO_TOP_LEVEL.test(sp) && existsSync(join(REPO_ROOT, sp)),
      );
      const fragments = exemptFragments(spans, verifiedWhole);
      for (const token of codeTokens(body)) {
        if (fragments.has(token)) continue;
        const path = stripLineRef(token.replace(/[.,;:)\]]+$/, '').trim());
        if (!REPO_TOP_LEVEL.test(path)) continue;
        if (/[<>{}*$…\s]/.test(path)) continue;
        checked += 1;
        if (existsSync(join(REPO_ROOT, path))) continue;
        if (isIgnoredBuildOutput(path)) continue;
        missing.push(`${rel}: "${path}"`);
      }
    }
    expect(missing).toEqual([]);
    // The doc cites well over a hundred repo paths; 20 is a floor that cannot be met by accident
    // but will not fight ordinary editing.
    if (HAS_CASES) expect(checked).toBeGreaterThan(20);
  });

  /**
   * No citation may point at a LINE. (#680)
   *
   * This is the check the suite could not have before, and the reason the whole convention moved.
   * The neighbouring checks verify that a cited PATH exists; none of them can verify a cited LINE,
   * and none ever will — nothing records what `saveSync.ts:1745` was SUPPOSED to point at, so a
   * number that drifts is indistinguishable from one that is right. That is the entire failure
   * mode: `verify` stays green while every citation quietly stops meaning what it says.
   *
   * Measured, not theorised: merging `origin/main` on 2026-09-04 invalidated 25 citations across 7
   * cases in one fast-forward. `games/court/runtime/systems.ts` moved by a single net line and took
   * eight of them with it. One doc citation had already drifted onto the wrong heading.
   *
   * A symbol survives that, and — unlike a number — a reader who lands in the wrong place can grep
   * their way back. Both docs and cases are covered: `qa/knowledge.md` is the densest citation site
   * in the suite and is read mid-run, so leaving it out would aim this at the smaller half.
   *
   * ⚠️ **If this fires on something legitimate, add it to `LINE_REF_ALLOWED` with a reason, or fix
   * `citesALine`'s precision. Do NOT delete the assertion** — the same rule the rest of this file
   * runs on. And a failure here is not a request to make the sentence vaguer: name the function,
   * the export, the action id, the route string. That is the trade #680 actually made.
   */
  it('no citation carries a line number — they rot silently, so cite the symbol (#680)', () => {
    const offenders: string[] = [];
    // Anti-vacuity, same reasoning as the knowledge.md check: a detector that silently stops
    // matching would leave this passing forever over a suite full of line refs.
    let scanned = 0;
    const docs: Array<{ rel: string; body: string }> = [
      ...cases.map((c) => ({ rel: c.rel, body: c.body })),
      ...suiteDocs(),
    ];
    for (const { rel, body } of docs) {
      for (const token of codeTokens(body)) {
        // Count PATH-SHAPED tokens, not every token. Counting raw tokens measured `codeTokens`,
        // not this rule: the corpus yields ~53k of them, so three files alone cleared the old
        // floor of 500 and a detector that stopped matching entirely would still have passed.
        if (REPO_TOP_LEVEL.test(stripLineRef(token))) scanned += 1;
        if (!citesALine(token)) continue;
        const t = token.replace(/[.,;)\]]+$/, '').trim();
        if (LINE_REF_ALLOWED.some((a) => a.file === rel && a.token === t)) continue;
        offenders.push(`${rel}: "${t}"`);
      }
      for (const span of codeSpans(body)) {
        if (isBareLineSpan(span)) offenders.push(`${rel}: "${span.trim()}"`);
      }
      // Prose too: `codeTokens` reads only spans and fences, so an UNBACKTICKED citation in a
      // heading, a link label or a table cell is invisible to it. Same blind spot the docs gate had.
      for (const token of nonCodeText(body).split(/\s+/)) {
        const t = token.replace(/[.,;)\]]+$/, '').trim();
        if (citesALine(token) && !LINE_REF_ALLOWED.some((a) => a.file === rel && a.token === t)) {
          offenders.push(`${rel}: "${t}"`);
        }
      }
      // The `~L202` marker rots here exactly as it does in docs/ — it was only found there first.
      // Wiring it into one gate and not the other is how a shape comes back through the door the
      // sweep was not watching.
      for (const m of citesALineByMarker(body)) offenders.push(`${rel}: "${m}"`);
    }
    expect(offenders).toEqual([]);
    // The suite cites thousands of code tokens; 500 is a floor no accident meets.
    if (HAS_CASES) expect(scanned).toBeGreaterThan(500);
  });

  /**
   * The same rule, for line numbers written in PROSE. (#680)
   *
   * `codeTokens` only reads backticked spans, so the check above is blind to "the `onMove` handler
   * (line 79)" — and 62 of those were found across 37 files AFTER the code-span sweep reported
   * itself clean. They rot identically; two were already pointing at unrelated code when found.
   *
   * This is the one place the suite inspects prose, and `qa/README.md` says elsewhere that prose is
   * deliberately left free so the guard cannot cry wolf. The narrow shape below is what buys the
   * exception: a space and TWO digits. That excludes "line height", "a 40-line function", "the
   * status line", and single-digit ordinals like "line 3 of the table", which is where the false
   * friends live.
   *
   * ⚠️ `qa/README.md` is NOT scanned by this rule — not exempted by it, simply absent from `docs`
   * above, which is the same reason the path check next door skips it (it documents `creates:` by
   * example). This comment used to say "exempt", which would have told the next author an
   * allowlist entry already existed. It does not: adding README to `docs` goes red immediately,
   * because README's own table quotes `saveSync.ts:1745` to explain the rule.
   */
  it('no citation writes a line number in prose either (#680)', () => {
    const offenders: string[] = [];
    const docs: Array<{ rel: string; body: string }> = [
      ...cases.map((c) => ({ rel: c.rel, body: c.body })),
      ...suiteDocs(),
    ];
    for (const { rel, body } of docs) {
      // Keyed file+TOKEN, exactly like LINE_REF_ALLOWED. It exempted the whole FILE first, which
      // was strictly wider for no reason: this is one of the most internals-heavy cases in the
      // suite, so "the merge branch at line 812 of saveSync.ts" appearing in it later would have
      // been invisible to both rules. The one legitimate occurrence is the paragraph explaining
      // this convention, which cannot make its point without naming a line.
      for (const m of citesALineInProse(body)) {
        if (PROSE_ALLOWED.some((a) => a.file === rel && a.token === m)) continue;
        offenders.push(`${rel}: "${m}"`);
      }
    }
    expect(offenders).toEqual([]);
    // Anti-vacuity: this rule had NONE, which made it unfalsifiable — see `citesALineInProse`.
    // The exempt paragraph is the one prose line reference the suite is allowed to contain, so
    // seeing exactly it proves the detector still fires.
    if (HAS_CASES) {
      const probe = docs.find((d) => d.rel === PROSE_ALLOWED[0].file);
      expect(probe, 'the exempt case must exist, or this rule is proving nothing').toBeDefined();
      expect(citesALineInProse(probe!.body)).toContain(PROSE_ALLOWED[0].token);
    }
  });

  /**
   * `creates:` is the cleanup contract, and this is the half that makes it mean something.
   *
   * A case that scaffolds a temp project or writes a probe asset must name those paths, and they
   * must NOT be in the tree: a present one is committed RESIDUE from a run whose cleanup did not
   * happen — exactly the CLAUDE.md #18 hazard (a stray file swept in by `git add -A`), and residue
   * under `games/` breaks every other clone's `npm test`, not just this one's.
   *
   * If this fires while a QA run is genuinely in progress in this clone, that is expected — finish
   * the case's cleanup step. Otherwise somebody committed the leftovers.
   */
  it('no `creates:` path is present in the tree (that would be leftover QA residue)', () => {
    const residue: string[] = [];
    let checked = 0;
    for (const c of cases) {
      const creates = c.fm?.fields.creates;
      if (!Array.isArray(creates)) continue;
      for (const entry of creates) {
        checked++;
        if (/[<>{}*$\s]/.test(entry)) {
          residue.push(`${c.rel}: creates: "${entry}" is a placeholder, not a real path`);
          continue;
        }
        if (!REPO_TOP_LEVEL.test(entry)) {
          residue.push(`${c.rel}: creates: "${entry}" is not a repo-relative path`);
          continue;
        }
        if (existsSync(join(REPO_ROOT, entry))) residue.push(`${c.rel}: creates: "${entry}" EXISTS`);
      }
    }
    // Same reason its `data-ui-id` sibling asserts a floor: with no `creates:` anywhere this loop
    // runs zero times and `[] === []` passes, so the check would stop working with no signal. A
    // floor of 1 rather than today's 30 — cases legitimately come and go, and the failure this
    // guards against is the field vanishing entirely, not shrinking.
    expect(checked).toBeGreaterThan(0);
    expect(residue).toEqual([]);
  });

  /**
   * The full-corpus source walk + `knownUiIds` scan + case/README docs array, HOISTED into one
   * lazily-memoized computation (#723 review, item F).
   *
   * The scan roots and the `cases ∪ qa/README.md` docs array used to be duplicated verbatim across
   * this test and `shapeOnlyCitedIds` below — widen one and not the other and the two ratchets
   * deadlock, each naming a different fix. And the full source walk (reading + `knownUiIds`-scanning
   * every `.ts(x)` file under the 3 roots, now including a real TypeScript parse per file for item
   * G/H's teeth) used to run up to THREE times per test run: once here, and once more for EACH of
   * the two ratchet tests below (`shapeOnlyCitedIds` is called by both). `engine/vite.config.ts`
   * records this suite already blowing past its 35s Windows ceiling — one walk, cached for every
   * caller in this run, is what keeps that from getting worse as the corpus grows.
   */
  let corpusScanCache: {
    known: ReturnType<typeof knownUiIds>;
    docs: Array<{ rel: string; body: string }>;
  } | null = null;
  function getCorpusScan() {
    if (corpusScanCache) return corpusScanCache;
    const roots = ['engine/packages/modoki/src', 'engine/app', 'engine/electron'].map((r) =>
      join(REPO_ROOT, r),
    );
    const sources = roots
      .filter((r) => existsSync(r))
      .flatMap((r) => walk(r).filter((f) => /\.tsx?$/.test(f)))
      .map((f) => readFileSync(f, 'utf8'));
    const known = knownUiIds(sources);
    // qa/README.md is scanned alongside the cases: the SPEC teaches selectors too, and a wrong one
    // there propagates further than in any single case. It already did — `modoki_tap`'s docstring
    // taught `inspector.header.kebab` (an Inspector kebab menu that has never existed), the README
    // quoted the docstring as its worked example, and a case brief copied the README.
    const docs = [
      ...cases.map((c) => ({ rel: c.rel, body: c.body })),
      { rel: 'qa/README.md', body: readFileSync(join(REPO_ROOT, 'qa', 'README.md'), 'utf8') },
    ];
    corpusScanCache = { known, docs };
    return corpusScanCache;
  }

  /**
   * A selector is an AIM. If it does not resolve, the case cannot be executed at all — and unlike a
   * wrong path or a wrong tool name, nothing else in this file would notice: the tool is real, the
   * parameter is real, only the target is missing. Wave 2 of the suite drives the editor through its
   * actual chrome, so this became the highest-value check to add.
   */
  it('every `data-ui-id` a case aims at exists in the editor source', () => {
    const { known: { ids, patterns }, docs } = getCorpusScan();
    // A vacuous pass would be worse than no check — the editor really does tag its chrome.
    expect(ids.size).toBeGreaterThan(30);

    // #723: the frozen `qa-shape-only-baseline.json` is a legitimate PASS here, not just a
    // measurement — it is what stands in for the shape pattern rule 1 removed for a derived
    // family's UNDERIVABLE values (`contextmenu.item.Move to Trash`). See the ratchet tests below
    // for what keeps this list itself honest (no new entries, no stale ones).
    const shapeBaseline = new Set(Object.keys(readShapeBaseline()));

    const unknown: string[] = [];
    for (const c of docs) {
      for (const m of c.body.matchAll(CITED_UI_ID_RE)) {
        const id = m[1] ?? m[3]!;
        if (/[${}<>…]/.test(id)) continue; // a placeholder the runner substitutes
        if (ids.has(id) || patterns.some((p) => p.test(id)) || shapeBaseline.has(id)) continue;
        unknown.push(`${c.rel}: [data-ui-id="${id}"]`);
      }
    }
    // PROPOSING an id that should exist is legitimate — write it in prose, without the
    // `data-ui-id="…"` code span, so it cannot be mistaken for a working selector.
    expect(unknown).toEqual([]);
  });

  /**
   * #723 Part 2 — the RATCHET over every citation that resolves ONLY via a shape pattern.
   *
   * `templateToIdPattern`'s `[^.]+` class checks a citation's SHAPE, not its VALUE — a family with
   * no deriver (rule 2 of #723's brief: `particle.bursts.row.${i}.*`, `spriteEditor.slice.${s.guid}`,
   * every other `*.row.${i}.*`) keeps that pattern on purpose, because the substituted value is
   * authored PROJECT DATA (an array index, a GUID) with no finite source-side vocabulary to check
   * it against. A shape-only pass is therefore not a claim the selector's VALUE is real — it is "I
   * cannot verify this", frozen into a committed baseline so the set can neither grow silently (a
   * new templated family landing with no deriver) nor go stale (a deriver landing, or a citation
   * moving/being fixed, must shrink it in the same commit). Follows `noNewCycles.test.ts`'s
   * pattern exactly: TWO assertions enforce EQUALITY, not just "no growth".
   *
   * Regenerate with:
   *   MODOKI_QA_WRITE_SHAPE_BASELINE=1 npx vitest run --config engine/vite.config.ts \
   *     engine/tests/architecture/qaCaseReferences.test.ts
   * Never hand-edit the JSON by ID — DO hand-edit a REASON string once a fresh entry is written
   * with an empty one (see "no empty reason" below): the regeneration run cannot know WHY an id
   * cannot be derived, only that it is shape-only, and that "why" is the actual review.
   *
   * ⚠️ **A regeneration that ADDS an entry reports ONE RED, by design — run it TWICE.** The write
   * happens inside the "no NEW entries" test below; the LIVE CHECK test above it in this file reads
   * the baseline EARLIER in the same run, before that write has happened, so it still sees the OLD
   * baseline missing the just-added id and fails once. The second run reads the now-updated file and
   * is green (assuming a real reason was typed in for the new entry in between).
   *
   * A regeneration that only REMOVES an entry is green in ONE run — the live check does not need the
   * departing id, so nothing fails while the file catches up. Measured 2026-09-06 by regenerating
   * after deleting a citation: 79/79 first time. So "it went green immediately" does not mean the
   * write was skipped; check the file, not the exit code.
   */
  function shapeOnlyCitedIds(): string[] {
    // `allPatterns`, NOT `patterns` — this measurement asks "would this citation still shape-match
    // under the OLD, undiminished rules", which is exactly what identifies a derived family's
    // UNDERIVABLE residue (`contextmenu.item.Move to Trash`). Using the live-check's filtered
    // `patterns` here would make every derived family's residue invisible to this scan, and the
    // baseline would never pick up what rule 1 needs it to.
    const { known: { ids, allPatterns }, docs } = getCorpusScan();
    const shapeOnly = new Set<string>();
    for (const c of docs) {
      for (const m of c.body.matchAll(CITED_UI_ID_RE)) {
        const id = m[1] ?? m[3]!;
        if (/[${}<>…]/.test(id)) continue; // a placeholder the runner substitutes
        if (ids.has(id)) continue; // verified by literal or derivation
        if (allPatterns.some((p) => p.test(id))) shapeOnly.add(id);
      }
    }
    return [...shapeOnly].sort();
  }

  it("the shape-only baseline has no NEW entries (derive it, or add it with a reason)", () => {
    // Regeneration lives INSIDE this test, not a standalone script, so the same `shapeOnlyCitedIds`
    // computation backs both the write and the read — a separate script re-implementing the scan
    // could silently drift from what the assertion below actually checks.
    if (process.env.MODOKI_QA_WRITE_SHAPE_BASELINE === '1') {
      writeShapeBaseline(shapeOnlyCitedIds());
    }
    const baseline = readShapeBaseline();
    const current = shapeOnlyCitedIds();
    const newEntries = current.filter((id) => !(id in baseline));
    expect(
      newEntries,
      'NEW shape-only citation(s) — this guard cannot verify these ids\' VALUES, only their ' +
        'shape. Either add a deriver for the family (see the #723 derivers above particleFieldIds), ' +
        'or add the id to qa-shape-only-baseline.json with a one-line reason in the same commit:\n' +
        newEntries.join('\n'),
    ).toEqual([]);
  });

  /**
   * #723 review, item D: the ratchet that makes the reason MANDATORY rather than a comment nobody
   * enforces. `writeShapeBaseline` writes `""` for a brand-new id — a regeneration run WRITES green
   * on the shape (nothing new/stale), but this fails LOUDLY, naming the id, until a human types WHY
   * it cannot be derived. Without this, `MODOKI_QA_WRITE_SHAPE_BASELINE=1` is a green button with no
   * review attached — reproduced end-to-end pre-fix: a typo'd DERIVED-family id, regenerated, went
   * permanently green with nobody having looked.
   */
  it('every shape-only baseline entry has a non-empty reason (no laundering a typo to green)', () => {
    const baseline = readShapeBaseline();
    const unexplained = Object.entries(baseline)
      .filter(([, reason]) => reason.trim() === '')
      .map(([id]) => id);
    expect(
      unexplained,
      'qa-shape-only-baseline.json has entry/entries with an EMPTY reason — a regeneration run ' +
        'writes one for a brand-new id, and a human must fill in why it cannot be derived before ' +
        `this can go green:\n${unexplained.join('\n')}`,
    ).toEqual([]);
  });

  it('the shape-only baseline has no STALE entries (shrink it when a citation is verified)', () => {
    const baseline = readShapeBaseline();
    const current = new Set(shapeOnlyCitedIds());
    const stale = Object.keys(baseline).filter((id) => !current.has(id));
    expect(
      stale,
      'qa-shape-only-baseline.json lists id(s) no longer shape-only (a deriver landed, or the ' +
        `citation moved/was fixed) — shrink the baseline in the same commit:\n${stale.join('\n')}`,
    ).toEqual([]);
  });

  /**
   * #723 review, item E — nothing PINS `DERIVED_FAMILY_TEMPLATES` to the derivers it exists to
   * protect, and the failure is silent and fail-OPEN: add a 12th deriver, forget its exclusion
   * entry, and that family keeps its shape blanket forever while its `ids` grow underneath it —
   * every typo of a real value in that family quietly keeps passing on shape, exactly rule 1 was
   * written to stop. Two directions, over the REAL 3-root corpus:
   *
   *  1. Every exclusion regex matches at least one LIVE template — a DEAD entry (the family was
   *     renamed/removed, or the regex was mistyped and never matched anything to begin with) is
   *     invisible with no other signal, so it is asserted here rather than trusted by inspection.
   *  2. No pattern SURVIVING in the live, filtered `patterns` set also matches a real DERIVED id —
   *     the direct check for "a shape blanket is still covering a family `ids` already derives".
   */
  it('DERIVED_FAMILY_TEMPLATES has no dead exclusions and lets no shape blanket survive over a derived id', () => {
    const { known: { templates, patterns } } = getCorpusScan();
    for (const re of DERIVED_FAMILY_TEMPLATES) {
      expect(
        templates.some((t) => re.test(t)),
        `${re} matches no live template — a dead exclusion (renamed/removed family, or a typo that `
          + 'never matched)',
      ).toBe(true);
    }
    // One real, currently-derivable id per family above — a shape pattern still matching any of
    // these means that family's `[^.]+` blanket SURVIVED despite having its own deriver, which is
    // exactly the hole rule 1 exists to close.
    const derivedSampleIds = [
      'inspector.field.Transform.x',
      'inspector.section.Director.header',
      'inspector.section.HapticSettings (resource).menu',
      'inspector.subsection.advanced',
      'inspector.addComponent.item.AudioSource',
      'animation.viewMode.dopesheet',
      'sceneView.toolbar.gizmo.translate',
      'gameView.devicePicker.device.Free',
      'module-toggles.render3d.auto',
      'quality-tiers.add.mid',
      'quality-tiers.remove.mid',
      'quality-tiers.field.mid.pixelRatioCap',
      'quality-tiers.field.default.pixelRatioCap',
      'projectSettings.app.appName',
      'contextmenu.item.Delete',
    ];
    for (const id of derivedSampleIds) {
      expect(patterns.some((p) => p.test(id)), `${id} still shape-matches a SURVIVING pattern`)
        .toBe(false);
    }
  });

  /**
   * The README's "Areas" table is what an author reads BEFORE writing a case, and it says a new
   * area is a new id prefix forever. So an area missing from it is not a doc nit — the author finds
   * no row for what they are writing, invents `qa/cases/context-menus/` with `QA-CTXMENU-`, and one
   * concern now lives under two permanent prefixes with the existing cases stranded on the other
   * side. That already happened: the three areas the interactive-surface batch added
   * (`contextmenu`, `dialogs`, `menubar` — 25 cases, 13% of the suite) shipped with no row, and
   * every other check here was green, because none of them reads the README.
   *
   * The prefix half matters for the same reason in reverse: a row promising `QA-DLG-` while the
   * directory actually uses `QA-DIALOG-` sends the next author to the wrong one.
   */
  it('every case area has a README row, with the id prefix that area actually uses', () => {
    const readme = readFileSync(join(REPO_ROOT, 'qa', 'README.md'), 'utf8');
    const rows = new Map(
      [...readme.matchAll(/^\|\s*`([a-z][\w-]*)`\s*\|\s*`(QA-[A-Z]+-)`\s*\|/gm)].map((m) => [
        m[1],
        m[2],
      ]),
    );
    // A table that stops parsing (a reformat, a renamed heading) must fail loudly, not vacuously.
    expect(rows.size).toBeGreaterThan(20);

    const prefixes = new Map<string, Set<string>>();
    for (const c of cases) {
      const id = typeof c.fm?.fields.id === 'string' ? c.fm.fields.id : '';
      const prefix = /^(QA-[A-Z]+-)/.exec(id)?.[1];
      if (!prefix) continue; // the id-format assertion owns a malformed id
      if (!prefixes.has(c.dir)) prefixes.set(c.dir, new Set());
      prefixes.get(c.dir)!.add(prefix);
    }

    const problems: string[] = [];
    for (const [area, used] of [...prefixes].sort(([a], [b]) => a.localeCompare(b))) {
      const row = rows.get(area);
      if (!row) {
        problems.push(`qa/cases/${area}/ has no row in qa/README.md's Areas table (ids use ${[...used].join(', ')})`);
      } else if (used.size > 1) {
        problems.push(`qa/cases/${area}/ mixes id prefixes ${[...used].sort().join(', ')} — one area, one prefix`);
      } else if ([...used][0] !== row) {
        problems.push(`qa/cases/${area}/ uses ${[...used][0]} but the README table promises ${row}`);
      }
    }
    for (const area of rows.keys()) {
      if (!existsSync(join(CASES_DIR, area))) {
        problems.push(`qa/README.md's Areas table lists \`${area}\`, which is not a directory under qa/cases`);
      }
    }
    expect(problems).toEqual([]);
  });

  // The target enum lives in THREE places across TWO repos: this list, qa/README.md's `targets`
  // sentence, and `TARGETS` in `src/github/cases.ts` of the modoki-testboard repo. The third
  // cannot be reached from here, and its drift is the SILENT one — the board does not merely
  // ignore a target it does not know, it records `Unknown target` in the case's `problems` AND
  // filters it out of the parsed `targets`, so an un-deployed target makes a case look mis-tagged
  // and drops it from /api/next. That was measured on 2026-08-20 adding `ios-ipad`. This guard
  // closes the two halves that ARE local, so at least a case can never name a target the spec
  // does not document, nor the spec promise one no case may use.
  it('the target enum in this guard matches the one qa/README.md documents', () => {
    const readme = readFileSync(join(REPO_ROOT, 'qa', 'README.md'), 'utf8');
    const sentence = /^\*\*`targets`\*\* —([\s\S]*?)\./m.exec(readme)?.[1] ?? '';
    const documented = [...sentence.matchAll(/`([a-z][\w-]*)`/g)].map((m) => m[1]);
    // A reformat that stops the parser matching must fail loudly, not vacuously pass.
    expect(documented.length).toBeGreaterThan(5);

    const missingFromReadme = TARGETS.filter((t) => !documented.includes(t));
    const missingFromGuard = documented.filter((t) => !TARGETS.includes(t));
    expect({ missingFromReadme, missingFromGuard }).toEqual({
      missingFromReadme: [],
      missingFromGuard: [],
    });
  });

  it('every MCP tool named in a case exists on the tool surface', () => {
    const unknown: string[] = [];
    for (const c of cases) {
      for (const m of c.body.matchAll(/\b(modoki_[a-z0-9_]+)\b/g)) {
        if (!modokiTools.has(m[1])) unknown.push(`${c.rel}: ${m[1]}`);
      }
      for (const m of c.body.matchAll(/\b(device_[a-z0-9_]+)\b/g)) {
        if (!deviceTools.has(m[1])) unknown.push(`${c.rel}: ${m[1]}`);
      }
    }
    // This is the check that would have caught `modoki_set_trait`, a case's only mutating
    // step, naming a tool that has never existed.
    expect(unknown).toEqual([]);
  });

  it('every `npm run <script>` named in a case exists in package.json', () => {
    const unknown: string[] = [];
    for (const c of cases) {
      for (const m of c.body.matchAll(/npm run ([a-zA-Z0-9:_-]+)/g)) {
        if (!npmScripts.has(m[1])) unknown.push(`${c.rel}: npm run ${m[1]}`);
      }
    }
    expect(unknown).toEqual([]);
  });
});
