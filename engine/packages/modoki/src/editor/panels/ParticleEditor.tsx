/** Particle Editor panel — a dedicated authoring surface for `.particle.json` effects.
 *  Left: a live WebGPU preview viewport (orbit camera) driving the real particle backend.
 *  Right: property sections (emission/shape/start/over-life/render) with live apply.
 *  Top: play / pause / restart / scrub timeline + Save. Edits apply to the running
 *  preview immediately (backend.setDef) and seed the shared cache so any ParticleEmitter
 *  entity referencing this asset in GameView updates too. */

import { useEffect, useRef, useState, useCallback } from 'react';
import { backendFetch } from '../backend/editorBackend';
import { createPortal } from 'react-dom';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { makeWebGPURenderer } from '../../runtime/rendering/scene3DSync';
import { setActiveRenderer } from '../../runtime/loaders/textureResolver';
import { particleBackend } from '../../runtime/particles/particleBackend';
import { defaultParticleEffect, type ParticleEffectDef, type ParticleHandle, type EmitterShapeType, type BlendMode, type ForceField, type MeshPrimitive, type SpriteMode, type SubEmitter, type CollisionConfig, type ColliderShape } from '../../runtime/particles/types';
import { normalizeParticleDef } from '../../runtime/loaders/particleCache';
import { newGuid, registerAsset } from '../../runtime/loaders/assetManifest';
import { saveAssetDialog } from '../utils/saveDialog';
import { useDebouncedSave } from './useDebouncedSave';
import { applyWheelStep, useWheelStep } from './fields';
import { AssetRefField } from './AssetRefField';
import { useEditorStore } from '../store/editorStore';
import { pushAction, peekUndo, isExecutingUndoRedo, undo as gUndo, redo as gRedo, type UndoAction } from '../undo/undoManager';
import CurveEditor from './particle/CurveEditor';
import { DEFAULT_CURVE_POINTS, withCurvePoints, withCurveScale } from './particle/curveMath';
import GradientEditor from './particle/GradientEditor';
import { displayElapsed } from './particle/previewMath';

/** Consecutive edits to the same field within this window collapse into one undo step. */
const COALESCE_MS = 500;
/** Auto-save debounce: write `.particle.json` this long after the last edit. Particle
 *  edits (slider/curve/gradient drags) fire continuously, so unlike the material
 *  Inspector (discrete clicks, no debounce) we coalesce writes onto a trailing timer. */
const AUTOSAVE_MS = 400;
/** A particle undo entry; `_after` is the (coalescing-)mutable redo target. */
type ParticleAction = UndoAction & { _after: ParticleEffectDef };

export default function ParticleEditor() {
  const asset = useEditorStore((s) => s.editingParticleAsset);
  const nonce = useEditorStore((s) => s.particleEditNonce);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<Awaited<ReturnType<typeof makeWebGPURenderer>> | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const handleRef = useRef<ParticleHandle | null>(null);
  const objRef = useRef<THREE.Object3D | null>(null); // stored so teardown never calls getObject3D on a stale handle
  const floorRef = useRef<THREE.Mesh | null>(null); // opaque depth target — only shown for soft-particle effects
  const playingRef = useRef(true);
  const elapsedRef = useRef(0);

  // The live def is the single source of truth in the editor store, so the GLOBAL undo
  // stack (shared with Hierarchy/Inspector/SceneView) can apply edits even when this
  // panel is unfocused or on another tab. Edits push to that one stack — there is no
  // separate particle undo system. Consecutive same-field edits coalesce (see commit()).
  const def = useEditorStore((s) => s.editingParticleDef);
  const lastGroup = useRef<string | undefined>(undefined);
  const lastTime = useRef(0);
  const lastAction = useRef<ParticleAction | null>(null);
  // Bridge to the auto-save hook's markSaved(): the load effect (declared above the hook)
  // calls it to seed the just-loaded def as "in sync", so opening an asset never rewrites
  // it. Stable identity (the hook's markSaved is useCallback []), assigned during render so
  // it's set before any effect runs.
  const savedMarkRef = useRef<((d: ParticleEffectDef) => void) | null>(null);
  const [playing, setPlaying] = useState(true);
  const [elapsed, setElapsed] = useState(0);
  const [sceneReady, setSceneReady] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');
  const [showFloor, setShowFloor] = useState(false);

  // ── Viewport (renderer / scene / camera / orbit / rAF) ──
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let disposed = false;
    let raf = 0;
    let resizeRaf = 0;
    const timer = new THREE.Timer(); // THREE.Clock is deprecated in r184

    (async () => {
      let renderer: Awaited<ReturnType<typeof makeWebGPURenderer>>;
      try { renderer = await makeWebGPURenderer(container); }
      catch (e) { console.error('[ParticleEditor] renderer init failed', e); return; }
      if (disposed) { renderer.dispose(); renderer.domElement.remove(); return; }
      setActiveRenderer(renderer);
      rendererRef.current = renderer;

      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0x14141f);
      // Opaque floor (writes depth) so soft particles have geometry to fade against.
      // Hidden by default — it occludes particles behind it, which is unwanted for
      // volumetric effects; toggled on from the toolbar (▦). The grid (lines, no
      // occlusion) is the always-on ground reference.
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshBasicMaterial({ color: 0x101018 }));
      floor.rotation.x = -Math.PI / 2;
      floor.position.y = -0.01;
      floor.visible = false;
      scene.add(floor);
      floorRef.current = floor;
      const grid = new THREE.GridHelper(10, 10, 0x444466, 0x262636);
      scene.add(grid);
      // Lights so `meshLit` mesh particles aren't black in the dedicated preview
      // (the in-game island scene already supplies its own lighting).
      scene.add(new THREE.AmbientLight(0xffffff, 0.6));
      const key = new THREE.DirectionalLight(0xffffff, 1.6);
      key.position.set(3, 6, 4);
      scene.add(key);
      sceneRef.current = scene;

      const camera = new THREE.PerspectiveCamera(50, container.clientWidth / container.clientHeight, 0.1, 200);
      camera.position.set(0, 2.8, 7);
      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.1;
      controls.target.set(0, 1.6, 0);

      // Defer resize work to rAF so setSize() doesn't reflow synchronously inside the
      // observer callback (that re-triggers the observer → "ResizeObserver loop" warning).
      const ro = new ResizeObserver(() => {
        cancelAnimationFrame(resizeRaf);
        resizeRaf = requestAnimationFrame(() => {
          const w = container.clientWidth, h = container.clientHeight;
          if (!w || !h) return;
          camera.aspect = w / h; camera.updateProjectionMatrix(); renderer.setSize(w, h);
        });
      });
      ro.observe(container);

      setSceneReady(true);

      const loop = () => {
        raf = requestAnimationFrame(loop);
        timer.update();
        const dt = Math.min(timer.getDelta(), 0.05);
        controls.update();
        const h = handleRef.current;
        if (h && playingRef.current) {
          elapsedRef.current += dt;
          particleBackend.update(h, dt);
        }
        renderer.render(scene, camera);
      };
      loop();

      // expose cleanup via closure captured below
      cleanupRef.current = () => {
        cancelAnimationFrame(raf);
        cancelAnimationFrame(resizeRaf);
        ro.disconnect();
        controls.dispose();
        if (handleRef.current) { particleBackend.dispose(handleRef.current); handleRef.current = null; objRef.current = null; }
        renderer.dispose();
        renderer.domElement.remove();
      };
    })();

    return () => { disposed = true; cleanupRef.current?.(); cleanupRef.current = null; };
  }, []);
  const cleanupRef = useRef<(() => void) | null>(null);

  // Tear down the current preview handle using the STORED object (never getObject3D,
  // which throws on a handle the backend already disposed during a re-mount).
  const dropHandle = useCallback(() => {
    if (objRef.current && sceneRef.current) sceneRef.current.remove(objRef.current);
    if (handleRef.current) particleBackend.dispose(handleRef.current);
    handleRef.current = null;
    objRef.current = null;
  }, []);

  // ── Load the asset def when the open target changes ──
  // openParticleEditor() clears editingParticleDef, so a fresh open always fetches. A
  // bare re-mount (e.g. switching back to this tab) keeps the def already in the store,
  // preserving unsaved edits + their place in the global undo stack.
  useEffect(() => {
    dropHandle();          // drop any previous asset's preview
    // Break the undo-coalesce chain so an edit to a same-named field on the newly-opened
    // asset can't merge into the previous asset's action (whose undo/redo target the old
    // path). Each asset starts a fresh undo step.
    lastAction.current = null;
    lastGroup.current = undefined;
    if (!asset) return;
    let cancelled = false;
    elapsedRef.current = 0; setElapsed(0);
    playingRef.current = true; setPlaying(true);
    const existing = useEditorStore.getState().editingParticleDef;
    if (existing) { savedMarkRef.current?.(existing); return; } // already loaded — keep it (treat as in-sync)
    const { loadParticleDef } = useEditorStore.getState();
    fetch(asset.path)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
      .then((json) => {
        if (cancelled) return;
        const loaded = normalizeParticleDef(json);
        if (!loaded.id) {
          // Legacy/new effect with no in-file guid. Assign + register one so scenes
          // and sub-emitters can reference it by guid (survives move/rename). Seed the
          // saved-baseline with an id-less twin so the autosave detects the new id as a
          // change and persists it to disk.
          loaded.id = newGuid();
          registerAsset(loaded.id, asset.path, 'particle');
          savedMarkRef.current?.(normalizeParticleDef(json));
        } else {
          registerAsset(loaded.id, asset.path, 'particle');
          savedMarkRef.current?.(loaded);
        }
        loadParticleDef(loaded);
      })
      .catch((e) => { if (cancelled) return; console.warn('[ParticleEditor] load failed, using default', e); const fallback = defaultParticleEffect(); savedMarkRef.current?.(fallback); loadParticleDef(fallback); });
    return () => { cancelled = true; };
    // Intentionally key on the asset PATH, not the `asset` object: the store
    // hands back a stable ref, and we only want to re-load when the path (or the
    // explicit reopen `nonce`) changes — not on incidental identity churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asset?.path, nonce, dropHandle]);

  // ── Apply def to the live preview + shared cache ──
  useEffect(() => {
    if (!def || !sceneReady || !asset) return;
    const scene = sceneRef.current;
    if (!scene) return;
    if (!handleRef.current) {
      // create on the fresh handle (getObject3D is valid here)
      const h = particleBackend.create(def);
      const obj = particleBackend.getObject3D(h);
      scene.add(obj);
      handleRef.current = h;
      objRef.current = obj;
    } else {
      particleBackend.setDef(handleRef.current, def); // live edit (store already updated the shared cache)
    }
    // `asset` is only read for a truthiness guard; we key on its stable path.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [def, sceneReady, asset?.path]);

  // Toggle the opaque ground plane. Off by default (it occludes particles behind it);
  // turn on as a ground reference or to preview soft particles fading against it.
  useEffect(() => {
    if (floorRef.current) floorRef.current.visible = showFloor;
  }, [showFloor]);

  // ── Edit helper: apply an immutable change to the def AND record it on the GLOBAL
  // undo stack (the same one Hierarchy/Inspector/SceneView use). `group` keys
  // consecutive edits so rapid same-field changes coalesce into one undo step — but
  // only while our own action is still on top of the stack (peekUndo identity check),
  // so an interleaved scene edit or any undo/redo cleanly starts a fresh step. ──
  const commit = useCallback((updater: (d: ParticleEffectDef) => ParticleEffectDef, group: string) => {
    const store = useEditorStore.getState();
    const cur = store.editingParticleDef;
    const path = store.editingParticleAsset?.path;
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
      act._after = next; // redo() reads act._after; undo() still restores the original `before`
    } else {
      const before = cur;
      const a: ParticleAction = {
        _after: next,
        label: `particle ${group.split(':')[0]}`,
        undo: () => useEditorStore.getState().applyParticleDef(path, before),
        redo: () => useEditorStore.getState().applyParticleDef(path, a._after),
      };
      pushAction(a);
      lastAction.current = a;
    }
    store.applyParticleDef(path, next);
  }, []);

  // patch default group = the set of top-level keys touched, so e.g. successive
  // "Duration" edits coalesce but a "Duration" then "Gravity" edit do not.
  const patch = useCallback((p: Partial<ParticleEffectDef>, group?: string) => commit((d) => ({ ...d, ...p }), group ?? Object.keys(p).join(',')), [commit]);
  const updForce = useCallback((i: number, p: Partial<ForceField>) => commit((d) => ({ ...d, forces: (d.forces ?? []).map((f, k) => (k === i ? { ...f, ...p } : f)) }), `force:${i}:${Object.keys(p).join(',')}`), [commit]);
  const updSub = useCallback((i: number, p: Partial<SubEmitter>) => commit((d) => ({ ...d, subEmitters: (d.subEmitters ?? []).map((s, k) => (k === i ? { ...s, ...p } : s)) }), `sub:${i}:${Object.keys(p).join(',')}`), [commit]);
  const updColl = useCallback((p: Partial<CollisionConfig>) => commit((d) => ({ ...d, collision: { mode: 'none', bounce: 0.5, ...(d.collision ?? {}), ...p } }), `coll:${Object.keys(p).join(',')}`), [commit]);

  const togglePlay = () => { const v = !playingRef.current; playingRef.current = v; setPlaying(v); if (handleRef.current) (v ? particleBackend.play : particleBackend.pause).call(particleBackend, handleRef.current); };
  const restart = () => { elapsedRef.current = 0; setElapsed(0); playingRef.current = true; setPlaying(true); if (handleRef.current) particleBackend.restart(handleRef.current); };
  const scrub = (t: number) => { elapsedRef.current = t; setElapsed(t); playingRef.current = false; setPlaying(false); if (handleRef.current) particleBackend.seek(handleRef.current, t); };

  // Create a new .particle.json via the native Save dialog, then open it.
  const newParticle = useCallback(async () => {
    const path = await saveAssetDialog({ defaultName: 'New Particle.particle.json', ext: '.particle.json', prompt: 'Create Particle Effect' });
    if (!path) return;
    const guid = newGuid();
    const def = { ...defaultParticleEffect(), id: guid };
    const ok = await backendFetch('/api/write-file', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path, content: JSON.stringify(def, null, 2) }) }).then((r) => r.ok).catch(() => false);
    if (!ok) return;
    registerAsset(guid, path, 'particle');
    const name = (path.split('/').pop() || 'Effect').replace(/\.particle\.json$/i, '');
    useEditorStore.getState().openParticleEditor({ path, type: 'particle', name });
  }, []);

  // reflect elapsed into the slider while playing
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => setElapsed(elapsedRef.current), 100);
    return () => clearInterval(id);
  }, [playing]);

  // ── Debounced auto-save to disk ──
  // Like the material Inspector, edits persist without an explicit Save — but on a
  // trailing timer so a slider/curve drag doesn't write the file every frame. Watching
  // the store's `def` covers every mutation path (field edits AND global undo/redo,
  // which both rewrite editingParticleDef). The live preview + shared cache were already
  // updated synchronously by applyParticleDef; this only handles persistence. The load
  // effect calls markSaved(def) so opening an asset never rewrites it.
  const writeDef = useCallback((d: ParticleEffectDef): Promise<boolean> => {
    const path = asset?.path;
    if (!path) return Promise.resolve(false);
    setSaveMsg('Saving…');
    return backendFetch('/api/write-file', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, content: JSON.stringify(d, null, 2) }),
    }).then((res) => {
      setSaveMsg(res.ok ? 'Saved ✓' : `Save failed (${res.status})`);
      return res.ok;
    }).catch((e) => { console.error('[ParticleEditor] auto-save failed', e); setSaveMsg('Save failed'); return false; });
  }, [asset?.path]);
  const { markSaved } = useDebouncedSave(def, writeDef, AUTOSAVE_MS);
  savedMarkRef.current = markSaved; // let the load effect seed the saved reference

  return (
    <div style={{ display: 'flex', width: '100%', height: '100%', background: '#1a1a2e', fontFamily: 'monospace', fontSize: 12, color: '#ccc' }}>
      {/* Viewport */}
      <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
        <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />
        {/* Timeline toolbar */}
        {def && (
          <div style={{ position: 'absolute', left: 8, right: 8, bottom: 8, display: 'flex', alignItems: 'center', gap: 8, background: 'rgba(0,0,0,0.55)', border: '1px solid #333', borderRadius: 4, padding: '6px 8px' }}>
            <button onClick={togglePlay} style={btn}>{playing ? '⏸' : '▶'}</button>
            <button onClick={restart} style={btn}>⟲</button>
            <button onClick={() => gUndo()} title="Undo (⌘Z) — shared global undo" style={btn}>↶</button>
            <button onClick={() => gRedo()} title="Redo (⇧⌘Z) — shared global undo" style={btn}>↷</button>
            <button onClick={() => setShowFloor((v) => !v)} title="Toggle opaque ground plane (occludes particles behind it; use for soft particles / ground reference)" style={{ ...btn, background: showFloor ? '#2d6cdf' : '#2a2a40' }}>▦</button>
            <input type="range" min={0} max={def.duration} step={0.01} value={displayElapsed(elapsed, def.duration, def.looping)} onChange={(e) => scrub(+e.target.value)} style={{ flex: 1 }} />
            <span style={{ width: 56, textAlign: 'right', color: '#888' }}>{displayElapsed(elapsed, def.duration, def.looping).toFixed(2)}s</span>
          </div>
        )}
        {!asset && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'center', justifyContent: 'center', color: '#555' }}>
            <div>Double-click a .particle.json in Assets to edit</div>
            <button onClick={newParticle} style={{ ...btn, padding: '6px 14px' }}>+ New Particle</button>
          </div>
        )}
      </div>

      {/* Properties */}
      {def && (
        <div style={{ width: 290, flexShrink: 0, borderLeft: '1px solid #333', overflowY: 'auto', padding: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <input value={def.name ?? ''} onChange={(e) => patch({ name: e.target.value })} style={{ ...input, fontWeight: 'bold', width: 150 }} />
            {/* Auto-saved — no Save button. This reflects the debounced write status. */}
            <span style={{ fontSize: 10, color: saveMsg.includes('fail') ? '#e74c3c' : '#2ecc71' }}>{saveMsg || 'Auto-save'}</span>
          </div>

          <Section title="General">
            <Num label="Duration" hint="Loop period in seconds. With looping on, the effect restarts every Duration; bursts are timed within this window." v={def.duration} min={0.1} step={0.1} on={(v) => patch({ duration: v })} />
            <Check label="Looping" hint="Restart the effect each Duration. Off = play once and stop." v={def.looping} on={(v) => patch({ looping: v })} />
            <Check label="World space" hint="On: particles stay where they were born when the emitter moves (sparks, smoke trails). Off: particles follow the emitter transform." v={def.worldSpace} on={(v) => patch({ worldSpace: v })} />
            <Num label="Max particles" hint="Hard cap on simultaneously-alive particles. Sizes the instance buffer — raising it costs memory even when fewer are alive." v={def.maxParticles} min={1} step={50} on={(v) => patch({ maxParticles: Math.round(v) })} />
            <Enum label="Sim" hint="CPU: deterministic, full feature set (trails, sub-emitters). GPU: TSL compute for very high counts (100k+) — requires Fill pool and drops trails/sub-emitters; falls back to CPU if ineligible." v={def.simulation ?? 'cpu'} options={['cpu', 'gpu']} on={(v) => patch(v === 'gpu'
              ? { simulation: 'gpu', emission: { ...def.emission, fillPool: true } } // GPU only does full-pool emission
              : { simulation: 'cpu' })} />
          </Section>

          <Section title="Emission">
            <Check label="Fill pool" hint="Keep every slot alive at all times (ages staggered so deaths spread out). Ignores Rate & Bursts; effective rate ≈ Max particles ÷ lifetime. Required for GPU sim. Ideal for dense ambient fields (galaxies, dust)." v={!!def.emission.fillPool} on={(v) => patch({ emission: { ...def.emission, fillPool: v } })} />
            <Num label="Rate / sec" hint="Continuous particles spawned per second. Disabled when Fill pool is on." v={def.emission.rateOverTime} min={0} step={5} disabled={!!def.emission.fillPool} on={(v) => patch({ emission: { ...def.emission, rateOverTime: v } })} />
            <div style={row}>
              <Label text="Bursts" hint="One-shot emissions at a specific time (seconds into Duration). Each row: time, then particle count. Fires every loop." />
              <button style={miniBtn} onClick={() => patch({ emission: { ...def.emission, bursts: [...(def.emission.bursts ?? []), { time: 0, count: 20 }] } })}>+ add</button>
            </div>
            {(def.emission.bursts ?? []).map((b, i) => (
              <div key={i} style={{ display: 'flex', gap: 4, marginBottom: 4, alignItems: 'center', paddingLeft: 8 }}>
                <NumInput title="time (s)" value={b.time} min={0} step={0.1} on={(n) => patch({ emission: { ...def.emission, bursts: (def.emission.bursts ?? []).map((x, k) => k === i ? { ...x, time: n } : x) } })} width={54} />
                <NumInput title="count" value={b.count} min={0} step={1} on={(n) => patch({ emission: { ...def.emission, bursts: (def.emission.bursts ?? []).map((x, k) => k === i ? { ...x, count: Math.round(n) } : x) } })} width={54} />
                <button style={miniBtn} onClick={() => patch({ emission: { ...def.emission, bursts: (def.emission.bursts ?? []).filter((_, k) => k !== i) } })}>×</button>
              </div>
            ))}
          </Section>

          <Section title="Shape" hint="The region particles spawn from and the initial direction they move.">
            <Enum label="Type" hint="Emitter volume: point (single spot), cone (spray), sphere (burst outward), box (volume), circle (flat ring/disc), cylinder (column around an axis)." v={def.shape.type} options={['point', 'cone', 'sphere', 'box', 'circle', 'cylinder']} on={(v) => patch({ shape: { ...def.shape, type: v as EmitterShapeType } })} />
            {(def.shape.type === 'cone' || def.shape.type === 'sphere' || def.shape.type === 'circle' || def.shape.type === 'cylinder') && (
              <>
                <Num label="Radius start" hint="Inner radius — particles spawn no closer than this to the center (0 = solid). Set equal to Radius end for a thin shell." v={def.shape.radiusStart ?? 0} min={0} step={0.05} on={(v) => patch({ shape: { ...def.shape, radiusStart: v } })} />
                <Num label="Radius end" hint="Outer radius — particles spawn out to here (world units)." v={def.shape.radiusEnd ?? def.shape.radius ?? 1} min={0} step={0.05} on={(v) => patch({ shape: { ...def.shape, radiusEnd: v } })} />
              </>
            )}
            {def.shape.type === 'cone' &&
              <Num label="Angle°" hint="Cone half-angle in degrees. 0 = straight beam, 90 = flat hemisphere spray." v={def.shape.angle ?? 25} min={0} max={90} step={1} on={(v) => patch({ shape: { ...def.shape, angle: v } })} />}
            {def.shape.type === 'cylinder' && (
              <>
                <Vec3Row label="Axis" hint="Direction the cylinder's length runs along (auto-normalized). Particles emit along this axis." v={def.shape.axis ?? [0, 1, 0]} step={0.1} on={(t) => patch({ shape: { ...def.shape, axis: t } })} />
                <Num label="Length" hint="Full length of the cylinder along its axis (world units)." v={def.shape.length ?? 1} min={0} step={0.1} on={(v) => patch({ shape: { ...def.shape, length: v } })} />
              </>
            )}
            {def.shape.type === 'box' && (
              <>
                <Vec3Row label="Half size start" hint="Inner box half-extents (x,y,z). Leave at 0 for a solid box; set to carve a hollow frame between this and the end size." v={def.shape.sizeStart ?? [0, 0, 0]} step={0.1} on={(t) => patch({ shape: { ...def.shape, sizeStart: t } })} />
                <Vec3Row label="Half size end" hint="Outer box half-extents (x,y,z) — the box's half-width/height/depth." v={def.shape.sizeEnd ?? def.shape.size ?? [1, 1, 1]} step={0.1} on={(t) => patch({ shape: { ...def.shape, sizeEnd: t } })} />
              </>
            )}
          </Section>

          <Section title="Start values" hint="Per-particle values sampled at birth. Ranges (min/max) pick a uniform random value for each particle.">
            <MinMax label="Lifetime" hint="How long each particle lives, in seconds (random between min/max)." v={def.startLifetime} step={0.1} on={(v) => patch({ startLifetime: v })} />
            <MinMax label="Speed" hint="Initial speed along the shape's emit direction, world units/sec (random min/max)." v={def.startSpeed} step={0.1} on={(v) => patch({ startSpeed: v })} />
            <MinMax label="Size" hint="Initial particle size in world units (random min/max). Scaled over life by the Size curve." v={def.startSize} step={0.05} on={(v) => patch({ startSize: v })} />
            <Color label="Color" hint="Base tint, multiplied by the Color-over-life gradient." v={def.startColor} on={(v) => patch({ startColor: v })} />
            <Num label="Opacity" hint="Base alpha 0..1, multiplied by the Opacity curve / gradient alpha." v={def.startOpacity ?? 1} min={0} max={1} step={0.05} on={(v) => patch({ startOpacity: v })} />
            <MinMax label="Rotation°" hint="Initial sprite rotation in degrees (random min/max). Billboard only." v={def.startRotation ?? { min: 0, max: 0 }} step={5} on={(v) => patch({ startRotation: v })} />
            <Vec3Row label="Gravity" hint="Constant acceleration vector (x,y,z), world units/s², applied as-is. 3D: (0,−g,0) pulls down. 2D: (0,+G,0) falls (PixiJS +Y is down), (0,−G,0) rises (smoke)." v={Array.isArray(def.gravity) ? def.gravity : [0, -(typeof def.gravity === 'number' ? def.gravity : 0), 0]} step={0.1} on={(t) => patch({ gravity: t })} />
          </Section>

          <Section title="Motion">
            <Num label="Drag" hint="Linear velocity damping per second. 0 = none; higher values slow particles down over time." v={def.drag ?? 0} min={0} step={0.05} on={(v) => patch({ drag: v })} />
            <Num label="Noise str" hint="Turbulence/curl-noise acceleration strength. Adds wandering, organic motion (smoke, embers)." v={def.noise?.strength ?? 0} min={0} step={0.1} on={(v) => patch({ noise: { strength: v, frequency: def.noise?.frequency ?? 1, scrollSpeed: def.noise?.scrollSpeed ?? 1 } })} />
            <Num label="Noise freq" hint="Spatial frequency of the noise field. Higher = tighter, more chaotic swirls; lower = broad, gentle drift." v={def.noise?.frequency ?? 1} min={0} step={0.1} on={(v) => patch({ noise: { strength: def.noise?.strength ?? 0, frequency: v, scrollSpeed: def.noise?.scrollSpeed ?? 1 } })} />
            <MinMax label="Spin °/s" hint="Constant sprite rotation speed in degrees/sec (random min/max). Billboard only." v={def.rotationSpeed ?? { min: 0, max: 0 }} step={10} on={(v) => patch({ rotationSpeed: v })} />
          </Section>

          <Section title="Forces" hint="Continuous external forces applied every frame (GPU sim supports up to 8).">
            <div style={row}>
              <Label text="Fields" hint="Directional = constant wind along (x,y,z). Point = attract (+strength) or repel (−strength) toward the (x,y,z) position. Strength scales the effect." />
              <button style={miniBtn} onClick={() => patch({ forces: [...(def.forces ?? []), { type: 'directional', x: 1, y: 0, z: 0, strength: 2 }] })}>+ add</button>
            </div>
            {(def.forces ?? []).map((f, i) => (
              <div key={i} style={{ marginBottom: 6, paddingLeft: 8, borderLeft: '2px solid #2a2a40' }}>
                <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginBottom: 3 }}>
                  <select value={f.type} onChange={(e) => updForce(i, { type: e.target.value as ForceField['type'] })} style={{ ...input, width: 100 }}>
                    <option value="directional">directional</option>
                    <option value="point">point</option>
                  </select>
                  <span style={{ color: '#666', fontSize: 9 }}>{f.type === 'point' ? 'pos' : 'dir'}</span>
                  <button style={{ ...miniBtn, marginLeft: 'auto' }} onClick={() => patch({ forces: (def.forces ?? []).filter((_, k) => k !== i) })}>×</button>
                </div>
                <div style={{ display: 'flex', gap: 4 }}>
                  <NumInput title="x" value={f.x} step={0.1} on={(n) => updForce(i, { x: n })} width={44} />
                  <NumInput title="y" value={f.y} step={0.1} on={(n) => updForce(i, { y: n })} width={44} />
                  <NumInput title="z" value={f.z} step={0.1} on={(n) => updForce(i, { z: n })} width={44} />
                  <NumInput title="strength (+attract / −repel for point)" value={f.strength} step={0.1} on={(n) => updForce(i, { strength: n })} width={54} />
                </div>
              </div>
            ))}
          </Section>

          <Section title="Collision" hint="Solid collider particles hit — a plane, sphere, or box. Coordinates are in the emitter's simulation space (emitter-local unless World space is enabled).">
            <Enum label="Mode" hint="None = pass through. Kill = particle dies on contact. Bounce = reflect off the surface." v={def.collision?.mode ?? 'none'} options={['none', 'kill', 'bounce']} on={(v) => updColl({ mode: v as CollisionConfig['mode'] })} />
            {def.collision && def.collision.mode !== 'none' && (
              <>
                <Enum label="Shape" hint="Plane = infinite half-space (normal + a point). Sphere = solid ball. Box = solid axis-aligned box. Cylinder = solid column (axis + radius + length)." v={def.collision.shape ?? 'plane'} options={['plane', 'sphere', 'box', 'cylinder']} on={(v) => updColl({ shape: v as ColliderShape })} />
                <Check label="Container" hint="Off = solid collider (keep particles OUT — they hit when entering). On = container (keep particles IN — they hit when leaving). Use a container sphere/box to trap an effect inside a volume and cull strays." v={def.collision.invert ?? false} on={(v) => updColl({ invert: v })} />
                {def.collision.mode === 'bounce' && <Num label="Bounce" hint="Fraction of velocity retained on bounce: 0 = stop dead, 1 = perfectly elastic." v={def.collision.bounce} min={0} max={1} step={0.05} on={(v) => updColl({ bounce: v })} />}
                {(def.collision.shape ?? 'plane') === 'plane' && (
                  <>
                    <Vec3Row label="Normal" hint="Plane surface normal — particles live on the +normal side. Auto-normalized." v={def.collision.planeNormal ?? [0, 1, 0]} step={0.1} on={(t) => updColl({ planeNormal: t })} />
                    <Vec3Row label="Point" hint="Any point lying on the plane (with the normal, this is the plane equation)." v={def.collision.planePoint ?? [0, def.collision.planeY ?? 0, 0]} step={0.1} on={(t) => updColl({ planePoint: t, planeY: undefined })} />
                  </>
                )}
                {def.collision.shape === 'sphere' && (
                  <>
                    <Vec3Row label="Center" hint="Sphere center." v={def.collision.center ?? [0, 0, 0]} step={0.1} on={(t) => updColl({ center: t })} />
                    <Num label="Radius" hint="Sphere radius." v={def.collision.radius ?? 1} min={0} step={0.1} on={(v) => updColl({ radius: v })} />
                  </>
                )}
                {def.collision.shape === 'box' && (
                  <>
                    <Vec3Row label="Center" hint="Box center." v={def.collision.center ?? [0, 0, 0]} step={0.1} on={(t) => updColl({ center: t })} />
                    <Vec3Row label="Size (w,h,d)" hint="Full box dimensions: width (X), height (Y), depth (Z)." v={[def.collision.width ?? 1, def.collision.height ?? 1, def.collision.depth ?? 1]} step={0.1} on={(t) => updColl({ width: t[0], height: t[1], depth: t[2] })} />
                  </>
                )}
                {def.collision.shape === 'cylinder' && (
                  <>
                    <Vec3Row label="Center" hint="Cylinder center." v={def.collision.center ?? [0, 0, 0]} step={0.1} on={(t) => updColl({ center: t })} />
                    <Vec3Row label="Axis" hint="Direction the cylinder's length runs along (auto-normalized)." v={def.collision.axis ?? [0, 1, 0]} step={0.1} on={(t) => updColl({ axis: t })} />
                    <Num label="Radius" hint="Cylinder cross-section radius." v={def.collision.radius ?? 1} min={0} step={0.1} on={(v) => updColl({ radius: v })} />
                    <Num label="Length" hint="Full length of the cylinder along its axis." v={def.collision.height ?? 1} min={0} step={0.1} on={(v) => updColl({ height: v })} />
                  </>
                )}
              </>
            )}
          </Section>

          <Section title="Over life" hint="Curves and gradient evaluated across each particle's normalized lifetime (0 = birth, 1 = death). Drag points to edit; double-click to add/remove.">
            {/* withCurvePoints/withCurveScale preserve the prior curve's other field so an
                authored `scale` survives a points edit and the curve shape survives a scale
                edit — the sampler multiplies points by `scale` (anim-particle F1). */}
            <CurveEditor label="Size" points={def.sizeOverLife?.points ?? DEFAULT_CURVE_POINTS} color="#4fd1c5" onChange={(points, g) => patch({ sizeOverLife: withCurvePoints(def.sizeOverLife, points) }, `sizeOverLife:${g ?? ''}`)} />
            <Num label="Size scale" hint="Multiplies the Size curve so a particle can grow past its base size (the curve points stay normalized 0..1; e.g. scale 3 peaks at 3× the start size)." v={def.sizeOverLife?.scale ?? 1} min={0} step={0.1} on={(v) => patch({ sizeOverLife: withCurveScale(def.sizeOverLife, v) }, 'sizeOverLife:scale')} />
            <CurveEditor label="Opacity" points={def.opacityOverLife?.points ?? DEFAULT_CURVE_POINTS} color="#f6ad55" onChange={(points, g) => patch({ opacityOverLife: withCurvePoints(def.opacityOverLife, points) }, `opacityOverLife:${g ?? ''}`)} />
            <GradientEditor value={def.colorOverLife ?? { colorStops: [{ t: 0, color: { r: 1, g: 1, b: 1 } }], alphaStops: [{ t: 0, alpha: 1 }] }} onChange={(g, group) => patch({ colorOverLife: g }, `colorOverLife:${group ?? ''}`)} />
          </Section>

          <Section title="Render">
            <Enum label="Mode" hint="Billboard = camera-facing textured quads (smoke, sparks, glows). Mesh = instanced 3D primitives (debris, confetti)." v={def.render.mode ?? 'billboard'} options={['billboard', 'mesh']} on={(v) => patch({ render: { ...def.render, mode: v as 'billboard' | 'mesh' } })} />
            <Enum label="Blend" hint="Additive = colors add up, glows brighter (fire, magic, light). Normal = standard alpha blend (smoke, debris)." v={def.render.blend} options={['additive', 'normal']} on={(v) => patch({ render: { ...def.render, blend: v as BlendMode } })} />
            {(def.render.mode ?? 'billboard') === 'mesh' ? (
              <>
                <Enum label="Shape" hint="Which built-in 3D primitive to instance for each particle." v={def.render.meshPrimitive ?? 'box'} options={['box', 'sphere', 'cone', 'tetra', 'torus']} on={(v) => patch({ render: { ...def.render, meshPrimitive: v as MeshPrimitive } })} />
                <Check label="Lit" hint="On: shade meshes with scene lighting (matte, reads as solid). Off: flat unlit color." v={def.render.meshLit ?? false} on={(v) => patch({ render: { ...def.render, meshLit: v } })} />
              </>
            ) : (
              <>
                <AssetRefField label="Texture" hint="Sprite/texture asset ref (.png/.webp). Drag a texture from the Assets panel, or use the locate button. Empty = a soft round particle." accept={['.png', '.jpg', '.jpeg', '.webp']} placeholder="drop a texture, or paste a GUID" value={def.render.texture ?? ''} onChange={(v) => patch({ render: { ...def.render, texture: v || undefined } })} />
                <Num label="Aspect" hint="Billboard width/height ratio. 1 = square; <1 = tall (e.g. 0.5 for a tall lightning bolt); >1 = wide. Size sets the height; width = height × aspect. Match a non-square sprite cell to avoid distortion/padding." v={def.render.aspect ?? 1} min={0.05} step={0.05} on={(v) => patch({ render: { ...def.render, aspect: v } })} />
                <Enum label="Anchor" hint="Billboard pivot. Center = sprite centered on the particle. Bottom = bottom edge sits at the particle position and grows upward — keeps a ground strike's base planted (place the emitter on the ground)." v={def.render.anchor ?? 'center'} options={['center', 'bottom']} on={(v) => patch({ render: { ...def.render, anchor: v as 'center' | 'bottom' } })} />
                <Num label="Offset X" hint="Horizontal sprite offset from the anchor, in units of Size (+ = right). Fine-tunes art placement." v={def.render.offset?.[0] ?? 0} step={0.05} on={(v) => patch({ render: { ...def.render, offset: [v, def.render.offset?.[1] ?? 0] } })} />
                <Num label="Offset Y" hint="Vertical sprite offset from the anchor, in units of Size (+ = up). E.g. nudge a bolt down so its in-texture impact lands on the ground." v={def.render.offset?.[1] ?? 0} step={0.05} on={(v) => patch({ render: { ...def.render, offset: [def.render.offset?.[0] ?? 0, v] } })} />
                <Num label="Tiles X" hint="Sprite-sheet columns. Frames advance over the particle's lifetime (set with Tiles Y)." v={def.render.tilesX ?? 1} min={1} step={1} on={(v) => patch({ render: { ...def.render, tilesX: Math.max(1, Math.round(v)) } })} />
                <Num label="Tiles Y" hint="Sprite-sheet rows. Total frames = Tiles X × Tiles Y, played across the lifetime." v={def.render.tilesY ?? 1} min={1} step={1} on={(v) => patch({ render: { ...def.render, tilesY: Math.max(1, Math.round(v)) } })} />
                {(def.render.tilesX ?? 1) * (def.render.tilesY ?? 1) > 1 && (
                  <>
                    <Enum label="Anim" hint="How the sprite-sheet plays over each particle's life. Once = single forward pass (explosion). Loop = cycle forward (flame). Ping-pong = forward then back, flip-flop (pulsing glow)." v={def.render.spriteMode ?? 'once'} options={['once', 'loop', 'pingpong']} on={(v) => patch({ render: { ...def.render, spriteMode: v as SpriteMode } })} />
                    {(def.render.spriteMode ?? 'once') !== 'once' && (
                      <Num label="Cycles" hint="How many full animation cycles play over the particle's lifetime (loop/ping-pong only)." v={def.render.spriteCycles ?? 1} min={1} step={1} on={(v) => patch({ render: { ...def.render, spriteCycles: Math.max(1, Math.round(v)) } })} />
                    )}
                    <Check label="Random start" hint="Offset each particle's start frame randomly so they don't animate in lockstep — adds variety to bursts." v={def.render.spriteRandomStart ?? false} on={(v) => patch({ render: { ...def.render, spriteRandomStart: v } })} />
                  </>
                )}
                <Check label="Soft" hint="Fade particles where they intersect opaque geometry, hiding hard clip edges (smoke against the ground). Use the ▦ floor toggle to preview." v={def.render.softParticles ?? false} on={(v) => patch({ render: { ...def.render, softParticles: v } })} />
              </>
            )}
            <Check label="Trail" hint="Draw a ribbon behind each particle from its recent position history. CPU sim only (forces a GPU effect to fall back)." v={def.trail?.enabled ?? false} on={(v) => patch({ trail: { enabled: v, segments: def.trail?.segments ?? 8 } })} />
            {def.trail?.enabled && (
              <Num label="Trail Seg" hint="History points retained per particle (≥2). More = longer, smoother trail at higher cost." v={def.trail?.segments ?? 8} min={2} step={1} on={(v) => patch({ trail: { enabled: true, segments: Math.max(2, Math.round(v)) } })} />
            )}
          </Section>

          <Section title="Sub-emitters" hint="Nested effects spawned in response to a parent particle's lifecycle (depth-1). CPU sim only — a GPU effect with sub-emitters falls back to CPU.">
            <div style={row}>
              <Label text="On birth/death" hint="Each row fires a burst of a child .particle.json effect when a parent particle is born or dies. Count = particles per trigger; probability = 0..1 chance per parent; inherit-v = fraction of the parent's velocity passed on." />
              <button style={miniBtn} onClick={() => patch({ subEmitters: [...(def.subEmitters ?? []), { trigger: 'death', effect: '', count: 8, probability: 1, inheritVelocity: 0 }] })}>+ add</button>
            </div>
            {(def.subEmitters ?? []).map((s, i) => (
              <div key={i} style={{ marginBottom: 6, paddingLeft: 8, borderLeft: '2px solid #2a2a40' }}>
                <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginBottom: 3 }}>
                  <select value={s.trigger} onChange={(e) => updSub(i, { trigger: e.target.value as SubEmitter['trigger'] })} style={{ ...input, width: 70 }}>
                    <option value="birth">birth</option>
                    <option value="death">death</option>
                  </select>
                  <NumInput title="count per trigger" value={s.count ?? 8} min={1} step={1} on={(n) => updSub(i, { count: Math.max(1, Math.round(n)) })} width={44} />
                  <button style={{ ...miniBtn, marginLeft: 'auto' }} onClick={() => patch({ subEmitters: (def.subEmitters ?? []).filter((_, k) => k !== i) })}>×</button>
                </div>
                <AssetRefField label="effect" hint="Child .particle.json fired by this sub-emitter. Drag a particle effect from the Assets panel, or use the locate button." accept={['.particle.json']} placeholder="drop a particle effect, or paste a GUID" value={s.effect} onChange={(val) => updSub(i, { effect: val })} />
                <div style={{ display: 'flex', gap: 4 }}>
                  <NumInput title="probability 0..1" value={s.probability ?? 1} min={0} max={1} step={0.05} on={(n) => updSub(i, { probability: n })} width={56} />
                  <NumInput title="inherit velocity 0..1" value={s.inheritVelocity ?? 0} step={0.05} on={(n) => updSub(i, { inheritVelocity: n })} width={56} />
                  <span style={{ color: '#666', fontSize: 9, alignSelf: 'center' }}>prob / inherit-v</span>
                </div>
              </div>
            ))}
          </Section>
        </div>
      )}
    </div>
  );
}

// ── styles + field components ──
const btn: React.CSSProperties = { background: '#2a2a40', color: '#ccc', border: '1px solid #444', borderRadius: 3, padding: '3px 9px', cursor: 'pointer', fontFamily: 'monospace', fontSize: 12 };
const miniBtn: React.CSSProperties = { background: '#2a2a40', color: '#aaa', border: '1px solid #444', borderRadius: 3, padding: '1px 6px', cursor: 'pointer', fontFamily: 'monospace', fontSize: 10 };
const input: React.CSSProperties = { background: '#15151f', color: '#ddd', border: '1px solid #333', borderRadius: 3, padding: '2px 4px', fontFamily: 'monospace', fontSize: 11 };
const row: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4, gap: 6 };
const lbl: React.CSSProperties = { color: '#999', fontSize: 11 };

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ color: '#7aa2f7', fontSize: 11, fontWeight: 'bold', borderBottom: '1px solid #2a2a40', paddingBottom: 3, marginBottom: 6, display: 'flex', alignItems: 'center' }}>
        {title}{hint && <Hint text={hint} />}
      </div>
      {children}
    </div>
  );
}

/** A label with an optional hover hint bubble. */
function Label({ text, hint }: { text: string; hint?: string }) {
  return <span style={{ ...lbl, display: 'inline-flex', alignItems: 'center' }}>{text}{hint && <Hint text={hint} />}</span>;
}

/** A small ⓘ marker that shows a floating hint bubble on hover. Rendered through a
 *  portal at a fixed position so the scrolling properties panel never clips it. */
function Hint({ text }: { text: string }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  return (
    <span
      onMouseEnter={(e) => { const r = e.currentTarget.getBoundingClientRect(); setPos({ x: r.right + 6, y: r.top + r.height / 2 }); }}
      onMouseLeave={() => setPos(null)}
      style={{ marginLeft: 4, color: '#6b7a99', cursor: 'help', fontSize: 10, lineHeight: 1, userSelect: 'none' }}
    >
      ⓘ
      {pos && createPortal(
        <div style={{ position: 'fixed', left: pos.x, top: pos.y, transform: 'translateY(-50%)', maxWidth: 240, background: '#0b0b14', border: '1px solid #3a3a5a', color: '#cdd4e6', padding: '6px 9px', borderRadius: 4, fontSize: 10, lineHeight: 1.45, zIndex: 99999, pointerEvents: 'none', boxShadow: '0 3px 12px rgba(0,0,0,0.7)', whiteSpace: 'normal' }}>
          {text}
        </div>,
        document.body,
      )}
    </span>
  );
}

/** Signed-number input. Uses `type="text"` (not `type="number"`) because a number
 *  input reports `value === ''` for an incomplete entry like a lone `-`, so the minus
 *  sign is wiped before a digit can follow — you could only type negatives by entering
 *  the digit first and prepending `-`. We buffer the raw string locally while focused
 *  (preserving in-progress `-`, `.`, `-.5`, …) and only push a value upstream when the
 *  text parses to a finite number; on blur we resync to the committed value. */
function NumInput({ value, on, title, min, max, step, disabled, width }: { value: number; on: (v: number) => void; title?: string; min?: number; max?: number; step?: number; disabled?: boolean; width: number }) {
  const [local, setLocal] = useState(String(value));
  const focused = useRef(false);
  const ref = useRef<HTMLInputElement>(null);
  const valueRef = useRef(value);
  valueRef.current = value;
  useEffect(() => { if (!focused.current) setLocal(String(value)); }, [value]);
  const handle = (raw: string) => {
    setLocal(raw);
    const n = parseFloat(raw);
    if (!Number.isFinite(n)) return; // mid-typing ("", "-", ".") — keep the text, push nothing
    let c = n;
    if (min !== undefined) c = Math.max(min, c);
    if (max !== undefined) c = Math.min(max, c);
    on(c);
  };
  // Mouse-wheel adjust (focused only); Shift = ×10. Steps from the shown value, falling
  // back to the committed value mid-typing. Writes local + upstream directly (the wheel
  // only fires while focused, so the value→local resync effect won't clobber it).
  const onStep = useCallback((dir: 1 | -1, mult: number) => {
    const cur = parseFloat(ref.current?.value ?? '');
    const next = applyWheelStep(Number.isFinite(cur) ? cur : valueRef.current, dir, step ?? 0.1, mult, min, max);
    setLocal(String(next));
    on(next);
  }, [on, step, min, max]);
  useWheelStep(ref, onStep, !disabled);
  return (
    <input
      ref={ref}
      type="text" inputMode="decimal" title={title} value={local} disabled={disabled}
      onFocus={() => { focused.current = true; }}
      onBlur={() => { focused.current = false; setLocal(String(value)); }}
      onChange={(e) => handle(e.target.value)}
      style={{ ...input, width }}
    />
  );
}

function Num({ label, hint, v, on, min, max, step, disabled }: { label: string; hint?: string; v: number; on: (v: number) => void; min?: number; max?: number; step?: number; disabled?: boolean }) {
  return (
    <div style={{ ...row, opacity: disabled ? 0.4 : 1 }}><Label text={label} hint={hint} />
      <NumInput value={v} min={min} max={max} step={step} disabled={disabled} on={on} width={80} />
    </div>
  );
}
function MinMax({ label, hint, v, on, step }: { label: string; hint?: string; v: { min: number; max: number }; on: (v: { min: number; max: number }) => void; step?: number }) {
  return (
    <div style={row}><Label text={label} hint={hint} />
      <span style={{ display: 'flex', gap: 4 }}>
        <NumInput title="min" value={v.min} step={step} on={(n) => on({ ...v, min: n })} width={56} />
        <NumInput title="max" value={v.max} step={step} on={(n) => on({ ...v, max: n })} width={56} />
      </span>
    </div>
  );
}
function Vec3Row({ label, hint, v, on, step }: { label: string; hint?: string; v: [number, number, number]; on: (v: [number, number, number]) => void; step?: number }) {
  return (
    <div style={row}><Label text={label} hint={hint} />
      <span style={{ display: 'flex', gap: 4 }}>
        <NumInput title="x" value={v[0]} step={step} on={(n) => on([n, v[1], v[2]])} width={50} />
        <NumInput title="y" value={v[1]} step={step} on={(n) => on([v[0], n, v[2]])} width={50} />
        <NumInput title="z" value={v[2]} step={step} on={(n) => on([v[0], v[1], n])} width={50} />
      </span>
    </div>
  );
}
function Check({ label, hint, v, on }: { label: string; hint?: string; v: boolean; on: (v: boolean) => void }) {
  return <div style={row}><Label text={label} hint={hint} /><input type="checkbox" checked={v} onChange={(e) => on(e.target.checked)} /></div>;
}
function Enum({ label, hint, v, options, on }: { label: string; hint?: string; v: string; options: string[]; on: (v: string) => void }) {
  return (
    <div style={row}><Label text={label} hint={hint} />
      <select value={v} onChange={(e) => on(e.target.value)} style={{ ...input, width: 90 }}>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  );
}
function Color({ label, hint, v, on }: { label: string; hint?: string; v: { r: number; g: number; b: number }; on: (v: { r: number; g: number; b: number }) => void }) {
  const hex = `#${[v.r, v.g, v.b].map((n) => Math.max(0, Math.min(255, Math.round(n * 255))).toString(16).padStart(2, '0')).join('')}`;
  return (
    <div style={row}><Label text={label} hint={hint} />
      <input type="color" value={hex} onChange={(e) => { const n = parseInt(e.target.value.slice(1), 16); on({ r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 }); }} />
    </div>
  );
}
