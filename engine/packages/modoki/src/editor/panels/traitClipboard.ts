/** Component clipboard — the copy/paste buffer behind the Inspector's per-trait
 *  ⋮ menu (Copy Component / Paste Component Values / Paste As New).
 *
 *  Module-level, not panel-local: the Inspector unmounts whenever its FlexLayout
 *  tab is hidden, and a `useState` clipboard would silently vanish with it. In
 *  memory only — copying does NOT touch the system clipboard, so Cmd+C in the
 *  Hierarchy (entity copy) and this never fight over one buffer.
 *
 *  Values are deep-cloned on the way IN here and again on the way OUT (see
 *  `cloneTraitValues` callers) because `readTraitDataFull` hands back LIVE
 *  references into a trait's backing store: without the second clone, pasting one
 *  copied `SpriteAnimator.clips` array onto two entities would leave both sharing
 *  a single array, and editing one would mutate the other.
 *
 *  The clipboard therefore stores ONLY structured-cloneable fields. `cloneTraitValues`
 *  falls back to keeping the original reference for a field `structuredClone` refuses (a
 *  function, a WeakMap, a DOM node) — fine for its other callers, but here that reference
 *  would be shared by the clipboard, the source entity, and every entity pasted from it,
 *  so mutating one would mutate all. Such fields are dropped at copy time instead: a
 *  missing field pastes as the trait's default, which is wrong-but-inert, where an
 *  aliased one corrupts unrelated entities. (A class INSTANCE doesn't throw — it clones
 *  into a plain object, losing its prototype. Traits hold plain data, so that's fine.)
 *
 *  There is no clear-on-project-switch: opening a project hard-reloads the renderer
 *  (`webContents.reloadIgnoringCache()` in electron/main.ts `setProject`), which wipes
 *  this module along with everything else. */

import { useSyncExternalStore } from 'react';
import type { TraitMeta } from '../../runtime/ecs/traitRegistry';

export interface TraitClipboardEntry {
  /** Trait name the values were read from. Paste requires an exact match. */
  traitName: string;
  values: Record<string, unknown>;
}

/** Traits that must never be copied. `EntityAttributes` carries `guid`,
 *  `parentId` and `sortOrder` — pasting a `guid` would duplicate it and corrupt
 *  the GUID index that undo refs, `scene-mutate` and every Percept tool resolve
 *  entities through. `PrefabInstance` is likewise pure identity, not values. */
const EXCLUDED_TRAITS = new Set(['EntityAttributes', 'PrefabInstance']);

/** Can this trait's values be copied? Tags hold no values (their presence IS the
 *  value, and Add Component already covers that), so they get no ⋮ menu either. */
export function isTraitCopyable(meta: TraitMeta): boolean {
  return meta.category === 'component' && !EXCLUDED_TRAITS.has(meta.name);
}

let _entry: TraitClipboardEntry | null = null;
const listeners = new Set<() => void>();

export function getTraitClipboard(): TraitClipboardEntry | null {
  return _entry;
}

/** Deep-copy the fields `structuredClone` can handle; report the ones it can't.
 *  Exported for the unit test that pins the no-aliasing contract. */
export function cloneCopyableValues(
  values: Record<string, unknown>,
): { values: Record<string, unknown>; dropped: string[] } {
  const out: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(values)) {
    try { out[k] = structuredClone(v); } catch { dropped.push(k); }
  }
  return { values: out, dropped };
}

export function setTraitClipboard(traitName: string, values: Record<string, unknown>): void {
  const { values: cloned, dropped } = cloneCopyableValues(values);
  if (dropped.length > 0) {
    console.warn(`[traitClipboard] ${traitName}: skipped non-copyable field(s) ${dropped.join(', ')} — they would alias across pasted entities.`);
  }
  // An entry with no values is worse than no entry: its trait name still ENABLES
  // "Paste Component Values", which then writes nothing. Keep the previous entry.
  if (Object.keys(cloned).length === 0) {
    console.warn(`[traitClipboard] ${traitName}: nothing copyable to copy — clipboard unchanged.`);
    return;
  }
  _entry = { traitName, values: cloned };
  listeners.forEach((l) => l());
}

export function subscribeTraitClipboard(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Reactive read — re-renders the Inspector when a copy lands, so Paste Values
 *  flips from disabled to enabled without needing a selection change. */
export function useTraitClipboard(): TraitClipboardEntry | null {
  return useSyncExternalStore(subscribeTraitClipboard, getTraitClipboard, getTraitClipboard);
}
