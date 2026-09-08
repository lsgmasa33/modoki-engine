/** MaterialBatchView — multi-select editor for N material (.mat.json) assets.
 *  Materials' editable surface is shader-dependent, so batch editing is gated on
 *  the selection sharing one shader. Fields that differ across the selection show
 *  "Mixed"; a change writes to EVERY selected material as ONE coalesced undo entry
 *  (materials persist undoably, unlike textures/models). */

import { useState, useEffect, useCallback, useRef } from 'react';
import { pushAction } from '../../undo/undoManager';
import { listShaderOptions, optionValueForMaterial, resolveShaderSchema, type ShaderKind } from '../../shaderCatalog';
import type { ShaderParamSchema } from '../../../runtime/loaders/shaderSchema';
import { NumberField, ColorField, DropdownField, DEFAULT_COLOR } from './widgets';
import { persistAssetEdit, invalidateMaterialFile, useAssetViewRefreshers } from './persist';
import { pendingAssetDoc } from '../pendingAssetDoc';
import { ParamField } from './MaterialAssetView';
import { mergeRecords } from '../assetMerge';
import { parseAssetJson } from '../../../runtime/loaders/assetFetch';
import { loadMaterialBatch, planBatchWrite, type MatMap, type UnreadableMaterial } from './materialBatchLoad';
import { AssetLoadRefusedBanner } from '../AssetLoadRefusedBanner';

/** Built-in (standard/unlit) fields exposed for batch tuning — the high-value
 *  scalar/color subset. Custom-shader materials use the merged param schema instead. */
const BUILTIN_KEYS = ['color', 'roughness', 'metalness', 'transparent', 'opacity', 'side', 'emissive', 'emissiveIntensity'] as const;

export function MaterialBatchView({ paths }: { paths: string[] }) {
  const [mats, setMats] = useState<MatMap>({});
  /** Members of the selection whose document could not be read — EXCLUDED from `mats` rather than
   *  represented by a placeholder, so no edit can park a document this panel never read (#886). */
  const [unreadable, setUnreadable] = useState<UnreadableMaterial[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [schema, setSchema] = useState<ShaderParamSchema | null>(null);

  /** Bumped by every load; a resolution whose epoch is stale is dropped. `loadAll` had no
   *  cancellation before (#843 left it that way because `mats` is path-keyed, so a stale map could
   *  not write under the wrong path). `unreadable` is NOT path-keyed — it is rendered raw — so a
   *  superseded load could name paths that are no longer selected and print "2 of 1 selected
   *  materials". Cheaper to cancel than to reason about which state is safe. */
  const loadEpoch = useRef(0);

  const loadAll = useCallback(async () => {
    const epoch = ++loadEpoch.current;
    setLoaded(false);
    // Decision extracted to `materialBatchLoad.ts` so it is testable without mounting this
    // component; this effect only supplies the I/O and applies the result.
    const { mats: next, unreadable: bad } = await loadMaterialBatch(paths, {
      // ⚠️ Per path, not per panel (#831): a batch selection can mix parked and clean materials,
      // and a parked edit is NOT on disk. Fetching one of those back would show — and re-seed the
      // cache with — the PRE-edit document while Cmd+S still writes the newer parked one. Same
      // rule as the single-asset views, applied to each member of the batch. This covers MOUNT and
      // path-change only — a live edit while mounted arrives through the per-path refresher below,
      // not through a re-run of this loop, so there is no mid-loop re-read to get wrong (#843).
      parked: (p) => pendingAssetDoc(p, 'material'),
      // ⚠️ `parseAssetJson`, never a raw `r.json()` (#886). Vite answers an unknown path with
      // `200 index.html`, so a deleted/renamed material used to arrive as a `SyntaxError` on HTML
      // — indistinguishable from a corrupt file, and (before this) swallowed into `{}` either way.
      fetchDoc: (p) => fetch(p).then((r) => parseAssetJson(r, p)),
    });
    if (epoch !== loadEpoch.current) return; // a newer load won while this one was in flight
    setMats(next);
    setUnreadable(bad);
    for (const { path, message } of bad) {
      console.error(`[MaterialBatchView] excluding ${path} from this batch — could not read it: ${message}. A batch edit will not write to it.`);
    }
    setLoaded(true);
  }, [paths]);

  useEffect(() => { loadAll(); }, [loadAll]);
  // Keep in sync if any of these materials is edited elsewhere / by undo — a pure state MERGE for
  // the one path that changed, never a re-read of the other N-1 (#843: `loadAll` here raced
  // `persistAssetEdit`'s loop over the batch, re-seeding not-yet-parked paths from the pre-edit
  // disk doc and clobbering the just-applied edit).
  useAssetViewRefreshers(paths, (p, updated) => {
    setMats((m) => ({ ...m, [p]: updated }));
    // ⚠️ …and it is no longer excluded. A refresher fires when another surface parks a document for
    // this path, which IS a readable document — so the member becomes writable by `planBatchWrite`
    // again, and leaving it in the banner would claim an exclusion that has stopped being true.
    setUnreadable((u) => (u.some((x) => x.path === p) ? u.filter((x) => x.path !== p) : u));
  });

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
    // ⚠️ Only the members actually in `mats` are reached — a member whose read was refused is
    // ABSENT from it (#886), which is what keeps a batch edit off a document this panel never
    // read while its siblings park normally. Extracted so that guarantee is testable.
    const { prev, next } = planBatchWrite(paths, mats, mutate);
    const apply = (map: MatMap) => { for (const p of Object.keys(map)) persistAssetEdit(p, 'material', map[p], invalidateMaterialFile); };
    setMats((m) => ({ ...m, ...next }));
    apply(next);
    // Asset-FILE edits, PARKED by persistAssetEdit (#831), so pending against the registry, not the scene — see MaterialAssetView.
    pushAction({ _isFileDirect: true, label, undo: () => { setMats((m) => ({ ...m, ...prev })); apply(prev); }, redo: () => { setMats((m) => ({ ...m, ...next })); apply(next); } });
  }, [paths, mats]);

  const writeFieldAll = useCallback((field: string, value: unknown) => {
    writeAll(`Edit material ${field}`, (d) => ({ ...d, [field]: value }));
  }, [writeAll]);

  const writeParamAll = useCallback((key: string, value: unknown) => {
    writeAll(`Edit ${key}`, (d) => ({ ...d, params: { ...((d.params as Record<string, unknown>) ?? {}), [key]: value } }));
  }, [writeAll]);

  // #886: excluded members are named, not silently dropped. A batch edit that quietly writes to 2
  // of the 3 materials the human selected is the same class of silent-partial-success as the `{}`
  // park this replaced — the human has to be able to see which one their edit did not reach.
  const banner = unreadable.length > 0 ? (
    // ⚠️ The SHARED component, not a hand-rolled copy of its palette — the fifth copy of those five
    // colour literals is exactly what it exists to prevent, and this file added one. `message`
    // rather than `fileName` because this refusal is about several files at once.
    <AssetLoadRefusedBanner
      uiId="assetView.materialBatch.unreadable"
      onRetry={loadAll}
      style={{ margin: '0 0 6px' }}
      message={`⚠ ${unreadable.length} of ${paths.length} selected ${paths.length === 1 ? 'material' : 'materials'} could not be read — ${unreadable.length === 1 ? 'it is' : 'they are'} excluded from this batch, so an edit here will not write to ${unreadable.length === 1 ? 'it' : 'them'}:`}
      details={(
        <ul style={{ margin: '4px 0 0', paddingLeft: 16 }}>
          {unreadable.map(({ path, message }) => (
            <li key={path}>{`${path.split('/').pop() || path} — ${message}`}</li>
          ))}
        </ul>
      )}
    />
  ) : null;

  if (!loaded) return <div style={{ color: '#666', fontSize: 11 }}>Loading {paths.length} materials…</div>;
  // Every member was excluded — say THAT, rather than falling through to the shader message below,
  // which would blame a mismatch that was never measured (`sameShader` is false on an empty set).
  if (datas.length === 0) {
    return banner ?? <div style={{ color: '#666', fontSize: 11 }}>Nothing to edit.</div>;
  }
  if (!sameShader) {
    return <>{banner}<div style={{ color: '#c0392b', fontSize: 11 }}>Materials use different shaders — select same-shader materials to batch-edit.</div></>;
  }

  const isUnlit = shaderValue === 'unlit';

  if (isCustom) {
    const params = datas.map((d) => (d.params as Record<string, unknown>) ?? {});
    const keys = schema ? Object.keys(schema) : [];
    const { merged, mixed } = mergeRecords(params, keys);
    if (!schema) return <>{banner}<div style={{ color: '#666', fontSize: 11 }}>Loading shader parameters…</div></>;
    if (keys.length === 0) return <>{banner}<div style={{ color: '#666', fontSize: 11 }}>This shader exposes no parameters.</div></>;
    return (
      <>
        {banner}
        {keys.map((key) => (
          <ParamField key={key} name={key} param={schema[key]} value={merged[key]} mixed={mixed.has(key)} onChange={(v) => writeParamAll(key, v)}
            idPrefix="assetView.materialBatch.param" />
        ))}
      </>
    );
  }

  // Built-in standard / unlit subset.
  const { merged, mixed } = mergeRecords(datas, [...BUILTIN_KEYS]);
  const isMixed = (k: string) => mixed.has(k);
  return (
    <>
      {banner}
      <ColorField label="Color" value={(merged.color as number) ?? DEFAULT_COLOR} mixed={isMixed('color')} onChange={(v) => writeFieldAll('color', v)} />
      {!isUnlit && <NumberField label="Roughness" value={(merged.roughness as number) ?? 1} step={0.01} wide mixed={isMixed('roughness')} onChange={(v) => writeFieldAll('roughness', v)} dataUiId="assetView.materialBatch.roughness" />}
      {!isUnlit && <NumberField label="Metalness" value={(merged.metalness as number) ?? 0} step={0.01} wide mixed={isMixed('metalness')} onChange={(v) => writeFieldAll('metalness', v)} dataUiId="assetView.materialBatch.metalness" />}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 2 }}>
        <span style={{ flex: 1, color: '#888', fontSize: '11px' }}>Transparent</span>
        <input type="checkbox" checked={isMixed('transparent') ? false : !!merged.transparent} ref={(el) => { if (el) el.indeterminate = isMixed('transparent'); }} onChange={(e) => writeFieldAll('transparent', e.target.checked)} />
      </div>
      <NumberField label="Opacity" value={(merged.opacity as number) ?? 1} step={0.01} wide mixed={isMixed('opacity')} onChange={(v) => writeFieldAll('opacity', v)} dataUiId="assetView.materialBatch.opacity" />
      <DropdownField label="Side" value={(merged.side as string) ?? 'front'} mixed={isMixed('side')} options={['front', 'double', 'back']} onChange={(v) => writeFieldAll('side', v)} />
      {!isUnlit && <ColorField label="Emissive" value={(merged.emissive as number) ?? 0} mixed={isMixed('emissive')} onChange={(v) => writeFieldAll('emissive', v)} />}
      {!isUnlit && <NumberField label="Emissive Intensity" value={(merged.emissiveIntensity as number) ?? 1} step={0.05} wide mixed={isMixed('emissiveIntensity')} onChange={(v) => writeFieldAll('emissiveIntensity', v)} dataUiId="assetView.materialBatch.emissiveIntensity" />}
    </>
  );
}
