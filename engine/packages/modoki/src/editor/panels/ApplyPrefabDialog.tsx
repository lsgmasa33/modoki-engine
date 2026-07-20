/** Selective Apply / Revert prefab-overrides dialog.
 *
 *  Walks the live prefab instance, collects every overridden field (per
 *  entity → trait → field) plus the structural diff, and presents a hierarchical
 *  checkbox tree. In `apply` mode the picked overrides become the new prefab
 *  base; in `revert` mode they are reset back to the prefab base on this single
 *  instance (the prefab file is untouched). Same diff tree, opposite direction. */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useEditorStore } from '../store/editorStore';
import {
  getPrefabSource,
  getOverrideValues,
  captureInstanceStructure,
  revertOverridesSelective,
  rebuildInstance,
  type PrefabFile,
} from '../scene/prefab';
import { pushAction } from '../undo/undoManager';
import { entityRef } from '../undo/entityRef';
import { applyToPrefabWithUndo } from '../undo/applyPrefabUndo';
import { getTraitByName, getAllTraits } from '../../runtime/ecs/traitRegistry';
import { readTraitData } from '../../runtime/ecs/entityUtils';
import { getCurrentWorld } from '../../runtime/ecs/world';
import type { AddedEntity } from '../../runtime/loaders/loadSceneFile';
import { buildOverrideForest, type ForestNode } from './prefabOverrideForest';

interface FieldNode {
  field: string;
  current: unknown;
  base: unknown;
  key: string; // "localId.traitName.fieldName"
}
interface TraitNode {
  trait: string;
  fields: FieldNode[];
}
interface EntityNode {
  ecsId: number;
  parentEcsId: number; // live EntityAttributes.parentId — used to nest the dialog tree
  localId: number;
  name: string;
  traits: TraitNode[];
}

/** Structural diff nodes, alongside the per-field EntityNode list. */
interface RemovedEntityNode { localId: number; name: string; key: string }   // "-removed.<localId>"
interface RemovedTraitNode { localId: number; entityName: string; trait: string; key: string } // "-trait.<localId>.<name>"
interface Structural {
  added: AddedEntity[];                  // each subtree root keyed "+added.<guid>"
  removedEntities: RemovedEntityNode[];
  removedTraits: RemovedTraitNode[];
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; entities: EntityNode[]; structural: Structural };

function stringifyValue(v: unknown): string {
  if (typeof v === 'number') {
    return Number.isInteger(v) ? String(v) : v.toFixed(3);
  }
  if (typeof v === 'string') return JSON.stringify(v);
  if (v === undefined) return '∅';
  return JSON.stringify(v);
}

function buildTree(rootInstanceId: number, prefab: PrefabFile): EntityNode[] {
  const PrefabInstanceMeta = getTraitByName('PrefabInstance');
  if (!PrefabInstanceMeta) return [];
  const allTraits = getAllTraits();
  const entityNameMeta = getTraitByName('EntityAttributes');

  const entries: EntityNode[] = [];
  getCurrentWorld().query(PrefabInstanceMeta.trait).updateEach(([pi], entity) => {
    const piData = pi as Record<string, unknown>;
    if (piData.rootInstanceId !== rootInstanceId) return;
    const localId = piData.localId as number;
    if (!localId) return;
    const ecsId = entity.id();

    // Snapshot live trait data for comparison
    const currentTraits: Record<string, Record<string, unknown>> = {};
    for (const meta of allTraits) {
      if (meta.name === 'PrefabInstance') continue;
      if (meta.category === 'tag') continue;
      const data = readTraitData(ecsId, meta);
      if (data) currentTraits[meta.name] = data;
    }
    const diffs = getOverrideValues(localId, currentTraits, prefab);
    if (Object.keys(diffs).length === 0) return;

    // Entity display name: prefer live EntityAttributes.name; fall back to prefab name.
    // Also capture the live parentId so the dialog can nest children under parents.
    let name = '';
    let parentEcsId = 0;
    if (entityNameMeta) {
      const ea = readTraitData(ecsId, entityNameMeta);
      if (ea?.name) name = ea.name as string;
      if (typeof ea?.parentId === 'number') parentEcsId = ea.parentId as number;
    }
    if (!name) {
      const prefabEntity = prefab.entities.find((e) => e.localId === localId);
      name = (prefabEntity?.name as string) || `localId ${localId}`;
    }

    const prefabEntity = prefab.entities.find((e) => e.localId === localId);
    const traitNodes: TraitNode[] = [];
    for (const [traitName, fields] of Object.entries(diffs)) {
      const fieldNodes: FieldNode[] = [];
      const base = (prefabEntity?.traits[traitName] as Record<string, unknown>) || {};
      for (const [field, current] of Object.entries(fields)) {
        fieldNodes.push({
          field,
          current,
          base: base[field],
          key: `${localId}.${traitName}.${field}`,
        });
      }
      if (fieldNodes.length > 0) traitNodes.push({ trait: traitName, fields: fieldNodes });
    }
    if (traitNodes.length > 0) entries.push({ ecsId, parentEcsId, localId, name, traits: traitNodes });
  });

  entries.sort((a, b) => a.localId - b.localId);
  return entries;
}

/** Build the structural diff (added subtrees, removed entities, removed traits)
 *  for the dialog from the live instance + prefab. */
function buildStructural(rootInstanceId: number, prefab: PrefabFile): Structural {
  const s = captureInstanceStructure(rootInstanceId, prefab);
  const prefabName = (localId: number) =>
    prefab.entities.find((e) => e.localId === localId)?.name || `localId ${localId}`;

  const removedEntities: RemovedEntityNode[] = s.removed.map((localId) => ({
    localId, name: prefabName(localId), key: `-removed.${localId}`,
  }));

  const removedTraits: RemovedTraitNode[] = [];
  for (const [localIdStr, names] of Object.entries(s.removedTraits)) {
    const localId = Number(localIdStr);
    for (const trait of names) {
      removedTraits.push({ localId, entityName: prefabName(localId), trait, key: `-trait.${localId}.${trait}` });
    }
  }
  return { added: s.added, removedEntities, removedTraits };
}

/** Count the leaf trait/field names inside an added subtree (for the row label). */
function describeAdded(node: AddedEntity): string {
  // Reference node = a user-added nested prefab instance (expands from a child file).
  if (node.prefab) return 'nested prefab instance';
  const traitCount = Object.keys(node.traits).filter((n) => n !== 'EntityAttributes').length;
  const childCount = node.children.length;
  const parts = [`${traitCount} trait${traitCount === 1 ? '' : 's'}`];
  if (childCount) parts.push(`${childCount} child${childCount === 1 ? '' : 'ren'}`);
  return parts.join(', ');
}

function TriCheckbox({ state, onChange, title }: {
  state: 'on' | 'off' | 'mixed';
  onChange: (next: 'on' | 'off') => void;
  title?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === 'mixed';
  }, [state]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={state === 'on'}
      onChange={(e) => onChange(e.target.checked ? 'on' : 'off')}
      title={title}
      style={{ marginRight: 6, cursor: 'pointer' }}
    />
  );
}

/** Read-only recursive display of an added subtree (rides with the root's single
 *  checkbox). Shows each node's traits and nested children, indented by depth. */
function AddedSubtreeRows({ node, depth }: { node: AddedEntity; depth: number }) {
  const traitNames = Object.keys(node.traits).filter((n) => n !== 'EntityAttributes');
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', minHeight: 20, fontFamily: 'monospace', fontSize: 11, paddingLeft: 28 + depth * 16 }}>
        <span style={{ color: '#888' }}>↳ {node.name || '(unnamed)'}</span>
        {traitNames.length > 0 && (
          <span style={{ color: '#5dade2', marginLeft: 8 }}>{traitNames.join(', ')}</span>
        )}
      </div>
      {node.children.map((child) => (
        <AddedSubtreeRows key={child.guid || child.name} node={child} depth={depth + 1} />
      ))}
    </>
  );
}

type Mode = 'apply' | 'revert';

export default function ApplyPrefabDialog() {
  return <PrefabOverridesDialog mode="apply" />;
}

export function RevertPrefabDialog() {
  return <PrefabOverridesDialog mode="revert" />;
}

function PrefabOverridesDialog({ mode }: { mode: Mode }) {
  const { active, rootInstanceId } = useEditorStore((s) =>
    mode === 'apply' ? s.applyPrefabDialog : s.revertPrefabDialog,
  );
  const closeDialog = useEditorStore((s) =>
    mode === 'apply' ? s.closeApplyPrefabDialog : s.closeRevertPrefabDialog,
  );
  const [loadState, setLoadState] = useState<LoadState>({ kind: 'loading' });
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    if (!active || rootInstanceId === null) return;
    let cancelled = false;
    setLoadState({ kind: 'loading' });
    (async () => {
      const PrefabInstanceMeta = getTraitByName('PrefabInstance');
      if (!PrefabInstanceMeta) {
        if (!cancelled) setLoadState({ kind: 'error', message: 'PrefabInstance trait not registered' });
        return;
      }
      let source = '';
      getCurrentWorld().query(PrefabInstanceMeta.trait).updateEach(([pi], entity) => {
        if (entity.id() !== rootInstanceId) return;
        source = (pi as Record<string, unknown>).source as string;
      });
      if (!source) {
        if (!cancelled) setLoadState({ kind: 'error', message: 'Entity is not a prefab instance' });
        return;
      }
      const prefab = await getPrefabSource(source);
      if (!prefab) {
        if (!cancelled) setLoadState({ kind: 'error', message: `Could not load prefab ${source}` });
        return;
      }
      const entities = buildTree(rootInstanceId, prefab);
      const structural = buildStructural(rootInstanceId, prefab);
      if (cancelled) return;
      const allKeys = new Set<string>();
      for (const e of entities) for (const t of e.traits) for (const f of t.fields) allKeys.add(f.key);
      for (const node of structural.added) allKeys.add(`+added.${node.guid}`);
      for (const r of structural.removedEntities) allKeys.add(r.key);
      for (const r of structural.removedTraits) allKeys.add(r.key);
      setChecked(allKeys);
      setCollapsed(new Set());
      setLoadState({ kind: 'ready', entities, structural });
    })();
    return () => { cancelled = true; };
  }, [active, rootInstanceId]);

  const totals = useMemo(() => {
    if (loadState.kind !== 'ready') return { total: 0, checked: 0 };
    let total = 0;
    let checkedCount = 0;
    const tally = (key: string) => { total++; if (checked.has(key)) checkedCount++; };
    for (const e of loadState.entities) for (const t of e.traits) for (const f of t.fields) tally(f.key);
    for (const node of loadState.structural.added) tally(`+added.${node.guid}`);
    for (const r of loadState.structural.removedEntities) tally(r.key);
    for (const r of loadState.structural.removedTraits) tally(r.key);
    return { total, checked: checkedCount };
  }, [loadState, checked]);

  if (!active) return null;

  const toggleKey = (key: string, next: 'on' | 'off') => {
    setChecked((prev) => {
      const out = new Set(prev);
      if (next === 'on') out.add(key); else out.delete(key);
      return out;
    });
  };
  const toggleMany = (keys: string[], next: 'on' | 'off') => {
    setChecked((prev) => {
      const out = new Set(prev);
      for (const k of keys) {
        if (next === 'on') out.add(k); else out.delete(k);
      }
      return out;
    });
  };
  const stateOf = (keys: string[]): 'on' | 'off' | 'mixed' => {
    let on = 0;
    for (const k of keys) if (checked.has(k)) on++;
    if (on === 0) return 'off';
    if (on === keys.length) return 'on';
    return 'mixed';
  };
  const toggleCollapsed = (id: string) => {
    setCollapsed((prev) => {
      const out = new Set(prev);
      if (out.has(id)) out.delete(id); else out.add(id);
      return out;
    });
  };

  const handleApply = async () => {
    if (rootInstanceId === null || checked.size === 0 || applying) return;
    setApplying(true);
    try {
      // Applies the selected overrides to the prefab AND pushes one undo entry.
      // (Promotion-driven scene re-save now happens inside applyToPrefabWithUndo.)
      await applyToPrefabWithUndo(rootInstanceId, checked);
      closeDialog();
    } finally {
      setApplying(false);
    }
  };

  const handleRevert = async () => {
    if (rootInstanceId === null || checked.size === 0 || applying) return;
    setApplying(true);
    try {
      const result = await revertOverridesSelective(rootInstanceId, checked);
      if (result) {
        // The rebuild assigns new ECS ids but preserves the instance root's guid
        // (rebuildInstance carries it over), so a guid-based ref re-finds the live
        // root across each rebuild AND across a world rebuild (Play→Stop).
        const ref = entityRef(result.newRootId);
        useEditorStore.getState().selectEntity(result.newRootId);
        const { source, prefab, fullOverrides, fullStructure, reducedOverrides, reducedStructure } = result;
        pushAction({
          label: 'Revert prefab overrides',
          undo: () => {
            const cur = ref.resolve(); if (cur == null) return;
            const id = rebuildInstance(cur, source, prefab, fullOverrides, fullStructure);
            useEditorStore.getState().selectEntity(id);
          },
          redo: () => {
            const cur = ref.resolve(); if (cur == null) return;
            const id = rebuildInstance(cur, source, prefab, reducedOverrides, reducedStructure);
            useEditorStore.getState().selectEntity(id);
          },
        });
      }
      closeDialog();
    } finally {
      setApplying(false);
    }
  };

  const baseRow: React.CSSProperties = { display: 'flex', alignItems: 'center', minHeight: 22, fontFamily: 'monospace', fontSize: 12 };

  const isRevert = mode === 'revert';
  const title = isRevert ? 'Revert Overrides' : 'Apply to Prefab';
  const emptyMsg = isRevert ? 'No overrides to revert on this instance.' : 'No overrides to apply on this instance.';
  const confirmLabel = applying ? (isRevert ? 'Reverting…' : 'Applying…') : (isRevert ? 'Revert' : 'Apply');
  const onConfirm = isRevert ? handleRevert : handleApply;
  const confirmBg = isRevert ? '#6a3a2d' : '#2d4a6a';
  const confirmBorder = isRevert ? '#7a4a3a' : '#3a4a5a';

  // Render one override-entity node and its nested children (indented by depth),
  // so a child entity sits under its parent instead of as a flat sibling.
  // Collapsing an entity hides its traits AND its descendant subtree.
  const INDENT = 16;
  const renderEntityNode = (fnode: ForestNode<EntityNode>): React.ReactElement => {
    const e = fnode.node;
    const d = fnode.depth;
    const entityKeys = e.traits.flatMap((t) => t.fields.map((f) => f.key));
    const entityState = stateOf(entityKeys);
    const entityCollapsed = collapsed.has(`e:${e.localId}`);
    return (
      <div key={e.localId} style={{ marginBottom: 4 }}>
        <div style={{ ...baseRow, paddingLeft: 4 + d * INDENT }}>
          <span
            onClick={() => toggleCollapsed(`e:${e.localId}`)}
            style={{ cursor: 'pointer', color: '#888', width: 14, userSelect: 'none' }}
          >{entityCollapsed ? '▸' : '▾'}</span>
          <TriCheckbox state={entityState} onChange={(next) => toggleMany(entityKeys, next)} />
          <span style={{ color: '#ddd', fontWeight: 'bold' }}>{e.name}</span>
          <span style={{ color: '#555', marginLeft: 8, fontSize: 10 }}>localId {e.localId}</span>
        </div>
        {!entityCollapsed && e.traits.map((t) => {
          const traitKeys = t.fields.map((f) => f.key);
          const traitState = stateOf(traitKeys);
          const traitCollapsed = collapsed.has(`e:${e.localId}:t:${t.trait}`);
          return (
            <div key={t.trait}>
              <div style={{ ...baseRow, paddingLeft: 26 + d * INDENT }}>
                <span
                  onClick={() => toggleCollapsed(`e:${e.localId}:t:${t.trait}`)}
                  style={{ cursor: 'pointer', color: '#888', width: 14, userSelect: 'none' }}
                >{traitCollapsed ? '▸' : '▾'}</span>
                <TriCheckbox state={traitState} onChange={(next) => toggleMany(traitKeys, next)} />
                <span style={{ color: '#5dade2' }}>{t.trait}</span>
              </div>
              {!traitCollapsed && t.fields.map((f) => (
                <div key={f.key} style={{ ...baseRow, paddingLeft: 64 + d * INDENT }}>
                  <TriCheckbox
                    state={checked.has(f.key) ? 'on' : 'off'}
                    onChange={(next) => toggleKey(f.key, next)}
                  />
                  <span style={{ color: '#bbb', minWidth: 110 }}>{f.field}</span>
                  {isRevert ? (
                    <>
                      <span style={{ color: '#888', textDecoration: 'line-through' }}>{stringifyValue(f.current)}</span>
                      <span style={{ color: '#666', margin: '0 6px' }}>→</span>
                      <span style={{ color: '#2ecc71', fontWeight: 'bold' }}>{stringifyValue(f.base)}</span>
                    </>
                  ) : (
                    <>
                      <span style={{ color: '#666' }}>{stringifyValue(f.base)}</span>
                      <span style={{ color: '#666', margin: '0 6px' }}>→</span>
                      <span style={{ color: '#5dade2', fontWeight: 'bold' }}>{stringifyValue(f.current)}</span>
                    </>
                  )}
                </div>
              ))}
            </div>
          );
        })}
        {!entityCollapsed && fnode.children.map((child) => renderEntityNode(child))}
      </div>
    );
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9999,
      background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{
        background: '#1e1e30', border: '1px solid #555', borderRadius: 6,
        padding: '16px 20px', width: 540, maxHeight: '80vh', display: 'flex', flexDirection: 'column',
        fontFamily: 'monospace',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <span style={{ color: '#fff', fontSize: 13, fontWeight: 'bold' }}>{title}</span>
          <span style={{ color: '#888', fontSize: 11 }}>{totals.checked} / {totals.total} selected</span>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', border: '1px solid #333', borderRadius: 4, padding: 8, background: '#15151f' }}>
          {loadState.kind === 'loading' && (
            <div style={{ color: '#888', fontSize: 12, padding: 8 }}>Loading overrides…</div>
          )}
          {loadState.kind === 'error' && (
            <div style={{ color: '#e74c3c', fontSize: 12, padding: 8 }}>{loadState.message}</div>
          )}
          {loadState.kind === 'ready' && loadState.entities.length === 0
            && loadState.structural.added.length === 0
            && loadState.structural.removedEntities.length === 0
            && loadState.structural.removedTraits.length === 0 && (
            <div style={{ color: '#888', fontSize: 12, padding: 8 }}>{emptyMsg}</div>
          )}
          {loadState.kind === 'ready'
            && buildOverrideForest(loadState.entities).map((fnode) => renderEntityNode(fnode))}

          {loadState.kind === 'ready' && loadState.structural.added.map((node) => {
            const key = `+added.${node.guid}`;
            return (
              <div key={key} style={{ marginBottom: 4 }}>
                <div style={{ ...baseRow, paddingLeft: 4 }}>
                  <span style={{ width: 14 }} />
                  <TriCheckbox
                    state={checked.has(key) ? 'on' : 'off'}
                    onChange={(next) => toggleKey(key, next)}
                    title={isRevert
                      ? 'Remove this added entity (and its subtree) from the instance'
                      : 'Add this entity (and its subtree) to the prefab base'}
                  />
                  {isRevert
                    ? <span style={{ color: '#e74c3c' }}>− remove&nbsp;</span>
                    : <span style={{ color: '#2ecc71' }}>+ added&nbsp;</span>}
                  <span style={{ color: '#ddd', fontWeight: 'bold' }}>{node.name || '(unnamed)'}</span>
                  <span style={{ color: '#555', marginLeft: 8, fontSize: 10 }}>
                    under localId {node.parentLocalId} · {describeAdded(node)}
                  </span>
                </div>
                <AddedSubtreeRows node={node} depth={1} />
              </div>
            );
          })}

          {loadState.kind === 'ready' && loadState.structural.removedEntities.map((r) => (
            <div key={r.key} style={{ ...baseRow, paddingLeft: 4, marginBottom: 2 }}>
              <span style={{ width: 14 }} />
              <TriCheckbox
                state={checked.has(r.key) ? 'on' : 'off'}
                onChange={(next) => toggleKey(r.key, next)}
                title={isRevert
                  ? 'Restore this prefab entity to the instance'
                  : 'Delete this entity from the prefab base — affects all instances'}
              />
              {isRevert
                ? <span style={{ color: '#2ecc71' }}>+ restore&nbsp;</span>
                : <span style={{ color: '#e74c3c' }}>− removed&nbsp;</span>}
              <span style={{ color: '#ddd', fontWeight: 'bold' }}>{r.name}</span>
              <span style={{ color: '#555', marginLeft: 8, fontSize: 10 }}>localId {r.localId}{isRevert ? '' : ' · affects all instances'}</span>
            </div>
          ))}

          {loadState.kind === 'ready' && loadState.structural.removedTraits.map((r) => (
            <div key={r.key} style={{ ...baseRow, paddingLeft: 4, marginBottom: 2 }}>
              <span style={{ width: 14 }} />
              <TriCheckbox
                state={checked.has(r.key) ? 'on' : 'off'}
                onChange={(next) => toggleKey(r.key, next)}
                title={isRevert
                  ? 'Restore this component to the instance'
                  : 'Delete this component from the prefab base — affects all instances'}
              />
              {isRevert
                ? <span style={{ color: '#2ecc71' }}>+ restore&nbsp;</span>
                : <span style={{ color: '#e74c3c' }}>− removed&nbsp;</span>}
              <span style={{ color: '#5dade2' }}>{r.trait}</span>
              <span style={{ color: '#888', margin: '0 6px' }}>on</span>
              <span style={{ color: '#ddd' }}>{r.entityName}</span>
              <span style={{ color: '#555', marginLeft: 8, fontSize: 10 }}>localId {r.localId}</span>
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          <button
            onClick={closeDialog}
            disabled={applying}
            data-ui-id="prefab.dialog.cancel" data-ui-kind="button" data-ui-label="cancel"
            style={{
              padding: '5px 16px', border: '1px solid #555', borderRadius: 3,
              background: '#2a2a40', color: '#ccc', cursor: applying ? 'default' : 'pointer',
              fontFamily: 'monospace', fontSize: 11, opacity: applying ? 0.5 : 1,
            }}
          >Cancel</button>
          <button
            onClick={onConfirm}
            disabled={applying || totals.checked === 0 || loadState.kind !== 'ready'}
            data-ui-id="prefab.dialog.confirm" data-ui-kind="button"
            style={{
              padding: '5px 16px', border: `1px solid ${confirmBorder}`, borderRadius: 3,
              background: confirmBg, color: '#fff', cursor: (applying || totals.checked === 0) ? 'default' : 'pointer',
              fontFamily: 'monospace', fontSize: 11,
              opacity: (applying || totals.checked === 0 || loadState.kind !== 'ready') ? 0.5 : 1,
            }}
          >{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
