/** prefabApplyEffects — what an Apply DOES, per key, as its plan computed it (#1736, #1693 design §4.1).
 *
 *  `planApply` is the one place that decides what each selected key writes, where, and what else that write changes
 *  (U13's reverts, a conflict with another key, a template node that keeps shadowing it). It returns that decision as a
 *  {@link KeyEffect} per key, and the commit executes exactly that plan. Every surface — the Apply dialog's rows and its
 *  "Writes:" footer, the agent `prefab overrides`/`apply` results — RENDERS those effects through
 *  {@link describeEffect}. None of them re-derives an effect: each used to, key by key, and so none could see an effect
 *  that only exists across keys (two frames writing one template field, one frame's write masking another's U13). */

/** What writing one key at its target does. `member` is the member's display name. */
export type EditEffect =
  | { op: 'setField'; member: string; trait: string; field: string; to: unknown }
  /** The target does not give the member the component, so the WHOLE component is written (#1658's truthful wording). */
  | { op: 'addComponent'; member: string; trait: string; fields: Record<string, unknown> }
  | { op: 'removeComponent'; member: string; trait: string }
  /** The target level is what adds the component: it stops adding it. */
  | { op: 'stopAddingComponent'; member: string; trait: string }
  | { op: 'addTag'; member: string; tag: string }
  | { op: 'removeMember'; member: string }
  | { op: 'addNode'; name: string }
  | { op: 'move'; member: string }
  /** The key is listed but this Apply writes nothing for it, and why. */
  | { op: 'notApplied'; reason: string }
  /** Another key of the same Apply states the same slot with a different value (#1727). The whole Apply is refused. */
  | { op: 'conflict'; slot: string; value: unknown; with: { key: string; value: unknown; who: string }[]; wanted: EditEffect };

export interface KeyEffect {
  /** The key, in the caller's spelling. */
  key: string;
  /** The prefab written (its `PrefabInstance.source`); '' for a key nothing is written for. */
  target: string;
  targetName: string;
  /** Written as an override on the row an ENCLOSING prefab holds for the key's frame, not into the frame's template. */
  asOverride: boolean;
  effect: EditEffect;
  /** U13: the enclosing overrides this key's write reverts, per prefab: as that frame's listing names them (`keys`), and
   *  in words (`what`: "its override of Transform.x on A"). */
  alsoReverts: { source: string; name: string; keys: string[]; what: string[] }[];
  /** A consequence the effect alone does not say: a template node above the chain that still states the value (#1731). */
  note?: string;
}

/** A slot two keys claim with different values. `keys` holds every claimant, with the value each writes. */
export interface ApplyConflict {
  slot: string;
  targetName: string;
  keys: { key: string; value: unknown }[];
}

/** The value a whole-trait REMOVAL states at its slot, where it collides with another key's field of that trait. */
export const REMOVED_VALUE = '(removed)';
const fmt = (v: unknown): string => (v === REMOVED_VALUE ? 'removed'
  : typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(3)) : JSON.stringify(v));
const fieldsOf = (bag: Record<string, unknown>): string => Object.entries(bag).map(([k, v]) => `${k} ${fmt(v)}`).join(', ');
export const formatEffectValue = fmt;

/** The sentence for `e` — the one wording the dialog, the agent op and the refusal all use. */
export function describeEffect(e: Pick<KeyEffect, 'effect' | 'targetName' | 'asOverride'>): string {
  const name = e.targetName;
  const at = e.asOverride ? `as an override in Prefab '${name}'` : `in Prefab '${name}'`;
  const every = (verb: string) => (e.asOverride ? '' : ` — every ${name} ${verb} it`);
  const x = e.effect;
  switch (x.op) {
    case 'setField': return `${x.member} · ${x.trait}.${x.field} → ${fmt(x.to)} ${at}`;
    case 'addComponent': return `add component ${x.trait} (${fieldsOf(x.fields)}) to ${x.member} ${at}${every('gains')}`;
    case 'removeComponent': return e.asOverride ? `remove ${x.trait} from ${x.member} ${at}` : `remove component ${x.trait} from ${x.member} ${at}${every('loses')}`;
    case 'stopAddingComponent': return `Prefab '${name}' stops adding ${x.trait} to ${x.member}`;
    case 'addTag': return `add tag ${x.tag} to ${x.member} ${at}${every('gains')}`;
    case 'removeMember': return e.asOverride ? `remove ${x.member} ${at}` : `remove ${x.member} from Prefab '${name}'${every('loses')}`;
    case 'addNode': return `add ${x.name} to Prefab '${name}'${every('gains')}`;
    case 'move': return `move ${x.member} in Prefab '${name}'`;
    case 'notApplied': return `not applied: ${x.reason}`;
    case 'conflict': {
      // Named for a reader — the member and the row its instance hangs from — not by key: the agent has the keys in
      // `conflicts` and in the refusal's `options`, and a guid chain in the dialog tells a person nothing.
      const others = x.with.map((w) => `the change to ${w.who} (${fmt(w.value)})`).join(', ');
      return `conflict: ${x.slot} in Prefab '${name}' is also written by ${others}, not ${fmt(x.value)} as here — uncheck one, or apply one of them as an override in an enclosing prefab`;
    }
  }
}

/** The refusal an Apply with conflicts answers with: nothing is written. */
export function conflictRefusal(conflicts: readonly ApplyConflict[]): string {
  const each = conflicts.map((c) => `${c.slot} in Prefab '${c.targetName}' — ${c.keys.map((k) => `${k.key} (${fmt(k.value)})`).join(', ')}`);
  return `changes write ${conflicts.length === 1 ? 'one field or component' : `${conflicts.length} fields or components`} with different values, so nothing was applied: ${each.join('; ')}. Keep one value per field, or apply the others as overrides in an enclosing prefab`;
}

/** A prefab source's FILE name — `Door.prefab.json` — from its resolved path (the display name is not a file, #1733). */
export function prefabFileName(path: string): string {
  const base = path.split(/[\\/]/).pop() || path;
  return base;
}

/** One string for a set of effects, order-free: what the dialog showed, handed back so the commit can refuse a fresh plan
 *  that would do something else (#1736 — a preview is debounced, and the world or the prefab can move under it). */
export function effectsFingerprint(effects: readonly KeyEffect[]): string {
  return effects
    .map((e) => JSON.stringify([e.key, e.target, e.asOverride, describeEffect(e), e.alsoReverts.map((r) => [r.source, r.keys]), e.note ?? '']))
    .sort()
    .join('\n');
}
