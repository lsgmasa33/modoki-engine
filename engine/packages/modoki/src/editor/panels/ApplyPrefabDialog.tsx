/** Selective Apply / Revert prefab-overrides dialog.
 *
 *  Walks the live prefab instance, collects every overridden field (per
 *  entity → trait → field) plus the structural diff, and presents a hierarchical
 *  checkbox tree. In `apply` mode the picked overrides become the new prefab
 *  base; in `revert` mode they are reset back to the prefab base on this single
 *  instance (the prefab file is untouched). Same diff tree, opposite direction. */

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useEditorStore } from '../store/editorStore';
import { getPrefabSource, preloadNestedPrefabsForSubtree } from '../scene/prefabCache';
import { missingSourceRefusal } from '../scene/prefabFrames';
import { previewApply, type ApplyPreview } from '../scene/prefabApply';
import { revertRefusal } from '../scene/prefabRevert';
import { applyToPrefabWithUndo } from '../undo/applyPrefabUndo';
import { revertOverridesWithUndo } from '../undo/revertPrefabUndo';
import { removeUnusedOverridesWithUndo } from '../undo/removeUnusedUndo';
import { instanceRemovableUnused, instanceUnusedOverrides } from '../scene/unusedOverrides';
import { getTraitByName } from '../../runtime/core/ecs/traitRegistry';
import { getCurrentWorld } from '../../runtime/core/ecs/world';
import { findEntity } from '../../runtime/core/ecs/entityUtils';
import { livePinnedId } from '../../runtime/core/ecs/entityPin';
import { subjectGoneNotice, subjectGoneReason, runOnPinnedSubject } from './prefabDialogSubject';
import { watchWorldReplaced } from '../scene/worldBoundModal';
import type { AddedEntity } from '../../runtime/loaders/loadSceneFile';
import { buildOverrideForest, type ForestNode } from './prefabOverrideForest';
import { MixedCheckbox } from './assetViews/widgets';
import {
  collectInstanceOverrideListing, listingFor, listingKeys, effectiveDefaults, applyOutcomeNotice,
  type EntityOverrideNode, type InstanceOverrideListing,
} from '../scene/prefabOverrideKeys';
import { ModalShell } from '../components/ModalShell';
import { applyTargetOptions, type KeyTargets } from '../scene/prefabApplyOptions';
import {
  initialTargets, setTarget, setAllTargets, chosenOption, hasChoice, groupToggle, groupState, retargetChecks, filesWritten, toApplyTargets, rowView, applyBlocked,
  applyPress, queuedPress, shownPlan, type KeptPress, previewRequestKey, staysOpen, previewWorldKey, subscribePreviewWorld, type TargetChoice, unusedOverridesLine,
} from './applyDialogModel';

/** The dialog's targets are prefab guids, as is the instance's source: no path to resolve. */
const noResolve = (): undefined => undefined;

// The dialog's tree node is the shared shape exactly — aliased locally so the rest
// of this file (predating the extraction) doesn't need a wholesale rename.
type EntityNode = EntityOverrideNode;

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | ({ kind: 'ready'; source: string } & InstanceOverrideListing);

function stringifyValue(v: unknown): string {
  if (typeof v === 'number') {
    return Number.isInteger(v) ? String(v) : v.toFixed(3);
  }
  if (typeof v === 'string') return JSON.stringify(v);
  if (v === undefined) return '∅';
  return JSON.stringify(v);
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
  // An Apply pressed while the plan was still being worked out (`applyPress`), with what the rows showed, run when the plan
  // lands if it says the same (`queuedPress`). A press dropped because it did not leaves a note, for the selection it was
  // made on.
  const [kept, setKept] = useState<KeptPress | null>(null);
  const [pressNote, setPressNote] = useState<{ text: string; selection: string } | null>(null);
  // #1773: a world change (an edit, an undo, Play/Stop, a pose preview) re-plans the preview too.
  const worldKey = useSyncExternalStore(subscribePreviewWorld, previewWorldKey, previewWorldKey);
  // The unused overrides, read off the record each time the world moves (#2001 S9): Remove Unused and its undo change them
  // with no reload of the listing.
  const unused = useMemo(() => (active && rootInstanceId !== null && loadState.kind === 'ready'
    ? { count: instanceUnusedOverrides(rootInstanceId), removable: instanceRemovableUnused(rootInstanceId) }
    : null), [active, rootInstanceId, loadState.kind, worldKey]);

  /** #868: when the instance root the dialog was opened for no longer exists, the dialog closes with a
   *  notice rather than acting on whatever entity now holds its index (see prefabDialogSubject.ts). */
  const closeAsGone = (notice: string) => {
    // Once per open: the open's own check and the world watcher can both see a world replaced before the dialog bound.
    const now = useEditorStore.getState()[mode === 'apply' ? 'applyPrefabDialog' : 'revertPrefabDialog'];
    if (!now.active || now.subject !== subject) return;
    closeDialog();
    // Logged too (#1936): the toast lasts seconds and no agent reads it, so a closed dialog left no record.
    console.warn(`[Prefab] ${notice}`);
    useEditorStore.getState().showToast(notice, 'warn');
  };

  // #1936: a world replaced under the dialog (a scene load, an outside-change hot reload) closes it, rather than leaving
  // rows for that world up over the new one — blocking Cmd+S, and with a Confirm that could only refuse.
  useEffect(() => {
    if (!active || !subject) return;
    return watchWorldReplaced(subject.world, () => closeAsGone(subjectGoneNotice(mode, 'reloaded')));
  }, [active, subject]);

  useEffect(() => {
    // Nothing from the last session of the dialog carries into this one, so all of it is dropped on the close as well as
    // the open. A kept press, closed while it waited and reopened on the same selection, would apply with no press; the
    // last session's preview was planned on a listing this open reads again (it once read as current after an edit,
    // before the world was part of its key); and its `ready` listing let the preview effect run in the reopen's own
    // commit — an empty last selection is planned synchronously, so the rows came up under a preview with no effect in
    // it, Apply enabled over it, and a press on them could only be refused as changed (measured live).
    setKept(null);
    setPressNote(null);
    setPreview(null);
    setLoadState({ kind: 'loading' });
    if (!active || rootInstanceId === null) return;
    if (livePinnedId(subject, findEntity, getCurrentWorld()) === null) {
      closeAsGone(subjectGoneNotice(mode, subjectGoneReason(subject, getCurrentWorld())));
      return;
    }
    let cancelled = false;
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
        // A frame kept live after its prefab was trashed (#1862): say so, as Apply and Revert themselves do, not the bare guid.
        if (!cancelled) setLoadState({ kind: 'error', message: missingSourceRefusal(rootInstanceId, source, mode) });
        return;
      }
      // The listing's `ownInstanceStructure` -> `captureInstanceStructure` -> `captureNestedRef` reads nested
      // children from the editor cache SYNCHRONOUSLY. The fetch above warms only the OUTER
      // prefab, so on a cold cache a nested instance the author dragged in by hand is dropped
      // from `added[]` and is simply MISSING from this dialog — unpromotable, with only a
      // console.warn (#1284).
      await preloadNestedPrefabsForSubtree(rootInstanceId);
      if (cancelled) return;
      // The ONE listing the agent op reads too (#1671), cut to what this mode can act on: Apply leaves out the fields it
      // cannot write (#1661) and takes the nested instances' own edits (U14, #1693); Revert the reverse.
      const listing = listingFor(collectInstanceOverrideListing(rootInstanceId, prefab), mode);
      if (cancelled) return;
      const allKeys = listingKeys(listing);
      const opts = mode === 'apply' ? applyTargetOptions(rootInstanceId, prefab, allKeys) : new Map<string, KeyTargets>();
      const choice0 = initialTargets(opts);
      // Checked to start is the dialog's Apply All / Revert All, which leaves the root's default overrides alone at their
      // default target (#1831, Unity): listed, unchecked, each applied or reverted only by its own checkbox.
      const leave = effectiveDefaults(listing.defaultOverrides, choice0, source, noResolve);
      setChecked(new Set(allKeys.filter((k) => !leave.has(k))));
      setTargetOpts(opts);
      setChoice(choice0);
      setCollapsed(new Set());
      setLoadState({ kind: 'ready', source, ...listing });
    })();
    return () => { cancelled = true; };
  }, [active, subject]);

  useEffect(() => {
    if (!active || mode !== 'apply' || rootInstanceId === null || loadState.kind !== 'ready') return;
    const request = previewRequestKey(rootInstanceId, choice, checked, worldKey);
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
    const keys = listingKeys(loadState);
    return { total: keys.length, checked: keys.filter((k) => checked.has(k)).length };
  }, [loadState, checked]);

  const toggleKey = (key: string, next: 'on' | 'off') => {
    setChecked((prev) => {
      const out = new Set(prev);
      if (next === 'on') out.add(key); else out.delete(key);
      return out;
    });
  };
  /** A target change, from a row's picker or "Apply all to …": the new choice, and the default overrides it turns into
   *  ordinary overrides (checked) or back into default overrides (unchecked); every other check stays (#1831). */
  const retarget = (next: TargetChoice) => {
    if (loadState.kind === 'ready') setChecked((c) => retargetChecks(c, loadState.defaultOverrides, choice, next, loadState.source, noResolve));
    setChoice(next);
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

  // The world is part of the request (#1773's `previewWorldKey`): a preview planned before an edit is stale, not current.
  const currentSelection = previewRequestKey(rootInstanceId, choice, checked);
  const currentRequest = previewRequestKey(rootInstanceId, choice, checked, worldKey);
  const press = mode === 'apply' && checked.size > 0 ? applyPress(preview, currentRequest, checked, choice) : 'apply';
  const pressApply = () => {
    setPressNote(null);
    if (press === 'wait') setKept({ selection: currentSelection, keys: [...checked], shown: shownPlan(preview, checked) });
    else void handleApply();
  };
  // Every render: the kept press runs on the preview it waited for, with this render's handleApply.
  useEffect(() => {
    const next = queuedPress(kept, preview, currentRequest, currentSelection);
    if (next === null || next === 'wait') return;
    setKept(null);
    if (next === 'apply') void handleApply();
    if (next === 'changed') {
      setPressNote({ text: 'Not applied: what this Apply does changed after you pressed it. Check the rows, then press Apply again.', selection: currentSelection });
    }
  });

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

  /** Remove Unused (#2001 S9; Unity's Remove Unused Overrides): the removable unused records come off the list, one undo
   *  step. The dialog stays open: nothing it lists changes. */
  const handleRemoveUnused = async () => {
    if (rootInstanceId === null || applying) return;
    setApplying(true);
    try {
      await runOnPinnedSubject({
        subject, lookup: findEntity, world: getCurrentWorld(), mode, onGone: closeAsGone,
        act: (liveId) => {
          const out = removeUnusedOverridesWithUndo(liveId);
          if ('refused' in out) useEditorStore.getState().showToast(`Remove Unused: nothing was removed — ${out.refused}`, 'warn');
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
            onChange={(e) => retarget(setTarget(choice, targetOpts, key, e.target.value))}
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
  const blocked = mode === 'apply' && checked.size > 0 ? applyBlocked(preview, currentRequest) : null;
  const note = pressNote?.selection === currentSelection ? pressNote.text : null;

  const isRevert = mode === 'revert';
  const title = isRevert ? 'Revert Overrides' : 'Apply to Prefab';
  const emptyMsg = isRevert ? 'No overrides to revert on this instance.' : 'No overrides to apply on this instance.';
  const confirmLabel = applying || kept !== null ? (isRevert ? 'Reverting…' : 'Applying…') : (isRevert ? 'Revert' : 'Apply');
  const onConfirm = isRevert ? handleRevert : pressApply;
  const confirmBg = isRevert ? '#6a3a2d' : '#2d4a6a';
  const confirmBorder = isRevert ? '#7a4a3a' : '#3a4a5a';

  // Render one override-entity node and its nested children (indented by depth),
  // so a child entity sits under its parent instead of as a flat sibling.
  // Collapsing an entity hides its traits AND its descendant subtree.
  const INDENT = 16;

  if (!active) return null;
  // The root's default overrides AT their current targets (#1831): what the checkboxes, their states and the badge read.
  const unusedLine = unused ? unusedOverridesLine(unused.count, unused.removable) : null;
  const defaultOverrides = loadState.kind === 'ready' ? effectiveDefaults(loadState.defaultOverrides, choice, loadState.source, noResolve) : new Set<string>();
  const renderEntityNode = (fnode: ForestNode<EntityNode>): React.ReactElement => {
    const e = fnode.node;
    const d = fnode.depth;
    const entityKeys = e.traits.flatMap((t) => t.fields.map((f) => f.key));
    const entityState = groupState(checked, entityKeys, defaultOverrides);
    const entityCollapsed = collapsed.has(`e:${e.localId}`);
    return (
      <div key={e.localId} style={{ marginBottom: 4 }}>
        <div style={{ ...baseRow, paddingLeft: 4 + d * INDENT }}>
          <span
            onClick={() => toggleCollapsed(`e:${e.localId}`)}
            style={{ cursor: 'pointer', color: '#888', width: 14, userSelect: 'none' }}
          >{entityCollapsed ? '▸' : '▾'}</span>
          <TriCheckbox state={entityState} onChange={(next) => setChecked((c) => groupToggle(c, entityKeys, defaultOverrides, next))}
            dataUiId={`prefab.dialog.entity.${e.localId}`} dataUiLabel={e.name} />
          <span style={{ color: '#ddd', fontWeight: 'bold' }}>{e.name}</span>
          <span style={{ color: '#555', marginLeft: 8, fontSize: 10 }}>localId {e.localId}</span>
        </div>
        {!entityCollapsed && e.traits.map((t) => {
          const traitKeys = t.fields.map((f) => f.key);
          const traitState = groupState(checked, traitKeys, defaultOverrides);
          const traitCollapsed = collapsed.has(`e:${e.localId}:t:${t.trait}`);
          return (
            <div key={t.trait}>
              <div style={{ ...baseRow, paddingLeft: 26 + d * INDENT }}>
                <span
                  onClick={() => toggleCollapsed(`e:${e.localId}:t:${t.trait}`)}
                  style={{ cursor: 'pointer', color: '#888', width: 14, userSelect: 'none' }}
                >{traitCollapsed ? '▸' : '▾'}</span>
                <TriCheckbox state={traitState} onChange={(next) => setChecked((c) => groupToggle(c, traitKeys, defaultOverrides, next))}
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
                  {defaultOverrides.has(f.key) && (
                    <span title="A default override (as in Unity): Apply All and Revert All leave it. Check it here to apply or revert it."
                      style={{ color: '#888', fontSize: 10, marginRight: 6 }}>default</span>
                  )}
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
              onChange={(e) => {
                if (!e.target.value || loadState.kind !== 'ready') return;
                retarget(setAllTargets(choice, targetOpts, targetOpts.keys(), e.target.value));
              }}
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
          {loadState.kind === 'ready' && listingKeys(loadState).length === 0 && loadState.unaddressableAdded === 0 && (
            <div style={{ color: '#888', fontSize: 12, padding: 8 }}>{emptyMsg}</div>
          )}
          {loadState.kind === 'ready'
            && buildOverrideForest(loadState.entities).map((fnode) => renderEntityNode(fnode))}

          {unusedLine !== null && (
            // #1914 F6: neither Apply nor Revert touches them; Remove Unused takes the removable ones (#2001 S9).
            <div data-ui-id="prefab.dialog.unusedRow" style={{ color: '#888', fontSize: 11, padding: '2px 4px 6px', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span data-ui-id="prefab.dialog.unused">{unusedLine}</span>
              {unused!.removable > 0 && (
                <button
                  data-ui-id="prefab.dialog.removeUnused"
                  disabled={applying}
                  onClick={() => void handleRemoveUnused()}
                  title="Remove the overrides whose target the prefab no longer has (a member or component it removed, or a field its component no longer declares). Undoable. Overrides on a component this build does not register stay."
                  style={{ background: '#333', color: '#ccc', border: '1px solid #555', borderRadius: 3, fontSize: 11, padding: '1px 8px', cursor: applying ? 'default' : 'pointer' }}
                >
                  Remove Unused
                </button>
              )}
            </div>
          )}
          {loadState.kind === 'ready' && loadState.unaddressableAdded > 0 && (
            <div style={{ color: '#888', fontSize: 11, padding: '2px 4px 6px' }}>
              {loadState.unaddressableAdded} added {loadState.unaddressableAdded === 1 ? 'entity is' : 'entities are'} not listed: {loadState.unaddressableAdded === 1 ? 'it has' : 'they have'} no id until the scene is saved.
            </div>
          )}
          {loadState.kind === 'ready' && loadState.added.map(({ node, key }) => {
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

          {loadState.kind === 'ready' && loadState.removedEntities.map((r) => (
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
          )).flatMap((row, i) => [row, <div key={`${loadState.removedEntities[i]!.key}:target`}>{targetCell(loadState.removedEntities[i]!.key, 40)}</div>])}

          {loadState.kind === 'ready' && loadState.removedTraits.map((r) => (
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
          )).flatMap((row, i) => [row, <div key={`${loadState.removedTraits[i]!.key}:target`}>{targetCell(loadState.removedTraits[i]!.key, 40)}</div>])}

          {loadState.kind === 'ready' && loadState.addedTags.map((r) => (
            <div key={r.key} style={{ ...baseRow, paddingLeft: 4, marginBottom: 2 }}>
              <span style={{ width: 14 }} />
              <TriCheckbox
                state={checked.has(r.key) ? 'on' : 'off'}
                onChange={(next) => toggleKey(r.key, next)}
                dataUiId={`prefab.dialog.item.${r.key}`} dataUiLabel={`${r.tag} on ${r.entityName}`}
                title={isRevert
                  ? `Remove this ${r.fields ? 'component' : 'tag'} from the instance`
                  : `Add this ${r.fields ? 'component' : 'tag'} to the prefab base — affects all instances`}
              />
              {isRevert
                ? <span style={{ color: '#e74c3c' }}>− remove&nbsp;</span>
                : <span style={{ color: '#2ecc71' }}>+ added&nbsp;</span>}
              <span style={{ color: '#5dade2' }}>{r.tag}</span>
              <span style={{ color: '#888', margin: '0 6px' }}>on</span>
              <span style={{ color: '#ddd' }}>{r.entityName}</span>
              {/* An added COMPONENT rides this row too (#1663), as one row. */}
              <span style={{ color: '#555', marginLeft: 8, fontSize: 10 }}>localId {r.localId} · {r.fields ? 'component' : 'tag'}</span>
            </div>
          )).flatMap((row, i) => [row, <div key={`${loadState.addedTags[i]!.key}:target`}>{targetCell(loadState.addedTags[i]!.key, 40)}</div>])}

          {loadState.kind === 'ready' && loadState.moved.map((r) => (
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
        {mode === 'apply' && (
          // The status line's space is kept whether it shows or not, so the buttons under it stay put while a checkbox
          // change re-plans: it came and went, and moved Apply half a line under a press aimed at it.
          <div style={{ minHeight: 15, marginTop: 4 }}>
            {blocked && (
              <div data-ui-id="prefab.dialog.blocked" style={{ color: blocked.startsWith('Cannot') ? '#e0605a' : '#888', fontSize: 11, lineHeight: '15px' }}>{blocked}</div>
            )}
            {!blocked && note && (
              <div data-ui-id="prefab.dialog.pressNote" style={{ color: '#c9a44a', fontSize: 11, lineHeight: '15px' }}>{note}</div>
            )}
          </div>
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
            disabled={applying || kept !== null || totals.checked === 0 || loadState.kind !== 'ready' || press === 'blocked'}
            data-ui-id="prefab.dialog.confirm" data-ui-kind="button"
            style={{
              padding: '5px 16px', border: `1px solid ${confirmBorder}`, borderRadius: 3,
              background: confirmBg, color: '#fff', cursor: (applying || totals.checked === 0) ? 'default' : 'pointer',
              fontFamily: 'monospace', fontSize: 11,
              opacity: (applying || kept !== null || totals.checked === 0 || loadState.kind !== 'ready' || press === 'blocked') ? 0.5 : 1,
            }}
          >{confirmLabel}</button>
        </div>
      </div>
    </ModalShell>
  );
}
