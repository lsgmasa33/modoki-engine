/** MaterialAssetView (+ its ParamField widget) — shader/material file editor.
 *  Extracted from Inspector.tsx (editor-inspector.md F2). Undo/redo persists
 *  against the file+cache via persistAssetEdit (F10), not panel-local state. */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { pushAction } from '../../undo/undoManager';
import { listShaderOptions, optionValueForMaterial, materialFieldsForOption, resolveShaderSchema, type ShaderKind } from '../../shaderCatalog';
import { mergeParamDefaults, type ShaderParam, type ShaderParamSchema } from '../../../runtime/loaders/shaderSchema';
import { inputStyle, BufferedNumberInput } from '../fields';
import { AssetRefField } from '../AssetRefField';
import { ColorField, NumberField, DropdownField, DEFAULT_COLOR } from './widgets';
import { clampNum, persistAssetEdit, useAssetViewRefresher, invalidateMaterialFile } from './persist';
import { parseAssetJson, isMissingAsset } from '../../../runtime/loaders/assetFetch';
import { MaterialPreview } from '../MaterialPreview';

/** One inspector widget for a shader param, dispatched by its schema type. When
 *  `mixed` (multi-select, values differ across the selection) the widget shows a
 *  non-committal placeholder; picking a value broadcasts it to all. */
export function ParamField({ name, param, value, onChange, mixed = false, idPrefix }: {
  name: string; param: ShaderParam; value: unknown; onChange: (v: unknown) => void; mixed?: boolean;
  /** Namespace for this field's `data-ui-id`, WITHOUT a trailing dot — e.g.
   *  `assetView.material.param`. REQUIRED, so the type checker enumerates every caller.
   *
   *  ⚠️ This was hardcoded to `assetView.material.param.${name}` and two of the three callers were
   *  wrong (#830 review). `ShaderAssetView` renders one ParamField per shader param with the
   *  LITERAL `name="default"`, so a shader with N float params emitted N elements all carrying
   *  `assetView.material.param.default` — `modoki_tap` drives whichever the DOM ordered first, and
   *  the correctly-namespaced `assetView.shader.param.<key>.min|max|step` siblings sat right beside
   *  them. `MaterialBatchView` emitted the `material` namespace while its own fields are
   *  `materialBatch`. There is no duplicate-`data-ui-id` guard anywhere, so nothing caught it. */
  idPrefix: string;
}) {
  const label = param.label || name;
  switch (param.type) {
    case 'texture':
      return <AssetRefField label={label} value={(value as string) ?? ''} onChange={onChange} accept={['.png', '.jpg', '.jpeg', '.webp']} mixed={mixed}
        dataUiId={`${idPrefix}.${name}`} dataUiLabel={label} />;
    case 'color':
      return <ColorField label={label} value={(value as number) ?? (param.default as number) ?? DEFAULT_COLOR} onChange={onChange} mixed={mixed} />;
    case 'bool':
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 2 }}>
          <span style={{ flex: 1, color: '#888', fontSize: '11px' }}>{label}</span>
          <input data-ui-id={`${idPrefix}.${name}`} data-ui-kind="toggle" data-ui-label={label} data-ui-state={mixed ? 'mixed' : value ? 'checked' : 'unchecked'} type="checkbox" checked={mixed ? false : !!value} ref={(el) => { if (el) el.indeterminate = mixed; }} onChange={e => onChange(e.target.checked)} />
        </div>
      );
    case 'float':
      return <NumberField label={label} value={(value as number) ?? (param.default as number) ?? 0}
        step={param.step ?? 0.01} wide mixed={mixed} onChange={v => onChange(clampNum(v, param.min, param.max))}
        dataUiId={`${idPrefix}.${name}`} />;
    default: {
      const n = param.type === 'vec2' ? 2 : param.type === 'vec3' ? 3 : 4;
      const arr = Array.isArray(value) ? (value as number[]) : ((param.default as number[]) ?? new Array(n).fill(0));
      return (
        <div style={{ marginBottom: 3 }}>
          <div style={{ color: '#888', fontSize: '10px', marginBottom: 2 }}>{label}</div>
          <div style={{ display: 'inline-flex', gap: 3, width: '100%' }}>
            {Array.from({ length: n }, (_, i) => (
              <BufferedNumberInput key={i} value={arr[i] ?? 0} step={param.step ?? 0.01} mixed={mixed}
                onChange={c => { const next = arr.slice(0, n); while (next.length < n) next.push(0); next[i] = c; onChange(next); }}
                style={{ ...inputStyle, flex: 1, minWidth: 0 }}
                dataUiId={`${idPrefix}.${name}.${i}`} dataUiLabel={label} />
            ))}
          </div>
        </div>
      );
    }
  }
}

export function MaterialAssetView({ path }: { path: string }) {
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const dataRef = useRef(data);
  dataRef.current = data;
  const [schema, setSchema] = useState<ShaderParamSchema | null>(null);
  const [schemaLoading, setSchemaLoading] = useState(false);

  useEffect(() => {
    const ac = new AbortController();
    fetch(path, { signal: ac.signal })
      .then(r => parseAssetJson(r, path))
      .catch(e => { if (isMissingAsset(e)) return null; throw e; })
      .then((data) => setData(data as Record<string, unknown> | null))
      .catch(e => { if (e.name !== 'AbortError') setData(null); });
    return () => ac.abort();
  }, [path]);
  useAssetViewRefresher(path, setData);

  const writeData = useCallback((updated: Record<string, unknown>, label: string) => {
    const old = dataRef.current;
    if (!old) return;
    persistAssetEdit(path, updated, invalidateMaterialFile);
    pushAction({
      // Asset-FILE edit: persistAssetEdit already wrote it to disk, so there is nothing pending for
      // the scene's edit-version to represent — the literal case this flag names. Without it, editing
      // a material marked the SCENE dirty, which self-blocks the file-direct agent routes and makes
      // modoki_build refuse over a file that is already saved.
      _isFileDirect: true,
      label,
      undo: () => persistAssetEdit(path, old, invalidateMaterialFile),
      redo: () => persistAssetEdit(path, updated, invalidateMaterialFile),
    });
  }, [path]);

  const writeField = useCallback((field: string, value: unknown) => {
    if (!dataRef.current) return;
    writeData({ ...dataRef.current, [field]: value }, `Edit material ${field}`);
  }, [writeData]);

  const writeParam = useCallback((key: string, value: unknown) => {
    const cur = dataRef.current;
    if (!cur) return;
    const params = { ...((cur.params as Record<string, unknown>) ?? {}) };
    params[key] = value;
    writeData({ ...cur, params }, `Edit ${key}`);
  }, [writeData]);

  const shaderValue = data ? optionValueForMaterial(data) : 'pbr';

  // Build options, ensuring the current selection appears even if its asset
  // hasn't loaded into the manifest yet.
  const options = useMemo(() => {
    const opts = listShaderOptions();
    if (data && !opts.some(o => o.value === shaderValue)) {
      opts.push({ label: shaderValue, value: shaderValue, kind: 'file' });
    }
    return opts;
  }, [data, shaderValue]);

  const currentOption = options.find(o => o.value === shaderValue) ?? options[0];
  const currentKind: ShaderKind = currentOption.kind;

  // Load the param schema for the current selection.
  useEffect(() => {
    let cancelled = false;
    if (currentKind === 'builtin') { setSchema(null); setSchemaLoading(false); return; }
    setSchemaLoading(true);
    resolveShaderSchema({ kind: currentKind, value: shaderValue })
      .then(s => { if (!cancelled) { setSchema(s); setSchemaLoading(false); } });
    return () => { cancelled = true; };
  }, [currentKind, shaderValue]);

  const changeShader = useCallback(async (newValue: string) => {
    const cur = dataRef.current;
    if (!cur) return;
    const opt = listShaderOptions().find(o => o.value === newValue) ?? { kind: 'file' as ShaderKind, value: newValue, label: newValue };
    const fields = materialFieldsForOption(newValue);
    const updated: Record<string, unknown> = { ...cur, type: fields.type };
    if (fields.shader !== undefined) updated.shader = fields.shader; else delete updated.shader;
    if (fields.type === 'custom') {
      const sch = await resolveShaderSchema(opt);
      updated.params = sch ? mergeParamDefaults(sch, cur.params as Record<string, unknown>) : ((cur.params as Record<string, unknown>) ?? {});
    } else {
      delete updated.params;
    }
    writeData(updated, 'Change shader');
  }, [writeData]);

  if (!data) return <div style={{ color: '#555', fontSize: '11px', padding: 4 }}>Loading...</div>;

  const isCustom = currentKind !== 'builtin';
  const isUnlit = shaderValue === 'unlit';
  const params = (data.params as Record<string, unknown>) ?? {};

  // Local helpers for the standard-material section (every MeshStandardMaterial slot).
  const IMG: string[] = ['.png', '.jpg', '.jpeg', '.webp'];
  const d = data as Record<string, unknown>;
  const texField = (field: string, label: string) => (
    <AssetRefField label={label} value={(d[field] as string) ?? ''} onChange={(v) => writeField(field, v)} accept={IMG}
      dataUiId={`assetView.material.${field}`} dataUiLabel={label} />
  );
  const boolField = (field: string, label: string, dflt = false) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 2 }}>
      <span style={{ flex: 1, color: '#888', fontSize: '11px' }}>{label}</span>
      <input data-ui-id={`assetView.material.${field}`} data-ui-kind="toggle" data-ui-label={label} data-ui-state={((d[field] as boolean) ?? dflt) ? 'checked' : 'unchecked'} type="checkbox" checked={(d[field] as boolean) ?? dflt} onChange={(e) => writeField(field, e.target.checked)} />
    </div>
  );
  const sectionHeader = (label: string) => (
    <div style={{ color: '#9aa', fontSize: '10px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', margin: '8px 0 3px' }}>{label}</div>
  );

  return (
    <>
      <MaterialPreview data={data} />
      {/* Shader picker */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 6 }}>
        <span style={{ flex: 1, color: '#888', fontSize: '11px' }}>Shader</span>
        <select data-ui-id="assetView.material.shader" data-ui-kind="field" data-ui-label="Shader" value={shaderValue} onChange={e => changeShader(e.target.value)} style={{ ...inputStyle, flex: 1 }}>
          {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>

      {/* Built-in standard / unlit fields — full MeshStandardMaterial surface.
          Unlit (MeshBasicMaterial) only honors the color/alpha/wireframe subset, so
          the PBR-only sections are gated on !isUnlit. */}
      {!isCustom && (
        <>
          {sectionHeader('Surface')}
          <ColorField label="Color" value={(data.color as number) ?? DEFAULT_COLOR} onChange={v => writeField('color', v)} />
          {!isUnlit && <NumberField label="Roughness" value={(data.roughness as number) ?? 1} step={0.01} onChange={v => writeField('roughness', v)} wide dataUiId="assetView.material.roughness" />}
          {!isUnlit && <NumberField label="Metalness" value={(data.metalness as number) ?? 0} step={0.01} onChange={v => writeField('metalness', v)} wide dataUiId="assetView.material.metalness" />}
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 2 }}>
            <span style={{ flex: 1, color: '#888', fontSize: '11px' }}>Transparent</span>
            <input data-ui-id="assetView.material.transparent" data-ui-kind="toggle" data-ui-label="Transparent" data-ui-state={data.transparent ? 'checked' : 'unchecked'} type="checkbox" checked={!!data.transparent} onChange={e => writeField('transparent', e.target.checked)} />
          </div>
          <NumberField label="Opacity" value={(data.opacity as number) ?? 1} step={0.01} onChange={v => writeField('opacity', v)} wide dataUiId="assetView.material.opacity" />
          <DropdownField label="Side" value={(data.side as string) ?? 'front'} options={['front', 'double', 'back']} onChange={v => writeField('side', v)} />
          <NumberField label="Alpha Test" value={(data.alphaTest as number) ?? 0} step={0.01} onChange={v => writeField('alphaTest', v)} wide dataUiId="assetView.material.alphaTest" />
          {!isUnlit && <NumberField label="Env Intensity" value={(data.envMapIntensity as number) ?? 1} step={0.1} onChange={v => writeField('envMapIntensity', v)} wide dataUiId="assetView.material.envMapIntensity" />}
          {boolField('flipY', 'Flip Y')}
          {boolField('flatShading', 'Flat Shading')}
          {boolField('wireframe', 'Wireframe')}
          {boolField('vertexColors', 'Vertex Colors')}

          {!isUnlit && sectionHeader('Emission')}
          {!isUnlit && <ColorField label="Emissive" value={(data.emissive as number) ?? 0} onChange={v => writeField('emissive', v)} />}
          {!isUnlit && <NumberField label="Emissive Intensity" value={(data.emissiveIntensity as number) ?? 1} step={0.05} onChange={v => writeField('emissiveIntensity', v)} wide dataUiId="assetView.material.emissiveIntensity" />}

          {sectionHeader('Maps')}
          {/* Tiling — UV repeat applied to ALL maps (higher = smaller/more tiles).
              Stored as [x,y]; a bare number is read as uniform. */}
          {(() => {
            const tr = data.textureRepeat;
            const rx = Array.isArray(tr) ? Number(tr[0]) || 1 : typeof tr === 'number' ? tr : 1;
            const ry = Array.isArray(tr) ? Number(tr[1]) || 1 : typeof tr === 'number' ? tr : 1;
            return (
              <>
                <NumberField label="Tiling X" value={rx} step={0.1} wide onChange={v => writeField('textureRepeat', [Math.max(0.01, v), ry])} dataUiId="assetView.material.textureRepeat.x" />
                <NumberField label="Tiling Y" value={ry} step={0.1} wide onChange={v => writeField('textureRepeat', [rx, Math.max(0.01, v)])} dataUiId="assetView.material.textureRepeat.y" />
              </>
            );
          })()}
          {texField('texture', 'Base Color')}
          {texField('alphaTexture', 'Alpha')}
          {!isUnlit && texField('normalTexture', 'Normal')}
          {!isUnlit && <NumberField label="Normal Scale" value={(data.normalScale as number) ?? 1} step={0.05} onChange={v => writeField('normalScale', v)} wide dataUiId="assetView.material.normalScale" />}
          {!isUnlit && texField('bumpTexture', 'Bump')}
          {!isUnlit && <NumberField label="Bump Scale" value={(data.bumpScale as number) ?? 1} step={0.05} onChange={v => writeField('bumpScale', v)} wide dataUiId="assetView.material.bumpScale" />}
          {!isUnlit && texField('roughnessTexture', 'Roughness')}
          {!isUnlit && texField('metalnessTexture', 'Metalness')}
          {!isUnlit && texField('emissiveTexture', 'Emissive')}
          {!isUnlit && texField('aoTexture', 'Ambient Occlusion')}
          {!isUnlit && <NumberField label="AO Intensity" value={(data.aoMapIntensity as number) ?? 1} step={0.05} onChange={v => writeField('aoMapIntensity', v)} wide dataUiId="assetView.material.aoMapIntensity" />}
          {!isUnlit && texField('lightTexture', 'Light Map')}
          {!isUnlit && <NumberField label="Light Intensity" value={(data.lightMapIntensity as number) ?? 1} step={0.05} onChange={v => writeField('lightMapIntensity', v)} wide dataUiId="assetView.material.lightMapIntensity" />}
          {!isUnlit && texField('displacementTexture', 'Displacement')}
          {!isUnlit && <NumberField label="Displacement Scale" value={(data.displacementScale as number) ?? 1} step={0.01} onChange={v => writeField('displacementScale', v)} wide dataUiId="assetView.material.displacementScale" />}
          {!isUnlit && <NumberField label="Displacement Bias" value={(data.displacementBias as number) ?? 0} step={0.01} onChange={v => writeField('displacementBias', v)} wide dataUiId="assetView.material.displacementBias" />}
          {!isUnlit && texField('envTexture', 'Environment (equirect)')}
        </>
      )}

      {/* Custom shader params */}
      {isCustom && (
        <>
          {schema && Object.keys(schema).length > 0 ? (
            Object.entries(schema).map(([key, param]) => (
              <ParamField key={key} name={key} param={param} value={params[key]} onChange={v => writeParam(key, v)} idPrefix="assetView.material.param" />
            ))
          ) : schemaLoading ? (
            <div style={{ color: '#666', fontSize: '11px', padding: '4px 0' }}>Loading shader parameters...</div>
          ) : (
            // No schema declared — fall back to untyped widgets inferred from stored values.
            <>
              {Object.keys(params).length === 0 && (
                <div style={{ color: '#666', fontSize: '11px', padding: '4px 0' }}>This shader exposes no parameters.</div>
              )}
              {Object.entries(params).map(([key, v]) =>
                typeof v === 'boolean' ? (
                  <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 2 }}>
                    <span style={{ flex: 1, color: '#888', fontSize: '11px' }}>{key}</span>
                    <input data-ui-id={`assetView.material.param.${key}`} data-ui-kind="toggle" data-ui-label={key} data-ui-state={v ? 'checked' : 'unchecked'} type="checkbox" checked={v} onChange={e => writeParam(key, e.target.checked)} />
                  </div>
                ) : typeof v === 'number' ? (
                  <NumberField key={key} label={key} value={v} step={0.01} onChange={nv => writeParam(key, nv)} wide dataUiId={`assetView.material.param.${key}`} />
                ) : null
              )}
            </>
          )}
          <DropdownField label="Side" value={(data.side as string) ?? 'front'} options={['front', 'double']} onChange={v => writeField('side', v)} />
        </>
      )}
      {/* NPR outline color + color preserve — apply to every material type.
          lineColor defaults to black; colorPreserve 0 = full NPR grayscale,
          1 = keep the material's true color (outline still drawn). A file
          shader with colorPreserve:'alpha' overrides preserve per-pixel. */}
      <ColorField label="Line Color" value={(data.lineColor as number) ?? 0} onChange={v => writeField('lineColor', v)} />
      <NumberField label="Color Preserve" value={(data.nprColorPreserve as number) ?? 0} step={0.05} wide onChange={v => writeField('nprColorPreserve', clampNum(v, 0, 1))} dataUiId="assetView.material.nprColorPreserve" />
    </>
  );
}
