/** MaterialBatchView — multi-select editor for N material (.mat.json) assets.
 *  Materials' editable surface is shader-dependent, so batch editing is gated on
 *  the selection sharing one shader. Fields that differ across the selection show
 *  "Mixed"; a change writes to EVERY selected material as ONE coalesced undo entry
 *  (materials persist undoably, unlike textures/models). */

import { useState, useEffect, useCallback } from 'react';
import { pushAction } from '../../undo/undoManager';
import { listShaderOptions, optionValueForMaterial, resolveShaderSchema, type ShaderKind } from '../../shaderCatalog';
import type { ShaderParamSchema } from '../../../runtime/loaders/shaderSchema';
import { NumberField, ColorField, DropdownField, DEFAULT_COLOR } from './widgets';
import { persistAssetEdit, invalidateMaterialFile, useAssetViewRefresher } from './persist';
import { ParamField } from './MaterialAssetView';
import { mergeRecords } from '../assetMerge';

type MatMap = Record<string, Record<string, unknown>>; // path -> .mat.json data

/** Built-in (standard/unlit) fields exposed for batch tuning — the high-value
 *  scalar/color subset. Custom-shader materials use the merged param schema instead. */
const BUILTIN_KEYS = ['color', 'roughness', 'metalness', 'transparent', 'opacity', 'side', 'emissive', 'emissiveIntensity'] as const;

export function MaterialBatchView({ paths }: { paths: string[] }) {
  const [mats, setMats] = useState<MatMap>({});
  const [loaded, setLoaded] = useState(false);
  const [schema, setSchema] = useState<ShaderParamSchema | null>(null);

  const loadAll = useCallback(async () => {
    setLoaded(false);
    const entries = await Promise.all(paths.map(async (p) => {
      try { const r = await fetch(p); return [p, r.ok ? await r.json() : {}] as const; }
      catch { return [p, {}] as const; }
    }));
    setMats(Object.fromEntries(entries));
    setLoaded(true);
  }, [paths]);

  useEffect(() => { loadAll(); }, [loadAll]);
  // Keep in sync if any of these materials is edited elsewhere / by undo.
  useAssetViewRefresher(paths[0] ?? '', () => loadAll());

  const datas = paths.map((p) => mats[p]).filter((d): d is Record<string, unknown> => !!d);
  const shaders = datas.map((d) => optionValueForMaterial(d));
  const sameShader = datas.length > 0 && shaders.every((s) => s === shaders[0]);
  const shaderValue = shaders[0] ?? 'pbr';
  const opt = listShaderOptions().find((o) => o.value === shaderValue) ?? { kind: 'file' as ShaderKind, value: shaderValue, label: shaderValue };
  const isCustom = opt.kind !== 'builtin';

  // Load the param schema for a shared custom shader.
  useEffect(() => {
    let cancelled = false;
    if (!sameShader || !isCustom) { setSchema(null); return; }
    resolveShaderSchema({ kind: opt.kind, value: shaderValue }).then((s) => { if (!cancelled) setSchema(s); });
    return () => { cancelled = true; };
  }, [sameShader, isCustom, opt.kind, shaderValue]);

  // Write `mutate(data)` into every selected material as ONE undo entry.
  const writeAll = useCallback((label: string, mutate: (data: Record<string, unknown>) => Record<string, unknown>) => {
    const prev: MatMap = {};
    const next: MatMap = {};
    for (const p of paths) {
      const cur = mats[p];
      if (!cur) continue;
      prev[p] = cur;
      next[p] = mutate(cur);
    }
    const apply = (map: MatMap) => { for (const p of Object.keys(map)) persistAssetEdit(p, map[p], invalidateMaterialFile); };
    setMats((m) => ({ ...m, ...next }));
    apply(next);
    pushAction({ label, undo: () => { setMats((m) => ({ ...m, ...prev })); apply(prev); }, redo: () => { setMats((m) => ({ ...m, ...next })); apply(next); } });
  }, [paths, mats]);

  const writeFieldAll = useCallback((field: string, value: unknown) => {
    writeAll(`Edit material ${field}`, (d) => ({ ...d, [field]: value }));
  }, [writeAll]);

  const writeParamAll = useCallback((key: string, value: unknown) => {
    writeAll(`Edit ${key}`, (d) => ({ ...d, params: { ...((d.params as Record<string, unknown>) ?? {}), [key]: value } }));
  }, [writeAll]);

  if (!loaded) return <div style={{ color: '#666', fontSize: 11 }}>Loading {paths.length} materials…</div>;
  if (!sameShader) {
    return <div style={{ color: '#c0392b', fontSize: 11 }}>Materials use different shaders — select same-shader materials to batch-edit.</div>;
  }

  const isUnlit = shaderValue === 'unlit';

  if (isCustom) {
    const params = datas.map((d) => (d.params as Record<string, unknown>) ?? {});
    const keys = schema ? Object.keys(schema) : [];
    const { merged, mixed } = mergeRecords(params, keys);
    if (!schema) return <div style={{ color: '#666', fontSize: 11 }}>Loading shader parameters…</div>;
    if (keys.length === 0) return <div style={{ color: '#666', fontSize: 11 }}>This shader exposes no parameters.</div>;
    return (
      <>
        {keys.map((key) => (
          <ParamField key={key} name={key} param={schema[key]} value={merged[key]} mixed={mixed.has(key)} onChange={(v) => writeParamAll(key, v)} />
        ))}
      </>
    );
  }

  // Built-in standard / unlit subset.
  const { merged, mixed } = mergeRecords(datas, [...BUILTIN_KEYS]);
  const isMixed = (k: string) => mixed.has(k);
  return (
    <>
      <ColorField label="Color" value={(merged.color as number) ?? DEFAULT_COLOR} mixed={isMixed('color')} onChange={(v) => writeFieldAll('color', v)} />
      {!isUnlit && <NumberField label="Roughness" value={(merged.roughness as number) ?? 1} step={0.01} wide mixed={isMixed('roughness')} onChange={(v) => writeFieldAll('roughness', v)} />}
      {!isUnlit && <NumberField label="Metalness" value={(merged.metalness as number) ?? 0} step={0.01} wide mixed={isMixed('metalness')} onChange={(v) => writeFieldAll('metalness', v)} />}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 2 }}>
        <span style={{ flex: 1, color: '#888', fontSize: '11px' }}>Transparent</span>
        <input type="checkbox" checked={isMixed('transparent') ? false : !!merged.transparent} ref={(el) => { if (el) el.indeterminate = isMixed('transparent'); }} onChange={(e) => writeFieldAll('transparent', e.target.checked)} />
      </div>
      <NumberField label="Opacity" value={(merged.opacity as number) ?? 1} step={0.01} wide mixed={isMixed('opacity')} onChange={(v) => writeFieldAll('opacity', v)} />
      <DropdownField label="Side" value={(merged.side as string) ?? 'front'} mixed={isMixed('side')} options={['front', 'double', 'back']} onChange={(v) => writeFieldAll('side', v)} />
      {!isUnlit && <ColorField label="Emissive" value={(merged.emissive as number) ?? 0} mixed={isMixed('emissive')} onChange={(v) => writeFieldAll('emissive', v)} />}
      {!isUnlit && <NumberField label="Emissive Intensity" value={(merged.emissiveIntensity as number) ?? 1} step={0.05} wide mixed={isMixed('emissiveIntensity')} onChange={(v) => writeFieldAll('emissiveIntensity', v)} />}
    </>
  );
}
