/** TextureAssetView (+ TextureImportedStats) — texture import settings editor +
 *  Apply (convert) action. Extracted from Inspector.tsx (editor-inspector.md F2).
 *  Settings persist to the texture's .meta.json on change; Apply runs the
 *  conversion + reloads. */

import { useState, useEffect, useCallback, useRef } from 'react';
import { backendFetch } from '../../backend/editorBackend';
import { useEditorStore } from '../../store/editorStore';
import { DEFAULT_TEXTURE_SETTINGS, TEXTURE_MAX_SIZES, DEFAULT_WEBP_QUALITY, DEFAULT_UASTC_LEVEL, DEFAULT_UASTC_RDO_LAMBDA, UASTC_LEVELS, resolveTextureSettings, resolveTextureType, deriveSettingsForType, variantsToEmit, resolveWebpQuality, resolveUastcRdoLambda, type TextureImportSettings, type TextureFormat, type TextureType, type TextureCacheInfo } from '../../../runtime/loaders/textureSettings';
import { invalidateTexture } from '../../../runtime/loaders/textureResolver';
import { registerSprite, isGuid, deriveGuid } from '../../../runtime/loaders/assetManifest';
import { markUIDirty } from '../../../runtime/ui/uiTreeStore';
import { inputStyle, BufferedNumberInput, MIXED_PLACEHOLDER } from '../fields';
import { DropdownField, SubSection, formatBytes, reimportBtnStyle, writeMetaOrWarn } from './widgets';
import { SpriteEditor } from '../SpriteEditor';
import { NineSliceEditor } from '../NineSliceEditor';

const TEXTURE_TYPE_OPTIONS: { value: TextureType; label: string }[] = [
  { value: '3d', label: '3D — model / material (mipmapped, KTX2)' },
  { value: '2d', label: '2D — sprite / atlas (PixiJS)' },
  { value: 'ui', label: 'UI — DOM image (WebP, 9-slice)' },
];

/** Codec options offered per texture type. UI is locked to WebP (CSS/DOM can't
 *  decode KTX2); 3D offers the KTX2 family; 2D offers UASTC (GPU-memory win) plus
 *  WebP/PNG overrides for crisp/alpha art. */
const FORMAT_OPTIONS_BY_TYPE: Record<TextureType, { value: TextureFormat; label: string }[]> = {
  '3d': [
    { value: 'ktx2-uastc', label: 'KTX2 UASTC (default)' },
    { value: 'ktx2-etc1s', label: 'KTX2 ETC1S (small)' },
    { value: 'ktx2-astc', label: 'KTX2 ASTC (native)' },
  ],
  '2d': [
    { value: 'ktx2-uastc', label: 'KTX2 UASTC (GPU memory)' },
    { value: 'webp', label: 'WebP (crisp / small download)' },
    { value: 'png', label: 'PNG (uncompressed)' },
  ],
  'ui': [
    { value: 'webp', label: 'WebP' },
    { value: 'png', label: 'PNG (uncompressed)' },
  ],
};

/** Keys of a texture import setting that can be marked "mixed" in a multi-select. */
export type TextureSettingKey = 'type' | keyof TextureImportSettings;

/** Tri-state checkbox: renders indeterminate when `mixed`, clearing to a definite
 *  value on the user's click. */
function MixedCheckbox({ checked, mixed, onChange }: { checked: boolean; mixed?: boolean; onChange: (v: boolean) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = !!mixed; }, [mixed]);
  return <input ref={ref} type="checkbox" checked={mixed ? false : checked} onChange={(e) => onChange(e.target.checked)} />;
}

/** Presentational texture Type + Advanced settings block, shared by the single-asset
 *  TextureAssetView and the multi-select TextureBatchView. When `mixed` marks a key,
 *  that control shows a non-committal placeholder; picking a value broadcasts it. */
export function TextureSettingsControls({ type, settings, mixed, onChangeType, onChange, advancedOpen = true }: {
  type: TextureType;
  settings: TextureImportSettings;
  mixed?: Set<TextureSettingKey>;
  onChangeType: (t: TextureType) => void;
  onChange: (patch: Partial<TextureImportSettings>) => void;
  advancedOpen?: boolean;
}) {
  const labelStyle: React.CSSProperties = { flex: 1, color: '#888', fontSize: '11px' };
  const rowStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 4, marginBottom: 3 };
  const sectionStyle: React.CSSProperties = { color: '#f1c40f', fontSize: '10px', textTransform: 'uppercase', margin: '8px 0 3px' };
  const isMixed = (k: TextureSettingKey) => !!mixed?.has(k);
  // The WebP-quality control is meaningful only when a WebP file is actually emitted
  // (a `webp` format, or a 2d/ui KTX2 texture's browser sibling — see variantsToEmit).
  const webpEmitted = variantsToEmit(settings.format, type).includes('webp');
  // UASTC knobs apply only when a `uastc` variant is emitted (ktx2-uastc, and the
  // universal sibling of ktx2-astc).
  const uastcEmitted = variantsToEmit(settings.format, type).includes('uastc');
  return (
    <>
      <div style={sectionStyle}>Type</div>
      <div style={rowStyle}>
        <span style={labelStyle}>Texture Type</span>
        <select value={isMixed('type') ? '' : type} onChange={(e) => { if (e.target.value) onChangeType(e.target.value as TextureType); }} style={{ ...inputStyle, flex: 1 }}>
          {isMixed('type') && <option value="">{MIXED_PLACEHOLDER}</option>}
          {TEXTURE_TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>

      <SubSection title="Advanced" defaultOpen={advancedOpen}>
        <div style={rowStyle}>
          <span style={labelStyle}>Format</span>
          <select value={isMixed('format') ? '' : settings.format} disabled={type === 'ui' && FORMAT_OPTIONS_BY_TYPE.ui.length === 1} onChange={(e) => { if (e.target.value) onChange({ format: e.target.value as TextureFormat }); }} style={{ ...inputStyle, flex: 1 }}>
            {isMixed('format') && <option value="">{MIXED_PLACEHOLDER}</option>}
            {FORMAT_OPTIONS_BY_TYPE[type].map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div style={rowStyle}>
          <span style={labelStyle}>Max Size</span>
          <select value={isMixed('maxSize') ? '' : String(settings.maxSize)} onChange={(e) => { if (e.target.value) onChange({ maxSize: Number(e.target.value) as TextureImportSettings['maxSize'] }); }} style={{ ...inputStyle, flex: 1 }}>
            {isMixed('maxSize') && <option value="">{MIXED_PLACEHOLDER}</option>}
            {TEXTURE_MAX_SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div style={rowStyle}>
          <span style={labelStyle}>Generate Mipmaps</span>
          <MixedCheckbox checked={settings.mipmaps} mixed={isMixed('mipmaps')} onChange={(v) => onChange({ mipmaps: v })} />
        </div>
        <DropdownField label="Wrap S" value={settings.wrapS} mixed={isMixed('wrapS')} options={['repeat', 'clamp', 'mirror']} onChange={(v) => onChange({ wrapS: v as TextureImportSettings['wrapS'] })} />
        <DropdownField label="Wrap T" value={settings.wrapT} mixed={isMixed('wrapT')} options={['repeat', 'clamp', 'mirror']} onChange={(v) => onChange({ wrapT: v as TextureImportSettings['wrapT'] })} />
        <div style={rowStyle}>
          <span style={labelStyle}>Colorspace</span>
          <select value={isMixed('colorspace') ? '' : settings.colorspace} onChange={(e) => { if (e.target.value) onChange({ colorspace: e.target.value as TextureImportSettings['colorspace'] }); }} style={{ ...inputStyle, flex: 1 }}>
            {isMixed('colorspace') && <option value="">{MIXED_PLACEHOLDER}</option>}
            <option value="srgb">sRGB (color)</option>
            <option value="linear">Linear (data / normal)</option>
          </select>
        </div>
        <div style={rowStyle}>
          <span style={labelStyle}>Flip Y</span>
          <MixedCheckbox checked={settings.flipY ?? false} mixed={isMixed('flipY')} onChange={(v) => onChange({ flipY: v })} />
        </div>
        <div style={rowStyle}>
          <span style={labelStyle}>Flip Green (normal)</span>
          <MixedCheckbox checked={settings.flipGreen ?? false} mixed={isMixed('flipGreen')} onChange={(v) => onChange({ flipGreen: v })} />
        </div>
        {webpEmitted && (
          <div style={rowStyle}>
            <span style={labelStyle}>WebP Quality</span>
            {isMixed('webpQuality') ? (
              <input value={MIXED_PLACEHOLDER} readOnly style={{ ...inputStyle, flex: 1 }} />
            ) : (
              <BufferedNumberInput
                value={settings.webpQuality ?? DEFAULT_WEBP_QUALITY}
                step={1}
                onChange={(v) => onChange({ webpQuality: resolveWebpQuality(v) })}
                style={{ ...inputStyle, flex: 1 }}
              />
            )}
          </div>
        )}
        {uastcEmitted && (
          <>
            <div style={rowStyle}>
              <span style={labelStyle}>UASTC Level</span>
              <select
                value={isMixed('uastcLevel') ? '' : String(settings.uastcLevel ?? DEFAULT_UASTC_LEVEL)}
                onChange={(e) => { if (e.target.value) onChange({ uastcLevel: Number(e.target.value) }); }}
                style={{ ...inputStyle, flex: 1 }}
              >
                {isMixed('uastcLevel') && <option value="">{MIXED_PLACEHOLDER}</option>}
                {UASTC_LEVELS.map((l) => <option key={l} value={l}>{l}{l === DEFAULT_UASTC_LEVEL ? ' (default)' : ''}</option>)}
              </select>
            </div>
            <div style={rowStyle}>
              <span style={labelStyle}>UASTC RDO λ</span>
              {isMixed('uastcRdoLambda') ? (
                <input value={MIXED_PLACEHOLDER} readOnly style={{ ...inputStyle, flex: 1 }} />
              ) : (
                <BufferedNumberInput
                  value={settings.uastcRdoLambda ?? DEFAULT_UASTC_RDO_LAMBDA}
                  step={0.1}
                  min={0}
                  max={4}
                  onChange={(v) => onChange({ uastcRdoLambda: resolveUastcRdoLambda(v) })}
                  style={{ ...inputStyle, flex: 1 }}
                />
              )}
            </div>
          </>
        )}
      </SubSection>
    </>
  );
}

export function TextureAssetView({ path, name }: { path: string; name: string }) {
  const [meta, setMeta] = useState<Record<string, unknown> | null>(null);
  const [settings, setSettings] = useState<TextureImportSettings>(DEFAULT_TEXTURE_SETTINGS);
  const [type, setType] = useState<TextureType>('3d');
  const [importing, setImporting] = useState(false);
  const [converted, setConverted] = useState(false);
  const [spriteEditorOpen, setSpriteEditorOpen] = useState(false);
  const [nineSliceOpen, setNineSliceOpen] = useState(false);

  // Enact: honor a headless open-modal request (requestTextureEditor / the
  // open-sprite-editor / open-nine-slice-editor ops) once this view owns the requested
  // texture. The request selects the asset first, so this mounts, then opens + clears.
  const textureEditorRequest = useEditorStore((s) => s.textureEditorRequest);
  const clearTextureEditorRequest = useEditorStore((s) => s.clearTextureEditorRequest);
  useEffect(() => {
    if (!textureEditorRequest || textureEditorRequest.path !== path) return;
    if (textureEditorRequest.kind === 'nineslice') setNineSliceOpen(true);
    else setSpriteEditorOpen(true);
    clearTextureEditorRequest();
  }, [textureEditorRequest, path, clearTextureEditorRequest]);
  const spriteCount = Array.isArray(meta?.sprites) ? (meta!.sprites as unknown[]).length : 0;
  const refreshAssets = useEditorStore((s) => s.refreshAssets);
  const setImportStatus = useEditorStore((s) => s.setImportStatus);

  const loadMeta = useCallback((signal?: AbortSignal) => {
    return backendFetch(`/api/read-meta?path=${encodeURIComponent(path)}`, signal ? { signal } : undefined)
      .then((r) => (r.ok ? r.json() : {}))
      .then((m: Record<string, unknown>) => {
        setMeta(m);
        setSettings(resolveTextureSettings(m as { type?: TextureType; texture?: Partial<TextureImportSettings> }));
        setType(resolveTextureType(m as { type?: TextureType; texture?: Partial<TextureImportSettings> }));
        setConverted(!!m.textureCache);
      })
      .catch(() => { /* keep defaults */ });
  }, [path]);

  useEffect(() => {
    const ac = new AbortController();
    loadMeta(ac.signal);
    return () => ac.abort();
  }, [loadMeta]);

  // Persist a settings change to the meta sidecar immediately (controls are
  // discrete, so no debounce needed). The full meta is preserved (id/textureCache).
  const update = useCallback((patch: Partial<TextureImportSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      const updatedMeta = { ...(meta ?? {}), version: 2, type, texture: next };
      setMeta(updatedMeta);
      writeMetaOrWarn(path, updatedMeta);
      return next;
    });
  }, [meta, path, type]);

  // 9-slice border insets (UI type) live at meta.border — persisted onto the
  // texture's auto whole-image sprite by the scanner, consumed by UINode as
  // `border-image`. Preserved across other meta edits.
  const border = (meta?.border as { l?: number; r?: number; t?: number; b?: number; scale?: number } | undefined) ?? { l: 0, r: 0, t: 0, b: 0 };
  const updateBorder = useCallback((patch: Partial<{ l: number; r: number; t: number; b: number; scale: number }>) => {
    setMeta((prev) => {
      const prevB = (prev?.border as Record<string, number> | undefined) ?? { l: 0, r: 0, t: 0, b: 0 };
      const merged = { l: prevB.l || 0, r: prevB.r || 0, t: prevB.t || 0, b: prevB.b || 0, scale: prevB.scale || 1, ...patch };
      // Don't persist the default scale (keeps metas clean; absent ⇒ 1).
      const hasBorder = merged.l || merged.r || merged.t || merged.b;
      const nextB = { l: merged.l, r: merged.r, t: merged.t, b: merged.b,
        ...(merged.scale !== 1 ? { scale: merged.scale } : {}) };
      const updatedMeta: Record<string, unknown> = { ...(prev ?? {}), version: 2, border: nextB };
      writeMetaOrWarn(path, updatedMeta);
      // Live-apply to the texture's auto whole-image sprite so the scene view reflects
      // border/edge-scale edits immediately (without a re-import/rescan) — same path
      // the visual 9-slice editor uses.
      const texGuid = typeof updatedMeta.id === 'string' ? updatedMeta.id : undefined;
      const tc = updatedMeta.textureCache as { width?: number; height?: number; srcWidth?: number; srcHeight?: number } | undefined;
      const w = tc?.srcWidth ?? tc?.width, h = tc?.srcHeight ?? tc?.height;
      if (texGuid && isGuid(texGuid) && w && h) {
        registerSprite(deriveGuid('sprite:' + texGuid), texGuid, path, {
          texture: texGuid, name, rect: { x: 0, y: 0, w, h }, pivot: { x: 0.5, y: 0.5 },
          sheetW: w, sheetH: h, ...(hasBorder ? { border: nextB } : {}),
        });
        markUIDirty();
      }
      return updatedMeta;
    });
  }, [path, name]);

  // Changing the type RESETS the codec block to that type's derived defaults
  // (so 3D→2D flips mips/wrap and 3D→UI flips to WebP). Advanced-section edits
  // afterward express explicit overrides on top.
  const changeType = useCallback((nextType: TextureType) => {
    const next = deriveSettingsForType(nextType);
    setType(nextType);
    setSettings(next);
    const updatedMeta = { ...(meta ?? {}), version: 2, type: nextType, texture: next };
    setMeta(updatedMeta);
    writeMetaOrWarn(path, updatedMeta);
  }, [meta, path]);

  const apply = useCallback(async () => {
    setImporting(true);
    setImportStatus(true, `Converting ${name}...`);
    try {
      const res = await backendFetch('/api/reimport', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      });
      const summary = await res.json().catch(() => ({}));
      if (!res.ok || (summary.errors && summary.errors.length)) {
        console.error('[Inspector] Texture convert failed:', summary.errors ?? summary);
      }
      await loadMeta();
      invalidateTexture(path);
      refreshAssets();
    } finally {
      setImporting(false);
      setImportStatus(false);
    }
  }, [path, name, loadMeta, refreshAssets, setImportStatus]);

  const labelStyle: React.CSSProperties = { flex: 1, color: '#888', fontSize: '11px' };
  const rowStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 4, marginBottom: 3 };
  const sectionStyle: React.CSSProperties = { color: '#f1c40f', fontSize: '10px', textTransform: 'uppercase', margin: '8px 0 3px' };

  return (
    <>
      {/* Source preview */}
      <img src={path} alt={name} style={{ width: '100%', maxHeight: 140, objectFit: 'contain', background: '#1a1a1a', border: '1px solid #333', marginBottom: 6 }} />

      <TextureSettingsControls type={type} settings={settings} onChangeType={changeType} onChange={update} advancedOpen={false} />

      {type === 'ui' && (
        <>
          <div style={sectionStyle}>9-slice border (px)</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
            {(['l', 'r', 't', 'b'] as const).map((edge) => (
              <div key={edge} style={rowStyle}>
                <span style={labelStyle}>{{ l: 'Left', r: 'Right', t: 'Top', b: 'Bottom' }[edge]}</span>
                <BufferedNumberInput value={border[edge] ?? 0} step={1}
                  onChange={(v) => updateBorder({ [edge]: Math.max(0, Math.round(v)) })}
                  style={{ ...inputStyle, width: 56 }} />
              </div>
            ))}
            <div style={rowStyle}>
              <span style={labelStyle}>Edge scale</span>
              <BufferedNumberInput value={border.scale ?? 1} step={0.05}
                onChange={(v) => updateBorder({ scale: Math.max(0.05, v || 1) })}
                style={{ ...inputStyle, width: 56 }} />
            </div>
          </div>
          <button onClick={() => setNineSliceOpen(true)} style={{ ...reimportBtnStyle, marginTop: 4 }}>Edit visually…</button>
          <div style={{ color: '#666', fontSize: 10, marginTop: 2 }}>Corners stay fixed; edges + center stretch (CSS border-image). Re-import to apply to the whole-image sprite.</div>
        </>
      )}
      {nineSliceOpen && (
        <NineSliceEditor path={path} name={name} onClose={() => { setNineSliceOpen(false); loadMeta(); }} />
      )}

      <button
        disabled={importing}
        onClick={apply}
        style={{ ...reimportBtnStyle, marginTop: 8, background: importing ? '#555' : '#2ecc71', color: '#fff', border: `1px solid ${importing ? '#444' : '#27ae60'}`, cursor: importing ? 'wait' : 'pointer' }}
      >
        {importing ? 'Converting...' : converted ? 'Re-import' : 'Apply'}
      </button>
      {converted && <TextureImportedStats cache={meta?.textureCache as TextureCacheInfo | undefined} />}

      <div style={sectionStyle}>Sprites</div>
      <button
        onClick={() => setSpriteEditorOpen(true)}
        style={{ ...reimportBtnStyle, marginTop: 2 }}
      >
        Sprite Editor{spriteCount > 0 ? ` (${spriteCount})` : ''}
      </button>
      {spriteEditorOpen && (
        <SpriteEditor path={path} name={name} onClose={() => { setSpriteEditorOpen(false); loadMeta(); }} />
      )}
    </>
  );
}

/** Post-conversion stats read back from the meta sidecar: actual (snapped)
 *  dimensions, baked mip levels, and on-disk size per produced variant. */
function TextureImportedStats({ cache }: { cache: TextureCacheInfo | undefined }) {
  const rowStyle: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', fontSize: '11px', padding: '1px 0' };
  const labelStyle: React.CSSProperties = { color: '#888' };
  const valStyle: React.CSSProperties = { color: '#ccc' };
  const sectionStyle: React.CSSProperties = { color: '#f1c40f', fontSize: '10px', textTransform: 'uppercase', margin: '10px 0 3px' };

  if (!cache || cache.width === undefined) {
    return <div style={{ color: '#666', fontSize: '10px', marginTop: 4 }}>Converted ✓ — re-import to compute stats</div>;
  }
  const bytes = cache.variantBytes ?? {};
  const total = Object.values(bytes).reduce((a, b) => a + (b ?? 0), 0);
  return (
    <>
      <div style={sectionStyle}>Imported</div>
      <div style={rowStyle}><span style={labelStyle}>Dimensions</span><span style={valStyle}>{cache.width} × {cache.height}</span></div>
      <div style={rowStyle}><span style={labelStyle}>Mip levels</span><span style={valStyle}>{cache.mipLevels ?? 1}</span></div>
      <div style={sectionStyle}>Disk size</div>
      {(cache.variants ?? []).map((v) => (
        <div key={v} style={rowStyle}><span style={labelStyle}>{v}</span><span style={valStyle}>{bytes[v] !== undefined ? formatBytes(bytes[v]!) : '—'}</span></div>
      ))}
      <div style={{ ...rowStyle, borderTop: '1px solid #333', marginTop: 2, paddingTop: 3 }}>
        <span style={{ ...labelStyle, color: '#aaa' }}>Total</span><span style={{ ...valStyle, color: '#fff' }}>{formatBytes(total)}</span>
      </div>
    </>
  );
}
