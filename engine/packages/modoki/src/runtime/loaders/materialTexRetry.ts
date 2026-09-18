/** Load-and-retry state for Scene2D's material-sprite textures (#1374).
 *
 *  The material pass asks for its sprite texture every running frame. Before #1374 the only guard
 *  was an in-flight set, released on failure, so a 404 texture was requested again on every dirty
 *  frame. This adds #1371's `loadFailureMemo` with `unknownIs: 'transient'`: Pixi's loader reports
 *  a 404 and a dropped connection as the same opaque error, and backing off bounds a 404 to one
 *  request per backoff step, where sticking would make one network blip permanent. No invalidation
 *  hook is needed — a re-import moves the resolved url (`withCacheBust`), so a fixed texture
 *  arrives under a key this memo has never seen.
 *
 *  A plain module rather than fields on `Scene2DRenderer` so the decisions are testable without a
 *  Pixi app (the renderer's constructor needs one). Rule: docs/architecture.md § "A load failure is
 *  classified before it is remembered". */

import { createLoadFailureMemo } from './loadFailureMemo';
import { rawNow } from '../core/clock';

export class MaterialTexRetry {
  /** url → the generation of the load that owns it. A settle whose generation no longer matches
   *  belongs to a load a `clear()` (teardown) superseded, and must not touch the newer one's entry. */
  private readonly loading = new Map<string, number>();
  private readonly failed = createLoadFailureMemo({ label: 'Scene2D', unknownIs: 'transient' });
  /** One wake per backing-off url: an idle scene has nothing else to dirty it, so without this a
   *  texture whose backoff expired would wait for an unrelated edit to be retried. */
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private generation = 0;

  private readonly load: (url: string) => Promise<unknown>;
  private readonly wake: () => void;

  constructor(load: (url: string) => Promise<unknown>, wake: () => void) {
    this.load = load;
    this.wake = wake;
  }

  /** Start a load for `url` unless one is in flight or the url is backing off. */
  request(url: string): void {
    if (this.loading.has(url) || this.failed.blocked(url)) return;
    const gen = ++this.generation;
    this.loading.set(url, gen);
    this.load(url).then(
      () => {
        if (this.loading.get(url) === gen) { this.loading.delete(url); this.failed.forget(url); }
        this.wake();
      },
      (e: unknown) => {
        const live = this.loading.get(url) === gen;
        if (live) this.loading.delete(url);
        this.failed.record(url, e, live);
        if (live) this.scheduleWake(url);
      },
    );
  }

  /** Teardown (world swap, renderer dispose): forget everything and cancel pending wakes. */
  clear(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.loading.clear();
    this.failed.clear();
  }

  /** Test seam: how many retry wakes are pending. */
  get pendingWakes(): number { return this.timers.size; }

  private scheduleWake(url: string): void {
    const at = this.failed.retryAt(url);
    if (at === undefined || this.timers.has(url)) return;
    this.timers.set(url, setTimeout(() => {
      this.timers.delete(url);
      this.wake();
    }, Math.max(0, at - rawNow())));
  }
}
