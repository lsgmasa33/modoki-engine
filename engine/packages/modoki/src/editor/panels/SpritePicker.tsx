/** SpritePicker — a popup that lists sliced sprites (grouped by their source texture)
 *  so they can be assigned to a sprite-accepting ref field. Sliced sprites have no
 *  Assets-panel row to drag from, so this is the assignment path. Each row shows a
 *  cropped thumbnail of the frame (using the dev-served source image) + its name;
 *  clicking assigns the sprite's GUID. A per-texture "whole image" row assigns the
 *  texture's auto whole-image SPRITE GUID (never the raw texture — 2D refs are
 *  sprites-only). Dev-only (editor). */

import { useRef } from 'react';
import { useOverlayEscape } from '../input/useOverlayEscape';
import type { AssetEntry } from '../../runtime/loaders/assetManifest';
import { resolveGuidToPath } from '../../runtime/loaders/assetManifest';
import { deriveGuid } from '../../runtime/loaders/assetRefRules';
import { assetDisplayName } from './AssetRefField';

/** The whole-image sprite GUID a 2D/UI texture auto-exposes — must match the
 *  scanner's `deriveGuid('sprite:' + textureGuid)`. Assigning THIS (not the raw
 *  texture GUID) is what keeps 2D refs sprites-only. */
const wholeImageSpriteGuid = (texGuid: string) => deriveGuid('sprite:' + texGuid);

const BOX_W = 46;
const BOX_H = 38;

/** CSS to crop one source-px frame out of the source image into a box tile.
 *  Exported so list editors (e.g. SpriteAnimatorSection's frame rows) can render
 *  the same cropped thumbnail. `box` defaults to the picker's BOX_W×BOX_H. */
export function spriteThumbStyle(
  srcUrl: string | undefined,
  rect: { x: number; y: number; w: number; h: number },
  sheetW?: number, sheetH?: number,
  box: { w: number; h: number } = { w: BOX_W, h: BOX_H },
): React.CSSProperties {
  const BOX_W = box.w, BOX_H = box.h;
  const base: React.CSSProperties = { width: BOX_W, height: BOX_H, flexShrink: 0, background: '#0e0e16', border: '1px solid #333', backgroundRepeat: 'no-repeat', backgroundPosition: 'center', imageRendering: 'pixelated' };
  if (!srcUrl || !sheetW || !sheetH || rect.w <= 0 || rect.h <= 0) {
    return { ...base, backgroundImage: srcUrl ? `url("${srcUrl}")` : undefined, backgroundSize: 'contain' };
  }
  const scale = Math.min(BOX_W / rect.w, BOX_H / rect.h);
  const dispW = rect.w * scale, dispH = rect.h * scale;
  return {
    ...base,
    backgroundImage: `url("${srcUrl}")`,
    backgroundSize: `${sheetW * scale}px ${sheetH * scale}px`,
    backgroundPosition: `${(BOX_W - dispW) / 2 - rect.x * scale}px ${(BOX_H - dispH) / 2 - rect.y * scale}px`,
  };
}

export function SpritePicker({ anchor, assets, onPick, onClear, onClose }: {
  anchor: DOMRect;
  assets: AssetEntry[];
  onPick: (guid: string) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useOverlayEscape(true, onClose, 'sprite-picker');

  // Group sprite assets by their parent texture.
  const groups = new Map<string, { texPath: string | undefined; sprites: AssetEntry[] }>();
  for (const a of assets) {
    if (a.type !== 'sprite' || !a.sprite || !a.guid) continue;
    const texGuid = a.sprite.texture;
    let g = groups.get(texGuid);
    if (!g) { g = { texPath: resolveGuidToPath(texGuid), sprites: [] }; groups.set(texGuid, g); }
    g.sprites.push(a);
  }

  const left = Math.min(anchor.left, window.innerWidth - 280);
  const top = Math.min(anchor.bottom + 2, window.innerHeight - 360);

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 10001 }}>
      <div
        ref={ref}
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'fixed', left, top, width: 270, maxHeight: 350, overflowY: 'auto',
          background: '#1e1e30', border: '1px solid #555', borderRadius: 5, padding: 6,
          fontFamily: 'monospace', fontSize: 11, color: '#ddd', boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <span style={{ color: '#f1c40f', fontSize: 10, textTransform: 'uppercase' }}>Pick Sprite</span>
          <button onClick={onClear} style={clearBtn} title="Clear the reference">Clear</button>
        </div>

        {groups.size === 0 ? (
          <div style={{ color: '#777', padding: '8px 4px', lineHeight: 1.5 }}>
            No sliced sprites yet. Select a texture in the Assets panel → Inspector → <b>Sprite Editor</b> to slice it.
          </div>
        ) : (
          [...groups.entries()].map(([texGuid, g]) => (
            <div key={texGuid} style={{ marginBottom: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#9ad', margin: '2px 0' }}>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {g.texPath ? assetDisplayName(g.texPath) : texGuid.slice(0, 8)}
                </span>
                <button onClick={() => onPick(wholeImageSpriteGuid(texGuid))} style={wholeBtn} title="Assign the whole-image sprite">whole</button>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {g.sprites.map((s) => (
                  <div
                    key={s.guid}
                    onClick={() => onPick(s.guid!)}
                    title={`${s.sprite!.name ?? ''}  ${s.sprite!.rect.w}×${s.sprite!.rect.h}`}
                    style={{ cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1, width: BOX_W }}
                  >
                    <div style={spriteThumbStyle(g.texPath, s.sprite!.rect, s.sprite!.sheetW, s.sprite!.sheetH)} />
                    <span style={{ width: BOX_W, fontSize: 9, color: '#aaa', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'center' }}>{s.sprite!.name ?? '—'}</span>
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

const clearBtn: React.CSSProperties = { background: '#2a2a3a', color: '#bbb', border: '1px solid #444', borderRadius: 3, fontFamily: 'monospace', fontSize: 10, padding: '1px 6px', cursor: 'pointer' };
const wholeBtn: React.CSSProperties = { background: '#22303f', color: '#9ad', border: '1px solid #2b4', borderColor: '#345', borderRadius: 3, fontFamily: 'monospace', fontSize: 9, padding: '0 5px', cursor: 'pointer' };
