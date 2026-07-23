/** Inspector — auto-generates trait editors from the trait registry */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { backendFetch } from '../backend/editorBackend';
import { readTraitData, readTraitDataFull, findEntity } from '../../runtime/ecs/entityUtils';
import { getCurrentWorld } from '../../runtime/ecs/world';
import { writeTraitFieldWithUndo as writeField, writeTraitFieldMultiWithUndo as writeFieldMulti, writeTraitFieldPerEntityWithUndo as writeFieldPerEntity, removeTraitFromEntitiesWithUndo, deleteEntitiesWithUndo, pasteTraitValuesWithUndo } from '../undo/entityActions';
import { type ContextMenuItem } from '../components/ContextMenu';
import { useTraitClipboard, setTraitClipboard, isTraitCopyable } from './traitClipboard';
import { type TraitMeta, type FieldHint, getTraitByName, getAllTraits } from '../../runtime/ecs/traitRegistry';
import { resolveMeshTemplate } from '../../runtime/loaders/meshTemplateCache';
import { geometryBoxHalfExtents, geometryBoundingRadius } from '../../runtime/systems/meshColliderGeometry';
import { pushAction } from '../undo/undoManager';
import { makePrefabInstantiateAction } from '../undo/prefabInstantiateUndo';
import { getAnimSet } from '../../runtime/loaders/animSetCache';
import { useEditorStore } from '../store/editorStore';
import { getPrefabSource, getCachedPrefabSync, getOverrides } from '../scene/prefab';
import { getEditorViewportCamera } from '../scene/sceneViewBus';
import { instantiatePrefabAsync, setPrefabSource, type PrefabFile } from '../scene/prefab';
import { getModelPostprocessorIds } from '../../runtime/loaders/modelPostprocessorRegistry';
import { isGuid, resolveGuidToPath, getAssetEntry } from '../../runtime/loaders/assetManifest';
import { BufferedTextInput, BufferedNumberInput, inputStyle, readOnlyFieldStyle, MIXED_PLACEHOLDER } from './fields';
import { type TraitEntry, sameTraitResult, readMergedTraits } from './inspectorMerge';
import { AssetRefField } from './AssetRefField';
import { parseClipBank, stringifyClipBank, type ClipBankEntry } from '../../runtime/audio/clipBank';
import { SpriteAnimatorSection } from './SpriteAnimatorSection';
import { AnimatorClipsSection } from './AnimatorClipsSection';
import { FieldLabel, NumberField, DropdownField, ColorField, Section, SubSection, DEFAULT_COLOR, colorToHex } from './assetViews/widgets';
import { defaultForHint, FieldValueWidget, EntityRefField, useWorldDirtyTick } from './inspectorFields';
import { AddComponentPicker } from './AddComponentPicker';
import { UIActionBindingsField } from './UIActionBindingsField';
import { MaterialOverridesField } from './MaterialOverridesField';
import { MeshAssetView } from './assetViews/MeshAssetView';
import { MaterialAssetView } from './assetViews/MaterialAssetView';
import { AnimSetAssetView } from './assetViews/AnimSetAssetView';
import { TextureAssetView } from './assetViews/TextureAssetView';
import { TextureBatchView } from './assetViews/TextureBatchView';
import { MaterialBatchView } from './assetViews/MaterialBatchView';
import { ModelBatchView } from './assetViews/ModelBatchView';
import { SpriteAssetView } from './assetViews/SpriteAssetView';
import { AtlasAssetView } from './assetViews/AtlasAssetView';
import { AudioAssetView } from './assetViews/AudioAssetView';
import { EnvironmentAssetView } from './assetViews/EnvironmentAssetView';
import { FontAssetView } from './assetViews/FontAssetView';
import { ModelAssetView } from './assetViews/ModelAssetView';
import { ShaderAssetView } from './assetViews/ShaderAssetView';
import { openAssetInEditor } from './openAssetInEditor';
import { isSelfPlacementDisabled } from '../uiAuthoring';
import { onEditorDirty } from '../../runtime/ui/uiTreeStore';
import { getUIActionNames } from '../../runtime/ui/actionRegistry';
import { getPhysicsLayerNames } from '../../runtime/systems/physicsLayers';
import { getClipNames, getBoneNames, getNodeMaterials } from '../../runtime/loaders/riggedModelCache';
import { EntityAttributes } from '../../runtime/traits';
import { registerFrameCallback, unregisterFrameCallback, startFrameDriver, stopFrameDriver } from '../../runtime/rendering/frameDriver';
import type { SelectedAsset } from '../store/editorStore';

// Runs after every render callback (PRIORITY_EDITOR_2D = 40) so the live
// re-read below sees this frame's freshly-stepped trait values.
const PRIORITY_INSPECTOR_REFRESH = 50;

// Multi-select trait merge + snapshot diffing live in ./inspectorMerge so the
// pure logic can be unit-tested without the panel's heavy transitive deps.

// Tooltip + inputStyle live in ./fields (shared with AssetRefField); imported above.
// FieldLabel/NumberField/DropdownField/ColorField/colorToHex/Section/SubSection/
// writeMetaOrWarn/DEFAULT_COLOR now live in ./assetViews/widgets (shared with the
// asset inspectors extracted in F2); imported above.

// ── Field Components (generic, reusable) ────────────────
// FieldLabel / NumberField / DropdownField / ColorField / Section / SubSection /
// writeMetaOrWarn moved to ./assetViews/widgets (F2). assetTypeFromPath /
// assetDisplayName / the asset-ref field live in ./AssetRefField.

/** Single source of truth for the trait fields that render as a number + unit
 *  dropdown (UIElement width/height/padding/margin, UIAnchor offsets) — per trait,
 *  value-field → its `*Unit` companion field. Both the "hide the standalone unit
 *  field" list AND the inline value+unit renderer derive from this map so they
 *  can't drift apart by hand (F2 — they used to be two hand-kept lists). */
export const UNIT_FIELD_MAPS: Record<string, Record<string, string>> = {
  UIElement: {
    width: 'widthUnit', height: 'heightUnit',
    paddingTop: 'paddingTopUnit', paddingLeft: 'paddingLeftUnit',
    paddingRight: 'paddingRightUnit', paddingBottom: 'paddingBottomUnit',
    marginTop: 'marginTopUnit', marginRight: 'marginRightUnit',
    marginBottom: 'marginBottomUnit', marginLeft: 'marginLeftUnit',
  },
  UIAnchor: { top: 'topUnit', right: 'rightUnit', bottom: 'bottomUnit', left: 'leftUnit' },
};
// The companion unit fields, per trait, that must be hidden as standalone rows
// (they render inline with their value field). Derived from UNIT_FIELD_MAPS so a
// new value/unit pair only needs to be added in one place.
export const UNIT_COMPANION_FIELDS: Record<string, Set<string>> = Object.fromEntries(
  Object.entries(UNIT_FIELD_MAPS).map(([trait, map]) => [trait, new Set(Object.values(map))]),
);

/** Coerce a raw `<input type="number">` value into a finite sort key. Clearing
 *  the box yields '' → Number('') is NaN; a NaN sort key silently breaks sibling
 *  ordering + drag-to-reorder math, so empty/NaN collapses to 0 (F4). */
export function coerceSortOrder(raw: string): number {
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/** The value the EDITABLE entity-name field must bind to: the RAW stored name,
 *  never a display transform. Binding the editor to a transformed name makes the
 *  field a lossy round-trip (the transformed string commits on the first
 *  keystroke), corrupting the canonical name. Kept as a tiny pure helper so the
 *  raw-binding invariant is unit-testable (F1). */
export function editableEntityName(rawName: unknown): string {
  return (rawName as string) ?? '';
}

// defaultForHint / FieldValueWidget / EntityRefField / useWorldDirtyTick moved to
// ./inspectorFields (shared with UIActionBindingsField, now its own file, F2).
// EntityRefField + UIActionBindingsField are imported above for the trait-section
// render; all are re-exported here for back-compat (tests import them via Inspector).
// DEFAULT_COLOR / colorToHex live in ./assetViews/widgets.
export { DEFAULT_COLOR, colorToHex };
export { defaultForHint, FieldValueWidget, EntityRefField, useWorldDirtyTick, UIActionBindingsField };

/** Mini anchor icon — draws inner rect inside outer parent bounds */
function AnchorIcon({ preset, active, size }: { preset: string; active: boolean; size: number }) {
  const P = 2; // padding inside cell
  const S = size - P * 2; // drawable area
  // Inner rect as fractions of drawable area: [x, y, w, h]
  const layouts: Record<string, [number, number, number, number]> = {
    'top-left':      [0, 0, 0.4, 0.35],
    'top':           [0.3, 0, 0.4, 0.35],
    'top-right':     [0.6, 0, 0.4, 0.35],
    'top-stretch':   [0, 0, 1, 0.35],
    'left':          [0, 0.3, 0.4, 0.4],
    'center':        [0.25, 0.25, 0.5, 0.5],
    'right':         [0.6, 0.3, 0.4, 0.4],
    'h-stretch':     [0, 0.3, 1, 0.4],
    'bottom-left':   [0, 0.65, 0.4, 0.35],
    'bottom':        [0.3, 0.65, 0.4, 0.35],
    'bottom-right':  [0.6, 0.65, 0.4, 0.35],
    'bottom-stretch':[0, 0.65, 1, 0.35],
    'left-stretch':  [0, 0, 0.4, 1],
    'v-stretch':     [0.3, 0, 0.4, 1],
    'right-stretch': [0.6, 0, 0.4, 1],
    'stretch':       [0, 0, 1, 1],
  };
  const [fx, fy, fw, fh] = layouts[preset] || [0.25, 0.25, 0.5, 0.5];
  const ix = P + fx * S, iy = P + fy * S, iw = fw * S, ih = fh * S;
  const borderColor = active ? '#f39c12' : 'rgba(255,255,255,0.2)';
  const fillColor = active ? '#f39c12' : 'rgba(255,255,255,0.25)';
  return (
    <svg width={size} height={size}>
      <rect x={P} y={P} width={S} height={S} fill="none" stroke={borderColor} strokeWidth={1} />
      <rect x={ix} y={iy} width={iw} height={ih} fill={fillColor} stroke={active ? '#fff' : 'none'} strokeWidth={active ? 0.8 : 0} />
    </svg>
  );
}

/** 4x4 anchor preset grid (Unity-style) */
function AnchorPickerField({ value, onChange, mixed = false }: { value: string; onChange: (v: string) => void; mixed?: boolean }) {
  // Mixed multi-select: don't highlight any cell; picking one applies to all.
  if (mixed) value = '';
  const grid: string[][] = [
    ['top-left',    'top',    'top-right',    'top-stretch'],
    ['left',        'center', 'right',        'h-stretch'],
    ['bottom-left', 'bottom', 'bottom-right', 'bottom-stretch'],
    ['left-stretch','v-stretch','right-stretch','stretch'],
  ];
  const colLabels = ['left', 'center', 'right', 'stretch'];
  const rowLabels = ['top', 'middle', 'bottom', 'stretch'];
  const CELL = 36;
  const labelStyle: React.CSSProperties = { color: '#666', fontSize: '9px', textAlign: 'center', userSelect: 'none' };
  return (
    <div style={{ marginBottom: 4 }}>
      <span style={{ color: '#888', fontSize: '11px' }}>anchor{mixed ? ` ${MIXED_PLACEHOLDER}` : ''}</span>
      <div style={{
        marginTop: 3, padding: 4,
        background: '#1a1a2e', border: '1px solid #444',
        borderRadius: 3, display: 'inline-flex', flexDirection: 'column', gap: 2,
      }}>
        {/* Column headers */}
        <div style={{ display: 'flex', gap: 2, marginLeft: 40 }}>
          {colLabels.map(l => <span key={l} style={{ ...labelStyle, width: CELL }}>{l}</span>)}
        </div>
        {/* Grid rows */}
        {grid.map((row, ri) => (
          <div key={ri} style={{ display: 'flex', gap: 2, alignItems: 'center' }}>
            <span style={{ ...labelStyle, width: 38, textAlign: 'right' }}>{rowLabels[ri]}</span>
            {row.map(preset => (
              <div key={preset} onClick={() => onChange(preset)} title={preset}
                style={{ cursor: 'pointer', lineHeight: 0, borderRadius: 2, background: value === preset ? 'rgba(243,156,18,0.15)' : 'transparent' }}>
                <AnchorIcon preset={preset} active={value === preset} size={CELL} />
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

// colorToHex + ColorField moved to ./assetViews/widgets (F2); imported above.
// colorToHex is re-exported (near defaultForHint) for back-compat (tests import it).

function VecField({ label, fields, data, onChange, overriddenKeys, mixedKeys }: {
  label: string;
  fields: { key: string; hint: FieldHint }[];
  data: Record<string, unknown>;
  onChange: (key: string, v: number) => void;
  overriddenKeys?: Set<string>;
  mixedKeys?: Set<string>;
}) {
  // Derive short labels: strip common prefix, use last distinct part
  // e.g. [lookAtX, lookAtY, lookAtZ] → [X, Y, Z], [near, far] → [Near, Far].
  // An explicit hint.label always wins over the derived label.
  const derived = fields.length <= 1
    ? fields.map((f) => f.key)
    : (() => {
        // Find common prefix
        const keys = fields.map((f) => f.key);
        let prefix = '';
        for (let i = 0; i < keys[0].length; i++) {
          const ch = keys[0][i];
          if (keys.every((k) => k[i] === ch)) prefix += ch;
          else break;
        }
        // If prefix covers entire keys, use full keys
        if (keys.some((k) => k.length === prefix.length)) return keys;
        return keys.map((k) => k.slice(prefix.length) || k);
      })();
  const labels = fields.map((f, i) => f.hint.label ?? derived[i]);
  return (
    <div style={{ marginBottom: 3 }}>
      <div style={{ color: '#9aa4b2', fontSize: '9px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 2 }}>{label}</div>
      <div style={{ display: 'inline-flex', gap: 3, width: '100%' }}>
        {fields.map((f, i) => {
          const isOv = overriddenKeys?.has(f.key) || false;
          const isMixed = mixedKeys?.has(f.key) || false;
          const isDeg = f.hint.display === 'degrees';
          const rawVal = data[f.key] as number;
          const displayVal = isDeg ? rawVal * (180 / Math.PI) : rawVal;
          return (
            <div key={f.key} style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 2, minWidth: 0 }}>
              <span style={{ color: isOv ? '#5dade2' : '#666', fontSize: '10px', flexShrink: 0, fontWeight: isOv ? 'bold' : 'normal' }}>{labels[i]}</span>
              <BufferedNumberInput value={parseFloat(displayVal.toFixed(2))} step={f.hint.step || 0.1} mixed={isMixed} readOnly={f.hint.readOnly}
                onChange={(v) => onChange(f.key, isDeg ? v * (Math.PI / 180) : v)}
                min={isDeg ? undefined : f.hint.min} max={isDeg ? undefined : f.hint.max}
                style={{ ...inputStyle, flex: 1, minWidth: 0, color: isOv ? '#5dade2' : '#ddd', fontWeight: isOv ? 'bold' : 'normal', ...(f.hint.readOnly ? readOnlyFieldStyle : null) }} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Section Component ───────────────────────────────────

// Section + SubSection moved to ./assetViews/widgets (F2); imported above.

// ── Prefab source link (used inside PrefabInstance trait section) ──

function PrefabSourceLink({ source }: { source: string }) {
  const selectAsset = useEditorStore((s) => s.selectAsset);
  // `source` is a prefab GUID (resolve via the manifest) or a legacy path.
  // Resolve to a concrete path so the button shows the prefab's name and the
  // Assets-panel selection matches by path. Falls back to the raw source if the
  // guid is unknown, so the link is never silently dropped.
  const path = (isGuid(source) ? resolveGuidToPath(source) : source) || source;
  const displayName = path.split('/').pop()?.replace('.prefab.json', '') || path;
  return (
    <button
      onClick={() => {
        selectAsset({ path, type: 'prefab', name: displayName });
      }}
      style={{
        padding: '2px 8px', border: '1px solid #3498db', borderRadius: 3,
        background: '#1e2a3a', color: '#3498db', cursor: 'pointer',
        fontSize: '11px', fontFamily: 'monospace',
      }}
      title={isGuid(source) ? `Select prefab in Assets\nGUID: ${source}${path !== source ? `\nPath: ${path}` : ''}` : 'Select prefab in Assets'}
    >
      {displayName}
    </button>
  );
}

// ── Director-only: open its timeline in the Timeline panel, bound to THIS director ──

function DirectorTimelineButton({ timeline, entityId }: { timeline: string; entityId: number }) {
  const path = timeline ? ((isGuid(timeline) ? resolveGuidToPath(timeline) : timeline) || '') : '';
  const name = path.split('/').pop() || 'timeline';
  if (!path) {
    return <div style={{ fontSize: 11, color: '#8a8a96', padding: '4px 0' }}>Assign a <code>.timeline.json</code> above to open it in the Timeline panel.</div>;
  }
  return (
    <button
      data-ui-id="director.open-timeline"
      onClick={() => useEditorStore.getState().openTimelineEditor({ path, type: 'timeline', name }, entityId)}
      style={{
        padding: '3px 10px', border: '1px solid #b0553f', borderRadius: 3,
        background: '#2a1e1a', color: '#e0a080', cursor: 'pointer', fontSize: 11, marginTop: 4,
      }}
      title={`Open ${name} in the Timeline panel, bound to this Director`}
    >
      ▷ Open timeline
    </button>
  );
}

// ── Auto-generated trait section from registry metadata ──

/** GUID → entity id (mirrors applyBindings' resolution). */
function guidToEntityId(guid: string): number | undefined {
  if (!guid) return undefined;
  let found: number | undefined;
  getCurrentWorld().query(EntityAttributes).updateEach(([ea]: [{ guid: string }], e: { id: () => number }) => {
    if (ea.guid === guid) found = e.id();
  });
  return found;
}

/** Resolve a field's dynamic enum options at Inspector render time. Per-entity
 *  sources read the entity's own traits to list the right values for THIS model:
 *  `animationClips` from the entity's SkinnedModel GLB; `skeletonBones` from the
 *  model the entity's BoneAttachment.target points at. */
function resolveDynamicOptions(source: FieldHint['optionsSource'], entityId: number): string[] {
  if (source === 'uiActions') return getUIActionNames();
  if (source === 'physicsLayers') return getPhysicsLayerNames();
  if (source === 'animationClips') {
    const sm = getTraitByName('SkinnedModel');
    const model = sm ? (readTraitData(entityId, sm)?.model as string | undefined) : undefined;
    const names = new Set<string>(model ? getClipNames(model) : []);
    // P6: also offer clips from the entity's AnimationLibrary (each animset's
    // `source` GLB). A bare rig (no own clips) plays ONLY library clips, so this
    // is what makes them pickable here. `animSets` isn't in meta.fields (custom
    // section), so read the raw AoS trait directly.
    const alMeta = getTraitByName('AnimationLibrary');
    const alData = alMeta ? (findEntity(entityId)?.get(alMeta.trait) as { animSets?: string[] } | undefined) : undefined;
    if (Array.isArray(alData?.animSets)) {
      for (const ref of alData!.animSets) {
        const src = getAnimSet(ref)?.source;
        if (src) for (const n of getClipNames(src)) names.add(n);
      }
    }
    // Also offer clips from the SkeletalAnimator's OWN animSet — assigning an animSet
    // there brings its source GLB's clips into a bare rig (mirrors the engine merge).
    // Union the source GLB clips (if loaded) with the animset's declared clip names
    // (always available, so the dropdown isn't empty before the source GLB loads).
    const saMeta = getTraitByName('SkeletalAnimator');
    const animSetRef = saMeta ? (readTraitData(entityId, saMeta)?.animSet as string | undefined) : undefined;
    if (animSetRef) {
      const set = getAnimSet(animSetRef);
      if (set?.source) for (const n of getClipNames(set.source)) names.add(n);
      for (const c of set?.clips ?? []) if (c?.name) names.add(c.name);
    }
    return [...names];
  }
  if (source === 'skeletonBones') {
    const ba = getTraitByName('BoneAttachment');
    const target = ba ? (readTraitData(entityId, ba)?.target as string | undefined) : undefined;
    const targetId = target ? guidToEntityId(target) : undefined;
    if (targetId == null) return [];
    const sm = getTraitByName('SkinnedModel');
    const model = sm ? (readTraitData(targetId, sm)?.model as string | undefined) : undefined;
    return model ? getBoneNames(model) : [];
  }
  return [];
}

/** SkinnedMeshRenderer-only: per-material-slot override pickers for ONE mesh node
 *  (Unity's per-renderer material array). The node's material slots come from the
 *  rig model on the PARENT SkinnedModel entity; each gets a `.mat.json` picker
 *  writing into `SkinnedMeshRenderer.materials`. An unset slot keeps the baked GLB
 *  material. Uses writeFieldPerEntity so each selected entity's OTHER slots are
 *  preserved (the map is a composite value). */
function SkinnedMeshRendererMaterials({ entityIds, meta, data }: {
  entityIds: number[]; meta: TraitMeta; data: Record<string, unknown>;
}) {
  const node = data.node as string | undefined;
  const primaryId = entityIds[0];
  // Slots load with the GLB (async). Nudge one re-render if they're not ready;
  // the same tick refreshes after an edit (see overrides note below).
  const [, setTick] = useState(0);
  // Read the LIVE koota `materials` map, not the readTraitData `data`: `materials`
  // isn't in meta.fields (custom section), so readTraitData drops it — without this
  // the pickers always show "unset" even when slots ARE assigned, and don't update
  // on edit (the Inspector's refresh diffs the readTraitData view, which never sees
  // `materials`).
  const live = findEntity(primaryId)?.get(meta.trait) as { materials?: Record<string, string> } | undefined;
  const overrides = live?.materials ?? {};
  // The rig model ref lives on the parent SkinnedModel entity (renderers are its
  // children). Resolve parentId → SkinnedModel.model.
  const eaMeta = getTraitByName('EntityAttributes');
  const parentId = eaMeta ? (readTraitData(primaryId, eaMeta)?.parentId as number | undefined) : undefined;
  const smMeta = getTraitByName('SkinnedModel');
  const model = (parentId && smMeta) ? (readTraitData(parentId, smMeta)?.model as string | undefined) : undefined;
  const slots = (model && node) ? getNodeMaterials(model, node) : [];
  useEffect(() => {
    if (model && node && slots.length === 0) {
      const t = setTimeout(() => setTick((n) => n + 1), 400);
      return () => clearTimeout(t);
    }
  }, [model, node, slots.length]);

  if (!node) return null;
  const setSlot = (slot: string, guid: string) => {
    writeFieldPerEntity(entityIds, meta, 'materials', (old) => {
      const cur = (old as Record<string, string>) ?? {};
      const next = { ...cur };
      if (guid) next[slot] = guid; else delete next[slot];
      return next;
    }, `Edit ${meta.name} material`);
    setTick((n) => n + 1); // refresh: `materials` isn't in the readTraitData view
  };

  return (
    <div style={{ marginTop: 4 }}>
      <div style={{ borderTop: '1px solid #444', margin: '6px 0' }} />
      <div style={{ fontSize: '11px', color: '#888', marginBottom: 4 }}>
        Materials <span style={{ color: '#666' }}>(unset = baked GLB material)</span>
      </div>
      {slots.length === 0 ? (
        <div style={{ fontSize: '11px', color: '#666' }}>Material slots appear once the model loads.</div>
      ) : (
        slots.map((slot) => (
          <AssetRefField
            key={slot}
            label={slot}
            value={overrides[slot] ?? ''}
            onChange={(v) => setSlot(slot, v)}
            accept={['.mat.json']}
          />
        ))
      )}
    </div>
  );
}

/** AnimationLibrary-only: a per-animSet bone-name remap for retargeting a foreign
 *  rig (source bones named differently from THIS model's). Writes
 *  `boneMaps[animSetRef] = { targetBone: sourceBone }` (the shape
 *  `retargetClip.names` wants). Collapsed by default — only needed when the source
 *  rig isn't bone-name identical. Dropdowns populate from THIS model's bones
 *  (target) and the animSet's `source` GLB bones (source) once both GLBs load. */
function BoneMapEditor({ animSetRef, model, map, onChange }: {
  animSetRef: string; model: string | undefined;
  map: Record<string, string>; onChange: (next: Record<string, string>) => void;
}) {
  const [open, setOpen] = useState(Object.keys(map).length > 0);
  const [, setTick] = useState(0);
  const source = getAnimSet(animSetRef)?.source;
  const targetBones = model ? getBoneNames(model) : [];
  const sourceBones = source ? getBoneNames(source) : [];
  // Bone lists load with their GLBs (async) — nudge a re-render until ready.
  useEffect(() => {
    if ((model && targetBones.length === 0) || (source && sourceBones.length === 0)) {
      const t = setTimeout(() => setTick((n) => n + 1), 400);
      return () => clearTimeout(t);
    }
  }, [model, source, targetBones.length, sourceBones.length]);

  const rows = Object.entries(map);
  const remove = (target: string) => { const next = { ...map }; delete next[target]; onChange(next); };
  const setSource = (target: string, src: string) => {
    const next = { ...map };
    if (src) next[target] = src; else delete next[target];
    onChange(next);
  };
  const [addTarget, setAddTarget] = useState('');
  const addRow = (src: string) => {
    if (!addTarget || !src) return;
    onChange({ ...map, [addTarget]: src });
    setAddTarget('');
  };
  const autoMap = () => {
    const srcSet = new Set(sourceBones);
    const next = { ...map };
    for (const tb of targetBones) if (srcSet.has(tb)) next[tb] = tb;
    onChange(next);
  };

  const sel: React.CSSProperties = { background: '#1a1a24', color: '#ccc', border: '1px solid #444', fontSize: '10px', borderRadius: 2, padding: '1px 2px', maxWidth: 110 };
  const unmapped = targetBones.filter((b) => !(b in map));

  return (
    <div style={{ margin: '2px 0 6px 12px' }}>
      <button onClick={() => setOpen((o) => !o)} style={{ background: 'none', border: 'none', color: '#888', fontSize: '10px', cursor: 'pointer', padding: 0 }}>
        {open ? '▾' : '▸'} bone map{rows.length ? ` (${rows.length})` : ''} <span style={{ color: '#666' }}>· retarget foreign rig</span>
      </button>
      {open && (
        <div style={{ marginTop: 2 }}>
          {(!model || !source) ? (
            <div style={{ fontSize: '10px', color: '#666' }}>Needs a SkinnedModel + the animSet's source to load.</div>
          ) : (targetBones.length === 0 || sourceBones.length === 0) ? (
            <div style={{ fontSize: '10px', color: '#666' }}>Bones load with the model…</div>
          ) : (
            <>
              {rows.map(([target, src]) => (
                <div key={target} style={{ display: 'flex', gap: 4, alignItems: 'center', marginBottom: 2 }}>
                  <span style={{ fontSize: '10px', color: '#aaa', minWidth: 70, overflow: 'hidden', textOverflow: 'ellipsis' }} title={target}>{target}</span>
                  <span style={{ color: '#555', fontSize: '10px' }}>←</span>
                  <select value={src} onChange={(e) => setSource(target, e.target.value)} style={sel}>
                    {sourceBones.map((b) => <option key={b} value={b}>{b}</option>)}
                  </select>
                  <button onClick={() => remove(target)} style={{ background: 'none', border: 'none', color: '#a55', cursor: 'pointer', fontSize: '11px' }} title="Remove">✕</button>
                </div>
              ))}
              {unmapped.length > 0 && (
                <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginTop: 2 }}>
                  <select value={addTarget} onChange={(e) => setAddTarget(e.target.value)} style={sel}>
                    <option value="">+ target bone…</option>
                    {unmapped.map((b) => <option key={b} value={b}>{b}</option>)}
                  </select>
                  <span style={{ color: '#555', fontSize: '10px' }}>←</span>
                  <select value="" onChange={(e) => addRow(e.target.value)} disabled={!addTarget} style={{ ...sel, opacity: addTarget ? 1 : 0.4 }}>
                    <option value="">source bone…</option>
                    {sourceBones.map((b) => <option key={b} value={b}>{b}</option>)}
                  </select>
                </div>
              )}
              <button onClick={autoMap} style={{ marginTop: 3, background: '#2a2a38', border: '1px solid #444', color: '#aab', fontSize: '10px', borderRadius: 2, cursor: 'pointer', padding: '1px 5px' }}>
                Auto-map matching names
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** AnimationLibrary-only: the ordered list of `.animset.json` GUIDs whose clips
 *  are merged into this rig (P6 shared cross-model clip library). Each animset's
 *  `source` GLB supplies the actual clips. Renders one asset picker per entry (plus
 *  a per-animSet bone-map editor for retargeting) and an "add" row; writes the whole
 *  `animSets`/`boneMaps` containers via writeFieldPerEntity so a multi-select edit
 *  preserves each entity's own data. */
function AnimationLibraryAnimSets({ entityIds, meta }: {
  entityIds: number[]; meta: TraitMeta;
}) {
  // Read the LIVE koota trait, not the readTraitData `data`: `animSets`/`boneMaps`
  // aren't in meta.fields (custom section), so readTraitData drops them — the trait
  // still carries them at runtime. A local tick forces a re-read after an in-section
  // edit (the Inspector's own refresh diffs the readTraitData view, which never sees
  // these fields, so it would otherwise skip the re-render).
  const [, setTick] = useState(0);
  const bump = () => setTick((t) => t + 1);
  const live = findEntity(entityIds[0])?.get(meta.trait) as { animSets?: string[]; boneMaps?: Record<string, Record<string, string>> } | undefined;
  const animSets = Array.isArray(live?.animSets) ? live!.animSets : [];
  const boneMaps = (live?.boneMaps && typeof live.boneMaps === 'object') ? live.boneMaps : {};
  // The rig model lives on the SAME entity (SkinnedModel) → its bones are the
  // retarget TARGET. (resolveDynamicOptions reads it the same way.)
  const smMeta = getTraitByName('SkinnedModel');
  const model = smMeta ? (readTraitData(entityIds[0], smMeta)?.model as string | undefined) : undefined;

  const setAt = (index: number, guid: string) => {
    writeFieldPerEntity(entityIds, meta, 'animSets', (old) => {
      const cur = Array.isArray(old) ? [...(old as string[])] : [];
      if (!guid) cur.splice(index, 1);   // cleared → drop the row
      else cur[index] = guid;
      return cur;
    }, `Edit ${meta.name} animSets`);
    bump();
  };
  const add = (guid: string) => {
    if (!guid) return;
    writeFieldPerEntity(entityIds, meta, 'animSets', (old) => {
      const cur = Array.isArray(old) ? [...(old as string[])] : [];
      if (cur.includes(guid)) return cur; // no duplicates
      cur.push(guid);
      return cur;
    }, `Add ${meta.name} animSet`);
    bump();
  };
  const setBoneMap = (ref: string, next: Record<string, string>) => {
    writeFieldPerEntity(entityIds, meta, 'boneMaps', (old) => {
      const cur = (old && typeof old === 'object') ? { ...(old as Record<string, Record<string, string>>) } : {};
      if (next && Object.keys(next).length) cur[ref] = next; else delete cur[ref];
      return cur;
    }, `Edit ${meta.name} bone map`);
    bump();
  };

  return (
    <div style={{ marginTop: 4 }}>
      <div style={{ borderTop: '1px solid #444', margin: '6px 0' }} />
      <div style={{ fontSize: '11px', color: '#888', marginBottom: 4 }}>
        Animation sets <span style={{ color: '#666' }}>(clips merged into this rig)</span>
      </div>
      {animSets.map((ref, i) => (
        <div key={i} style={{ marginBottom: 2 }}>
          <AssetRefField
            label={`#${i + 1}`}
            value={ref}
            onChange={(v) => setAt(i, v)}
            accept={['.animset.json']}
          />
          {ref && <BoneMapEditor animSetRef={ref} model={model} map={boneMaps[ref] ?? {}} onChange={(m) => setBoneMap(ref, m)} />}
        </div>
      ))}
      <AssetRefField
        label="+ add"
        value=""
        onChange={add}
        accept={['.animset.json']}
        placeholder="drop a .animset.json"
      />
    </div>
  );
}

/** AudioSource-only: the named clip bank, edited as key + audio-ref rows. The trait
 *  field `clips` is a JSON-STRING scalar (like Collider2D.points) — not in meta.fields
 *  (custom section), so read the LIVE trait + parse it; writes re-stringify. A local
 *  tick forces a re-read after an edit (the Inspector's refresh diffs readTraitData,
 *  which never sees this field). Play sounds by key via audio.setClip/audio.playOneShot. */
function AudioSourceClips({ entityIds, meta }: {
  entityIds: number[]; meta: TraitMeta;
}) {
  const [, setTick] = useState(0);
  const bump = () => setTick((t) => t + 1);
  const live = findEntity(entityIds[0])?.get(meta.trait) as { clips?: string } | undefined;
  const bank = parseClipBank(live?.clips);
  const AUDIO_EXT = ['.mp3', '.m4a', '.aac', '.wav', '.ogg', '.flac'];

  // Edit the parsed bank, then write it back as a JSON string (single scalar field).
  const editBank = (fn: (cur: ClipBankEntry[]) => ClipBankEntry[], label: string) => {
    writeFieldPerEntity(entityIds, meta, 'clips', (old) => stringifyClipBank(fn(parseClipBank(old))), label);
    bump();
  };
  const setKeyAt = (i: number, key: string) => editBank((cur) => { if (cur[i]) cur[i] = { ...cur[i], key }; return cur; }, `Edit ${meta.name} clip key`);
  const setRefAt = (i: number, ref: string) => editBank((cur) => { if (!ref) cur.splice(i, 1); else if (cur[i]) cur[i] = { ...cur[i], ref }; return cur; }, `Edit ${meta.name} clip`);
  const add = (ref: string) => { if (ref) editBank((cur) => [...cur, { key: '', ref }], `Add ${meta.name} clip`); };

  return (
    <div style={{ marginTop: 4 }}>
      <div style={{ borderTop: '1px solid #444', margin: '6px 0' }} />
      <div style={{ fontSize: '11px', color: '#888', marginBottom: 4 }}>
        Clip bank <span style={{ color: '#666' }}>(key → audio; play by key via audio.setClip / audio.playOneShot)</span>
      </div>
      {bank.map((c, i) => (
        <div key={i} style={{ display: 'flex', gap: 4, alignItems: 'center', marginBottom: 2 }}>
          <BufferedTextInput
            value={c.key} onChange={(v) => setKeyAt(i, v)} placeholder="key"
            style={{ ...inputStyle, width: 78, flex: '0 0 auto' }}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <AssetRefField label="" value={c.ref} onChange={(v) => setRefAt(i, v)} accept={AUDIO_EXT} />
          </div>
        </div>
      ))}
      <AssetRefField label="+ add" value="" onChange={add} accept={AUDIO_EXT} placeholder="drop an audio clip" />
    </div>
  );
}

/** Inline note shown atop the Layout section when a UIElement is anchored. */
function AnchorLayoutNote() {
  return (
    <div style={{ background: '#2a2640', border: '1px solid #4a4270', borderRadius: 3, padding: '5px 7px', margin: '2px 0 6px', fontSize: '11px', color: '#b8b0d8', lineHeight: 1.4 }}>
      📌 <b>Anchored</b> — position is controlled by the <b>UIAnchor</b> above.
      Self-placement fields (grow / shrink / align-self, and size on a stretched
      axis) are disabled. <b>Child Layout</b> below stays active — it arranges this
      element's children (Unity LayoutGroup). To use flex placement for this element
      instead, remove the UIAnchor.
    </div>
  );
}

function FilterIgnoredNote({ layer }: { layer: string }) {
  return (
    <div style={{ background: '#2a2640', border: '1px solid #4a4270', borderRadius: 3, padding: '5px 7px', margin: '2px 0 6px', fontSize: '11px', color: '#b8b0d8', lineHeight: 1.4 }}>
      ℹ️ Ignored while <b>Layer</b> is set (<b>{layer}</b>) — collisions come from the
      layer + collision matrix (Project Settings → Physics Layers). Clear the Layer
      above to author these raw bits directly.
    </div>
  );
}

/** CameraFrame-only: the "show framing-box gizmo" toggle. Editor-ONLY display state (a
 *  localStorage-persisted per-frame preference, keyed by the entity's guid), NOT a scene
 *  trait — so it survives reloads without a Cmd+S and never ships to the game. */
function CameraFrameGizmoToggle({ entityIds }: { entityIds: number[] }) {
  const shownSet = useEditorStore((s) => s.cameraGizmoShown);
  const setShown = useEditorStore((s) => s.setCameraGizmoShown);
  // Single-select only (a frame's gizmo is per-entity); read the primary's guid.
  const guid = entityIds.length === 1
    ? (findEntity(entityIds[0])?.get(EntityAttributes)?.guid ?? '')
    : '';
  if (!guid) return null;
  const on = shownSet.has(guid);
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 2px', color: '#bbb', fontSize: '11px', cursor: 'pointer' }}>
      <input type="checkbox" checked={on} onChange={(e) => setShown(guid, e.target.checked)} />
      Show framing gizmo
      <span style={{ color: '#666' }}>(editor-only, sticky)</span>
    </label>
  );
}

/** One renderable row in a trait section: either a single field or a grouped
 *  VecField (Vec2/Vec3). Ordered by declaration; a group is anchored at its
 *  first member's position and carries its members' shared section. */
type SectionItem =
  | { kind: 'field'; key: string; hint: FieldHint }
  | { kind: 'group'; name: string; fields: { key: string; hint: FieldHint }[] };

function TraitSection({ meta, entityIds, data, overrides, mixedFields, onRemove, menuItems }: {
  meta: TraitMeta;
  /** All selected entities this section edits. Single-select is just [id]. */
  entityIds: number[];
  /** Merged trait data — common values, plus a representative value for mixed
   *  fields (the field shows MIXED_PLACEHOLDER instead). */
  data: Record<string, unknown>;
  overrides?: Set<string>;
  /** Fields whose value differs across entityIds (rendered as ----). */
  mixedFields?: Set<string>;
  onRemove?: () => void;
  /** Header ⋮ menu (Copy Component / Paste Component Values). */
  menuItems?: ContextMenuItem[];
}) {
  const primaryId = entityIds[0];
  // Prefab being edited (if any) — used to suppress "Apply to Prefab" on the
  // prefab editing itself (self-application). Reactive so the button updates
  // when entering/leaving prefab-edit mode.
  const editingPrefab = useEditorStore((s) => s.editingPrefab);
  const isOverridden = (field: string) => overrides?.has(`${meta.name}.${field}`) || false;
  const isMixed = (field: string) => mixedFields?.has(field) || false;
  const write = useCallback((field: string, value: unknown) => {
    writeFieldMulti(entityIds, meta, field, value);
  }, [entityIds, meta]);

  // UIElement: gray out flexGrow/flexShrink when entity has UIAnchor (absolute positioning ignores flex-child props)
  // Also track anchor value to disable width/height when anchor stretches along that axis.
  // Multi-select: inspect the primary entity (anchor decoration is cosmetic).
  const [hasAnchor, anchorValue] = meta.name === 'UIElement' ? (() => {
    const allTraits = getAllTraits();
    const anchorMeta = allTraits.find(t => t.name === 'UIAnchor');
    if (!anchorMeta) return [false, ''] as const;
    const entity = findEntity(primaryId);
    if (!entity || !entity.has(anchorMeta.trait)) return [false, ''] as const;
    return [true, (entity.get(anchorMeta.trait) as any).anchor as string] as const;
  })() : [false, ''] as const;

  // A self-placement prop (grow/shrink/align-self) is dead once the element is
  // anchored — see uiAuthoring.SELF_PLACEMENT_PROPS. Container/child-layout
  // props (direction/justify/align/gap) stay live (the Unity LayoutGroup).
  const selfPlacementDisabled = (key: string) => isSelfPlacementDisabled(meta.name, hasAnchor, key);

  // Classify fields into an ordered item stream (single field OR a grouped
  // VecField), split by section. A grouped VecField respects its members'
  // `section` — so a Vec2 like `Shadow offset` renders INSIDE Effects next to its
  // siblings, not pulled to the top. Items keep declaration order within each
  // context, the group anchored at its first member's position. Memoized on
  // `meta` (static per trait) so we don't rebuild on every value edit.
  const { topItems, sections, fieldCount } = useMemo(() => {
    const entries = Object.entries(meta.fields);
    // First pass: collect each group's member fields + its section (from the
    // first member — all members of a group share one section by construction).
    const groupFields = new Map<string, { key: string; hint: FieldHint }[]>();
    const groupSection = new Map<string, string | undefined>();
    for (const [key, hint] of entries) {
      if (hint.group && hint.type === 'number') {
        if (!groupFields.has(hint.group)) { groupFields.set(hint.group, []); groupSection.set(hint.group, hint.section); }
        groupFields.get(hint.group)!.push({ key, hint });
      }
    }
    const top: SectionItem[] = [];
    const s = new Map<string, { items: SectionItem[]; defaultOpen: boolean; divider: boolean }>();
    const ensureSection = (name: string, hint: FieldHint) => {
      if (!s.has(name)) s.set(name, { items: [], defaultOpen: hint.sectionDefaultOpen !== false, divider: hint.sectionDivider === true });
      return s.get(name)!;
    };
    const emitted = new Set<string>();
    for (const [key, hint] of entries) {
      // Only NUMBER fields group into a VecField (it renders numeric inputs + calls
      // toFixed). A non-number field with an accidental `group` falls through to a
      // standalone render instead of crashing the whole Inspector.
      if (hint.group && hint.type === 'number') {
        if (emitted.has(hint.group)) continue; // group emitted at its first member
        emitted.add(hint.group);
        const item: SectionItem = { kind: 'group', name: hint.group, fields: groupFields.get(hint.group)! };
        const sec = groupSection.get(hint.group);
        if (sec) ensureSection(sec, hint).items.push(item);
        else top.push(item);
      } else if (hint.section) {
        ensureSection(hint.section, hint).items.push({ kind: 'field', key, hint });
      } else {
        top.push({ kind: 'field', key, hint });
      }
    }
    return { topItems: top, sections: s, fieldCount: entries.length };
  }, [meta]);
  if (fieldCount === 0) return null;

  const isResource = meta.category === 'resource';

  /** Render a single field. Returns null if hidden. */
  const renderField = (key: string, hint: FieldHint) => {
    const val = data[key];
    const ov = isOverridden(key);
    const mx = isMixed(key);
    // showWhen: hide fields based on another field's value
    if (hint.showWhen) {
      const visible = Object.entries(hint.showWhen).every(
        ([depField, allowedValues]) => (allowedValues as string[]).includes(String(data[depField]))
      );
      if (!visible) return null;
    }
    // Hide standalone unit fields (rendered inline with their value field).
    // Derived from UNIT_FIELD_MAPS so this list can't drift from the renderer below.
    if (UNIT_COMPANION_FIELDS[meta.name]?.has(key)) return null;
    // Alpha fields folded into their color picker (rendered as an A slider there)
    // are hidden as standalone rows. Any color field declaring `alphaField: 'x'`
    // claims field 'x' as its alpha (e.g. UIElement.backgroundColor ↔ backgroundOpacity,
    // Renderable2D.color ↔ opacity).
    if (Object.values(meta.fields).some((h) => h.type === 'color' && h.alphaField === key)) return null;
    // UIAnchor: hide offset fields irrelevant to current anchor preset
    if (meta.name === 'UIAnchor' && (key === 'top' || key === 'left' || key === 'right' || key === 'bottom')) {
      const anchor = data.anchor as string;
      const visible: Record<string, string[]> = {
        stretch: ['top', 'left', 'right', 'bottom'],
        'top-stretch': ['top', 'left', 'right'],
        'bottom-stretch': ['bottom', 'left', 'right'],
        'left-stretch': ['top', 'left', 'bottom'],
        'right-stretch': ['top', 'right', 'bottom'],
        'h-stretch': ['top', 'left', 'right'],
        'v-stretch': ['top', 'left', 'bottom'],
        top: ['top', 'left'],
        bottom: ['bottom', 'left'],
        left: ['top', 'left'],
        right: ['top', 'right'],
        'top-left': ['top', 'left'],
        'top-right': ['top', 'right'],
        'bottom-left': ['bottom', 'left'],
        'bottom-right': ['bottom', 'right'],
        center: ['top', 'left'],
      };
      if (!(visible[anchor] || []).includes(key)) return null;
    }
    // UIAnchor: hide pivotX/pivotY when their axis is stretched (pivot has no effect)
    if (meta.name === 'UIAnchor' && (key === 'pivotX' || key === 'pivotY')) {
      const anchor = data.anchor as string;
      const stretchX = ['stretch', 'top-stretch', 'bottom-stretch', 'h-stretch'].includes(anchor);
      const stretchY = ['stretch', 'left-stretch', 'right-stretch', 'v-stretch'].includes(anchor);
      if (key === 'pivotX' && stretchX) return null;
      if (key === 'pivotY' && stretchY) return null;
    }
    // Number + unit dropdown (UIElement width/height, UIAnchor offsets).
    const unitFieldMap = UNIT_FIELD_MAPS[meta.name] ?? {};
    if (unitFieldMap[key]) {
      const unitKey = unitFieldMap[key];
      const unit = (data[unitKey] as string) || 'px';
      // Disable width/height when anchor stretches along that axis
      const stretchDisabled = meta.name === 'UIElement' && hasAnchor && (
        (key === 'width' && ['stretch', 'top-stretch', 'bottom-stretch', 'h-stretch'].includes(anchorValue)) ||
        (key === 'height' && ['stretch', 'left-stretch', 'right-stretch', 'v-stretch'].includes(anchorValue))
      );
      return (
        <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 2, ...(ov ? overrideStyle : {}), ...(stretchDisabled ? { opacity: 0.35 } : {}) }}>
          <FieldLabel label={key} hint={hint} style={{ width: 50, color: ov ? '#5dade2' : '#888', fontSize: '11px', fontWeight: ov ? 'bold' : 'normal' }} />
          <BufferedNumberInput value={val as number} step={hint.step ?? 1} mixed={mx} min={hint.min} max={hint.max}
            onChange={v => write(key, v)} readOnly={stretchDisabled}
            style={{ flex: 1, background: '#111', color: '#ddd', border: '1px solid #444', borderRadius: 3, padding: '2px 4px', fontSize: '12px', fontFamily: 'monospace' }} />
          <select value={isMixed(unitKey) ? '' : unit} onChange={e => { if (e.target.value !== '') write(unitKey, e.target.value); }} disabled={stretchDisabled}
            style={{ background: '#111', color: '#ddd', border: '1px solid #444', borderRadius: 3, padding: '2px 2px', fontSize: '11px', fontFamily: 'monospace', cursor: 'pointer' }}>
            {isMixed(unitKey) && <option value="">--</option>}
            <option value="px">px</option>
            <option value="%">%</option>
            <option value="vw">vw</option>
            <option value="vh">vh</option>
            <option value="vmin">vmin</option>
            <option value="vmax">vmax</option>
          </select>
        </div>
      );
    }
    if (hint.type === 'number') {
      const disabledByAnchor = selfPlacementDisabled(key);
      return <div key={key} style={{ ...(ov ? overrideStyle : {}), ...(disabledByAnchor ? { opacity: 0.35 } : {}) }}><NumberField label={key} value={val as number} step={hint.step}
        readOnly={hint.readOnly || disabledByAnchor} wide onChange={(v) => write(key, v)} overrideColor={ov} hint={hint} mixed={mx} /></div>;
    }
    if (hint.type === 'string') {
      if (meta.name === 'PrefabInstance' && key === 'source' && val) {
        return (
          <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 2 }}>
            <span style={{ flex: 1, color: '#888', fontSize: '11px' }}>{key}</span>
            <PrefabSourceLink source={val as string} />
          </div>
        );
      }
      // Plain-text string (no asset `accept`) — free text like UIElement.text or a
      // UIBinding store-field name. These must NOT route through AssetRefField:
      // its GUID-only typed-input guard (isAcceptableTypedRef) rejects any ordinary
      // word, so handleChange never commits and onBlur reverts the field to its old
      // value — i.e. the text looked un-editable. A plain BufferedTextInput commits
      // every keystroke. Asset-ref strings (mesh/material/sprite/fontFamily/…) all
      // declare `accept` and keep the drop-target AssetRefField below.
      if (!hint.accept) {
        return (
          <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 2, ...(ov ? overrideStyle : {}) }}>
            <FieldLabel label={key} hint={hint} style={{ flex: 1, color: ov ? '#5dade2' : '#888', fontSize: '11px', fontWeight: ov ? 'bold' : 'normal' }} />
            <BufferedTextInput value={typeof val === 'string' ? val : ''} onChange={(v) => write(key, v)} mixed={mx} multiline={hint.multiline} readOnly={hint.readOnly}
              style={{ ...inputStyle, flex: 1, color: ov ? '#5dade2' : '#ddd', fontWeight: ov ? 'bold' : 'normal' }} />
          </div>
        );
      }
      // Assigning a sliced sprite to Renderable2D.sprite seeds the entity pivot from
      // the slice's authored pivot (so it lands where the artist set it, instead of
      // keeping whatever pivot the entity had).
      const onChangeRef = (meta.name === 'Renderable2D' && key === 'sprite')
        ? (v: string) => {
            write(key, v);
            const e = v ? getAssetEntry(v) : undefined;
            if (e?.type === 'sprite' && e.sprite) { write('pivotX', e.sprite.pivot.x); write('pivotY', e.sprite.pivot.y); }
          }
        : (v: string) => write(key, v);
      return <div key={key} style={ov ? overrideStyle : undefined}><AssetRefField label={key} value={val as string} onChange={onChangeRef} overrideColor={ov} accept={hint.accept} mixed={mx} fontFamilyRef={key === 'fontFamily'} editorPanel={hint.editorPanel} /></div>;
    }
    if (hint.type === 'color') {
      // A color field can fold a sibling 0..1 field into an A slider (hint.alphaField),
      // e.g. UIElement.backgroundColor↔backgroundOpacity, Renderable2D.color↔opacity.
      const af = hint.alphaField;
      const foldAlpha = af && typeof data[af] === 'number';
      return <div key={key} style={ov ? overrideStyle : undefined}><ColorField label={key} value={val as number} onChange={(v) => write(key, v)} mixed={mx}
        {...(foldAlpha ? { alpha: data[af] as number, onAlphaChange: (a: number) => write(af, a), alphaMixed: isMixed(af) } : {})} /></div>;
    }
    if (hint.type === 'entityRef') {
      return <div key={key} style={ov ? overrideStyle : undefined}><EntityRefField label={key} value={val as string} onChange={(v) => write(key, v)} hint={hint} mixed={mx} /></div>;
    }
    if (hint.type === 'bindings') {
      return <div key={key} style={ov ? overrideStyle : undefined}><UIActionBindingsField entityIds={entityIds} meta={meta} field={key} /></div>;
    }
    if (hint.type === 'materialOverrides') {
      return <div key={key} style={ov ? overrideStyle : undefined}><MaterialOverridesField entityIds={entityIds} meta={meta} field={key} /></div>;
    }
    if (hint.type === 'enum' && (hint.options || hint.optionsSource)) {
      if (meta.name === 'UIAnchor' && key === 'anchor') {
        return <div key={key} style={ov ? overrideStyle : undefined}><AnchorPickerField value={val as string} onChange={(v) => write(key, v)} mixed={mx} /></div>;
      }
      // Resolve dynamic options (UIAction names, this model's clips/bones) at
      // render time; always keep an empty "(none)" option and the current value,
      // so editing can't lose an unlisted value (e.g. GLB not loaded yet).
      const base = hint.optionsSource ? resolveDynamicOptions(hint.optionsSource, primaryId) : (hint.options ?? []);
      const opts = Array.from(new Set(['', ...base, (val as string) || '']));
      const enumDisabled = selfPlacementDisabled(key); // alignSelf when anchored
      return <div key={key} style={{ ...(ov ? overrideStyle : {}), ...(enumDisabled ? { opacity: 0.35 } : {}) }}><DropdownField label={key} value={val as string} options={opts} onChange={(v) => write(key, v)} hint={hint} mixed={mx} disabled={enumDisabled} /></div>;
    }
    if (hint.type === 'boolean') {
      // UIAnchor.safeArea only takes effect on a STRETCHED anchor: safe-area padding
      // insets a stretched container's children from the notch/home-indicator; on a
      // non-stretched element it does nothing (the runtime gates it — see anchorCss).
      // Disable the checkbox there so the UI doesn't imply an effect it won't have.
      const safeAreaInert = meta.name === 'UIAnchor' && key === 'safeArea' && (() => {
        const anc = data.anchor as string;
        const sx = ['stretch', 'top-stretch', 'bottom-stretch', 'h-stretch'].includes(anc);
        const sy = ['stretch', 'left-stretch', 'right-stretch', 'v-stretch'].includes(anc);
        return !(sx || sy);
      })();
      return (
        <label key={key} title={safeAreaInert ? 'Safe Area only applies to a stretched anchor — it insets a container’s children from the notch/home-indicator. No effect on a non-stretched element.' : undefined}
          style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: safeAreaInert ? 'default' : 'pointer', fontSize: '11px', marginBottom: 2, ...(safeAreaInert ? { opacity: 0.4 } : {}) }}>
          <input type="checkbox" checked={mx ? false : (val as boolean)} disabled={safeAreaInert}
            ref={(el) => { if (el) el.indeterminate = mx; }}
            onChange={(e) => write(key, e.target.checked)} />
          <FieldLabel label={key} hint={hint} style={{ color: '#bbb' }} />
        </label>
      );
    }
    return null;
  };

  /** Render a grouped VecField (Vec2/Vec3). */
  const renderVecGroup = (name: string, groupFields: { key: string; hint: FieldHint }[]) => {
    const ovKeys = new Set(groupFields.filter((f) => isOverridden(f.key)).map((f) => f.key));
    const mxKeys = new Set(groupFields.filter((f) => isMixed(f.key)).map((f) => f.key));
    return (
      <div key={`group:${name}`} style={ovKeys.size > 0 ? overrideStyle : undefined}>
        <VecField label={name} fields={groupFields} data={data} onChange={(key, v) => write(key, v)} overriddenKeys={ovKeys} mixedKeys={mxKeys} />
      </div>
    );
  };

  /** Render one ordered section item (single field or grouped VecField). */
  const renderItem = (item: SectionItem) =>
    item.kind === 'group' ? renderVecGroup(item.name, item.fields) : renderField(item.key, item.hint);

  /** Check if a section has any visible content (a group is always visible; a
   *  single field respects showWhen). */
  const sectionHasVisibleItems = (items: SectionItem[]) =>
    items.some((item) => {
      if (item.kind === 'group') return true;
      if (!item.hint.showWhen) return true;
      return Object.entries(item.hint.showWhen).every(
        ([depField, allowedValues]) => (allowedValues as string[]).includes(String(data[depField]))
      );
    });

  return (
    <Section title={isResource ? `${meta.name} (resource)` : meta.name} defaultOpen onRemove={onRemove} menuItems={menuItems}>
      {/* Top-level items (no section) — grouped VecFields + singles, in order */}
      {topItems.map(renderItem)}

      {/* Collapsible sub-sections */}
      {Array.from(sections.entries()).map(([sectionName, { items, defaultOpen, divider }]) => {
        if (!sectionHasVisibleItems(items)) return null;
        const showAnchorNote = meta.name === 'UIElement' && hasAnchor && sectionName === 'Layout';
        const activeLayer = typeof data['physicsLayer'] === 'string' ? (data['physicsLayer'] as string) : '';
        const showFilterNote = meta.name === 'Collider2D' && sectionName === 'Advanced Filter' && activeLayer.length > 0;
        return (
          <div key={sectionName}>
            {divider && <div style={{ borderTop: '1px solid #444', margin: '6px 0' }} />}
            <SubSection title={sectionName} defaultOpen={defaultOpen}>
              {showAnchorNote && <AnchorLayoutNote />}
              {showFilterNote && <FilterIgnoredNote layer={activeLayer} />}
              {items.map(renderItem)}
            </SubSection>
          </div>
        );
      })}

      {/* SkinnedMeshRenderer-only: per-slot material override pickers for this mesh node */}
      {meta.name === 'SkinnedMeshRenderer' && <SkinnedMeshRendererMaterials entityIds={entityIds} meta={meta} data={data} />}

      {/* AnimationLibrary-only: the .animset.json GUID list (shared cross-model clips) */}
      {meta.name === 'AnimationLibrary' && <AnimationLibraryAnimSets entityIds={entityIds} meta={meta} />}

      {/* Animator-only: the named keyframe-clip bank + active-clip dropdown (JSON-string field) */}
      {meta.name === 'Animator' && <AnimatorClipsSection entityIds={entityIds} meta={meta} />}

      {/* SpriteAnimator-only: the ordered 'sprite' GUID frame list (2D flipbook) */}
      {meta.name === 'SpriteAnimator' && <SpriteAnimatorSection entityIds={entityIds} meta={meta} />}

      {/* AudioSource-only: the named clip bank (key → audio GUID; JSON-string field) */}
      {meta.name === 'AudioSource' && <AudioSourceClips entityIds={entityIds} meta={meta} />}

      {/* CameraFrame-only: the editor-persistent "show framing gizmo" toggle (not a trait). */}
      {meta.name === 'CameraFrame' && <CameraFrameGizmoToggle entityIds={entityIds} />}

      {/* Camera-only: copy editor SceneView camera transform */}
      {meta.name === 'Camera' && <CopyEditorCameraButton entityId={primaryId} />}

      {/* Director-only: open its .timeline.json in the Timeline panel, bound to this Director */}
      {meta.name === 'Director' && <DirectorTimelineButton timeline={data['timeline'] as string} entityId={primaryId} />}

      {/* Collider3D-only: fit the collider to this entity's Renderable3D mesh bounds.
          (Collision-mesh generation lives in the Model asset inspector — it's a derived,
          reusable asset — then assigned here via the `mesh` field.) */}
      {meta.name === 'Collider3D' && <ColliderFitToBoundsButtons entityId={primaryId} write={write} />}

      {/* PrefabInstance-only: open the Selective Apply dialog scoped to the
       *  instance's root entity (the PrefabInstance trait records rootInstanceId
       *  on every entity in the instance, so this works whether the user
       *  inspects the root or a deep child).
       *
       *  Hidden when this instance IS the prefab currently being edited
       *  (source === editingPrefab.guid) — applying a prefab back onto itself is
       *  a no-op/cycle. Genuinely-nested child instances (a different source)
       *  keep the button so their edits can be pushed to the child .prefab.json. */}
      {meta.name === 'PrefabInstance' && !(editingPrefab && data['source'] === editingPrefab.guid) && (
        <>
          <button
            onClick={() => {
              const rootInstanceId = (data['rootInstanceId'] as number) || primaryId;
              useEditorStore.getState().openApplyPrefabDialog(rootInstanceId);
            }}
            style={{
              marginTop: 6, width: '100%', padding: '4px 8px', background: '#2d3a4a', color: '#bbb',
              border: '1px solid #3a4a5a', borderRadius: 3, fontSize: '11px', cursor: 'pointer',
            }}
            title="Pick which overrides to push back to the source .prefab.json"
          >
            Apply to Prefab…
          </button>
          {/* Revert: reset selected overrides on THIS instance back to the prefab
           *  base. Does not touch the .prefab.json (the inverse, instance-scoped). */}
          <button
            onClick={() => {
              const rootInstanceId = (data['rootInstanceId'] as number) || primaryId;
              useEditorStore.getState().openRevertPrefabDialog(rootInstanceId);
            }}
            style={{
              marginTop: 6, width: '100%', padding: '4px 8px', background: '#3a2d2d', color: '#bbb',
              border: '1px solid #4a3a3a', borderRadius: 3, fontSize: '11px', cursor: 'pointer',
            }}
            title="Pick which overrides to reset back to the prefab base on this instance"
          >
            Revert Overrides…
          </button>
        </>
      )}
    </Section>
  );
}

function CopyEditorCameraButton({ entityId }: { entityId: number }) {
  const onClick = useCallback(() => {
    const cam = getEditorViewportCamera();
    if (!cam) { console.warn('[Inspector] Editor camera not available'); return; }
    const tfMeta = getAllTraits().find(t => t.name === 'Transform');
    if (!tfMeta) return;
    writeField(entityId, tfMeta, 'x', cam.position.x);
    writeField(entityId, tfMeta, 'y', cam.position.y);
    writeField(entityId, tfMeta, 'z', cam.position.z);
    writeField(entityId, tfMeta, 'rx', cam.rotation.x);
    writeField(entityId, tfMeta, 'ry', cam.rotation.y);
    writeField(entityId, tfMeta, 'rz', cam.rotation.z);
  }, [entityId]);
  return (
    <button onClick={onClick} style={{
      marginTop: 6, width: '100%', padding: '4px 8px', background: '#2d3a4a', color: '#bbb',
      border: '1px solid #3a4a5a', borderRadius: 3, fontSize: '11px', cursor: 'pointer',
    }} title="Copy the editor SceneView camera position/rotation to this entity's Transform">
      Copy from Editor Camera
    </button>
  );
}

/** Collider3D "fit to mesh bounds" — one-click size a primitive collider (box or sphere) to the
 *  bounding box / sphere of this entity's Renderable3D mesh. Uses the same geometry the runtime
 *  mesh cache holds; writes shape + dims through the normal undo-tracked field writer.
 *  (Off-center meshes size correctly but stay origin-centered — Collider3D has no local offset
 *  yet, a later add.)
 *
 *  Collider extents are ENTITY-LOCAL and the runtime multiplies them by the entity's WORLD scale
 *  (`makeColliderDesc` in physics3DSystem.ts — same convention as Unity's BoxCollider.size vs
 *  lossyScale). So this must fit the RAW geometry bounds and must NOT pre-apply Transform.scale:
 *  doing so double-scaled the collider (a 7x-scaled ramp got a 49-wide collider) and silently
 *  produced physics that did not match the mesh. */
function ColliderFitToBoundsButtons({ entityId, write }: { entityId: number; write: (field: string, value: unknown) => void }) {
  const ent = findEntity(entityId);
  const r3dMeta = getTraitByName('Renderable3D');
  const meshGuid = ent && r3dMeta && ent.has(r3dMeta.trait) ? ((ent.get(r3dMeta.trait) as { mesh?: string }).mesh ?? '') : '';
  const geometry = meshGuid ? resolveMeshTemplate(meshGuid)?.geometry : undefined;

  const fit = useCallback((mode: 'box' | 'sphere') => {
    if (!ent || !geometry) return;
    // No scale argument on purpose — see the note above: the runtime applies world scale.
    if (mode === 'box') {
      const he = geometryBoxHalfExtents(geometry);
      write('shape', 'box'); write('halfW', +he.x.toFixed(4)); write('halfH', +he.y.toFixed(4)); write('halfD', +he.z.toFixed(4));
    } else {
      write('shape', 'sphere'); write('radius', +geometryBoundingRadius(geometry).toFixed(4));
    }
  }, [ent, geometry, write]);

  if (!geometry) {
    return <div style={{ marginTop: 6, fontSize: '10px', color: '#666' }}>Add a Renderable3D mesh (and let it load) to fit the collider to its bounds.</div>;
  }
  const btn: React.CSSProperties = { flex: 1, padding: '4px 8px', background: '#2d3a4a', color: '#bbb', border: '1px solid #3a4a5a', borderRadius: 3, fontSize: '11px', cursor: 'pointer' };
  return (
    <div style={{ marginTop: 6, display: 'flex', gap: 4 }}>
      <button onClick={() => fit('box')} style={btn} title="shape=box + half-extents from the mesh bounding box (× Transform scale)">Fit Box to Mesh</button>
      <button onClick={() => fit('sphere')} style={btn} title="shape=sphere + radius from the mesh bounding sphere (× max scale)">Fit Sphere</button>
    </div>
  );
}

// ── Asset Inspector (shown when an asset is selected in Assets panel) ──

/** Multi-select asset Inspector — shown when >1 asset is selected. Same chrome as
 *  AssetInspector; dispatches to a per-type batch editor when the selection is
 *  homogeneous, else explains why there's nothing shared to edit. */
function AssetBatchInspector({ assets }: { assets: SelectedAsset[] }) {
  const types = new Set(assets.map((a) => a.type));
  const commonType = types.size === 1 ? assets[0].type : null;
  const paths = assets.map((a) => a.path);
  return (
    <div style={containerStyle}>
      <div style={{ padding: '4px 8px', borderBottom: '1px solid #333' }}>
        <span style={{ fontWeight: 'bold', color: '#f1c40f', fontSize: '13px' }}>Inspector</span>
      </div>
      <div style={{ padding: '6px 8px', borderBottom: '1px solid #333' }}>
        <strong style={{ color: '#fff', fontSize: '12px' }}>
          {assets.length} {commonType ? `${commonType}s` : 'assets'} selected
        </strong>
        {!commonType && <div style={{ color: '#555', fontSize: '10px', marginTop: 2 }}>mixed types — no shared settings</div>}
      </div>
      <div style={{ padding: '8px', flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {commonType === 'texture' && <TextureBatchView paths={paths} />}
        {commonType === 'material' && <MaterialBatchView paths={paths} />}
        {commonType === 'model' && <ModelBatchView assets={assets} />}
        {commonType && !['texture', 'material', 'model'].includes(commonType) && (
          <div style={{ color: '#555', fontSize: '11px' }}>Batch editing not supported for {commonType} assets</div>
        )}
      </div>
    </div>
  );
}

function AssetInspector({ asset }: { asset: SelectedAsset }) {
  const [postprocessor, setPostprocessor] = useState('none');
  const [metaLoaded, setMetaLoaded] = useState(false);
  const postprocessorIds = getModelPostprocessorIds();

  // Load meta on mount / asset change
  useEffect(() => {
    if (asset.type !== 'model') return;
    setMetaLoaded(false);
    const ac = new AbortController();
    backendFetch(`/api/read-meta?path=${encodeURIComponent(asset.path)}`, { signal: ac.signal })
      .then(r => r.ok ? r.json() : {})
      .then((meta: Record<string, unknown>) => { if (meta.postprocessor) setPostprocessor(meta.postprocessor as string); setMetaLoaded(true); })
      .catch(e => { if (e.name !== 'AbortError') setMetaLoaded(true); });
    return () => ac.abort();
  }, [asset.path, asset.type]);

  // Persist postprocessor to meta when changed
  const handlePostprocessorChange = useCallback((newPostprocessor: string) => {
    setPostprocessor(newPostprocessor);
    backendFetch('/api/write-meta', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: asset.path, meta: { version: 1, postprocessor: newPostprocessor } }),
    }).catch(() => {});
  }, [asset.path]);

  return (
    <div style={containerStyle}>
      <div style={{ padding: '4px 8px', borderBottom: '1px solid #333' }}>
        <span style={{ fontWeight: 'bold', color: '#f1c40f', fontSize: '13px' }}>Inspector</span>
      </div>

      {/* Asset header */}
      <div style={{ padding: '6px 8px', borderBottom: '1px solid #333' }}>
        <strong style={{ color: '#fff', fontSize: '12px' }}>{asset.name}</strong>
        <div style={{ color: '#555', fontSize: '10px', marginTop: 2 }}>{asset.type} — {asset.path}</div>
      </div>

      {/* flex:1 + minHeight:0 so this fills the panel (short content shows the
          container's bg, not the black window base) and overflowY scrolls tall
          content (e.g. a many-clip animset) instead of spilling past the panel. */}
      <div style={{ padding: '8px', flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {asset.type === 'model' && (
          <>
            <div style={{ marginBottom: 6 }}>
              <div style={{ color: '#888', fontSize: '10px', marginBottom: 2 }}>Postprocessor</div>
              <select value={postprocessor} onChange={(e) => handlePostprocessorChange(e.target.value)}
                style={{ ...inputStyle, width: '100%' }} disabled={!metaLoaded}>
                {postprocessorIds.map((id) => <option key={id} value={id}>{id}</option>)}
              </select>
            </div>
            <ModelAssetView path={asset.path} name={asset.name} postprocessor={postprocessor} />
          </>
        )}

        {asset.type === 'prefab' && (
          <>
            <button
              onClick={async () => {
                try {
                  const res = await fetch(asset.path);
                  const prefab: PrefabFile = await res.json();
                  // Preload nested children before the sync expand (nested prefabs).
                  const rootId = await instantiatePrefabAsync(prefab);
                  setPrefabSource(rootId, asset.path);
                  // Make it undoable via the shared helper (prefab F4) — same
                  // reassign-on-redo semantics as Hierarchy/Assets so Cmd+Z removes
                  // the instance and redo respawns + retracks the new id.
                  const { deleteEntity } = await import('../../runtime/ecs/entityUtils');
                  pushAction(makePrefabInstantiateAction({
                    label: `Instantiate "${prefab.name}"`,
                    initialId: rootId,
                    respawn: async () => {
                      const r = await fetch(asset.path);
                      if (!r.ok) return null;
                      const p: PrefabFile = await r.json();
                      const id = await instantiatePrefabAsync(p);
                      setPrefabSource(id, asset.path);
                      return id;
                    },
                    remove: (id) => { deleteEntity(id); },
                  }));
                } catch (e) { console.error('[Inspector] Instantiate failed:', e); }
              }}
              style={{ ...reimportBtnStyle, marginBottom: 6 }}
            >
              Instantiate Prefab
            </button>
            <button
              onClick={async () => {
                // TODO: re-import from source GLB with postprocessor
                console.log('[Inspector] Re-import not yet implemented for asset view');
              }}
              style={reimportBtnStyle}
            >
              Re-import
            </button>
          </>
        )}

        {asset.type === 'mesh' && <MeshAssetView path={asset.path} />}

        {asset.type === 'material' && <MaterialAssetView path={asset.path} />}
        {asset.type === 'shader' && <ShaderAssetView path={asset.path} />}

        {asset.type === 'texture' && <TextureAssetView path={asset.path} name={asset.name} />}

        {asset.type === 'particle' && (
          <button
            onClick={() => openAssetInEditor({ path: asset.path, type: 'particle', name: asset.name })}
            style={reimportBtnStyle}
          >
            Open in Particle Editor
          </button>
        )}

        {asset.type === 'animation' && (
          <button
            onClick={() => openAssetInEditor({ path: asset.path, type: 'animation', name: asset.name })}
            style={reimportBtnStyle}
          >
            Open in Animation Window
          </button>
        )}

        {asset.type === 'rig2d' && (
          <button
            onClick={() => openAssetInEditor({ path: asset.path, type: 'rig2d', name: asset.name })}
            style={reimportBtnStyle}
          >
            Open in 2D Skin Window
          </button>
        )}

        {asset.type === 'spriteanim' && (
          <button
            onClick={() => openAssetInEditor({ path: asset.path, type: 'spriteanim', name: asset.name })}
            style={reimportBtnStyle}
          >
            Open in Sprite Animation Window
          </button>
        )}

        {asset.type === 'scene' && (
          <button
            onClick={() => openAssetInEditor({ path: asset.path, type: 'scene', name: asset.name })}
            style={reimportBtnStyle}
          >
            Open Scene
          </button>
        )}

        {asset.type === 'animset' && <AnimSetAssetView path={asset.path} />}

        {asset.type === 'sprite' && <SpriteAssetView path={asset.path} name={asset.name} />}

        {asset.type === 'atlas' && <AtlasAssetView path={asset.path} name={asset.name} />}

        {asset.type === 'audio' && <AudioAssetView path={asset.path} name={asset.name} />}

        {asset.type === 'environment' && <EnvironmentAssetView path={asset.path} name={asset.name} />}

        {asset.type === 'font' && <FontAssetView path={asset.path} name={asset.name} />}

        {!['model', 'prefab', 'texture', 'sprite', 'atlas', 'mesh', 'material', 'particle', 'animation', 'rig2d', 'spriteanim', 'scene', 'animset', 'audio', 'environment', 'font'].includes(asset.type) && (
          <div style={{ color: '#555', fontSize: '11px' }}>No actions for {asset.type} assets</div>
        )}
      </div>
    </div>
  );
}

// ── Main Inspector ──────────────────────────────────────

export default function Inspector() {
  const selectedId = useEditorStore((s) => s.selectedEntityId);
  const selectedIds = useEditorStore((s) => s.selectedEntityIds);
  const selectedAsset = useEditorStore((s) => s.selectedAsset);
  const selectedAssets = useEditorStore((s) => s.selectedAssets);
  // Component clipboard — reactive so Paste flips enabled the moment a copy lands.
  const clipboard = useTraitClipboard();
  const [traits, setTraits] = useState<TraitEntry[]>([]);
  const [entityName, setEntityName] = useState('');
  const [overrides, setOverrides] = useState<Set<string>>(new Set());
  const [nonSharedTraits, setNonSharedTraits] = useState<string[]>([]);

  const multi = selectedIds.length > 1;
  // Stable dependency key so the effect re-runs when the selection set changes
  // (the array identity changes on every selection write, but we key on contents
  // to avoid surprises).
  const selKey = selectedIds.join(',');

  // Refresh entity data periodically. lastRead holds the latest refresh result
  // so the dirty-driven override calc can reuse it instead of re-reading every
  // trait a second time per frame.
  const lastReadRef = useRef<TraitEntry[]>([]);
  useEffect(() => {
    if (selectedIds.length === 0) { setTraits([]); setEntityName(''); setNonSharedTraits([]); lastReadRef.current = []; return; }
    const refresh = () => {
      const { result, nonShared } = readMergedTraits(selectedIds);
      if (result.length === 0) { setTraits([]); setEntityName(''); setNonSharedTraits([]); lastReadRef.current = []; return; }

      // Skip the React update when the read is identical to last frame. Critical
      // now that we re-read every frame (live-refresh below): a static selection
      // yields an unchanged result each tick and must not re-render the panel.
      if (sameTraitResult(result, lastReadRef.current)) return;
      lastReadRef.current = result;
      setTraits(result);
      setNonSharedTraits(nonShared);

      // Derive name (single-select header; multi shows a count instead)
      const camTrait = result.find((m) => m.meta.role === 'camera');
      if (camTrait) { setEntityName('Game Camera'); return; }
      const resTrait = result.find((m) => m.meta.category === 'resource');
      if (resTrait) { setEntityName(`${resTrait.meta.name} (resource)`); return; }
      // Use first string field value
      for (const { meta, data } of result) {
        if (!data || meta.category !== 'component') continue;
        for (const [key, hint] of Object.entries(meta.fields)) {
          if (hint.type === 'string' && data[key]) {
            setEntityName(String(data[key]));
            return;
          }
        }
      }
      setEntityName(`Entity ${selectedIds[0]}`);
    };
    refresh();
    setOverrides(new Set());

    // Prefab-override highlighting only applies to a single selection (overrides
    // are computed against one entity's prefab localId). Skip entirely in multi.
    const primaryId = selectedIds[0];
    const piMeta = !multi ? getTraitByName('PrefabInstance') : null;
    const piData = piMeta ? readTraitData(primaryId, piMeta) : null;
    const prefabSource = piData?.['source'] as string | undefined;
    const localId = (piData?.['localId'] as number) || 0;

    // Use object ref so the interval closure sees updates
    const state = { prefabFile: null as Awaited<ReturnType<typeof getPrefabSource>> };

    // Recompute overrides against the current cached prefab + the most recent
    // trait read. Used both on prefab load (initial highlight) and on every
    // ECS dirty event.
    const recomputeOverrides = () => {
      // Re-read PrefabInstance each call: the selected entity may have just BECOME an
      // instance (Create Prefab on the current selection doesn't change selKey, so this
      // effect doesn't re-run) — without this a freshly-created instance never highlights
      // its overrides. Falls back to the effect-time source/localId.
      const piNow = piMeta ? readTraitData(primaryId, piMeta) : null;
      const source = (piNow?.['source'] as string | undefined) ?? prefabSource;
      const lid = (piNow?.['localId'] as number) || localId;
      if (!source || lid <= 0) { setOverrides(new Set()); return; }
      // Read the CURRENT cached prefab, not the once-fetched state.prefabFile — so an
      // Apply-to-Prefab (or any external prefab edit) that moves the base is reflected:
      // an applied field must stop highlighting as an override once it matches the new
      // base. state.prefabFile is the fallback until the async load first fills the cache.
      const prefab = getCachedPrefabSync(source) ?? state.prefabFile;
      if (!prefab) return;
      const currentTraits: Record<string, Record<string, unknown>> = {};
      for (const { meta, data } of lastReadRef.current) {
        if (meta.category === 'tag' || !data) continue;
        currentTraits[meta.name] = data;
      }
      setOverrides(getOverrides(lid, currentTraits, prefab));
    };

    // Capture selection at fetch time; on resolution, only apply the result if
    // selection hasn't changed (rapid A→B switches must not clobber B's data).
    const fetchSelKey = selKey;
    let cancelled = false;
    if (prefabSource && localId > 0) {
      getPrefabSource(prefabSource).then((p) => {
        if (cancelled || fetchSelKey !== selectedIds.join(',')) return;
        state.prefabFile = p;
        // Compute once the prefab is in hand, even when no ECS write follows.
        recomputeOverrides();
      });
    }

    // Dirty-flag driven refresh (replaces 500ms polling).
    // markUIDirty() fires on every ECS write — we coalesce via rAF so the
    // Inspector re-reads traits at most once per frame.
    let dirty = false;
    let rafId = 0;

    const onDirty = () => {
      if (!dirty) {
        dirty = true;
        rafId = requestAnimationFrame(() => {
          dirty = false;
          refresh();
          recomputeOverrides();
        });
      }
    };

    const unsubscribeDirty = onEditorDirty(onDirty);

    // Live refresh: systems that mutate traits directly via updateEach (e.g. the
    // ship-shake / engine-flame animation systems) never route through
    // writeTraitField, so they don't fire markUIDirty. Re-read the selected
    // entity once per frame so the Inspector tracks those runtime changes, the
    // same way Unity's inspector shows live values during play. refresh() diffs
    // and no-ops when nothing changed, so a static selection costs one read +
    // compare per frame and zero re-renders. Overrides are intentionally NOT
    // recomputed here (only refresh() data, not recomputeOverrides) — so a
    // jittering Transform doesn't flicker the prefab-override highlight every
    // frame; overrides still recompute on real edits via onDirty.
    //
    // Gated to single-select: for a multi-selection, readMergedTraits is
    // O(entities × traits) of fresh allocation per frame (Maps, per-trait
    // objects, the merge + mixed-Set), which we will NOT pay 60×/s. Multi-select
    // still tracks every writeTraitField edit through onDirty; only live
    // runtime-animation values (rare to multi-select) go un-tracked.
    const liveRefresh = !multi;
    if (liveRefresh) {
      startFrameDriver();
      registerFrameCallback('inspector-live-refresh', refresh, PRIORITY_INSPECTOR_REFRESH);
    }

    return () => {
      cancelled = true;
      unsubscribeDirty();
      cancelAnimationFrame(rafId);
      if (liveRefresh) {
        unregisterFrameCallback('inspector-live-refresh');
        stopFrameDriver();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selKey]);

  const handleDelete = useCallback(() => {
    if (selectedIds.length === 0) return;
    // Delete the whole selection as ONE undo entry; fold selection into it via a
    // raw setState (no separate selection-undo entry) so a single undo restores
    // every deleted entity and reselects them.
    deleteEntitiesWithUndo(selectedIds, (ids) =>
      useEditorStore.setState({
        selectedEntityId: ids.length > 0 ? ids[ids.length - 1] : null,
        selectedEntityIds: ids,
        selectedAsset: null,
      }),
    );
  }, [selectedIds]);

  // Asset mode — batch inspector when >1 asset selected, else single-asset.
  if (selectedAssets.length > 1 && selectedId === null) {
    return <AssetBatchInspector assets={selectedAssets} />;
  }
  if (selectedAsset && selectedId === null) {
    return <AssetInspector asset={selectedAsset} />;
  }

  if (selectedIds.length === 0 || traits.length === 0) {
    return (
      <div style={containerStyle}>
        <div style={{ padding: '6px 8px', borderBottom: '1px solid #333', fontWeight: 'bold', color: '#f1c40f' }}>Inspector</div>
        <div style={{ padding: 12, color: '#555', fontSize: '11px' }}>
          {selectedIds.length > 1
            ? `${selectedIds.length} entities selected — no shared components`
            : 'Select an entity or asset'}
        </div>
      </div>
    );
  }

  // Separate EntityAttributes from other components
  const entityAttr = traits.find((t) => t.meta.name === 'EntityAttributes');
  const components = traits
    .filter((t) => t.meta.category === 'component' && t.meta.name !== 'EntityAttributes')
    .sort((a, b) => (a.meta.priority ?? 100) - (b.meta.priority ?? 100));
  const resources = traits.filter((t) => t.meta.category === 'resource');
  const tags = traits.filter((t) => t.meta.category === 'tag');

  // Under a multi-selection, Copy takes the PRIMARY entity's values — including for
  // fields the panel is rendering as `----` (mixed). Name the source in the menu label
  // so the copied value isn't one the user was never shown.
  const eaMetaForName = getTraitByName('EntityAttributes');
  const copySourceName = multi && selectedIds.length > 0 && eaMetaForName
    ? (readTraitData(selectedIds[0], eaMetaForName)?.['name'] as string | undefined)
    : undefined;
  const copyLabel = multi
    ? `Copy Component (from ${copySourceName || `Entity ${selectedIds[0]}`})`
    : 'Copy Component';

  return (
    <div style={containerStyle}>
      {/* Header with delete button */}
      <div style={{ height: 32, padding: '0 8px', borderBottom: '1px solid #333', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontWeight: 'bold', color: '#f1c40f', fontSize: '13px' }}>Inspector</span>
        <button onClick={handleDelete} style={deleteBtnStyle} title={multi ? 'Delete Entities' : 'Delete Entity'}
          data-ui-id="inspector.header.delete" data-ui-kind="button" data-ui-label="delete entity">🗑</button>
      </div>

      {/* EntityAttributes — inline header (checkbox + name + id) */}
      <div style={{ padding: '6px 8px', borderBottom: '1px solid #333', display: 'flex', alignItems: 'center', gap: 6 }}>
        {entityAttr?.data && (
          <input
            type="checkbox"
            checked={entityAttr.mixed?.has('isActive') ? false : (entityAttr.data['isActive'] as boolean)}
            ref={(el) => { if (el) el.indeterminate = !!entityAttr.mixed?.has('isActive'); }}
            onChange={(e) => {
              // A mixed (indeterminate) checkbox must resolve a click to a
              // definite value: clicking when some entities are active and some
              // aren't turns them ALL on. Don't trust e.target.checked here —
              // browsers differ on the indeterminate→checked transition.
              const next = entityAttr.mixed?.has('isActive') ? true : e.target.checked;
              writeFieldMulti(selectedIds, entityAttr.meta, 'isActive', next);
            }}
            title="Active"
            data-ui-id="inspector.header.active" data-ui-kind="toggle" data-ui-label="active"
          />
        )}
        {multi ? (
          // Multi-select: name is per-entity, so show a count instead of an editable field.
          <strong style={{ color: '#fff', flex: 1, fontSize: '12px' }}>{selectedIds.length} entities selected</strong>
        ) : entityAttr?.data ? (
          // BufferedTextInput (not a raw controlled input): the ECS name write
          // round-trips back through an rAF-deferred refresh, so a plain
          // controlled input would reset the caret to the end on every keystroke.
          // The local buffer keeps the caret put while focused.
          //
          // Name is a first-class per-instance override (captured + applied like
          // any other trait field). EntityAttributes is rendered here as an inline
          // header rather than a TraitSection, so reflect the override state
          // ourselves — blue accent when the name differs from the prefab source.
          <span
            style={{ flex: 1, display: 'flex' }}
            title={overrides.has('EntityAttributes.name') ? 'Overridden from prefab' : undefined}
            // BufferedTextInput doesn't forward data-* attributes, so the wrapper carries
            // the id. Tap it to focus, then `modoki_type_text` — the rename flow.
            data-ui-id="inspector.header.name" data-ui-kind="field" data-ui-label="entity name"
          >
            <BufferedTextInput
              // Bind the RAW stored name — never the display transform. The
              // editable field is a round-trip: binding to transformName(...)
              // would commit the transformed string on the first keystroke,
              // silently corrupting the canonical name (a first-class prefab
              // override). The transform is a display-only adornment; if a game
              // registers one, surface it as a separate read-only label, not here.
              value={editableEntityName(entityAttr.data['name'])}
              onChange={(v) => writeFieldMulti(selectedIds, entityAttr.meta, 'name', v)}
              style={{
                ...inputStyle, flex: 1, fontSize: '12px', fontWeight: 'bold',
                color: overrides.has('EntityAttributes.name') ? '#5dade2' : '#fff',
                // Inset box-shadow (not borderLeft) for the override accent:
                // inputStyle sets the `border` shorthand, and mixing it with the
                // non-shorthand borderLeft makes React warn about conflicting
                // style properties on rerender.
                ...(overrides.has('EntityAttributes.name')
                  ? { boxShadow: 'inset 3px 0 0 #3498db', background: 'rgba(52, 152, 219, 0.15)' }
                  : {}),
              }}
            />
          </span>
        ) : (
          <strong style={{ color: '#fff', flex: 1, fontSize: '12px' }}>{entityName}</strong>
        )}
        {!multi && entityAttr?.data && (
          <input
            type="number"
            value={entityAttr.data['sortOrder'] as number ?? 0}
            onChange={(e) => writeFieldMulti(selectedIds, entityAttr.meta, 'sortOrder', coerceSortOrder(e.target.value))}
            title="Sort order (sibling ordering)"
            style={{ ...inputStyle, width: 36, textAlign: 'center', fontSize: '10px', color: '#888' }}
          />
        )}
        <span style={{ color: '#555', fontSize: '10px', flexShrink: 0 }}>{multi ? `×${selectedIds.length}` : `id:${selectedId}`}</span>
      </div>

      {/* Trait sections — auto-generated (excluding EntityAttributes) */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        {components.map(({ meta, data, mixed }) => {
          if (!data) return null;
          // Don't allow removing core traits
          const isCore = ['Transform', 'EntityAttributes'].includes(meta.name);
          // Copy reads the FIRST selected entity's live values (see copyLabel);
          // Paste writes every selected entity that carries the trait.
          const menuItems: ContextMenuItem[] | undefined = isTraitCopyable(meta) ? [
            {
              label: copyLabel,
              onClick: () => {
                // Bail rather than copying `{}`: the panel can render a section for one
                // rAF after its entity/trait is gone, and an empty clipboard entry would
                // still ENABLE Paste (the trait name matches) while pasting nothing.
                const full = readTraitDataFull(selectedIds[0], meta);
                if (full) setTraitClipboard(meta.name, full);
              },
            },
            {
              label: 'Paste Component Values',
              disabled: clipboard?.traitName !== meta.name,
              onClick: () => { if (clipboard) pasteTraitValuesWithUndo(selectedIds, meta, clipboard.values); },
            },
          ] : undefined;
          return (
            <TraitSection key={meta.name} meta={meta} entityIds={selectedIds} data={data} overrides={overrides} mixedFields={mixed}
              onRemove={isCore ? undefined : () => removeTraitFromEntitiesWithUndo(selectedIds, meta)}
              menuItems={menuItems}
            />
          );
        })}

        {/* Note: components present on only some of the selected entities are
            hidden because they aren't shared across the whole selection. */}
        {nonSharedTraits.length > 0 && (
          <div style={{ padding: '6px 10px', borderBottom: '1px solid #333', color: '#888', fontSize: '10px', lineHeight: 1.5 }}>
            <span style={{ color: '#777' }}>Not shared by all ({nonSharedTraits.length}):</span>{' '}
            <span style={{ color: '#aa8' }}>{nonSharedTraits.join(', ')}</span>
          </div>
        )}

        {resources.map(({ meta, data }) => data && (
          <TraitSection key={meta.name} meta={meta} entityIds={selectedIds} data={data} />
        ))}

        {/* Add Component picker */}
        <AddComponentPicker
          addable={getAllTraits().filter(t =>
            t.category === 'component' && !new Set(traits.map(x => x.meta.name)).has(t.name)
          )}
          selectedIds={selectedIds}
          clipboard={clipboard}
        />

        {tags.length > 0 && (
          <Section title="Tags">
            {tags.map(({ meta }) => (
              <label key={meta.name} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: '11px', marginBottom: 2 }}>
                <input
                  type="checkbox"
                  checked={true}
                  onChange={(e) => writeFieldMulti(selectedIds, meta, '', e.target.checked)}
                />
                <span style={{ color: '#e74c3c' }}>{meta.name}</span>
              </label>
            ))}
          </Section>
        )}
      </div>
    </div>
  );
}

// ── Styles ──────────────────────────────────────────────

const containerStyle: React.CSSProperties = {
  width: '100%', height: '100%', background: '#252536', color: '#ccc',
  fontFamily: 'monospace', fontSize: '12px', display: 'flex', flexDirection: 'column',
};

const deleteBtnStyle: React.CSSProperties = {
  padding: '2px 6px', border: '1px solid #555', borderRadius: 3,
  background: '#333', cursor: 'pointer', fontSize: '12px',
};

const reimportBtnStyle: React.CSSProperties = {
  width: '100%', padding: '4px 10px', border: '1px solid #555', borderRadius: 3,
  background: '#2a2a40', color: '#ccc', cursor: 'pointer', fontSize: '11px',
  fontFamily: 'monospace',
};

const overrideStyle: React.CSSProperties = {
  borderLeft: '3px solid #3498db',
  paddingLeft: 4,
  background: 'rgba(52, 152, 219, 0.15)',
  borderRadius: 2,
  marginBottom: 1,
};
