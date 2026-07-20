/** ModelAssetView (+ ModelImportedStats) — preview + LOD/encoder settings +
 *  Import / Re-import. Extracted from Inspector.tsx (editor-inspector.md F2).
 *  The single Import button chains:
 *    POST /api/reimport (Stage A bake + Stage B LODs)
 *      → browser-side importModel() (regenerate .mesh.json / .mat.json / textures)
 *      → write <glb>.prefab.json ONLY if it doesn't already exist (preserve manual edits)
 *      → refreshAssets + invalidateModel. */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { backendFetch } from '../../backend/editorBackend';
import { useEditorStore } from '../../store/editorStore';
import { importModel } from '../../scene/modelImport';
import { glbDeclaresSkin } from '../../scene/rigBones';
import { needsGLBConversion } from '../../scene/convertToGLB';
import { serializePrefab, resolveExistingPrefabId, mergeRiggedPrefab, setPrefabCache, type PrefabFile } from '../../scene/prefab';
import { assetUrl } from '../../../runtime/loaders/assetUrl';
import { DEFAULT_MODEL_SETTINGS, resolveModelSettings, type ModelImportSettings, type ModelCacheInfo, type LodCount, type ModelEncoder } from '../../../runtime/loaders/modelSettings';
import { DEFAULT_TEXTURE_SETTINGS, TEXTURE_MAX_SIZES, DEFAULT_UASTC_LEVEL, DEFAULT_UASTC_RDO_LAMBDA, UASTC_LEVELS, resolveTextureSettings, resolveUastcRdoLambda, type TextureImportSettings, type TextureFormat } from '../../../runtime/loaders/textureSettings';
import { invalidateModel, loadModelTemplates, getTemplatesForModel, getModelHierarchy } from '../../../runtime/loaders/meshTemplateCache';
import { registerAsset } from '../../../runtime/loaders/assetManifest';
import { newGuid } from '../../../runtime/loaders/assetRefRules';
import { decimateMesh, buildCollisionGLB, bytesToBase64, mergeModelGeometry } from '../../scene/collisionMeshGen';
import { inputStyle, BufferedNumberInput } from '../fields';
import { ModelPreview } from '../ModelPreview';
import { formatBytes, reimportBtnStyle, writeMetaOrWarn } from './widgets';

/** Cheap rigged-detection: does this GLB declare a skin? Fetches the file and reads
 *  only its glTF JSON chunk (glbDeclaresSkin), so the Model inspector shows
 *  skinned-model controls (skeleton expansion, no LOD) even before the model has
 *  been imported — a rigged GLB only gets its `meta.rig` marker at import time. */
async function glbHasSkins(url: string): Promise<boolean> {
  try {
    const buf = await fetch(url).then((r) => (r.ok ? r.arrayBuffer() : null));
    return !!buf && glbDeclaresSkin(buf);
  } catch { return false; }
}

export function ModelAssetView({ path, name, postprocessor }: { path: string; name: string; postprocessor: string }) {
  const [meta, setMeta] = useState<Record<string, unknown> | null>(null);
  const [settings, setSettings] = useState<ModelImportSettings>(DEFAULT_MODEL_SETTINGS);
  // Texture-compression settings for a RIGGED model (its embedded textures are
  // KTX2-compressed by convertRiggedModel, which reads resolveTextureSettings(meta) —
  // so these persist to meta.texture, the same block the reimport handler reads).
  const [texSettings, setTexSettings] = useState<TextureImportSettings>(DEFAULT_TEXTURE_SETTINGS);
  const [importing, setImporting] = useState(false);
  const [hasPrefab, setHasPrefab] = useState(false);
  const [probedRigged, setProbedRigged] = useState(false);
  const refreshAssets = useEditorStore((s) => s.refreshAssets);
  const setImportStatus = useEditorStore((s) => s.setImportStatus);
  const setImportError = useEditorStore((s) => s.setImportError);

  const hasCache = !!meta?.modelCache;
  const modelCache = meta?.modelCache as ModelCacheInfo | undefined;
  // Source models (OBJ/FBX/DAE) convert to GLB in-browser at import — they never
  // go through the gltfpack/gltf-transform LOD pipeline (reimport-model skips
  // them), so the LOD/encoder controls don't apply. Hide them for sources.
  const isSourceModel = needsGLBConversion(path);
  // Rigged (skinned) GLBs take the parallel converter (convertRiggedModel): one
  // optimized variant (resize + KTX2 + meshopt), NO LOD pipeline. The lodCount /
  // ratio / simplify controls do nothing for them, so hide the LOD section and
  // show a single-variant note instead. (Skinned LOD — THREE.LOD of SkinnedMesh
  // levels sharing a skeleton — is a deferred feature.)
  // Rigged if the meta says so (written at import) OR the GLB itself declares a skin
  // (probed below) — so a not-yet-imported skinned model shows the right controls.
  const isRigged = !!meta?.rig || probedRigged;

  // Resolved once so the apply flow and the prefab probe agree on the file we
  // mean by "the prefab for this model".
  const prefabPath = useMemo(() => {
    const dir = path.substring(0, path.lastIndexOf('/'));
    const baseName = path.substring(path.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');
    return `${dir}/${baseName}.prefab.json`;
  }, [path]);

  const loadMeta = useCallback((signal?: AbortSignal) => {
    return backendFetch(`/api/read-meta?path=${encodeURIComponent(path)}`, signal ? { signal } : undefined)
      .then((r) => (r.ok ? r.json() : {}))
      .then((m: Record<string, unknown>) => {
        setMeta(m);
        setSettings(resolveModelSettings(m as { model?: Partial<ModelImportSettings> }));
        setTexSettings(resolveTextureSettings(m as Parameters<typeof resolveTextureSettings>[0]));
      })
      .catch(() => { /* keep defaults */ });
  }, [path]);

  // Probe whether the model's prefab exists on disk — drives the button label
  // (Import when missing, Re-import when present). Re-runs after import so the
  // label flips immediately when the import created a fresh prefab.
  // Uses /api/exists rather than raw fetch because Vite's SPA fallback serves
  // index.html with 200 for any missing static path — fetch+r.ok lies.
  const probePrefab = useCallback((signal?: AbortSignal) => {
    return backendFetch(`/api/exists?path=${encodeURIComponent(prefabPath)}`, signal ? { signal } : undefined)
      .then((r) => (r.ok ? r.json() : { exists: false }))
      .then((j: { exists?: boolean }) => setHasPrefab(!!j.exists))
      .catch(() => { /* aborted / network — leave prior state */ });
  }, [prefabPath]);

  useEffect(() => {
    const ac = new AbortController();
    loadMeta(ac.signal);
    probePrefab(ac.signal);
    return () => ac.abort();
  }, [loadMeta, probePrefab]);

  // Probe the GLB for a skin so a not-yet-imported skinned model is detected as
  // rigged (the browser caches the fetch — ModelPreview loads the same file).
  useEffect(() => {
    let live = true;
    setProbedRigged(false);
    if (!isSourceModel) glbHasSkins(path).then((s) => { if (live) setProbedRigged(s); });
    return () => { live = false; };
  }, [path, isSourceModel]);

  // Persist a settings change to the meta sidecar. Length-sensitive arrays
  // (lodRatios / lodDistances) get resized in place to match lodCount.
  const update = useCallback((patch: Partial<ModelImportSettings>) => {
    setSettings((prev) => {
      let next: ModelImportSettings = { ...prev, ...patch };
      if (patch.lodCount !== undefined && patch.lodCount !== prev.lodCount) {
        next = resolveModelSettings({ model: next });
      }
      const updatedMeta = { ...(meta ?? {}), version: 2, model: next };
      setMeta(updatedMeta);
      writeMetaOrWarn(path, updatedMeta);
      return next;
    });
  }, [meta, path]);

  // Persist a texture-compression change to meta.texture (rigged models). Note: no
  // meta.type is written, so resolveTextureSettings merges this block over the
  // defaults (a `type` would trigger codec derivation meant for standalone textures).
  const updateTex = useCallback((patch: Partial<TextureImportSettings>) => {
    setTexSettings((prev) => {
      const next = { ...prev, ...patch };
      const updatedMeta = { ...(meta ?? {}), version: 2, texture: next };
      setMeta(updatedMeta);
      writeMetaOrWarn(path, updatedMeta);
      return next;
    });
  }, [meta, path]);

  const updateLodLevel = useCallback((index: number, kind: 'ratio' | 'distance', value: number) => {
    setSettings((prev) => {
      const ratios = prev.lodRatios.slice();
      const dists = prev.lodDistances.slice();
      if (kind === 'ratio') ratios[index] = value; else dists[index] = value;
      const next: ModelImportSettings = { ...prev, lodRatios: ratios, lodDistances: dists };
      const updatedMeta = { ...(meta ?? {}), version: 2, model: next };
      setMeta(updatedMeta);
      writeMetaOrWarn(path, updatedMeta);
      return next;
    });
  }, [meta, path]);

  const updateLodEncoder = useCallback((index: number, encoder: ModelEncoder) => {
    setSettings((prev) => {
      const encoders = (prev.lodEncoders ?? Array.from({ length: prev.lodCount }, () => prev.encoder)).slice();
      encoders[index] = encoder;
      const next: ModelImportSettings = { ...prev, lodEncoders: encoders };
      const updatedMeta = { ...(meta ?? {}), version: 2, model: next };
      setMeta(updatedMeta);
      writeMetaOrWarn(path, updatedMeta);
      return next;
    });
  }, [meta, path]);

  const updateLodFlag = useCallback((index: number, kind: 'meshopt' | 'aggressive', value: boolean) => {
    setSettings((prev) => {
      const fallback = kind === 'meshopt' ? prev.meshopt : prev.aggressiveSimplify;
      const currentArr = kind === 'meshopt' ? prev.lodMeshopt : prev.lodAggressive;
      const arr = (currentArr ?? Array.from({ length: prev.lodCount }, () => fallback)).slice();
      arr[index] = value;
      const next: ModelImportSettings = kind === 'meshopt'
        ? { ...prev, lodMeshopt: arr }
        : { ...prev, lodAggressive: arr };
      const updatedMeta = { ...(meta ?? {}), version: 2, model: next };
      setMeta(updatedMeta);
      writeMetaOrWarn(path, updatedMeta);
      return next;
    });
  }, [meta, path]);

  const apply = useCallback(async () => {
    setImporting(true);
    setImportStatus(true, `Importing ${name}...`);
    try {
      // 1. Server-side bake (Stage A fixups + Stage B LOD simplification).
      const res = await backendFetch('/api/reimport', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      });
      const summary = await res.json().catch(() => ({}));
      if (!res.ok || (summary.errors && summary.errors.length)) {
        console.error('[Inspector] Model convert failed:', summary.errors ?? summary);
      }

      // 2. Browser-side regen of .mesh.json / .mat.json / texture sidecars.
      //    `importModel` spawns entities as a side effect; for a GLB we seed the
      //    prefab from them, then discard them.
      const { deleteEntity } = await import('../../../runtime/ecs/entityUtils');
      const prefix = name.replace(/\s+/g, '_').toLowerCase();
      const rootId = await importModel(path, prefix, postprocessor);
      if (rootId) {
        try {
          // Create the prefab only for GLB models (importing a GLB produces its
          // prefab) — NOT for FBX/OBJ/DAE sources, which only bake the GLB. A static
          // model's prefab is created once (no churn on a settings re-import). A
          // rigged model's prefab is REGENERATED every import so it reflects the
          // current skeleton-expansion state (bones added/removed).
          if (!isSourceModel) {
            const prefabExists = await backendFetch(`/api/exists?path=${encodeURIComponent(prefabPath)}`)
              .then((r) => (r.ok ? r.json() : { exists: false }))
              .then((j: { exists?: boolean }) => !!j.exists)
              .catch(() => false);
            // Rigged → always regenerate (reflect the current expand state, bones in
            // or out). Static → only when missing.
            if (!prefabExists || isRigged) {
              // Reuse the prefab's existing stable id (manifest guid → on-disk id)
              // so re-creating it keeps the guid scenes already reference.
              const existingId = await resolveExistingPrefabId(prefabPath);
              let prefab = serializePrefab(rootId, existingId);
              // P7b-2b: a rigged re-import refreshes the skeleton from source, but the
              // user's prefab edits (a child hung on a bone, an added Animator) must
              // survive. Merge the fresh skeleton over the existing on-disk prefab,
              // matching bones by NAME so their localIds stay stable and the child
              // stays attached. Read the file fresh (no-store) — the cache may be stale.
              if (prefab && prefabExists && isRigged) {
                const existing = await fetch(assetUrl(prefabPath), { cache: 'no-store' })
                  .then((r) => (r.ok ? (r.json() as Promise<PrefabFile>) : null))
                  .catch(() => null);
                if (existing && Array.isArray(existing.entities)) prefab = mergeRiggedPrefab(prefab, existing);
              }
              if (prefab) {
                await backendFetch('/api/write-file', {
                  method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ path: prefabPath, content: JSON.stringify(prefab, null, 2) }),
                });
                // Refresh the editor cache to the just-written prefab AND evict the
                // runtime refcounted prefab cache (meshTemplateCache) — otherwise the
                // NEXT scene load / Play→Stop revert re-expands the STALE cached copy
                // and a rigged re-import's freshly-added bone entities vanish. The raw
                // /api/write-file above bypasses writePrefabFile()'s own eviction, so we
                // mirror it here. Key by the stable GUID so both caches resolve it.
                setPrefabCache(prefab.id ?? prefabPath, prefab);
                const verb = !prefabExists ? 'Created' : isRigged ? 'Merged' : 'Regenerated';
                console.log(`[Inspector] ${verb} prefab: ${prefabPath}${existingId ? ` (preserved id ${existingId})` : ''}`);
              }
            }
          }
        } finally {
          deleteEntity(rootId);
        }
      }

      // 3. Refresh editor state.
      await loadMeta();
      await probePrefab();
      invalidateModel(path);
      refreshAssets();
      setImportStatus(false);
    } catch (e) {
      // Conversion/import threw (e.g. an unsupported FBX version) — show the
      // reason in a dismissible modal rather than leaking an unhandled rejection
      // out of this click handler. Don't clear the modal here (that would hide
      // the error); setImportError keeps it up with an OK button.
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[Inspector] Model import failed:', e);
      setImportError(msg);
    } finally {
      setImporting(false);
    }
  }, [path, name, postprocessor, meta, isRigged, loadMeta, probePrefab, prefabPath, refreshAssets, setImportStatus, setImportError]);

  // Toggle opt-in skeleton expansion (P7b) — persisted in the meta's rig block.
  // Takes effect on the next Re-import (regenerates the prefab with/without bones).
  // Default ON — checked unless the meta explicitly says false (the user unchecked it).
  const expandSkeleton = (meta?.rig as { expandSkeleton?: boolean } | undefined)?.expandSkeleton !== false;
  const setExpandSkeleton = useCallback((on: boolean) => {
    const rig = (meta?.rig as Record<string, unknown> | undefined) ?? {};
    const updatedMeta = { ...(meta ?? {}), rig: { ...rig, expandSkeleton: on } };
    setMeta(updatedMeta);
    writeMetaOrWarn(path, updatedMeta);
  }, [meta, path]);

  const labelStyle: React.CSSProperties = { flex: 1, color: '#888', fontSize: '11px' };
  const rowStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 4, marginBottom: 3 };
  const sectionStyle: React.CSSProperties = { color: '#f1c40f', fontSize: '10px', textTransform: 'uppercase', margin: '8px 0 3px' };

  return (
    <>
      <ModelPreview sourceUrl={path} hasLods={hasCache} lodCount={isRigged ? 1 : settings.lodCount} />

      <div style={sectionStyle}>Source</div>
      <div style={rowStyle}><span style={labelStyle}>Path</span><span style={{ color: '#ccc', fontSize: '10px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{path}</span></div>
      {modelCache && (
        <div style={rowStyle}><span style={labelStyle}>Source tris</span><span style={{ color: '#ccc', fontSize: '11px' }}>{modelCache.triCounts?.[0]?.toLocaleString() ?? '—'}</span></div>
      )}

      {isSourceModel && (
        <div style={{ color: '#888', fontSize: '10px', margin: '6px 0', lineHeight: 1.4 }}>
          {path.slice(path.lastIndexOf('.') + 1).toUpperCase()} source — converts to GLB on import.
          Import it, then tune LODs on the generated <span style={{ color: '#bbb' }}>.glb</span>.
        </div>
      )}

      {isRigged && (
        <div style={{ color: '#888', fontSize: '10px', margin: '6px 0', lineHeight: 1.4 }}>
          Skinned model — ships a single optimized variant (<span style={{ color: '#bbb' }}>LOD0</span>):
          resize + KTX2 + meshopt, skeleton + clips preserved. LOD simplification isn't applied to
          skinned meshes. Its embedded textures are compressed with these settings.
        </div>
      )}

      {isRigged && (<>
        <div style={sectionStyle}>Texture Compression</div>
        <div style={rowStyle}>
          <span style={labelStyle}>Format</span>
          <select value={texSettings.format} onChange={(e) => updateTex({ format: e.target.value as TextureFormat })} style={{ ...inputStyle, flex: 1 }}>
            <option value="ktx2-uastc">KTX2 UASTC (default)</option>
            <option value="ktx2-etc1s">KTX2 ETC1S (small)</option>
            <option value="png">Raw (no KTX2)</option>
          </select>
        </div>
        <div style={rowStyle}>
          <span style={labelStyle}>Max Size</span>
          <select value={String(texSettings.maxSize)} onChange={(e) => updateTex({ maxSize: Number(e.target.value) as TextureImportSettings['maxSize'] })} style={{ ...inputStyle, flex: 1 }}>
            {TEXTURE_MAX_SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <label style={{ ...rowStyle, cursor: 'pointer' }}>
          <input type="checkbox" checked={texSettings.mipmaps} onChange={(e) => updateTex({ mipmaps: e.target.checked })} />
          <span style={labelStyle}>Generate Mipmaps</span>
        </label>
        {texSettings.format === 'ktx2-uastc' && (<>
          <div style={rowStyle}>
            <span style={labelStyle}>UASTC Level</span>
            <select value={String(texSettings.uastcLevel ?? DEFAULT_UASTC_LEVEL)} onChange={(e) => updateTex({ uastcLevel: Number(e.target.value) })} style={{ ...inputStyle, flex: 1 }}>
              {UASTC_LEVELS.map((l) => <option key={l} value={l}>{l}{l === DEFAULT_UASTC_LEVEL ? ' (default)' : ''}</option>)}
            </select>
          </div>
          <div style={rowStyle}>
            <span style={labelStyle}>UASTC RDO λ</span>
            <BufferedNumberInput value={texSettings.uastcRdoLambda ?? DEFAULT_UASTC_RDO_LAMBDA} step={0.1} min={0} max={4}
              onChange={(v) => updateTex({ uastcRdoLambda: resolveUastcRdoLambda(v) })} style={{ ...inputStyle, flex: 1 }} />
          </div>
        </>)}
        <div style={{ color: '#666', fontSize: '10px', margin: '0 0 6px', lineHeight: 1.4 }}>
          Re-import to apply. Higher RDO λ = smaller download, lower quality (0 = off).
          {probedRigged && !meta?.rig && (
            <span style={{ color: '#b08a3a' }}> Import this model first — these apply once it's rig-imported.</span>
          )}
        </div>

        <div style={sectionStyle}>Skeleton</div>
        <label style={{ ...rowStyle, cursor: 'pointer' }} title="Expand the skeleton into Bone entities under the prefab root (Unity-style), so you can drive bones from code and parent props to them. Off keeps the skeleton internal to the root. Takes effect on Re-import.">
          <input type="checkbox" checked={expandSkeleton} onChange={(e) => setExpandSkeleton(e.target.checked)} />
          <span style={labelStyle}>Expand skeleton into bone entities</span>
        </label>
        <div style={{ color: '#666', fontSize: '10px', margin: '0 0 6px', lineHeight: 1.4 }}>
          Re-import to apply. Regenerates the prefab with one <code>Bone</code> entity per joint.
        </div>
      </>)}

      {!isSourceModel && !isRigged && (<>
      <div style={sectionStyle}>LOD</div>
      <div style={rowStyle}>
        <span style={labelStyle}>Levels</span>
        <select value={String(settings.lodCount)} onChange={(e) => update({ lodCount: Number(e.target.value) as LodCount })} style={{ ...inputStyle, flex: 1 }}>
          <option value="1">1 (no LOD)</option>
          <option value="2">2 levels</option>
          <option value="3">3 levels</option>
        </select>
      </div>
      {Array.from({ length: settings.lodCount }).map((_, i) => {
        const lodEnc = settings.lodEncoders?.[i] ?? settings.encoder;
        const lodMeshopt = settings.lodMeshopt?.[i] ?? settings.meshopt;
        const lodAggressive = settings.lodAggressive?.[i] ?? settings.aggressiveSimplify;
        const triCount = modelCache?.triCounts?.[i];
        const lodByteCount = modelCache?.lodBytes?.[i];
        const meshoptHint = lodEnc === 'gltfpack'
          ? 'gltfpack -cc: writes geometry / morph / animation with EXT_meshopt_compression. Smaller download, cheap runtime transcode.'
          : 'gltf-transform meshopt post-pass: same EXT_meshopt_compression. Smaller download, cheap runtime transcode.';
        const aggressiveHint = lodEnc === 'gltfpack'
          ? 'gltfpack -sa instead of -slb: drops UV/material border protection so simplify actually hits the target ratio. Conservative mode stalls around 50% on Blender hard-edge exports.'
          : 'gltf-transform --lock-border 0: drops UV/material border protection so simplify actually hits the target ratio. Conservative mode stalls around 50% on Blender hard-edge exports.';
        return (
          <div
            key={i}
            style={{
              marginBottom: 8,
              paddingBottom: 6,
              borderBottom: '1px solid #2a2a2a',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 4 }}>
              <span style={{ color: '#ddd', fontSize: '11px', fontWeight: 600 }}>LOD{i}</span>
              <span style={{ color: '#666', fontSize: '10px' }}>
                {triCount !== undefined ? `${triCount.toLocaleString()} tri` : '—'}
                {lodByteCount !== undefined && lodByteCount > 0 && ` · ${formatBytes(lodByteCount)}`}
              </span>
            </div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4, flexWrap: 'wrap' }}>
              <span style={{ color: '#777', fontSize: '10px' }}>ratio</span>
              <input
                type="number" step={0.05} min={0} max={1}
                value={settings.lodRatios[i] ?? 1}
                onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) updateLodLevel(i, 'ratio', n); }}
                style={{ ...inputStyle, width: 50 }}
              />
              <span style={{ color: '#777', fontSize: '10px' }}>dist</span>
              <input
                type="number" step={1} min={0}
                value={settings.lodDistances[i] ?? 0}
                onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) updateLodLevel(i, 'distance', n); }}
                style={{ ...inputStyle, width: 50 }}
              />
              <select
                value={lodEnc}
                onChange={(e) => updateLodEncoder(i, e.target.value as ModelEncoder)}
                title="Encoder used for this LOD. gltf-transform preserves mesh names + quality; gltfpack hits the ratio more aggressively but renames meshes."
                style={{ ...inputStyle, flex: '0 1 140px', fontSize: 10 }}
              >
                <option value="gltf-transform">gltf-transform</option>
                <option value="gltfpack">gltfpack</option>
              </select>
            </div>
            <label
              style={{ display: 'flex', alignItems: 'flex-start', gap: 6, padding: '2px 0 2px 4px', fontSize: '10px' }}
              title={meshoptHint}
            >
              <input
                type="checkbox"
                checked={lodMeshopt}
                onChange={(e) => updateLodFlag(i, 'meshopt', e.target.checked)}
                style={{ margin: '2px 0 0 0' }}
              />
              <span style={{ color: '#ccc' }}>
                meshopt compress
                <span style={{ color: '#666' }}> — EXT_meshopt_compression</span>
              </span>
            </label>
            <label
              style={{ display: 'flex', alignItems: 'flex-start', gap: 6, padding: '2px 0 2px 4px', fontSize: '10px' }}
              title={aggressiveHint}
            >
              <input
                type="checkbox"
                checked={lodAggressive}
                onChange={(e) => updateLodFlag(i, 'aggressive', e.target.checked)}
                style={{ margin: '2px 0 0 0' }}
              />
              <span style={{ color: '#ccc' }}>
                Aggressive simplify
                <span style={{ color: '#666' }}> — drop border-preservation to hit the ratio</span>
              </span>
            </label>
          </div>
        );
      })}
      <div style={rowStyle} title="Caps how far ratio can simplify. The encoder quits once this error budget is hit, even if the target ratio isn't reached. 0.01 = strict (hero meshes), 0.5 = loose (let ratio drive), 1.0 = unconstrained.">
        <span style={labelStyle}>Error tolerance</span>
        <input
          type="number" step={0.005} min={0} max={1}
          value={settings.simplifyError}
          onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) update({ simplifyError: n }); }}
          style={{ ...inputStyle, width: 70 }}
        />
      </div>

      {(() => {
        const lodEncodersUsed = Array.from({ length: settings.lodCount }, (_, i) => settings.lodEncoders?.[i] ?? settings.encoder);
        const anyGltfTransform = lodEncodersUsed.includes('gltf-transform');
        if (!anyGltfTransform) return null;
        return (
          <>
            <div style={sectionStyle}>Encoder options</div>
            <div style={rowStyle} title="One-time pre-simplify weld pass for gltf-transform LODs. Coincident vertices get merged so simplify can collapse across former UV/normal splits.">
              <span style={labelStyle}>Weld verts</span>
              <input type="checkbox" checked={settings.weld} onChange={(e) => update({ weld: e.target.checked })} />
            </div>
          </>
        );
      })()}
      </>)}

      <button
        disabled={importing}
        onClick={apply}
        style={{ ...reimportBtnStyle, marginTop: 8, background: importing ? '#555' : '#2ecc71', color: '#fff', border: `1px solid ${importing ? '#444' : '#27ae60'}`, cursor: importing ? 'wait' : 'pointer' }}
      >
        {importing ? 'Importing...' : (hasCache && hasPrefab) ? 'Re-import' : 'Import'}
      </button>
      {hasCache && <ModelImportedStats cache={modelCache} />}

      {!isSourceModel && !isRigged && (
        <GenerateCollisionMeshRow path={path} name={name} postprocessor={postprocessor} onDone={refreshAssets} />
      )}
    </>
  );
}

/** "Collision" section — decimate the WHOLE model (all its meshes, composed in model space) into
 *  one low-poly trimesh, written as a sibling `<name>_col.colmesh.glb` + `.mesh.json` derived
 *  asset. This is the canonical place to author a collision mesh (it's a reusable asset, not a
 *  property of one entity); assign it afterward via a Collider3D's `mesh` field (shape=trimesh). */
function GenerateCollisionMeshRow({ path, name, postprocessor, onDone }: { path: string; name: string; postprocessor: string; onDone: () => void }) {
  const [cells, setCells] = useState(28);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const generate = useCallback(async () => {
    if (busy) return;
    setBusy(true); setStatus('generating…');
    try {
      // Ensure the model's templates + hierarchy are loaded (it may never have rendered).
      await loadModelTemplates(path, undefined, postprocessor || 'none');
      const templates = getTemplatesForModel(path);
      if (!templates || templates.size === 0) throw new Error('model has no meshes to collide');
      const merged = mergeModelGeometry(templates.values(), getModelHierarchy(path));
      const srcTris = merged.indices.length / 3;
      if (srcTris === 0) throw new Error('model geometry is empty');
      const dec = decimateMesh(merged.positions, merged.indices, cells);
      const outTris = dec.indices.length / 3;

      const dir = path.slice(0, path.lastIndexOf('/'));
      const base = path.slice(dir.length + 1).replace(/\.[^.]+$/, '');
      const meshName = `${base}_col`;
      const glbPath = `${dir}/${meshName}.colmesh.glb`;
      const meshJsonPath = `${dir}/meshes/${meshName}.mesh.json`;

      const modelGuid = newGuid();
      const meshGuid = newGuid();
      // Register browser-side so the new asset resolves immediately (Collider3D.mesh picker).
      registerAsset(modelGuid, glbPath, 'model');
      registerAsset(meshGuid, meshJsonPath, 'mesh');

      const glb = buildCollisionGLB(dec.positions, dec.normals, dec.indices, meshName);
      const post = (p: string, content: string, encoding?: string) => backendFetch('/api/write-file', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: p, content, encoding }),
      });
      const glbRes = await post(glbPath, bytesToBase64(glb), 'base64');
      if (!glbRes.ok) throw new Error(`write GLB failed (${glbRes.status})`);
      await backendFetch('/api/write-meta', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: glbPath, meta: { id: modelGuid, version: 2, generated: { meshes: [meshJsonPath], materials: [], textures: [] } } }),
      });
      const meshAsset = { id: meshGuid, version: 1, model: modelGuid, mesh: meshName, postprocessor: 'none', material: '' };
      await post(meshJsonPath, JSON.stringify(meshAsset, null, 2));

      onDone();
      setStatus(`${srcTris.toLocaleString()}→${outTris.toLocaleString()} tris (${Math.round((100 * outTris) / Math.max(1, srcTris))}%) → ${meshName}`);
    } catch (e) {
      setStatus(`failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [busy, path, name, postprocessor, cells, onDone]);

  const sectionStyle: React.CSSProperties = { color: '#f1c40f', fontSize: '10px', textTransform: 'uppercase', margin: '10px 0 3px' };
  return (
    <>
      <div style={sectionStyle}>Collision</div>
      <div style={{ color: '#666', fontSize: '10px', margin: '0 0 4px', lineHeight: 1.4 }}>
        Decimate the whole model into a coarse trimesh collision asset, then assign it to a
        Collider3D&apos;s <span style={{ color: '#bbb' }}>mesh</span> field (shape=trimesh).
      </div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <button
          disabled={busy}
          onClick={generate}
          title="Vertex-cluster decimate every mesh in this model into one trimesh collision mesh asset"
          style={{ ...reimportBtnStyle, flex: 1, marginTop: 0, background: busy ? '#555' : '#34495e', color: '#fff', border: `1px solid ${busy ? '#444' : '#2c3e50'}`, cursor: busy ? 'wait' : 'pointer' }}
        >
          {busy ? 'Generating…' : 'Generate Collision Mesh'}
        </button>
        <span style={{ color: '#777', fontSize: '10px' }} title="Grid resolution along the longest axis — higher = finer/more triangles">cells</span>
        <input
          type="number" step={1} min={4} max={128} value={cells}
          onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) setCells(Math.max(4, Math.min(128, Math.round(n)))); }}
          style={{ ...inputStyle, width: 50 }}
        />
      </div>
      {status && <div style={{ marginTop: 4, fontSize: '10px', color: status.startsWith('failed') ? '#e07a7a' : '#7a9a7a' }}>{status}</div>}
    </>
  );
}

/** Post-conversion stats for the model pipeline — per-LOD tri counts + bytes. */
function ModelImportedStats({ cache }: { cache: ModelCacheInfo | undefined }) {
  const rowStyle: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', fontSize: '11px', padding: '1px 0' };
  const labelStyle: React.CSSProperties = { color: '#888' };
  const valStyle: React.CSSProperties = { color: '#ccc' };
  const sectionStyle: React.CSSProperties = { color: '#f1c40f', fontSize: '10px', textTransform: 'uppercase', margin: '10px 0 3px' };

  if (!cache) return null;
  const lodPaths = cache.lodPaths ?? [];
  const total = (cache.lodBytes ?? []).reduce((a, b) => a + (b ?? 0), 0);
  return (
    <>
      <div style={sectionStyle}>Imported</div>
      {lodPaths.map((_, i) => (
        <div key={i} style={rowStyle}>
          <span style={labelStyle}>LOD{i}</span>
          <span style={valStyle}>
            {(cache.triCounts?.[i] ?? 0).toLocaleString()} tri · {formatBytes(cache.lodBytes?.[i] ?? 0)}
          </span>
        </div>
      ))}
      <div style={{ ...rowStyle, borderTop: '1px solid #333', marginTop: 2, paddingTop: 3 }}>
        <span style={{ ...labelStyle, color: '#aaa' }}>Total</span>
        <span style={{ ...valStyle, color: '#fff' }}>{formatBytes(total)}</span>
      </div>
    </>
  );
}
