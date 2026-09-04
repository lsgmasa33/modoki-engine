/** The cloud-sync contract's public surface (#532). See `types.ts` for the declaration surface,
 *  `decide.ts` for the pure decision table, `runGroupSync.ts` for the runner, and `resolveFork.ts`
 *  for applying a player's fork choice. */

export {
  defineSyncGroup, emptyMarks, neverSynced,
  type AnySyncGroup, type CloudGroup, type ConflictChoice, type ForkPolicy, type GroupAtomicity,
  type GroupMarks, type GroupStore, type GroupTransport, type LocalGroup, type SyncGroupSpec,
} from './types';
export {
  decideGroup, hasLocalWrites, scopeMarksToAccount, type GroupDecision,
} from './decide';
export {
  runGroupSync, runCloudSync, type GroupOutcome, type RunSyncOptions, type RunSyncResult,
} from './runGroupSync';
export { resolveGroupFork, type ResolveForkOptions } from './resolveFork';
export {
  CloudSyncCoordinator,
  type CloudSyncDeps, type PendingConflict, type SyncFork, type SyncOutcomeOf, type SyncReason,
} from './coordinator';
