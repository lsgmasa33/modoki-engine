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

import { saveAll, type SaveResult } from './serialize';
import { flushDirtyAssets, type FlushResult } from './dirtyAssets';
import { isEditingPrefab, savePrefabEdit } from './prefabEdit';
import { getRunMode, canEdit, type RunMode } from '../../runtime/core/playState';
import { getModeOwner } from './playMode';

export interface SaveOutcome {
  /** Parked asset docs written by this save. ALWAYS attempted, whatever the scene half does. */
  assets: FlushResult;
  /** Which half the scene-shaped save targeted. */
  target: 'scene' | 'prefab';
  /** `target:'scene'` — the full scene result (absent for a prefab save). */
  scene?: SaveResult;
  /** `target:'prefab'` — did the prefab write land? */
  prefabSaved?: boolean;
  /** `target:'prefab'` — the write was REFUSED by the run-mode guard, not attempted and failed.
   *  Different sentences for the human: one is "exit preview", the other is "look at the console". */
  prefabRefused?: boolean;
  /** Run mode + the panel owning it, captured at the moment a scene save was refused for it. */
  mode?: { runMode: RunMode; owner: string | null };
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
export async function runSaveAll(): Promise<SaveOutcome> {
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

  if (o.target === 'prefab') {
    if (o.prefabRefused) {
      const why = whyBlocked(o.mode);
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
    return {
      text: `Scene saved${n ? ` · ${assetPhrase}` : ''}${failSuffix}`,
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
    return { text: `${savedPart || 'The scene was not saved: '}${whyBlocked(o.mode)}${failSuffix}`, kind: 'warn' };
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
