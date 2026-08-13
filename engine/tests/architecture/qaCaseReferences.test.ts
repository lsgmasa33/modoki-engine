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

const REPO_ROOT = join(__dirname, '..', '..', '..');
const CASES_DIR = join(REPO_ROOT, 'qa', 'cases');
const HAS_CASES = existsSync(CASES_DIR);

/** Top-level directories a cited repo path may start with. */
const REPO_TOP_LEVEL =
  /^(engine|games|demos|docs|qa|scripts|server|build|layouts|site|tools-scratch)\//;

const CASE_TYPES = ['auto', 'agent', 'human'];
const TARGETS = [
  'editor',
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
 * Minimal glob → RegExp for the patterns `covers:` uses. Also hand-rolled, and for the same
 * reason as the YAML subset above.
 */
export function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` spans zero or more directories; a trailing `**` spans anything.
        if (glob[i + 2] === '/') {
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
      const rel = relative(REPO_ROOT, f);
      return {
        rel,
        dir: relative(CASES_DIR, f).split('/')[0],
        fm: parseFrontmatter(raw),
        body: raw,
      };
    })
    .sort((a, b) => a.rel.localeCompare(b.rel));
}

/** Tokens inside inline code spans and fenced blocks — never bare prose. */
function codeTokens(md: string): string[] {
  const inline = [...md.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
  const fenced = [...md.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].flatMap((m) => m[1].split(/\s+/));
  return [...inline, ...fenced];
}

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
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

  it('every repo path cited in a code span exists (or is a gitignored build output)', () => {
    const missing: string[] = [];
    for (const c of cases) {
      for (const token of codeTokens(c.body)) {
        const path = token.replace(/[.,;:)\]]+$/, '').trim();
        if (!REPO_TOP_LEVEL.test(path)) continue;
        // Placeholders (`games/<id>/…`), globs and shell expansions are not literal paths.
        if (/[<>{}*$\s]/.test(path)) continue;
        if (existsSync(join(REPO_ROOT, path))) continue;
        if (isIgnoredBuildOutput(path)) continue;
        missing.push(`${c.rel}: "${path}"`);
      }
    }
    expect(missing).toEqual([]);
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
