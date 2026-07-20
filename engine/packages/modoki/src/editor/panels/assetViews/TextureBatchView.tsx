/** TextureBatchView — multi-select import-settings editor for N textures. Mirrors
 *  TextureAssetView but merges settings across the selection (differing fields show
 *  "Mixed"), writes each changed field to EVERY selected .meta.json, and offers a
 *  single "Re-import all (N)". Meta writes are fire-and-forget, same as single-select. */

import { useState, useEffect, useCallback } from 'react';
import { backendFetch } from '../../backend/editorBackend';
import { useEditorStore } from '../../store/editorStore';
import { resolveTextureSettings, resolveTextureType, deriveSettingsForType, type TextureImportSettings, type TextureType } from '../../../runtime/loaders/textureSettings';
import { reimportBtnStyle, writeMetaOrWarn } from './widgets';
import { mergeRecords } from '../assetMerge';
import { reimportPaths } from './reimport';
import { TextureSettingsControls, type TextureSettingKey } from './TextureAssetView';

type MetaMap = Record<string, Record<string, unknown>>; // path -> full meta object

const SETTING_KEYS: (keyof TextureImportSettings)[] = ['format', 'maxSize', 'mipmaps', 'wrapS', 'wrapT', 'colorspace'];

export function TextureBatchView({ paths }: { paths: string[] }) {
  const [metas, setMetas] = useState<MetaMap>({});
  const [loaded, setLoaded] = useState(false);
  const [importing, setImporting] = useState(false);
  const refreshAssets = useEditorStore((s) => s.refreshAssets);
  const setImportStatus = useEditorStore((s) => s.setImportStatus);

  // Load all metas in parallel; store the full object per path so writes preserve
  // each asset's id/textureCache/border.
  const loadAll = useCallback(async () => {
    setLoaded(false);
    const entries = await Promise.all(paths.map(async (p) => {
      try {
        const r = await backendFetch(`/api/read-meta?path=${encodeURIComponent(p)}`);
        return [p, r.ok ? await r.json() : {}] as const;
      } catch { return [p, {}] as const; }
    }));
    setMetas(Object.fromEntries(entries));
    setLoaded(true);
  }, [paths]);

  useEffect(() => { loadAll(); }, [loadAll]);

  // Merge the per-path resolved settings + type into a representative value + a
  // set of "mixed" keys.
  const resolved = paths.map((p) => {
    const m = (metas[p] ?? {}) as { type?: TextureType; texture?: Partial<TextureImportSettings> };
    return { type: resolveTextureType(m), ...resolveTextureSettings(m) };
  });
  const { merged, mixed } = mergeRecords(resolved, ['type', ...SETTING_KEYS] as (keyof (typeof resolved)[number])[]);
  const type = (merged.type ?? '3d') as TextureType;
  const settings: TextureImportSettings = {
    format: merged.format ?? 'ktx2-uastc',
    maxSize: merged.maxSize ?? 1024,
    mipmaps: merged.mipmaps ?? true,
    wrapS: merged.wrapS ?? 'repeat',
    wrapT: merged.wrapT ?? 'repeat',
    colorspace: merged.colorspace ?? 'srgb',
  } as TextureImportSettings;
  const mixedKeys = mixed as Set<TextureSettingKey>;

  // Write one changed setting field into every selected meta.
  const applyPatch = useCallback((patch: Partial<TextureImportSettings>) => {
    setMetas((prev) => {
      const next: MetaMap = { ...prev };
      for (const p of paths) {
        const m = prev[p] ?? {};
        const curSettings = resolveTextureSettings(m as { type?: TextureType; texture?: Partial<TextureImportSettings> });
        const curType = resolveTextureType(m as { type?: TextureType; texture?: Partial<TextureImportSettings> });
        const updated = { ...m, version: 2, type: curType, texture: { ...curSettings, ...patch } };
        next[p] = updated;
        writeMetaOrWarn(p, updated);
      }
      return next;
    });
  }, [paths]);

  // Changing the type RESETS the codec block to that type's derived defaults for
  // every selected texture (matches single-select changeType semantics).
  const applyType = useCallback((nextType: TextureType) => {
    const derived = deriveSettingsForType(nextType);
    setMetas((prev) => {
      const next: MetaMap = { ...prev };
      for (const p of paths) {
        const updated = { ...(prev[p] ?? {}), version: 2, type: nextType, texture: derived };
        next[p] = updated;
        writeMetaOrWarn(p, updated);
      }
      return next;
    });
  }, [paths]);

  const reimportAll = useCallback(async () => {
    setImporting(true);
    try {
      await reimportPaths(paths.map((p) => ({ path: p, type: 'texture' })), setImportStatus, `Re-importing ${paths.length} textures…`);
      await loadAll();
      refreshAssets();
    } finally {
      setImporting(false);
      setImportStatus(false);
    }
  }, [paths, setImportStatus, loadAll, refreshAssets]);

  if (!loaded) return <div style={{ color: '#666', fontSize: 11 }}>Loading {paths.length} textures…</div>;

  return (
    <>
      <TextureSettingsControls type={type} settings={settings} mixed={mixedKeys} onChangeType={applyType} onChange={applyPatch} advancedOpen={true} />
      <button
        disabled={importing}
        onClick={reimportAll}
        style={{ ...reimportBtnStyle, marginTop: 8, background: importing ? '#555' : '#2ecc71', color: '#fff', border: `1px solid ${importing ? '#444' : '#27ae60'}`, cursor: importing ? 'wait' : 'pointer' }}
      >
        {importing ? 'Converting…' : `Re-import all (${paths.length})`}
      </button>
    </>
  );
}
