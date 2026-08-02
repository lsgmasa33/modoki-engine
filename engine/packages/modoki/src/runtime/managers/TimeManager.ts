/** TimeManager — the Manager half of "time" (the System half is `timeSystem`,
 *  which advances one monotonic, pause-aware `Time.elapsed` every frame).
 *
 *  This owns event **anchors** (offsets into that elapsed) and exposes derived
 *  reads — `timeSinceGameStart`, `timeSinceSceneLoad`, and arbitrary named
 *  stopwatches via `mark`/`timeSince`. It never ticks and never resets the
 *  clock; an anchor is just `elapsed` captured at an event, and `timeSinceX =
 *  now − anchorX`. Because it derives from the already-pause-aware `elapsed`,
 *  pause and editor Play/Stop fall out for free.
 *
 *  Registered once at core startup (app scope → engine infrastructure, alive the
 *  whole session, independent of scene or game). Exposes its fixed accessors to
 *  UI text bindings via the read-source registry.
 *
 *  See docs/managers-and-systems.md ("Time"). */

import { getCurrentWorld, onWorldSwap } from '../core/ecs/world';
import { getTime } from '../core/getTime';
import { getPlayState, onPlayStateChange } from '../core/playState';
import { registerReadSource, unregisterReadSource } from '../core/readSourceRegistry';
import type { ManagerDef } from './managerRegistry';

const READ_SOURCES = ['deltaTime', 'timeSinceGameStart', 'timeSinceSceneLoad'] as const;

/** Public surface of the {@link timeManager} singleton — event anchors and derived
 *  reads over the pause-aware engine clock. See the module doc above. */
export interface TimeManager extends ManagerDef {
  /** Narrowed to the no-arg form the implementation actually has — inheriting
   *  `ManagerDef`'s `init(ctx: ManagerContext)` would force every direct caller to
   *  fabricate a context this manager never reads (#37). Required, not optional: both
   *  are always implemented. Rule + rationale: `docs/managers-and-systems.md`. */
  init(): void;
  dispose(): void;
  /** Stamp a named anchor at the current elapsed time. */
  mark(name: string): void;
  /** Seconds since a named anchor was stamped (0 if never stamped). */
  timeSince(name: string): number;
  /** Current frame delta (seconds), pause- and timeScale-aware. */
  readonly deltaTime: number;
  /** Seconds since the game (session) started, or since the last editor Play. */
  readonly timeSinceGameStart: number;
  /** Seconds since the current scene finished loading. */
  readonly timeSinceSceneLoad: number;
}

class TimeManagerImpl implements ManagerDef {
  name = 'engine.time';
  scope = 'app' as const;

  private anchors = new Map<string, number>();
  private unsubs: Array<() => void> = [];

  /** Pause-aware absolute clock from `timeSystem`; 0 before the Time singleton exists. */
  private now(): number {
    return getTime(getCurrentWorld())?.elapsed ?? 0;
  }

  init(): void {
    // Shipped app starts in 'playing' with no transition — stamp immediately.
    if (getPlayState() === 'playing') this.mark('gameStart');
    this.mark('sceneLoad');

    // Re-anchor gameStart on every entry into Playing (editor Stop→Play).
    this.unsubs.push(onPlayStateChange(() => {
      if (getPlayState() === 'playing') this.mark('gameStart');
    }));
    // Re-anchor sceneLoad on every scene swap.
    this.unsubs.push(onWorldSwap(() => this.mark('sceneLoad')));

    registerReadSource('deltaTime', () => this.deltaTime);
    registerReadSource('timeSinceGameStart', () => this.timeSinceGameStart);
    registerReadSource('timeSinceSceneLoad', () => this.timeSinceSceneLoad);
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    for (const n of READ_SOURCES) unregisterReadSource(n);
    this.anchors.clear();
  }

  // ── generic layer (open-ended; games invent their own) ──
  /** Stamp a named anchor at the current elapsed time. */
  mark(name: string): void {
    this.anchors.set(name, this.now());
  }
  /** Seconds since a named anchor was stamped (0 if never stamped). */
  timeSince(name: string): number {
    return this.now() - (this.anchors.get(name) ?? this.now());
  }

  // ── fixed accessors (sugar over the generic layer; no duplicate state) ──
  get deltaTime(): number {
    return getTime(getCurrentWorld())?.delta ?? 0;
  }
  get timeSinceGameStart(): number {
    return this.timeSince('gameStart');
  }
  get timeSinceSceneLoad(): number {
    return this.timeSince('sceneLoad');
  }
}

/** The singleton TimeManager. Registered by core (app/ecs/register.ts); call its
 *  methods by importing this directly. Typed as {@link TimeManager} (not the
 *  `Impl` class) so the public surface — and the generated API reference — show
 *  the documented interface, not the private implementation. */
export const timeManager: TimeManager = new TimeManagerImpl();
