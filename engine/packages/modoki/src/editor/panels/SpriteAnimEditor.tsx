/** SpriteAnim Editor panel — a dedicated dockable authoring surface for
 *  `.spriteanim.json` assets (a reusable named set of flipbook clips). Left: a live
 *  flipbook preview of the active clip. Right: the track list + per-clip fps/mode/
 *  cycles + ordered frame rows (sprite picker, reorder, remove).
 *
 *  Architecture mirrors ParticleEditor/AnimationEditor: the live def is the single
 *  source of truth in the editor store, so the GLOBAL undo stack applies edits even
 *  when this panel is unfocused; edits coalesce per group; persistence is a debounced
 *  /api/write-file, and each edit re-seeds the shared spriteAnimCache so any live
 *  SpriteAnimator referencing this asset updates next frame. */

import { useEffect, useRef, useState, useCallback } from 'react';
import { backendFetch } from '../backend/editorBackend';
import { newGuid, registerAsset, getAssetEntry, resolveGuidToPath } from '../../runtime/loaders/assetManifest';
import { spriteThumbStyle } from './SpritePicker';
import { normalizeSpriteAnim, type SpriteAnimDef } from '../../runtime/loaders/spriteAnimCache';
import { defaultSpriteClip, type SpriteClip } from '../../runtime/traits/SpriteAnimator';
import { spriteIndexFromStep } from '../../runtime/particles/types';
import { saveAssetDialog } from '../utils/saveDialog';
import { useDebouncedSave } from './useDebouncedSave';
import { AssetRefField } from './AssetRefField';
import { useEditorStore } from '../store/editorStore';
import { pushAction, peekUndo, isExecutingUndoRedo, undo as gUndo, redo as gRedo, type UndoAction } from '../undo/undoManager';
import { BufferedNumberInput, inputStyle } from './fields';
import { FrameThumb, TrackNameField, iconBtn, labelStyle } from './SpriteAnimatorSection';

const COALESCE_MS = 500;
const AUTOSAVE_MS = 400;
type SpriteAnimAction = UndoAction & { _after: SpriteAnimDef };

export default function SpriteAnimEditor() {
  const asset = useEditorStore((s) => s.editingSpriteAnimAsset);
  const nonce = useEditorStore((s) => s.spriteAnimEditNonce);
  const def = useEditorStore((s) => s.editingSpriteAnimDef);

  const lastGroup = useRef<string | undefined>(undefined);
  const lastTime = useRef(0);
  const lastAction = useRef<SpriteAnimAction | null>(null);
  const savedMarkRef = useRef<((d: SpriteAnimDef) => void) | null>(null);

  // Active track is LOCAL panel state — the asset is just the clip set, it has no
  // "active clip" concept (that lives on the SpriteAnimator trait instead).
  const [active, setActive] = useState('');
  const [saveMsg, setSaveMsg] = useState('');

  // ── Load the asset def when the open target changes ──
  useEffect(() => {
    lastAction.current = null;
    lastGroup.current = undefined;
    if (!asset) return;
    let cancelled = false;
    const existing = useEditorStore.getState().editingSpriteAnimDef;
    if (existing) { savedMarkRef.current?.(existing); return; } // bare re-mount — keep unsaved edits
    const { loadSpriteAnimDef } = useEditorStore.getState();
    fetch(asset.path)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
      .then((json) => {
        if (cancelled) return;
        const loaded = normalizeSpriteAnim(json);
        if (!loaded.id) {
          loaded.id = newGuid();
          registerAsset(loaded.id, asset.path, 'spriteanim');
          savedMarkRef.current?.(normalizeSpriteAnim(json)); // id-less twin → autosave persists the new id
        } else {
          registerAsset(loaded.id, asset.path, 'spriteanim');
          savedMarkRef.current?.(loaded);
        }
        loadSpriteAnimDef(loaded);
        setActive(Object.keys(loaded.clips)[0] ?? '');
      })
      .catch((e) => { if (cancelled) return; console.warn('[SpriteAnimEditor] load failed', e); const fb = { clips: {} }; savedMarkRef.current?.(fb); loadSpriteAnimDef(fb); });
    return () => { cancelled = true; };
    // Key on the stable path + explicit reopen nonce, not the asset object identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asset?.path, nonce]);

  // Keep `active` valid as clips change (delete/rename/load).
  const clips = def?.clips ?? {};
  const names = Object.keys(clips);
  useEffect(() => { if (active && !clips[active] && names.length) setActive(names[0]); }, [active, clips, names]);
  const activeName = active && clips[active] ? active : (names[0] ?? '');
  const clip: SpriteClip | undefined = activeName ? clips[activeName] : undefined;

  // ── Edit → global-undo coalescing commit (mirrors ParticleEditor.commit) ──
  const commit = useCallback((updater: (d: SpriteAnimDef) => SpriteAnimDef, group: string) => {
    const store = useEditorStore.getState();
    const cur = store.editingSpriteAnimDef;
    const path = store.editingSpriteAnimAsset?.path;
    if (!cur || !path) return;
    const next = updater(cur);
    if (next === cur) return;
    const now = performance.now();
    const act = lastAction.current;
    const coalesce = !!act && group === lastGroup.current && now - lastTime.current < COALESCE_MS
      && peekUndo() === act && !isExecutingUndoRedo();
    lastGroup.current = group;
    lastTime.current = now;
    if (coalesce && act) {
      act._after = next;
    } else {
      const before = cur;
      const a: SpriteAnimAction = {
        _after: next,
        label: `spriteanim ${group.split(':')[0]}`,
        undo: () => useEditorStore.getState().applySpriteAnimDef(path, before),
        redo: () => useEditorStore.getState().applySpriteAnimDef(path, a._after),
      };
      pushAction(a);
      lastAction.current = a;
    }
    store.applySpriteAnimDef(path, next);
  }, []);

  // ── clip-set mutations ──
  const writeClip = (name: string, group: string, fn: (c: SpriteClip) => SpriteClip) =>
    commit((d) => ({ ...d, clips: { ...d.clips, [name]: fn({ ...(d.clips[name] ?? defaultSpriteClip()), frames: [...(d.clips[name]?.frames ?? [])] }) } }), group);

  const addTrack = () => {
    let n = names.length + 1;
    let name = `track${n}`;
    while (clips[name]) name = `track${++n}`;
    commit((d) => ({ ...d, clips: { ...d.clips, [name]: defaultSpriteClip() } }), `add:${name}`);
    setActive(name);
  };
  const deleteTrack = () => {
    if (!activeName) return;
    commit((d) => { const c = { ...d.clips }; delete c[activeName]; return { ...d, clips: c }; }, `delete:${activeName}`);
  };
  const renameTrack = (next: string) => {
    next = next.trim();
    if (!activeName || !next || next === activeName || clips[next]) return;
    commit((d) => {
      if (!d.clips[activeName] || d.clips[next]) return d;
      const out: Record<string, SpriteClip> = {};
      for (const k of Object.keys(d.clips)) out[k === activeName ? next : k] = d.clips[k]; // preserve order
      return { ...d, clips: out };
    }, `rename:${activeName}`);
    setActive(next);
  };

  const setFrameAt = (i: number, guid: string) => writeClip(activeName, `frame:${activeName}:${i}`, (c) => { if (!guid) c.frames.splice(i, 1); else c.frames[i] = guid; return c; });
  const addFrame = (guid: string) => { if (guid) writeClip(activeName, `addframe:${activeName}`, (c) => { c.frames.push(guid); return c; }); };
  const removeFrame = (i: number) => writeClip(activeName, `rmframe:${activeName}:${i}`, (c) => { c.frames.splice(i, 1); return c; });
  const moveFrame = (i: number, dir: -1 | 1) => writeClip(activeName, `moveframe:${activeName}`, (c) => { const j = i + dir; if (j >= 0 && j < c.frames.length) [c.frames[i], c.frames[j]] = [c.frames[j], c.frames[i]]; return c; });

  // Create a new .spriteanim.json via the native Save dialog, then open it.
  const newSpriteAnim = useCallback(async () => {
    const path = await saveAssetDialog({ defaultName: 'New Sprite Animation.spriteanim.json', ext: '.spriteanim.json', prompt: 'Create Sprite Animation' });
    if (!path) return;
    const guid = newGuid();
    const doc = { id: guid, clips: { idle: defaultSpriteClip() } };
    const ok = await backendFetch('/api/write-file', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path, content: JSON.stringify(doc, null, 2) }) }).then((r) => r.ok).catch(() => false);
    if (!ok) return;
    registerAsset(guid, path, 'spriteanim');
    const name = (path.split('/').pop() || 'SpriteAnim').replace(/\.spriteanim\.json$/i, '');
    useEditorStore.getState().openSpriteAnimEditor({ path, type: 'spriteanim', name });
  }, []);

  // ── Debounced auto-save to disk (watches the store def → covers edits + undo/redo) ──
  const writeDef = useCallback((d: SpriteAnimDef): Promise<boolean> => {
    const path = asset?.path;
    if (!path) return Promise.resolve(false);
    setSaveMsg('Saving…');
    return backendFetch('/api/write-file', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, content: JSON.stringify(d, null, 2) }),
    }).then((res) => { setSaveMsg(res.ok ? 'Saved ✓' : `Save failed (${res.status})`); return res.ok; })
      .catch((e) => { console.error('[SpriteAnimEditor] auto-save failed', e); setSaveMsg('Save failed'); return false; });
  }, [asset?.path]);
  const { markSaved } = useDebouncedSave(def, writeDef, AUTOSAVE_MS);
  savedMarkRef.current = markSaved;

  const frames = clip?.frames ?? [];

  return (
    <div style={{ display: 'flex', width: '100%', height: '100%', background: '#1a1a2e', fontFamily: 'monospace', fontSize: 12, color: '#ccc' }}>
      {/* Preview */}
      <div style={{ position: 'relative', flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {clip && frames.length > 0
          ? <FlipbookPreview clip={clip} />
          : <div style={{ color: '#555' }}>{asset ? 'No frames in this clip yet' : 'Double-click a .spriteanim.json in Assets to edit'}</div>}
        {!asset && (
          <button onClick={newSpriteAnim} style={{ ...btn, position: 'absolute', bottom: 40, padding: '6px 14px' }}>+ New Sprite Animation</button>
        )}
        {def && (
          <div style={{ position: 'absolute', left: 8, bottom: 8, display: 'flex', gap: 6 }}>
            <button onClick={() => gUndo()} title="Undo (⌘Z) — shared global undo" style={btn}>↶</button>
            <button onClick={() => gRedo()} title="Redo (⇧⌘Z) — shared global undo" style={btn}>↷</button>
          </div>
        )}
      </div>

      {/* Editor */}
      {def && (
        <div style={{ width: 290, flexShrink: 0, borderLeft: '1px solid #333', overflowY: 'auto', padding: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <span style={{ fontWeight: 'bold', color: '#ddd' }}>{asset?.name}</span>
            <span style={{ fontSize: 10, color: saveMsg.includes('fail') ? '#e74c3c' : '#2ecc71' }}>{saveMsg || 'Auto-save'}</span>
          </div>

          {/* Track picker */}
          <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>Clips</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4 }}>
            <select value={activeName} onChange={(e) => setActive(e.target.value)} style={{ ...inputStyle, flex: 1, minWidth: 0 }} disabled={names.length === 0}>
              {names.length === 0 && <option value="">(no clips)</option>}
              {names.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            <button onClick={addTrack} title="Add clip" style={iconBtn(false)}>＋</button>
            <button onClick={deleteTrack} disabled={!activeName} title="Delete clip" style={iconBtn(!activeName)}>🗑</button>
          </div>

          {!activeName ? (
            <div style={{ color: '#777', fontSize: 11, padding: '4px 2px' }}>No clips yet — add one to start a sprite animation.</div>
          ) : (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <span style={labelStyle}>name</span>
                <TrackNameField name={activeName} onRename={renameTrack} />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <span style={labelStyle}>fps</span>
                <BufferedNumberInput value={clip!.fps} step={1} onChange={(v) => writeClip(activeName, `fps:${activeName}`, (c) => ({ ...c, fps: v }))} style={{ ...inputStyle, width: 56 }} />
                <span style={labelStyle}>mode</span>
                <select value={clip!.mode} onChange={(e) => writeClip(activeName, `mode:${activeName}`, (c) => ({ ...c, mode: e.target.value as SpriteClip['mode'] }))} style={{ ...inputStyle, flex: 1, minWidth: 0 }}>
                  <option value="once">once</option>
                  <option value="loop">loop</option>
                  <option value="pingpong">pingpong</option>
                </select>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                <span style={labelStyle}>cycles</span>
                <BufferedNumberInput value={clip!.cycles} step={1} onChange={(v) => writeClip(activeName, `cycles:${activeName}`, (c) => ({ ...c, cycles: Math.max(0, v) }))} style={{ ...inputStyle, width: 56 }} />
                <span style={{ color: '#666', fontSize: 10 }}>0 = infinite</span>
              </div>

              <div style={{ fontSize: 11, color: '#888', margin: '4px 0 2px' }}>
                Frames <span style={{ color: '#666' }}>({frames.length}{clip!.fps > 0 ? ` @ ${clip!.fps} fps` : ''})</span>
              </div>
              {frames.map((ref, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 2 }}>
                  <span style={{ width: 18, textAlign: 'right', color: '#666', fontSize: 10 }}>{i}</span>
                  <FrameThumb guid={ref} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <AssetRefField label="" value={ref} onChange={(v) => setFrameAt(i, v)} accept={['sprite']} />
                  </div>
                  <button onClick={() => moveFrame(i, -1)} disabled={i === 0} title="Move up" style={iconBtn(i === 0)}>↑</button>
                  <button onClick={() => moveFrame(i, 1)} disabled={i === frames.length - 1} title="Move down" style={iconBtn(i === frames.length - 1)}>↓</button>
                  <button onClick={() => removeFrame(i)} title="Remove frame" style={iconBtn(false)}>✕</button>
                </div>
              ))}
              <div style={{ marginTop: 2 }}>
                <AssetRefField label="+ add" value="" onChange={addFrame} accept={['sprite']} placeholder="pick (▦) or drop a sprite" />
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Live flipbook preview: cycles the active clip's frames at its fps via the shared
 *  loop/pingpong index math, showing a large cropped view of the current frame. */
function FlipbookPreview({ clip }: { clip: SpriteClip }) {
  const [idx, setIdx] = useState(0);
  const startRef = useRef<number | null>(null);
  useEffect(() => {
    startRef.current = null;
    let raf = 0;
    const n = clip.frames.length;
    const fps = clip.fps > 0 ? clip.fps : 0;
    if (n === 0) { setIdx(0); return; }
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (startRef.current == null) startRef.current = now;
      const t = (now - startRef.current) / 1000;
      const step = fps > 0 ? Math.floor(t * fps) : 0;
      setIdx(spriteIndexFromStep(step, n, clip.mode || 'loop'));
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [clip.frames, clip.fps, clip.mode]);
  const guid = clip.frames[idx] ?? clip.frames[0];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
      <SpritePreview guid={guid} max={224} />
      <span style={{ color: '#666', fontSize: 10 }}>frame {idx + 1} / {clip.frames.length}</span>
    </div>
  );
}

/** Big preview of one sprite frame at its NATIVE aspect ratio — the box matches the
 *  slice's rect (integer-scaled up to fit `max`), so the sprite fills it with no
 *  letterboxing/distortion. `pixelated` keeps pixel art crisp. */
function SpritePreview({ guid, max }: { guid: string; max: number }) {
  const sp = guid ? getAssetEntry(guid)?.sprite : undefined;
  if (!sp || sp.rect.w <= 0 || sp.rect.h <= 0) {
    return <div style={{ width: 96, height: 96, border: '1px solid #333', background: '#0e0e16' }} />;
  }
  const { w, h } = sp.rect;
  const k = Math.max(1, Math.floor(Math.min(max / w, max / h))); // integer up-scale to fit `max`
  return <div style={spriteThumbStyle(resolveGuidToPath(sp.texture), sp.rect, sp.sheetW, sp.sheetH, { w: w * k, h: h * k })} />;
}

const btn: React.CSSProperties = { background: '#2a2a40', color: '#ccc', border: '1px solid #444', borderRadius: 3, padding: '3px 9px', cursor: 'pointer', fontFamily: 'monospace', fontSize: 12 };
