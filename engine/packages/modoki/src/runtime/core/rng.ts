/** Seeded RNG service (Phase 2 — verification harness).
 *
 *  The single sanctioned source of gameplay randomness. Routing all gameplay RNG
 *  through here (instead of `Math.random`) makes a run reproducible: the headless
 *  playtest harness calls `seedRng(n)` and every random decision replays
 *  identically. Production auto-seeds once from entropy at startup so shipped
 *  games still vary launch-to-launch.
 *
 *  Algorithm: mulberry32 — tiny, fast, good distribution, fully deterministic
 *  from a 32-bit seed. NOT cryptographically secure (don't use for tokens).
 *
 *  Cosmetic-only randomness (particle jitter, debug sprites) may stay on
 *  `Math.random` — this is for anything that affects gameplay STATE, which the
 *  harness needs to reproduce.
 *
 *  WORLD-SCOPED (determinism-harness F1): the generator state lives in a
 *  `WeakMap<World>` keyed off the active world (mirroring `worldRegistry`'s
 *  per-world entity/guid indices), NOT a module global. So two coexisting worlds
 *  (editor dual-viewport, a future multi-world game, parallel test files) each
 *  draw from their OWN reproducible sequence instead of interleaving into one
 *  shared stream. The free functions resolve the current world by default (like
 *  `getTime`); pass an explicit `world` to operate on a specific one. Disposing a
 *  world drops its state via GC, so the harness needs no RNG restore on teardown. */

import { type World } from 'koota';
import { getCurrentWorld } from './ecs/worldRegistry';

interface RngState {
  state: number;
}

// Per-world generator state. WeakMap so old worlds GC cleanly.
const rngStates = new WeakMap<World, RngState>();

/** Entropy seed for a freshly-seen world so production runs aren't identical.
 *  ALLOWLISTED Date.now(): this is the sanctioned RNG entropy source (see Phase 0
 *  guard) — the whole point is that nothing ELSE reads wall-clock for randomness. */
function entropySeed(): number {
  return (Date.now() ^ 0x9e3779b9) >>> 0;
}

/** A seed pinned for every world seen from now on, in place of entropy — see `pinFreshWorldSeed`. */
let pinnedFreshSeed: number | null = null;

/** Seed every world first seen AFTER this call with `seed` instead of entropy; `null` restores
 *  entropy. A world that already drew keeps its stream — this is for the moment before a world
 *  exists, which `seedRng` cannot reach.
 *
 *  The gameplay recorder (#1479) needs exactly that moment: a take is recorded from a Play press
 *  and replayed from a page boot, and in both the world is created, and may draw, before any code
 *  outside the engine gets a turn. Seeding it afterwards would leave those first draws on entropy,
 *  so the replay could diverge from the take before its first frame. */
export function pinFreshWorldSeed(seed: number | null): void {
  pinnedFreshSeed = seed === null ? null : seed >>> 0;
}

function rngStateFor(world: World): RngState {
  let s = rngStates.get(world);
  if (!s) {
    s = { state: pinnedFreshSeed ?? entropySeed() };
    rngStates.set(world, s);
  }
  return s;
}

/** Reseed the generator for a world. Same seed → same sequence (the basis of
 *  reproducible playtests). */
export function seedRng(seed: number, world: World = getCurrentWorld()): void {
  rngStateFor(world).state = seed >>> 0;
}

/** Next float in [0, 1). */
export function rngNext(world: World = getCurrentWorld()): number {
  // mulberry32
  const s = rngStateFor(world);
  s.state = (s.state + 0x6d2b79f5) >>> 0;
  let t = s.state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Float in [min, max). */
export function rngFloat(min: number, max: number, world: World = getCurrentWorld()): number {
  return min + rngNext(world) * (max - min);
}

/** Integer in [min, max] inclusive. */
export function rngInt(min: number, max: number, world: World = getCurrentWorld()): number {
  return Math.floor(rngFloat(min, max + 1, world));
}

/** True with probability `p` (default 0.5). */
export function rngBool(p = 0.5, world: World = getCurrentWorld()): boolean {
  return rngNext(world) < p;
}

/** A uniformly-random element of `arr` (undefined if empty). */
export function rngPick<T>(arr: readonly T[], world: World = getCurrentWorld()): T | undefined {
  if (arr.length === 0) return undefined;
  return arr[Math.floor(rngNext(world) * arr.length)];
}
