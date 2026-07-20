/** SpriteAnimator-only Inspector section: picks the ACTIVE clip (track) from the
 *  bound `.spriteanim.json` asset (the `clipSet` field, rendered as an AssetRefField
 *  above by the generic field renderer). The clip DATA — frames/fps/mode/cycles — is
 *  authored in the dockable SpriteAnim Editor, opened here via the ✎ button.
 *
 *  `clip` isn't in the trait's meta.fields (so the generic renderer ignores it) — this
 *  custom section owns it as a dropdown driven by the asset's clip names. Exports the
 *  small frame-preview + track-name helpers that the SpriteAnim Editor panel reuses. */

import { useState, useEffect } from 'react';
import { findEntity } from '../../runtime/ecs/entityUtils';
import { type TraitMeta } from '../../runtime/ecs/traitRegistry';
import { writeTraitFieldsPerEntityWithUndo as writeTraitFields } from '../undo/entityActions';
import { getAssetEntry, resolveGuidToPath } from '../../runtime/loaders/assetManifest';
import { getSpriteAnim } from '../../runtime/loaders/spriteAnimCache';
import { useEditorStore } from '../store/editorStore';
import { spriteThumbStyle } from './SpritePicker';
import { inputStyle } from './fields';

/** Track-name editor: commits the rename only on blur / Enter (NOT per keystroke).
 *  A per-keystroke rename would fire a chain of partial renames (r, ro, rol, …) that
 *  race each other and can strand the old key, so the selector snaps back to it. */
export function TrackNameField({ name, onRename }: { name: string; onRename: (next: string) => void }) {
  const [text, setText] = useState(name);
  // Re-seed when the active track changes (switch / external edit / successful rename).
  useEffect(() => { setText(name); }, [name]);
  const commit = () => { const t = text.trim(); if (t && t !== name) onRename(t); else setText(name); };
  return (
    <input
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        else if (e.key === 'Escape') { setText(name); (e.target as HTMLInputElement).blur(); }
      }}
      style={{ ...inputStyle, flex: 1 }}
    />
  );
}

/** Small cropped preview for one frame's sprite GUID (or a placeholder). */
export function FrameThumb({ guid }: { guid: string }) {
  const sp = guid ? getAssetEntry(guid)?.sprite : undefined;
  const box = { w: 30, h: 26 };
  if (!sp) return <div style={{ ...box, flexShrink: 0, border: '1px solid #333', background: '#0e0e16' }} />;
  return <div style={spriteThumbStyle(resolveGuidToPath(sp.texture), sp.rect, sp.sheetW, sp.sheetH, box)} />;
}

export function SpriteAnimatorSection({ entityIds, meta }: {
  entityIds: number[]; meta: TraitMeta;
}) {
  // `clip` isn't in meta.fields → readTraitData drops it; read the live trait. A local
  // tick re-reads after selecting a clip / once the async asset fetch lands.
  const [, setTick] = useState(0);
  const bump = () => setTick((t) => t + 1);
  const live = findEntity(entityIds[0])?.get(meta.trait) as { clipSet?: string; clip?: string } | undefined;
  const clipSet = live?.clipSet ?? '';

  // The clip names come from the bound .spriteanim asset (resolved async — poll until
  // it lands, mirroring what spriteAnimationSystem does every frame at runtime). A
  // setInterval (not one-shot) keeps re-reading: `bump` re-renders → `assetClips`
  // recomputes; once it's non-undefined the deps change, this effect re-runs and its
  // cleanup clears the interval.
  const assetClips = clipSet ? getSpriteAnim(clipSet)?.clips : undefined;
  useEffect(() => {
    if (!clipSet || assetClips) return;
    const id = setInterval(bump, 120);
    return () => clearInterval(id);
  }, [clipSet, assetClips]);

  if (!clipSet) {
    return (
      <div style={{ marginTop: 4 }}>
        <div style={{ borderTop: '1px solid #444', margin: '6px 0' }} />
        <div style={{ color: '#777', fontSize: 11, padding: '2px 0' }}>
          Assign a clip set (.spriteanim) above, or create one via Assets ▸ right-click ▸ Create Sprite Animation.
        </div>
      </div>
    );
  }

  const setNames = assetClips ? Object.keys(assetClips) : [];
  const activeName = (live?.clip && assetClips?.[live.clip]) ? live.clip : (setNames[0] ?? '');
  const selectClip = (name: string) => { writeTraitFields(entityIds, meta, () => ({ clip: name, time: 0 }), `Select ${meta.name} clip`); bump(); };
  const editSet = () => useEditorStore.getState().openSpriteAnimEditor({ path: resolveGuidToPath(clipSet) ?? clipSet, type: 'spriteanim', name: 'Sprite Animation' });

  return (
    <div style={{ marginTop: 4 }}>
      <div style={{ borderTop: '1px solid #444', margin: '6px 0' }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
        <span style={labelStyle}>clip</span>
        <select value={activeName} onChange={(e) => selectClip(e.target.value)} style={{ ...inputStyle, flex: 1, minWidth: 0 }} disabled={setNames.length === 0}>
          {setNames.length === 0 && <option value="">{assetClips ? '(no clips)' : '(loading…)'}</option>}
          {setNames.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
        <button onClick={editSet} title="Edit the clip set in the SpriteAnim Editor" style={iconBtn(false)}>✎</button>
      </div>
      <div style={{ color: '#666', fontSize: 10 }}>Clips live in the referenced .spriteanim asset. Edit frames/fps there (✎).</div>
    </div>
  );
}

export const labelStyle: React.CSSProperties = { width: 40, color: '#9a9aa8', fontSize: 11, flexShrink: 0 };
export const iconBtn = (disabled: boolean): React.CSSProperties => ({
  background: '#2a2a3a', color: disabled ? '#555' : '#bbb', border: '1px solid #444',
  borderRadius: 3, fontFamily: 'monospace', fontSize: 11, lineHeight: '14px',
  minWidth: 20, height: 20, padding: '0 3px', cursor: disabled ? 'default' : 'pointer', flexShrink: 0,
});
