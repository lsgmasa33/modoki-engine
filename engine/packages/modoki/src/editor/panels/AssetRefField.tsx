/** AssetRefField — a GUID-aware asset reference input shared by the Inspector and
 *  the Particle Editor. Accepts an asset drag-and-drop (stores the asset's GUID),
 *  displays a GUID ref by the asset's friendly name (with the guid/path in a hover
 *  tooltip), and offers a "locate in Assets" button. Font refs resolve to a CSS
 *  family name on drop. References are GUID-only — see assetManifest. */

import { useEffect, useRef, useState } from 'react';
import { useEditorStore } from '../store/editorStore';
import { fontPathFromFamily, loadFont } from '../../runtime/loaders/fontLoader';
import { isGuid, isExternalUrl, resolveGuidToPath, getGuidForPath, getAllAssets, getAssetEntry } from '../../runtime/loaders/assetManifest';
import { BufferedTextInput, Tooltip, inputStyle, MIXED_PLACEHOLDER } from './fields';
import { acceptMatchesAsset } from '../utils/dragGhost';
import { classifyJsonAssetSuffix } from '../../runtime/loaders/assetTypeClassifier';
import { SpritePicker } from './SpritePicker';

/** Infer asset type from file extension. The JSON asset kinds come from the shared
 *  classifier (assetTypeClassifier) — the same single source of truth the asset
 *  scanner + tree-shaker use — so this can't drift (it previously lacked
 *  `.animset.json`/`.shader.json` and mislabeled them 'unknown'). */
export function assetTypeFromPath(path: string): string {
  const jsonType = classifyJsonAssetSuffix(path);
  if (jsonType) return jsonType;
  if (path.endsWith('.scene.json')) return 'scene';
  if (path.endsWith('.hdr')) return 'environment';
  if (/\.(png|jpe?g|webp)$/i.test(path)) return 'texture';
  if (/\.(glb|gltf)$/i.test(path)) return 'model';
  if (/\.(mp3|m4a|aac|wav|ogg|flac)$/i.test(path)) return 'audio';
  if (/\.(ttf|otf|woff2?)$/i.test(path)) return 'font';
  return 'unknown';
}

/** Friendly name for an asset path — basename without its (possibly double)
 *  extension. e.g. "/m/CubeMaterial.mat.json" → "CubeMaterial", "island.glb" → "island". */
export function assetDisplayName(path: string): string {
  const base = path.split('/').pop() || path;
  return base.replace(/\.(mesh|mat|prefab|scene|particle|anim)\.json$/i, '').replace(/\.[^/.]+$/, '');
}

/** Whether a TYPED / pasted value is an acceptable reference for this field. Drag-drop
 *  and the picker always write a GUID, so this only guards manual text entry: a stray
 *  string like "1" must NOT be committable into a GUID-only ref field, or the runtime
 *  resolves it to a path that 404s (the exact bug this prevents). Accepts: empty (clear),
 *  an asset GUID, an external URL/data-URI, a font-family name (font fields only), and a
 *  primitive sprite keyword (sprite/image fields only). Everything else is rejected. */
export function isAcceptableTypedRef(v: string, accept?: string[], fontFamilyRef = false): boolean {
  const s = v.trim();
  if (!s) return true;                                   // empty = clear
  if (isGuid(s) || isExternalUrl(s)) return true;        // pasted GUID / http(s)·data·blob URL
  // A CSS-font-FAMILY field (UIElement.fontFamily) holds a family name — any string is
  // plausible. An SDF font-GUID field (Text2D/Text3D.font) does NOT: a typed non-GUID
  // there is rejected (the runtime resolves GUIDs only, so a family name renders nothing).
  if (fontFamilyRef && accept?.some((ext) => /\.(ttf|otf|woff2?)$/i.test(ext))) return true;
  // Primitive sprite keywords are valid sprite/texture refs.
  if (/^(circle|square|triangle)$/i.test(s) &&
      accept?.some((a) => a === 'sprite' || /\.(png|jpe?g|webp)$/i.test(a))) return true;
  return false;
}

export function AssetRefField({ label, value, onChange, overrideColor = false, accept, hint, placeholder, mixed = false, fontFamilyRef = false, editorPanel }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  overrideColor?: boolean;
  accept?: string[];
  hint?: string;
  placeholder?: string;
  /** Multi-select: values differ across entities. Shows an editable field with a
   *  MIXED_PLACEHOLDER hint; dropping an asset / typing broadcasts to all. */
  mixed?: boolean;
  /** Id of a registered editor panel that edits this asset kind (FieldHint.editorPanel).
   *  When set and the ref resolves, an "Open" button selects the asset AND docks/focuses
   *  that panel — e.g. FieldSource.level → the sling Field Editor. */
  editorPanel?: string;
  /** This is a CSS-font-FAMILY field (`UIElement.fontFamily`, DOM/UI text), so a
   *  dropped font resolves to its family NAME. Default false: SDF font fields
   *  (`Text2D`/`Text3D.font`) store the asset GUID like every other asset ref. */
  fontFamilyRef?: boolean;
}) {
  const divRef = useRef<HTMLDivElement>(null);
  const fontFamilyRefRef = useRef(fontFamilyRef);
  fontFamilyRefRef.current = fontFamilyRef;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const acceptRef = useRef(accept);
  acceptRef.current = accept;
  const selectAsset = useEditorStore((s) => s.selectAsset);
  const openPanel = useEditorStore((s) => s.openPanel);
  // Sprite picker: fields that accept sprites get a "▾" button (sliced sprites have
  // no Assets-panel row to drag from, so a picker is the assignment path).
  const acceptsSprite = !!accept?.includes('sprite');
  const [pickerAnchor, setPickerAnchor] = useState<DOMRect | null>(null);

  // Listen for asset-drop CustomEvent dispatched by dragGhost's completeAssetDrop()
  useEffect(() => {
    const el = divRef.current;
    if (!el) return;
    const onAssetDrop = (e: Event) => {
      const raw = (e as CustomEvent).detail as string;
      const { path, guid, type } = JSON.parse(raw) as { path: string; guid?: string; type?: string };
      if (!acceptMatchesAsset(acceptRef.current, path, type)) return;
      // A CSS-family field (UIElement.fontFamily, DOM/UI text): resolve the dropped
      // font to its family NAME + ensure it's loaded. SDF font fields (Text2D/Text3D
      // .font) fall through to the GUID path below — storing a family name there
      // makes the SDF loader reject the ref and the text renders NOTHING.
      if (fontFamilyRefRef.current && /\.(ttf|otf|woff2?)$/i.test(path)) {
        // F7: a failed font fetch/decode must not surface as an unhandled rejection —
        // warn and leave the ref unchanged (the prior family stays in effect).
        loadFont(path)
          .then(family => onChangeRef.current(family))
          .catch(err => console.warn(`[AssetRefField] font load failed for ${path}:`, err));
        return;
      }
      // Store a GUID, not a path — refs must survive the asset being moved, and
      // the runtime hard-rejects raw-path refs. Prefer the payload's guid, then
      // the manifest by path. If neither resolves, refuse rather than write a
      // path that fails at load: the dev scan auto-heals missing guids, so a
      // rescan (the warning hints at it) makes the asset droppable.
      const resolved = guid || getGuidForPath(path);
      if (!resolved) {
        console.warn(
          `[AssetRefField] "${path}" has no GUID yet — not assigning a raw path ` +
          `(the runtime only resolves GUIDs). Refresh the Assets panel to mint one, then drop again.`,
        );
        return;
      }
      onChangeRef.current(resolved);
    };
    el.addEventListener('asset-drop', onAssetDrop);
    return () => el.removeEventListener('asset-drop', onAssetDrop);
  }, []);

  const isAssetPath = value && value.startsWith('/') && value.includes('.');
  // References are GUIDs — resolve through the manifest to a concrete path.
  const guidPath = value && isGuid(value) ? resolveGuidToPath(value) : null;
  // Font family names aren't paths — reverse-lookup to find the font asset
  const isFontAccept = accept && accept.some(ext => /\.(ttf|otf|woff2?)$/i.test(ext));
  const fontAssetPath = isFontAccept && value && !isAssetPath && !guidPath ? fontPathFromFamily(value) : null;
  const targetPath = guidPath || (isAssetPath ? value : null) || fontAssetPath;
  const canLocate = !!targetPath;
  const locateAsset = () => {
    if (!targetPath) return;
    const name = targetPath.substring(targetPath.lastIndexOf('/') + 1);
    selectAsset({ path: targetPath, type: assetTypeFromPath(targetPath), name });
  };
  // Open in the game's asset editor panel: select the asset (retargets a
  // selection-driven panel like the Field Editor) THEN dock/focus that panel.
  const canOpenPanel = !!(editorPanel && targetPath);
  const openInPanel = () => {
    if (!targetPath || !editorPanel) return;
    const name = targetPath.substring(targetPath.lastIndexOf('/') + 1);
    selectAsset({ path: targetPath, type: assetTypeFromPath(targetPath), name });
    openPanel(editorPanel);
  };

  // GUID references display the asset's NAME (not the opaque guid). The guid +
  // resolved path live in a hover tooltip. The input is read-only because a
  // name can't be edited back into a guid — replace the ref by dropping another
  // asset onto the field (the drop target is the wrapper div, still active).
  const isGuidRef = !!(value && isGuid(value));
  // A sliced-sprite GUID resolves to its PARENT texture's path, so the texture name
  // would be shown for every frame. Prefer the sprite slice's own name when the GUID
  // is a 'sprite' asset; fall back to the texture/asset name otherwise.
  const spriteEntry = isGuidRef ? getAssetEntry(value) : undefined;
  const spriteName = spriteEntry?.type === 'sprite' ? spriteEntry.sprite?.name : undefined;
  const refName = isGuidRef ? (spriteName || (guidPath ? assetDisplayName(guidPath) : value)) : null;
  const refTooltip = isGuidRef
    ? `${spriteName ? `Sprite: ${spriteName}\n` : ''}GUID: ${value}\n${guidPath ? `Path: ${guidPath}` : '(not in manifest)'}`
    : '';
  const inputColor = overrideColor ? '#5dade2' : '#ddd';
  const inputWeight = overrideColor ? 'bold' : 'normal';

  const labelColor = overrideColor ? '#5dade2' : '#888';
  // Empty label (e.g. sprite-animation frame rows) → render NO label span at all, so
  // the value input sits flush after the row's leading content instead of a flex:1
  // spacer pushing it to the right half of the row.
  const labelEl = label
    ? <span style={{ flex: 1, color: labelColor, fontSize: '11px', fontWeight: overrideColor ? 'bold' : 'normal' }}>{label}</span>
    : null;

  return (
    <div
      ref={divRef}
      data-drop-target="true"
      data-accept={accept?.join(',') || ''}
      style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 2, borderRadius: 3 }}
    >
      {hint ? <Tooltip text={hint} style={{ flex: 1, display: 'flex' }}>{labelEl}</Tooltip> : labelEl}
      {mixed ? (
        <BufferedTextInput value="" onChange={onChange} mixed placeholder={MIXED_PLACEHOLDER}
          validate={(v) => isAcceptableTypedRef(v, accept, fontFamilyRef)}
          style={{ ...inputStyle, flex: 1, color: inputColor, fontWeight: inputWeight }} />
      ) : refName !== null ? (
        <Tooltip text={refTooltip} style={{ flex: 1, display: 'flex' }}>
          <input type="text" readOnly value={refName}
            title="Backspace to clear"
            onKeyDown={(e) => {
              // The field is read-only (a name can't be typed back into a GUID),
              // but Backspace/Delete clears the reference when it's focused.
              if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); onChange(''); }
            }}
            style={{ ...inputStyle, flex: 1, width: '100%', color: inputColor, fontWeight: inputWeight, background: '#1a1a2e', cursor: 'help' }} />
        </Tooltip>
      ) : (
        <BufferedTextInput value={value} onChange={onChange} placeholder={placeholder}
          validate={(v) => isAcceptableTypedRef(v, accept, fontFamilyRef)}
          style={{ ...inputStyle, flex: 1, color: inputColor, fontWeight: inputWeight }} />
      )}
      {acceptsSprite && (
        <button
          onClick={(e) => setPickerAnchor((e.currentTarget as HTMLElement).getBoundingClientRect())}
          title="Pick a sprite"
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#888', padding: 0, fontSize: '12px', lineHeight: 1, flexShrink: 0 }}
        >▦</button>
      )}
      {canOpenPanel && (
        <button onClick={openInPanel} title="Open in editor" style={{
          background: 'none', border: '1px solid #3a3a3a', borderRadius: 3, cursor: 'pointer',
          color: '#bbb', padding: '1px 6px', fontSize: '10px', lineHeight: 1.4, flexShrink: 0,
        }}>Open</button>
      )}
      {canLocate && (
        <button onClick={locateAsset} title="Locate in Assets" style={{
          background: 'none', border: 'none', cursor: 'pointer', color: '#888',
          padding: 0, fontSize: '12px', lineHeight: 1, flexShrink: 0,
        }}>
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
            <circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5"/>
            <line x1="11" y1="11" x2="15" y2="15" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
        </button>
      )}
      {pickerAnchor && (
        <SpritePicker
          anchor={pickerAnchor}
          assets={getAllAssets()}
          onPick={(guid) => { onChange(guid); setPickerAnchor(null); }}
          onClear={() => { onChange(''); setPickerAnchor(null); }}
          onClose={() => setPickerAnchor(null)}
        />
      )}
    </div>
  );
}
