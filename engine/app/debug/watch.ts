/** Percept Watch (Phase 6) — a standing, focused, change-detected numeric time-series
 *  over the live ECS world. The THIRD Percept primitive: Snapshot answers "what's true
 *  now", Journal answers "what happened", Watch answers "how did this NUMBER move over
 *  time" (jump overshoot, spring settle, velocity decay) — the animation/physics tuning
 *  questions Claude can't judge from a screenshot.
 *
 *  Pure OBSERVER, editor-side only (this module is imported by agentBridge, which is
 *  stripped from shipped game builds): a single frameDriver callback samples every
 *  active watch each frame by reading the live world. Zero shipped-game cost; never
 *  touches the determinism-guarded runtime; no game instrumentation.
 *
 *  Anti-flood ("focus"): (1) SCOPE — a watch targets one component + optional guid/field
 *  subset, narrow by construction. (2) CHANGE-DETECTION — a value is recorded only when
 *  it moves beyond `epsilon`, so a settled entity emits nothing. (3) BOUNDS — per-series
 *  ring cap + series-cardinality cap + frame decimation + idle auto-expire (a watch not
 *  read for a while is dropped so a forgotten one can't leak per-frame CPU).
 *
 *  Identity: a series is keyed by the entity's stable GUID. A GUID watch is fully stable.
 *  A component watch keys guid-BEARING entities stably; a guid-LESS (fresh, unsaved) entity
 *  falls back to its numeric id, which koota recycles — so for a runtime-spawned, short-lived,
 *  fresh-guid entity (e.g. a prefab re-instantiated every launch) prefer NAME scoping
 *  (`names:[...]`, Batch 3 A): it matches by authored name, auto-joins new spawns, and is stable
 *  across the guid/id churn a guid or numeric-id key can't survive. */

import {
  registerFrameCallback, unregisterFrameCallback, getCurrentWorld,
  findEntity, findEntityByGuid, getAllTraits, readTraitDataFull, getTime, entityRef, EntityAttributes,
} from '@modoki/engine/runtime';

interface Sample { tick: number; value: number }
interface Series { samples: Sample[]; last: number; despawnedAt?: number; name?: string }

interface Watch {
  id: string;
  component: string;
  meta: ReturnType<typeof getAllTraits>[number];
  guids?: Set<string>;      // restrict to these guids; undefined = every entity with the component
  names?: string[];         // case-insensitive substring name filters; NEW matches auto-join (Batch 3 A)
  fields: string[];         // numeric fields sampled
  epsilon: number;
  everyN: number;           // decimation: sample every Nth observed frame
  maxSamples: number;       // ring cap per (entity,field) series
  maxSeries: number;        // cap on MOVER series (never-moved baselines don't count — Batch 3 B)
  moverCount: number;       // series that have recorded ≥1 movement (counts toward maxSeries)
  expireFrames: number;     // absolute cap on observed frames (0 = none)
  idleExpireFrames: number; // drop the watch if not read for this many frames (leak guard)
  frameCount: number;       // observed frames (for decimation + absolute expiry)
  lastReadTick: number;     // Time.frame at last read/start (for idle expiry)
  truncated: boolean;       // hit maxSeries
  series: Map<string, Series>;   // keyed `${guid} ${field}`
  seen: Set<string>;             // guids ever sampled (for despawn detection)
}

const watches = new Map<string, Watch>();
let hookInstalled = false;
let watchSeq = 0;

const MAX_SAMPLES_CEIL = 5000;
const DEFAULT_MAX_SERIES = 512;
const MAX_SERIES_CEIL = 4096; // hard ceiling for the caller-tunable maxSeries (Batch 3 C)
const DEFAULT_IDLE_EXPIRE = 18_000; // ~5 min of frames — a watch not read by then is "forgotten"

const SEP = ' ';
const key = (guid: string, field: string) => `${guid}${SEP}${field}`;
const splitKey = (k: string): [string, string] => {
  const i = k.indexOf(SEP);
  return [k.slice(0, i), k.slice(i + 1)];
};
const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

function numericFields(meta: Watch['meta'], filter?: string[]): string[] {
  return Object.keys(meta.fields).filter((k) => {
    const hint = meta.fields[k] as { type?: string };
    if (hint?.type !== 'number') return false;
    return !filter || filter.includes(k);
  });
}

/** min/max via reduce (spread `Math.min(...arr)` overflows the call stack on a big array). */
function minOf(a: number[]): number { let m = Infinity; for (const x of a) if (x < m) m = x; return m; }
function maxOf(a: number[]): number { let m = -Infinity; for (const x of a) if (x > m) m = x; return m; }
function avgGap(s: Sample[]): number { return s.length < 2 ? 0 : (s[s.length - 1].tick - s[0].tick) / (s.length - 1); }

function ensureHook(): void {
  if (hookInstalled) return;
  hookInstalled = true;
  // Priority 45 — after ECS (0), 3D/2D render (10/20) and editor render (30/40), so
  // per-frame trait read-backs (world transform, skeletal, velocity/isSleeping) are done.
  registerFrameCallback('percept-watch', sampleAllWatches, 45);
}
function teardownHookIfIdle(): void {
  if (watches.size === 0 && hookInstalled) { unregisterFrameCallback('percept-watch'); hookInstalled = false; }
}

function sampleAllWatches(): void {
  if (watches.size === 0) return;
  const world = getCurrentWorld();
  const tick = getTime(world)?.frame ?? 0;
  for (const w of watches.values()) {
    w.frameCount++;
    if (w.frameCount % w.everyN === 0) sampleWatch(w, tick);
    // Auto-expiry: absolute cap, or "forgotten" (not read for idleExpireFrames).
    if ((w.expireFrames > 0 && w.frameCount >= w.expireFrames) || (tick - w.lastReadTick > w.idleExpireFrames)) {
      watches.delete(w.id);
    }
  }
  teardownHookIfIdle();
}

/** The entity's authored name (once, for series identity in the read), or undefined. */
function entityNameOf(id: number): string | undefined {
  const n = (findEntity(id)?.get(EntityAttributes) as { name?: string } | undefined)?.name;
  return typeof n === 'string' && n ? n : undefined;
}

/** Entities a watch currently targets, as {guid,id,name?}. A guid-only watch resolves O(1) via
 *  the guid index; a NAME-scoped watch (Batch 3 A) queries the trait + EntityAttributes so a
 *  runtime-spawned entity whose guid changes every spawn (the sling puck) auto-joins by name; a
 *  bare component watch queries the trait directly (auto-joining new matches) — NEVER via the
 *  expensive full-world getAllEntities(). */
function resolveTargets(w: Watch): { guid: string; id: number; name?: string }[] {
  const out: { guid: string; id: number; name?: string }[] = [];
  const world = getCurrentWorld();
  if (w.guids && !w.names) {
    for (const g of w.guids) {
      const ent = findEntityByGuid(g);
      if (ent && ent.has(w.meta.trait)) out.push({ guid: g, id: ent.id() });
    }
  } else if (w.names || w.guids) {
    // Name-scoped (or guid+name): read EntityAttributes so we can match by name. New spawns whose
    // name matches auto-join — the whole point (a fresh-guid puck has no stable guid to pass).
    try {
      world.query(w.meta.trait, EntityAttributes).updateEach((_: unknown, entity: { id(): number; get(t: unknown): { name?: string } | undefined; has(t: unknown): boolean }) => {
        const guid = String(entityRef(entity));
        const name = String(entity.get(EntityAttributes)?.name ?? '');
        const byName = w.names?.some((n) => name.toLowerCase().includes(n));
        const byGuid = w.guids?.has(guid);
        if (byName || byGuid) out.push({ guid, id: entity.id(), name });
      });
    } catch { /* trait not present in this world */ }
  } else {
    try {
      world.query(w.meta.trait).updateEach((_: unknown, entity: { id(): number; get(t: unknown): unknown; has(t: unknown): boolean }) => {
        out.push({ guid: String(entityRef(entity)), id: entity.id() });
      });
    } catch { /* trait not present in this world */ }
  }
  return out;
}

function sampleWatch(w: Watch, tick: number): void {
  const present = new Set<string>();
  for (const t of resolveTargets(w)) {
    present.add(t.guid);
    const data = readTraitDataFull(t.id, w.meta) as Record<string, unknown> | null;
    if (!data) continue;
    for (const f of w.fields) {
      const v = data[f];
      if (typeof v !== 'number' || Number.isNaN(v)) continue;
      const k = key(t.guid, f);
      let s = w.series.get(k);
      if (!s) {
        // Allocate a BASELINE series freely up to a hard memory ceiling. Baseline (never-moved)
        // series do NOT count toward `maxSeries` — only MOVERS do (below) — so a screen full of
        // static tiles can't crowd out a late-joining mover the way it used to: the sling puck
        // spawned at launch, by which time ~170 static entities had filled the old 512 cap, and its
        // series was silently dropped. Now static baselines are cheap and uncapped-until-OOM, and
        // the mover budget is reserved for things that actually move. (Batch 3 B) An eviction scheme
        // was rejected: at a small cap it thrashes and can drop a just-baselined mover before it
        // records its first movement.
        if (w.series.size >= MAX_SERIES_CEIL) { w.truncated = true; continue; }
        s = { samples: [], last: NaN, name: t.name ?? entityNameOf(t.id) };
        w.series.set(k, s);
      }
      if (s.samples.length === 0) {
        s.samples.push({ tick, value: v }); s.last = v; // baseline — always recorded
      } else if (Math.abs(v - s.last) > w.epsilon) {
        // Movement. The FIRST movement promotes this series to a MOVER; enforce the mover cap there
        // so a huge world's movers stay bounded while its static baselines don't consume the budget.
        if (s.samples.length === 1) {
          if (w.moverCount >= w.maxSeries) { w.truncated = true; continue; }
          w.moverCount++;
        }
        s.samples.push({ tick, value: v });
        if (s.samples.length > w.maxSamples) s.samples.shift(); // ring cap
        s.last = v;
      }
      if (s.despawnedAt !== undefined) s.despawnedAt = undefined; // rejoined → un-freeze
    }
    w.seen.add(t.guid);
  }
  // Despawn (Decision B): an entity sampled before but now gone → freeze its series with a
  // one-time despawn marker (cleared above if it later rejoins).
  for (const g of w.seen) {
    if (present.has(g)) continue;
    for (const f of w.fields) {
      const s = w.series.get(key(g, f));
      if (s && s.despawnedAt === undefined) s.despawnedAt = tick;
    }
  }
}

// ── Public API (wired to bridge ops) ─────────────────────────────────────────

export interface StartWatchParams {
  component: string;
  guids?: string[];
  names?: string[];
  fields?: string[];
  epsilon?: number;
  everyNFrames?: number;
  maxSamples?: number;
  maxSeries?: number;
  expireFrames?: number;
}

export function startWatch(p: StartWatchParams): { ok: boolean; id?: string; component?: string; fields?: string[]; matched?: string[]; unmatchedGuids?: string[]; names?: string[]; matchedNow?: number; error?: string } {
  const meta = getAllTraits().find((m) => m.name === p.component);
  if (!meta) return { ok: false, error: `unknown component "${p.component}"` };
  const fields = numericFields(meta, p.fields);
  if (fields.length === 0) {
    return { ok: false, error: `no numeric fields on "${p.component}"${p.fields ? ` matching ${JSON.stringify(p.fields)}` : ''}` };
  }
  // Name filters (Batch 3 A): case-insensitive substrings. NOT hard-failed on zero current matches,
  // unlike guids — the point is to catch entities that spawn LATER (a fresh-guid puck at launch), so
  // "nothing matches yet" is legitimate. `matchedNow` reports the current count so a typo that will
  // never match (and no imminent spawn) is at least visible.
  const names = p.names && p.names.length ? p.names.map((n) => n.toLowerCase()).filter(Boolean) : undefined;
  // Resolve caller-supplied guids AT START, not silently at sample time. An unresolvable or
  // stale guid (routine — ids/entities rebuild on scene reload and play→stop) otherwise
  // produced a watch that recorded NOTHING forever, which reads back identically to a
  // "settled, didn't move" result — the exact false-negative an agent tuning a spring/jump
  // would trust. Mirror dispatch-action's phantom-guid guard: fail if ALL guids are dead,
  // and surface the partial miss otherwise. (A guid must also carry the component to record.)
  let matched: string[] | undefined;
  let unmatchedGuids: string[] | undefined;
  if (p.guids && p.guids.length) {
    const hit: string[] = [];
    const miss: string[] = [];
    for (const g of p.guids) {
      const ent = findEntityByGuid(g);
      (ent && ent.has(meta.trait) ? hit : miss).push(g);
    }
    if (hit.length === 0) {
      return {
        ok: false,
        error: `none of the ${p.guids.length} guid(s) resolved to a live entity carrying "${p.component}" — they may be stale (ids/entities rebuild on scene reload and play→stop). Re-read them with get_scene_state.`,
        unmatchedGuids: miss,
      };
    }
    matched = hit;
    if (miss.length) unmatchedGuids = miss;
  }
  ensureHook();
  const id = `w${++watchSeq}`;
  const nowTick = getTime(getCurrentWorld())?.frame ?? 0;
  const watch: Watch = {
    id, component: p.component, meta,
    guids: p.guids && p.guids.length ? new Set(p.guids) : undefined,
    names,
    fields,
    epsilon: p.epsilon != null && p.epsilon >= 0 ? p.epsilon : 1e-4,
    everyN: Math.max(1, Math.floor(p.everyNFrames ?? 1)),
    maxSamples: clamp(Math.floor(p.maxSamples ?? 600), 1, MAX_SAMPLES_CEIL),
    maxSeries: clamp(Math.floor(p.maxSeries ?? DEFAULT_MAX_SERIES), 1, MAX_SERIES_CEIL),
    moverCount: 0,
    expireFrames: Math.max(0, Math.floor(p.expireFrames ?? 0)),
    idleExpireFrames: DEFAULT_IDLE_EXPIRE,
    frameCount: 0,
    lastReadTick: nowTick,
    truncated: false,
    series: new Map(),
    seen: new Set(),
  };
  watches.set(id, watch);
  // Count entities matching a name filter right now (informational — see above).
  const matchedNow = names ? resolveTargets(watch).length : undefined;
  return {
    ok: true, id, component: p.component, fields,
    ...(matched ? { matched } : {}), ...(unmatchedGuids ? { unmatchedGuids } : {}),
    ...(names ? { names, matchedNow } : {}),
  };
}

/** Read a watch's change-filtered series + per-series summary stats (W3). Resets the
 *  idle-expiry clock (an actively-read watch is not "forgotten"). */
export function readWatch(id: string, opts?: { clear?: boolean; name?: string; guids?: string[]; limit?: number }): unknown {
  const w = watches.get(id);
  if (!w) return { ok: false, error: `no watch "${id}"` };
  const cur = getTime(getCurrentWorld())?.frame ?? 0;
  w.lastReadTick = cur;
  // Read-side filters (Batch 3 D): isolate the entity you care about even in a broad watch, so a
  // "watch all Transform" read doesn't blow the response cap with hundreds of series.
  const nameFilter = opts?.name?.toLowerCase();
  const guidFilter = opts?.guids && opts.guids.length ? new Set(opts.guids) : undefined;
  const limit = opts?.limit != null && opts.limit >= 0 ? Math.floor(opts.limit) : undefined;
  const series = [] as unknown[];
  let matchedSeries = 0;
  for (const [k, s] of w.series) {
    const [guid, field] = splitKey(k);
    if (guidFilter && !guidFilter.has(guid)) continue;
    if (nameFilter && !(s.name ?? '').toLowerCase().includes(nameFilter)) continue;
    matchedSeries++;
    if (limit != null && series.length >= limit) continue; // count every match; emit up to `limit`
    const vals = s.samples.map((x) => x.value);
    const lastTick = s.samples.length ? s.samples[s.samples.length - 1].tick : 0;
    series.push({
      guid, ...(s.name ? { name: s.name } : {}), field, count: s.samples.length,
      despawnedAt: s.despawnedAt,
      stats: vals.length ? {
        first: vals[0],
        last: vals[vals.length - 1],
        min: minOf(vals),
        max: maxOf(vals),
        delta: vals[vals.length - 1] - vals[0],
        // "settled" = the value stopped moving. Change-detection only records movement,
        // so recording GOING QUIET is the signal — judged relative to how often THIS
        // series records (a coarse-epsilon value that advances slowly records sparsely
        // yet isn't settled), so: last sample older than a few typical inter-sample gaps.
        settled: s.despawnedAt === undefined && (cur - lastTick) > Math.max(30, 3 * avgGap(s.samples)),
      } : null,
      samples: s.samples,
    });
  }
  const out = {
    ok: true, id, component: w.component, fields: w.fields, frameCount: w.frameCount,
    truncated: w.truncated || undefined,
    seriesTotal: matchedSeries,
    ...(limit != null && matchedSeries > series.length ? { seriesTruncated: true } : {}),
    series,
  };
  // Clear empties every series → they all revert to baseline-pending, so the mover budget frees up.
  if (opts?.clear) { for (const s of w.series.values()) s.samples = []; w.moverCount = 0; }
  return out;
}

/** List active watches (id + focus + series count). */
export function listWatches(): unknown {
  return {
    ok: true,
    watches: Array.from(watches.values()).map((w) => ({
      id: w.id, component: w.component,
      guids: w.guids ? Array.from(w.guids) : (w.names ? undefined : 'all'),
      ...(w.names ? { names: w.names } : {}),
      fields: w.fields, frameCount: w.frameCount, seriesCount: w.series.size, truncated: w.truncated || undefined,
    })),
  };
}

/** Test hook: drive one sampling pass synchronously (normally the frameDriver rAF
 *  callback does this). Not for production use. */
export function __tickWatchesForTest(): void {
  sampleAllWatches();
}

/** Clear one watch (by id) or ALL (no id). */
export function clearWatch(id?: string): unknown {
  if (id) watches.delete(id);
  else watches.clear();
  teardownHookIfIdle();
  return { ok: true, remaining: watches.size };
}
