/** @modoki/three — Three.js integration (lights, environment, fog). Opt-in.
 *
 *  What is left here is genuinely Three-specific: traits that only mean something to a
 *  Three.js scene graph. `transformPropagationSystem` / `worldTransforms` /
 *  `deactivatedEntities` moved to `runtime/core/ecs/transformPropagationSystem` in P5 of
 *  the module-boundaries plan — they are ECS parent-chain composition, not a renderer
 *  concern, and ten runtime subsystems consume them. They are STILL re-exported from here
 *  so `@modoki/engine/three` keeps its exact public surface for existing consumers
 *  (`games/**` included); new code should import them from `@modoki/engine/runtime`. */

export { Light } from './traits/Light';
export { Environment } from './traits/Environment';
export { Fog } from './traits/Fog';
export {
  worldTransforms, deactivatedEntities, transformPropagationSystem,
} from '../runtime/core/ecs/transformPropagationSystem';
