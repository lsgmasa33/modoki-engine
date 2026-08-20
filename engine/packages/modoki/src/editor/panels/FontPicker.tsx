/** FontPicker — a popup that lists the project's font assets so one can be assigned to a
 *  font-accepting ref field. Each row previews the family in its own typeface (the face is
 *  already registered by the Assets panel's `loadAllFonts`, and re-registered on pick) and
 *  assigns the font's GUID.
 *
 *  It exists because #231 turned `UIElement.fontFamily` into a GUID ref: before that a font
 *  could be assigned by TYPING its family name, and a GUID cannot be typed. Drag-and-drop
 *  from the Assets panel still works; this is the keyboard-free path that replaces typing.
 *  Dev-only (editor). */

import { useRef } from 'react';
import { useOverlayEscape } from '../input/useOverlayEscape';
import type { AssetEntry } from '../../runtime/loaders/assetManifest';
import { fontFamilyFromPath, loadFont } from '../../runtime/loaders/fontLoader';
import { assetDisplayName } from './AssetRefField';

export function FontPicker({ anchor, assets, onPick, onClear, onClose }: {
  anchor: DOMRect;
  assets: AssetEntry[];
  onPick: (guid: string) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useOverlayEscape(true, onClose, 'font-picker');

  // Sorted by the FAMILY the runtime will register, not by filename: that is the name the
  // author sees in the rendered UI, and two variants of one family sort together.
  const fonts = assets
    .filter((a) => a.type === 'font' && !!a.guid)
    .map((a) => ({ guid: a.guid as string, path: a.path, family: fontFamilyFromPath(a.path) }))
    .sort((a, b) => a.family.localeCompare(b.family) || a.path.localeCompare(b.path));

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
          <span style={{ color: '#f1c40f', fontSize: 10, textTransform: 'uppercase' }}>Pick Font</span>
          <button onClick={onClear} style={clearBtn} title="Clear the reference">Clear</button>
        </div>
        {fonts.length === 0 && (
          <div style={{ color: '#777', padding: '6px 4px' }}>
            No font assets in this project. Drop a .ttf/.otf into the project’s assets folder.
          </div>
        )}
        {fonts.map((f) => (
          <div
            key={f.guid}
            data-ui-id={`font-picker.row.${f.guid}`}
            onClick={() => {
              // Register the face before assigning, so the Inspector's own preview and the
              // Game panel show the real typeface immediately rather than after the next
              // scene load. A failure is warned, never thrown: the REF is still valid.
              loadFont(f.path).catch((err) => console.warn(`[FontPicker] font load failed for ${f.path}:`, err));
              onPick(f.guid);
            }}
            style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '3px 4px', cursor: 'pointer', borderRadius: 3 }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#2a2a40'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'none'; }}
            title={`${f.family}\n${f.path}`}
          >
            <span style={{ fontFamily: `"${f.family}", monospace`, fontSize: 15, color: '#eee', flexShrink: 0 }}>Ag</span>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.family}</span>
            <span style={{ color: '#777', fontSize: 10 }}>{assetDisplayName(f.path)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const clearBtn: React.CSSProperties = {
  background: '#2a2a40', color: '#bbb', border: '1px solid #444', borderRadius: 3,
  fontSize: 10, padding: '1px 6px', cursor: 'pointer',
};
