/** The state OUTSIDE the world that a ▶ preview can change, and the copy that puts it back (#1551).
 *
 *  ▶ runs signal and `OnSequence` actions exactly as Play does, and the world snapshot reverts only
 *  ECS state. A cutscene that ducks the music bus left the editor muted after ⏹ Exit, and a
 *  `quality.set` left the tier applied and written into PlayerPrefs. The owner's decision was to
 *  snapshot the stores the engine knows about when a session opens and restore them wherever the
 *  session ends — rather than skip "unsafe" actions in preview, which would make ▶ stop matching Play.
 *
 *  ⚠️ What this CANNOT cover, by that same decision: effects that are not state (a real `iap.buy`, a
 *  browser tab from `system.openUrl`, `engine.reload`, a sound that already played) and a game's own
 *  module state or stores. Those still happen for real during ▶.
 *
 *  Each store restores only what CHANGED, so a preview that fired no action writes nothing — no
 *  PlayerPrefs drain, no tier re-apply, no mixer re-render. A store that throws is logged and skipped:
 *  one broken store must not stop the others, or the world restore that follows. */

import { getBusVolumes, setBusVolume, type BusName } from '../../runtime/audio/audioService';
import { useAudioMixStore } from '../../runtime/actions/audioControls';
import { PlayerPrefs } from '../../runtime/storage/playerPrefs';
import { getActiveQualityTier, setActiveQualityTier } from '../../runtime/rendering/renderSettings';
import { applyActiveTierToRuntime } from '../../runtime/rendering/tierCalibration';

interface SideStore<T> {
  name: string;
  capture(): T;
  /** Put `snap` back, writing only what differs from the live value. */
  restore(snap: T): void;
}

const MIX_KEYS = [
  'audioMaster', 'audioMusic', 'audioSfx', 'audioUi',
  'audioMasterPct', 'audioMusicPct', 'audioSfxPct', 'audioUiPct',
] as const;
type MixSnap = Pick<ReturnType<typeof useAudioMixStore.getState>, typeof MIX_KEYS[number]>;

/** The bus volumes live in TWO places — the audio service (what you hear) and the mixer store a
 *  settings slider binds to — and each writer updates both. Restored together, or a slider shows a
 *  volume the mix no longer has. The store is read on its own rather than derived from the service:
 *  it is only a mirror, and a game writer may not keep it in step. */
const busVolumesStore: SideStore<{ service: Record<BusName, number>; mix: MixSnap }> = {
  name: 'audio bus volumes',
  capture() {
    const st = useAudioMixStore.getState();
    const mix = {} as MixSnap;
    for (const k of MIX_KEYS) (mix as Record<string, unknown>)[k] = st[k];
    return { service: getBusVolumes(), mix };
  },
  restore(snap) {
    const now = getBusVolumes();
    for (const bus of Object.keys(snap.service) as BusName[]) {
      if (now[bus] !== snap.service[bus]) setBusVolume(bus, snap.service[bus]);
    }
    const st = useAudioMixStore.getState();
    if (MIX_KEYS.some((k) => st[k] !== snap.mix[k])) useAudioMixStore.setState(snap.mix);
  },
};

/** PlayerPrefs is PERSISTED — the editor's namespace lives in localStorage — so a preview's write is a
 *  real disk write until this puts it back. Values are compared as JSON, and the snapshot holds the
 *  JSON text, so a caller mutating a returned object cannot edit the snapshot.
 *  ⚠️ Only the READABLE keys (`keys()`): a key protected by an unreadable save cannot be read here and
 *  cannot be written by any action either (`set` refuses it). An action that DELETES one is not
 *  undone — the bytes it removed were never readable to this build. */
const playerPrefsStore: SideStore<Map<string, string>> = {
  name: 'PlayerPrefs',
  capture() {
    const snap = new Map<string, string>();
    for (const k of PlayerPrefs.keys()) snap.set(k, JSON.stringify(PlayerPrefs.get(k)));
    return snap;
  },
  restore(snap) {
    for (const k of PlayerPrefs.keys()) if (!snap.has(k)) PlayerPrefs.delete(k);
    for (const [k, json] of snap) {
      if (JSON.stringify(PlayerPrefs.get(k)) !== json) PlayerPrefs.set(k, JSON.parse(json));
    }
  },
};

/** The APPLIED tier (module state: shadows, texture cap, DPR). `quality.set`'s persisted half — the
 *  player's choice — is a PlayerPrefs key, restored above. Put back through the same two calls
 *  `applyQualityTier` makes, but with the snapshot's own resolution, so its source and reason survive
 *  instead of reading "player selected this tier".
 *  ⚠️ Not undone: the `assessedTier` latch. A ▶ `quality.set('auto')` from a player pin can latch it,
 *  and nothing un-latches it. Harmless in the editor (calibration is off there); only a game reading
 *  `getAssessedQualityTier()` during an editor session would see it. */
const qualityTierStore: SideStore<ReturnType<typeof getActiveQualityTier>> = {
  name: 'applied quality tier',
  capture() {
    const res = getActiveQualityTier();
    return res ? { ...res } : null;
  },
  restore(snap) {
    const now = getActiveQualityTier();
    if ((now?.tier ?? null) === (snap?.tier ?? null) && now?.source === snap?.source) return;
    setActiveQualityTier(snap);
    applyActiveTierToRuntime();
  },
};

const STORES: SideStore<unknown>[] = [busVolumesStore, playerPrefsStore, qualityTierStore] as SideStore<unknown>[];

/** One captured value per store that captured cleanly. Opaque to callers. */
export type PreviewSideState = ReadonlyMap<string, unknown>;

/** Capture every known non-world store. Taken when a preview session seats its world snapshot. */
export function capturePreviewSideState(): PreviewSideState {
  const snap = new Map<string, unknown>();
  for (const s of STORES) {
    try { snap.set(s.name, s.capture()); } catch (e) {
      console.error(`[previewSideState] could not capture ${s.name} — a preview change to it will not be undone`, e);
    }
  }
  return snap;
}

/** Put every captured store back. Called wherever a session ends — WITH or WITHOUT a world restore:
 *  the actions ran whatever happens to the world afterwards, so a scene swap that abandons the
 *  session still owes this. */
export function restorePreviewSideState(snap: PreviewSideState): void {
  for (const s of STORES) {
    if (!snap.has(s.name)) continue;
    try { s.restore(snap.get(s.name)); } catch (e) {
      console.error(`[previewSideState] could not restore ${s.name} after the preview`, e);
    }
  }
}
