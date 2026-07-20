/** SpriteAssetView — read-only Inspector view for a sliced-sprite sub-asset.
 *  Shows a cropped thumbnail of the frame (from the parent texture's source image)
 *  plus its rect / pivot / parent texture. Editing happens in the parent texture's
 *  Sprite Editor — this is purely informational. Dev-only (editor). */

import { getAssetEntry, getGuidForPath, resolveGuidToPath } from '../../../runtime/loaders/assetManifest';
import { InfoRow } from './widgets';

const BOX = 132;

/** Crop one source-px frame out of the source image into a BOX×BOX tile (contain). */
function thumbStyle(srcUrl: string | undefined, rect: { x: number; y: number; w: number; h: number }, sheetW?: number, sheetH?: number): React.CSSProperties {
  const base: React.CSSProperties = {
    width: BOX, height: BOX, background: '#0e0e16', border: '1px solid #333',
    backgroundRepeat: 'no-repeat', backgroundPosition: 'center', imageRendering: 'pixelated',
  };
  if (!srcUrl || !sheetW || !sheetH || rect.w <= 0 || rect.h <= 0) {
    return { ...base, backgroundImage: srcUrl ? `url("${srcUrl}")` : undefined, backgroundSize: 'contain' };
  }
  const scale = Math.min(BOX / rect.w, BOX / rect.h);
  const dispW = rect.w * scale, dispH = rect.h * scale;
  return {
    ...base,
    backgroundImage: `url("${srcUrl}")`,
    backgroundSize: `${sheetW * scale}px ${sheetH * scale}px`,
    backgroundPosition: `${(BOX - dispW) / 2 - rect.x * scale}px ${(BOX - dispH) / 2 - rect.y * scale}px`,
  };
}

export function SpriteAssetView({ path, name }: { path: string; name: string }) {
  // The selected sprite carries a synthetic `texturePath#guid` path — resolve its
  // GUID, then pull the rect/pivot/parent from the live manifest entry.
  const guid = getGuidForPath(path) ?? (path.includes('#') ? path.slice(path.lastIndexOf('#') + 1) : undefined);
  const sprite = guid ? getAssetEntry(guid)?.sprite : undefined;
  if (!sprite) {
    return <div style={{ color: '#888', fontSize: '11px', lineHeight: 1.5 }}>
      Sliced sprite. Open the parent texture's <b>Sprite Editor</b> to edit it.
    </div>;
  }
  const texPath = resolveGuidToPath(sprite.texture);
  const { x, y, w, h } = sprite.rect;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={thumbStyle(texPath, sprite.rect, sprite.sheetW, sprite.sheetH)} />
      <div>
        <InfoRow label="Name" value={sprite.name ?? name} />
        <InfoRow label="Rect" value={`${x}, ${y} · ${w}×${h}`} />
        <InfoRow label="Pivot" value={`${sprite.pivot.x}, ${sprite.pivot.y}`} />
        {texPath && <InfoRow label="Source" value={texPath.split('/').pop() ?? texPath} />}
      </div>
      <div style={{ color: '#666', fontSize: '11px', lineHeight: 1.5 }}>
        Drag onto a 2D entity's <b>Renderable2D → sprite</b> field. Edit its boundary
        in the parent texture's <b>Sprite Editor</b>.
      </div>
    </div>
  );
}
