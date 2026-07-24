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
 *  trace can't close on its own. */

import { type World } from 'koota';
import { emit } from './journal';

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
 *  ref missing at runtime." `level: 'warn'`. */
export function journalWarn(name: string, payload?: unknown, world?: World): void {
  emit(name, payload, world, 'warn');
}

/** Something unexpected and fatal to that system. `level: 'error'`. */
export function journalError(name: string, payload?: unknown, world?: World): void {
  emit(name, payload, world, 'error');
}
