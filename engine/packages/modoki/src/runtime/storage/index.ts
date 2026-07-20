/** PlayerPrefs — engine-owned atomic per-key JSON store. See playerPrefs.ts. */
export { PlayerPrefs, resetPlayerPrefsForTest, type JsonValue, type PlayerPrefsInitOptions } from './playerPrefs';
export {
  type PrefsBackend, InMemoryBackend, LocalStorageBackend, PreferencesBackend,
  selectDefaultBackend,
} from './backends';
