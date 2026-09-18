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

import { createLoadFailureMemo } from '../core/loadFailureMemo';

export class MaterialTexRetry {
  /** url → the generation of the load that owns it. A settle whose generation no longer matches
   *  belongs to a load a `clear()` (teardown) superseded, and must not touch the newer one's entry. */
  private readonly loading = new Map<string, number>();
  /** `onRetryDue` wakes the renderer when a url's backoff expires: an idle scene has nothing else
   *  to dirty it, so without the wake a due retry would wait for an unrelated edit. */
  private readonly failed = createLoadFailureMemo({ label: 'Scene2D', unknownIs: 'transient', onRetryDue: () => this.wake() });
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
      },
    );
  }

  /** url → the consumers waiting to bind it once resident (#1397). */
  private readonly waiters = new Map<string, Array<{ dead: () => boolean; bind: () => void }>>();

  /** Wait for `url` on behalf of a consumer that is built ONCE and never asks again — a sprite
   *  slot (`Scene2D.makeSprite`). Kicks the load; {@link drain} binds it when it lands, and
   *  re-requests it (after the backoff) when it failed. `dead` reports that the consumer was
   *  destroyed, so a waiter for a url its slot no longer wants is dropped, never bound. */
  whenResident(url: string, dead: () => boolean, bind: () => void): void {
    let list = this.waiters.get(url);
    if (!list) { list = []; this.waiters.set(url, list); }
    list.push({ dead, bind });
    this.request(url);
  }

  /** Bind every waiter whose url is now resident (`isResident`), drop dead ones, and re-request the
   *  rest — a no-op while a url is in flight or backing off, a fresh load once its backoff
   *  expired. The caller runs it at the top of a frame that renders; this class's wakes (a load
   *  landed, a retry is due) are what make that frame happen on an idle surface. Returns true when
   *  it bound anything. */
  drain(isResident: (url: string) => boolean): boolean {
    let bound = false;
    for (const [url, list] of this.waiters) {
      const live = list.filter((w) => !w.dead());
      if (!live.length) { this.waiters.delete(url); continue; }
      if (isResident(url)) {
        this.waiters.delete(url);
        for (const w of live) w.bind();
        bound = true;
      } else {
        if (live.length !== list.length) this.waiters.set(url, live);
        this.request(url);
      }
    }
    return bound;
  }

  /** Test seam / fast path: how many urls have waiters. */
  get waitingUrls(): number { return this.waiters.size; }

  /** Teardown (world swap, renderer dispose): forget everything and cancel pending wakes. */
  clear(): void {
    this.loading.clear();
    this.failed.clear();
    this.waiters.clear();
  }

  /** Test seam: how many retry wakes are pending. */
  get pendingWakes(): number { return this.failed.pendingWakes; }
}
