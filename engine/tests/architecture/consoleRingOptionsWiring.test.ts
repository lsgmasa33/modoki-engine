import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments, assertScanIsSane, readScannedSource } from '@modoki/engine/testing';
import { importsIn, parseSource, type ModuleEdge } from '@modoki/engine/testing/sourceAst';
import { resolveRelative, runtimeEdgesOf } from '@modoki/engine/testing/importClosure';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';
import { repoFiles } from '../../scripts/repoCorpus.mjs';

/**
 * F8 (#626/#633 adversarial review): `installConsoleRing()` is idempotent — a SECOND call returns
 * early and silently discards its own options (see `consoleRing.ts`'s `installed` guard). Two
 * call sites reach it with NO options at all: `app/debug/agentBridge.ts`'s own `installConsoleCapture`
 * shim, and `packages/modoki/src/runtime/debug/consoleCapture.ts`'s identically-named shim. Today
 * BOTH always lose the race to `app/installConsoleRing.ts`'s eager, options-carrying call, because
 * that one is a STATIC side-effect import above `App.tsx` in `main.tsx` while both option-less
 * callers sit behind a DYNAMIC `import(...)`.
 *
 * #633's own finding is that BUNDLING reorders exactly this class of thing. A single new STATIC
 * edge reaching either option-less caller — nobody would notice adding one, since neither file's
 * own code changed — would flip the winner and silently drop the editor to `capacity:512,
 * retainCallSite:false` with every existing gate green. This guard has two legs: (1)
 * `installConsoleRing.ts` is the ONLY call site in the app/engine source that passes it any
 * options, and (2) the two option-less callers are reached ONLY via a dynamic import, never a
 * static top-level one, from the app's entry point.
 */

const engineDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Repo-relative POSIX path for the handful of individually-named files below (`MAIN`, `APP_TSX`, …
 *  and the F11 BFS trail) — these are known, fixed source files, not a corpus enumeration, so a
 *  `path.relative` round-trip here is just display formatting, not the enumeration hazard
 *  `repoFiles()` exists to remove. Still needed for exactly that: turning a handful of literal
 *  absolute paths into readable labels. The two OFFENDER LISTS below no longer use it — they are
 *  built straight from `walk()`'s own git-POSIX `rel`, which is the half of this file that WAS the
 *  hazard (#799/#771/#805 Phase 4 — both lists used to compare `path.relative()` output against
 *  forward-slash literals). */
const relPosix = (file: string) => path.relative(engineDir, file).split(path.sep).join('/');

const APP_DIR = path.join(engineDir, 'app');
const RUNTIME_SRC = path.join(engineDir, 'packages/modoki/src');
const MAIN = path.join(APP_DIR, 'main.tsx');
const APP_TSX = path.join(APP_DIR, 'App.tsx');
const AGENT_BRIDGE = path.join(APP_DIR, 'debug/agentBridge.ts');
const RUNTIME_DEBUG_CONSOLE_CAPTURE = path.join(RUNTIME_SRC, 'runtime/debug/consoleCapture.ts');

/** `.ts`/`.tsx` PRODUCTION source files under app/ and the runtime src, engine-relative POSIX —
 *  via the shared corpus producer (#799/#771/#805 Phase 4). Skips `node_modules`/`dist`/any `tests`
 *  directory and `.test.` files (this guard is about real call sites, not the tests that exercise
 *  them). `repoFiles()`'s own `rel` is repo-root-relative, so the `engine/` prefix is stripped by a
 *  plain string slice — safe, unlike a `path.relative` round-trip, because it operates on git's own
 *  already-POSIX string rather than re-deriving one from `node:path`. Floored well under the 855
 *  measured today. */
function walk(): Array<{ abs: string; rel: string }> {
  return repoFiles({
    under: [APP_DIR, RUNTIME_SRC],
    match: (rel: string) => /\.tsx?$/.test(rel) && !path.posix.basename(rel).includes('.test.'),
    exclude: ['node_modules', 'dist', 'tests'],
    floor: 600,
  }).map(({ abs, rel }) => ({ abs, rel: rel.replace(/^engine\//, '') }));
}

/** Every `installConsoleRing(...)` CALL found in comment-stripped `text` (the declaration itself
 *  is excluded), classified by whether its argument list is non-empty. */
function findInstallCalls(text: string): Array<{ hasOptions: boolean }> {
  const calls: Array<{ hasOptions: boolean }> = [];
  const re = /\binstallConsoleRing\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const before = text.slice(Math.max(0, m.index - 40), m.index);
    if (/function\s+$/.test(before)) continue; // the declaration: `export function installConsoleRing(`
    const afterParen = text.slice(m.index + m[0].length).trimStart();
    calls.push({ hasOptions: !afterParen.startsWith(')') });
  }
  return calls;
}

/** Every module edge `file` writes, read from its declarations (#1193). The regex this replaced took
 *  `^\s*import … '…'` only, so an `export … from` edge, an import that did not start its line and a
 *  dynamic `import()` were each invisible — and the dynamic legs below were `includes()` over the text,
 *  one of them over RAW text a comment could satisfy. */
function edgesOf(file: string): ModuleEdge[] {
  const rel = relPosix(file);
  return importsIn(parseSource(readScannedSource(file).code, rel));
}

/** Specifiers `file` loads STATICALLY: imports and re-exports, type-only ones included — a guard about
 *  what must stay behind a dynamic import should not be one `type` keyword from a real edge. */
const staticSpecifiers = (file: string) => edgesOf(file).filter((e) => e.kind === 'import' || e.kind === 'reexport').map((e) => e.spec);
const dynamicSpecifiers = (file: string) => edgesOf(file).filter((e) => e.kind === 'dynamic').map((e) => e.spec);

describe('installConsoleRing() options wiring (F8)', () => {
  const allFiles = walk();

  it('app/installConsoleRing.ts is the ONLY call site passing options', () => {
    const withOptions: string[] = [];
    for (const { abs, rel } of allFiles) {
      const src = fs.readFileSync(abs, 'utf8');
      if (!src.includes('installConsoleRing')) continue;
      const stripped = stripComments(src);
      assertScanIsSane(src, stripped, rel);
      for (const call of findInstallCalls(stripped)) {
        if (call.hasOptions) withOptions.push(rel);
      }
    }
    expect(withOptions).toEqual(['app/installConsoleRing.ts']);
  });

  it('exactly two call sites pass NO options: agentBridge.ts and runtime/debug/consoleCapture.ts', () => {
    const noOptions: string[] = [];
    for (const { abs, rel } of allFiles) {
      const src = fs.readFileSync(abs, 'utf8');
      if (!src.includes('installConsoleRing')) continue;
      const stripped = stripComments(src);
      assertScanIsSane(src, stripped, rel);
      for (const call of findInstallCalls(stripped)) {
        if (!call.hasOptions) noOptions.push(rel);
      }
    }
    expect(noOptions.sort()).toEqual([
      'app/debug/agentBridge.ts',
      'packages/modoki/src/runtime/debug/consoleCapture.ts',
    ].sort());
  });

  it('the two option-less callers really do call installConsoleRing() with an empty argument list', () => {
    for (const file of [AGENT_BRIDGE, RUNTIME_DEBUG_CONSOLE_CAPTURE]) {
      const src = fs.readFileSync(file, 'utf8');
      const stripped = stripComments(src);
      const rel = relPosix(file);
      assertScanIsSane(src, stripped, rel);
      const calls = findInstallCalls(stripped);
      expect(calls.length, `${rel}: expected exactly one installConsoleRing() call`).toBe(1);
      expect(calls[0].hasOptions, `${rel}: expected its installConsoleRing() call to pass no options`).toBe(false);
    }
  });

  it('main.tsx does not STATICALLY import ./debug/agentBridge — only a dynamic import() reaches its option-less caller', () => {
    const staticSpecs = staticSpecifiers(MAIN);
    expect(staticSpecs.length, 'main.tsx reads as importing nothing — the reader is broken').toBeGreaterThan(0);
    expect(
      staticSpecs.some((s) => s.includes('debug/agentBridge')),
      `main.tsx's static imports: ${JSON.stringify(staticSpecs)}`,
    ).toBe(false);
    expect(
      dynamicSpecifiers(MAIN).includes('./debug/agentBridge'),
      'main.tsx must reach ./debug/agentBridge only through a dynamic import() — that is what keeps ' +
        "it (and the option-less installConsoleRing() call inside its installConsoleCapture) behind " +
        "installConsoleRing.ts's static side-effect import in bundling order",
    ).toBe(true);
  });

  it('neither main.tsx nor App.tsx STATICALLY imports @modoki/engine/runtime/debug — only a dynamic import()/lazy() reaches its option-less caller', () => {
    for (const file of [MAIN, APP_TSX]) {
      const rel = relPosix(file);
      const specs = staticSpecifiers(file);
      expect(specs.length, `${rel} reads as importing nothing — the reader is broken`).toBeGreaterThan(0);
      expect(specs.some((s) => s.includes('runtime/debug')), `${rel}'s static imports: ${JSON.stringify(specs)}`).toBe(false);
    }
    expect(
      dynamicSpecifiers(APP_TSX).includes('@modoki/engine/runtime/debug'),
      'App.tsx must reach @modoki/engine/runtime/debug only through a dynamic import() (lazy())',
    ).toBe(true);
  });

  /**
   * F11 (adversarial review of the F8 guard above): the previous four checks only look ONE hop
   * deep — `main.tsx`/`App.tsx`'s OWN specifier lists — but the guard's own docstring promises the
   * option-less callers are reachable only dynamically "from the app's entry point", which is a
   * claim about the WHOLE transitive static graph, not just its first hop.
   *
   * Concrete miss the shallow checks above cannot catch: `runtime/index.ts` (the public barrel;
   * `main.tsx`/`App.tsx` reach it via `@modoki/engine`, a STATIC edge) already re-exports several
   * `./debug/*` modules (`./debug/perfSources`, `./debug/debugMenuRegistry`,
   * `./debug/agentToolRegistry`) — none of those happen to reach `./debug/index` or
   * `./debug/consoleCapture` TODAY, but nothing stops a future `export * from './debug';` (a
   * plausible-looking addition right next to the existing ones) from making
   * `runtime/debug/index.ts`'s module-scope `installConsoleCapture()` call statically reachable
   * from `main.tsx` after all — flipping which install wins in a bundled build, with all five
   * assertions above still green, since none of them walks past the entry point's own import list.
   *
   * This walks the REAL transitive static graph (import AND `export … from`, never a dynamic
   * `import()`) starting at `packages/modoki/src/runtime/index.ts`, and fails loudly — naming the
   * import chain — the moment it reaches either forbidden module.
   */
  describe('F11: the WHOLE transitive static graph from runtime/index.ts, not just one hop', () => {
    const RUNTIME_INDEX = path.join(RUNTIME_SRC, 'runtime/index.ts');
    const FORBIDDEN = [
      path.join(RUNTIME_SRC, 'runtime/debug/index.ts'),
      RUNTIME_DEBUG_CONSOLE_CAPTURE,
    ];

    /** Static edges only — an `import()` is evaluated lazily and cannot flip install order at module
     *  init. `runtimeEdgesOf` already drops `import type` / `export type` (erased, so a bundler never
     *  loads the target) and reads every spelling from the parse (#1193): the regex this replaced took a
     *  statement only at the start of a line, so `setup(); export * from './debug';` — the exact addition
     *  the docblock above fears — was invisible, and an import in a template string was an edge. */
    const staticEdgesOf = (file: string) => runtimeEdgesOf(file).filter((e) => e.kind !== 'dynamic');

    /** Breadth-first over static edges from `entry`; returns every file reached and, for the first
     *  forbidden one, the chain that reached it. */
    function staticReach(entry: string, forbidden: readonly string[]): { visited: Set<string>; trail?: string[] } {
      const visited = new Set<string>([entry]);
      const cameFrom = new Map<string, string>();
      const queue = [entry];
      while (queue.length > 0) {
        const file = queue.shift()!;
        for (const { spec } of staticEdgesOf(file)) {
          if (!spec.startsWith('.')) continue; // an npm package, or `@modoki/engine` naming its own barrel
          const resolved = resolveRelative(file, spec);
          if (!resolved || visited.has(resolved)) continue;
          visited.add(resolved);
          cameFrom.set(resolved, file);
          if (forbidden.includes(resolved)) {
            const trail = [resolved];
            let cur = resolved;
            while (cameFrom.has(cur)) { cur = cameFrom.get(cur)!; trail.unshift(cur); }
            return { visited, trail };
          }
          queue.push(resolved);
        }
      }
      return { visited };
    }

    it('never statically reaches ./debug/index or ./debug/consoleCapture, however many hops away', () => {
      const { visited, trail } = staticReach(RUNTIME_INDEX, FORBIDDEN);
      expect(trail && `runtime/index.ts statically reaches ${relPosix(trail.at(-1)!)} via: ${trail.map(relPosix).join(' -> ')}`)
        .toBeUndefined();

      // Sanity: the BFS actually walked a real graph, not a no-op over a single file — a barrel
      // this size re-exports hundreds of modules, so a suspiciously small count here would mean
      // the specifier regex or the relative resolver silently stopped following edges.
      expect(visited.size).toBeGreaterThan(50);
    });

    it('follows the spellings the old line regex missed, and not an import that is only text (#1193)', () => {
      const dir = makeScratchDir('f11-reach-');
      try {
        const write = (rel: string, code: string) => {
          fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
          fs.writeFileSync(path.join(dir, rel), code, 'utf8');
        };
        write('index.ts', [
          "setup(); export * from './viaMidLine';",
          "const doc = `\nimport './viaTemplate';`;",
          "export const lazy = () => import('./viaDynamic');",
          "import type { T } from './viaType';",
        ].join('\n'));
        for (const leaf of ['viaTemplate', 'viaDynamic', 'viaType']) write(`${leaf}.ts`, "import './debug/index';\n");
        write('viaMidLine.ts', "import {\n  a,\n} from './debug/index';\n");
        write('debug/index.ts', 'export const a = 1;\n');
        const forbidden = [path.join(dir, 'debug/index.ts')];
        const { trail } = staticReach(path.join(dir, 'index.ts'), forbidden);
        expect(trail?.map((f) => path.relative(dir, f).split(path.sep).join('/')))
          .toEqual(['index.ts', 'viaMidLine.ts', 'debug/index.ts']);
        // Without the mid-line re-export, nothing else reaches it: not the template, the import(), nor the type.
        write('index.ts', fs.readFileSync(path.join(dir, 'index.ts'), 'utf8').replace("setup(); export * from './viaMidLine';", ''));
        expect(staticReach(path.join(dir, 'index.ts'), forbidden).trail).toBeUndefined();
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
