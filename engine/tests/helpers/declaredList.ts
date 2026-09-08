/** ⚠️ **A guard's hand-written scope list must be checked against the population it claims to
 *  cover — otherwise "green" means "nothing found in the list somebody wrote" (#830).**
 *
 *  The rule this enforces is already in `docs/verify-and-ci.md` § "Source-scanning guards":
 *  **a scope restriction is a claim about where a defect can occur.** This module is the shared
 *  way to make that claim falsifiable, so it stops being re-derived one guard at a time.
 *
 *  ## The defect it exists to kill
 *
 *  Measured across this repo 2026-09-06, four guards independently wrote the same broken
 *  self-check: they filter the hand-list BY ITSELF and compare the result to the hand-list.
 *  `clonePortHardcoding.test.ts` was the clearest —
 *
 *      const resolvesBinary = SPAWNERS.filter(existsSync).filter(hasMarker);
 *      expect(resolvesBinary.sort()).toEqual([...SPAWNERS].sort());
 *
 *  — under a comment claiming the set was "found by the marker … rather than by a hand-listed
 *  set, so a NEW spawner is covered the day it is written". It can detect a **deleted** entry and
 *  never an **added** one, which is the only direction that matters: the population grows, the
 *  list does not, and the guard stays green over the difference.
 *
 *  So the contract here is deliberately asymmetric in emphasis. `missing` (in the population, not
 *  declared) is the defect. `stale` (declared, not in the population) is hygiene — worth failing
 *  on, but it is not what bites.
 *
 *  ## Exemptions are part of the population, not an escape from it
 *
 *  An `exempt` row must name something the marker CURRENTLY finds. A row for an item that no
 *  longer exists is vouching for nothing and would silently excuse that name if it came back —
 *  the same rule `corpusProducerIsShared.test.ts`'s EXEMPT ledger carries, generalised.
 *
 *  ## What this does NOT do
 *
 *  It does not enumerate anything. YOU supply `population`, because the marker that identifies a
 *  member is different at every site (a file that resolves a packaged binary, a module that
 *  dispatches on `/api/*`, a component that accepts a `dataUiId`). Getting that marker right is
 *  the judgement; this module only guarantees the comparison is honest once you have it.
 *
 *  ⚠️ And it cannot tell you the marker is CORRECT. A marker that matches nothing makes
 *  `population` empty and every check below vacuous — which is why `floor` is required and why
 *  `assertDeclaredListIsComplete` refuses a population smaller than it. */

import { expect } from 'vitest';

export interface DeclaredListCheck {
  /** What is being guarded, for the failure message. e.g. "SPAWNERS in clonePortHardcoding". */
  label: string;
  /** The hand-maintained list as the guard declares it today. */
  declared: readonly string[];
  /** Everything the marker finds. Supplied by the caller — see the note above. */
  population: readonly string[];
  /** Minimum plausible population size. REQUIRED: a marker that silently stops matching makes
   *  every comparison here vacuous, and a vacuous scope check is the defect one level up. */
  floor: number;
  /** Members deliberately left out of `declared`, each with the reason it is safe. Every row must
   *  currently appear in `population`, or it is stale and fails. */
  exempt?: ReadonlyArray<{ item: string; reason: string }>;
  /** Entries the list carries ON PURPOSE that the marker cannot see, each with its reason.
   *
   *  The mirror of `exempt`, and a real case rather than a convenience: `routeCoverage`'s
   *  ROUTE_FILES includes `electron/devServer.ts`, which does not dispatch on `/api/*` at all — it
   *  CALLS one (`http.get(new URL(IDENTITY_PATH, url))`) and owns the route constant the catalogue
   *  wants. A marker tuned to dispatchers is right, and so is that entry. Without this the guard
   *  would report it as stale and the honest fix would look like loosening the marker, which is
   *  how a population gets narrowed to fit a list. */
  extraDeclared?: ReadonlyArray<{ item: string; reason: string }>;
  /** One line telling the reader what to DO about a `missing` entry. */
  fix: string;
}

/**
 * Assert a guard's hand-written list still covers the population its marker finds.
 *
 * Fails in three independent directions, each with its own message:
 *  1. **vacuous**   — the population is below `floor`; the marker has broken.
 *  2. **missing**   — the marker found members the list does not name. *This is the defect.*
 *  3. **stale**     — the list names members the marker no longer finds, or an `exempt` row does.
 */
export function assertDeclaredListIsComplete(check: DeclaredListCheck): void {
  const { label, declared, population, floor, exempt = [], extraDeclared = [], fix } = check;

  expect(
    population.length,
    `${label}: the marker found ${population.length} member(s), below the floor of ${floor}. `
    + 'It has stopped matching — every check below would pass having examined nothing, which is '
    + 'exactly the failure this helper exists to prevent.',
  ).toBeGreaterThanOrEqual(floor);

  const pop = new Set(population);
  const exemptItems = new Set(exempt.map((e) => e.item));

  const staleExempt = exempt.filter((e) => !pop.has(e.item)).map((e) => e.item).sort();
  expect(
    staleExempt,
    `${label}: these exemption rows name members the marker no longer finds. Delete them — a `
    + 'stale exemption vouches for nothing and would silently excuse the name if it came back.',
  ).toEqual([]);

  const missing = population.filter((p) => !declared.includes(p) && !exemptItems.has(p)).sort();
  expect(
    missing,
    `${label}: the marker found these, and the hand-written list does not name them — so the `
    + `guard is GREEN over them and has never looked.\n\n${fix}\n\n`
    + 'If a member genuinely does not need covering, add an `exempt` row saying why. Do NOT widen '
    + 'the marker to exclude it: the marker defines the population, and narrowing it to fit the '
    + `list is how this defect comes back.\n\n${missing.join('\n')}`,
  ).toEqual([]);

  const allowedExtra = new Set(extraDeclared.map((e) => e.item));
  const uselessExtra = extraDeclared.filter((e) => pop.has(e.item)).map((e) => e.item).sort();
  expect(
    uselessExtra,
    `${label}: these extraDeclared rows name members the marker DOES find, so the row explains `
    + 'nothing and will outlive the reason it was written for. Delete them.',
  ).toEqual([]);

  const stale = declared.filter((d) => !pop.has(d) && !allowedExtra.has(d)).sort();
  expect(
    stale,
    `${label}: the hand-written list names these, and the marker does not find them. Either they `
    + 'were renamed or deleted (drop them), or the marker is wrong (fix it) — but a list entry '
    + 'that matches nothing is a scope claim with no subject.',
  ).toEqual([]);
}
