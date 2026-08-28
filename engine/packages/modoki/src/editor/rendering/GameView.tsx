/** Game View — live game preview with device presets and Play/Pause/Step */

import { useState, useCallback, useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import Scene3D from '../../runtime/rendering/Scene3D';
import Game from '../../runtime/rendering/Game';
import { stepOneFrame } from '../../runtime/rendering/frameDriver';
import { getPlayState, setPlayState, onPlayStateChange } from '../../runtime/core/playState';
import { setShowColliders2D, isShowColliders2D } from '../../runtime/rendering';
import { setAudioMuted, isAudioMuted } from '../../runtime/audio/audioService';
import { enterPlay, stopPlay, pausePlay } from '../scene/playMode';
import { useEditorStore } from '../store/editorStore';
import { computeDeviceLetterbox } from '../scene/sceneViewMath';
import { resolveLogicalSize, resolveSafeArea, safeAreaCssVars, type DevicePreset } from '../scene/devicePresets';
import DevicePicker from './DevicePicker';
import SafeAreaOverlay from './SafeAreaOverlay';
import { DebugMenu } from '../../runtime/debug';
import { VideoOverlay } from '../../runtime/video/VideoOverlay';
import { loadGameViewMuted, saveGameViewMuted, loadGameViewShowColliders, saveGameViewShowColliders } from './gameViewPrefs';

// ── Main GameView ───────────────────────────────────────

interface GameViewProps {
  uiLayer?: ReactNode;
}

export default function GameView({ uiLayer }: GameViewProps) {
  const playState = useSyncExternalStore(onPlayStateChange, getPlayState);
  // The device preset + orientation live in the STORE, not in local state, so an agent can set
  // them (`set-game-view-device` / `modoki_game_view_device`, #367) — the picker is a popup that
  // trusted input cannot operate, so a session's layout check used to measure whatever device the
  // human last left selected. Everything below reads them exactly as it read the useState pair.
  const preset = useEditorStore((s) => s.gameViewDevice);
  const orientation = useEditorStore((s) => s.gameViewOrientation);
  const setGameViewDevice = useEditorStore((s) => s.setGameViewDevice);
  const setGameViewMounted = useEditorStore((s) => s.setGameViewMounted);
  const setGameAreaSize = useEditorStore((s) => s.setGameAreaSize);
  const setPreset = useCallback((p: DevicePreset) => setGameViewDevice(p), [setGameViewDevice]);
  // Persisted across reloads (#399) — the runtime flag itself (`isShowColliders2D()`) starts
  // false on every fresh module load, so it can't be the source of truth for the initial
  // React state; apply the persisted value to the runtime once on mount instead.
  const [showColliders, setShowColliders] = useState(loadGameViewShowColliders);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setShowColliders2D(showColliders); }, []);
  const toggleColliders = useCallback(() => {
    const next = !isShowColliders2D();
    setShowColliders2D(next);
    setShowColliders(next);
    saveGameViewShowColliders(next);
  }, []);
  // Unity-style "Mute Audio" — silences all game audio during editing/preview. Persisted (#399)
  // the same way as showColliders above.
  const [muted, setMuted] = useState(loadGameViewMuted);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setAudioMuted(muted); }, []);
  const toggleMute = useCallback(() => {
    const next = !isAudioMuted();
    setAudioMuted(next);
    setMuted(next);
    saveGameViewMuted(next);
  }, []);
  const containerRef = useRef<HTMLDivElement>(null);
  const gameAreaRef = useRef<HTMLDivElement>(null);
  const setGameViewSize = useEditorStore((s) => s.setGameViewSize);
  const setGameViewSafeArea = useEditorStore((s) => s.setGameViewSafeArea);
  const setStoreGameRect = useEditorStore((s) => s.setGameRect);
  // Single source of truth — the letterbox rect lives in the store (read here for
  // the preview div style; SceneView overlay/picking read the same store value).
  const gameRect = useEditorStore((s) => s.gameRect);

  const isFree = preset.logicalW === 0;
  const { w: deviceW, h: deviceH } = resolveLogicalSize(preset, orientation);
  // The preset's safe-area insets, published to the preview as --ui-sa-* below. `Free`
  // and the abstract aspect presets carry zeros, so this is a no-op for them without a
  // branch. Logical px, which is the space the preview div is laid out in (the visual
  // fit is a transform: scale() applied OUTSIDE the layout — see the div's comment).
  const safeArea = resolveSafeArea(preset, orientation);
  // Publish to the store so SceneView's UI preview frame insets identically — it sizes
  // itself from `gameViewSize` and has no access to the device picker, which lives here.
  // The setter no-ops on an unchanged quartet, so this is safe to run every render.
  useEffect(() => { setGameViewSafeArea(safeArea); }, [safeArea, setGameViewSafeArea]);

  // Publish MOUNTEDNESS — the agent read-back reports it, and this component is the only place
  // the fact exists. It cannot be inferred from `openPanels`: that is every tab NODE in the
  // FlexLayout model with no selection test, and FlexLayout defaults `tabEnableRenderOnDemand`,
  // so an unclicked Game tab sharing a tabset EXISTS without ever mounting. Deriving it there
  // reported "mounted" for exactly the case the flag exists to catch (#367 close-out review).
  useEffect(() => {
    setGameViewMounted(true);
    return () => setGameViewMounted(false);
  }, [setGameViewMounted]);

  // Measure the game AREA in real CSS px, always — device selected or not. Separate from
  // `gameViewSize` below, which holds the DEVICE's logical size whenever one is picked: reading
  // that as "how big is the panel" answers with the phone, and is stale in precisely the
  // transition it would be consulted for (iPhone 16 Pro -> Free returned 402x874 as the panel
  // size; a cold editor returned the fabricated {800,450} default).
  useEffect(() => {
    const el = gameAreaRef.current;
    if (!el) return;
    const publish = () => setGameAreaSize(el.clientWidth, el.clientHeight);
    publish();
    // Deferred to the next frame for the same reason the observers below are: a synchronous
    // setState inside the RO callback can re-lay-out within the same RO cycle.
    let pending = false;
    const ro = new ResizeObserver(() => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => { pending = false; publish(); });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [setGameAreaSize]);

  // Track effective size
  useEffect(() => {
    if (!gameAreaRef.current) return;
    if (!isFree) {
      setGameViewSize(deviceW, deviceH);
      return;
    }
    // Defer the store write to the next frame: a synchronous setState inside the
    // RO callback can re-lay-out within the same RO cycle ("ResizeObserver loop
    // completed with undelivered notifications").
    let pending = false;
    let lastW = 0, lastH = 0;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width <= 0 || height <= 0) return;
      lastW = width; lastH = height;
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => { pending = false; setGameViewSize(lastW, lastH); });
    });
    ro.observe(gameAreaRef.current);
    return () => ro.disconnect();
  }, [setGameViewSize, isFree, deviceW, deviceH]);

  // Play snapshots the authored world; Stop reverts to it (discarding play-mode
  // mutations); Pause freezes the sim in place. See editor/scene/playMode.ts.
  const onPlay = useCallback(() => { void enterPlay(); }, []);
  const onStop = useCallback(() => { void stopPlay(); }, []);
  const onPause = useCallback(() => { pausePlay(); }, []);

  // Step one frame while Paused: briefly run the sim for a single frame, then
  // freeze again. The pipeline gates on play state, so we flip to 'playing'
  // around the single stepOneFrame() to actually advance game systems.
  const stepOnce = useCallback(() => {
    if (getPlayState() !== 'paused') return;
    setPlayState('playing');
    stepOneFrame(); // runs ECS pipeline + both renderers once
    setPlayState('paused');
  }, []);

  const isStopped = playState === 'stopped';
  const isPaused = playState === 'paused';

  // Letterbox calculation — sole writer to the store's gameRect.
  useEffect(() => {
    if (isFree || !gameAreaRef.current) {
      setStoreGameRect({ left: 0, top: 0, width: 0, height: 0 });
      return;
    }
    const update = () => {
      const area = gameAreaRef.current!;
      setStoreGameRect(computeDeviceLetterbox(area.clientWidth, area.clientHeight, deviceW, deviceH));
    };
    update();
    // Defer to next frame — synchronous setStoreGameRect inside the RO callback
    // can re-lay-out within the same RO cycle (RO-loop warning).
    let pending = false;
    const ro = new ResizeObserver(() => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => { pending = false; update(); });
    });
    ro.observe(gameAreaRef.current);
    return () => ro.disconnect();
  }, [isFree, deviceW, deviceH, setStoreGameRect]);

  const toggleOrientation = useCallback(
    () => setGameViewDevice(undefined, useEditorStore.getState().gameViewOrientation === 'portrait' ? 'landscape' : 'portrait'),
    [setGameViewDevice],
  );

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', background: '#0f0f23' }}>
      {/* Toolbar: menu + play controls + status — single row */}
      <div style={{ height: 32, background: '#1e1e30', borderBottom: '1px solid #333', display: 'flex', alignItems: 'center', padding: '0 6px', flexShrink: 0, fontFamily: 'monospace', fontSize: '13px', gap: 3 }}>
        <DevicePicker preset={preset} orientation={orientation} onSelect={setPreset} onToggleOrientation={toggleOrientation} />
        <div style={{ width: 1, height: 18, background: '#444', margin: '0 6px' }} />
        {isStopped ? (
          <button data-ui-id="gameView.toolbar.play" onClick={onPlay} style={{ ...iconBtnStyle, color: '#2ecc71' }} title="Play (⌘P)">▶</button>
        ) : (
          <button data-ui-id="gameView.toolbar.stop" onClick={onStop} style={{ ...iconBtnStyle, color: '#e74c3c' }} title="Stop">⏹</button>
        )}
        {/* One control, two labels — the id stays `pause` in BOTH states on purpose: an agent
            aims by id and reads which it is from get_editor_state.playState, so a resume can't
            miss because the selector changed underneath it. */}
        <button data-ui-id="gameView.toolbar.pause" onClick={isPaused ? onPlay : onPause} style={{ ...iconBtnStyle, opacity: isStopped ? 0.4 : 1 }}
          title={isPaused ? 'Resume (⌘P)' : 'Pause (⌘P)'} disabled={isStopped}>
          {isPaused ? '▶' : '⏸'}
        </button>
        <button data-ui-id="gameView.toolbar.step" onClick={stepOnce} style={{ ...iconBtnStyle, opacity: isPaused ? 1 : 0.4 }} title="Step Frame" disabled={!isPaused}>
          ⏭
        </button>
        <div style={{ width: 1, height: 18, background: '#444', margin: '0 6px' }} />
        <button data-ui-id="gameView.toolbar.colliders" onClick={toggleColliders} style={{ ...iconBtnStyle, color: showColliders ? '#2effa6' : '#888' }}
          title="Toggle 2D collider overlay">⬡</button>
        <button data-ui-id="gameView.toolbar.mute" onClick={toggleMute} style={{ ...iconBtnStyle, color: muted ? '#e74c3c' : '#888' }}
          title={muted ? 'Unmute audio' : 'Mute audio'}>{muted ? '🔇' : '🔊'}</button>
        <span style={{ flex: 1 }} />
        <span data-ui-id="gameView.status" style={{ color: isStopped ? '#888' : isPaused ? '#f1c40f' : '#2ecc71', fontSize: '11px', whiteSpace: 'nowrap', flexShrink: 0 }}>
          {isStopped ? 'STOPPED' : isPaused ? 'PAUSED' : 'PLAYING'}
        </span>
        <span style={{ color: '#555', fontSize: '11px', flexShrink: 0 }}>|</span>
        {/* The device readout is the least important thing here: in a narrow Game panel
            it ellipsizes away rather than wrapping out of the 32px toolbar. */}
        <span style={{ color: '#888', fontSize: '11px', minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {isFree ? 'Free' : `${preset.name} ${deviceW}x${deviceH}`}
        </span>
      </div>

      {/* Game area */}
      <div ref={gameAreaRef} data-game-view-area style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        {/* Device preview: render the content at the LOGICAL device resolution
            (deviceW×deviceH) and visually fit it with transform: scale(). This
            keeps the preview pixel-faithful to the device — px text, vmin-sized
            UI, and the canvas all scale together. Sizing the div to the SCALED
            rect instead would make --ui-vmin (measured from the container) reflect
            the scaled size, so vmin buttons would grow out of proportion with the
            fixed-px text. gameRect (the visual rect) stays in the store for the
            SceneView overlay/picking math. */}
        <div style={{
          ...(isFree ? { position: 'absolute', inset: 0 } : {
            position: 'absolute', left: gameRect.left, top: gameRect.top,
            width: deviceW, height: deviceH,
            transform: `scale(${deviceW > 0 ? gameRect.width / deviceW : 1})`,
            transformOrigin: 'top left',
            border: '1px solid #333',
          }),
          // Simulate the device's safe area for everything inside this preview.
          // `anchorCss` emits `var(--ui-sa-top, env(safe-area-inset-top))`, so setting
          // these overrides the desktop `env()` — which is always 0 and is why the editor
          // structurally could not show a notched-phone layout before (#271). A shipped
          // build never sets them and falls through to the device's real values.
          ...safeAreaCssVars(safeArea),
        }}>
          <Scene3D />
          <Game />
          {uiLayer && (
            <div style={{ position: 'absolute', inset: 0, zIndex: 2, pointerEvents: 'none' }}>
              {uiLayer}
            </div>
          )}
          {/* Cutscene layer. Mounted HERE as well as in the app shell because the
              editor's Game panel does not render App.tsx's wrapper — a cutscene that
              only appeared in a shipped build would be untestable in the editor,
              which is where it gets authored. Renders nothing unless a
              presentation-mode clip is playing. */}
          <VideoOverlay />
          {/* The bands the insets above correspond to — drawn so an element that moves
              has a visible reason. Renders nothing when the preset has no insets. */}
          <SafeAreaOverlay insets={safeArea} />
          {/* Stopped: the game sim is frozen and UI actions don't dispatch, so
              clicking buttons/sliders does nothing. Make that explicit with a
              click-to-play call-to-action overlaying the game. */}
          {isStopped && (
            <div
              onClick={onPlay}
              title="Press Play to run the game and interact with its UI"
              style={{
                position: 'absolute', inset: 0, zIndex: 3, cursor: 'pointer',
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                gap: 14, background: 'rgba(15,15,35,0.35)', backdropFilter: 'blur(1px)',
                fontFamily: 'monospace', userSelect: 'none',
              }}
            >
              <div style={{
                width: 72, height: 72, borderRadius: '50%',
                background: 'rgba(46,204,113,0.18)', border: '2px solid #2ecc71',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: '#2ecc71', fontSize: 30, paddingLeft: 6,
              }}>▶</div>
              <div style={{ color: '#fff', fontSize: 14, fontWeight: 600 }}>Press Play to interact</div>
              <div style={{ color: '#aaa', fontSize: 11 }}>The game is stopped — UI buttons won't respond until you play</div>
            </div>
          )}
          {/* In-game debug menu (F12 / 3-finger tap) — mounted INSIDE the device
              preview and anchored to it, so it overlays (and scales with) the game
              exactly the way it appears on a device, rather than floating over the
              surrounding editor chrome. Editor code is dev-only, so importing the
              debug UI here doesn't affect game bundles. */}
          <DebugMenu anchor="container" />
        </div>
      </div>
    </div>
  );
}

const iconBtnStyle: React.CSSProperties = {
  padding: '4px 8px', border: '1px solid #555', borderRadius: 4,
  background: '#333', color: '#ccc', cursor: 'pointer', fontSize: '14px',
  lineHeight: 1,
};
