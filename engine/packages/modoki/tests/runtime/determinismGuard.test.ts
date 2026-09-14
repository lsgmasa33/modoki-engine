/** Determinism guard (Phase 0 — verification harness).
 *
 *  The headless playtest loop only reproduces if engine runtime systems take
 *  time from the injectable clock (`rawNow`/`getSimDelta`/`getVisualDelta`) and
 *  randomness from the seeded RNG service — never wall-clock or `Math.random`
 *  directly. This test fails the build if a new offender appears under
 *  `src/runtime/**`, so determinism can't silently drift (it's exactly what
 *  would have caught the skeletal-mixer-on-its-own-clock bug).
 *
 *  ⚠️ **The allowlists were keyed per FILE while the rules are per OCCURRENCE, so each one pardoned
 *  every future occurrence in its file — forever (#1123).** That is the whole defect: `core/clock.ts`
 *  carried two wall-clock reads under one entry, `loaders/spriteSheet.ts` two `newGuid()` calls, and
 *  a THIRD in either was green. The only defence was `ALLOW_WALLCLOCK.size <= 3`, which caps the
 *  LIST's length and says nothing about the occurrences inside each file — and there was **no
 *  staleness re-check at all**, in the guard `CLAUDE.md` § Time cites as what keeps game state
 *  deterministic.
 *
 *  Now every occurrence is named `file::token` and pardoned one at a time by
 *  `assertExemptionLedger` (`@modoki/engine/testing/exemptionLedger`), which fails on a second
 *  occurrence AND on a row blessing one that no longer exists. A count alone would not be enough:
 *  #1120 measured that binding one read while unbinding a different one in the same file keeps a
 *  bare count unchanged. Naming the token closes both directions.
 *
 *  ⚠️ **Counts here are on COMMENT-STRIPPED source, which is what the detector sees.** #1123 was
 *  filed with `grep` figures and its headline "an exempt file already has 8" was 6 docblock mentions
 *  plus 2 real calls. A raw count of this file's own prose would be wrong by more than the thing
 *  being measured.
 *
 *  ⚠️ **`traits/Persistent.ts` mints with `crypto.randomUUID` directly rather than through
 *  `newGuid()`**, which the ledger below now makes visible as a distinct token. Left alone — routing
 *  it is a behaviour change, not this change.
 *
 *  ⚠️ **An occurrence is a READ of the name, found in the parse — not a `\btok\s*\(` match per line
 *  (#1179).** The per-line form missed a wrapped `performance\n  .now()` and never saw an UNCALLED
 *  read at all: `applyOps(…, mint = newGuid)` hands the unseeded minter on to be called later, and
 *  it sat in `scene/sceneMutate.ts` unledgered. It also matched `function newGuid()` — a
 *  DECLARATION — which is what the old sanctioned `core/assetRefRules.ts::newGuid` row pardoned.
 *  Measured over all 567 runtime files on migrating: those two rows were the ENTIRE delta, every
 *  other file::token count identical. */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments, assertScanIsSane } from '../helpers/sourceScanner';
import { lineOf, parseSource, referencesToPath } from '../helpers/sourceAst';
import { assertExemptionLedger } from '../helpers/exemptionLedger';
import { repoFiles } from '../../../../scripts/repoCorpus.mjs';

const RUNTIME = join(fileURLToPath(new URL('.', import.meta.url)), '../../src/runtime');

/** ⚠️ **Every row names ONE occurrence as `<runtime-relative file>::<token>`, and pardons exactly
 *  one of it** (`count` where a file legitimately holds several of the same token). A bare file key
 *  is what #1123 is about; a bare count is what #1120 measured as still fail-open within a file.
 *
 *  Tokens are the detector's own, so a row cannot drift from what is banned: `performance.now`,
 *  `Date.now`, `Math.random`, `crypto.randomUUID`, `newGuid`. Sites measured 2026-09-12 on work-ai2 on
 *  comment-stripped source. */

/** Wall-clock reads that are the sanctioned source of "now", not a leak of it. */
const WALLCLOCK_LEDGER = [
  {
    item: 'core/clock.ts::performance.now',
    reason: 'THE sanctioned wrapper — `rawNow()` IS this read, and every runtime caller goes '
      + 'through it rather than around it.',
  },
  {
    item: 'core/clock.ts::Date.now',
    reason: 'The same wrapper\'s EPOCH half (`epochNow()`), a separate reader with a separate '
      + 'manual override. Named separately on purpose: it is the second occurrence that a '
      + 'file-keyed entry pardoned for free, and a THIRD reader appearing here should be a '
      + 'decision somebody makes.',
  },
  {
    item: 'core/rng.ts::Date.now',
    reason: 'The sanctioned RNG entropy seed, read once at module load to seed the default '
      + 'stream. Gameplay draws from the SEEDED stream, never from this.',
  },
] as const;

/** `Math.random` that reaches no game state. */
const RANDOM_LEDGER = [
  {
    item: 'audio/playlist.ts::Math.random',
    reason: 'The music-playlist shuffle. Cosmetic by construction: a playlist order reaches no '
      + 'game state, no journal event and no replay. Routing it through the seeded RNG would be '
      + 'actively WRONG — it would consume the stream gameplay draws from, so which track plays '
      + 'would change which level is generated.',
  },
] as const;

/** Unseeded guid minting. These are all AUTHORING / IMPORT / PERSISTENCE paths, never a
 *  deterministic sim tick — a random guid there is correct (a fresh unique identity). The guard
 *  exists so a NEW runtime *system* that spawns on the sim playhead cannot silently reach for a
 *  random guid (which would corrupt the replay-stable event journal, exactly the Timeline
 *  control-track bug) — it must derive a stable guid (e.g. `spawnPrefabInstance`'s `guidSeed`) or
 *  be named here. */
const GUID_LEDGER = [
  {
    item: 'loaders/loadGLB.ts::newGuid',
    reason: 'mints asset guids at GLB import time (authoring)',
  },
  {
    item: 'loaders/spriteSheet.ts::newGuid',
    count: 2,
    reason: 'mints sprite guids at slice time (authoring) — TWO sites, the per-sheet id and the '
      + 'per-slice id. Both are authoring-time; a THIRD would not be, and that is the occurrence '
      + 'the old file-keyed entry would have waved through.',
  },
  {
    item: 'loaders/loadSceneFile.ts::newGuid',
    reason: 'ad-hoc runtime-spawn fallback; deterministic callers pass guidSeed',
  },
  {
    item: 'scene/sceneMutate.ts::newGuid',
    reason: 'the DEFAULT `mint` of `applyOps` — an uncalled read, handed on and called per added '
      + 'entity. Its only production caller is the editor backend\'s scene-file mutate route '
      + '(authoring: an agent or the editor adding entities to a scene on disk); tests inject a '
      + 'deterministic mint.',
  },
  {
    item: 'traits/Persistent.ts::crypto.randomUUID',
    reason: 'one-time guid when an entity is marked persistent (authoring). ⚠️ Note the token: it '
      + 'bypasses newGuid() rather than calling it.',
  },
] as const;

/** `core/assetRefRules.ts` DEFINES `newGuid()` and its body is the one `crypto.randomUUID()` call
 *  the repo is supposed to have. Structural, not a reviewed exception — see `sanctioned`. (The
 *  definition's own name is not a read, so it needs no row since #1179.) */
const GUID_SANCTIONED = [
  'core/assetRefRules.ts::crypto.randomUUID',
] as const;

function tsFiles(dir: string): string[] {
  return repoFiles({
    under: dir,
    match: (rel) => /\.tsx?$/.test(rel) && !/\.test\.tsx?$/.test(rel),
    floor: 400,
  }).map(({ abs }) => abs);
}

// Comment stripping is the shared scanner (#419) — see sourceScanner.ts.

const FILES = tsFiles(RUNTIME).map((f) => {
  const raw = readFileSync(f, 'utf8');
  return { rel: relative(RUNTIME, f).replace(/\\/g, '/'), raw, code: stripComments(raw) };
});

/** Every READ of each token in one file's comment-stripped `code`, one entry per occurrence —
 *  called or not, however formatted (see `referencesToPath`). Pure, so the fixtures below drive the
 *  very detector the ledgers run on.
 *
 *  ⚠️ Built from the detector's OWN token list rather than a second copy of the pattern — two
 *  matchers free to disagree is how a load-bearing check ends up checking nothing, which is the
 *  lesson `gitReadIsBounded` and `corpusProducerIsShared` both write down. */
function readsIn(code: string, rel: string, tokens: readonly string[]): Array<{ item: string; site: string }> {
  const sf = parseSource(code, rel);
  return tokens.flatMap((tok) => referencesToPath(sf, tok).map((r) => ({ item: `${rel}::${tok}`, site: `${rel}:${lineOf(r)}` })));
}

const occurrencesOf = (tokens: readonly string[]): Array<{ item: string; site: string }> =>
  FILES.flatMap((f) => readsIn(f.code, f.rel, tokens));

describe('determinism guard (Phase 0)', () => {
  // Length/line parity is true by construction for the scanner (sourceScanner.ts) — this pins
  // against a regression to a regex stripper. The forward oracle lives in sourceScanner.test.ts.
  it('the comment strip is length- and line-exact (a regex stripper would not be)', () => {
    for (const f of FILES) assertScanIsSane(f.raw, f.code, f.rel);
  });

  it('the detector sees a WRAPPED read, an UNCALLED one, and two on one line (#1179)', () => {
    const src = [
      'const a = performance',
      '  .now();',
      'export function applyOps(mint: () => string = newGuid) { return mint(); }',
      'const pair = [Math.random(), Math.random()];',
      'export function newGuid(): string { return crypto.randomUUID(); }',
    ].join('\n');
    expect(readsIn(src, 'x.ts', ['performance.now', 'newGuid', 'Math.random', 'crypto.randomUUID']).map((o) => `${o.item}@${o.site}`))
      .toEqual(['x.ts::performance.now@x.ts:1', 'x.ts::newGuid@x.ts:3', 'x.ts::Math.random@x.ts:4', 'x.ts::Math.random@x.ts:4', 'x.ts::crypto.randomUUID@x.ts:5']);
  });

  it('no direct wall-clock outside the ledger', () => {
    assertExemptionLedger({
      label: 'WALLCLOCK_LEDGER in determinismGuard',
      population: occurrencesOf(['performance.now', 'Date.now']),
      exempt: WALLCLOCK_LEDGER,
      // ⚠️ A FLOOR, deliberately under the measured 3. Set to the exact population it stops being
      // a floor and starts doing the over-blessed check's job — with `floor: 3`, FIXING one of
      // clock.ts's two reads reddened this as "the detector has stopped matching", which is both
      // the wrong message and the reason the over-blessed arm was never exercised. Found by the
      // mutation check, not by review. 2 still catches a detector that matches one token or none.
      floor: 2,
      fix: 'use rawNow()/getSimDelta()/getVisualDelta() instead.',
    });
  });

  it('no Math.random outside the ledger (route gameplay RNG through the seeded service)', () => {
    assertExemptionLedger({
      label: 'RANDOM_LEDGER in determinismGuard',
      population: occurrencesOf(['Math.random']),
      exempt: RANDOM_LEDGER,
      // ⚠️ 1 measured, so 1 is the only honest floor, and the consequence is stated rather than
      // hidden: if that single shuffle is ever routed through the seeded RNG, THIS fires rather
      // than the over-blessed arm. For a one-row ledger that is the right signal — there is
      // nothing left to guard — but the message will say "stopped matching", so read it here.
      floor: 1,
      fix: 'route through the seeded RNG service (runtime/core/rng.ts).',
    });
  });

  it('no unseeded guid outside the ledger — deterministic spawns must derive a stable guid', () => {
    assertExemptionLedger({
      label: 'GUID_LEDGER in determinismGuard',
      population: occurrencesOf(['crypto.randomUUID', 'newGuid']),
      exempt: GUID_LEDGER,
      sanctioned: GUID_SANCTIONED,
      // 7 measured 2026-09-12 (5 ledgered + 2 sanctioned). Floored well under it so that FIXING a
      // pardoned call reaches the over-blessed arm ("blesses 2, found 1") instead of being reported
      // as a broken detector — see the wall-clock note above.
      floor: 4,
      fix: 'a deterministic sim path must derive a stable guid (e.g. spawnPrefabInstance guidSeed).',
    });
  });

  it('the ledgers stay small (review pressure)', () => {
    // Kept from the old `ALLOW_WALLCLOCK.size <= 3`, but counting what the rule is about: PARDONED
    // OCCURRENCES, not list length. The old form was satisfied by one entry pardoning eight calls.
    // If this trips, a redesign is probably leaking wall-clock — don't just bump it.
    // ⚠️ `item` is in the parameter type even though this only reads `count`. Without it the type
    // is WEAK — `{ count?: number }` shares no property with a row that omits `count`, and tsc
    // rejects the whole ledger with "has no properties in common". Caught by the ROOT typecheck
    // leg, which vitest cannot see.
    const pardoned = (l: ReadonlyArray<{ readonly item: string; readonly count?: number }>) =>
      l.reduce((n, e) => n + (e.count ?? 1), 0);
    expect(pardoned(WALLCLOCK_LEDGER)).toBeLessThanOrEqual(4);
    expect(pardoned(RANDOM_LEDGER)).toBeLessThanOrEqual(2);
    // ⚠️ `sanctioned` counts toward the cap too. It needs no `reason`, so leaving it uncapped made
    // it the CHEAPEST way to pardon a new unseeded guid — one array entry, no sentence written, cap
    // untouched, four tests green. Found by review. The old guard capped only ALLOW_WALLCLOCK, so
    // this is not a regression it introduced; it is a gap the new structural split would have opened.
    expect(pardoned(GUID_LEDGER) + GUID_SANCTIONED.length).toBeLessThanOrEqual(8);
  });
});
