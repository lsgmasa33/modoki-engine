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
 *  ⚠️ **The new per-line detector was measured against the old whole-file regexes over all 562
 *  runtime files: identical file sets for all three rules**, at 3 / 1 / 7 occurrences. The one
 *  deliberate narrowing: `\s*\(` used to span a newline on whole-file text and per line it cannot,
 *  so `Date.now\n()` would now be missed. No formatter in this repo emits that. */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments, assertScanIsSane } from '../helpers/sourceScanner';
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
    item: 'traits/Persistent.ts::crypto.randomUUID',
    reason: 'one-time guid when an entity is marked persistent (authoring). ⚠️ Note the token: it '
      + 'bypasses newGuid() rather than calling it.',
  },
] as const;

/** `core/assetRefRules.ts` DEFINES `newGuid()` and its body is the one `crypto.randomUUID()` call
 *  the repo is supposed to have. Structural, not a reviewed exception — see `sanctioned`. */
const GUID_SANCTIONED = [
  'core/assetRefRules.ts::newGuid',
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

/** Every occurrence of each token, one ledger row per occurrence.
 *
 *  ⚠️ Built from the detector's OWN token list rather than a second copy of the pattern — two
 *  matchers free to disagree is how a load-bearing check ends up checking nothing, which is the
 *  lesson `gitReadIsBounded` and `corpusProducerIsShared` both write down. And it counts per LINE
 *  with a global regex, because the old `\.test()` answered one boolean per FILE and so could not
 *  have carried a count at all. */
const occurrencesOf = (tokens: readonly string[]): Array<{ item: string; site: string }> => {
  // Hoisted out of the 562-file x per-line loops; it was rebuilding one RegExp per token per LINE.
  //
  // ⚠️ Reusing a `/g/` regex across lines is safe HERE only because `String.prototype.match` resets
  // `lastIndex` to 0 before it iterates. `.exec()` and `.test()` do NOT, and swapping either in
  // would make every other line silently unmatched.
  const matchers = tokens.map((tok) => ({
    tok,
    re: new RegExp(String.raw`\b${tok.replace(/\./g, String.raw`\.`)}\s*\(`, 'g'),
  }));
  const out: Array<{ item: string; site: string }> = [];
  for (const f of FILES) {
    f.code.split('\n').forEach((line, i) => {
      for (const { tok, re } of matchers) {
        for (let n = (line.match(re) ?? []).length; n > 0; n -= 1) {
          out.push({ item: `${f.rel}::${tok}`, site: `${f.rel}:${i + 1}` });
        }
      }
    });
  }
  return out;
};

describe('determinism guard (Phase 0)', () => {
  // Length/line parity is true by construction for the scanner (sourceScanner.ts) — this pins
  // against a regression to a regex stripper. The forward oracle lives in sourceScanner.test.ts.
  it('the comment strip is length- and line-exact (a regex stripper would not be)', () => {
    for (const f of FILES) assertScanIsSane(f.raw, f.code, f.rel);
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
