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

import {
  saveAll, unsavedChangeCauses, causeSpecs, flushParked,
  type SaveResult, type UnsavedCauses,
} from './serialize';
import { type FlushResult, flushDirtyAssets, overwriteParkedAsset, peekDirtyAsset } from './dirtyAssets';
import { type MetaFlushResult } from './pendingMeta';
import { isEditingPrefab, savePrefabEditReport } from './prefabEdit';
import { getRunMode, canEdit, type RunMode } from '../../runtime/core/playState';
import {
  hasTimelinePreviewSession, getPreviewSaveHandler, previewHasAuthoredEdits, whenPreviewRestoresLanded,
  resumeHandlerFor,
} from './timelinePreview';
import { getModeOwner } from './playMode';
import { beginWorldReplacement } from './authoringSettle';
import { runSerialisedSave } from './saveQueue';

export interface SaveOutcome {
  /** Parked asset docs written by this save. ALWAYS attempted, whatever the scene half does. */
  assets: FlushResult;
  /** Pending `baseScene` refs written by this save (#831), if any were.
   *
   *  A SEPARATE field rather than folded into `assets`, because they fail for different reasons
   *  and a caller acting on the failure needs to know which: an asset write is retried by saving
   *  again, while a refused `setBaseScene` means the route's own unsaved-work or run-mode guard
   *  turned it down. `toastForSave` still names both in one sentence — the human wants ONE answer
   *  to "did my work save", not a taxonomy. */
  baseScenes?: { saved: string[]; failed: Array<{ path: string; error: string }> };
  /** Parked `.meta.json` import-settings edits (Inspector, #845) written by this save, if any.
   *
   *  ALWAYS attempted, same as `assets` — `/api/write-meta` carries no unsaved-work refusal, so
   *  there is no branch of `runSaveAllOnce` that skips it. A separate field rather than folded
   *  into `assets`, for the same reason `baseScenes` is: a sidecar is not an `ASSET_SCHEMA_TYPES`
   *  document. */
  importSettings?: MetaFlushResult;
  /** Which half the scene-shaped save targeted. `'assets'` = only parked asset docs were written:
   *  a preview envelope was open and the scene had nothing to write, so interrupting the preview
   *  would have bought churn and a flicker for no content. */
  target: 'scene' | 'prefab' | 'assets';
  /** `target:'scene'` — the full scene result (absent for a prefab save). */
  scene?: SaveResult;
  /** `target:'prefab'` — did the prefab write land? */
  prefabSaved?: boolean;
  /** Why the prefab save failed, when the backend said (#1468) — e.g. the format gate's refusal.
   *  Empty when it failed for a reason that never reached this side. */
  prefabFailReason?: string;
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
export function sceneNeedsWriting(causes: UnsavedCauses = unsavedChangeCauses()): boolean {
  // Derived from the table's `writtenBy`, not a hand-picked pair (#972 P3). The parameter used to
  // be typed `{ sceneDirty: boolean; dirtyScenes: string[] }` — a structural subtype of the real
  // causes object, so it accepted the full value while checking two of its five fields and a sixth
  // cause would have compiled green here forever. It is now the whole type, so a cause can only be
  // left out of this answer by declaring itself not scene-written.
  for (const [key, spec] of Object.entries(causeSpecs())) {
    if (spec.writtenBy !== 'scene-write') continue;
    const v = causes[key as keyof UnsavedCauses];
    if (Array.isArray(v) ? v.length > 0 : v) return true;
  }
  return false;
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
  // Queued behind any other save (an agent's `save-all`, a Create Scene — #2069); the conflict questions after it are
  // not, since they wait on a human and flush only asset docs.
  _inFlight = runSerialisedSave(runSaveAllOnce)
    .then(async (o) => ({ ...o, assets: await answerParkedConflicts(o.assets) }))
    .finally(() => { _inFlight = null; });
  return _inFlight;
}

/** Overwrite or Cancel, for one parked document whose file changed on disk since it was parked. */
async function askOverwrite(path: string): Promise<boolean> {
  // Dynamic, like the prefab-edit save's own question below: the modal is DOM, and this module is not.
  return (await import('../utils/saveDialog')).confirmInEditor(
    `${path.split('/').pop() ?? path} changed on disk`,
    `${path} changed on disk since your unsaved edit to it was made (a save from somewhere else, an outside edit or a git pull). Overwrite it with your edit, or cancel and keep the file as it is? Your edit stays unsaved if you cancel.`,
    'Overwrite',
  );
}

/** The human's answer to each parked document the save refused as a CONFLICT (#1868, hub call b): the file changed on
 *  disk since the edit was parked, so it was not written. Each one is asked about — Overwrite writes it over whatever the
 *  file holds now, Cancel leaves it parked and unsaved. Never written without the answer: a silent overwrite is what the
 *  precondition exists to stop. Returns the flush result the toast reports, with the overwritten ones moved to `saved`. */
export async function answerParkedConflicts(
  assets: FlushResult,
  ask: (path: string) => Promise<boolean> = askOverwrite,
  reflush: () => Promise<FlushResult> = flushDirtyAssets,
): Promise<FlushResult> {
  // A conflict whose document is no longer parked was settled another way before this asked — the prefab-edit save's
  // own Overwrite wrote it (close-out review F4) — so it is neither asked about nor reported as unsaved.
  const settled = new Set(assets.failed.filter((f) => f.conflict && !peekDirtyAsset(f.path)).map((f) => f.path));
  if (settled.size) assets = { saved: assets.saved, failed: assets.failed.filter((f) => !settled.has(f.path)) };
  let chose = false;
  for (const f of assets.failed) if (f.conflict && await ask(f.path) && overwriteParkedAsset(f.path)) chose = true;
  if (!chose) return assets;
  // Everything still parked goes again — the overwritten ones, and a cancelled conflict, which refuses again unasked.
  const again = await reflush();
  return { saved: [...assets.saved, ...again.saved.filter((p) => !assets.saved.includes(p))], failed: again.failed };
}

async function runSaveAllOnce(): Promise<SaveOutcome> {
  // A preview restore still landing: ⏹ Exit has already cleared the session and set 'stopped', so
  // every check below would pass while the world is still POSED, and the scene write would bake the
  // pose (#1167 review). Wait for the swap rather than refuse — the save is then of the authored world.
  await whenPreviewRestoresLanded();
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
    // ⚠️ EVERY parked flush, derived from the cause table — not a hand-picked pair (#972 P12).
    // This branch used to name `flushDirtyAssets` and `flushPendingMeta` and stop there, so a
    // session with a preview live and ONLY a parked base-scene ref took this path, got
    // `{target:'assets'}` reporting success, and the ref was never written. Its gate could not
    // see the cause either — `sceneNeedsWriting()` read two of the five.
    // Both phases run here even though no scene is written: this branch IS the whole save, so
    // `after-scene` work has nothing else to run behind. The phase names describe an ORDER, and
    // that order still holds — there is simply no scene write between them. The base-scene route
    // does not refuse here: the branch condition guarantees `sceneDirty` false and `dirtyScenes`
    // empty, so the unsaved-work report it gates on is already clear of live-world edits.
    const { dirtyAssetPaths: assets, pendingImportSettings: importSettings } = await flushParked('before-scene');
    const { pendingBaseScenes: baseScenes } = await flushParked('after-scene');
    return {
      assets,
      ...(importSettings.saved.length || importSettings.failed.length ? { importSettings } : {}),
      ...(baseScenes.saved.length || baseScenes.failed.length ? { baseScenes } : {}),
      target: 'assets',
    };
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
    // #1164 review: the suspend returns the run mode to 'stopped', which would settle authoring and
    // start a deferred hot-reload replay in the middle of this save — the replay loads the external
    // bytes into the world while the save writes the pre-change world over the file, and the resume's
    // new snapshot races the replay's load. Held across suspend → save → resume, the token keeps a
    // change deferred until the envelope that resumes finally exits (or, if nothing resumes, until
    // this releases with the mode stopped). Both resume handlers re-enter scrub synchronously.
    const releaseReplacement = beginWorldReplacement();
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
    } finally {
      releaseReplacement();
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
    // Derived from the cause table, like every other save site (#972 P12). This branch never
    // reaches `saveAll`'s own flush, so it must run the phases itself.
    const { dirtyAssetPaths: assets, pendingImportSettings: importSettings } = await flushParked('before-scene');
    // `savePrefabEdit` owns the run-mode refusal itself (so the agent path inherits it too); this
    // reads the same condition ONLY to phrase the message — a bare `false` cannot tell "refused
    // because you are scrubbing" from "the prefab root was not found", and those need different
    // sentences. Deliberate duplication: do not "simplify" it by deleting the guard down there.
    const refused = !canEdit();
    const mode = { runMode: getRunMode(), owner: getModeOwner() };
    // ⚠️ The REPORT form, not the boolean (#1468 close-out review R2). Under the format gate a save
    // can fail for a reason only the human can act on — "this file was written by a newer build" —
    // and the boolean throws it away, leaving a toast that says to check a console the reason may
    // not even be in (the server logs it to the DEV-SERVER terminal). `savePrefabEditReport` returns
    // it in `warnings` on a failure; the notice below names it.
    // A file changed on disk under the open edit is replaced only when the human says so (#1692) — Cancel leaves it,
    // and the edit stays open and unsaved, so Exit's Save leaves nothing behind to discard.
    const prefabReport = await savePrefabEditReport({
      // Dynamic, like the unsaved gate's own import of this module: the modal is DOM, and this module is not.
      confirmOverwrite: async (name, path) => (await import('../utils/saveDialog')).confirmInEditor(
        `"${name}" changed on disk`,
        `${path} changed on disk since you opened it here (a save from somewhere else, an outside edit or a git pull). Overwrite it with this edit, or cancel and keep the file as it is? Your edit stays open either way.`,
        'Overwrite',
      ),
    });
    const prefabSaved = prefabReport.saved;
    // …and the pending base-scene refs, for the same #259 reason this branch already flushes
    // parked asset docs: a `baseScene` set on a scene the editor never loaded has nothing to do
    // with which world is open, and Cmd+S doing nothing for it is "the human pressed save and
    // their edit did not save". AFTER `savePrefabEdit`, not before: `/api/scene-mutate` refuses
    // while the editor reports unsaved work, and the prefab world's own edits are exactly that —
    // running it first would refuse every ref against the save that is trying to persist it. Same
    // ordering rule as `saveAll`'s, for the same reason.
    const { pendingBaseScenes: baseScenes } = await flushParked('after-scene');
    return {
      assets, target: 'prefab', prefabSaved, prefabFailReason: prefabSaved ? undefined : prefabReport.warnings.join('; '),
      ...(baseScenes.saved.length || baseScenes.failed.length ? { baseScenes } : {}),
      ...(importSettings.saved.length || importSettings.failed.length ? { importSettings } : {}),
      ...(refused ? { prefabRefused: true, mode } : {}),
    };
  }
  const scene = await saveAll({ allowDialog: true });
  return {
    assets: scene.assets ?? { saved: [], failed: [] },
    ...(scene.baseScenes ? { baseScenes: scene.baseScenes } : {}),
    ...(scene.importSettings ? { importSettings: scene.importSettings } : {}),
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
  // ⚠️ Every KIND of successful write, not just asset docs (#972 close-out review). `n` counts
  // `assets.saved` alone, and the failure suffix below already names base-scene and
  // import-settings FAILURES — so their SUCCESSES were the one outcome nothing reported. After
  // #972 P12 that became a lie the human acts on: a Cmd+S under a timeline preview that writes
  // only a parked base-scene ref took the `target:'assets'` branch, wrote the ref correctly, and
  // toasted "Nothing to save". The `runSaveAll` test covering that path is even titled "so the
  // toast can name them" while asserting only the outcome field.
  //
  // Separate nouns, for the same reason the failure clauses use separate nouns: "asset" names an
  // ASSET_SCHEMA_TYPES document, and a human told "1 asset saved" for a `.meta.json` sidecar or a
  // one-field scene mutation looks in the wrong panel.
  const savedParts: string[] = [];
  if (n) savedParts.push(n === 1 ? '1 asset saved' : `${n} assets saved`);
  const baseSaved = o.baseScenes?.saved.length ?? 0;
  if (baseSaved) savedParts.push(baseSaved === 1 ? '1 base-scene ref saved' : `${baseSaved} base-scene refs saved`);
  const metaSaved = o.importSettings?.saved.length ?? 0;
  if (metaSaved) savedParts.push(metaSaved === 1 ? '1 import-setting edit saved' : `${metaSaved} import-setting edits saved`);
  const assetPhrase = savedParts.join(', ');
  const savedAny = savedParts.length > 0;
  const assetFails = o.assets.failed;

  // A failed asset write is reported first and always: it is pending work that stayed pending,
  // and the file it belongs to is named so the human knows which edit is still only in memory.
  const baseFails = o.baseScenes?.failed ?? [];
  const metaFails = o.importSettings?.failed ?? [];
  // Split by REMEDY, not by severity: a conflict must not be retried blindly, a plain
  // failure should be. `conflict` is set only by a 409 from the `ifMatch` precondition.
  const metaConflicts = metaFails.filter((f) => f.conflict);
  // A write the editor can never make (#1959: a built-in in the packaged editor) was DROPPED, not re-parked — saying
  // "still unsaved" would send the human to press Save again, which does nothing.
  const metaDropped = metaFails.filter((f) => f.dropped);
  const metaPlainFails = metaFails.filter((f) => !f.conflict && !f.dropped);
  // A conflict the human chose to keep (Cancel on Overwrite, #1868) is said as what it is: the file changed on disk.
  const assetConflicts = assetFails.filter((f) => f.conflict);
  const assetPlainFails = assetFails.filter((f) => !f.conflict);
  const failSuffix = (assetPlainFails.length
    ? ` — ${assetPlainFails.length} asset write(s) FAILED and are still unsaved: ${assetPlainFails.map((f) => f.path).join(', ')}`
    : '')
    + (assetConflicts.length
      ? ` — ${assetConflicts.length} unsaved edit(s) NOT written: the file changed on disk (${assetConflicts.map((f) => f.path).join(', ')}). The edit is still unsaved; saving again asks whether to overwrite.`
      : '')
    // Same rule for a refused base-scene ref (#831): it is pending work that stayed pending, and
    // nothing else would have told the human. Its own clause rather than a shared count, because
    // "asset write" is the wrong noun for a one-field scene mutation and a human chasing the wrong
    // noun looks in the wrong panel.
    + (baseFails.length
      ? ` — ${baseFails.length} base-scene ref(s) FAILED and are still unsaved: ${baseFails.map((f) => f.path).join(', ')}`
      : '')
    // Same rule again for a rejected import-settings write (#845) — "asset write" is still the
    // wrong noun (it names an ASSET_SCHEMA_TYPES document, not a `.meta.json` sidecar), and a
    // human chasing that noun looks in the Assets panel rather than the Inspector.
    // ⚠️ A CONFLICT is called out separately from a plain failure, because the two have OPPOSITE
    // remedies and this sentence is what the human acts on. The house rule for a failed write is
    // "press Save again" (`NineSliceEditor.save`'s dialog stays open saying exactly that) — and a
    // conflicted write's baseline has just been dropped, so pressing Save again OVERWRITES the
    // change somebody else made. Wording them identically turns the documented remedy into a
    // silent clobber, which is the whole reason `MetaWriteResult.conflict` is carried this far.
    + (metaConflicts.length
      ? ` — ${metaConflicts.length} import-setting write(s) REFUSED: the file changed on disk since `
        + `the edit was based on it (${metaConflicts.map((f) => f.path).join(', ')}). The edit is `
        + `still pending — reopen the asset to see the current values. Saving again will OVERWRITE `
        + `the newer file.`
      : '')
    + (metaPlainFails.length
      ? ` — ${metaPlainFails.length} import-setting write(s) FAILED and are still unsaved: ${metaPlainFails.map((f) => f.path).join(', ')}`
      : '')
    + (metaDropped.length
      ? ` — ${metaDropped.length} import-setting edit(s) DISCARDED: the engine's built-in assets are read-only in this editor `
        + `(${metaDropped.map((f) => f.path).join(', ')}). To change one for this project, copy it into the project's assets, edit the copy, and point its references at the copy.`
      : '');
  // A failed write is a WARNING in every branch, including the ones whose own outcome is benign.
  // A cancelled Save-As over a failed asset write was reporting 'info', so the sentence said FAILED
  // in a colour that says "nothing to see" — and colour is what gets read.
  const worst = (k: 'success' | 'warn' | 'info') => (assetFails.length || baseFails.length || metaFails.length ? 'warn' : k);

  if (o.target === 'assets') {
    // No scene half to report. Silence about it is the point: while authoring a clip the scene is
    // untouched, so "the SCENE was not saved" would be a warning about a non-event.
    return savedAny
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
      return { text: `${savedAny ? `${assetPhrase} — but the PREFAB was not saved: ` : 'The prefab was not saved: '}${why}${failSuffix}`, kind: 'warn' };
    }
    if (!o.prefabSaved) {
      // Name the cause when there is one. "See console" is a wrong instruction for the format
      // gate's refusal, whose reason is logged by the SERVER to the dev-server terminal.
      const why = o.prefabFailReason ? `: ${o.prefabFailReason}` : ' (see console)';
      return { text: `Prefab save FAILED — nothing written to disk${why}${savedAny ? `. ${assetPhrase}.` : ''}${failSuffix}`, kind: 'warn' };
    }
    return {
      text: `Prefab saved${savedAny ? ` · ${assetPhrase}` : ''}${failSuffix}`,
      kind: worst('success'),
    };
  }

  const r = o.scene!;
  if (r.saved) {
    // A cycle whose resume did not land ended the human's preview. The save is fine; saying nothing
    // would leave them wondering where their frame went.
    const lostPreview = o.previewCycled && !o.previewResumed ? ' · preview ended' : '';
    return {
      text: `Scene saved${savedAny ? ` · ${assetPhrase}` : ''}${lostPreview}${failSuffix}`,
      kind: worst('success'),
    };
  }

  // The scene did not save. Say what DID, then why it did not — in that order, because the first
  // half is the part the human cannot otherwise find out.
  const savedPart = savedAny ? `${assetPhrase} — but the SCENE was not saved: ` : '';

  if (r.reason === 'cancelled') {
    return savedAny
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
  if (r.reason === 'switching') {
    // Refused, not queued (#1750; owner, 2026-09-28): the outgoing scene was already saved or discarded when the switch
    // was chosen, so nothing is lost by pressing it again.
    return { text: `${savedPart || 'The scene was not saved: '}a scene is still loading — save again once it's open.${failSuffix}`, kind: 'warn' };
  }
  if (r.reason === 'prefab-edit') {
    return { text: `${savedPart}this is a prefab-edit world — re-open the prefab to save it${failSuffix}`, kind: 'warn' };
  }
  // The route's own reason when it gave one (#1811): "write-failed" alone told the human nothing they could act on.
  const why = r.error ? `${r.reason}: ${r.error}` : r.reason;
  return {
    text: savedPart
      ? `${assetPhrase} — but the SCENE was not saved (${why})${failSuffix}`
      : `Save FAILED (${why}) — nothing written to disk${failSuffix}`,
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
