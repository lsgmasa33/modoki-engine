/** Closes the family behind #734/#730/#629: three format-version fields were shipped as
 *  bare NUMERIC LITERALS with no named constant anywhere — `schema: 1`, `version: 2`,
 *  written straight into the emitted artifact. With no constant, there is nothing for a
 *  reader to compare against and nothing for a reviewer's eye to catch, which is exactly
 *  why five instances went unnoticed across three separate fixes.
 *
 *  **This guard is deliberately SYNTACTIC, not semantic.** It only asks "does this emit
 *  reference a named constant?" — it does NOT ask "is the constant compared/read anywhere?".
 *  A semantic guard ("every format-version constant must be compared somewhere") was
 *  evaluated and REJECTED: measured against this repo it gives 2 false positives
 *  (`RIGGED_ENCODER_VERSION` and `MODEL_ENCODER_VERSION` are folded into content-cache
 *  keys — read by construction, with zero explicit comparisons) and 1 false negative
 *  (`PREFAB_FORMAT_VERSION` has a comparison, but it is only ever RAISED via `Math.max`;
 *  nothing branches on it — see #365). That is exactly backwards: it would be green on
 *  the case this family cares about. Do not "improve" this file into that version.
 *
 *  **The `;` vs `,`/`}` discriminator, and why it's safe.** A hit like
 *  `interface SubgameManifest { schema: 1 }` or a return-type annotation
 *  `{ version: 2; assets: X[] }` LOOKS like the same defect but isn't: it's a TypeScript
 *  literal TYPE, not a value emit. That asymmetry is deliberate and worth keeping — a
 *  PRODUCER-only type may pin the literal, because the module really does always emit
 *  that exact value, and `const X = 1` gives `X` the literal type `1` in TS, so writing
 *  `schema: X` into a field typed `schema: 1` only compiles while the constant's value
 *  matches; bump the constant and the assignment fails to typecheck, forcing the type to
 *  be updated in the same change. That makes the type annotation a READER of the
 *  constant enforced by the compiler — the opposite of the defect this guard exists for.
 *  A type describing a document read back from disk or the network must NOT do this
 *  (the bytes may have been written by a different build) — which is why
 *  `BinaryAssetMeta.version` became `number` in #734, and why `subgameLoader.ts`'s own
 *  `SubgameManifest` declares `schema: number` rather than the producer's `schema: 1`.
 *  TS type members are `;`-terminated; object-literal properties are `,`-terminated or
 *  close the literal — so a numeric hit whose next non-space character is `;` is a type
 *  position and is NOT a violation; anything else (`,`, `}`, end of line) is a real value
 *  emit and IS a violation. */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { hasScratchTooling } from '../helpers/repoLayout';

const ENGINE = path.resolve(__dirname, '../..');

/** Producers of versioned artifacts, scoped to exactly the family this guard protects. */
const PRODUCERS = [
  'plugins/subgameBuild.ts',
  'plugins/vite-asset-scanner.ts',
  'plugins/meta-sidecar.ts',
  'packages/modoki/src/runtime/loaders/assetManifest.ts',
  'scripts/ota/schema.mjs',
  // packages/modoki/src/runtime/ota/otaClient.ts is deliberately NOT here — it only
  // COMPARES `SCHEMA_VERSION` (`m.schema !== SCHEMA_VERSION`, `r.schema !== SCHEMA_VERSION`),
  // it never EMITS `schema: SCHEMA_VERSION` into a written object. The actual producer is
  // `scripts/ota/schema.mjs` above (which does emit it, twice, and is already anchored).
  // The two constants' parity (`SCHEMA_VERSION` ×2, docs/format-versioning.md § 3) is a
  // separate, already-covered concern — not this guard's job.
  'scripts/gen-white-hdr.mjs',
  // gen-skinned-test-models.mjs has an unrelated pre-existing `version: 8` numeric
  // literal (a SCENE format version, not a sidecar version) at the point it builds
  // its demo scene JSON (#781) — carved out narrowly via the `IGNORE_MARKER` below
  // rather than excluding the whole file, so its sidecar-version literal (`writeMeta`,
  // fixed to use SIDECAR_FORMAT_VERSION) is still protected by this guard.
  'scripts/gen-skinned-test-models.mjs',
];

/** Producers that live OUTSIDE the shipped engine (repo-private tooling). `npm run
 *  verify:publish` assembles an OSS snapshot from `scripts/publish-engine-oss.sh`, which is
 *  INCLUDE-ONLY (`git ls-files -- engine build docs` plus a few root files) — `tools-scratch/`
 *  is absent there by construction. Flattening this entry into `PRODUCERS` above made every
 *  fs-reading test in this file throw `ENOENT` in the snapshot: green on the worker clone, red
 *  the moment it reached the hub. Worth noting: the existing snapshot-exclusion list in
 *  `publish-engine-oss.sh` catches tests that *import* outside `engine/` (those fail to compile,
 *  TS2307) — it does not catch this file, which *reads* its paths at runtime with
 *  `fs.readFileSync` and so compiles fine and ENOENTs instead, a different failure shape.
 *  Checked only when present, via `hasScratchTooling()` (see `repoLayout.ts` for why that
 *  gates on the directory, not this file): in the private repo it always is, so the rename
 *  tripwire below still bites exactly where the file can actually be renamed. */
const PRIVATE_PRODUCERS = ['../tools-scratch/spine-import.mjs'];

/** The corpus every test below iterates. */
const ALL_PRODUCERS = [...PRODUCERS, ...(hasScratchTooling() ? PRIVATE_PRODUCERS : [])];

/** A `version:`/`schema:` property written as a bare numeric literal — a real VALUE
 *  emit, not a type position. See header comment for the `;` discriminator. Also catches
 *  the ASSIGNMENT form (`meta.version = 2;`) — the shape the reimport-handler family and
 *  `writeAssetGuid` actually use. Without this half the original guard could not see a
 *  revert of the very fix it exists to protect (the ten reimport handlers cleaned up in
 *  #734 all wrote `meta.version = 2;`, never `version: 2`). */
const VIOLATION = /\b(version|schema)\s*:\s*\d+(?!\s*;)|\.(version|schema)\s*=\s*\d/;

/** Same property, but read FROM a named constant (`version: FOO_VERSION` or
 *  `meta.version = FOO_VERSION`). Used only to anchor that the corpus is non-trivial —
 *  see the anti-vacuity check below. The assignment form is what makes `meta-sidecar.ts`
 *  itself (`committed.version = SIDECAR_FORMAT_VERSION`) a real anchor instead of a file
 *  this guard can neither violate nor vouch for. */
const FROM_CONSTANT = /\b(version|schema)\s*:\s*[A-Z][A-Z0-9_]+|\.(version|schema)\s*=\s*[A-Z][A-Z0-9_]+/;

/** A line carrying this marker is a KNOWN, narrowly-scoped, unrelated numeric version
 *  literal — e.g. `gen-skinned-test-models.mjs`'s `version: 8` is a SCENE format version,
 *  not the sidecar version this guard protects (#781). Use it on exactly the offending
 *  line, with a comment explaining what the literal actually is and why — carving out one
 *  line keeps the REST of the file (its real sidecar-version emit) covered by the guard,
 *  which excluding the whole file from PRODUCERS would not. */
const IGNORE_MARKER = 'format-version-guard: ignore-line';

function violationsIn(relPath: string): { line: number; text: string }[] {
  // `resolve`, not `join`, and the Windows CI is what forced it. The ignore-marker test below
  // builds its synthetic file under `os.tmpdir()` and hands us `path.relative(ENGINE, file)`.
  // On the Windows runner the repo is on `D:` and the temp dir on `C:`, and there IS no relative
  // path across drives — `path.relative` hands back an ABSOLUTE `C:\…` path, which `join`
  // happily glued onto the engine root to make `D:\a\…\engine\C:\…\synthetic.mjs` and
  // ENOENT'd. (Spelled with an ellipsis on purpose: the literal Windows temp path trips
  // `scan-publish-safety`'s home-dir-username rule, and the drive letter is the whole point
  // here anyway.) `resolve` returns an already
  // absolute argument unchanged, and is identical to `join` for the relative producer paths
  // (`..` segments included). Green on every POSIX clone either way — this is only reachable
  // where the tree and the temp dir sit on different volumes.
  const src = fs.readFileSync(path.resolve(ENGINE, relPath), 'utf-8');
  const hits: { line: number; text: string }[] = [];
  src.split('\n').forEach((line, idx) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('*') || trimmed.startsWith('//')) return;
    if (line.includes(IGNORE_MARKER)) return;
    if (VIOLATION.test(line)) hits.push({ line: idx + 1, text: trimmed });
  });
  return hits;
}

describe('format-version fields are emitted from a named constant, never a numeric literal', () => {
  it('every listed producer file exists (a rename must turn this red)', () => {
    for (const rel of ALL_PRODUCERS) {
      expect(fs.existsSync(path.join(ENGINE, rel)), `missing: ${rel}`).toBe(true);
    }
  });

  it('the corpus is non-trivially anchored: EVERY producer actually emits version/schema from a constant', () => {
    // If a future refactor strips a versioned emit out of one of these files, this guard
    // has nothing left to protect for that file and should say so loudly, NAMING which
    // one, rather than pass as long as some other file in the list still qualifies. A
    // weak lower bound (e.g. ">= 4" against a 7-entry list) lets N-1 producers be
    // stripped silently — the same defect this file already fixes for the sibling
    // `metaMergeNotClobber`-style liveness check.
    const missing = ALL_PRODUCERS.filter((rel) => {
      const src = fs.readFileSync(path.join(ENGINE, rel), 'utf-8');
      return !FROM_CONSTANT.test(src);
    });
    expect(
      missing,
      `expected every one of ${ALL_PRODUCERS.length} producers to emit version/schema from a ` +
        `named constant; NOT anchored: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('no producer writes a numeric literal into a version/schema property', () => {
    const violations = ALL_PRODUCERS.flatMap((rel) =>
      violationsIn(rel).map((h) => `${rel}:${h.line}: ${h.text}`),
    );
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('the ignore-marker mechanism only skips the marked line, not the whole file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'format-version-guard-'));
    const file = path.join(dir, 'synthetic.mjs');
    try {
      // A real violation with NO marker must still be flagged...
      fs.writeFileSync(file, 'export const meta = { version: 8 };\n');
      const relFromEngine = path.relative(ENGINE, file);
      expect(violationsIn(relFromEngine).length).toBe(1);

      // ...but the SAME literal carrying the marker on its own line must be skipped.
      fs.writeFileSync(
        file,
        `export const meta = { version: 8, // ${IGNORE_MARKER} — unrelated literal\n};\n`,
      );
      expect(violationsIn(relFromEngine)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the detector detects', () => {
    // Positives — real value emits.
    expect(VIOLATION.test('version: 2')).toBe(true);
    expect(VIOLATION.test('schema: 1')).toBe(true);
    expect(VIOLATION.test('  version:3')).toBe(true);
    expect(VIOLATION.test('  schema: 1,')).toBe(true);
    expect(VIOLATION.test('  version: 2 }')).toBe(true);

    // Negatives — referencing a named constant.
    expect(VIOLATION.test("version: SIDECAR_FORMAT_VERSION")).toBe(false);
    expect(VIOLATION.test('schema: SUBGAME_MANIFEST_SCHEMA_VERSION')).toBe(false);
    expect(VIOLATION.test("version: 'v1'")).toBe(false);

    // The ASSIGNMENT form — `meta.version = 2;` — the shape the reimport-handler family
    // and `writeAssetGuid` actually use. This is the case #5 exists to close: without it
    // the guard cannot see a revert of the very literal it was written to protect.
    expect(VIOLATION.test('  meta.version = 2;')).toBe(true);
    expect(VIOLATION.test('  committed.version = SIDECAR_FORMAT_VERSION;')).toBe(false);

    // Negative — a comment line (filtered upstream by the trim check, not by the regex
    // itself — verify the regex alone would still match so the trim guard is load-bearing).
    expect(VIOLATION.test(' * version: 2')).toBe(true);
    expect(' * version: 2'.trim().startsWith('*')).toBe(true);

    // Negatives — TypeScript type positions (`;`-terminated), the discriminator this
    // guard exists to get right. These are real lines from the corpus.
    expect(VIOLATION.test('  schema: 1;')).toBe(false);
    expect(
      VIOLATION.test(
        'export function buildManifest(): { version: 2; assets: X[] } {',
      ),
    ).toBe(false);
    expect(
      VIOLATION.test(
        'let cachedManifest: { version: 2; assets: X[] } = { version: ASSET_MANIFEST_VERSION, assets: [] };',
      ),
    ).toBe(false);
  });
});
