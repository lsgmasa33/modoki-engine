/** Why a prefab document was refused at its seat (#1937 C-A, owner ruling F-A (1): Unity refuses a file whose
 *  identifiers repeat, and its instances load as missing-asset prefab instances). The refused prefab is a prefab that
 *  did not load (I18): its instances are Missing Prefab placeholders that keep every override. This store only names
 *  the reason, so the Hierarchy can say "Damaged Prefab" with it rather than "Missing Prefab" about a file that is there.
 *
 *  Keyed by every name the seat knows the prefab by (its path, and its guid when the document states one), since a
 *  placeholder's marker holds whichever the scene wrote. Written and cleared by the runtime cache's seat
 *  (`meshTemplateCache.ts`): set on a refusal, cleared whenever that key's failure memory is (a re-import, a fix, a
 *  scene swap). And by the scene load for a repeat no seat can see, across two documents (#1933 L5,
 *  `frameRepeatRefusal`): set when it refuses an instance, cleared when a later load finds the files fixed. */

const reasons = new Map<string, string>();

export function noteDamagedPrefab(keys: readonly string[], reason: string): void {
  for (const k of keys) if (k) reasons.set(k, reason);
}

export function forgetDamagedPrefab(key: string): void {
  const reason = reasons.get(key);
  if (reason === undefined) return;
  // Every alias of the same refusal goes with it (the path forgets the guid it was noted under too).
  for (const [k, r] of reasons) if (r === reason) reasons.delete(k);
}

/** The refusal reason for prefab `ref` (a guid or a path), or undefined when it was not refused. */
export function damagedPrefabReason(ref: string): string | undefined {
  return ref ? reasons.get(ref) : undefined;
}

export function clearDamagedPrefabs(): void {
  reasons.clear();
}
