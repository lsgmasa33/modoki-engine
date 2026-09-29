// Client model for the AI panel's per-project settings (<project>/.modoki/ai-settings.json,
// served by /api/ai-settings). Kept tiny + fetch-through-backendFetch so it obeys the
// no-raw-fetch('/api/...') lint parity rule. Failures degrade to defaults — a settings
// read never blocks the panel or Play.

import { backendFetch, postBackend } from '../backend/editorBackend';

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

/** Shallow-merge a patch into the persisted settings: the merged result, or the route's refusal.
 *
 *  ⚠️ It used to answer the CACHED settings on a refusal, which read to its caller as a save (#1824, a false success).
 *  Renamed with the return type, so no caller can keep reading the old shape as if it saved. */
export async function saveAiSettingsPatch(patch: AiSettings): Promise<{ ok: true; settings: AiSettings } | { ok: false; error: string }> {
  const a = await postBackend('/api/ai-settings', patch);
  if (!a.ok) return { ok: false, error: a.error };
  return { ok: true, settings: _cached = a.body as AiSettings };
}
