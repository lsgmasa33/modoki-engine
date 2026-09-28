/** prefabApplyOptions — WHICH prefabs each listed key can be applied to (#1693, owner ruling C), and its default.
 *
 *  For every listed key: the prefabs on the instance's chain it can be written to, and the default (ruling (a)). What
 *  writing it there DOES is not said here (#1736): that is the plan's per-key effect (`previewApply` → `KeyEffect`,
 *  worded by `describeEffect`), which the dialog and the agent op render. This module used to word each target on its
 *  own, key by key, and so could not see an effect that exists only across keys (two frames writing one template field,
 *  one frame's write hiding another's U13). Both this and `planApply` read the same rules from `prefabApplyTargets.ts`,
 *  so what is offered is what is written. */

import { getTraitByName } from '../../runtime/core/ecs/traitRegistry';
import { readTraitData } from '../../runtime/core/ecs/entityUtils';
import { isGuid, resolveRef } from '../../runtime/loaders/assetManifest';
import { frameBase, ownedRootAt, levelDoc } from './prefabBase';
import { memberPathSteps } from '../../runtime/core/assetRefRules';
import { chainSlots, resolveKeyLevel, defaultKeyLevel } from './prefabApplyTargets';
import { toLocalIdKey, splitNestedKey } from './overrideKeyGrammar';
import { getCachedPrefabSync, type PrefabFile } from './prefab';

export interface ApplyTargetOption {
  /** The prefab's guid (its `PrefabInstance.source`): what `ApplyTargets` names it by. */
  target: string;
  /** The prefab's display name. */
  name: string;
}

export interface KeyTargets {
  options: ApplyTargetOption[];
  defaultTarget: string;
  /** The prefab of the frame the key belongs to — `'frame'` names it: the instance's own for its own keys, the NESTED
   *  instance's for a U14 key (`keys.nested`). */
  frameTarget: string;
}

/** The targets of each of `keys` (as the listing spells them) on the instance rooted at `rootInstanceId`, whose
 *  document is `prefab`. A stored root nothing encloses has one target per key, its own prefab. */
export function applyTargetOptions(rootInstanceId: number, prefab: PrefabFile, keys: readonly string[]): Map<string, KeyTargets> {
  const out = new Map<string, KeyTargets>();
  const base = frameBase(rootInstanceId);
  const piMeta = getTraitByName('PrefabInstance');
  const ownSource = piMeta ? ((readTraitData(rootInstanceId, piMeta)?.source as string) || '') : '';
  const frameName = prefab.name || ownSource;
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
      options.push({ target: levelSource(j), name: levelName(j) });
    }
    const def = base ? defaultKeyLevel(base, slots, prefab, canon) : n;
    out.set(key, { options, defaultTarget: levelSource(def), frameTarget: levelSource(n) });
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
