/** prefabApplyOptions — what the Apply dialog and the agent `prefab overrides` op SAY about each key's targets (#1693).
 *
 *  For every listed key: the prefabs on the instance's chain it can be applied to, what writing it there DOES —
 *  stated truthfully (owner ruling C: a field of a component the enclosing row added, applied to the inner prefab, is
 *  "add component Rotate3D (axis x, speed 7) to Hinge — every Hinge gains it", never a one-field edit) — which
 *  enclosing overrides U13 reverts with it, and the default (ruling (a)). The write itself is `applyToPrefabSelective`;
 *  both read the same rules from `prefabApplyTargets.ts`, so what is offered is what is written. */

import { getTraitByName } from '../../runtime/core/ecs/traitRegistry';
import { getCurrentWorld } from '../../runtime/core/ecs/world';
import { readTraitData, readTraitDataFull } from '../../runtime/core/ecs/entityUtils';
import { isGuid, resolveRef } from '../../runtime/loaders/assetManifest';
import { frameBase, ownedRootAt, levelDoc } from './prefabBase';
import { memberPathSteps } from '../../runtime/core/assetRefRules';
import {
  chainSlots, memberKeyAt, statedFields, carrierOf, traitInside, resolveKeyLevel, defaultKeyLevel,
} from './prefabApplyTargets';
import { toLocalIdKey, splitNestedKey } from './overrideKeyGrammar';
import { getCachedPrefabSync, isTemplateExcludedField, type PrefabFile } from './prefab';

export interface ApplyTargetOption {
  /** The prefab's guid (its `PrefabInstance.source`): what `ApplyTargets` names it by. */
  target: string;
  /** The prefab's display name. */
  name: string;
  /** What applying the key there does, in a sentence. */
  label: string;
  /** U13: the enclosing overrides applying it there also reverts — the prefab (guid and name), and what, in a phrase. */
  alsoReverts: { prefab: string; name: string; what: string }[];
}

export interface KeyTargets {
  options: ApplyTargetOption[];
  defaultTarget: string;
  /** The prefab of the frame the key belongs to — `'frame'` names it: the instance's own for its own keys, the NESTED
   *  instance's for a U14 key (`keys.nested`). */
  frameTarget: string;
}

const fmt = (v: unknown): string => (typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(3)) : typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v));
const fieldsOf = (bag: Record<string, unknown>): string => Object.entries(bag).map(([k, v]) => `${k} ${fmt(v)}`).join(', ');

/** The targets of each of `keys` (as the listing spells them) on the instance rooted at `rootInstanceId`, whose
 *  document is `prefab`. A stored root nothing encloses has one target per key, its own prefab. */
export function applyTargetOptions(rootInstanceId: number, prefab: PrefabFile, keys: readonly string[]): Map<string, KeyTargets> {
  const out = new Map<string, KeyTargets>();
  const base = frameBase(rootInstanceId);
  const piMeta = getTraitByName('PrefabInstance');
  const eaMeta = getTraitByName('EntityAttributes');
  const ownSource = piMeta ? ((readTraitData(rootInstanceId, piMeta)?.source as string) || '') : '';
  const frameName = prefab.name || ownSource;
  const memberEcs = new Map<number, number>();
  if (piMeta) {
    getCurrentWorld().query(piMeta.trait).updateEach(([pi], e) => {
      const d = pi as { rootInstanceId?: number; localId?: number };
      if (d.rootInstanceId === rootInstanceId && d.localId) memberEcs.set(d.localId, e.id());
    });
  }
  const memberName = (lid: number) => {
    const ecs = memberEcs.get(lid);
    return (ecs && eaMeta ? (readTraitData(ecs, eaMeta)?.name as string) : '') || prefab.entities.find((e) => e.localId === lid)?.name || `member ${lid}`;
  };
  const sameSource = (a: string, b: string) => a === b || (isGuid(a) && resolveRef(a) === b) || (isGuid(b) && resolveRef(b) === a);
  const slots = base ? chainSlots(base) : [];
  const n = base ? base.levels.length - 1 : 0;
  const levelSource = (j: number) => (base ? base.levels[j]!.source : ownSource);
  const levelName = (j: number) => (base ? base.levels[j]!.doc?.name ?? base.levels[j]!.source : frameName);
  for (const key of keys) {
    const canon = toLocalIdKey(key, prefab, getCachedPrefabSync);
    if (!canon) continue;
    // U14: a nested instance's own edit, listed on this one. Its targets are its own chain's, from THIS instance's
    // prefab inward, and the default is this instance's prefab (as an override on the row it holds for that instance).
    const parts = splitNestedKey(canon);
    if (parts) {
      let nested = rootInstanceId;
      for (const step of memberPathSteps(parts.chain)) nested = nested && typeof step === 'number' ? ownedRootAt(nested, step) : 0;
      const fb = nested ? frameBase(nested) : null;
      const idx = fb ? fb.levels.findIndex((l) => l.root === rootInstanceId) : -1;
      const own = fb?.levels[fb.levels.length - 1];
      const doc = own ? levelDoc(nested, own.source).doc : null;
      if (!fb || idx < 0 || !doc) continue;
      const sub = applyTargetOptions(nested, doc, [parts.inner]).get(parts.inner);
      if (!sub) continue;
      const inside = new Set(fb.levels.slice(idx).map((l) => l.source));
      // A member removal from the nested prefab itself is applied from the nested instance (it cascades and re-parents).
      if (parts.inner.startsWith('-removed.')) inside.delete(fb.levels[fb.levels.length - 1]!.source);
      out.set(key, { options: sub.options.filter((o) => inside.has(o.target)), defaultTarget: fb.levels[idx]!.source, frameTarget: own!.source });
      continue;
    }
    const options: ApplyTargetOption[] = [];
    for (let j = 0; j <= n; j++) {
      const level = base ? resolveKeyLevel(base, slots, prefab, canon, levelSource(j), sameSource) : n;
      if (level !== j) continue;
      options.push({ target: levelSource(j), name: levelName(j), label: describe(j), alsoReverts: reverted(j) });
    }
    const def = base ? defaultKeyLevel(base, slots, prefab, canon) : n;
    out.set(key, { options, defaultTarget: levelSource(def), frameTarget: levelSource(n) });

    function describe(j: number): string {
      const inner = j === n;
      const at = inner ? `in Prefab '${levelName(j)}'` : `as an override in Prefab '${levelName(j)}'`;
      const every = inner ? ` — every ${levelName(j)} gains it` : '';
      if (canon!.startsWith('-trait.')) {
        const [, lidStr, t] = canon!.split('.');
        const lid = Number(lidStr);
        if (inner) return `remove component ${t} from ${memberName(lid)} in Prefab '${levelName(j)}' — every ${levelName(j)} loses it`;
        const s = slots.find((x) => x.level === j)!;
        // It STOPS adding only when this level is what gives the member the component; otherwise its statement (a field
        // of it, perhaps) goes and a removal is written (`writeOuter`).
        const adds = !!statedFields(carrierOf(base!, s)!, s.path, memberKeyAt(s, prefab, lid), lid, t!) && !traitInside(slots, base!, prefab, j, lid, t!);
        return adds ? `Prefab '${levelName(j)}' stops adding ${t} to ${memberName(lid)}` : `remove ${t} from ${memberName(lid)} ${at}`;
      }
      if (canon!.startsWith('+trait.')) {
        const [, lidStr, tag] = canon!.split('.');
        return `add tag ${tag} to ${memberName(Number(lidStr))} ${at}${every}`;
      }
      if (canon!.startsWith('-removed.')) {
        const lid = Number(canon!.slice('-removed.'.length));
        const name = prefab.entities.find((e) => e.localId === lid)?.name || `member ${lid}`;
        return inner ? `remove ${name} from Prefab '${levelName(j)}' — every ${levelName(j)} loses it` : `remove ${name} ${at}`;
      }
      if (/^[+\-~]/.test(canon!)) return `apply it to Prefab '${levelName(j)}'`;
      const [lidStr, t, f] = canon!.split('.');
      const lid = Number(lidStr);
      const meta = getTraitByName(t!);
      const ecs = memberEcs.get(lid);
      const live = ecs && meta ? readTraitDataFull(ecs, meta) : null;
      // The component is ADDED where nothing inside the target gives the member it: at the frame's own template, its
      // row lacks it; at an enclosing level, neither the template nor a level below it adds it (what Apply writes whole).
      const adds = inner
        ? prefab.entities.find((e) => e.localId === lid)?.traits[t!] === undefined
        : !traitInside(slots, base!, prefab, j, lid, t!, true);
      if (adds && live && meta) {
        const bag: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(live)) if (!isTemplateExcludedField(meta, k)) bag[k] = v;
        return `add component ${t} (${fieldsOf(bag)}) to ${memberName(lid)} ${at}${every}`;
      }
      return `${memberName(lid)} · ${t}.${f} → ${fmt(live?.[f!])} ${at}`;
    }

    function reverted(j: number): ApplyTargetOption['alsoReverts'] {
      const whole = canon!.startsWith('+trait.') || canon!.startsWith('-trait.');
      if (!base || (/^[+\-~]/.test(canon!) && !whole)) return [];
      const parts = canon!.split('.');
      const [lid, t, f] = whole ? [Number(parts[1]), parts[2]!, undefined] : [Number(parts[0]), parts[1]!, parts[2]];
      const inner = j === n;
      // U13 drops the whole component where the write is: a tag, a removal, and a component written whole (nothing inside
      // the target gives the member it) — as `planApply` does; else the one field.
      const writesWhole = whole || (inner
        ? prefab.entities.find((e) => e.localId === lid)?.traits[t] === undefined
        : !traitInside(slots, base, prefab, j, lid, t, true));
      const written = writesWhole ? undefined : f;
      const out2: ApplyTargetOption['alsoReverts'] = [];
      for (const s of slots) {
        if (s.level >= j) continue;
        const stated = statedFields(carrierOf(base, s)!, s.path, memberKeyAt(s, prefab, lid), lid, t);
        if (!stated) continue;
        if (written && !(written in stated)) continue;
        out2.push({ prefab: levelSource(s.level), name: levelName(s.level), what: `its override of ${t}${written ? `.${written}` : ''} on ${memberName(lid)}` });
      }
      return out2;
    }
  }
  return out;
}

/** An Apply request's targets, checked ALL-or-nothing against each key's options (#1693) — the agent `prefab apply` op's
 *  one decision, kept here so it is tested and says what `planApply` does:
 *  - a per-key target is matched to its key in ONE spelling (`canonical`), and handed on under the spelling `keys` uses;
 *  - `'instance'` is the prefab of the instance the request is made on (`ownSource`); `'frame'` the prefab of the frame
 *    the KEY belongs to (`KeyTargets.frameTarget` — a nested instance's for a `keys.nested` key); any other value names a
 *    prefab by guid, or by path (`resolve`);
 *  - `stray`: a per-key target for a key the request does not act on; `bad`: a key whose target is not one of its own. */
export function checkApplyTargets(
  keys: Iterable<string>,
  options: ReadonlyMap<string, KeyTargets>,
  ownSource: string,
  asked: { default?: string; perKey?: Readonly<Record<string, string>> },
  canonical: (key: string) => string,
  resolve: (guid: string) => string | undefined,
): { perKey: Record<string, string>; stray: string[]; bad: string[] } {
  const keyList = [...keys];
  const byCanon = new Map<string, string>();
  const bad: string[] = [];
  for (const [k, v] of Object.entries(asked.perKey ?? {})) {
    const c = canonical(k);
    const had = byCanon.get(c);
    // Two spellings of one key asking for two targets: a contradiction, refused rather than resolved by order.
    if (had !== undefined && had !== v) bad.push(`${k} → ${v} (the same key is also asked for ${had})`);
    byCanon.set(c, v);
  }
  const listed = new Set(keyList.map(canonical));
  const optsByCanon = new Map([...options].map(([k, t]) => [canonical(k), t]));
  const stray = Object.keys(asked.perKey ?? {}).filter((k) => !listed.has(canonical(k)));
  const perKey: Record<string, string> = {};
  for (const k of keyList) {
    const own = byCanon.get(canonical(k));
    if (own) perKey[k] = own;
    const a = own ?? asked.default;
    if (!a) continue;
    const t = options.get(k) ?? optsByCanon.get(canonical(k));
    const opts = t?.options ?? [];
    const want = a === 'instance' ? ownSource : a === 'frame' ? (t?.frameTarget ?? ownSource) : a;
    if (!opts.some((o) => o.target === want || resolve(o.target) === want)) {
      bad.push(`${k} → ${a} (its targets: ${opts.map((o) => `'${o.name}' ${o.target}`).join(', ') || 'none'})`);
    }
  }
  return { perKey, stray, bad };
}
