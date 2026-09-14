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
 *  **Type position vs value emit, and why the distinction is safe.** A hit like
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
 *  How the two are told apart: a type member is a PROPERTY SIGNATURE in the parse and a value
 *  emit is a PROPERTY ASSIGNMENT (or an `x.version = …` assignment), so only the latter is read.
 *  (Until #1179 this was a per-line regex keyed on a `;` following the literal — see `versionEmits`.) */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { hasScratchTooling } from '../helpers/repoLayout';
import { readScannedSource, stripComments } from '@modoki/engine/testing';
import { findNodes, lineOf, parseSource, ts, unwrapValue } from '@modoki/engine/testing/sourceAst';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';

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

/*  A `version:`/`schema:` value written as a bare numeric literal — a real VALUE emit, not a type
 *  position. The ASSIGNMENT form (`meta.version = 2;`) is read too — the shape the reimport-handler
 *  family and `writeAssetGuid` actually use. Without that half the original guard could not see a
 *  revert of the very fix it exists to protect (the ten reimport handlers cleaned up in #734 all
 *  wrote `meta.version = 2;`, never `version: 2`).
 *
 *  ⚠️ **Read from the PARSE since #1179, which retires the `;` discriminator.** The regex form
 *  (`\b(version|schema)\s*:\s*\d+(?!\s*;)|\.(version|schema)\s*=\s*\d`) told a type position from a
 *  value by the `;` after it, per LINE, so `meta.version =\n  2` escaped, and a code line starting with
 *  `*` was dropped as a comment. In the parse a type literal's `version: 2;` is a PROPERTY SIGNATURE and
 *  a value's is a PROPERTY ASSIGNMENT — the discriminator is the node kind. */
type Emit = { line: number; text: string; value: 'literal' | 'constant' | 'other' };
const VERSION_KEYS = new Set(['version', 'schema']);
/** Every `version`/`schema` VALUE written in one file — `{ version: … }` and `x.version = …` — with
 *  what it is written from: a numeric literal, a SCREAMING_CASE named constant, or anything else. */
function versionEmits(code: string, label: string): Emit[] {
  const sf = parseSource(code, label);
  const kind = (e: ts.Expression): Emit['value'] => {
    const u = unwrapValue(e);
    if (ts.isNumericLiteral(u)) return 'literal';
    return ts.isIdentifier(u) && /^[A-Z][A-Z0-9_]+$/.test(u.text) ? 'constant' : 'other';
  };
  const props = findNodes(sf, (n): n is ts.PropertyAssignment => ts.isPropertyAssignment(n)
    && (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name)) && VERSION_KEYS.has(n.name.text));
  const assigns = findNodes(sf, (n): n is ts.BinaryExpression => ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken
    && ts.isPropertyAccessExpression(n.left) && VERSION_KEYS.has(n.left.name.text));
  return [
    ...props.map((p) => ({ line: lineOf(p), text: p.getText(sf).replace(/\s+/g, ' '), value: kind(p.initializer) })),
    ...assigns.map((b) => ({ line: lineOf(b), text: b.getText(sf).replace(/\s+/g, ' '), value: kind(b.right) })),
  ];
}

/** A line carrying this marker is a KNOWN, narrowly-scoped, unrelated numeric version
 *  literal — e.g. `gen-skinned-test-models.mjs`'s `version: 8` is a SCENE format version,
 *  not the sidecar version this guard protects (#781). Use it on exactly the offending
 *  line, with a comment explaining what the literal actually is and why — carving out one
 *  line keeps the REST of the file (its real sidecar-version emit) covered by the guard,
 *  which excluding the whole file from PRODUCERS would not.
 *
 *  ⚠️ **It pardons ONE occurrence (#1179).** It used to skip its whole LINE, so a second literal
 *  written beside the carved-out one was pardoned too. Now a marker line holding more than one
 *  NUMERIC-LITERAL version emit pardons none of them — split them, or give each its own line. (Only
 *  literals are counted: a `schema: SCHEMA_V` beside the marked literal is not a violation to begin with.) */
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
  const abs = path.resolve(ENGINE, relPath);
  // Two reads, both declared: the CODE is what is classified; the raw text is read only to find the
  // ignore marker, which by design lives in a COMMENT on the literal's line.
  const { raw } = readScannedSource(abs, { comments: 'include', reason: 'the format-version ignore marker is a comment on the pardoned line' });
  const { code } = readScannedSource(abs);
  return literalViolations(raw, code, relPath);
}

/** `violationsIn` over text: the numeric-literal emits, minus the one a marker line pardons. */
function literalViolations(raw: string, code: string, label: string): { line: number; text: string }[] {
  const rawLines = raw.split('\n');
  const literals = versionEmits(code, label).filter((e) => e.value === 'literal');
  const perLine = new Map<number, number>();
  for (const e of literals) perLine.set(e.line, (perLine.get(e.line) ?? 0) + 1);
  return literals
    .filter((e) => !(rawLines[e.line - 1]?.includes(IGNORE_MARKER) && perLine.get(e.line) === 1))
    .map(({ line, text }) => ({ line, text }));
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
    // From CODE (#1179): the old whole-file regex over raw text was satisfied by a docblock quoting
    // `version: FOO_VERSION`, which is exactly the file this check exists to name.
    const missing = ALL_PRODUCERS.filter((rel) => {
      const abs = path.join(ENGINE, rel);
      return !versionEmits(readScannedSource(abs).code, rel).some((e) => e.value === 'constant');
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
    const dir = makeScratchDir('format-version-guard-');
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
    const literalsIn = (src: string) => literalViolations(src, stripComments(src), 'row.ts').length;
    // Positives — real value emits.
    expect(literalsIn('const a = { version: 2 };')).toBe(1);
    expect(literalsIn('const a = { schema: 1 };')).toBe(1);
    expect(literalsIn('const a = { version:3 };')).toBe(1);
    expect(literalsIn('const a = { "schema": 1, };')).toBe(1);

    // Negatives — referencing a named constant, or not a number.
    expect(literalsIn('const a = { version: SIDECAR_FORMAT_VERSION };')).toBe(0);
    expect(literalsIn('const a = { schema: SUBGAME_MANIFEST_SCHEMA_VERSION };')).toBe(0);
    expect(literalsIn("const a = { version: 'v1' };")).toBe(0);

    // The ASSIGNMENT form — `meta.version = 2;` — the shape the reimport-handler family
    // and `writeAssetGuid` actually use. This is the case #5 exists to close: without it
    // the guard cannot see a revert of the very literal it was written to protect.
    expect(literalsIn('meta.version = 2;')).toBe(1);
    expect(literalsIn('committed.version = SIDECAR_FORMAT_VERSION;')).toBe(0);

    // A comment is blanked by the scanner, whatever its first character.
    expect(literalsIn('/**\n * version: 2\n */\nconst x = 1;')).toBe(0);

    // Negatives — TypeScript type positions: a property SIGNATURE, not an assignment. These are real
    // lines from the corpus (made whole statements to parse).
    expect(literalsIn('type T = { schema: 1; };')).toBe(0);
    expect(literalsIn('export function buildManifest(): { version: 2; assets: X[] } { return m; }')).toBe(0);
    expect(literalsIn('let cachedManifest: { version: 2; assets: X[] } = { version: ASSET_MANIFEST_VERSION, assets: [] };')).toBe(0);

    // #1179: wrapped, a code line that begins with `*`, and two on one line.
    expect(literalsIn('meta.version =\n  2;')).toBe(1);
    expect(literalsIn('const a = {\n  version:\n    2,\n};')).toBe(1);
    expect(literalsIn('const b = 3\n  * 2; meta.schema = 4;')).toBe(1);
    expect(literalsIn('const c = { version: 1, schema: 2 };')).toBe(2);
  });

  it('a marker pardons ONE occurrence — a second literal on its line is not carried with it (#1179)', () => {
    const one = `const scene = { version: 8 }; // ${IGNORE_MARKER} — a scene format version`;
    const two = `const scene = { version: 8, schema: 3 }; // ${IGNORE_MARKER} — a scene format version`;
    expect(literalViolations(one, stripComments(one), 'row.ts')).toEqual([]);
    expect(literalViolations(two, stripComments(two), 'row.ts')).toHaveLength(2);
  });
});
