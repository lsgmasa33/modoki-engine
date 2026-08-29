/** Guard: no COMMITTED project config carries a MACHINE-LOCAL filesystem path (#394).
 *
 *  `app.iconSource` became a live owner-facing knob in #391 (Court is the first project with a
 *  non-empty value), and Project Settings' **Browse…** button feeds it from a native chooser that
 *  can only return an absolute path. `/api/pick-path` relativises one that lands inside the project
 *  (`relativiseUnderProject`, covered by `plugins/projectPaths.test.ts`) — but the same field is
 *  also a free text box, so a hand-typed or pasted absolute path reaches the tracked file with
 *  nothing in between. This guard asserts the OUTCOME instead of any one route into it.
 *
 *  What an absolute path there costs: it is dead on every other clone and on the `win` machine,
 *  dead in a copied-out `games/<id>` (#29 — a game must be self-contained), and a real home
 *  directory in a tracked file, which is the shape `scripts/scan-publish-safety.mjs` hard-fails on
 *  for `demos/`.
 *
 *  Sibling of `privateBuildFields.test.ts` — same class (a per-machine value in a file every clone
 *  shares), different field set, and deliberately a separate file: that one asserts the #172
 *  private-field invariant and is scoped to it. */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mergeProjectConfig } from '../../project-config';
import { isNonPortableProjectPath } from '../../packages/modoki/src/editor/panels/projectSettingsPaths';
import { REPO_ROOT, hasAnyProject, hasInternalGames } from '../helpers/repoLayout';

/** Fields whose value is a path into the PROJECT's own files, so a committed value must be
 *  project-relative. Every `type: 'path'` field in the Project Settings schema that lives OUTSIDE
 *  the gitignored `user.*` subtree belongs here — the `user.sdk.*` ones are per-machine by design
 *  and absolute is correct for them. That correspondence is not left to a comment: the test below
 *  reads the schema and asserts set equality, so #396's splash source cannot be added to the UI
 *  and quietly miss this guard — which is precisely what it caught when #396/#397 landed the
 *  seven fields below. */
const PROJECT_PATH_FIELDS = [
  'app.iconSource',
  'app.iconMonochromeSource',
  'app.iconDarkSource',
  'app.iconTintedSource',
  'app.splashSource',
  'app.splashDarkSource',
  'app.splashTitleSource',
] as const;

const SETTINGS_SCHEMA_SRC = join(REPO_ROOT, 'engine/app/editor/setup.ts');

/** The `type: 'path'` field keys the Project Settings schema declares. Line-scoped on purpose:
 *  every entry is one line today, and `pathFieldCount` below fails loudly if one ever is not,
 *  rather than this silently returning fewer keys than there are fields. Comments are stripped
 *  first — a schema line quoted inside a doc comment is not a declaration. */
function schemaPathFields(): { keys: string[]; warned: string[]; pathFieldCount: number } {
  const src = readFileSync(SETTINGS_SCHEMA_SRC, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  const lines = src.split('\n').filter((l) => /\btype:\s*'path'/.test(l));
  const entries = lines
    .map((l) => ({ key: /\bkey:\s*'([^']+)'/.exec(l)?.[1], warns: /\bcommittedPath:\s*true/.test(l) }))
    .filter((e): e is { key: string; warns: boolean } => !!e.key);
  return {
    keys: entries.map((e) => e.key),
    warned: entries.filter((e) => e.warns).map((e) => e.key),
    pathFieldCount: lines.length,
  };
}

/** Home-directory shapes: unambiguous wherever they appear, so this half of the guard needs no
 *  field list at all. `build.webBasePath` is a URL base (`/court/`) and correctly does not match. */
const HOME_PATH = /^(~|\/Users\/|\/home\/|\/Volumes\/|[A-Za-z]:[\\/])/;

// Same three layouts (and the same reasoning) as privateBuildFields.test.ts: dev clone ~24
// configs, `ci/main` 4, the release snapshot 2 — the two engine-owned ones survive everything.
const CONFIG_FLOOR = hasInternalGames() ? 10 : hasAnyProject() ? 3 : 2;

const tracked = execFileSync('git', ['ls-files', '*project.config.json', 'project.config.json'], {
  cwd: REPO_ROOT, encoding: 'utf8',
}).split('\n').filter(Boolean);

type Json = Record<string, unknown>;
const parse = (rel: string): Json => JSON.parse(readFileSync(join(REPO_ROOT, rel), 'utf8')) as Json;

/** `{present}` distinguishes "the field is absent" from "the field is there and empty" — the
 *  difference between a guard that walked the config and one whose key path silently stopped
 *  matching after a rename. */
function at(cfg: Json, dotted: string): { present: boolean; value: unknown } {
  let node: unknown = cfg;
  const parts = dotted.split('.');
  for (const k of parts) {
    if (typeof node !== 'object' || node === null || !(k in node)) return { present: false, value: undefined };
    node = (node as Json)[k];
  }
  return { present: true, value: node };
}

function strings(node: unknown, path: string, out: [string, string][] = []): [string, string][] {
  if (typeof node === 'string') out.push([path, node]);
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Json)) strings(v, path ? `${path}.${k}` : k, out);
  }
  return out;
}

describe('committed project configs hold no machine-local path (#394)', () => {
  it('finds project configs to check — a vacuous pass is a failure', () => {
    expect(tracked.length).toBeGreaterThanOrEqual(CONFIG_FLOOR);
  });

  it('PROJECT_PATH_FIELDS is exactly the schema\'s non-user path fields', () => {
    const { keys, warned, pathFieldCount } = schemaPathFields();
    // A key the line scan could not read is a field this guard would silently not cover.
    expect(keys.length, `a type:'path' entry in ${SETTINGS_SCHEMA_SRC} spans lines — the scan below missed it`)
      .toBe(pathFieldCount);
    expect(keys.length, 'no path fields found — the schema moved and this guard reads nothing')
      .toBeGreaterThanOrEqual(1);
    const committed = keys.filter((k) => !k.startsWith('user.')).sort();
    expect(committed, 'a Browse…-able field outside the gitignored user.* subtree writes into the TRACKED project.config.json — add it to PROJECT_PATH_FIELDS')
      .toEqual([...PROJECT_PATH_FIELDS].sort());
    // …and the OTHER half. Listing the field here makes the gate cover it; `committedPath: true` is
    // what makes the dialog warn about it. Enforcing only the first would let the next field (#396's
    // splash source) ship with the warning silently absent — the very failure it was written for.
    expect(warned.sort(), 'every committed path field needs committedPath: true, or the dialog warns about nothing')
      .toEqual(committed);
  });

  it.each(PROJECT_PATH_FIELDS)('%s still resolves in the engine defaults', (field) => {
    // The reachability half of the non-vacuity floor. Every assertion below is a no-op on a key
    // path that resolves to nothing, so a renamed field would leave this guard green while
    // guarding a field that no longer exists. Asserted against the RESOLVED defaults rather than
    // the corpus: a project config omits the field entirely when it holds the default, so
    // "present in every committed file" is false today and says nothing about the name.
    expect(at(mergeProjectConfig({}) as unknown as Json, field).present,
      `${field} no longer resolves — update PROJECT_PATH_FIELDS`).toBe(true);
  });

  it.each(PROJECT_PATH_FIELDS)('%s is project-relative in every committed config', (field) => {
    const offenders = tracked.flatMap((rel) => {
      const value = at(parse(rel), field).value;
      if (typeof value !== 'string' || value.trim() === '') return [];
      // The SAME predicate the dialog warns with — imported, not restated. Two copies of this rule
      // drift, and the copy that drifts is the warning, which then goes quiet on a value this gate
      // still rejects.
      return isNonPortableProjectPath(value) ? [`${rel}: ${value.trim()}`] : [];
    });
    expect(offenders, `${field} must be a project-relative POSIX path — an absolute one is dead on every other clone`).toEqual([]);
  });

  it('no committed config holds a home-directory path in ANY field', () => {
    const offenders = tracked.flatMap((rel) =>
      strings(parse(rel), '').filter(([, v]) => HOME_PATH.test(v.trim())).map(([k, v]) => `${rel}: ${k} = ${v}`));
    expect(offenders).toEqual([]);
  });
});
