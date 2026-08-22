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
 *  Distinguishing a real invocation from a prose mention (a comment/doc referencing the
 *  filename) is done narrowly rather than cleverly: only a straight-quoted `'node
 *  engine/scripts/build-web.mjs ...'` shell-command string, or an `execFileSync`-style args
 *  array containing `'engine/scripts/build-web.mjs'`, counts as an invocation. Every prose
 *  mention in this codebase uses backticks or no quotes at all, so this stays reliable without
 *  needing a Babel/TS parse. The one exception — a string inspection that happens to be
 *  single-quoted — is named in ALLOWLIST below with its reason; if a new false positive shows up
 *  here, add it there rather than loosening the detector. */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const ENGINE_ROOT = path.join(REPO_ROOT, 'engine');

/** Known non-invocation matches of the raw-string detector below — each INSPECTS a string that
 *  happens to equal the invocation prefix rather than spawning it. Listed explicitly (a narrow
 *  allowlist, per the file header) instead of trying to regex-distinguish "spawn" from
 *  "inspect" generally, which would be unreliable and could hide a real regression. */
const ALLOWLIST: Array<{ file: string; needle: string; reason: string }> = [
  {
    file: 'plugins/vite-asset-scanner.ts',
    needle: "steps[0]?.cmd?.startsWith('node engine/scripts/build-web.mjs')",
    reason: "checks an already-built step's cmd PREFIX to decide whether to drop it from the " +
      'scaffold flow — it does not spawn build-web.mjs itself, so it carries no --target.',
  },
];

function isAllowlisted(relFile: string, line: string): boolean {
  return ALLOWLIST.some((a) => a.file === relFile && line.includes(a.needle));
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
      continue;
    }
    if (/\.(ts|mjs|sh)$/.test(entry.name)) out.push(full);
  }
  return out;
}

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

const files = walk(ENGINE_ROOT).filter((f) => {
  const rel = relEngine(f);
  if (rel.startsWith('tests/')) return false; // not call sites — this suite's own files
  if (rel === 'scripts/build-web.mjs') return false; // the callee, not a caller
  return true;
});

interface Invocation {
  rel: string;
  lineNo: number;
  line: string;
  ok: boolean;
}

function scan(): Invocation[] {
  const found: Invocation[] = [];
  for (const file of files) {
    const rel = relEngine(file);
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.includes('build-web.mjs')) continue;
      if (isAllowlisted(rel, line)) continue;

      // Case A: a quoted shell-command string — 'node engine/scripts/build-web.mjs ...'
      const cmdMatch = line.match(/(['"])node engine\/scripts\/build-web\.mjs([^'"]*)\1/);
      if (cmdMatch) {
        found.push({ rel, lineNo: i + 1, line: line.trim(), ok: hasValidTarget(cmdMatch[2]) });
        continue;
      }

      // Case B: an execFileSync/spawn-style args array — ['engine/scripts/build-web.mjs', ...],
      // where --target (if present) is a separate array element within the next few lines.
      if (/['"]engine\/scripts\/build-web\.mjs['"]/.test(line)) {
        const windowEnd = Math.min(lines.length, i + 6);
        const windowText = lines.slice(i, windowEnd).join('\n');
        found.push({ rel, lineNo: i + 1, line: line.trim(), ok: hasValidTarget(windowText) });
        continue;
      }

      // Anything else mentioning the string (no straight-quoted invocation shape) is prose — a
      // comment or doc reference — and isn't a call site.
    }
  }
  return found;
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
    expect(
      violations.map((v) => `${v.rel}:${v.lineNo}: ${v.line}`),
      'New build-web.mjs invocation(s) missing --target — this is exactly the regression class ' +
        '#40 exists to prevent (a silently wrong base path). Pass --target web|native|playable ' +
        'explicitly at every call site.',
    ).toEqual([]);
  });
});

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
  const read = (p: string) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');

  it('build-web.mjs runs `vite build` WITHOUT --configLoader runner', () => {
    const src = read('scripts/build-web.mjs');
    const buildLine = src.split('\n').find((l) => /viteBin\)\}\s+build/.test(l));
    expect(buildLine, 'could not find the `vite build` invocation in build-web.mjs').toBeDefined();
    expect(buildLine!, '--configLoader runner breaks build-hook dynamic imports (rigged-model '
      + 'conversion); see this block\'s header before re-adding it').not.toContain('--configLoader');
  });

  it('the DEV SERVER still passes it — the two sites differ on purpose', () => {
    expect(read('electron/devServer.ts')).toContain("'--configLoader', 'runner'");
  });
});
