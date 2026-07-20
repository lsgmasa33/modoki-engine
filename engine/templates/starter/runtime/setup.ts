/** Game-specific systems + trait registration for this project.
 *
 *  A "hello world" project has none yet. Register your own ECS systems, custom
 *  shaders, managers, and trait editor metadata here — they're set up when the
 *  game loads and torn down on teardown, without touching engine systems.
 *
 *  Example:
 *    import { registerSystem, unregisterSystem, SYSTEM_PRIORITY } from '@modoki/engine/runtime';
 *    export function registerGameSystems() {
 *      registerSystem('my-game/spin', spinSystem, SYSTEM_PRIORITY.UPDATE);
 *    }
 *    export function unregisterGameSystems() {
 *      unregisterSystem('my-game/spin');
 *    }
 */

export function registerGameSystems(): void {
  // No game systems yet — add yours here.
}

export function unregisterGameSystems(): void {
  // Mirror of registerGameSystems — unregister everything you registered above.
}
