/** Native "Save As" file selector via the dev server (macOS osascript). Returns an
 *  asset-root URL path for the chosen location, or null if the user cancelled.
 *  Falls back to an in-app prompt on platforms without a native panel. */

import { backendFetch } from '../backend/editorBackend';

export function ensureExt(p: string, ext: string): string {
  const lp = p.toLowerCase(), le = ext.toLowerCase();
  if (lp.endsWith(le)) return p;
  // Compound extension (e.g. ".anim.json"): the native macOS panel collapses it to its
  // final component (".json") and re-appends that to whatever the user typed — so typing
  // "wave" yields "wave.json". Strip that trailing outer component before appending the
  // full ext, else we'd get "wave.json.anim.json".
  const outer = ext.slice(ext.lastIndexOf('.')); // ".json" for ".anim.json"
  const base = le !== outer.toLowerCase() && lp.endsWith(outer.toLowerCase())
    ? p.slice(0, p.length - outer.length)
    : p;
  return base + ext;
}

export async function saveAssetDialog(opts: {
  defaultName: string;      // e.g. "New Animation.anim.json"
  ext: string;              // e.g. ".anim.json" — enforced on the result
  defaultFolder?: string;   // asset-root URL to start in (Assets folder context)
  prompt?: string;
}): Promise<string | null> {
  const { defaultName, ext, defaultFolder, prompt } = opts;
  let res: { path?: string; cancelled?: boolean; unsupported?: boolean; error?: string } = {};
  try {
    res = await backendFetch('/api/save-dialog', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultName, defaultFolder, prompt: prompt ?? 'Save As' }),
    }).then((r) => r.json());
  } catch {
    res = { error: 'network' };
  }
  if (res.cancelled) return null;
  if (res.path) return ensureExt(res.path, ext);
  if (res.error === 'outside-asset-roots') {
    alert('Please choose a location inside the project (a game\'s assets/ folder or modoki/assets).');
    return null;
  }
  // Fallback: no native panel (non-macOS) or a server error — prompt for a path.
  const seed = `${(defaultFolder ?? '').replace(/\/$/, '')}/${defaultName}`.replace(/^\/+/, '/');
  const typed = window.prompt('Save as (project-relative path):', seed);
  if (!typed) return null;
  return ensureExt(typed.startsWith('/') ? typed : '/' + typed, ext);
}
