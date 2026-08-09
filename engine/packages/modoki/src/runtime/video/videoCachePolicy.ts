/** Cache admission + eviction policy for downloaded video — PURE, so the decision
 *  that actually matters (what gets thrown away) is testable without a filesystem,
 *  a network, or a browser.
 *
 *  The rule is least-recently-USED, not least-recently-downloaded: a clip the player
 *  keeps returning to should outlive one they fetched once and never watched again.
 *
 *  ## Why admission can FAIL rather than silently evict everything
 *
 *  A budget exists to bound disk use, but "make room at any cost" is the wrong
 *  reading of it. Evicting five clips a game is actively using to admit a sixth
 *  produces thrashing — every clip re-downloads on next use, and the player pays for
 *  it in bandwidth while the cache reports itself healthy. So:
 *   - PINNED entries are never evicted (a game marks what it is about to need);
 *   - if the incoming clip cannot fit even after evicting every unpinned entry, the
 *     admission FAILS LOUDLY instead of emptying the cache for something that was
 *     never going to fit;
 *   - a single clip larger than the entire budget is rejected outright, with its own
 *     reason — that is a configuration mistake, not a capacity problem, and it should
 *     not read as "cache full". */

export interface CacheEntry {
  /** Stable key — the asset GUID + content hash, so a re-import is a different entry. */
  key: string;
  bytes: number;
  /** Monotonic use counter or timestamp; higher = more recent. Compared, never interpreted. */
  lastUsed: number;
  /** Never evicted. For clips a game has declared it is about to need. */
  pinned?: boolean;
}

export type AdmissionResult =
  /** Admit, after deleting `evict` (possibly empty). */
  | { ok: true; evict: string[] }
  /** Refuse, and why. Nothing should be deleted. */
  | { ok: false; reason: 'exceeds-budget' | 'cannot-fit'; needed: number; freeable: number };

export interface AdmissionRequest {
  entries: readonly CacheEntry[];
  /** Size of the clip being admitted. */
  incomingBytes: number;
  /** Total cache budget in bytes. */
  budgetBytes: number;
  /** Key being admitted — if already present it is REPLACED, so its bytes are freed. */
  incomingKey?: string;
}

export function totalBytes(entries: readonly CacheEntry[]): number {
  return entries.reduce((n, e) => n + e.bytes, 0);
}

/** Decide whether a clip can be admitted, and what to evict to make room.
 *
 *  Never mutates its input, and returns the eviction list rather than performing it,
 *  so a caller can apply it transactionally (delete, then write) and a test can assert
 *  the decision without any I/O. */
export function planAdmission(req: AdmissionRequest): AdmissionResult {
  const { entries, incomingBytes, budgetBytes, incomingKey } = req;

  // A clip bigger than the whole budget can never be cached, no matter what we drop.
  // Distinguished from 'cannot-fit' because the fix is different: raise the budget or
  // shrink the clip, rather than free space.
  if (incomingBytes > budgetBytes) {
    return { ok: false, reason: 'exceeds-budget', needed: incomingBytes, freeable: budgetBytes };
  }

  // Re-admitting an existing key REPLACES it, so its current bytes are already free.
  const others = incomingKey ? entries.filter((e) => e.key !== incomingKey) : entries;

  const used = totalBytes(others);
  if (used + incomingBytes <= budgetBytes) return { ok: true, evict: [] };

  // Evict least-recently-used first, skipping pinned entries.
  const candidates = others.filter((e) => !e.pinned).sort((a, b) => a.lastUsed - b.lastUsed);
  const freeable = totalBytes(candidates);

  // Even dropping everything droppable leaves too little — refuse rather than empty
  // the cache for a clip that still will not fit.
  if (used - freeable + incomingBytes > budgetBytes) {
    return {
      ok: false,
      reason: 'cannot-fit',
      needed: used + incomingBytes - budgetBytes,
      freeable,
    };
  }

  const evict: string[] = [];
  let freed = 0;
  for (const c of candidates) {
    if (used - freed + incomingBytes <= budgetBytes) break;
    evict.push(c.key);
    freed += c.bytes;
  }
  return { ok: true, evict };
}

/** Human-readable explanation of a refusal — used in the loud failure, so the message
 *  says what to DO rather than just that something went wrong. */
export function explainRefusal(r: Extract<AdmissionResult, { ok: false }>, budgetBytes: number): string {
  const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (r.reason === 'exceeds-budget') {
    return `video is ${mb(r.needed)} but the whole cache budget is ${mb(budgetBytes)} — `
      + 'raise build.videoCacheBudgetMB or re-import the clip smaller. It can never be cached as-is.';
  }
  return `need ${mb(r.needed)} more than the ${mb(budgetBytes)} budget allows; only ${mb(r.freeable)} `
    + 'is evictable (the rest is pinned). Unpin something or raise the budget.';
}
