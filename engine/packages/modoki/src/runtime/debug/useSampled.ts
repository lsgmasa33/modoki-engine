/** useSampledHistory — poll `sample()` every `ms` into a fixed-length ring buffer,
 *  returning a FRESH array each tick (so a downstream <Sparkline>'s [data] effect
 *  re-runs). Shared by the floating stat widgets. */

import { useEffect, useRef, useState } from 'react';

export function useSampledHistory(sample: () => number, ms: number, cap: number): number[] {
  const ref = useRef<number[]>([]);
  const sampleRef = useRef(sample);
  sampleRef.current = sample;
  const [, setTick] = useState(0);

  useEffect(() => {
    const push = () => {
      const buf = ref.current;
      buf.push(sampleRef.current());
      if (buf.length > cap) buf.shift();
      setTick((t) => t + 1);
    };
    push();
    const id = window.setInterval(push, ms);
    return () => window.clearInterval(id);
  }, [ms, cap]);

  return [...ref.current];
}

/** A bare interval re-render (for readouts that don't keep history).
 *
 *  `ms <= 0` means DON'T TICK, not "tick as fast as possible". A hook cannot be called
 *  conditionally, so a component that is currently hidden has no way to opt out except by
 *  passing a rate — and `setInterval(fn, 0)` would spin a hidden overlay at full speed on the
 *  exact devices these diagnostics exist for. */
export function useInterval(ms: number): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!(ms > 0)) return;
    const id = window.setInterval(() => setTick((t) => t + 1), ms);
    return () => window.clearInterval(id);
  }, [ms]);
}
