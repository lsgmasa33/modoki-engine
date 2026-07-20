/** Debounced auto-save for a value that mutates frequently — extracted from the Particle
 *  Editor so the timing-sensitive logic (debounce, skip-when-saved, mark-saved-on-success)
 *  can be unit-tested without mounting the WebGPU editor. */

import { useEffect, useRef, useCallback } from 'react';

/**
 * Persist `value` to disk on a trailing debounce. Each time `value` changes, schedules
 * `write(value)` to run `delay` ms after the *latest* change — so a burst of rapid edits
 * (slider/curve drags) collapses into a single write. A write is skipped while `value` is
 * still the exact reference last marked saved, so:
 *   - loading/opening a value never rewrites it (call {@link markSaved} right after load),
 *   - a successful write isn't immediately re-saved.
 *
 * `write` resolves `true` on success (the value is then marked saved) or `false`/throws on
 * failure (the value stays dirty; the caller surfaces the error + a later edit retries).
 *
 * @returns `markSaved(value)` — imperatively record a value as already-persisted, without
 *   writing. Use it when seeding the value from disk (load) so opening doesn't trigger a save.
 */
export function useDebouncedSave<T>(
  value: T | null,
  write: (value: T) => Promise<boolean>,
  delay: number,
): { markSaved: (value: T) => void } {
  const savedRef = useRef<T | null>(null);
  const markSaved = useCallback((v: T) => { savedRef.current = v; }, []);

  useEffect(() => {
    if (value == null || value === savedRef.current) return; // nothing to persist
    const pending = value;
    const id = setTimeout(() => {
      Promise.resolve(write(pending))
        .then((ok) => { if (ok) savedRef.current = pending; })
        .catch(() => { /* stays dirty — write() reports the failure to the user */ });
    }, delay);
    return () => clearTimeout(id); // a newer change arrived first → reset the debounce
  }, [value, write, delay]);

  return { markSaved };
}
