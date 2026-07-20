/** MaterialOverridesField — Inspector editor for `MaterialInstance.overrides`, the
 *  per-channel material-parameter drivers. Modeled on UIActionBindingsField: one "+ Add"
 *  button; each row picks a `kind` (uniform / prop / texture), a `target` (with suggestion
 *  chips — standard props for 'prop', the material's shader uniforms for 'uniform', its
 *  texture params for 'texture'), and either a `source` (uniform/prop: constant / time / store;
 *  a `curve` source is shown read-only — author its points/driver in the scene JSON for now) or,
 *  for a `texture` override, a sprite/texture `ref` (an AssetRefField with the sprite picker).
 *  The `texture` kind — a per-instance extra-sampler swap — is offered ONLY for a 2D custom
 *  material (`space:'2d'` `.shader.json`). Edits go through writeTraitFieldPerEntityWithUndo
 *  (undo-tracked). Editing is single-entity only — a multi-selection shows a hint (see `multi`). */

import { useState, useEffect } from 'react';
import { readTraitData } from '../../runtime/ecs/entityUtils';
import { type TraitMeta, getTraitByName } from '../../runtime/ecs/traitRegistry';
import { writeTraitFieldPerEntityWithUndo as writeFieldPerEntity } from '../undo/entityActions';
import type { MaterialParamOverride, MaterialParamSource } from '../../runtime/traits/MaterialInstance';
import { resolveGuidToPath, resolveRef, isGuid } from '../../runtime/loaders/assetManifest';
import { listShaderOptions, optionValueForMaterial, resolveShaderSchema } from '../shaderCatalog';
import { BufferedTextInput, BufferedNumberInput, inputStyle } from './fields';
import { FieldLabel, DropdownField } from './assetViews/widgets';
import { FieldValueWidget, useWorldDirtyTick } from './inspectorFields';
import { AssetRefField } from './AssetRefField';

/** Standard material properties a `prop` override can drive. `map*` targets drive one axis of
 *  the base texture's offset (UV scroll) / repeat (tiling). */
const STANDARD_PROPS = ['color', 'opacity', 'roughness', 'metalness', 'emissive', 'emissiveIntensity',
  'mapOffsetX', 'mapOffsetY', 'mapRepeatX', 'mapRepeatY'];
const COLOR_TARGETS = new Set(['color', 'emissive']);
const KIND_OPTS = ['uniform', 'prop'];
const SOURCE_OPTS = ['constant', 'time', 'store', 'curve'];

/** The `kind` dropdown options for ONE override row. `texture` is offered only on a 2D custom
 *  material (`is2D`). But if THIS row is already a `texture` override on a material the user has
 *  since swapped to 3D (`is2D` now false), keep `texture` in the list — otherwise the controlled
 *  `<select value="texture">` has no matching option and the UI silently shows the wrong kind
 *  while the data still says `texture` (a UI-vs-data desync). */
export function kindOptionsForRow(rowKind: string, is2D: boolean): string[] {
  const base = is2D ? [...KIND_OPTS, 'texture'] : KIND_OPTS;
  return rowKind === 'texture' && !base.includes('texture') ? [...base, 'texture'] : base;
}

const rowStyle: React.CSSProperties = { border: '1px solid #333', borderRadius: 3, padding: 4, marginBottom: 4 };
const lblStyle: React.CSSProperties = { flex: 1, color: '#888', fontSize: '11px' };
const rowFlex: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 4, marginBottom: 2 };

/** Read the selected entity's material GUID (Renderable3D / Renderable3DPrimitive, or
 *  the 2D `Renderable2D.material` — a `space:'2d'` `.shader.json`). */
function materialGuidOf(entityId: number): string {
  const r3d = getTraitByName('Renderable3D');
  const rp = getTraitByName('Renderable3DPrimitive');
  const r2d = getTraitByName('Renderable2D');
  const a = (r3d && readTraitData(entityId, r3d)?.material) as string | undefined;
  const b = (rp && readTraitData(entityId, rp)?.material) as string | undefined;
  const c = (r2d && readTraitData(entityId, r2d)?.material) as string | undefined;
  return a || b || c || '';
}

/** Partition a shader param schema into uniform (non-texture) names and texture names. */
export function partitionParams(params: Record<string, { type?: string }>): { uniforms: string[]; textures: string[] } {
  const uniforms: string[] = [], textures: string[] = [];
  for (const [k, p] of Object.entries(params)) (p?.type === 'texture' ? textures : uniforms).push(k);
  return { uniforms, textures };
}

/** Resolve a material GUID → its custom-shader param names, split into `uniforms` (scalar/vec —
 *  drivable by a `uniform` override) and `textures` (extra-sampler params — swappable by a
 *  `texture` override, 2D only). `is2D` marks a `space:'2d'` `.shader.json` material (the only
 *  place a `texture` override applies). Async; empty for built-in/unresolved materials. Keyed on
 *  the GUID (not the dirty tick) so it refetches only when the material changes — no chip flicker. */
function useShaderUniforms(guid: string): { uniforms: string[]; textures: string[]; is2D: boolean } {
  const [out, setOut] = useState<{ uniforms: string[]; textures: string[]; is2D: boolean }>({ uniforms: [], textures: [], is2D: false });
  useEffect(() => {
    let cancelled = false;
    setOut({ uniforms: [], textures: [], is2D: false });
    if (!guid) return;
    const path = isGuid(guid) ? (resolveGuidToPath(guid) ?? resolveRef(guid)) : guid;
    if (!path) return;
    fetch(path)
      .then((r) => (r.ok ? r.json() : null))
      .then(async (data: Record<string, unknown> | null) => {
        if (!data || cancelled) return;
        // A 2D material GUID resolves to a `.shader.json` manifest DIRECTLY (the shader IS
        // the material), so its `params` are the uniform/texture names — no .mat.json indirection.
        if (data.params && typeof data.params === 'object') {
          const { uniforms, textures } = partitionParams(data.params as Record<string, { type?: string }>);
          if (!cancelled) setOut({ uniforms, textures, is2D: (data.space === '2d') });
          return;
        }
        const value = optionValueForMaterial(data);
        const opt = listShaderOptions().find((o) => o.value === value);
        const schema = opt ? await resolveShaderSchema(opt) : null;
        if (!cancelled) setOut({ ...partitionParams((schema ?? {}) as Record<string, { type?: string }>), is2D: false });
      })
      .catch(() => { /* material fetch failed — no suggestions */ });
    return () => { cancelled = true; };
  }, [guid]);
  return out;
}

/** Clickable suggestion chips that set the row's target. */
function Suggestions({ options, onPick }: { options: string[]; onPick: (v: string) => void }) {
  if (options.length === 0) return null;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, margin: '1px 0 3px' }}>
      {options.map((o) => (
        <span key={o} onClick={() => onPick(o)} title={`Use "${o}"`}
          style={{ cursor: 'pointer', fontSize: '10px', color: '#8ac', background: '#1b2430', border: '1px solid #345', borderRadius: 3, padding: '0 4px' }}>{o}</span>
      ))}
    </div>
  );
}

export function MaterialOverridesField({ entityIds, meta, field }: { entityIds: number[]; meta: TraitMeta; field: string }) {
  const [, setTick] = useState(0);
  const bump = () => setTick((t) => t + 1);
  useWorldDirtyTick(); // re-render when the world changes (e.g. material ref edited elsewhere)

  const allRows: MaterialParamOverride[][] = entityIds.map((id) => {
    const a = readTraitData(id, meta)?.[field];
    return Array.isArray(a) ? (a as MaterialParamOverride[]) : [];
  });
  const rows = allRows[0] ?? [];
  const multi = entityIds.length > 1;
  const rowsDiffer = multi && allRows.some((arr) => arr.length !== rows.length);

  // Param-name suggestions come from the entity's material; keyed on the GUID so the fetch
  // runs only when the material changes, not on every override edit. `textures`/`is2D` gate
  // the `texture` override kind (a per-instance extra-sampler swap — 2D custom materials only).
  const { uniforms: uniformNames, textures: textureNames, is2D } = useShaderUniforms(entityIds[0] != null ? materialGuidOf(entityIds[0]) : '');

  const update = (i: number, makePatch: (row: MaterialParamOverride) => Partial<MaterialParamOverride>) => {
    writeFieldPerEntity(entityIds, meta, field, (old) => {
      const arr = Array.isArray(old) ? (old as MaterialParamOverride[]) : [];
      if (i >= arr.length) return old;
      return arr.map((o, idx) => idx === i ? { ...o, ...makePatch(o) } : o);
    }, `Edit material override`);
    bump();
  };
  const patchSource = (i: number, patch: Partial<Record<string, unknown>>) =>
    update(i, (row) => ({ source: { ...(row.source as Record<string, unknown>), ...patch } as MaterialParamSource }));
  const remove = (i: number) => {
    writeFieldPerEntity(entityIds, meta, field, (old) => {
      const arr = Array.isArray(old) ? (old as MaterialParamOverride[]) : [];
      return arr.filter((_, idx) => idx !== i);
    }, `Remove material override`);
    bump();
  };
  const add = () => {
    const fresh: MaterialParamOverride = { target: '', kind: 'uniform', source: { type: 'constant', value: 0 } };
    writeFieldPerEntity(entityIds, meta, field, (old) => {
      const arr = Array.isArray(old) ? (old as MaterialParamOverride[]) : [];
      return [...arr, fresh];
    }, `Add material override`);
    bump();
  };

  if (multi) {
    // Composite override arrays are awkward to merge across a heterogeneous multi-selection, so
    // editing (add/remove/edit) is fully disabled here — select ONE entity to edit its overrides.
    return <div style={{ color: '#aa8', fontSize: '11px', marginBottom: 4 }}>Select a single entity to edit material overrides.</div>;
  }

  return (
    <div style={{ marginBottom: 4 }}>
      <FieldLabel label="overrides" style={{ color: '#888', fontSize: '11px' }} />
      {rowsDiffer && <div style={{ color: '#aa8', fontSize: '10px', marginBottom: 4 }}>Rows differ across selection.</div>}
      {rows.map((o, i) => {
        const kind = (o.kind || 'uniform') as 'uniform' | 'prop' | 'texture';
        const src = (o.source || { type: 'constant', value: 0 }) as Record<string, unknown>;
        const srcType = String(src.type || 'constant');
        const suggestions = kind === 'prop' ? STANDARD_PROPS : kind === 'texture' ? textureNames : uniformNames;
        return (
          <div key={i} style={rowStyle}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 }}>
              <span style={{ color: '#666', fontSize: '10px' }}>override {i + 1}</span>
              <span onClick={() => remove(i)} title="Remove" style={{ cursor: 'pointer', color: '#888', padding: '0 2px' }}>×</span>
            </div>

            {/* Switching TO texture drops the (unused) source + seeds a ref; switching AWAY
                seeds a default source so the row stays valid. */}
            <DropdownField label="kind" value={kind} options={kindOptionsForRow(kind, is2D)} onChange={(v) => update(i, (row) => (
              v === 'texture' ? { kind: 'texture', ref: row.ref ?? '', source: undefined }
                : { kind: v as 'uniform' | 'prop', ref: undefined, source: row.source ?? defaultSource('constant') }
            ))} />

            <div style={rowFlex}>
              <span style={lblStyle}>target</span>
              <div style={{ flex: 1 }}>
                <BufferedTextInput value={o.target || ''} onChange={(v) => update(i, () => ({ target: v }))}
                  style={{ ...inputStyle, width: '100%' }} placeholder={kind === 'prop' ? 'e.g. opacity' : kind === 'texture' ? 'texture param name' : 'uniform name'} />
              </div>
            </div>
            <Suggestions options={suggestions} onPick={(v) => update(i, () => ({ target: v }))} />

            {kind === 'texture' ? (
              // A texture override binds a sprite/texture GUID (accept:['sprite'] gives the picker),
              // overriding the param's manifest default for this instance — no source.
              <AssetRefField label="ref" value={o.ref || ''} accept={['sprite']} placeholder="sprite/texture"
                onChange={(v) => update(i, () => ({ ref: v }))} />
            ) : (<>
            <DropdownField label="source" value={srcType} options={SOURCE_OPTS}
              onChange={(v) => update(i, () => ({ source: defaultSource(v) }))} />

            {srcType === 'constant' && (
              <div style={rowFlex}>
                <span style={lblStyle}>value</span>
                <div style={{ flex: 1, display: 'flex' }}>
                  <FieldValueWidget hint={{ type: kind === 'prop' && COLOR_TARGETS.has(o.target) ? 'color' : 'number', step: 0.05 }}
                    value={src.value} onChange={(v) => patchSource(i, { value: v })} />
                </div>
              </div>
            )}

            {srcType === 'time' && (<>
              <NumRow label="speed" value={num(src.speed, 1)} step={0.05} onChange={(v) => patchSource(i, { speed: v })} />
              <NumRow label="wrap (s)" value={num(src.wrap, 10000)} step={1} onChange={(v) => patchSource(i, { wrap: v })} />
              <DropdownField label="base" value={String(src.base || 'visual')} options={['visual', 'sim']}
                onChange={(v) => patchSource(i, { base: v })} />
            </>)}

            {srcType === 'store' && (<>
              <div style={rowFlex}>
                <span style={lblStyle}>key</span>
                <div style={{ flex: 1 }}>
                  <BufferedTextInput value={String(src.key || '')} onChange={(v) => patchSource(i, { key: v })}
                    style={{ ...inputStyle, width: '100%' }} placeholder="read-source key" />
                </div>
              </div>
              <NumRow label="scale" value={num(src.scale, 1)} step={0.05} onChange={(v) => patchSource(i, { scale: v })} />
              <NumRow label="default" value={num(src.default, 0)} step={0.05} onChange={(v) => patchSource(i, { default: v })} />
            </>)}

            {srcType === 'curve' && (
              <div style={{ color: '#888', fontSize: '10px', padding: '2px 0' }}>
                curve ({Array.isArray(src.points) ? (src.points as unknown[]).length : 0} points) — edit points/driver in the scene JSON.
              </div>
            )}
            </>)}
          </div>
        );
      })}
      <button onClick={add} style={{ fontSize: '11px', background: '#2a2a40', color: '#ccc', border: '1px solid #444', borderRadius: 3, padding: '2px 8px', cursor: 'pointer' }}>+ Add override</button>
      {rows.length === 0 && <span style={{ color: '#666', fontSize: '10px', marginLeft: 6 }}>no overrides</span>}
    </div>
  );
}

export function num(v: unknown, fallback: number): number { return typeof v === 'number' ? v : fallback; }

export function defaultSource(type: string): MaterialParamSource {
  switch (type) {
    case 'time': return { type: 'time' };
    case 'store': return { type: 'store', key: '' };
    case 'curve': return { type: 'curve', points: [{ t: 0, v: 0 }, { t: 1, v: 1 }], driver: { type: 'time', wrap: 1 } };
    default: return { type: 'constant', value: 0 };
  }
}

/** A compact labelled number row. */
function NumRow({ label, value, step, onChange }: { label: string; value: number; step: number; onChange: (v: number) => void }) {
  return (
    <div style={rowFlex}>
      <span style={lblStyle}>{label}</span>
      <div style={{ flex: 1, display: 'flex' }}>
        <BufferedNumberInput value={value} step={step} onChange={onChange} style={{ ...inputStyle, flex: 1 }} />
      </div>
    </div>
  );
}
