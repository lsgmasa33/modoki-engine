/** What the Inspector's entity header says about `EntityAttributes.guid` — the decision, kept out of
 *  `Inspector.tsx` so it carries a unit test (CLAUDE.md § Editor: a panel's DECISIONS live in a plain
 *  `.ts` beside it).
 *
 *  Three states, because since #1210 "has a guid" no longer means "is saved":
 *  - **durable** — a real identity: written to the scene file, survives reload and scene swaps.
 *  - **runtime** — the address `spawnEntity` minted for an entity spawned without one. It works for
 *    every guid-addressed tool NOW, but is valid only until the scene reloads, and the next save
 *    replaces it with a durable guid. Saying so is the point: an address that silently expires is
 *    the confusion #1199/#1207 were about.
 *  - **none** — no guid at all (only reachable for an entity whose EntityAttributes was added after
 *    spawn); the next save mints one. */

import { isRuntimeGuid } from '../../runtime/core/assetRefRules';

export type EntityGuidKind = 'durable' | 'runtime' | 'none';

export interface EntityGuidLabel {
  kind: EntityGuidKind;
  /** The value shown (and copied) — the guid itself, or a placeholder for `none`. */
  text: string;
  /** Short badge text beside the value; empty for a durable guid. */
  badge: string;
  /** Hover explanation. */
  title: string;
}

/** `transient`: a save never writes this entity — it or an ancestor is `Transient` (spawned inside a
 *  system tick: every Play spawn, a projection's generated content), or it came from a base scene.
 *  Decided by `isSkippedByPrimarySave`, so the label and the serializer share one rule. */
export function describeEntityGuid(guid: string | null | undefined, transient = false): EntityGuidLabel {
  if (!guid) {
    return {
      kind: 'none', text: '—', badge: 'unsaved',
      title: 'No guid yet. Saving the scene mints a durable one.',
    };
  }
  if (isRuntimeGuid(guid)) {
    return {
      kind: 'runtime', text: guid, badge: 'runtime',
      title: 'Runtime guid: this entity was spawned without one, so the engine gave it an address. '
        + 'It works in every guid-addressed tool now, but is valid only until the scene reloads — '
        + (transient
          ? 'and this entity is spawned at runtime, so it is never saved and never gets a durable guid.'
          : 'saving the scene replaces it with a durable guid.'),
    };
  }
  return {
    kind: 'durable', text: guid, badge: '',
    title: 'Durable guid: saved with the scene, and stable across reloads and scene swaps.',
  };
}
