/** The Apply dialog's target DECISIONS (#1693, owner ruling C) — which prefab each checked override is written to, as
 *  plain data the `.tsx` renders (CLAUDE.md: a panel's decisions live beside it in a `.ts`, with the unit tests).
 *
 *  Each listed key arrives with its targets (`applyTargetOptions`: the prefabs on the instance's chain it can go to,
 *  each with a truthful label and the enclosing overrides it would revert, U13) and its default (ruling (a)). The dialog
 *  shows, per row, the label of the target it is set to, a picker when there is more than one, and a footer naming every
 *  file the checked rows will write. "Apply all to …" moves every row that CAN go there, and leaves the rest where
 *  they are. */

import type { KeyTargets, ApplyTargetOption } from '../scene/prefabApplyOptions';
import type { ApplyTargets } from '../scene/prefabApplyTargets';

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

/** The prefab files the CHECKED keys write, by display name, in first-seen order: each key's target, and every
 *  enclosing prefab whose override it reverts (U13). The dialog's footer. */
export function filesWritten(choice: TargetChoice, options: ReadonlyMap<string, KeyTargets>, checked: Iterable<string>): string[] {
  const out: string[] = [];
  const add = (name: string) => { if (!out.includes(name)) out.push(name); };
  for (const key of checked) {
    const o = chosenOption(choice, options, key);
    if (!o) continue;
    add(o.name);
    for (const r of o.alsoReverts) add(r.name);
  }
  return out;
}

/** The request for `applyToPrefabWithUndo`: each checked key's chosen target. A key without a target is left to the
 *  engine's default. */
export function toApplyTargets(choice: TargetChoice, checked: Iterable<string>): ApplyTargets {
  const perKey: Record<string, string> = {};
  for (const key of checked) if (choice[key]) perKey[key] = choice[key]!;
  return { perKey };
}
