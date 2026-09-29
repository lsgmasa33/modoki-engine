/** Selective Apply / Revert prefab-overrides dialog.
 *
 *  Walks the live prefab instance, collects every overridden field (per
 *  entity → trait → field) plus the structural diff, and presents a hierarchical
 *  checkbox tree. In `apply` mode the picked overrides become the new prefab
 *  base; in `revert` mode they are reset back to the prefab base on this single
 *  instance (the prefab file is untouched). Same diff tree, opposite direction. */

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useEditorStore } from '../store/editorStore';
import {
  getPrefabSource,
  preloadNestedPrefabsForSubtree,
  ownInstanceStructure,
  revertRefusal,
  previewApply,
  type PrefabFile,
  type ApplyPreview,
} from '../scene/prefab';
import { applyToPrefabWithUndo } from '../undo/applyPrefabUndo';
import { revertOverridesWithUndo } from '../undo/revertPrefabUndo';
import { getTraitByName } from '../../runtime/core/ecs/traitRegistry';
import { getCurrentWorld } from '../../runtime/core/ecs/world';
import { findEntity, getAllEntities } from '../../runtime/core/ecs/entityUtils';
import { livePinnedId } from '../../runtime/core/ecs/entityPin';
import { subjectGoneNotice, runOnPinnedSubject } from './prefabDialogSubject';
import type { AddedEntity } from '../../runtime/loaders/loadSceneFile';
import { buildOverrideForest, type ForestNode } from './prefabOverrideForest';
import { MixedCheckbox } from './assetViews/widgets';
import {
  collectInstanceOverrideTree, collectInstanceOverrideKeys, addedKey, removedEntityKey, removedTraitKey, movedKey, applyOutcomeNotice, nestedFrameMoves, documentMemberRefs,
  type EntityOverrideNode, type AddedTagNode,
} from '../scene/prefabOverrideKeys';
import { ModalShell } from '../components/ModalShell';
import { applyTargetOptions, type KeyTargets } from '../scene/prefabApplyOptions';
import {
  initialTargets, setTarget, setAllTargets, chosenOption, hasChoice, filesWritten, toApplyTargets, rowView, applyBlocked,
  previewRequestKey, staysOpen, previewWorldKey, subscribePreviewWorld, type TargetChoice,
} from './applyDialogModel';

// The dialog's tree node is the shared shape exactly — aliased locally so the rest
// of this file (predating the extraction) doesn't need a wholesale rename.
type EntityNode = EntityOverrideNode;

/** Structural diff nodes, alongside the per-field EntityNode list. */
interface RemovedEntityNode { localId: number; name: string; key: string }   // "-removed.<member>" (prefabOverrideKeys.ts)
interface RemovedTraitNode { localId: number; entityName: string; trait: string; key: string } // "-trait.<member>.<name>"
interface MovedNode { localId: number; name: string; parentName: string; key: string } // "~moved.<member>" (#1437)
interface Structural {
  added: AddedEntity[];                  // each subtree root keyed "+added.<guid>"
  removedEntities: RemovedEntityNode[];
  removedTraits: RemovedTraitNode[];
  moved: MovedNode[];
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; entities: EntityNode[]; addedTags: AddedTagNode[]; structural: Structural; nested: string[] };

function stringifyValue(v: unknown): string {
  if (typeof v === 'number') {
    return Number.isInteger(v) ? String(v) : v.toFixed(3);
  }
  if (typeof v === 'string') return JSON.stringify(v);
  if (v === undefined) return '∅';
  return JSON.stringify(v);
}

/** Build the structural diff (added subtrees, removed entities, removed traits)
 *  for the dialog from the live instance + prefab. */
function buildStructural(rootInstanceId: number, prefab: PrefabFile): Structural {
  // Only what THIS instance changed (#1506): a structural row the enclosing prefab authors is not its to apply.
  const s = ownInstanceStructure(rootInstanceId, prefab);
  const refOf = documentMemberRefs(prefab); // read from the document the capture diffs against (#1468 Phase 4)
  const prefabName = (localId: number) =>
    prefab.entities.find((e) => e.localId === localId)?.name || `localId ${localId}`;

  const removedEntities: RemovedEntityNode[] = s.removed.map((localId) => ({
    localId, name: prefabName(localId), key: removedEntityKey(refOf(localId)),
  }));

  const removedTraits: RemovedTraitNode[] = [];
  for (const [localIdStr, names] of Object.entries(s.removedTraits)) {
    const localId = Number(localIdStr);
    for (const trait of names) {
      removedTraits.push({ localId, entityName: prefabName(localId), trait, key: removedTraitKey(refOf(localId), trait) });
    }
  }
  const nameOfGuid = new Map(getAllEntities().filter((e) => e.guid).map((e) => [e.guid!, e.name]));
  const moved: MovedNode[] = Object.entries(s.moved).map(([localIdStr, parentGuid]) => {
    const localId = Number(localIdStr);
    return { localId, name: prefabName(localId), parentName: nameOfGuid.get(parentGuid) || '(unknown)', key: movedKey(refOf(localId)) };
  });
  // A nested instance's member moved out of it: recorded by THIS prefab (#1437).
  const nameOfId = new Map(getAllEntities().map((e) => [e.id, e.name]));
  for (const m of nestedFrameMoves(rootInstanceId)) {
    moved.push({ localId: m.lid, name: nameOfId.get(m.memberEcs) || `localId ${m.lid}`, parentName: nameOfGuid.get(m.parentGuid) || '(unknown)', key: m.ref });
  }
  return { added: s.added, removedEntities, removedTraits, moved };
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

/** A row's tri-state checkbox. Through MixedCheckbox so it carries a handle (#1170): these rows were
 *  untagged, so an agent could neither read a partly-selected entity nor tick one. */
export function TriCheckbox({ state, onChange, title, dataUiId, dataUiLabel }: {
  state: 'on' | 'off' | 'mixed';
  onChange: (next: 'on' | 'off') => void;
  title?: string;
  dataUiId: string;
  dataUiLabel?: string;
}) {
  return (
    <MixedCheckbox checked={state === 'on'} mixed={state === 'mixed'} onChange={(v) => onChange(v ? 'on' : 'off')}
      title={title} style={{ marginRight: 6, cursor: 'pointer' }} dataUiId={dataUiId} dataUiLabel={dataUiLabel} />
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
  const { active, subject } = useEditorStore((s) =>
    mode === 'apply' ? s.applyPrefabDialog : s.revertPrefabDialog,
  );
  const rootInstanceId = subject?.id ?? null;
  const closeDialog = useEditorStore((s) =>
    mode === 'apply' ? s.closeApplyPrefabDialog : s.closeRevertPrefabDialog,
  );
  const [loadState, setLoadState] = useState<LoadState>({ kind: 'loading' });
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [applying, setApplying] = useState(false);
  // Where each key is written (#1693, owner ruling C): its targets, and the one chosen. Apply only.
  const [targetOpts, setTargetOpts] = useState<Map<string, KeyTargets>>(new Map());
  const [choice, setChoice] = useState<TargetChoice>({});
  // What the checked keys at their targets DO (#1736): a dry run of exactly this Apply, which every row, the footer and
  // the conflict line render. `request` is the selection it was computed for; a newer selection makes it stale.
  const [preview, setPreview] = useState<(ApplyPreview & { request: string }) | null>(null);
  const [previewEpoch, setPreviewEpoch] = useState(0);
  // #1773: a world change (an edit, an undo, Play/Stop, a pose preview) re-plans the preview too.
  const worldKey = useSyncExternalStore(subscribePreviewWorld, previewWorldKey, previewWorldKey);

  /** #868: when the instance root the dialog was opened for no longer exists, the dialog closes with a
   *  notice rather than acting on whatever entity now holds its index (see prefabDialogSubject.ts). */
  const closeAsGone = (notice: string) => {
    closeDialog();
    useEditorStore.getState().showToast(notice, 'warn');
  };

  useEffect(() => {
    if (!active || rootInstanceId === null) return;
    if (livePinnedId(subject, findEntity, getCurrentWorld()) === null) { closeAsGone(subjectGoneNotice(mode)); return; }
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
      // `buildStructural` -> `ownInstanceStructure` -> `captureInstanceStructure` -> `captureNestedRef` reads nested
      // children from the editor cache SYNCHRONOUSLY. The fetch above warms only the OUTER
      // prefab, so on a cold cache a nested instance the author dragged in by hand is dropped
      // from `added[]` and is simply MISSING from this dialog — unpromotable, with only a
      // console.warn (#1284).
      await preloadNestedPrefabsForSubtree(rootInstanceId);
      if (cancelled) return;
      const { entities, addedTags } = collectInstanceOverrideTree(rootInstanceId, prefab);
      const structural = buildStructural(rootInstanceId, prefab);
      if (cancelled) return;
      const allKeys = new Set<string>();
      for (const e of entities) for (const t of e.traits) for (const f of t.fields) allKeys.add(f.key);
      for (const t of addedTags) allKeys.add(t.key);
      for (const node of structural.added) allKeys.add(addedKey(node.guid));
      for (const r of structural.removedEntities) allKeys.add(r.key);
      for (const r of structural.removedTraits) allKeys.add(r.key);
      for (const r of structural.moved) allKeys.add(r.key);
      // U14 (#1693): the nested instances' own edits, which Apply on this OUTER instance writes into its prefab by default.
      const nested = mode === 'apply' ? collectInstanceOverrideKeys(rootInstanceId, prefab).nested : [];
      for (const k of nested) allKeys.add(k);
      setChecked(allKeys);
      const opts = mode === 'apply' ? applyTargetOptions(rootInstanceId, prefab, [...allKeys]) : new Map<string, KeyTargets>();
      setTargetOpts(opts);
      setChoice(initialTargets(opts));
      setCollapsed(new Set());
      setLoadState({ kind: 'ready', entities, addedTags, structural, nested });
    })();
    return () => { cancelled = true; };
  }, [active, subject]);

  useEffect(() => {
    if (!active || mode !== 'apply' || rootInstanceId === null || loadState.kind !== 'ready') return;
    const request = previewRequestKey(rootInstanceId, choice, checked);
    if (checked.size === 0) { setPreview({ effects: [], conflicts: [], skipped: [], files: [], fingerprint: '', request }); return; }
    let cancelled = false;
    // Debounced: a run of checkbox clicks asks once. A result for an older selection is dropped here, and the Apply
    // button waits for one of THIS selection (`applyBlocked`).
    const timer = setTimeout(() => {
      previewApply(rootInstanceId, new Set(checked), toApplyTargets(choice, checked))
        .then((p) => { if (!cancelled) setPreview({ ...p, request }); })
        .catch((err: unknown) => {
          if (!cancelled) setPreview({ refused: String((err as Error)?.message ?? err), effects: [], conflicts: [], skipped: [], files: [], fingerprint: '', request });
        });
    }, 120);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [active, mode, rootInstanceId, loadState.kind, checked, choice, previewEpoch, worldKey]);

  const totals = useMemo(() => {
    if (loadState.kind !== 'ready') return { total: 0, checked: 0 };
    let total = 0;
    let checkedCount = 0;
    const tally = (key: string) => { total++; if (checked.has(key)) checkedCount++; };
    for (const e of loadState.entities) for (const t of e.traits) for (const f of t.fields) tally(f.key);
    for (const t of loadState.addedTags) tally(t.key);
    for (const node of loadState.structural.added) tally(addedKey(node.guid));
    for (const r of loadState.structural.removedEntities) tally(r.key);
    for (const r of loadState.structural.removedTraits) tally(r.key);
    for (const r of loadState.structural.moved) tally(r.key);
    for (const k of loadState.nested) tally(k);
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
      await runOnPinnedSubject({
        subject, lookup: findEntity, world: getCurrentWorld(), mode, onGone: closeAsGone,
        act: async (liveId) => {
          // Applies the selected overrides to the prefab AND pushes one undo entry.
          // (Promotion-driven scene re-save now happens inside applyToPrefabWithUndo.)
          // The Apply commits a FRESH plan of the checked keys; handed the fingerprint of what the rows show, it refuses
          // a plan that would do something else (#1736) — the dialog then re-reads and shows it rather than closing.
          const result = await applyToPrefabWithUndo(liveId, checked, toApplyTargets(choice, checked), { expect: preview?.fingerprint ?? '' });
          const notice = applyOutcomeNotice(result);
          if (notice) useEditorStore.getState().showToast(notice, 'warn');
          // Re-read, with the old preview dropped: it has the same request, and would let a second click send its stale
          // fingerprint before the new one lands.
          if (staysOpen(result)) { setPreview(null); setPreviewEpoch((e) => e + 1); return; }
          closeDialog();
        },
      });
    } finally {
      setApplying(false);
    }
  };

  const handleRevert = async () => {
    if (rootInstanceId === null || checked.size === 0 || applying) return;
    setApplying(true);
    try {
      await runOnPinnedSubject({
        subject, lookup: findEntity, world: getCurrentWorld(), mode, onGone: closeAsGone,
        act: async (liveId) => {
          // Revert's own refusal is a bare null (#1483, #1862); say why here, as Apply's notice does.
          const refusal = await revertRefusal(liveId);
          if (refusal) { useEditorStore.getState().showToast(`Revert: nothing was reverted — ${refusal}`, 'warn'); return; }
          await revertOverridesWithUndo(liveId, checked);
          closeDialog();
        },
      });
    } finally {
      setApplying(false);
    }
  };

  const baseRow: React.CSSProperties = { display: 'flex', alignItems: 'center', minHeight: 22, fontFamily: 'monospace', fontSize: 12 };

  /** A row's target (#1693): what applying it does at the chosen prefab — a picker when there is more than one — and,
   *  under it, the enclosing overrides that choice also reverts (U13). Null in Revert, and for a key with no target. */
  const targetCell = (key: string, indent: number): React.ReactElement | null => {
    const o = mode === 'apply' ? chosenOption(choice, targetOpts, key) : undefined;
    if (!o) return null;
    // The plan's effect for a CHECKED row (#1736); an unchecked row writes nothing, so it names only where it would go.
    const view = checked.has(key) ? rowView(preview, key) : null;
    const tone = view?.tone === 'conflict' ? '#e0605a' : view?.tone === 'notApplied' ? '#c9a44a' : '#9ab';
    return (
      <div style={{ paddingLeft: indent, fontSize: 11, marginBottom: 2 }}>
        {hasChoice(targetOpts, key) && (
          <select
            value={o.target}
            onChange={(e) => setChoice((c) => setTarget(c, targetOpts, key, e.target.value))}
            data-ui-id={`prefab.dialog.target.${key}`} data-ui-kind="select" data-ui-label={`target of ${key}`}
            style={{ background: '#22223a', color: '#ddd', border: '1px solid #444', fontFamily: 'monospace', fontSize: 11, marginRight: 6 }}
          >
            {targetOpts.get(key)!.options.map((t) => <option key={t.target} value={t.target}>{t.name}</option>)}
          </select>
        )}
        {view
          ? <span style={{ color: tone }} data-ui-id={`prefab.dialog.effect.${key}`}>{view.label}</span>
          : <span style={{ color: '#667' }}>→ Prefab '{o.name}'{checked.has(key) ? '' : ' (not applied)'}</span>}
        {view?.reverts.map((r) => <div key={r} style={{ color: '#c9a44a' }}>{r}</div>)}
        {view?.note && <div style={{ color: '#c9a44a' }}>{view.note}</div>}
      </div>
    );
  };
  const chainTargets = (() => {
    const seen = new Map<string, string>();
    for (const t of targetOpts.values()) for (const o of t.options) if (!seen.has(o.target)) seen.set(o.target, o.name);
    return [...seen];
  })();
  const writesFooter = mode === 'apply' ? filesWritten(preview) : [];
  const blocked = mode === 'apply' && checked.size > 0 ? applyBlocked(preview, previewRequestKey(rootInstanceId, choice, checked)) : null;

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
          <TriCheckbox state={entityState} onChange={(next) => toggleMany(entityKeys, next)}
            dataUiId={`prefab.dialog.entity.${e.localId}`} dataUiLabel={e.name} />
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
                <TriCheckbox state={traitState} onChange={(next) => toggleMany(traitKeys, next)}
                  dataUiId={`prefab.dialog.entity.${e.localId}.trait.${t.trait}`} dataUiLabel={t.trait} />
                <span style={{ color: '#5dade2' }}>{t.trait}</span>
              </div>
              {!traitCollapsed && t.fields.map((f) => (
                <div key={f.key} style={{ ...baseRow, paddingLeft: 64 + d * INDENT }}>
                  <TriCheckbox
                    state={checked.has(f.key) ? 'on' : 'off'}
                    onChange={(next) => toggleKey(f.key, next)}
                    dataUiId={`prefab.dialog.item.${f.key}`} dataUiLabel={f.field}
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
              )).flatMap((row, i) => [row, <div key={`${t.fields[i]!.key}:target`}>{targetCell(t.fields[i]!.key, 84 + d * INDENT)}</div>])}
            </div>
          );
        })}
        {!entityCollapsed && fnode.children.map((child) => renderEntityNode(child))}
      </div>
    );
  };

  return (
    <ModalShell kind={`prefab-${mode}`}>
      <div style={{
        background: '#1e1e30', border: '1px solid #555', borderRadius: 6,
        padding: '16px 20px', width: 540, maxHeight: '80vh', display: 'flex', flexDirection: 'column',
        fontFamily: 'monospace',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <span style={{ color: '#fff', fontSize: 13, fontWeight: 'bold' }}>{title}</span>
          <span style={{ color: '#888', fontSize: 11 }}>{totals.checked} / {totals.total} selected</span>
        </div>
        {mode === 'apply' && chainTargets.length > 1 && (
          <div style={{ color: '#aaa', fontSize: 11, marginBottom: 8 }}>
            Apply all to{' '}
            <select
              value=""
              onChange={(e) => { if (e.target.value) setChoice((c) => setAllTargets(c, targetOpts, targetOpts.keys(), e.target.value)); }}
              data-ui-id="prefab.dialog.target.all" data-ui-kind="select" data-ui-label="apply all to"
              style={{ background: '#22223a', color: '#ddd', border: '1px solid #444', fontFamily: 'monospace', fontSize: 11 }}
            >
              <option value="">—</option>
              {chainTargets.map(([target, name]) => <option key={target} value={target}>Prefab '{name}'</option>)}
            </select>
            <span style={{ color: '#666', marginLeft: 6 }}>(each row that can go there)</span>
          </div>
        )}

        <div style={{ flex: 1, overflowY: 'auto', border: '1px solid #333', borderRadius: 4, padding: 8, background: '#15151f' }}>
          {loadState.kind === 'loading' && (
            <div style={{ color: '#888', fontSize: 12, padding: 8 }}>Loading overrides…</div>
          )}
          {loadState.kind === 'error' && (
            <div style={{ color: '#e74c3c', fontSize: 12, padding: 8 }}>{loadState.message}</div>
          )}
          {loadState.kind === 'ready' && loadState.entities.length === 0
            && loadState.addedTags.length === 0
            && loadState.structural.added.length === 0
            && loadState.structural.removedEntities.length === 0
            && loadState.structural.removedTraits.length === 0
            && loadState.structural.moved.length === 0
            && loadState.nested.length === 0 && (
            <div style={{ color: '#888', fontSize: 12, padding: 8 }}>{emptyMsg}</div>
          )}
          {loadState.kind === 'ready'
            && buildOverrideForest(loadState.entities).map((fnode) => renderEntityNode(fnode))}

          {loadState.kind === 'ready' && loadState.structural.added.map((node) => {
            const key = addedKey(node.guid);
            return (
              <div key={key} style={{ marginBottom: 4 }}>
                <div style={{ ...baseRow, paddingLeft: 4 }}>
                  <span style={{ width: 14 }} />
                  <TriCheckbox
                    state={checked.has(key) ? 'on' : 'off'}
                    onChange={(next) => toggleKey(key, next)}
                    dataUiId={`prefab.dialog.item.${key}`} dataUiLabel={node.name || '(unnamed)'}
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
                // A label of its own: without one `labelFor` falls back to `title`, and every row
                // in this list shares the same title, so a label aim could not tell them apart. (Two
                // removed children sharing a NAME still collide — aim those by id.)
                dataUiId={`prefab.dialog.item.${r.key}`} dataUiLabel={r.name}
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
          )).flatMap((row, i) => [row, <div key={`${loadState.structural.removedEntities[i]!.key}:target`}>{targetCell(loadState.structural.removedEntities[i]!.key, 40)}</div>])}

          {loadState.kind === 'ready' && loadState.structural.removedTraits.map((r) => (
            <div key={r.key} style={{ ...baseRow, paddingLeft: 4, marginBottom: 2 }}>
              <span style={{ width: 14 }} />
              <TriCheckbox
                state={checked.has(r.key) ? 'on' : 'off'}
                onChange={(next) => toggleKey(r.key, next)}
                dataUiId={`prefab.dialog.item.${r.key}`} dataUiLabel={`${r.trait} on ${r.entityName}`}
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
          )).flatMap((row, i) => [row, <div key={`${loadState.structural.removedTraits[i]!.key}:target`}>{targetCell(loadState.structural.removedTraits[i]!.key, 40)}</div>])}

          {loadState.kind === 'ready' && loadState.addedTags.map((r) => (
            <div key={r.key} style={{ ...baseRow, paddingLeft: 4, marginBottom: 2 }}>
              <span style={{ width: 14 }} />
              <TriCheckbox
                state={checked.has(r.key) ? 'on' : 'off'}
                onChange={(next) => toggleKey(r.key, next)}
                dataUiId={`prefab.dialog.item.${r.key}`} dataUiLabel={`${r.tag} on ${r.entityName}`}
                title={isRevert
                  ? 'Remove this tag from the instance'
                  : 'Add this tag to the prefab base — affects all instances'}
              />
              {isRevert
                ? <span style={{ color: '#e74c3c' }}>− remove&nbsp;</span>
                : <span style={{ color: '#2ecc71' }}>+ added&nbsp;</span>}
              <span style={{ color: '#5dade2' }}>{r.tag}</span>
              <span style={{ color: '#888', margin: '0 6px' }}>on</span>
              <span style={{ color: '#ddd' }}>{r.entityName}</span>
              <span style={{ color: '#555', marginLeft: 8, fontSize: 10 }}>localId {r.localId} · tag</span>
            </div>
          )).flatMap((row, i) => [row, <div key={`${loadState.addedTags[i]!.key}:target`}>{targetCell(loadState.addedTags[i]!.key, 40)}</div>])}

          {loadState.kind === 'ready' && loadState.structural.moved.map((r) => (
            <div key={r.key} style={{ ...baseRow, paddingLeft: 4, marginBottom: 2 }}>
              <span style={{ width: 14 }} />
              <TriCheckbox
                state={checked.has(r.key) ? 'on' : 'off'}
                onChange={(next) => toggleKey(r.key, next)}
                dataUiId={`prefab.dialog.item.${r.key}`} dataUiLabel={`${r.name} moved`}
                title={isRevert
                  ? 'Put this entity back under its prefab parent'
                  : 'Move this entity in the prefab base, with its current position under the new parent — affects all instances'}
              />
              {isRevert
                ? <span style={{ color: '#2ecc71' }}>↩ move back&nbsp;</span>
                : <span style={{ color: '#f39c12' }}>↪ moved&nbsp;</span>}
              <span style={{ color: '#ddd', fontWeight: 'bold' }}>{r.name}</span>
              <span style={{ color: '#888', margin: '0 6px' }}>under</span>
              <span style={{ color: '#ddd' }}>{r.parentName}</span>
              <span style={{ color: '#555', marginLeft: 8, fontSize: 10 }}>localId {r.localId}{isRevert ? '' : ' · affects all instances'}</span>
            </div>
          ))}
          {loadState.kind === 'ready' && loadState.nested.length > 0 && (
            <div style={{ color: '#888', fontSize: 11, margin: '8px 0 2px' }}>Inside nested instances</div>
          )}
          {loadState.kind === 'ready' && loadState.nested.map((k) => (
            <div key={k} style={{ ...baseRow, paddingLeft: 4, marginBottom: 2, alignItems: 'flex-start' }}>
              <span style={{ width: 14 }} />
              <TriCheckbox
                state={checked.has(k) ? 'on' : 'off'}
                onChange={(next) => toggleKey(k, next)}
                dataUiId={`prefab.dialog.item.${k}`} dataUiLabel={rowView(preview, k)?.label ?? k}
              />
              {targetCell(k, 0)}
            </div>
          ))}
        </div>

        {writesFooter.length > 0 && (
          <div data-ui-id="prefab.dialog.writes" style={{ color: '#888', fontSize: 11, marginTop: 8 }}>
            Writes: {writesFooter.join(', ')}
          </div>
        )}
        {blocked && (
          <div data-ui-id="prefab.dialog.blocked" style={{ color: blocked.startsWith('Cannot') ? '#e0605a' : '#888', fontSize: 11, marginTop: 4 }}>{blocked}</div>
        )}
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
            disabled={applying || totals.checked === 0 || loadState.kind !== 'ready' || !!blocked}
            data-ui-id="prefab.dialog.confirm" data-ui-kind="button"
            style={{
              padding: '5px 16px', border: `1px solid ${confirmBorder}`, borderRadius: 3,
              background: confirmBg, color: '#fff', cursor: (applying || totals.checked === 0) ? 'default' : 'pointer',
              fontFamily: 'monospace', fontSize: 11,
              opacity: (applying || totals.checked === 0 || loadState.kind !== 'ready' || blocked) ? 0.5 : 1,
            }}
          >{confirmLabel}</button>
        </div>
      </div>
    </ModalShell>
  );
}
