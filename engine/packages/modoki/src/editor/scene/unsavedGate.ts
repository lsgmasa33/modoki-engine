/** The HUMAN's unsaved-work gate (#1419) — the twin of the agent ops' `guardUnsaved`
 *  (`app/editor/agentEditorOps.ts`), driven by the same `unsavedChangeCauses()`.
 *
 *  Before this, only the agent entry points asked. `load_scene`/`new_scene` refused unless told
 *  `discardUnsaved:true`, while a human double-clicking a scene in Assets, creating a scene,
 *  leaving prefab edit, switching project or closing the window lost the open scene's edits with no
 *  word — and since #1409 the undo stack went with them, so nothing brought them back. Every human
 *  gesture that replaces the world or unloads the page now awaits `confirmDiscardUnsaved` first.
 *
 *  The owner's call (#1419, confirmed 2026-09-19): a **Save / Discard / Cancel** modal — not a toast with
 *  undo, and not an auto-save. Save saves and proceeds ONLY if the work is actually written (a
 *  cancelled Save As or a failed write keeps the scene open); Discard proceeds; Cancel does nothing.
 *
 *  ⚠️ **Scope decides what counts, and it is derived from the cause table, not listed here.** A
 *  world swap destroys only the causes the SCENE WRITE carries (`writtenBy: 'scene-write'` — the
 *  live primary world and the other loaded scenes); parked asset docs, base-scene refs and import
 *  settings are path-keyed module state that SURVIVES the swap (see `guardUnsaved`'s consequence
 *  clause), so asking about them before a scene open would be a prompt about work nothing is about
 *  to lose — a base-scene ref on the very scene being opened included: the open APPLIES it (#2069). A page unload (project switch, window close, reload) loses every cause. A hand-written
 *  subset here would be #972 again.
 *
 *  The decision (`decideUnsavedGate`) is a pure function over injected deps so it is unit-tested
 *  without an editor (docs/editor.md § Panels); `confirmDiscardUnsaved` binds the real ones. */

import { unsavedChangeCauses, causeSpecs, type UnsavedCauses } from './serialize';
import { openChoiceModal } from '../components/choiceModal';
import { useEditorStore } from '../store/editorStore';
import { undoStepPending } from '../undo/undoManager';
import { isPrefabEditWorld, prefabSessionWorldPath } from './prefabEditWorld';

/** What the gesture is about to destroy: the live world only, or everything in the page. */
export type UnsavedScope = 'world-swap' | 'page-unload';

export type GateChoice = 'save' | 'discard' | 'cancel';

type SpecView = Readonly<Record<string, { writtenBy: unknown; keying: string; label: { bool?: string; noun?: string } }>>;

/** At most this many paths are named per cause; the rest are counted. The modal is read in one
 *  glance, and a Save All writes them all regardless of how many are shown. */
const MAX_NAMED = 3;

/** The work `scope` would destroy, one human phrase per active cause — empty when there is none.
 *  Enumerated from the cause TABLE, so a sixth cause is named here the day it is added.
 *
 *  `editingPrefab` names the prefab when the live world is a prefab-edit world (`''` for one with no name to give).
 *  There the live world's edits (`sceneDirty`) are the PREFAB's, so they are named as Unity's Prefab Mode names them
 *  ("Prefab 'X' has been modified"); the table's "unsaved scene changes" named the scene, which the open had already
 *  saved. The other causes keep their own words, so the scene is named only when a scene is what is unsaved. */
export function describeLostWork(
  causes: UnsavedCauses,
  scope: UnsavedScope,
  editingPrefab: string | null = null,
  specs: SpecView = causeSpecs() as SpecView,
): string[] {
  const out: string[] = [];
  for (const [key, spec] of Object.entries(specs)) {
    if (scope === 'world-swap' && spec.writtenBy !== 'scene-write') continue;
    const v = (causes as Record<string, boolean | string[]>)[key];
    if (Array.isArray(v)) {
      if (v.length === 0) continue;
      const noun = spec.label.noun ?? key;
      const phrase = `${v.length} ${noun}${v.length === 1 ? '' : 's'}`;
      // A GUID means nothing to the reader; only path-keyed causes are worth naming.
      if (spec.keying !== 'path') { out.push(phrase); continue; }
      const named = v.slice(0, MAX_NAMED).join(', ');
      out.push(`${phrase}: ${named}${v.length > MAX_NAMED ? `, +${v.length - MAX_NAMED} more` : ''}`);
    } else if (v) {
      out.push((key === 'sceneDirty' ? prefabEditsPhrase(editingPrefab) : null) ?? spec.label.bool ?? key);
    }
  }
  return out;
}

/** The phrase for the live world's edits (`sceneDirty`) when that world is a prefab-edit world — `editingPrefab` as
 *  {@link describeLostWork} takes it — or null for a scene, whose edits keep the cause table's "unsaved scene changes".
 *  The one author of this wording: the HMR reload banner (`app/debug/hmrStaleness.ts`) reads it through the editor
 *  barrel, so a prefab edit is named the same way wherever its loss is announced. */
export function prefabEditsPhrase(editingPrefab: string | null): string | null {
  if (editingPrefab === null) return null;
  return editingPrefab ? `unsaved changes to prefab "${editingPrefab}"` : 'unsaved changes to the prefab being edited';
}

export interface UnsavedGateDeps {
  causes: () => UnsavedCauses;
  ask: (action: string, lost: string[], scope: UnsavedScope) => Promise<GateChoice>;
  /** Save everything. Its own outcome is reported by the dep (a toast); the gate trusts only the
   *  causes it re-reads afterwards. */
  save: () => Promise<unknown>;
  warn: (message: string) => void;
  /** The prefab being edited when the live world is a prefab-edit world, else null — see `describeLostWork`. */
  editingPrefab?: () => string | null;
}

/** Proceed with `action`? True when nothing `scope` destroys is unsaved, when the human chose
 *  Discard, or when they chose Save and the save left nothing behind. */
export async function decideUnsavedGate(action: string, scope: UnsavedScope, deps: UnsavedGateDeps): Promise<boolean> {
  const lost = describeLostWork(deps.causes(), scope, deps.editingPrefab?.() ?? null);
  if (lost.length === 0) return true;
  const choice = await deps.ask(action, lost, scope);
  if (choice === 'discard') return true;
  if (choice === 'cancel') return false;
  try {
    await deps.save();
  } catch (e) {
    // Stay: the work is not known to be written. Reported rather than rethrown — every caller is
    // a `void` gesture handler, where a rejection is an unhandled error the human never sees.
    deps.warn(`Not ${action}: Save failed — ${e instanceof Error ? e.message : String(e)}.`);
    return false;
  }
  // Re-read, never trust the save's own verdict: a cancelled Save As on an untitled scene, a
  // failed write, or a partial Save All all return without throwing.
  const still = describeLostWork(deps.causes(), scope, deps.editingPrefab?.() ?? null);
  if (still.length === 0) return true;
  deps.warn(`Not ${action}: still unsaved after Save — ${still.join('; ')}.`);
  return false;
}

/** What `describeLostWork` calls the live world's edits by: the prefab-edit session's name when the live world is THAT
 *  session's (`prefabSessionWorldPath`: a stale store flag can outlive its world, and a world can outlive its session),
 *  its file name when it has no name, `''` for a prefab world with no session (an exit whose return reload failed),
 *  and null for a scene. */
export function editingPrefabName(): string | null {
  const session = useEditorStore.getState().editingPrefab;
  if (prefabSessionWorldPath(session) !== null) return session!.name || session!.path.split('/').pop() || '';
  return isPrefabEditWorld() ? '' : null;
}

const DEFAULT_DEPS: UnsavedGateDeps = {
  causes: unsavedChangeCauses,
  editingPrefab: editingPrefabName,
  ask: (action, lost) => openChoiceModal<GateChoice>({
    kind: 'unsaved-gate',
    title: 'Save changes first?',
    message: `You are about to ${action}. This is not saved and will be lost:`,
    details: lost,
    choices: [
      { value: 'discard', label: 'Discard', tone: 'danger' },
      { value: 'cancel', label: 'Cancel' },
      { value: 'save', label: 'Save', tone: 'primary' },
    ],
    cancelValue: 'cancel',
    // Save is the safe answer to Enter: it loses nothing, and a failed save proceeds nowhere.
    focus: 'save',
  }),
  save: async () => {
    // Dynamic: saveCommand imports prefabEdit, which imports this module — a static import would
    // close that cycle.
    const { runSaveAll, toastForSave } = await import('./saveCommand');
    const o = await runSaveAll();
    const { text, kind } = toastForSave(o);
    useEditorStore.getState().showToast(text, kind);
  },
  warn: (message) => {
    console.warn(`[Editor] ${message}`);
    useEditorStore.getState().showToast(message, 'warn');
  },
};

/** Build (or publish) with unsaved work? (#1868, hub call c) A build reads the FILES, so nothing unsaved is in it — an
 *  undone Apply parked in memory included, whose file still holds the applied prefab until Save. Nothing unsaved: true.
 *  Otherwise the human is shown every cause and chooses; `ask` answers true for "go ahead anyway". Save is not offered
 *  here: it can open a Save As dialog, and the build would then run behind it on whatever the human picked. */
export async function decideUnsavedBeforeBuild(
  action: string,
  causes: () => UnsavedCauses,
  ask: (action: string, lost: string[]) => Promise<boolean>,
  editingPrefab: string | null = null,
): Promise<boolean> {
  const lost = describeLostWork(causes(), 'page-unload', editingPrefab);
  return lost.length === 0 || ask(action, lost);
}

/** The human Build menu's and the OTA dialog's gate — {@link decideUnsavedBeforeBuild} with the editor's modal. `action`
 *  completes "You are about to …" (e.g. `build for ios`). */
export function confirmUnsavedBeforeBuild(action: string): Promise<boolean> {
  return decideUnsavedBeforeBuild(action, unsavedChangeCauses, async (act, lost) => (await openChoiceModal<'build' | 'cancel'>({
    kind: 'unsaved-gate',
    title: 'Unsaved changes',
    message: `You are about to ${act}. The build reads the files on disk, so this is not saved and will not be in it:`,
    details: lost,
    choices: [
      { value: 'cancel', label: 'Cancel' },
      { value: 'build', label: 'Build anyway', tone: 'danger' },
    ],
    cancelValue: 'cancel',
    focus: 'cancel',
  })) === 'build', editingPrefabName());
}

let _open: Promise<boolean> | null = null;

/** The gate every human world-replacing or page-unloading gesture awaits. `action` completes the
 *  sentence "You are about to …" (e.g. `open scene Level-2`).
 *
 *  One prompt at a time: a second request while one is open is REFUSED (answers false) — it is not
 *  queued. A window close arriving while an Assets open is being asked about is dropped, and the
 *  human repeats it after answering the modal on screen; asking twice would stack two modals over
 *  one decision. */
export function confirmDiscardUnsaved(action: string, scope: UnsavedScope, deps: UnsavedGateDeps = DEFAULT_DEPS): Promise<boolean> {
  if (_open) return Promise.resolve(false);
  // A world swap asks once the undo in flight has landed (#1579): its dirty mark comes at its end, and the swap waits
  // for it anyway — asked before, "clean" let the swap discard that scene's history with no prompt. Not for a page
  // unload, which must not hang on a step that never settles.
  const pending = scope === 'world-swap' ? undoStepPending() : null;
  const decided = pending ? pending.then(() => decideUnsavedGate(action, scope, deps)) : decideUnsavedGate(action, scope, deps);
  const p = decided.finally(() => { if (_open === p) _open = null; });
  _open = p;
  return p;
}

/** The renderer's answer to Electron main's `unsaved-gate` request (a window close, a quit, a
 *  project switch, a reload — `electron/unsavedGateClient.ts`). ACK first, before anything can
 *  block: main reads a missing ack as a hung renderer and proceeds, so the ack is what earns the
 *  human unlimited time over the modal. A gate that throws keeps the window (`proceed:false`) —
 *  losing work to a bug is worse than a close that has to be retried. */
export async function answerUnsavedGateRequest(
  req: unknown,
  reply: (data: { id: number; stage: 'ack' | 'final'; proceed?: boolean }) => void,
  confirm: (action: string, scope: UnsavedScope) => Promise<boolean> = confirmDiscardUnsaved,
): Promise<void> {
  const { id, action } = (req ?? {}) as { id?: unknown; action?: unknown };
  if (typeof id !== 'number') return;
  reply({ id, stage: 'ack' });
  let proceed = false;
  try {
    proceed = await confirm(typeof action === 'string' ? action : 'close the editor', 'page-unload');
  } catch (e) {
    console.error('[Editor] unsaved-work gate failed:', e);
  }
  reply({ id, stage: 'final', proceed });
}
