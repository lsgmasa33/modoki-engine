/** PlayerPrefs — engine-owned atomic per-key JSON store. See playerPrefs.ts. */
// Side-effect: installs the PlayerPrefs-backed `playerTierStore` so the rendering layer can
// read the player's quality-tier choice without importing storage (#121 P3d).
import './playerTierProvider';
// Side-effect: installs the PlayerPrefs-backed `probeVerdictStore`, which is what stops the
// launch-blocking boot ramp probe from re-running on every launch (#188).
import './probeVerdictProvider';

export { PlayerPrefs, resetPlayerPrefsForTest, type JsonValue, type PlayerPrefsInitOptions } from './playerPrefs';
export {
  type PrefsBackend, InMemoryBackend, LocalStorageBackend, PreferencesBackend,
  selectDefaultBackend,
} from './backends';
export { PLAYER_TIER_PREF_KEY } from './playerTierProvider';
export { PROBE_VERDICT_PREF_KEY } from './probeVerdictProvider';
