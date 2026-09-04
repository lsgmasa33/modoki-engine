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
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

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
export function knownUiIds(sources: string[]): { ids: Set<string>; prefixes: string[] } {
  const ids = new Set<string>();
  const joined = sources.join('\n');
  // `\s*` around the `=`/`:` in all four, for the same reason as the prefix regex below: a JSX
  // prop is written tight (`uiId="a.b"`), but the identical id assigned to a local or a plain
  // object property is conventionally spaced (`const uiId = "a.b"`). Only the tight spelling was
  // matched, so the spaced one was invisible and any case citing such an id came back unknown.
  // Zero editor sources use the spaced LITERAL form today (checked 2026-08-22), so this half is
  // latent rather than a live fix — but the blind spot was identical in all five regexes and
  // fixing only the one that happened to bite would leave the same trap for the next id.
  const literal = [
    /data-ui-id\s*=\s*["']([\w.:-]+)["']/g,
    /\buiId\s*=\s*["']([\w.:-]+)["']/g,
    /\bdataUiId\s*=\s*["']([\w.:-]+)["']/g,
    /\buiId\s*:\s*["']([\w.:-]+)["']/g,
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
  const prefixes = [...joined.matchAll(/(?:data-ui-id|uiId|dataUiId)\s*[=:]\s*\{?`([\w.:-]*)\$/g)]
    .map((m) => m[1])
    .filter(Boolean);
  return { ids, prefixes };
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
        "items={[{ key: 'grid', uiId: 'sceneView.toolbar.grid' }]}",
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
   * A selector is an AIM. If it does not resolve, the case cannot be executed at all — and unlike a
   * wrong path or a wrong tool name, nothing else in this file would notice: the tool is real, the
   * parameter is real, only the target is missing. Wave 2 of the suite drives the editor through its
   * actual chrome, so this became the highest-value check to add.
   */
  it('every `data-ui-id` a case aims at exists in the editor source', () => {
    const roots = ['engine/packages/modoki/src', 'engine/app', 'engine/electron'].map((r) =>
      join(REPO_ROOT, r),
    );
    const sources = roots
      .filter((r) => existsSync(r))
      .flatMap((r) => walk(r).filter((f) => /\.tsx?$/.test(f)))
      .map((f) => readFileSync(f, 'utf8'));
    const { ids, prefixes } = knownUiIds(sources);
    // A vacuous pass would be worse than no check — the editor really does tag its chrome.
    expect(ids.size).toBeGreaterThan(30);

    // qa/README.md is scanned alongside the cases: the SPEC teaches selectors too, and a wrong one
    // there propagates further than in any single case. It already did — `modoki_tap`'s docstring
    // taught `inspector.header.kebab` (an Inspector kebab menu that has never existed), the README
    // quoted the docstring as its worked example, and a case brief copied the README.
    const docs = [
      ...cases.map((c) => ({ rel: c.rel, body: c.body })),
      { rel: 'qa/README.md', body: readFileSync(join(REPO_ROOT, 'qa', 'README.md'), 'utf8') },
    ];

    const unknown: string[] = [];
    for (const c of docs) {
      for (const m of c.body.matchAll(/data-ui-id=\\?["']([\w.:${}<>-]+)/g)) {
        const id = m[1];
        if (/[${}<>]/.test(id)) continue; // a placeholder the runner substitutes
        if (ids.has(id) || prefixes.some((p) => id.startsWith(p))) continue;
        unknown.push(`${c.rel}: [data-ui-id="${id}"]`);
      }
    }
    // PROPOSING an id that should exist is legitimate — write it in prose, without the
    // `data-ui-id="…"` code span, so it cannot be mistaken for a working selector.
    expect(unknown).toEqual([]);
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
