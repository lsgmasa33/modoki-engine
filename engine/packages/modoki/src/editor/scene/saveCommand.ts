/** The ONE "Save All" command, and the message it reports — shared by the `app.saveAll` keymap
 *  handler and the native File → Save All menu item.
 *
 *  WHY IT IS A MODULE. Those two entry points live 360 lines apart in `EditorApp.tsx` and had
 *  already drifted once: the keymap handler was fixed to report a failed prefab save and the menu
 *  twin was missed, so the same command told the user different things depending on how they
 *  invoked it. The file's own comment flags that as the hazard of two entry points for one
 *  command. #259 makes the outcome strictly harder to phrase — a save can now half-succeed, with
 *  the asset docs written and the SCENE refused — so the mapping from outcome to sentence is
 *  exactly the logic that must not be duplicated, and exactly the logic a `.tsx` panel cannot
 *  carry a test for (CLAUDE.md: editor `.ts` carries tests, `.tsx` does not).
 *
 *  `toastForSave` is pure over `SaveOutcome` — it reads no globals, so the run-mode context it
 *  needs is captured INTO the outcome by `runSaveAll` rather than sampled later. */

import { saveAll, unsavedChangeCauses, type SaveResult } from './serialize';
import { flushDirtyAssets, type FlushResult } from './dirtyAssets';
import { isEditingPrefab, savePrefabEdit } from './prefabEdit';
import { getRunMode, canEdit, type RunMode } from '../../runtime/core/playState';
import {
  hasTimelinePreviewSession, getPreviewSaveHandler, previewHasAuthoredEdits,
  resumeHandlerFor,
} from './timelinePreview';
import { getModeOwner } from './playMode';

export interface SaveOutcome {
  /** Parked asset docs written by this save. ALWAYS attempted, whatever the scene half does. */
  assets: FlushResult;
  /** Which half the scene-shaped save targeted. `'assets'` = only parked asset docs were written:
   *  a preview envelope was open and the scene had nothing to write, so interrupting the preview
   *  would have bought churn and a flicker for no content. */
  target: 'scene' | 'prefab' | 'assets';
  /** `target:'scene'` — the full scene result (absent for a prefab save). */
  scene?: SaveResult;
  /** `target:'prefab'` — did the prefab write land? */
  prefabSaved?: boolean;
  /** `target:'prefab'` — the write was REFUSED by the run-mode guard, not attempted and failed.
   *  Different sentences for the human: one is "exit preview", the other is "look at the console". */
  prefabRefused?: boolean;
  /** Run mode + the panel owning it, captured at the moment a scene save was refused for it. */
  mode?: { runMode: RunMode; owner: string | null };
  /** The preview envelope was put down for this save and picked back up afterwards. */
  previewCycled?: boolean;
  /** …and whether the pick-back-up actually happened. False when the owning panel closed or handed
   *  the envelope over mid-save: the save is fine, but the human's preview is gone and only the
   *  toast can tell them. */
  previewResumed?: boolean;
  /** The envelope was NOT cycled because the scene was edited inside it — exiting would have
   *  reverted those edits, and a save must not destroy work to make itself possible. */
  previewHoldsEdits?: boolean;
}

/** Does the SCENE half of a save have anything to write? Used only to decide whether a save is
 *  worth interrupting a preview for — see `runSaveAll`. Pure over the unsaved-work causes, so the
 *  decision is testable without an editor.
 *
 *  `dirtyScenes` counts too: `saveAll` writes dirty BASE scenes after the primary, and skipping the
 *  scene half would strand them exactly the way the pre-#259 flush was stranded. */
export function sceneNeedsWriting(
  causes: { sceneDirty: boolean; dirtyScenes: string[] } = unsavedChangeCauses(),
): boolean {
  return causes.sceneDirty || causes.dirtyScenes.length > 0;
}

/**
 * Run Save All: flush every parked asset doc, then save the scene (or the open prefab).
 *
 * The asset flush is NOT conditional on the scene half. That is the whole of #259's step 2: a
 * prefab-edit world never reaches `saveAll` at all, and `saveScene` refuses outright while
 * scrub/preview/play is live — so with the panels parking instead of autosaving, gating the flush
 * on either would mean a human pressing Cmd+S in those states and having no way to save what they
 * just authored.
 */
/** One save at a time. Both Cmd+S entry points are `void runSaveAll()`, so a second press during a
 *  cycle started a second save while the first was mid-suspend — a window where the session is
 *  already cleared and run-mode already 'stopped' while the world is still POSED, so the second
 *  save takes the no-preview path and serializes the pose. Coalescing onto the in-flight promise
 *  also stops two toasts claiming one write. */
let _inFlight: Promise<SaveOutcome> | null = null;

export function runSaveAll(): Promise<SaveOutcome> {
  if (_inFlight) return _inFlight;
  _inFlight = runSaveAllOnce().finally(() => { _inFlight = null; });
  return _inFlight;
}

async function runSaveAllOnce(): Promise<SaveOutcome> {
  // ── Inside a preview envelope: put it down, save, pick it back up ──
  // A scene/prefab write must contain AUTHORED data, and the envelope's whole point is that the
  // live world is posed. Refusing was the old answer and it cost two keystrokes every time; simply
  // exiting would snap the animator's frame away. So the owner's call: exit → save → resume at the
  // same playhead (`PreviewSaveHandler`).
  //
  // ⚠️ Only when the save actually needs a stopped world. A clip edit dirties no scene, so an
  // unconditional cycle would reload the world and rewrite the scene file on EVERY Cmd+S while
  // animating — a flicker plus real churn (the serializer reorders entities) in exchange for
  // nothing. When there is nothing to write, the scene half is skipped instead and only the parked
  // asset docs are flushed, which is the common case while authoring a clip.
  const preview = hasTimelinePreviewSession() ? getPreviewSaveHandler() : null;
  const needsAuthoredWorld = isEditingPrefab() || sceneNeedsWriting();
  if (preview && !needsAuthoredWorld) {
    return { assets: await flushDirtyAssets(), target: 'assets' };
  }
  if (preview && previewHasAuthoredEdits()) {
    // ⚠️ DO NOT cycle here. Exiting restores the snapshot taken when the preview began, which would
    // revert every authored change made since — and this path is reached by pressing SAVE. A save
    // that silently destroys work to make itself possible is worse than the refusal it replaced, so
    // fall through to the normal refusal and let the toast say what is actually in the way.
    // (Measured while building this: a set_transform made during a scrub was reverted and the
    // pre-edit world written, reporting success.)
    const out = await runSaveTargets();
    return { ...out, previewHoldsEdits: true };
  }
  if (preview) {
    const owner = preview.owner;
    try {
      // MUST be awaited: the restore rebuilds the world, and the save serializes it a line later.
      // Inside the try, because a restore that REJECTS (a failed scene load, a throwing rebind)
      // otherwise leaves the world posed, the session cleared and run-mode 'stopped' — the state in
      // which the NEXT Cmd+S bakes the pose and reports success — while the exception escapes into
      // a `.then()` with no `.catch()`, so nothing is reported at all.
      await preview.suspend();
      const out = await runSaveTargets();
      // Resume through the CURRENT registration when there is one (see
      // `currentPreviewSaveHandlerFor` — a rebind REPLACES the handler mid-cycle), and fall back to
      // the one we started with when the owner panel DEREGISTERED instead.
      //
      // ⚠️ That second case is not hypothetical, it was the normal path for the Timeline panel:
      // its registration effect bails while the run-mode is 'stopped', and `suspend()` is what
      // sets the run-mode to 'stopped'. So the suspend deleted the registration it was about to
      // need, `resumed` was always null, and every Cmd+S ended the human's scrub session while
      // reporting a clean save (bug `tSv0EWjWICpEl9HSjRe9`). The fallback is only safe because
      // both panels' handlers now dispatch through a ref, so the captured object calls the
      // FRESHLY-REBOUND closures rather than the dead ones this comment's sibling warns about
      // (`poseRef` in AnimationEditor, `previewHooks` in TimelineEditor).
      const resumed = resumeHandlerFor(owner, preview);
      resumed?.resume();
      return { ...out, previewCycled: true, previewResumed: !!resumed };
    } catch (e) {
      resumeHandlerFor(owner, preview)?.resume();
      throw e;
    }
  }
  return runSaveTargets();
}

/** The save itself, with the world already in whatever state it should be written from. */
async function runSaveTargets(): Promise<SaveOutcome> {
  // Prefab-edit: the live world is a synthetic prefab scene, so `saveAll` would refuse it
  // ('prefab-edit') and the panel's own save is the right one. Flush the parked docs here, since
  // this branch never reaches `saveAll`'s own flush.
  if (isEditingPrefab()) {
    const assets = await flushDirtyAssets();
    // `savePrefabEdit` owns the run-mode refusal itself (so the agent path inherits it too); this
    // reads the same condition ONLY to phrase the message — a bare `false` cannot tell "refused
    // because you are scrubbing" from "the prefab root was not found", and those need different
    // sentences. Deliberate duplication: do not "simplify" it by deleting the guard down there.
    const refused = !canEdit();
    const mode = { runMode: getRunMode(), owner: getModeOwner() };
    const prefabSaved = await savePrefabEdit();
    return { assets, target: 'prefab', prefabSaved, ...(refused ? { prefabRefused: true, mode } : {}) };
  }
  const scene = await saveAll({ allowDialog: true });
  return {
    assets: scene.assets ?? { saved: [], failed: [] },
    target: 'scene',
    scene,
    // Sampled here, not in the toast: by the time a message renders the user may already have
    // exited preview, and a message that names the wrong mode sends them hunting for a control
    // that is no longer there.
    ...(scene.reason === 'playing' ? { mode: { runMode: getRunMode(), owner: getModeOwner() } } : {}),
  };
}

/** How to say what just happened. NEVER claims a save that did not land (C7), and never reports a
 *  bare failure over asset docs that DID land — both halves have to be in the sentence. */
export function toastForSave(o: SaveOutcome): { text: string; kind: 'success' | 'warn' | 'info' } {
  const n = o.assets.saved.length;
  const assetPhrase = n === 1 ? '1 asset saved' : `${n} assets saved`;
  const assetFails = o.assets.failed;

  // A failed asset write is reported first and always: it is pending work that stayed pending,
  // and the file it belongs to is named so the human knows which edit is still only in memory.
  const failSuffix = assetFails.length
    ? ` — ${assetFails.length} asset write(s) FAILED and are still unsaved: ${assetFails.map((f) => f.path).join(', ')}`
    : '';
  // A failed write is a WARNING in every branch, including the ones whose own outcome is benign.
  // A cancelled Save-As over a failed asset write was reporting 'info', so the sentence said FAILED
  // in a colour that says "nothing to see" — and colour is what gets read.
  const worst = (k: 'success' | 'warn' | 'info') => (assetFails.length ? 'warn' : k);

  if (o.target === 'assets') {
    // No scene half to report. Silence about it is the point: while authoring a clip the scene is
    // untouched, so "the SCENE was not saved" would be a warning about a non-event.
    return n
      ? { text: `${assetPhrase}${failSuffix}`, kind: worst('success') }
      : { text: `Nothing to save${failSuffix}`, kind: worst('info') };
  }

  if (o.target === 'prefab') {
    if (o.prefabRefused) {
      // Same reasoning as the scene branch: if the envelope holds authored scene edits, "press ⏹
      // Exit Preview" is advice that REVERTS them, so it must not be what we say.
      const why = o.previewHoldsEdits
        ? 'the scene was CHANGED while previewing, and exiting preview reverts those changes — undo them, or exit and re-apply them, then save.'
        : whyBlocked(o.mode);
      return { text: `${n ? `${assetPhrase} — but the PREFAB was not saved: ` : 'The prefab was not saved: '}${why}${failSuffix}`, kind: 'warn' };
    }
    if (!o.prefabSaved) {
      return { text: `Prefab save FAILED — nothing written to disk (see console)${n ? `. ${assetPhrase}.` : ''}${failSuffix}`, kind: 'warn' };
    }
    return {
      text: `Prefab saved${n ? ` · ${assetPhrase}` : ''}${failSuffix}`,
      kind: worst('success'),
    };
  }

  const r = o.scene!;
  if (r.saved) {
    // A cycle whose resume did not land ended the human's preview. The save is fine; saying nothing
    // would leave them wondering where their frame went.
    const lostPreview = o.previewCycled && !o.previewResumed ? ' · preview ended' : '';
    return {
      text: `Scene saved${n ? ` · ${assetPhrase}` : ''}${lostPreview}${failSuffix}`,
      kind: worst('success'),
    };
  }

  // The scene did not save. Say what DID, then why it did not — in that order, because the first
  // half is the part the human cannot otherwise find out.
  const savedPart = n ? `${assetPhrase} — but the SCENE was not saved: ` : '';

  if (r.reason === 'cancelled') {
    return n
      ? { text: `${assetPhrase} — the scene save was cancelled, nothing written for it${failSuffix}`, kind: worst('info') }
      : { text: `Save cancelled — nothing written${failSuffix}`, kind: worst('info') };
  }
  if (r.reason === 'playing') {
    // The scene edits are the reason we did not just exit for them, so the message has to name
    // them — "exit preview" alone would be advice that quietly reverts the very work they mean.
    const why = o.previewHoldsEdits
      ? 'the scene was CHANGED while previewing, and exiting preview reverts those changes — undo them, or exit and re-apply them, then save.'
      : whyBlocked(o.mode);
    return { text: `${savedPart || 'The scene was not saved: '}${why}${failSuffix}`, kind: 'warn' };
  }
  if (r.reason === 'prefab-edit') {
    return { text: `${savedPart}this is a prefab-edit world — re-open the prefab to save it${failSuffix}`, kind: 'warn' };
  }
  return {
    text: savedPart
      ? `${assetPhrase} — but the SCENE was not saved (${r.reason})${failSuffix}`
      : `Save FAILED (${r.reason}) — nothing written to disk${failSuffix}`,
    kind: 'warn',
  };
}

/** Why a write is blocked by the run mode, and how to get out of it. Shared by the scene and
 *  prefab branches — the same block, so the same sentence.
 *
 *  Name the panel that actually owns the mode: BOTH the Timeline and the Animation panel drive it,
 *  and a hardcoded "timeline" sent Animation users hunting for a control in the wrong window (which
 *  is also why the Animation panel has its own ⏹ Exit Preview). */
function whyBlocked(mode: SaveOutcome['mode']): string {
  const who = mode?.owner === 'animation' ? 'Animation' : 'Timeline';
  const m = mode?.runMode;
  return m === 'scrub' || m === 'preview'
    ? `exit ${m} to save it — press ⏹ Exit Preview in the ${who} panel (poses revert on exit).`
    : 'stop the game to save it — saving during Play would bake the runtime world over your authored data.';
}
