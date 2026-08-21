/** SpritePicker — a popup that lists sliced sprites (grouped by their source texture)
 *  so they can be assigned to a sprite-accepting ref field. Sliced sprites have no
 *  Assets-panel row to drag from, so this is the assignment path. Each row shows a
 *  cropped thumbnail of the frame (using the dev-served source image) + its name;
 *  clicking assigns the sprite's GUID. A per-texture "whole image" row assigns the
 *  texture's auto whole-image SPRITE GUID (never the raw texture — 2D refs are
 *  sprites-only) — and is shown only when that sprite actually exists, which a sliced
 *  sheet's texture has none of (see spritePickerGroups.ts).
 *
 *  A "NO SPRITE YET" section (#293) additionally lists every texture with no sprite
 *  at all — the dead end a 3D-typed texture (the import default) used to leave
 *  totally unlisted here, with the empty-state text pointing at Sprite Editor even
 *  though slicing a 3D texture does nothing (see spritelessTextures.ts). A 3D
 *  texture gets a "Make 2D" button that flips its type and re-imports it
 *  (makeTexture2D.ts); anything else spriteless just points at the Inspector.
 *
 *  That section is COLLAPSED by default and, expanded, filtered + capped at 30 rows
 *  (`filterSpriteless`, spritelessTextures.ts) — a 3D-heavy project has 100+ of
 *  these (measured: `demos/forest-camp` 130, `games/court` ~395, `games/3d-test`
 *  ~147), and an always-expanded list at that size would bury the sliced-sprite
 *  groups this popup exists to show. Dev-only (editor). */

import { useState, useRef } from 'react';
import { useOverlayEscape } from '../input/useOverlayEscape';
import type { AssetEntry } from '../../runtime/loaders/assetManifest';
import { resolveGuidToPath } from '../../runtime/loaders/assetManifest';
import { assetDisplayName } from './AssetRefField';
import { inputStyle } from './fields';
import { groupSpritesByTexture } from './spritePickerGroups';
import { spritelessTextures, filterSpriteless } from './spritelessTextures';
import { makeTexture2D, textureRefCount } from './makeTexture2D';
import { useEditorStore } from '../store/editorStore';

const SPRITELESS_CAP = 30;

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

  // `assetsVersion` is read so this panel re-renders after a "Make 2D" conversion —
  // the `assets` PROP is re-derived by AssetRefField (also subscribed, see there),
  // this subscription just makes sure the picker's own render observes the bump.
  // Same pattern as AtlasAssetView.tsx.
  const assetsVersion = useEditorStore((s) => s.assetsVersion);
  void assetsVersion;
  const refreshAssets = useEditorStore((s) => s.refreshAssets);
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [showSpriteless, setShowSpriteless] = useState(false);
  const [filter, setFilter] = useState('');

  // Group sprite assets by their parent texture (pure — see spritePickerGroups.ts).
  const groups = groupSpritesByTexture(assets);
  // Textures with no sprite at all — the dead end this section exists to surface.
  const spriteless = spritelessTextures(assets);
  const { shown: spritelessShown, hidden: spritelessHidden } = filterSpriteless(spriteless, filter, SPRITELESS_CAP);

  // Two clicks, not one. The list this button sits in is EVERY spriteless texture in the
  // project — which in a 3D project is every material map — and converting one is not a
  // display toggle: it drops mipmaps and switches wrap to clamp, so a mis-click on a tiling
  // terrain albedo or a normal map degrades that material's rendering with no error. It also
  // writes the sidecar and re-imports on disk, so the editor's undo stack cannot take it back.
  // The first click arms, the second commits; `armed` clears on any other row being armed.
  // `null` = not looked up / unknown. Never rendered as "unused" — see textureRefCount.
  const [armed, setArmed] = useState<string | null>(null);
  const [armedRefs, setArmedRefs] = useState<number | null>(null);
  const armingRef = useRef<string | null>(null);
  const makeTexture2DClick = async (path: string, guid: string) => {
    if (armed !== path) {
      setArmed(path);
      setArmedRefs(null);
      // Ask what depends on this texture, for the one row being armed only. The answer
      // is what turns a vague warning into a decidable one: "used by 4" on a normal map
      // is the signal that this click is about to change how the scene renders.
      //
      // The in-flight row is tracked in a REF, not read back out of a `setArmed` updater:
      // a state updater must be pure, and React double-invokes it in StrictMode, so
      // setting `armedRefs` from inside one would fire the side effect twice. The ref also
      // discards a slow answer for a row the user has already moved off — otherwise
      // arming A then B could paint A's reference count beside B.
      armingRef.current = path;
      void textureRefCount(guid || path).then((n) => {
        if (armingRef.current === path) setArmedRefs(n);
      });
      return;
    }
    setArmed(null);
    setArmedRefs(null);
    armingRef.current = null;
    setFailed(null);
    setBusy(path);
    const ok = await makeTexture2D(path);
    // The HMR asset-manifest bump (`assetsVersion`) is not guaranteed in every
    // host, so this explicit refresh stays as the belt-and-braces trigger.
    if (ok) refreshAssets();
    // A failure has to be VISIBLE here. `makeTexture2D` only console.errors, and on a
    // reimport failure the meta write has already landed — so the row's `textureType`
    // flips to '2d' on the next scan and this button is replaced by the inert
    // "re-import in Inspector" text. Without this the button the user just clicked would
    // simply vanish, which reads as success.
    else setFailed(path);
    setBusy(null);
  };

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

        {/* The slicing hint shows whenever there are no sprite GROUPS — not only when
            there is nothing at all. A 3D-heavy project has zero groups AND a long
            spriteless list, and gating on both left that case with only the amber row,
            dropping the one pointer to the Sprite Editor for the case it was written for. */}
        {groups.size === 0 ? (
          <div style={{ color: '#777', padding: '8px 4px', lineHeight: 1.5 }}>
            No sliced sprites yet. Select a texture in the Assets panel → Inspector → <b>Sprite Editor</b> to slice it.
          </div>
        ) : (
          [...groups.entries()].map(([texGuid, g]) => {
            const texPath = resolveGuidToPath(texGuid);
            return (
            <div key={texGuid} style={{ marginBottom: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#9ad', margin: '2px 0' }}>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {texPath ? assetDisplayName(texPath) : texGuid.slice(0, 8)}
                </span>
                {g.wholeGuid && (
                  <button onClick={() => onPick(g.wholeGuid!)} style={wholeBtn} title="Assign the whole-image sprite">whole</button>
                )}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {g.sprites.map((s) => (
                  <div
                    key={s.guid}
                    onClick={() => onPick(s.guid!)}
                    title={`${s.sprite!.name ?? ''}  ${s.sprite!.rect.w}×${s.sprite!.rect.h}`}
                    style={{ cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1, width: BOX_W }}
                  >
                    <div style={spriteThumbStyle(texPath, s.sprite!.rect, s.sprite!.sheetW, s.sprite!.sheetH)} />
                    <span style={{ width: BOX_W, fontSize: 9, color: '#aaa', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'center' }}>{s.sprite!.name ?? '—'}</span>
                  </div>
                ))}
              </div>
            </div>
            );
          })
        )}

        {spriteless.length > 0 && (
          <div style={{ marginTop: groups.size > 0 ? 6 : 0 }}>
            <button
              onClick={() => setShowSpriteless((v) => !v)}
              data-ui-id="spritePicker.spritelessToggle"
              title="Textures typed 3D (the import default) expose no whole-image sprite. Expand to convert one."
              style={{
                background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                color: '#f39c12', fontSize: 10, textTransform: 'uppercase', margin: '2px 0',
                display: 'block', fontFamily: 'monospace',
              }}
            >
              {showSpriteless ? '▾' : '▸'} {spriteless.length} texture{spriteless.length === 1 ? '' : 's'} have no sprite
            </button>

            {showSpriteless && (
              <>
                <div style={{ color: '#777', fontSize: 10, lineHeight: 1.4, margin: '4px 0' }}>
                  Typed 3D textures expose no whole-image sprite. Convert one, or re-import a 2D/UI texture from the Inspector.
                </div>
                <input
                  data-ui-id="spritePicker.spritelessFilter"
                  placeholder="filter by name"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  style={{ ...inputStyle, width: '100%', marginBottom: 4 }}
                />
                {spritelessShown.length === 0 ? (
                  <div style={{ color: '#777', fontSize: 10, padding: '2px 0' }}>no match</div>
                ) : (
                  spritelessShown.map((t) => (
                    <div key={t.guid} style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '2px 0' }}>
                      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {t.name}
                      </span>
                      {t.textureType === '3d' ? (
                        <>
                          {failed === t.path && (
                            <span style={{ color: '#e74c3c', fontSize: 9 }} title="The convert did not complete — see the Console panel. If the re-import was the step that failed, the type was already written, so the Inspector's Apply will finish it.">
                              failed
                            </span>
                          )}
                          {armed === t.path && armedRefs !== null && armedRefs > 0 && (
                            <span style={{ color: '#e74c3c', fontSize: 9 }} title="Assets that reference this texture — converting it changes how they render.">
                              used by {armedRefs}
                            </span>
                          )}
                          <button
                            data-ui-id="spritePicker.make2d"
                            disabled={busy !== null}
                            onClick={() => makeTexture2DClick(t.path, t.guid)}
                            style={armed === t.path ? make2dArmedBtn : make2dBtn}
                            title={armed === t.path
                              ? 'Click again to convert. This drops mipmaps and clamps wrap — if a 3D material uses this texture, its rendering will change, and this is not undoable.'
                              : 'A 3D texture exposes no whole-image sprite. Set its type to 2D and re-import so it does.'}
                          >
                            {busy === t.path ? '…' : armed === t.path ? 'Sure?' : 'Make 2D'}
                          </button>
                        </>
                      ) : (
                        <span
                          style={{ color: '#777', fontSize: 9 }}
                          title="This texture has no whole-image sprite yet — select it in Assets and press Apply in the Inspector."
                        >
                          re-import in Inspector
                        </span>
                      )}
                    </div>
                  ))
                )}
                {spritelessHidden > 0 && (
                  <div style={{ color: '#777', fontSize: 9, padding: '2px 0' }}>+{spritelessHidden} more — type to filter</div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const clearBtn: React.CSSProperties = { background: '#2a2a3a', color: '#bbb', border: '1px solid #444', borderRadius: 3, fontFamily: 'monospace', fontSize: 10, padding: '1px 6px', cursor: 'pointer' };
const wholeBtn: React.CSSProperties = { background: '#22303f', color: '#9ad', border: '1px solid #2b4', borderColor: '#345', borderRadius: 3, fontFamily: 'monospace', fontSize: 9, padding: '0 5px', cursor: 'pointer' };
const make2dBtn: React.CSSProperties = { background: '#2a2210', color: '#f39c12', border: '1px solid #f39c12', borderRadius: 3, fontFamily: 'monospace', fontSize: 9, padding: '0 5px', cursor: 'pointer' };
const make2dArmedBtn: React.CSSProperties = { ...make2dBtn, background: '#4a1f1f', color: '#e74c3c', borderColor: '#e74c3c' };
