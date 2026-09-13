/** Every production file that calls a project-MUTATING operation takes or checks the project's build
 *  claim (#1160). The population is DERIVED, not listed.
 *
 *  Why derived: `cliBuildClaims.test.ts` names four scripts by hand, so a fifth writer is invisible
 *  to it by construction. #1160's census found nine unclaimed writers the list had never heard of:
 *  Electron's heal-on-open, `vendor-plugins.mjs`, `bootstrap-game-deps.mjs` (the root postinstall),
 *  and others. This walks every production `.mjs`/`.ts` under `engine/scripts`, `engine/electron`
 *  and `engine/plugins`, finds each file that CALLS one of `MUTATORS`, and requires the same file to
 *  contain a claim spelling from `CLAIMS`.
 *
 *  What it does NOT see, stated so a green run is not over-read:
 *   - **File-level granularity.** A file that claims in one function and calls a mutator in another,
 *     unclaimed, passes. `main.ts` and `vite-asset-scanner.ts` are big enough for that to matter.
 *     The behavioural tests (`openClaim`, `addNativeTarget`, `bootstrapGameDepsClaim`,
 *     `cliScriptsTakeBuildClaim`) cover the specific paths.
 *   - **Direct `fs` writes into a project** (`rmSync(dist)`, a `writeFileSync` of a manifest). Which
 *     path is a project is not decidable from source. `cliScriptsTakeBuildClaim.test.ts` covers the
 *     scripts #1160 found doing it.
 *   - **A mutator not in `MUTATORS`.** The list is the helpers #1160's census found project writes
 *     going through. A new helper that writes a project belongs here.
 *
 *  Each wrapper spelling in `CLAIMS` is itself checked to reach `acquireBuildClaim(`, so the
 *  accepted spellings cannot drift into names that claim nothing. Calls are read from the AST
 *  (`sourceAst`, #1144), never matched as text. */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readScannedSource } from '@modoki/engine/testing';
import { calledNames, namedFunctions, parseSource } from '@modoki/engine/testing/sourceAst';
import { repoFiles } from '../../scripts/repoCorpus.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** Operations that write a project's native folders, `plugins/`, `package.json`, lockfile or
 *  `node_modules`. */
const MUTATORS = [
  'vendorEnginePlugins', 'writeVendorMarker', 'healNativeConfig', 'healNativeProject',
  'ensureCapacitorDeps', 'scaffoldNativeTarget', 'installProjectDeps',
] as const;

/** Spellings that take or check the claim, each with the file that must prove it reaches the store. */
const CLAIMS: ReadonlyArray<{ call: string; definedIn: string | null }> = [
  { call: 'acquireBuildClaim', definedIn: null },
  { call: 'holdsBuildClaim', definedIn: null },
  { call: 'acquireBuildSlot', definedIn: 'engine/plugins/backend/buildLock.ts' },
  { call: 'claimProjectOrExit', definedIn: 'engine/scripts/cliBuildClaim.mjs' },
];

/** The names a file CALLS (member access included: `vendorMod.vendorEnginePlugins(` is
 *  `vendorEnginePlugins`), read from its AST. A definition, an import or a mention is not a call, and a
 *  file that does not parse throws rather than reading as "calls nothing". */
function callsIn(code: string, label: string): Set<string> {
  return new Set(calledNames(parseSource(code, label)));
}

function productionFiles() {
  return repoFiles({
    under: ['engine/scripts', 'engine/electron', 'engine/plugins'],
    match: (rel: string) => /\.(mjs|ts)$/.test(rel) && !/\.d\.m?ts$/.test(rel) && !rel.includes('.test.'),
    exclude: ['node_modules', 'dist'],
    floor: 150,
  });
}

describe('every project writer takes or checks the build claim (#1160)', () => {
  const files = productionFiles().map(({ rel, abs }) => {
    const norm = rel.split(path.sep).join('/');
    return { rel: norm, calls: callsIn(readScannedSource(abs).code, norm) };
  });
  const writers = files.filter((f) => MUTATORS.some((m) => f.calls.has(m)));

  it('finds the writers it is meant to police (the census is not vacuous)', () => {
    const rels = writers.map((w) => w.rel);
    // The known population from #1160's census. A scan that stopped matching would drop these.
    for (const known of [
      'engine/electron/main.ts', 'engine/scripts/vendor-plugins.mjs', 'engine/scripts/bootstrap-game-deps.mjs',
      'engine/plugins/addNativeTarget.ts', 'engine/plugins/healNativeProject.ts', 'engine/scripts/add-native-targets.mjs',
      'engine/plugins/vite-asset-scanner.ts',
    ]) expect(rels, `${known} no longer reads as a writer; the matcher or MUTATORS broke`).toContain(known);
  });

  // No exemption channel: when #1160 landed every writer claimed, and the modules that DEFINE the
  // mutators never call them. A writer that genuinely must not claim gets a row through
  // `assertExemptionLedger` (#1140), not a hand-rolled skip list here.
  it('each writer file contains a claim spelling', () => {
    const offenders = writers
      .filter((w) => !CLAIMS.some((c) => w.calls.has(c.call)))
      .map((w) => `${w.rel} calls ${MUTATORS.filter((m) => w.calls.has(m)).join(', ')} with no claim`);
    expect(offenders).toEqual([]);
  });

  it('each wrapper spelling actually reaches acquireBuildClaim( — inside its own body, not elsewhere in the file', () => {
    for (const c of CLAIMS) {
      if (!c.definedIn) continue;
      const sf = parseSource(readScannedSource(path.join(repoRoot, c.definedIn)).code, c.definedIn);
      const fn = namedFunctions(sf).find((f) => f.name === c.call);
      expect(fn, `${c.definedIn} no longer defines ${c.call}`).toBeDefined();
      expect(calledNames(fn!.body), `${c.call} in ${c.definedIn} claims nothing`).toContain('acquireBuildClaim');
    }
  });

  it('the matcher counts calls, not definitions, imports or look-alike names', () => {
    expect(callsIn('export async function scaffoldNativeTarget(opts) {}', 'a.ts').has('scaffoldNativeTarget')).toBe(false);
    expect(callsIn('const r = vendorMod.vendorEnginePlugins(dir, root);', 'a.mjs').has('vendorEnginePlugins')).toBe(true);
    expect(callsIn('import { healNativeConfig } from "./x";', 'a.ts').has('healNativeConfig')).toBe(false);
    expect(callsIn('myhealNativeConfig(x)', 'a.ts').has('healNativeConfig')).toBe(false);
    expect(() => callsIn('function (', 'broken.ts')).toThrow(/did not parse/);
  });
});
