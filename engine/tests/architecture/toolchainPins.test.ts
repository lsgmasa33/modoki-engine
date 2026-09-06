/** Guard: an engine-owned package that pins its OWN `typescript` must be a deliberate,
 *  documented divergence from the root — never a manifest the last upgrade pass forgot.
 *
 *  The repo has 32 tracked `package.json` files and a root `npm update` reaches almost none
 *  of them: it covers the root plus the `engine/packages/*` workspaces, while
 *  `engine/tools/*` and every `games/*`/`demos/*` project install separately (via
 *  `bootstrap-mcp-deps.mjs` / `bootstrap-game-deps.mjs`). So "bump the compiler" is a
 *  multi-manifest edit that LOOKS like a one-line one.
 *
 *  Measured on the #57 upgrade pass (2026-08-02): the root moved to typescript 6.0.3 and six
 *  engine-owned manifests silently stayed on 5.9.3. That is not cosmetic — `npm run typecheck`
 *  runs six `tsc` invocations, and the two MCP-tool legs resolve their OWN typescript. They
 *  were therefore compiled by 5.9 while the commit claimed the gate covered 6. A gate that
 *  reports on a different compiler than you think is worse than a missing one, and nothing in
 *  the suite could see it.
 *
 *  So each pin is asserted with the REASON it differs, and an unlisted pin is a failure. The
 *  point is not to force one version — two of the reasons below are good ones — it is to make
 *  a silent drift impossible: adding a pin, or changing one, has to come here and state why.
 *
 *  Why the current divergences are deliberate, not debt:
 *   - `engine/packages/capacitor-*` build with `tsc && rollup`, so their compiler EMITS the
 *     plugin JS that ships to devices. Moving it is a packaging change and belongs with
 *     packaging verification.
 *   - `engine/tools/*-mcp` genuinely FAIL on TS 6 (TS2591 `Buffer`/`process`, TS6059 on the
 *     shared `mcpResult.ts` being outside the inferred rootDir) because they declare no
 *     `@types/node` and no explicit `rootDir`. Fixing that is config work, not a bump.
 *
 *  KNOWN GAP, accepted: `games/*` and `demos/*` are excluded. A project is self-contained and
 *  routinely copied OUT of the repo (#29), so its toolchain is its own; `games/3d-test/packages/
 *  capacitor-{adjust,applovin-max}` pin `^5.9.3` today and this guard deliberately does not
 *  police them. It also checks only `typescript` — the compiler is the pin whose drift changes
 *  what a gate MEANS. */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { hasOssOverlay } from '../helpers/repoLayout';
import { repoFiles } from '../../scripts/repoCorpus.mjs';

const repoRoot = path.resolve(__dirname, '../../..');

/** Every engine-owned manifest allowed to pin `typescript`, with the reason it is what it is.
 *  A pin that appears here must match exactly; a pin found on disk but missing here fails. */
const EXPECTED: Record<string, { pin: string; why: string }> = {
  'package.json': {
    pin: '~6.0.3',
    why: 'the root compiler — gates tsconfig.app, engine/tsconfig.test, and the package check+test programs',
  },
  'engine/packages/capacitor-game-debug/package.json': {
    pin: '^5.9.3',
    why: 'builds with `tsc && rollup`; its compiler emits plugin JS that ships to devices',
  },
  'engine/packages/capacitor-litert-lm/package.json': {
    pin: '^5.9.3',
    why: 'builds with `tsc && rollup`; its compiler emits plugin JS that ships to devices',
  },
  'engine/packages/capacitor-modoki-ota/package.json': {
    pin: '^5.9.3',
    why: 'builds with `tsc && rollup`; its compiler emits plugin JS that ships to devices',
  },
  'engine/packages/capacitor-modoki-iap/package.json': {
    pin: '^5.9.3',
    why: 'builds with `tsc && rollup`; its compiler emits plugin JS that ships to devices',
  },
  'engine/packages/capacitor-appsflyer/package.json': {
    pin: '^5.9.3',
    why: 'builds with `tsc && rollup`; its compiler emits plugin JS that ships to devices',
  },
  'engine/packages/modoki/package.json': {
    pin: '~6.0.3',
    why: 'ON the root compiler, and a devDependency only — the `./testing` subpath\'s scanner asks '
      + 'TypeScript to locate string literals (#419). Declared rather than left to hoisting '
      + 'because an exports subpath is a public surface; nothing under `src/` imports it, so no '
      + 'compiler reaches a shipped bundle',
  },
  'engine/tools/modoki-mcp/package.json': {
    pin: '~6.0.3',
    why: 'ON the root compiler (#87); carries its own only because it is deliberately not a root workspace',
  },
  'engine/tools/game-debug-mcp/package.json': {
    pin: '~6.0.3',
    why: 'ON the root compiler (#87); carries its own only because it is deliberately not a root workspace',
  },
};

/** Engine-owned manifests only: the root, plus everything under `engine/` that is not an
 *  installed dependency. `games/`/`demos/` are excluded on purpose (see KNOWN GAP above). Via
 *  the shared corpus producer (#799/#771/#805 Phase 4); floored well under the 10 measured
 *  under `engine/` today. */
function engineOwnedManifests(): string[] {
  const underEngine = repoFiles({
    under: path.join(repoRoot, 'engine'),
    match: /(^|\/)package\.json$/,
    exclude: ['node_modules', 'dist'],
    floor: 5,
  }).map(({ rel }) => rel);
  return ['package.json', ...underEngine];
}

function typescriptPin(rel: string): string | undefined {
  const raw = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
  const pkg = JSON.parse(raw) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  return pkg.devDependencies?.typescript ?? pkg.dependencies?.typescript;
}

describe('engine-owned typescript pins are deliberate, not drift', () => {
  it('every manifest that pins typescript is declared here, with the reason', () => {
    const actual: Record<string, string> = {};
    for (const rel of engineOwnedManifests()) {
      const pin = typescriptPin(rel);
      if (pin) actual[rel] = pin;
    }

    const undeclared = Object.keys(actual).filter((rel) => !(rel in EXPECTED));
    expect(
      undeclared,
      'a new engine-owned package pins `typescript`. Add it to EXPECTED with the reason it ' +
        'differs from the root — a pin nobody wrote a reason for is the drift this guard exists ' +
        'to catch.',
    ).toEqual([]);

    const stale = Object.keys(EXPECTED).filter((rel) => !(rel in actual));
    expect(
      stale,
      'EXPECTED lists a manifest that no longer pins `typescript`. Drop the entry.',
    ).toEqual([]);

    for (const [rel, { pin, why }] of Object.entries(EXPECTED)) {
      expect(actual[rel], `${rel} pin changed — if deliberate, update EXPECTED (was: ${why})`).toBe(pin);
    }
  });

  it('the two MCP tools track the ROOT compiler major, so their typecheck leg proves something', () => {
    // Inverted from the carve-out this replaces (#87, now fixed). The correctness point is
    // unchanged: `npm run typecheck` shells into each MCP tool, and each resolves its OWN
    // typescript — so if these pins drift below the root's, a green root typecheck silently
    // stops saying anything about those two legs. The old test asserted the skew EXISTED (to
    // document it); this one asserts it does not come back.
    //
    // They keep a `typescript` devDependency rather than inheriting the root's because they are
    // deliberately NOT root workspaces (see build-electron.mjs) — so their EXPECTED entries stay.
    // That is why only the carve-out was deleted here and not the entries: the first test in this
    // file fails any manifest that pins typescript without a declared reason.
    const rootMajor = Number(EXPECTED['package.json'].pin.replace(/^[~^]/, '').split('.')[0]);
    for (const rel of ['engine/tools/modoki-mcp/package.json', 'engine/tools/game-debug-mcp/package.json']) {
      const pin = typescriptPin(rel);
      expect(pin, `${rel} must still declare its own typescript`).toBeDefined();
      const major = Number(pin!.replace(/^[~^]/, '').split('.')[0]);
      expect(
        major,
        `${rel} no longer tracks the root compiler major — its typecheck leg is proving less than it appears`,
      ).toBe(rootMajor);
    }
  });
});

/** Guard: every workflow's `node-version` tracks PINNED_NODE's major — INCLUDING the `oss/`
 *  overlay that ships to the public repo.
 *
 *  `nodeProvision.ts` already states the rule ("the pin must stay in lockstep with `@types/node`
 *  and the workflows' `node-version`") and `nodeProvision.test.ts` asserts the pin is v24 — but
 *  nothing ever read a workflow, so the rule was documented and unenforced. It drifted exactly
 *  where you would expect: `9e632573` ("align on Node 24 Active LTS — types, CI, and the runtime
 *  the editor SHIPS") updated the three PRIVATE workflows and missed all three in `oss/`, so the
 *  public repo went on building the SHIPPED .dmg/.exe on Node 22 while package.json declared
 *  `engines: >=24`. Nothing failed, because npm treats `engines` as a warning — the drift was
 *  invisible by construction.
 *
 *  The overlay is the half that matters most and the half nobody looks at: it is not exercised by
 *  any local gate, only by the public repo after a publish. Hence a test here rather than a note. */
describe('workflow node-version tracks the provisioned Node', () => {
  const WORKFLOW_DIRS = ['.github/workflows', 'oss/.github/workflows'];

  function pins(): { file: string; version: string }[] {
    const out: { file: string; version: string }[] = [];
    for (const dir of WORKFLOW_DIRS) {
      const abs = path.join(repoRoot, dir);
      if (!fs.existsSync(abs)) continue;
      for (const name of fs.readdirSync(abs)) {
        if (!/\.ya?ml$/.test(name)) continue;
        const src = fs.readFileSync(path.join(abs, name), 'utf8');
        for (const m of src.matchAll(/^\s*node-version:\s*['"]?([0-9.]+)['"]?/gm)) {
          out.push({ file: `${dir}/${name}`, version: m[1] });
        }
      }
    }
    return out;
  }

  it('every workflow (private AND the oss/ overlay) pins the PINNED_NODE major', () => {
    // Read the pin from source rather than hard-coding 24 — a hard-coded copy is the same drift
    // this guard exists to catch, one level up.
    const src = fs.readFileSync(path.join(repoRoot, 'engine/toolchain/nodeProvision.ts'), 'utf8');
    const pinned = src.match(/version:\s*'v(\d+)\./);
    expect(pinned, 'could not read PINNED_NODE.version from nodeProvision.ts').not.toBeNull();
    const major = pinned![1];

    const wrong = pins().filter((p) => p.version.split('.')[0] !== major);
    expect(
      wrong.map((p) => `${p.file} → ${p.version}`),
      `these workflows do not track PINNED_NODE (v${major}). The oss/ overlay is the easy one to ` +
        'miss and the costly one to get wrong — it builds the artifacts users install.',
    ).toEqual([]);
  });

  it('finds workflows in every tree that is present (the walker is not silently empty)', () => {
    // Independently count workflow FILES that mention `node-version:` at all, via simple
    // string search rather than pins()'s own regex — so this is a genuine cross-check on
    // the walker, not a tautology. Derived from what's actually on disk (not a hardcoded
    // 3) so it stays meaningful in the public snapshot, which ships only some workflows.
    const filesWithNodeVersion: string[] = [];
    for (const dir of WORKFLOW_DIRS) {
      const abs = path.join(repoRoot, dir);
      if (!fs.existsSync(abs)) continue;
      for (const name of fs.readdirSync(abs)) {
        if (!/\.ya?ml$/.test(name)) continue;
        if (fs.readFileSync(path.join(abs, name), 'utf8').includes('node-version:')) {
          filesWithNodeVersion.push(`${dir}/${name}`);
        }
      }
    }
    expect(filesWithNodeVersion.length, 'no workflow files on disk mention node-version — nothing to prove').toBeGreaterThan(0);

    const found = pins();
    expect(found.length, 'no node-version pins found at all — the walker is broken').toBeGreaterThanOrEqual(filesWithNodeVersion.length);
  });

  // The oss/ overlay is what CI publishes and builds the shipped installers from — but a
  // checkout of the public snapshot IS that overlay's output, so it never carries oss/
  // itself; nothing to scan there in that case.
  it.skipIf(!hasOssOverlay())('the oss/ overlay is scanned too — that is the half that drifted before', () => {
    const found = pins();
    expect(
      found.some((p) => p.file.startsWith('oss/')),
      'the oss/ overlay was not scanned — that is the half that drifted',
    ).toBe(true);
  });
});
