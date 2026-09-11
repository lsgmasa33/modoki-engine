/** Game-journal helpers — thin sugar over `emit()` for the handful of event shapes
 *  that recur across any gameplay bug hunt: a state/phase transition, a branch the
 *  game took and why, and something unexpected. Not a required taxonomy — a game can
 *  keep calling `emit()` directly for a plain semantic event (as `games/sling` does
 *  for `win`/`score`/etc.) and mix freely. These exist so a game author reaching for
 *  "I want Claude to be able to see this" has an obvious, consistent entry point
 *  instead of inventing a bare string + ad hoc payload shape per call site.
 *
 *  `journalDecision` is the one worth reaching for first: raw state dumps (a health
 *  value, a position) answer "what happened," but not "why" — an AI target pick, a
 *  spawn roll, a difficulty-scaling choice. That's the gap a plain `emit('hit', ...)`
 *  trace can't close on its own.
 *
 *  ⚠️ `journalError` is the one helper that is NOT journal-only: it also files a Crashlytics
 *  report (#1056). See its own doc comment before choosing it over `journalWarn`. */

import { type World } from 'koota';
import { emit } from './journal';
import { captureToCrashlytics } from './globalErrors';
import { jsonSafeReplacer } from './jsonSafe';

/** A state-machine/phase transition — `resetPhase`, a wave start/end, a boss phase
 *  change. `level: 'info'`. */
export function journalState(name: string, payload?: unknown, world?: World): void {
  emit(name, payload, world, 'info');
}

/** A branch the game took and why — an AI target pick, a spawn roll, a
 *  difficulty-scaling decision. `level: 'info'`. */
export function journalDecision(name: string, payload?: unknown, world?: World): void {
  emit(name, payload, world, 'info');
}

/** Something unexpected but non-fatal to that system — "no spawn point found," "asset
 *  ref missing at runtime." `level: 'warn'`. Journal-only: it reports nothing to Crashlytics. */
export function journalWarn(name: string, payload?: unknown, world?: World): void {
  emit(name, payload, world, 'warn');
}

/** Something unexpected and fatal to that system. `level: 'error'`.
 *
 *  ⚠️ **Also filed to Crashlytics, in EVERY build, as a `'caught'` report (#1056).** The journal is
 *  enabled only in the editor and debug builds (`engine/app/main.tsx`), so a failure a game caught
 *  and carried on from, reported only here, reached no one from a store build. It did not crash, by
 *  definition, so nothing else reported it either. Court had 28 such sites, among them unconfirmed
 *  payouts and IAP grants. wordweave had routed its own through a local helper (#930), which this
 *  replaces. The owner's call (2026-09-11) was to fix it here, once, rather than per game.
 *
 *  So pick the level deliberately. `journalError` means "a person should look at this". A handled,
 *  expected or self-healing outcome is `journalWarn`, which stays journal-only.
 *
 *  `'caught'` is an issue on its OWN session budget, not the crash budget: a failure that recurs
 *  with a varying payload (a new transaction id each time) would otherwise spend the budget that
 *  guarantees a genuine crash gets through. See `MAX_CAUGHT_PER_SESSION` in `globalErrors.ts`.
 *  ⚠️ Whether the Crashlytics CONSOLE shows distinct failures as distinct issues is a separate,
 *  pre-existing question: the plugin receives every JS report with the same grouping inputs (#1063).
 *
 *  ⚠️ **PRIVACY: the payload is sent to Crashlytics as text.** Guids, keys, product and transaction
 *  ids, counts and error text only. Never player content (a typed word, a name) and never an
 *  account identifier (a uid, an email). */
export function journalError(name: string, payload?: unknown, world?: World): void {
  // Reported FIRST: the journal write resolves a default world, and a throw there must not also
  // cost the report.
  captureToCrashlytics('caught', caughtFailureText(name, payload));
  emit(name, payload, world, 'error');
}

/** `[journalError] <name> <payload>`. A string payload is used verbatim; anything else is JSON through
 *  the shared `jsonSafeReplacer`, so each nested `Error` reads as text (a bare `JSON.stringify` turns
 *  it into `{}`, #1068). A payload that cannot be serialized still reports. */
function caughtFailureText(name: string, payload: unknown): string {
  if (payload === undefined) return `[journalError] ${name}`;
  let detail: string;
  try {
    detail = typeof payload === 'string'
      ? payload
      : JSON.stringify(payload, jsonSafeReplacer) ?? String(payload);
  } catch {
    try { detail = String(payload); } catch { detail = '<unprintable>'; }
  }
  return `[journalError] ${name} ${detail}`;
}
