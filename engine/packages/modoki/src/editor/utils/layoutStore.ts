/** Layout-persistence logic, factored out of EditorApp so it's unit-testable
 *  without dragging in the whole editor (FlexLayout, panels, Three.js, SceneView)
 *  — same rationale as `layoutNames.ts` next to it. Landed for #126: this block
 *  was already pure and already at module scope, merely unexported, and sat at
 *  0% measured coverage inside EditorApp.tsx while layoutNames.ts (extracted for
 *  the same reason) sits at 100%.
 *
 * Layouts are MACHINE-LOCAL editor working state — NOT engine source or project
 * data — so they're stored per-project under <project>/.modoki/layouts/ (a
 * gitignored dir), served by the backend /api/layout(s) endpoints. This mirrors
 * recent-projects.json; it deliberately does NOT use the asset tree (which would
 * write layouts into the engine package and commit them).
 *
 * The working layout also auto-saves to a reserved "autosave" layout so there's
 * ALWAYS a durable, loadable recovery point — the user never has to "Save Layout
 * As" before they can load a past layout. localStorage is kept only as an offline
 * fast-path mirror. The tracked layout NAME (last loaded/saved) persists in
 * localStorage so the association survives a reload. */

import { Model, TabNode, Actions } from 'flexlayout-react';
import type { IJsonModel } from 'flexlayout-react';

import { backendFetch } from '../backend/editorBackend';
import { AUTOSAVE_NAME, sanitizeExportFileName } from './layoutNames';

// Default layout — Unity-inspired
export const defaultLayout: IJsonModel = {
  global: {
    // Each panel tab shows a ✕ that closes (hides) it; re-show from the Window menu.
    tabEnableClose: true,
    tabSetEnableMaximize: true,
    tabSetEnableTabStrip: true,
    splitterSize: 4,
  },
  borders: [],
  layout: {
    type: 'row',
    weight: 100,
    children: [
      {
        type: 'tabset',
        weight: 15,
        children: [
          { type: 'tab', name: 'Hierarchy', component: 'hierarchy' },
        ],
      },
      {
        type: 'row',
        weight: 55,
        children: [
          {
            type: 'tabset',
            weight: 60,
            children: [
              { type: 'tab', name: 'Scene', component: 'scene' },
            ],
          },
          {
            type: 'tabset',
            weight: 40,
            children: [
              { type: 'tab', name: 'Game', component: 'game' },
              { type: 'tab', name: 'Console', component: 'console' },
              { type: 'tab', name: 'Assets', component: 'assets' },
            ],
          },
        ],
      },
      {
        type: 'tabset',
        weight: 30,
        children: [
          { type: 'tab', name: 'Inspector', component: 'inspector' },
        ],
      },
    ],
  },
};

// Human-readable labels for the Window menu (built-in name, else custom panel name).
export const PANEL_LABELS: Record<string, string> = {
  scene: 'Scene', game: 'Game', hierarchy: 'Hierarchy', inspector: 'Inspector',
  console: 'Console', assets: 'Assets', 'particle-editor': 'Particle Editor', 'animation-editor': 'Animation', 'timeline-editor': 'Timeline', 'spriteanim-editor': 'Sprite Animation', 'skin-editor': '2D Skin', ai: 'AI', profiler: 'Profiler',
};
/** `customPanels` is injected (rather than imported from `./createEditor`) so this
 *  module doesn't drag the editor back in — the whole point of the move. */
export const panelLabel = (id: string, customPanels: readonly { id: string; name: string }[]): string =>
  PANEL_LABELS[id] ?? customPanels.find((p) => p.id === id)?.name ?? id;

export const LAYOUT_KEY = 'editor-layout';            // localStorage working-state mirror
export const LAYOUT_NAME_KEY = 'editor-layout-name';  // name of the tracked layout
export const AUTODOCK_KEY = 'editor-autodocked-panels'; // openByDefault panel ids already auto-docked once
/** One-shot marker: "the next load must start from the DEFAULT layout".
 *  Why it is a marker rather than a deletion, and how it sits in the restore ladder:
 *  [docs/editor.md](../../../../../../docs/editor.md) § "Shell & layout" (QA-EDITOR-0004). */
export const LAYOUT_RESET_KEY = 'editor-layout-reset';

/** Panel ids this editor has already auto-docked (so an openByDefault panel appears
 *  once, then respects the user closing it). */
export function autoDockedPanels(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(AUTODOCK_KEY) || '[]') as string[]); }
  catch { return new Set(); }
}
export function markAutoDocked(ids: string[]): void {
  const s = autoDockedPanels();
  for (const id of ids) s.add(id);
  try { localStorage.setItem(AUTODOCK_KEY, JSON.stringify([...s])); } catch { /* storage full/blocked */ }
}

export function saveLayout(model: Model) {
  localStorage.setItem(LAYOUT_KEY, JSON.stringify(model.toJson()));
}

export function loadLayout(): IJsonModel | null {
  const json = localStorage.getItem(LAYOUT_KEY);
  if (!json) return null;
  try { return JSON.parse(json); }
  catch { return null; }
}

export function currentLayoutName(): string | null {
  return localStorage.getItem(LAYOUT_NAME_KEY);
}

/** Write raw layout JSON to <project>/.modoki/layouts/<name>.layout.json. */
export async function writeLayoutJson(name: string, content: unknown): Promise<boolean> {
  try {
    const res = await backendFetch('/api/layout', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, content }),
    });
    return res.ok;
  } catch { return false; }
}

/** Write a layout to <project>/.modoki/layouts/<name>.layout.json. */
export function writeLayout(name: string, model: Model): Promise<boolean> {
  return writeLayoutJson(name, model.toJson());
}


/** Download arbitrary layout JSON as a portable `<name>.layout.json` file — the
 *  export counterpart to `LoadLayoutModal`'s "Load from file…" import. Works in
 *  both the Electron and web editors via a plain object-URL anchor click. */
export function downloadLayoutJson(name: string, json: unknown): void {
  const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${sanitizeExportFileName(name)}.layout.json`;
  a.click();
  // Defer the revoke — revoking on the same tick can race the browser's download
  // read of the object URL and drop the file.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Read a saved layout by name, or null if it doesn't exist / fetch failed. */
export async function readLayout(name: string): Promise<IJsonModel | null> {
  try {
    const res = await backendFetch(`/api/layout?name=${encodeURIComponent(name)}`);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

/** Build a Model from stored JSON, or null if missing/malformed — so a corrupt or
 *  stale-format saved layout falls back to the next candidate instead of crashing
 *  the editor on mount (Model.fromJson throws on bad input). Self-heals: the bad
 *  entry is overwritten by the next autosave. */
export function toModel(json: unknown): Model | null {
  if (!json) return null;
  try {
    const m = Model.fromJson(json as IJsonModel);
    normalizeTabTitles(m);
    return m;
  }
  catch (e) { console.warn('[Editor] ignoring invalid saved layout (falling back):', e); return null; }
}

/** Retitle built-in editor tabs to their current PANEL_LABELS value. Tab names are
 *  derived purely from the component (tabs aren't user-renamable), so a persisted
 *  layout can carry a stale title after a panel is renamed (e.g. Skin → 2D Skin).
 *  Only touches known built-ins, leaving custom-panel tabs alone. */
export function normalizeTabTitles(model: Model): void {
  model.visitNodes((node) => {
    if (!(node instanceof TabNode)) return;
    const component = node.getComponent();
    const label = component ? PANEL_LABELS[component] : undefined;
    if (label && node.getName() !== label) {
      model.doAction(Actions.updateNodeAttributes(node.getId(), { name: label }));
    }
  });
}

/** Build the initial layout model: prefer the tracked layout, then the
 *  auto-saved last session, then the localStorage mirror, then the default.
 *  `fromDefault` is true only when nothing was restored — the "first load" signal
 *  that gates openByDefault custom-panel auto-docking (so a panel the user later
 *  closes stays closed on reload). */
export async function loadInitialModel(): Promise<{ model: Model; fromDefault: boolean }> {
  // Consumed FIRST and unconditionally, so a throw further down can't strand the flag and
  // reset every subsequent load.
  if (takeLayoutResetFlag()) return { model: Model.fromJson(defaultLayout), fromDefault: true };
  const tracked = currentLayoutName();
  if (tracked) {
    const m = toModel(await readLayout(tracked));
    if (m) return { model: m, fromDefault: false };
    localStorage.removeItem(LAYOUT_NAME_KEY); // layout is gone/invalid — drop the stale reference
  }
  const autosaved = toModel(await readLayout(AUTOSAVE_NAME));
  if (autosaved) return { model: autosaved, fromDefault: false };
  const mirror = toModel(loadLayout());
  if (mirror) return { model: mirror, fromDefault: false };
  return { model: Model.fromJson(defaultLayout), fromDefault: true };
}

/** Drop the persisted layout so the next load falls through to the default. The
 *  reload that applies it is an untestable side effect and stays in EditorApp. */
export function clearStoredLayout(): void {
  localStorage.removeItem(LAYOUT_KEY);
  localStorage.removeItem(LAYOUT_NAME_KEY);
  // The autosave outranks both keys above on load — see LAYOUT_RESET_KEY.
  try { sessionStorage.setItem(LAYOUT_RESET_KEY, '1'); } catch { /* private mode → best effort */ }
  _resetThisLoad = null; // a newly-armed reset must not be answered from this load's memo
}

/** Whether THIS page load is a reset load — resolved once, from the marker, then remembered.
 *  `null` = not yet asked. */
let _resetThisLoad: boolean | null = null;

/** Is this page load a reset load? Reads and clears the marker on the FIRST call, then answers
 *  from memory for the rest of the load.
 *
 *  The memo is not an optimisation, it is the fix for a defect the first version shipped with
 *  (found by the close-out review). `main.tsx` wraps the app in `<StrictMode>`, so in dev React
 *  mounts, runs effects, tears them down and runs them AGAIN. `EditorApp`'s init effect calls
 *  `loadInitialModel()`, which consults this synchronously — so a read-and-clear consumed the
 *  marker on the first, DISCARDED invocation (`alive = false`), and the second, live one saw
 *  nothing and restored the autosave: Reset Layout silently reverted to the exact pre-fix bug,
 *  deterministically, in every `npm run dev` session. The marker is still cleared on that first
 *  read, so the next real page load restores normally — which is the semantics the name means:
 *  one-shot per LOAD, not per call. */
export function takeLayoutResetFlag(): boolean {
  if (_resetThisLoad === null) {
    try {
      const v = sessionStorage.getItem(LAYOUT_RESET_KEY);
      if (v) sessionStorage.removeItem(LAYOUT_RESET_KEY);
      _resetThisLoad = !!v;
    } catch { _resetThisLoad = false; }
  }
  return _resetThisLoad;
}

/** Test-only: model a fresh PAGE LOAD, which in production is a fresh module instance. */
export function _resetLayoutLoadMemoForTests(): void {
  _resetThisLoad = null;
}

/** One entry in the Load-Layout list: `name` is the layout id used to load it,
 *  `label` is what the user reads. */
export interface LayoutChoice { name: string; label: string }

/** Order the saved-layout list for the Load Layout dialog: the reserved autosave is
 *  PINNED to the top under a friendly label ("Last session (auto-saved)") because it
 *  is the recovery point rather than something the user named; everything else is a
 *  named layout, sorted alphabetically by locale.
 *
 *  Pure, and split out of `LoadLayoutModal`'s fetch callback (#126) so the ordering
 *  rule is testable without mounting the dialog — the label mapping and the pin are
 *  the parts a reader could get wrong, and neither is visible to any other test. */
export function orderLayoutChoices(names: readonly string[]): LayoutChoice[] {
  const autosave = names.filter((n) => n === AUTOSAVE_NAME).map((n) => ({ name: n, label: 'Last session (auto-saved)' }));
  const named = names.filter((n) => n !== AUTOSAVE_NAME).sort((a, b) => a.localeCompare(b)).map((n) => ({ name: n, label: n }));
  return [...autosave, ...named];
}
