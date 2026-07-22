/** Bind an open `.anim.json` clip to an entity's Animator.
 *
 *  The Animation panel can only author tracks once it knows which entity is the
 *  clip's binding ROOT (tracks address descendants by relative name-path). Normally
 *  that root is discovered by scanning for the Animator whose `clips` bank already
 *  references the clip (`resolveAnimatorRootForClip`) — but a brand-new clip is
 *  referenced by nobody, so the panel opens unbound and shows a warning.
 *
 *  This module is the fix-it path behind that warning: pick any entity and we
 *  ADD the `Animator` trait when it's missing and APPEND the clip to its `clips`
 *  bank, so the same scan finds it from then on. Both cases are ONE undo entry
 *  (add-and-populate via `addTraitToEntitiesWithUndo`'s `values` prefill) — a half
 *  state (Animator added but clip not in the bank) would be a bound root whose
 *  clip still isn't assigned, i.e. the exact bug this closes. */

import { getTraitByName } from '../../runtime/ecs/traitRegistry';
import { findEntity } from '../../runtime/ecs/entityUtils';
import {
  parseAnimClipBank, stringifyAnimClipBank, type AnimatorClip,
} from '../../runtime/animation/animClipBank';
import {
  addTraitToEntitiesWithUndo, writeTraitFieldPerEntityWithUndo,
} from '../undo/entityActions';
import { useEditorStore } from '../store/editorStore';

/** A bank entry name derived from `preferred`, de-duplicated against the bank
 *  (base / base2 / base3 …). Falls back to "clip" for an empty/blank preference —
 *  the same base `AnimatorClipsSection.uniqueName` uses for a hand-added row. */
export function uniqueClipName(bank: AnimatorClip[], preferred: string): string {
  const base = preferred.trim() || 'clip';
  const taken = new Set(bank.map((c) => c.name));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) { const s = `${base}${n}`; if (!taken.has(s)) return s; }
}

export interface ClipBindingPlan {
  /** The bank to write back (identical to the input when `added` is false). */
  bank: AnimatorClip[];
  /** Entry name the clip is (now) filed under. */
  name: string;
  /** False when the bank already referenced this GUID — nothing to write. */
  added: boolean;
}

/** Plan appending `guid` to an Animator's clip bank. Re-binding a clip that's
 *  already in the bank is a no-op write (we only need the editor's root pointer),
 *  so a second bind never appends a duplicate entry under a new name. */
export function planClipBinding(bank: AnimatorClip[], guid: string, preferred: string): ClipBindingPlan {
  const existing = bank.find((c) => c.clip === guid);
  if (existing) return { bank, name: existing.name, added: false };
  const name = uniqueClipName(bank, preferred);
  return { bank: [...bank, { name, clip: guid }], name, added: true };
}

/** Bind `clipGuid` to `entityId`: add the Animator trait if the entity lacks one,
 *  append the clip to its bank, then point the Animation panel at it (and select
 *  the entity, so the Inspector shows the Animator that just appeared).
 *
 *  Returns false — without touching the world — when the entity or the Animator
 *  trait can't be resolved, or the clip has no GUID yet. */
export function bindClipToEntity(entityId: number, clipGuid: string, clipName: string): boolean {
  const meta = getTraitByName('Animator');
  const ent = findEntity(entityId);
  if (!meta || !ent) { console.warn('[bindAnimator] no Animator trait / entity', entityId); return false; }
  if (!clipGuid) { console.warn('[bindAnimator] clip has no GUID yet — not binding'); return false; }

  if (!ent.has(meta.trait)) {
    const plan = planClipBinding([], clipGuid, clipName);
    // Prefill `clips` on the ADD so the component never exists without its clip
    // (one undo entry — see the module header).
    addTraitToEntitiesWithUndo([entityId], meta, { clips: stringifyAnimClipBank(plan.bank) }, `Bind ${plan.name} to Animator`);
  } else {
    const live = ent.get(meta.trait) as { clips?: string } | undefined;
    const plan = planClipBinding(parseAnimClipBank(live?.clips), clipGuid, clipName);
    if (plan.added) {
      writeTraitFieldPerEntityWithUndo(
        [entityId], meta, 'clips',
        () => stringifyAnimClipBank(plan.bank),
        `Add clip ${plan.name} to Animator`,
      );
    }
  }

  const store = useEditorStore.getState();
  store.setAnimatorRoot(entityId);
  store.selectEntity(entityId);
  return true;
}
