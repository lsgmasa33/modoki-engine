/** @modoki/three — Three.js integration (lights, transform propagation). Opt-in. */

export { Light } from './traits/Light';
export { Environment } from './traits/Environment';
export {
  worldTransforms, deactivatedEntities, transformPropagationSystem,
} from './systems/transformPropagationSystem';
