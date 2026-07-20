/** Selection restore on world swap.
 *
 *  When SceneManager swaps worlds (e.g. on scene load), the editor's currently
 *  selected entity id becomes invalid because koota entity ids are scoped to
 *  their owning world. This module subscribes to onWorldSwap and tries to find
 *  the equivalent entity in the new world.
 *
 *  Fast path: if the selected entity has a non-empty EntityAttributes.guid,
 *  we look up the guid in the new world — guaranteed O(n) single-pass,
 *  no name ambiguity.
 *
 *  Fallback: for non-persistent entities (or children of persistent roots that
 *  don't themselves carry the trait), we match by name + ancestor path.
 *
 *  For non-persistent entities the path won't be found and selection clears. */

import { type World } from 'koota';
import { onWorldSwap } from '../../runtime/ecs/world';
import { getAllTraits, getTraitByName } from '../../runtime/ecs/traitRegistry';
import { useEditorStore } from './editorStore';

let registered = false;
let unsubscribe: (() => void) | null = null;

/** Register the swap listener. Idempotent — call once at editor startup. */
export function registerSelectionRestore(): void {
  if (registered) return;
  registered = true;
  unsubscribe = onWorldSwap((newWorld, oldWorld) => {
    restoreSelectionAcrossSwap(newWorld, oldWorld);
  });
}

// HMR cleanup: unsubscribe the old listener so a hot-reloaded module doesn't
// leave an orphan listener pointing at a stale editorStore reference.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    registered = false;
  });
}

/** Re-attach the editor's selection across a world swap. Reads the current
 *  selectedEntityId from the editor store, looks up its identity in the old
 *  world, and tries to find a matching entity in the new world. If found, the
 *  selection is updated to the new entity id. If not, the selection is cleared.
 *  Exported separately from the registry for testability. */
export function restoreSelectionAcrossSwap(newWorld: World, oldWorld: World): void {
  const { selectedEntityId, selectedEntityIds } = useEditorStore.getState();
  // Work from the multi-selection set; fall back to the primary alone when the
  // set is empty (e.g. selection set directly via setState rather than an action).
  const oldIds = selectedEntityIds.length > 0
    ? selectedEntityIds
    : (selectedEntityId != null ? [selectedEntityId] : []);
  if (oldIds.length === 0) return;

  // Build the guid maps in ONE pass per world (the fast path for persistent
  // entities), rather than re-scanning both worlds for every selected id.
  const oldGuidById = collectGuidsById(oldWorld);   // oldId  → guid
  const newIdByGuid = collectIdsByGuid(newWorld);   // guid   → newId

  // Name maps are only needed for entities lacking a guid; build them lazily so
  // a purely-persistent selection never pays for the (also O(n)) name pass.
  let oldNames: Map<number, { name: string; parentId: number }> | null = null;
  let newNames: Map<number, { name: string; parentId: number }> | null = null;

  const remap = (oldId: number): number | null => {
    const guid = oldGuidById.get(oldId);
    if (guid) return newIdByGuid.get(guid) ?? null;
    oldNames ??= collectEntityNames(oldWorld);
    newNames ??= collectEntityNames(newWorld);
    if (!oldNames.has(oldId)) return null;
    const path = walkPath(oldId, oldNames);
    if (!path || path.length === 0 || path.some((n) => !n)) return null;
    return findEntityByPathIn(newNames, path);
  };

  // Remap each member once; the primary is always a member of the set (store
  // invariant), so reuse its mapping instead of remapping it a second time.
  const mapped = new Map<number, number | null>();
  for (const oldId of oldIds) mapped.set(oldId, remap(oldId));
  const newIds = oldIds.map((id) => mapped.get(id)!).filter((v): v is number => v != null);

  const newPrimary = selectedEntityId != null
    ? (mapped.has(selectedEntityId) ? mapped.get(selectedEntityId)! : remap(selectedEntityId))
    : null;
  // Keep the primary inside the set; fall back to the last remaining member.
  const primary = newPrimary != null && newIds.includes(newPrimary)
    ? newPrimary
    : (newIds[newIds.length - 1] ?? null);

  useEditorStore.setState({ selectedEntityId: primary, selectedEntityIds: newIds });
}

// ── Guid helpers ──────────────────────────────────────────────────────────

/** One-pass map of entityId → non-empty EntityAttributes.guid for a world. */
function collectGuidsById(world: World): Map<number, string> {
  const out = new Map<number, string>();
  const eaMeta = getTraitByName('EntityAttributes');
  if (!eaMeta) return out;
  try {
    world.query(eaMeta.trait).updateEach(([ea]: Record<string, unknown>[], entity: { id(): number }) => {
      const g = ea.guid as string;
      if (g) out.set(entity.id(), g);
    });
  } catch { /* trait not initialized in this world */ }
  return out;
}

/** One-pass map of guid → entityId for a world. On the (illegal) chance two
 *  entities share a guid, the first wins — matching the old find-first scan. */
function collectIdsByGuid(world: World): Map<string, number> {
  const out = new Map<string, number>();
  const eaMeta = getTraitByName('EntityAttributes');
  if (!eaMeta) return out;
  try {
    world.query(eaMeta.trait).updateEach(([ea]: Record<string, unknown>[], entity: { id(): number }) => {
      const g = ea.guid as string;
      if (g && !out.has(g)) out.set(g, entity.id());
    });
  } catch { /* trait not initialized in this world */ }
  return out;
}

// ── Name + path helpers ─────────────────────────────────────────────────────

/** Find an entity in a prebuilt name-entry map whose ancestor name path equals
 *  the target path. Returns the entity id, or null if not found. */
function findEntityByPathIn(entries: Map<number, { name: string; parentId: number }>, targetPath: string[]): number | null {
  const leafName = targetPath[targetPath.length - 1];
  // Iterate candidates with matching leaf name first to keep this cheap on
  // large worlds (avoids walking ancestors for unrelated entities).
  for (const [id, entry] of entries) {
    if (entry.name !== leafName) continue;
    const candidatePath = walkPath(id, entries);
    if (candidatePath && pathsEqual(candidatePath, targetPath)) return id;
  }
  return null;
}

function walkPath(entityId: number, entries: Map<number, { name: string; parentId: number }>): string[] | null {
  const path: string[] = [];
  let current: number | undefined = entityId;
  const seen = new Set<number>();
  while (current != null && current !== 0 && !seen.has(current)) {
    seen.add(current);
    const entry = entries.get(current);
    if (!entry) return null;
    path.unshift(entry.name);
    current = entry.parentId;
  }
  return path;
}

function pathsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Build a snapshot of (entityId → name + parentId) for the world by querying
 *  EntityAttributes. Empty map if the trait isn't registered in the world. */
function collectEntityNames(world: World): Map<number, { name: string; parentId: number }> {
  const entries = new Map<number, { name: string; parentId: number }>();
  const allTraits = getAllTraits();
  const attrMeta = allTraits.find((m) => m.name === 'EntityAttributes');
  if (!attrMeta) return entries;
  try {
    world.query(attrMeta.trait).updateEach(([attr]: Record<string, unknown>[], entity: { id(): number }) => {
      entries.set(entity.id(), {
        name: (attr.name as string) ?? '',
        parentId: (attr.parentId as number) ?? 0,
      });
    });
  } catch {
    // EntityAttributes not initialized in this world — return empty map
  }
  return entries;
}
