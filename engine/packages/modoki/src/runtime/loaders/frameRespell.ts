/** A member path's respell for the frame rooted at `frameRoot` — the one half of the #1809 path grammar that needs a
 *  WORLD (the documents that frame was expanded from). Its own module, apart from `templateKeyRecovery.ts`, because that
 *  one is read by the prefab validator, which the dev server loads under Node: the world's modules are browser-side. */

import type { World } from 'koota';
import { frameDocReader } from '../core/ecs/identityParents';
import { getTraitByName } from '../core/ecs/traitRegistry';
import { findEntityById } from '../core/ecs/world';
import type { MemberStep } from '../core/assetRefRules';
import { flatKeyedSteps, type TemplateKeyDoc } from './templateKeyRecovery';

/** The respell `memberPathLookup` takes for a path in the frame rooted at `frameRoot`: {@link flatKeyedSteps} over the
 *  document that frame was expanded from, and the nested ones by source (`frameDocReader`, with the editor's cache under
 *  it). A written path that is not the flat spelling — a document or a scene statement from before #1809 — then still
 *  names its node, and one the documents cannot place names nothing, never a guess. */
export function frameRespell(world: World, frameRoot: number): (path: readonly MemberStep[]) => MemberStep[] {
  // LAZY, and built once: a caller hands one to every lookup, and the exact lookup almost always hits, so the respell
  // mostly never runs. Built eagerly, reading the frame's document walked the whole world (`frameDocReader` maps it
  // by entity) once per TOKEN — a scene load of N entities holding N tokens went quadratic (#1876 close-out review:
  // 126 ms → 2.2 s at 8,000 entities).
  let built: ((path: readonly MemberStep[]) => MemberStep[]) | undefined;
  return (path) => {
    if (!built) {
      const piMeta = getTraitByName('PrefabInstance');
      const root = frameRoot ? findEntityById(frameRoot, world) : undefined;
      const source = root && piMeta && root.has(piMeta.trait) ? (root.get(piMeta.trait) as { source?: string }).source : undefined;
      const reader = frameDocReader(world);
      const doc = source ? reader(source, frameRoot) as TemplateKeyDoc | null | undefined : undefined;
      built = (p) => flatKeyedSteps(p, doc, (g) => reader(g) as TemplateKeyDoc | null | undefined);
    }
    return built(path);
  };
}
