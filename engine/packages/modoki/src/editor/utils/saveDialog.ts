/** Native "Save As" file selector via the backend's `/api/save-dialog` — in the Electron editor a
 *  sheet on the editor window, in a browser dev tab an osascript panel on macOS (#1440,
 *  `plugins/backend/nativeChooser.ts`). Returns an asset-root URL path for the chosen location, or
 *  null if the user cancelled. Falls back to an in-app modal where the host has no native panel, and
 *  when the panel FAILED (a failure is no longer reported as a Cancel). */

import { backendFetch } from '../backend/editorBackend';
import { openDomModalShell } from '../components/modalBackdrop';

/** In-app path prompt. `window.prompt()` throws "prompt() is not supported" in the Electron
 *  renderer, which broke every "New <asset>" flow on Windows/Linux (no native osascript panel).
 *  This renders a minimal modal with plain DOM — no React dependency in this util — and resolves
 *  with the typed value (trimmed) or null on cancel/Escape. */
function promptPath(title: string, message: string, initial: string): Promise<string | null> {
  return openModal(title, message, 'Create', initial);
}

/** In-app "Replace?" confirmation for a create whose destination already exists (#1215, #1264).
 *  Needed because neither save path reliably asks: the in-app fallback above (a browser dev tab off
 *  macOS, or a failed panel) is a text box with no existence check, and the native panel checks the COLLAPSED name (`rock.json`) while the
 *  write goes to `rock.mat.json` (see `ensureExt`) — and Create Prefab / Auto-Rig derive their path
 *  with no dialog at all. `window.confirm` is not an option for the same reason `window.prompt` is
 *  not. Resolves true only on an explicit Replace. The wording is shared by every create, so it names
 *  no particular new content: a New X writes a default document, Create Prefab the selected entity. */
export async function confirmReplaceAsset(path: string): Promise<boolean> {
  const answer = await openModal(
    'Replace existing asset?',
    `${path} already exists. Replace its contents? It keeps its GUID, so scenes and prefabs that use it keep pointing at it — at the new contents.`,
    'Replace',
  );
  return answer !== null;
}

/** A yes/no question in the editor's own modal. `window.confirm` is not an option (see
 *  `confirmReplaceAsset`). `message` keeps its line breaks. Resolves true only on an explicit OK;
 *  Cancel, Escape and a backdrop click are all no. First used by the cross-scene reparent prompt (#1429). */
export async function confirmInEditor(title: string, message: string, okLabel: string): Promise<boolean> {
  return (await openModal(title, message, okLabel, undefined, true)) !== null;
}

/** The prompt and the confirmation, in the plain-DOM form of the editor's modal shell (#1270), so the
 *  editor underneath takes no key and no menu command while it waits. With `initial` it is a text
 *  prompt resolving the trimmed value (null when empty); without it, a confirmation resolving '' on
 *  OK. Null on Cancel, Escape or a backdrop click. */
function openModal(title: string, message: string, okLabel: string, initial?: string, multiline = false): Promise<string | null> {
  return new Promise((resolve) => {
    // Above every React dialog (99999): Create Prefab and the New buttons can ask from inside one.
    const { root: overlay, close } = openDomModalShell('save-dialog', { zIndex: 99999, onDismiss: () => done(null) });
    const box = document.createElement('div');
    box.style.cssText = 'background:#1e1e30;border:1px solid #555;border-radius:6px;padding:16px 20px;min-width:380px;font-family:monospace';
    const heading = document.createElement('div');
    heading.textContent = title;
    heading.style.cssText = 'color:#fff;font-size:13px;margin-bottom:8px';
    const label = document.createElement('div');
    label.textContent = message;
    label.style.cssText = 'color:#9a9aa8;font-size:11px;margin-bottom:8px';
    // A multi-line message keeps its breaks and wraps inside a bounded box instead of stretching it.
    if (multiline) { label.style.whiteSpace = 'pre-wrap'; box.style.maxWidth = '560px'; }
    const input = initial === undefined ? null : document.createElement('input');
    if (input) {
      input.value = initial ?? '';
      input.style.cssText = 'width:100%;box-sizing:border-box;padding:6px 8px;border-radius:3px;border:1px solid #444;background:#11111c;color:#eee;font-family:monospace;font-size:12px';
    }
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:12px';
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    cancel.style.cssText = 'padding:4px 16px;border:1px solid #555;border-radius:3px;background:#2a2a40;color:#ccc;cursor:pointer;font-family:monospace;font-size:11px';
    const ok = document.createElement('button');
    ok.textContent = okLabel;
    ok.style.cssText = 'padding:4px 16px;border:1px solid #3a6;border-radius:3px;background:#244;color:#cfc;cursor:pointer;font-family:monospace;font-size:11px';
    row.append(cancel, ok);
    box.append(heading, label, ...(input ? [input] : []), row);
    overlay.append(box);

    const onKey = (e: KeyboardEvent) => {
      // Enter submits only from the prompt's own INPUT. On a focused button it falls through to
      // that button: Tab-to-Cancel then Enter must cancel (it submitted, briefly — #1215 close-out
      // review), and in a confirmation the focused button is Cancel, so a destructive Replace takes
      // a deliberate click rather than a reflexive Enter.
      if (e.key === 'Enter' && input && e.target === input) { e.preventDefault(); submit(); }
      else if (e.key === 'Escape') { e.preventDefault(); done(null); }
    };
    const done = (val: string | null) => { close(); resolve(val); };
    const submit = () => { if (!input) { done(''); return; } const v = input.value.trim(); done(v || null); };
    ok.onclick = submit;
    cancel.onclick = () => done(null);
    // On the OVERLAY, not the document: every key a modal should hear comes from an element inside
    // it (the input, or the focused button), and a global listener is what keymapOwnership forbids.
    // Removed with the overlay, so nothing outlives a closed modal.
    overlay.onkeydown = onKey;
    setTimeout(() => { if (input) { input.focus(); input.select(); } else { cancel.focus(); } }, 0);
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

type SaveAssetDialogOpts = {
  defaultName: string;      // e.g. "New Animation.anim.json"
  ext: string;              // e.g. ".anim.json" — enforced on the result
  defaultFolder?: string;   // asset-root URL to start in (Assets folder context)
  prompt?: string;
};

/** The save dialog, plus the `confirmReplace` a create at the chosen path should use (#1264).
 *
 *  The native panel runs its OWN "Replace?" check (macOS observed; Windows observed in #1441 — Windows'
 *  own "Confirm Save As"; `showOverwriteConfirmation` is Linux-only, the others always ask) — but against the name IT returned, before
 *  `ensureExt`. When that name already is the real destination (`scene.json`, or a typed
 *  `Walk.anim.json`) the human has been asked once, and asking again in-app is a double prompt.
 *  When it is not (`Walk` → `Walk.anim.json`, the compound-extension collapse) the panel checked a
 *  different file and nobody has asked about this one. The fallback text box never asks. */
export async function chooseNewAssetPath(
  opts: SaveAssetDialogOpts,
): Promise<{ path: string; confirmReplace: (path: string) => Promise<boolean> } | null> {
  const { defaultName, ext, defaultFolder, prompt } = opts;
  let res: { path?: string; existingPath?: string; cancelled?: boolean; unsupported?: boolean; error?: string };
  try {
    res = await backendFetch('/api/save-dialog', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultName, defaultFolder, prompt: prompt ?? 'Save As' }),
    }).then((r) => r.json());
  } catch {
    res = { error: 'network' };
  }
  if (res.cancelled) return null;
  if (res.path) {
    const path = ensureExt(res.path, ext);
    // The file the panel asked about, spelled as the create's 409 will name it (`existingPath`) — the
    // typed `level.json` over an existing `Level.json` reaches `confirmReplace` as `Level.json` (#1273).
    // The premise that the panel's own "already exists" check folds case: observed on Windows (#1441 —
    // an all-caps spelling of an existing scene raised the Replace prompt); still unobserved on APFS.
    // Wrong there, it would be a silent replace of a case variant.
    const panelChecked = res.existingPath ?? res.path;
    return { path, confirmReplace: (p) => (p === panelChecked ? Promise.resolve(true) : confirmReplaceAsset(p)) };
  }
  if (res.error === 'outside-asset-roots') {
    alert('Please choose a location inside the project (a game\'s assets/ folder or modoki/assets).');
    return null;
  }
  // Fallback: no native panel (a browser dev tab off macOS), a failed panel, or a server error —
  // in-app modal (window.prompt throws in the Electron renderer).
  const seed = `${(defaultFolder ?? '').replace(/\/$/, '')}/${defaultName}`.replace(/^\/+/, '/');
  const typed = await promptPath(prompt ?? 'Save As', 'Save as (project-relative path):', seed);
  if (!typed) return null;
  return { path: ensureExt(typed.startsWith('/') ? typed : '/' + typed, ext), confirmReplace: confirmReplaceAsset };
}
