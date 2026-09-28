/** prefabTemplateValue — the ONE way Apply writes a live value into a prefab template (#1659, invariant I8).
 *
 *  A template holds no identity of one instance: a ref from one member to another is written as a member TOKEN (a
 *  path through the template), which every instance resolves to its own member (#1352). Before #1659 only Apply's
 *  value overlay tokenized. The added-component seed (the other fields of a partly applied component), promotion's
 *  plain rows and a promoted reference node's overrides copied the live guids verbatim — so the template named
 *  instance 1's entities, and every other instance's copy pointed into instance 1.
 *
 *  {@link templateValueWriter} is built per written frame and answers every writer:
 *  - **exclusion**: a field kept out of every template (`isTemplateExcludedField` — a runtime read-back, the scene-only
 *    `editorFolder`), and, for a whole bag, a BLANK asset ref (`authoredAssetRefs.test.ts`, #53);
 *  - **tokenizing**: a string equal to the guid of an entity the template can name — a member of the written frame
 *    (`memberPathIndex`), a node this same Apply promotes ({@link TemplateValueWriter.promote}), or, for a value that
 *    lives in a frame nested below the written one, a member of that frame first, climbing out as the loader climbs a
 *    `^` (`templateFrameClimber`).
 *  A live ref no frame up to the written one can name is written as it is, as before. */

import { getCurrentWorld } from '../../runtime/core/ecs/world';
import { templateFrameClimber } from '../../runtime/core/ecs/identityParents';
import { getTraitByName, type TraitMeta } from '../../runtime/core/ecs/traitRegistry';
import { memberPathIndex } from '../../runtime/loaders/loadSceneFile';
import { REF_FIELDS_BY_TRAIT } from '../../runtime/loaders/sceneValidation';
import { mapStringValues, memberPathSteps } from '../../runtime/core/assetRefRules';
import { memberToken, type MemberStep } from '../../runtime/core/templateRefs';
import { isTemplateExcludedField } from './prefab';

export interface TemplateValueWriter {
  /** The frame root whose template is written. */
  readonly root: number;
  /** `v` as the template holds it, for a value applied in frame `at` (default: the written frame). */
  value(v: unknown, at?: number): unknown;
  /** One field's value for the template, or `excluded` for a field no template carries. */
  field(meta: TraitMeta, field: string, v: unknown, at?: number): { value: unknown } | { excluded: true };
  /** A whole live trait bag as the template holds it: excluded fields and blank asset refs dropped, refs tokenized. */
  bag(meta: TraitMeta | undefined, bag: Record<string, unknown>, at?: number): Record<string, unknown>;
  /** `v` as the template holds it, for a value that applies in `frames[0]`, whose `^` climbs step through the rest in
   *  order — the last is the written frame. For a PROMOTED reference row, whose frames are not linked to the written one
   *  yet (a node the scene added has no row to climb by until the promotion lands). */
  valueVia(v: unknown, frames: readonly number[]): unknown;
  /** A node this Apply promotes will be the written frame's member at `steps`: a ref to it tokenizes to that path. */
  promote(guid: string, steps: MemberStep[]): void;
  /** The path the written frame names live entity guid `guid` by — a member's, or a promoted node's. */
  pathOf(guid: string): MemberStep[] | undefined;
}

export function templateValueWriter(root: number): TemplateValueWriter {
  const world = getCurrentWorld();
  const eaMeta = getTraitByName('EntityAttributes');
  const promoted = new Map<string, MemberStep[]>();
  const frames = new Map<number, Map<string, MemberStep[]>>();
  const pathsIn = (frame: number): Map<string, MemberStep[]> => {
    let out = frames.get(frame);
    if (out) return out;
    out = new Map();
    if (eaMeta) {
      for (const [key, target] of memberPathIndex(world, frame)) {
        const guid = target ? (target.get(eaMeta.trait) as { guid?: string }).guid : '';
        if (guid) out.set(guid, memberPathSteps(key));
      }
    }
    frames.set(frame, out);
    return out;
  };
  const pathOf = (guid: string): MemberStep[] | undefined => promoted.get(guid) ?? pathsIn(root).get(guid);
  let climb: ReturnType<typeof templateFrameClimber> | undefined;
  const value = (v: unknown, at = root): unknown => mapStringValues(v, (str) => {
    if (!str) return str;
    let frame = at;
    for (let up = 0; frame && up < 64; up++) {
      const p = frame === root ? pathOf(str) : pathsIn(frame).get(str);
      if (p) return memberToken(up, p);
      if (frame === root) break; // the written frame is the outermost one the template can name
      frame = (climb ??= templateFrameClimber(world))(frame, 1);
    }
    return str;
  });
  const valueVia = (v: unknown, frames: readonly number[]): unknown => mapStringValues(v, (str) => {
    if (!str) return str;
    for (let up = 0; up < frames.length; up++) {
      const f = frames[up]!;
      const p = f === root ? pathOf(str) : pathsIn(f).get(str);
      if (p) return memberToken(up, p);
    }
    return str;
  });
  return {
    root,
    value,
    valueVia,
    field: (meta, field, v, at) => (isTemplateExcludedField(meta, field) ? { excluded: true } : { value: value(v, at) }),
    bag: (meta, bag, at) => {
      const out: Record<string, unknown> = {};
      const refs = new Set(meta ? REF_FIELDS_BY_TRAIT[meta.name] ?? [] : []);
      for (const [k, v] of Object.entries(bag)) {
        if (meta && isTemplateExcludedField(meta, k)) continue;
        if (refs.has(k) && v === '') continue;
        out[k] = value(v, at);
      }
      return out;
    },
    promote: (guid, steps) => { if (guid) promoted.set(guid, steps); },
    pathOf,
  };
}
