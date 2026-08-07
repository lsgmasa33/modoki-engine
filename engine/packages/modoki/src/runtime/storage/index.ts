/** PlayerPrefs — engine-owned atomic per-key JSON store. See playerPrefs.ts. */
// Side-effect: installs the PlayerPrefs-backed `playerTierStore` so the rendering layer can
// read the player's quality-tier choice without importing storage (#121 P3d).
import './playerTierProvider';

export { PlayerPrefs, resetPlayerPrefsForTest, type JsonValue, type PlayerPrefsInitOptions } from './playerPrefs';
export {
  type PrefsBackend, InMemoryBackend, LocalStorageBackend, PreferencesBackend,
  selectDefaultBackend,
} from './backends';
export { PLAYER_TIER_PREF_KEY } from './playerTierProvider';
