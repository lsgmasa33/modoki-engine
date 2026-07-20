/** ShaderAssetView — Inspector view for a `.shader.json` (a custom-shader MANIFEST).
 *  Unlike MaterialAssetView (which edits a `.mat.json`'s param VALUES), this shows the
 *  shader's DECLARED params — the contract a material/MaterialInstance drives — and lets
 *  you tune each param's `default` (via the type-appropriate ParamField widget) plus its
 *  numeric `min`/`max`/`step` and `label`. The WGSL/GLSL bodies are code and are edited as
 *  the sibling `.wgsl`/`.glsl` files, not here (shown as a note). Edits persist to the file
 *  + undo via persistAssetEdit; they apply on the next scene load / material rebuild. */

import { useState, useEffect, useRef, useCallback } from 'react';
import { pushAction } from '../../undo/undoManager';
import type { ShaderParam, ShaderParamType } from '../../../runtime/loaders/shaderSchema';
import { BufferedTextInput, inputStyle } from '../fields';
import { NumberField } from './widgets';
import { persistAssetEdit, useAssetViewRefresher, invalidateShaderFile } from './persist';
import { ParamField } from './MaterialAssetView';
import { ShaderPreview } from '../ShaderPreview';

const NUMERIC: ReadonlySet<ShaderParamType> = new Set<ShaderParamType>(['float', 'vec2', 'vec3', 'vec4']);

const rowStyle: React.CSSProperties = { border: '1px solid #333', borderRadius: 3, padding: '5px 6px', marginBottom: 5 };
const lblStyle: React.CSSProperties = { flex: 1, color: '#888', fontSize: '11px' };
const rowFlex: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 4, marginBottom: 2 };
const badge: React.CSSProperties = { fontSize: '9px', color: '#8ac', background: '#1b2430', border: '1px solid #345', borderRadius: 3, padding: '0 4px', textTransform: 'uppercase', letterSpacing: '0.03em' };

export function ShaderAssetView({ path }: { path: string }) {
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const dataRef = useRef(data);
  dataRef.current = data;

  useEffect(() => {
    const ac = new AbortController();
    fetch(path, { signal: ac.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then(setData)
      .catch((e) => { if (e.name !== 'AbortError') setData(null); });
    return () => ac.abort();
  }, [path]);
  useAssetViewRefresher(path, setData);

  const writeData = useCallback((updated: Record<string, unknown>, label: string) => {
    const old = dataRef.current;
    if (!old) return;
    persistAssetEdit(path, updated, invalidateShaderFile);
    pushAction({
      label,
      undo: () => persistAssetEdit(path, old, invalidateShaderFile),
      redo: () => persistAssetEdit(path, updated, invalidateShaderFile),
    });
  }, [path]);

  // Patch one metadata field of one param (default / min / max / step / label).
  const writeParamMeta = useCallback((key: string, field: keyof ShaderParam, value: unknown) => {
    const cur = dataRef.current;
    if (!cur) return;
    const params = { ...((cur.params as Record<string, ShaderParam>) ?? {}) };
    const param = { ...(params[key] ?? { type: 'float', default: 0 }) } as ShaderParam;
    const bag = param as unknown as Record<string, unknown>;
    if (value === undefined) delete bag[field as string];
    else bag[field as string] = value;
    params[key] = param;
    writeData({ ...cur, params }, `Edit ${key}.${String(field)}`);
  }, [writeData]);

  if (!data) return <div style={{ color: '#555', fontSize: '11px', padding: 4 }}>Loading...</div>;

  const params = (data.params as Record<string, ShaderParam>) ?? {};
  const space = data.space === '2d' ? '2d' : '3d';
  const keys = Object.keys(params);

  return (
    <>
      <ShaderPreview path={path} data={data} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <span style={{ color: '#ccc', fontSize: '12px', fontWeight: 600 }}>{(data.name as string) || 'Shader'}</span>
        <span style={badge}>{space}</span>
        <span style={{ flex: 1 }} />
        <span style={{ color: '#666', fontSize: '10px' }}>{keys.length} param{keys.length === 1 ? '' : 's'}</span>
      </div>

      {keys.length === 0 && (
        <div style={{ color: '#666', fontSize: '11px', padding: '4px 0' }}>This shader declares no parameters.</div>
      )}

      {keys.map((key) => {
        const param = params[key];
        const numeric = NUMERIC.has(param.type);
        return (
          <div key={key} style={rowStyle}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
              <span style={{ color: '#ddd', fontSize: '11px', fontFamily: 'monospace' }}>{key}</span>
              <span style={badge}>{param.type}</span>
            </div>

            {/* Default value — the type-appropriate widget (number/color/bool/vecN/texture). */}
            <ParamField name="default" param={param} value={param.default} onChange={(v) => writeParamMeta(key, 'default', v)} />

            {/* Numeric range + step (float/vecN). min/max clamp the default + the driven range. */}
            {numeric && (
              <div style={{ display: 'flex', gap: 6 }}>
                <NumberField label="min" value={typeof param.min === 'number' ? param.min : 0} step={0.01} wide onChange={(v) => writeParamMeta(key, 'min', v)} />
                <NumberField label="max" value={typeof param.max === 'number' ? param.max : 1} step={0.01} wide onChange={(v) => writeParamMeta(key, 'max', v)} />
                <NumberField label="step" value={typeof param.step === 'number' ? param.step : 0.01} step={0.01} wide onChange={(v) => writeParamMeta(key, 'step', v)} />
              </div>
            )}

            {/* Display label (falls back to the param key). */}
            <div style={rowFlex}>
              <span style={lblStyle}>label</span>
              <div style={{ flex: 1 }}>
                <BufferedTextInput value={param.label ?? ''} placeholder={key}
                  onChange={(v) => writeParamMeta(key, 'label', v || undefined)} style={{ ...inputStyle, width: '100%' }} />
              </div>
            </div>
          </div>
        );
      })}

      <div style={{ color: '#666', fontSize: '10px', marginTop: 4, lineHeight: 1.4 }}>
        Param types + the WGSL/GLSL bodies are authored in the shader's <code>.shader.json</code> / sibling{' '}
        <code>.wgsl</code>·<code>.glsl</code> files. Default/range edits apply on the next scene load or material rebuild.
      </div>
    </>
  );
}
