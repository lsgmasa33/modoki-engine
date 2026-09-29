/** The Apply dialog's DECISIONS (#1693, owner ruling C; #1736) — which prefab each checked override is written to, and
 *  what the dialog says about it — as plain data the `.tsx` renders (CLAUDE.md: a panel's decisions live beside it in a
 *  `.ts`, with the unit tests).
 *
 *  Each listed key arrives with its targets (`applyTargetOptions`: the prefabs on the instance's chain it can go to) and
 *  its default (ruling (a)). What applying the checked keys at their chosen targets DOES is not worked out here: the
 *  dialog asks the engine for a dry run of exactly that Apply (`previewApply`), and every row, the "Writes:" footer and
 *  the conflict line RENDER its per-key effects (#1736). A row's words used to be computed key by key, so the dialog
 *  could not see two frames writing one template field, or one frame's write hiding another's U13 revert. */

import type { KeyTargets, ApplyTargetOption } from '../scene/prefabApplyOptions';
import type { ApplyTargets } from '../scene/prefabApplyTargets';
import type { ApplyPreview, ApplyResult } from '../scene/prefabApply';
import { describeEffect } from '../scene/prefabApplyEffects';
import { effectiveDefaults } from '../scene/prefabOverrideKeys';
import { getEditVersion, subscribeUndo } from '../undo/undoManager';
import { getRunMode, onRunModeChange } from '../../runtime/core/playState';

/** What checking an entity's or a component's checkbox checks (#1831): its keys WITHOUT the instance root's default
 *  overrides (`defaultOverrides`: `effectiveDefaults`, at their current targets), as Unity applies a component's other properties and leaves those — or, when the group holds nothing else,
 *  the default overrides themselves, since the checkbox would otherwise do nothing. A default override's own row always
 *  toggles it: that is the per-property route Apply All and Revert All leave to the user. UNchecking a group clears every
 *  key in it, a checked default override included: that is how a component is left out. */
export function groupToggle(checked: ReadonlySet<string>, keys: readonly string[], defaultOverrides: ReadonlySet<string>, next: 'on' | 'off'): Set<string> {
  const out = new Set(checked);
  if (next === 'off') { for (const k of keys) out.delete(k); return out; }
  const rest = keys.filter((k) => !defaultOverrides.has(k));
  for (const k of rest.length ? rest : keys) out.add(k);
  return out;
}

/** A group checkbox's state, read over the keys checking it would check — so a component whose ordinary fields are all
 *  checked reads "on" while its default overrides sit unchecked, as they start — but "mixed", not "off", while a default
 *  override inside it is checked on its own: "off" would hide a key that is going to be applied (#1831 review). */
export function groupState(checked: ReadonlySet<string>, keys: readonly string[], defaultOverrides: ReadonlySet<string>): 'on' | 'off' | 'mixed' {
  const rest = keys.filter((k) => !defaultOverrides.has(k));
  const over = rest.length ? rest : keys;
  const on = over.filter((k) => checked.has(k)).length;
  if (on === 0) return keys.some((k) => checked.has(k)) ? 'mixed' : 'off';
  return on === over.length ? 'on' : 'mixed';
}

/** `checked` after a target change (#1831 review): a key that STOPS being a default override (a nested instance's root
 *  placement sent into the prefab that contains it) is checked, as Apply All to there takes it, and one that BECOMES one
 *  is unchecked. Every other key keeps what the user set — "Apply all to" the target a checked default override already
 *  has leaves it checked. The same for a row's own picker and for "Apply all to …". */
export function retargetChecks(
  checked: ReadonlySet<string>, defaultOverrides: readonly string[], before: TargetChoice, after: TargetChoice,
  ownSource: string, resolve: (guid: string) => string | undefined,
): Set<string> {
  const was = effectiveDefaults(defaultOverrides, before, ownSource, resolve);
  const now = effectiveDefaults(defaultOverrides, after, ownSource, resolve);
  const out = new Set(checked);
  for (const k of defaultOverrides) {
    if (was.has(k) && !now.has(k)) out.add(k);
    if (!was.has(k) && now.has(k)) out.delete(k);
  }
  return out;
}

/** key → the chosen target (a prefab guid). */
export type TargetChoice = Readonly<Record<string, string>>;

/** Every key at its default (ruling (a): the frame's own prefab, except a component an enclosing row added, which goes
 *  back to the prefab that adds it). A key with no target is left out. */
export function initialTargets(options: ReadonlyMap<string, KeyTargets>): TargetChoice {
  const out: Record<string, string> = {};
  for (const [key, t] of options) {
    const def = t.options.find((o) => o.target === t.defaultTarget) ?? t.options[0];
    if (def) out[key] = def.target;
  }
  return out;
}

/** `key` set to `target` — unchanged when `target` is not one of its options. */
export function setTarget(choice: TargetChoice, options: ReadonlyMap<string, KeyTargets>, key: string, target: string): TargetChoice {
  if (!options.get(key)?.options.some((o) => o.target === target)) return choice;
  return { ...choice, [key]: target };
}

/** Every key in `keys` that CAN go to `target`, set to it; the others keep their choice. What "Apply all to …" does. */
export function setAllTargets(choice: TargetChoice, options: ReadonlyMap<string, KeyTargets>, keys: Iterable<string>, target: string): TargetChoice {
  let out = choice;
  for (const key of keys) out = setTarget(out, options, key, target);
  return out;
}

/** The option `key` is set to, or undefined for a key with no target. */
export function chosenOption(choice: TargetChoice, options: ReadonlyMap<string, KeyTargets>, key: string): ApplyTargetOption | undefined {
  const t = options.get(key);
  return t?.options.find((o) => o.target === choice[key]) ?? t?.options[0];
}

/** Does `key` offer a choice at all? A single target is shown as a label, not a picker. */
export function hasChoice(options: ReadonlyMap<string, KeyTargets>, key: string): boolean {
  return (options.get(key)?.options.length ?? 0) > 1;
}

/** The request for `applyToPrefabWithUndo`: each checked key's chosen target. A key without a target is left to the
 *  engine's default. */
export function toApplyTargets(choice: TargetChoice, checked: Iterable<string>): ApplyTargets {
  const perKey: Record<string, string> = {};
  for (const key of checked) if (choice[key]) perKey[key] = choice[key]!;
  return { perKey };
}

/** What a preview was computed FOR — the instance, the checked keys and their targets — so a result that arrives after
 *  the selection moved on is recognised as stale and never rendered or applied from. Order-free. The instance is part
 *  of it: two instances of one prefab list the same keys, and reopened on the other, the first one's preview passed. */
export function previewRequestKey(root: number | null, choice: TargetChoice, checked: Iterable<string>, world = ''): string {
  return `${root ?? ''}\n${world}\n${[...checked].sort().map((k) => `${k}→${choice[k] ?? ''}`).join('\n')}`;
}

/** Does the dialog stay open after an Apply (#1736)? Only for a REFUSAL that carries the plan it refused — a conflict,
 *  or a plan that changed since it was shown: the dialog re-reads it and shows why. An Apply that wrote nothing
 *  because every key was passed over carries effects too, and closing with its notice is right there — kept open, every
 *  click toasted and nothing changed. */
export function staysOpen(result: Pick<ApplyResult, 'applied' | 'refused' | 'effects'>): boolean {
  return !result.applied && !!result.refused && !!result.effects;
}

/** The prefab FILES the plan writes, by file name, each once (#1733): it printed the display name with `.prefab.json`
 *  after it — "Wooden Door.prefab.json", which does not exist — and two prefabs sharing a name were listed as one. */
export function filesWritten(preview: Pick<ApplyPreview, 'files'> | null): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of preview?.files ?? []) {
    if (seen.has(f.source)) continue;
    seen.add(f.source);
    out.push(f.file);
  }
  return out;
}

/** How one row reads: its effect in a sentence, its tone, what U13 reverts with it, and a consequence the effect alone
 *  does not say. Null for a key the preview has no effect for (unchecked, or a key the plan passes over quietly). */
export interface RowView { label: string; tone: 'ok' | 'notApplied' | 'conflict'; reverts: string[]; note?: string }

export function rowView(preview: Pick<ApplyPreview, 'effects'> | null, key: string): RowView | null {
  const e = preview?.effects.find((x) => x.key === key);
  if (!e) return null;
  const tone = e.effect.op === 'conflict' ? 'conflict' : e.effect.op === 'notApplied' ? 'notApplied' : 'ok';
  return {
    label: describeEffect(e),
    tone,
    reverts: e.alsoReverts.flatMap((r) => r.what.map((w) => `also reverts Prefab '${r.name}': ${w} — Prefab '${r.name}' is written too`)),
    ...(e.note ? { note: e.note } : {}),
  };
}

/** Why Apply cannot run on this preview, or null when it can: a refusal, a conflict (#1736 — both rows say which), or a
 *  preview that is not of the current selection (`current` ≠ the request it was computed for). */
export function applyBlocked(preview: (Pick<ApplyPreview, 'conflicts' | 'refused'> & { request: string }) | null, current: string): string | null {
  if (!preview || preview.request !== current) return 'Working out what this Apply writes…';
  if (preview.refused) return `Cannot apply: ${preview.refused}`;
  const n = preview.conflicts.length;
  if (n) return `Cannot apply: ${n} conflict${n === 1 ? '' : 's'} — checked changes write the same field with different values (see the red lines)`;
  return null;
}

/** What a press of Apply does: 'apply' now; 'wait' while a plan the rows show is being re-worked for THIS request; or
 *  'blocked' — a refusal or a conflict, which the dialog names, or rows that show no plan a press could agree to.
 *
 *  A stale plan keeps a press only while its rows state an effect for EVERY checked key, at the target now chosen: an
 *  uncheck, or an edit re-planning the same rows. A key just checked has no row in it, and a retargeted one names the
 *  old target, so for those (and with no plan at all: the open, the re-read after a refused Apply) the button waits, as
 *  it always did — kept, such a press could only be refused as "changed" when nothing had (close-out re-review). The
 *  button used to wait for the uncheck too, so the first press after one (inside the 120 ms debounce and the plan) was
 *  dropped with no word — 3 of 3 directed tries, an uncheck and then an immediate press. */
export function applyPress(
  preview: (Pick<ApplyPreview, 'effects' | 'conflicts' | 'refused'> & { request: string }) | null,
  current: string,
  checked: Iterable<string>,
  choice: TargetChoice,
): 'apply' | 'wait' | 'blocked' {
  if (applyBlocked(preview, current) === null) return 'apply';
  if (!preview || preview.request === current) return 'blocked';
  for (const key of checked) {
    const shown = preview.effects.find((e) => e.key === key);
    if (!shown || (choice[key] !== undefined && shown.target !== choice[key])) return 'blocked';
  }
  return 'wait';
}

/** What the rows show for `keys` — each key's effect as `rowView` renders it, from whatever preview is on screen (a stale
 *  one included: the rows do not wait for the new plan). A press made while the plan is worked out records this. */
export function shownPlan(preview: Pick<ApplyPreview, 'effects'> | null, keys: Iterable<string>): string {
  return JSON.stringify([...keys].sort().map((k) => [k, rowView(preview, k)]));
}

/** A press kept while its plan was worked out: the selection it was made on (`previewRequestKey` without the world),
 *  its keys, and what the rows showed for them (`shownPlan`). */
export interface KeptPress { selection: string; keys: string[]; shown: string }

/** A kept press as the preview changes, `request` being the current preview request and `selection` the same key without
 *  the world: 'apply' it, keep it ('wait'), 'drop' it (the selection changed after the press, or the plan came back
 *  blocked — the blocked line says why), or 'changed': the plan landed, and for the pressed keys it does not say what
 *  the rows showed. An Apply commits the plan the rows SHOWED (#1736), so a press is never the go-ahead for one nobody
 *  saw — a target changed under it, a cross-key effect, an edit that re-planned it, the re-read after a refused plan.
 *  A world change alone does not drop it: the press waits for the new plan and is held to the same test. Null with no
 *  press kept. */
export function queuedPress(
  kept: KeptPress | null,
  preview: (Pick<ApplyPreview, 'effects' | 'conflicts' | 'refused'> & { request: string }) | null,
  request: string,
  selection: string,
): 'apply' | 'wait' | 'drop' | 'changed' | null {
  if (kept === null) return null;
  if (kept.selection !== selection) return 'drop';
  if (preview && preview.request !== request) return 'wait';
  if (applyBlocked(preview, request) !== null) return 'drop';
  return shownPlan(preview, kept.keys) === kept.shown ? 'apply' : 'changed';
}

/** The world a preview was planned against (#1773): the edit version (an edit, or an undo/redo of one) and the run mode
 *  (Play, Stop, a pose preview's begin and Exit). The preview re-plans when it changes, so a refusal the dialog shows
 *  ("the live world is not authored") does not outlive the state that caused it, and the Apply button is not left
 *  disabled until the user touches the list. A selection changes neither, so a click re-plans nothing. Correctness does
 *  not rest on it: Apply hands the preview's fingerprint over and refuses a plan that differs (#1736). */
export function previewWorldKey(): string {
  return `${getEditVersion()}|${getRunMode()}`;
}

/** Subscribe to what {@link previewWorldKey} reads: the undo stacks (every edit, undo and redo moves them) and the run
 *  mode. Returns the unsubscribe. */
export function subscribePreviewWorld(fn: () => void): () => void {
  const offUndo = subscribeUndo(fn);
  const offMode = onRunModeChange(fn);
  return () => { offUndo(); offMode(); };
}
