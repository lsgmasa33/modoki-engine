/** Native "Save As" file selector via the dev server (macOS osascript). Returns an
 *  asset-root URL path for the chosen location, or null if the user cancelled.
 *  Falls back to an in-app modal on platforms without a native panel (Windows/Linux). */

import { backendFetch } from '../backend/editorBackend';

/** In-app path prompt. `window.prompt()` throws "prompt() is not supported" in the Electron
 *  renderer, which broke every "New <asset>" flow on Windows/Linux (no native osascript panel).
 *  This renders a minimal modal with plain DOM — no React dependency in this util — and resolves
 *  with the typed value (trimmed) or null on cancel/Escape. */
function promptPath(title: string, message: string, initial: string): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center';
    const box = document.createElement('div');
    box.style.cssText = 'background:#1e1e30;border:1px solid #555;border-radius:6px;padding:16px 20px;min-width:380px;font-family:monospace';
    const heading = document.createElement('div');
    heading.textContent = title;
    heading.style.cssText = 'color:#fff;font-size:13px;margin-bottom:8px';
    const label = document.createElement('div');
    label.textContent = message;
    label.style.cssText = 'color:#9a9aa8;font-size:11px;margin-bottom:8px';
    const input = document.createElement('input');
    input.value = initial;
    input.style.cssText = 'width:100%;box-sizing:border-box;padding:6px 8px;border-radius:3px;border:1px solid #444;background:#11111c;color:#eee;font-family:monospace;font-size:12px';
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:12px';
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    cancel.style.cssText = 'padding:4px 16px;border:1px solid #555;border-radius:3px;background:#2a2a40;color:#ccc;cursor:pointer;font-family:monospace;font-size:11px';
    const ok = document.createElement('button');
    ok.textContent = 'Create';
    ok.style.cssText = 'padding:4px 16px;border:1px solid #3a6;border-radius:3px;background:#244;color:#cfc;cursor:pointer;font-family:monospace;font-size:11px';
    row.append(cancel, ok);
    box.append(heading, label, input, row);
    overlay.append(box);
    document.body.append(overlay);

    const done = (val: string | null) => { overlay.remove(); resolve(val); };
    const submit = () => { const v = input.value.trim(); done(v || null); };
    ok.onclick = submit;
    cancel.onclick = () => done(null);
    overlay.onclick = (e) => { if (e.target === overlay) done(null); };
    input.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
      else if (e.key === 'Escape') { e.preventDefault(); done(null); }
    };
    setTimeout(() => { input.focus(); input.select(); }, 0);
  });
}

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
  // Fallback: no native panel (Windows/Linux) or a server error — in-app modal (window.prompt
  // throws in the Electron renderer).
  const seed = `${(defaultFolder ?? '').replace(/\/$/, '')}/${defaultName}`.replace(/^\/+/, '/');
  const typed = await promptPath(prompt ?? 'Save As', 'Save as (project-relative path):', seed);
  if (!typed) return null;
  return ensureExt(typed.startsWith('/') ? typed : '/' + typed, ext);
}
