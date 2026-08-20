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
 * Tokens inside inline code spans and fenced blocks — never bare prose.
 *
 * BOTH are split on whitespace. An inline span used to be kept whole, which quietly defeated
 * this guard for the commonest citation shape in the repo: `` `engine/scripts/launch-editor.sh
 * games/3d-test` `` became one token containing a space, and the placeholder filter (which skips
 * anything with whitespace, for `games/<id>/…`) then dropped it without ever checking either
 * path existed. A renamed script would have passed silently — in the guard whose entire job is
 * catching renamed references.
 */
export function codeTokens(md: string): string[] {
  const inline = [...md.matchAll(/`([^`\n]+)`/g)].flatMap((m) => m[1].split(/\s+/));
  const fenced = [...md.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].flatMap((m) => m[1].split(/\s+/));
  return [...inline, ...fenced].filter(Boolean);
}

/**
 * Whole inline code spans, unsplit.
 *
 * Needed because **this repo has asset filenames containing spaces** — e.g.
 * `games/3d-test/runtime/assets/scenes/2D Animation.scene.json`. Splitting that span on whitespace
 * yields `…/scenes/2D` plus `Animation.scene.json`, and the checker then reports a perfectly correct
 * citation as two missing paths. The caller uses this to ask "is the ENTIRE span a real path?" before
 * falling back to the token split.
 *
 * This cannot re-open the hole the split was introduced to close: a span is only accepted whole when
 * it EXISTS on disk, so a span naming something missing is still split and still checked token by
 * token.
 */
export function codeSpans(md: string): string[] {
  return [...md.matchAll(/`([^`\n]+)`/g)].map((m) => m[1].trim()).filter(Boolean);
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
 * Strip a trailing line reference from a cited path — `foo.ts:525`, `foo.ts:525-573`, `foo.ts#L525`.
 *
 * `file_path:line_number` is the repo's own citation convention (CLAUDE.md: it is clickable), and
 * the checker used to treat the whole thing as the path and report the file as missing. The fix
 * belongs HERE rather than in the cases: the guard's contract is "fix the extractor's precision,
 * never delete the assertion", and pushing authors to drop line numbers would make every case
 * vaguer to satisfy a tool.
 */
export function stripLineRef(path: string): string {
  return path.replace(/(?::\d+(?:-\d+)?|#L\d+(?:-L?\d+)?)$/, '');
}

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
  const literal = [
    /data-ui-id=["']([\w.:-]+)["']/g,
    /\buiId=["']([\w.:-]+)["']/g,
    /\bdataUiId=["']([\w.:-]+)["']/g,
    /\buiId:\s*["']([\w.:-]+)["']/g,
  ];
  for (const re of literal) for (const m of joined.matchAll(re)) ids.add(m[1]);
  // A template-built id (`hierarchy.folder.${name}`) can only be checked to its static prefix.
  const prefixes = [...joined.matchAll(/(?:data-ui-id|uiId|dataUiId)[=:]\s*\{?`([\w.:-]*)\$/g)]
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
        const title = (f.title as string) ?? '';
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
        if (/[<>{}*$\s]/.test(path)) continue;
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
