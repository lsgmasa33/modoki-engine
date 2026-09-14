/** Regression guard: every call site that SPAWNS `engine/scripts/build-web.mjs` must pass a
 *  valid `--target`. `engine/scripts/buildTarget.mjs` fail-fasts when `--target` is missing or
 *  invalid (#40, plus the F1/F2 fixes reviewed alongside this test) — but nothing stops a FUTURE
 *  edit from dropping `--target` off a call site in `vite-asset-scanner.ts` (the editor's build
 *  pipeline, not unit-reachable) and only finding out at runtime, or worse, silently building
 *  with the wrong base path if a caller ever reintroduces a default. This scans the repo's own
 *  source for every such call site and asserts none of them regress.
 *
 *  Scope: `engine/**` `.ts` / `.mjs` / `.sh`, excluding `node_modules`, `dist`, this suite's own
 *  test files, and `build-web.mjs` itself (the callee, not a caller). The repo-root
 *  `package.json` "build" script is DELIBERATELY excluded — `node engine/scripts/build-web.mjs`
 *  with no target is the intended base command, extended by callers via
 *  `npm run build -- --target web` (see CLAUDE.md); it is not a call site with a baked-in
 *  (missing) target.
 *
 *  Distinguishing a real invocation from a prose mention: comments are blanked at the read, and a
 *  JS/TS file is PARSED (#1179) — an invocation is a string or template literal holding the `node
 *  engine/scripts/build-web.mjs` command, or the `'engine/scripts/build-web.mjs'` literal, judged on
 *  its own literal or its own args array (see `buildWebInvocations`). A `.sh` file keeps its one-line
 *  quoted-command form. The one exception — a string inspection that happens to match — is named in
 *  ALLOWLIST below with its reason; if a new false positive shows up here, add it there rather than
 *  loosening the detector. */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readScannedSource, shellLogicalLines } from '@modoki/engine/testing';
import {
  callsTo, findNodes, flatText, lineOf, parseSource, statementOf, stringValueOf, ts,
} from '@modoki/engine/testing/sourceAst';
import { assertExemptionLedger } from '@modoki/engine/testing/exemptionLedger';
import { repoFiles } from '../../scripts/repoCorpus.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const ENGINE_ROOT = path.join(REPO_ROOT, 'engine');

/** Known non-invocation matches of the raw-string detector below — each INSPECTS a string that
 *  happens to equal the invocation prefix rather than spawning it. Listed explicitly (a narrow
 *  allowlist, per the file header) instead of trying to regex-distinguish "spawn" from
 *  "inspect" generally, which would be unreliable and could hide a real regression.
 *
 *  ⚠️ **Keyed by `file::<the literal the detector matched>` and SPENT (#1140).** This was a
 *  `.some(file && line.includes(needle))` match that skipped the LINE before detection, with no
 *  staleness check — so a fixed site left a row pardoning nothing, and a second copy of the same
 *  literal in the same file was excused by the first one's reason. Keying on the matched literal
 *  (not the whole line) keeps the old needle's reorder-safety: a trailing comma is not part of it. */
const ALLOWLIST: ReadonlyArray<{ item: string; count?: number; reason: string }> = [
  {
    item: "scripts/scopedTypecheckLib.mjs::'engine/scripts/build-web.mjs'",
    reason: 'a MACHINERY_PATHS entry (#967) — the path is COMPARED against git\'s changed-file ' +
      'list to decide whether the scoped per-project typecheck must escalate to a full sweep, ' +
      'because build-web.mjs is what generates the scoped config shape. It is data being ' +
      'matched, never a command being spawned, so it carries no --target.',
  },
  {
    item: "plugins/vite-asset-scanner.ts::'node engine/scripts/build-web.mjs'",
    reason: "`steps[0]?.cmd?.startsWith('node engine/scripts/build-web.mjs')` checks an already-" +
      'built step\'s cmd PREFIX to decide whether to drop it from the scaffold flow — it does not ' +
      'spawn build-web.mjs itself, so it carries no --target.',
  },
];

// Space form (`--target web`) or equals form (`--target=web`) inside one string.
const SPACE_OR_EQUALS_TARGET_RE = /--target[= ]+(web|native|playable)\b/;
// execFileSync/spawn args-array form: '--target', 'web' as two separate array elements.
const ARRAY_TARGET_RE = /['"]--target['"]\s*,\s*['"](web|native|playable)['"]/;

function hasValidTarget(text: string): boolean {
  return SPACE_OR_EQUALS_TARGET_RE.test(text) || ARRAY_TARGET_RE.test(text);
}

function relEngine(file: string): string {
  return path.relative(ENGINE_ROOT, file).split(path.sep).join('/');
}

// Every .ts/.mjs/.sh under engine/**, via the shared corpus producer (#799/#771/#805 Phase 4).
// Floored well under the 2167 measured today — only a broken enumeration can turn this red.
const files = repoFiles({
  under: ENGINE_ROOT, match: /\.(ts|mjs|sh)$/, exclude: ['node_modules', 'dist'], floor: 1500,
}).map(({ abs }) => abs).filter((f) => {
  const rel = relEngine(f);
  if (rel.startsWith('tests/')) return false; // not call sites — this suite's own files
  if (rel === 'scripts/build-web.mjs') return false; // the callee, not a caller
  return true;
});

interface Invocation {
  rel: string;
  lineNo: number;
  line: string;
  /** The exact literal the detector matched — what an ALLOWLIST row keys on. */
  literal: string;
  ok: boolean;
}

const COMMAND = 'node engine/scripts/build-web.mjs';
const SCRIPT = 'engine/scripts/build-web.mjs';
const TARGETS = /^(web|native|playable)$/;

/** Every build-web.mjs invocation in a JS/TS file, each judged on its OWN node (#1179):
 *
 *  - Case A, a command string: a string or template literal holding `node engine/scripts/build-web.mjs`
 *    — each occurrence judged on the text AFTER it, up to the next shell separator.
 *  - Case B, an args array: the literal `'engine/scripts/build-web.mjs'` — judged on the elements of
 *    the array it is an element of (`'--target', 'web'`, or one `--target=web` element). Anywhere else
 *    — a `path.join` argument, a bare constant — it has no arguments of its own and is judged missing.
 *
 *  The line scan this replaced judged Case B on a SIX-LINE WINDOW, so a `'--target', 'web'` in the
 *  next call's array vouched for one that had none, and a target wrapped seven lines down was missed;
 *  and it read Case A only between straight quotes, so a template literal was prose. */
export function buildWebInvocations(code: string, rel: string): Invocation[] {
  const sf = parseSource(code, rel);
  return findNodes(sf, (n): n is ts.StringLiteralLike | ts.TemplateExpression => ts.isStringLiteralLike(n) || ts.isTemplateExpression(n))
    .flatMap((n) => {
      const literal = n.getText(sf);
      // The COOKED text — what the string holds at runtime: `\n` is a newline, `\\` one backslash. A
      // template's substitutions read as `${…}`, which is no valid target.
      const value = ts.isTemplateExpression(n)
        ? n.head.text + n.templateSpans.map((span) => `\${${flatText(span.expression)}}${span.literal.text}`).join('')
        : n.text;
      if (value.includes(COMMAND)) {
        // EVERY occurrence, each judged on its OWN arguments: up to the next shell separator (`&&`, `||`,
        // `;`, `|`, a bare `&`, a newline) — a target after one belongs to the next command.
        // A shell line continuation — a newline after an ODD number of backslashes — joins lines; after an
        // even number the backslashes are literal and the newline still separates.
        return value.replace(/(^|[^\\])((?:\\\\)*)\\\r?\n/g, '$1$2 ').split(COMMAND).slice(1).map((after) => ({
          rel, lineNo: lineOf(n), line: flatText(statementOf(n)), literal,
          ok: hasValidTarget(after.split(/&&|\|\||;|\||\n|(?<![<>&])&(?![>&])/)[0]),
        }));
      }
      if (value !== SCRIPT) return [];
      const array = n.parent;
      const args = ts.isArrayLiteralExpression(array) ? array.elements.map((e) => stringValueOf(e)) : [];
      const ok = args.some((e, k) => (e === '--target' && TARGETS.test(args[k + 1] ?? '')) || (e !== undefined && SPACE_OR_EQUALS_TARGET_RE.test(e)));
      return [{ rel, lineNo: lineOf(n), line: flatText(statementOf(n)), literal, ok }];
    });
}

/** A shell file has no parser here, so each invocation is judged on its own COMMAND (#1179 P7): a logical
 *  line (backslash continuations joined), every occurrence, its arguments cut at the next shell separator
 *  or — for a command inside a quoted string — at that string's closing quote. The per-physical-line
 *  version required the command to be QUOTED, so a plain `node engine/scripts/build-web.mjs …` line in a
 *  script was invisible, and a `--target` wrapped onto the next line was not read. */
function shellInvocations(code: string, rel: string): Invocation[] {
  return shellLogicalLines(code).flatMap(({ text, line }) => {
    const out: Invocation[] = [];
    const re = /(['"]?)node\s+engine\/scripts\/build-web\.mjs/g;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      let after = text.slice(m.index + m[0].length);
      if (m[1]) after = after.split(m[1])[0]!;
      after = after.split(/&&|\|\||;|\||(?<![<>&])&(?![>&])/)[0]!;
      out.push({ rel, lineNo: line, line: text.trim(), literal: `${COMMAND}${after}`.trim(), ok: hasValidTarget(after) });
    }
    return out;
  });
}

function scan(): Invocation[] {
  return files.flatMap((file) => {
    const code = readScannedSource(file).code;
    if (!code.includes('build-web.mjs')) return [];
    const rel = relEngine(file);
    return file.endsWith('.sh') ? shellInvocations(code, rel) : buildWebInvocations(code, rel);
  });
}

describe('every build-web.mjs invocation passes --target (regression guard)', () => {
  const invocations = scan();

  it('finds the known live invocation sites (the scan is not silently empty)', () => {
    // If this drops to 0, the detector itself has rotted (extension filter, quote style change,
    // …) and the guard below would pass for the wrong reason.
    expect(invocations.length).toBeGreaterThan(0);
  });

  it('has no invocation missing a valid --target', () => {
    const violations = invocations.filter((inv) => !inv.ok);
    assertExemptionLedger({
      label: 'ALLOWLIST in buildWebCallSites',
      population: violations.map((v) => ({ item: `${v.rel}::${v.literal}`, site: `${v.rel}:${v.lineNo}: ${v.line}` })),
      exempt: ALLOWLIST,
      floor: 1,
      fix: 'New build-web.mjs invocation(s) missing --target — this is exactly the regression class ' +
        '#40 exists to prevent (a silently wrong base path). Pass --target web|native|playable ' +
        'explicitly at every call site.',
    });
  });

  it('judges each invocation on its own literal or its own array (#1179)', () => {
    const judged = (code: string) => buildWebInvocations(code, 'fixture.mjs').map((i) => `${i.literal.replace(/\s+/g, ' ')} ${i.ok}`);
    expect(judged(`
      run('node engine/scripts/build-web.mjs --target native');
      run(\`node engine/scripts/build-web.mjs --target \${target}\`);
      run(\`node engine/scripts/build-web.mjs --target=web\`);
      run('cd x && node engine/scripts/build-web.mjs');
      run('node tools/prep.mjs --target web && node engine/scripts/build-web.mjs');
      run('node engine/scripts/build-web.mjs && node tools/post.mjs --target web');
      run(\`node engine/scripts/build-web.mjs
        node tools/post.mjs --target web\`);
      run('node engine/scripts/build-web.mjs & node tools/post.mjs --target web');
      run('node engine/scripts/build-web.mjs --target web 2>&1 | tee log');
      run('node engine/scripts/build-web.mjs >&2 --target web');
      run(\`node engine/scripts/build-web.mjs \\\\
        <&0 --target native\`);
      run(\`node engine/scripts/build-web.mjs \${flags}\\nnode tools/post.mjs --target web\`);
      run(\`node engine/scripts/build-web.mjs x\\\\\\\\
        node tools/post.mjs --target web\`);
      run('node engine/scripts/build-web.mjs --target web && node engine/scripts/build-web.mjs');
      execFileSync('node', [
        'engine/scripts/build-web.mjs',
        '--quiet',
      ]);
      execFileSync('node', ['engine/scripts/other.mjs', '--target', 'web']);
      execFileSync('node', ['engine/scripts/build-web.mjs', '--mode', 'x', '--verbose', 'y', '--z',
        '--also', 'nope', '--target', 'playable']);
      execFileSync('node', ['engine/scripts/build-web.mjs', '--target=native']);
      execFileSync('node', ['engine/scripts/build-web.mjs', '--target', 'mobile']);
      spawn('node', [path.join(root, 'engine/scripts/build-web.mjs'), '--target', 'web']);
      const s = 'engine/scripts/build-web.mjs is the callee';`)).toEqual([
      "'node engine/scripts/build-web.mjs --target native' true",
      // A substituted target is not a valid one the scan can read.
      '`node engine/scripts/build-web.mjs --target ${target}` false',
      '`node engine/scripts/build-web.mjs --target=web` true',
      "'cd x && node engine/scripts/build-web.mjs' false",
      // A target BEFORE the command belongs to another command.
      "'node tools/prep.mjs --target web && node engine/scripts/build-web.mjs' false",
      // …and so does one AFTER it, past a separator.
      "'node engine/scripts/build-web.mjs && node tools/post.mjs --target web' false",
      '`node engine/scripts/build-web.mjs node tools/post.mjs --target web` false',
      "'node engine/scripts/build-web.mjs & node tools/post.mjs --target web' false",
      "'node engine/scripts/build-web.mjs --target web 2>&1 | tee log' true",
      // A redirect's `&` is not a separator.
      "'node engine/scripts/build-web.mjs >&2 --target web' true",
      // A line continuation joins its lines; `<&` is a redirect too.
      '`node engine/scripts/build-web.mjs \\\\ <&0 --target native` true',
      // The COOKED text: a `\n` escape is a newline; an ESCAPED backslash before a newline is no continuation.
      '`node engine/scripts/build-web.mjs ${flags}\\nnode tools/post.mjs --target web` false',
      '`node engine/scripts/build-web.mjs x\\\\\\\\ node tools/post.mjs --target web` false',
      // Two commands in one literal: each is its own invocation.
      "'node engine/scripts/build-web.mjs --target web && node engine/scripts/build-web.mjs' true",
      "'node engine/scripts/build-web.mjs --target web && node engine/scripts/build-web.mjs' false",
      // The next call's `'--target', 'web'` sat inside the six-line window and vouched for this one.
      "'engine/scripts/build-web.mjs' false",
      // A target past the six-line window is still this array's own.
      "'engine/scripts/build-web.mjs' true",
      "'engine/scripts/build-web.mjs' true",
      "'engine/scripts/build-web.mjs' false",
      // Not an element of the args array — it has no arguments of its own.
      "'engine/scripts/build-web.mjs' false",
    ]);
  });
});

/** Every template literal that runs `${…viteBin…} build` — its whole text, however it wraps. */
function viteBuildCommands(code: string, label: string): string[] {
  return findNodes(parseSource(code, label), ts.isTemplateExpression)
    .filter((t) => t.templateSpans.some((span) => /\bviteBin\b/.test(flatText(span.expression)) && /^\s+build\b/.test(span.literal.text)))
    .map((t) => flatText(t));
}

/** How many `spawn(…)` calls pass `'--configLoader', 'runner'` as adjacent elements of their own args array. */
function spawnsWithRunnerLoader(code: string, label: string): number {
  return callsTo(parseSource(code, label), 'spawn').filter((call) => call.arguments.some((arg) => {
    if (!ts.isArrayLiteralExpression(arg)) return false;
    const els = arg.elements.map((e) => stringValueOf(e));
    return els.some((e, k) => e === '--configLoader' && els[k + 1] === 'runner');
  })).length;
}

/** The build path's `vite build` must NOT pass `--configLoader runner`.
 *
 *  The inverted assertion, and it is inverted because the first cut of this guard demanded the
 *  flag. The flag does stop Vite writing its bundled config into `node_modules/.vite-temp` — which
 *  in a packaged editor is inside the signed .app — but it tears the module runner down after
 *  config load, so any build hook that dynamically imports dies with "Vite module runner has been
 *  closed". Measured on the v0.5.2 rc: `rigged-model-optimize.ts`'s `@gltf-transform/*` import
 *  failed, char_Ranger.glb fell back to raw source, and `assertNoConversionFallback` failed the
 *  build. The `win` clone independently reproduced it in isolation and reverted the same change.
 *
 *  ⚠️ The trap that let it reach an rc: a project with NO rigged model (games/anim-bug) builds
 *  cleanly WITH the flag. Verifying there passes under both hypotheses and proves nothing — the
 *  distinguishing project is one that exercises a build-hook dynamic import, i.e. any rigged GLB.
 *
 *  The dev server is the opposite case and keeps the flag: it loads the config once and keeps the
 *  runner alive, and it needs the flag for read-only installs. So the two spawn sites legitimately
 *  DIFFER, which is why this asserts each one separately rather than assuming symmetry. */
describe('vite build must not use the runner config loader', () => {
  const read = (p: string) => readScannedSource(path.join(__dirname, '../..', p)).code;

  it('build-web.mjs runs `vite build` WITHOUT --configLoader runner', () => {
    // The whole command template, read as one node (#1179) — the line that held `viteBin)} build` was
    // all the line reader saw, so a flag wrapped onto the next line of the same template passed.
    const builds = viteBuildCommands(read('scripts/build-web.mjs'), 'build-web.mjs');
    expect(builds.length, 'could not find the `vite build` invocation in build-web.mjs').toBe(1);
    expect(builds[0], '--configLoader runner breaks build-hook dynamic imports (rigged-model '
      + 'conversion); see this block\'s header before re-adding it').not.toContain('--configLoader');
  });

  it('the DEV SERVER still passes it — the two sites differ on purpose', () => {
    // The spawn's own args array, not the file (#1179): a copy anywhere else in devServer.ts — a
    // helper, a message — kept the file-grained check green after the spawn dropped it.
    expect(spawnsWithRunnerLoader(read('electron/devServer.ts'), 'devServer.ts')).toBeGreaterThan(0);
  });

  it('reads the build template and the spawn args from their own nodes (#1179)', () => {
    expect(viteBuildCommands('run(`${q(node)} ${q(viteBin)} build --config x\n  --configLoader runner`);\nrun(`${q(viteBin)} preview`);', 'f.mjs'))
      .toEqual(['`${q(node)} ${q(viteBin)} build --config x --configLoader runner`']);
    expect(spawnsWithRunnerLoader(`spawn(process.execPath, [entry, '--configLoader',
      'runner']);
      const note = ['--configLoader', 'runner'];
      log(['--configLoader', 'runner']);
      spawn(process.execPath, [entry, '--configLoader', 'native']);`, 'f.ts')).toBe(1);
  });
});
describe('shellInvocations reads each build-web.mjs COMMAND (#1179 P7)', () => {
  it('a plain, a wrapped, a quoted and a same-line-twice invocation — each judged on its own arguments', () => {
    const src = [
      'node engine/scripts/build-web.mjs --target web',
      'node engine/scripts/build-web.mjs \\\n  --target native',
      'bash -c "node engine/scripts/build-web.mjs" --target web',
      'node engine/scripts/build-web.mjs && other --target web',
      'node engine/scripts/build-web.mjs --target=playable; node engine/scripts/build-web.mjs',
    ].join('\n');
    expect(shellInvocations(src, 'x.sh').map((i) => `${i.lineNo}:${i.ok}`)).toEqual(['1:true', '2:true', '4:false', '5:false', '6:true', '6:false']);
  });
});
