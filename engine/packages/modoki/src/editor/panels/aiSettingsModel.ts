// Client model for the AI panel's per-project settings (<project>/.modoki/ai-settings.json,
// served by /api/ai-settings). Kept tiny + fetch-through-backendFetch so it obeys the
// no-raw-fetch('/api/...') lint parity rule. Failures degrade to defaults — a settings
// read never blocks the panel or Play.

import { backendFetch, backendPostJson } from '../backend/editorBackend';

export interface AiSettings {
  /** Auto-open the Tier-2 @contact journal watch when the GameView enters Play. */
  captureContactOnLaunch?: boolean;
}

// Last known settings, refreshed on every fetch/save. Lets a hot path (enterPlay) read the
// flag SYNCHRONOUSLY instead of blocking Play on a backend round-trip. `undefined` = never
// loaded yet (a cold read should fetch once).
let _cached: AiSettings | undefined;

/** The cached settings, or undefined if never fetched this session. */
export function getCachedAiSettings(): AiSettings | undefined { return _cached; }

export async function fetchAiSettings(signal?: AbortSignal): Promise<AiSettings> {
  try {
    const res = await backendFetch('/api/ai-settings', signal ? { signal } : undefined);
    if (!res.ok) return _cached = {};
    return _cached = (await res.json()) as AiSettings;
  } catch { return _cached ?? {}; }
}

/** Shallow-merge a patch into the persisted settings; returns the merged result. */
export async function saveAiSettings(patch: AiSettings): Promise<AiSettings> {
  try {
    const res = await backendPostJson('/api/ai-settings', patch);
    if (!res.ok) return _cached ?? {};
    return _cached = (await res.json()) as AiSettings;
  } catch { return _cached ?? {}; }
}
