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
import { MaterialPreview } from '../MaterialPreview';

/** One inspector widget for a shader param, dispatched by its schema type. When
 *  `mixed` (multi-select, values differ across the selection) the widget shows a
 *  non-committal placeholder; picking a value broadcasts it to all. */
export function ParamField({ name, param, value, onChange, mixed = false }: {
  name: string; param: ShaderParam; value: unknown; onChange: (v: unknown) => void; mixed?: boolean;
}) {
  const label = param.label || name;
  switch (param.type) {
    case 'texture':
      return <AssetRefField label={label} value={(value as string) ?? ''} onChange={onChange} accept={['.png', '.jpg', '.jpeg', '.webp']} mixed={mixed} />;
    case 'color':
      return <ColorField label={label} value={(value as number) ?? (param.default as number) ?? DEFAULT_COLOR} onChange={onChange} mixed={mixed} />;
    case 'bool':
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 2 }}>
          <span style={{ flex: 1, color: '#888', fontSize: '11px' }}>{label}</span>
          <input type="checkbox" checked={mixed ? false : !!value} ref={(el) => { if (el) el.indeterminate = mixed; }} onChange={e => onChange(e.target.checked)} />
        </div>
      );
    case 'float':
      return <NumberField label={label} value={(value as number) ?? (param.default as number) ?? 0}
        step={param.step ?? 0.01} wide mixed={mixed} onChange={v => onChange(clampNum(v, param.min, param.max))} />;
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
                style={{ ...inputStyle, flex: 1, minWidth: 0 }} />
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
      .then(r => r.ok ? r.json() : null)
      .then(setData)
      .catch(e => { if (e.name !== 'AbortError') setData(null); });
    return () => ac.abort();
  }, [path]);
  useAssetViewRefresher(path, setData);

  const writeData = useCallback((updated: Record<string, unknown>, label: string) => {
    const old = dataRef.current;
    if (!old) return;
    persistAssetEdit(path, updated, invalidateMaterialFile);
    pushAction({
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
    <AssetRefField label={label} value={(d[field] as string) ?? ''} onChange={(v) => writeField(field, v)} accept={IMG} />
  );
  const boolField = (field: string, label: string, dflt = false) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 2 }}>
      <span style={{ flex: 1, color: '#888', fontSize: '11px' }}>{label}</span>
      <input type="checkbox" checked={(d[field] as boolean) ?? dflt} onChange={(e) => writeField(field, e.target.checked)} />
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
        <select value={shaderValue} onChange={e => changeShader(e.target.value)} style={{ ...inputStyle, flex: 1 }}>
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
          {!isUnlit && <NumberField label="Roughness" value={(data.roughness as number) ?? 1} step={0.01} onChange={v => writeField('roughness', v)} wide />}
          {!isUnlit && <NumberField label="Metalness" value={(data.metalness as number) ?? 0} step={0.01} onChange={v => writeField('metalness', v)} wide />}
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 2 }}>
            <span style={{ flex: 1, color: '#888', fontSize: '11px' }}>Transparent</span>
            <input type="checkbox" checked={!!data.transparent} onChange={e => writeField('transparent', e.target.checked)} />
          </div>
          <NumberField label="Opacity" value={(data.opacity as number) ?? 1} step={0.01} onChange={v => writeField('opacity', v)} wide />
          <DropdownField label="Side" value={(data.side as string) ?? 'front'} options={['front', 'double', 'back']} onChange={v => writeField('side', v)} />
          <NumberField label="Alpha Test" value={(data.alphaTest as number) ?? 0} step={0.01} onChange={v => writeField('alphaTest', v)} wide />
          {!isUnlit && <NumberField label="Env Intensity" value={(data.envMapIntensity as number) ?? 1} step={0.1} onChange={v => writeField('envMapIntensity', v)} wide />}
          {boolField('flipY', 'Flip Y')}
          {boolField('flatShading', 'Flat Shading')}
          {boolField('wireframe', 'Wireframe')}
          {boolField('vertexColors', 'Vertex Colors')}

          {!isUnlit && sectionHeader('Emission')}
          {!isUnlit && <ColorField label="Emissive" value={(data.emissive as number) ?? 0} onChange={v => writeField('emissive', v)} />}
          {!isUnlit && <NumberField label="Emissive Intensity" value={(data.emissiveIntensity as number) ?? 1} step={0.05} onChange={v => writeField('emissiveIntensity', v)} wide />}

          {sectionHeader('Maps')}
          {/* Tiling — UV repeat applied to ALL maps (higher = smaller/more tiles).
              Stored as [x,y]; a bare number is read as uniform. */}
          {(() => {
            const tr = data.textureRepeat;
            const rx = Array.isArray(tr) ? Number(tr[0]) || 1 : typeof tr === 'number' ? tr : 1;
            const ry = Array.isArray(tr) ? Number(tr[1]) || 1 : typeof tr === 'number' ? tr : 1;
            return (
              <>
                <NumberField label="Tiling X" value={rx} step={0.1} wide onChange={v => writeField('textureRepeat', [Math.max(0.01, v), ry])} />
                <NumberField label="Tiling Y" value={ry} step={0.1} wide onChange={v => writeField('textureRepeat', [rx, Math.max(0.01, v)])} />
              </>
            );
          })()}
          {texField('texture', 'Base Color')}
          {texField('alphaTexture', 'Alpha')}
          {!isUnlit && texField('normalTexture', 'Normal')}
          {!isUnlit && <NumberField label="Normal Scale" value={(data.normalScale as number) ?? 1} step={0.05} onChange={v => writeField('normalScale', v)} wide />}
          {!isUnlit && texField('bumpTexture', 'Bump')}
          {!isUnlit && <NumberField label="Bump Scale" value={(data.bumpScale as number) ?? 1} step={0.05} onChange={v => writeField('bumpScale', v)} wide />}
          {!isUnlit && texField('roughnessTexture', 'Roughness')}
          {!isUnlit && texField('metalnessTexture', 'Metalness')}
          {!isUnlit && texField('emissiveTexture', 'Emissive')}
          {!isUnlit && texField('aoTexture', 'Ambient Occlusion')}
          {!isUnlit && <NumberField label="AO Intensity" value={(data.aoMapIntensity as number) ?? 1} step={0.05} onChange={v => writeField('aoMapIntensity', v)} wide />}
          {!isUnlit && texField('lightTexture', 'Light Map')}
          {!isUnlit && <NumberField label="Light Intensity" value={(data.lightMapIntensity as number) ?? 1} step={0.05} onChange={v => writeField('lightMapIntensity', v)} wide />}
          {!isUnlit && texField('displacementTexture', 'Displacement')}
          {!isUnlit && <NumberField label="Displacement Scale" value={(data.displacementScale as number) ?? 1} step={0.01} onChange={v => writeField('displacementScale', v)} wide />}
          {!isUnlit && <NumberField label="Displacement Bias" value={(data.displacementBias as number) ?? 0} step={0.01} onChange={v => writeField('displacementBias', v)} wide />}
          {!isUnlit && texField('envTexture', 'Environment (equirect)')}
        </>
      )}

      {/* Custom shader params */}
      {isCustom && (
        <>
          {schema && Object.keys(schema).length > 0 ? (
            Object.entries(schema).map(([key, param]) => (
              <ParamField key={key} name={key} param={param} value={params[key]} onChange={v => writeParam(key, v)} />
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
                    <input type="checkbox" checked={v} onChange={e => writeParam(key, e.target.checked)} />
                  </div>
                ) : typeof v === 'number' ? (
                  <NumberField key={key} label={key} value={v} step={0.01} onChange={nv => writeParam(key, nv)} wide />
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
      <NumberField label="Color Preserve" value={(data.nprColorPreserve as number) ?? 0} step={0.05} wide onChange={v => writeField('nprColorPreserve', clampNum(v, 0, 1))} />
    </>
  );
}
