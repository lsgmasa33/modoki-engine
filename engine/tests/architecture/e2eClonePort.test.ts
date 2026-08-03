/** The e2e dev-server port is derived PER CLONE (#20) — several clones share one machine,
 *  and a single hardcoded port meant only one of them could run e2e at a time.
 *
 *  Worth guarding because the failure mode is quiet: collapse the derivation back to a
 *  constant and every clone contends again, while the suite still passes on whichever
 *  clone ran first. */
import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { BASE_E2E_PORT, PORT_SLOTS, clonePort, clonePortOffset } from '../e2e/clonePort';

// The real clone paths this scheme exists to separate (see CLAUDE.md § Clones).
const CLONES = [
  '/Users/dev/Projects/modoki',
  '/Users/dev/Projects/modoki-ai',
  '/Users/dev/Projects/modoki-ai2',
  'C:\\dev\\modoki',
];

describe('e2e clone port derivation (#20)', () => {
  it('is stable — the same clone gets the same port on every run', () => {
    // If this drifted, `lsof -ti :<port>` (the documented orphan recovery) would be
    // chasing a different port each time.
    for (const root of CLONES) {
      expect(clonePort(root), root).toBe(clonePort(root));
    }
  });

  it('separates the clones that actually run side by side', () => {
    const ports = CLONES.map(clonePort);
    expect(new Set(ports).size, `collision among ${JSON.stringify(ports)}`).toBe(CLONES.length);
  });

  it('is sensitive to a sibling-directory suffix, not just the leading path', () => {
    // The whole point: `modoki` and `modoki-ai` differ only by a suffix. A derivation
    // keyed on, say, the parent directory would map them to the same port.
    expect(clonePort('/p/modoki')).not.toBe(clonePort('/p/modoki-ai'));
    expect(clonePort('/p/modoki-ai')).not.toBe(clonePort('/p/modoki-ai2'));
  });

  it('stays inside the reserved high-port block', () => {
    for (const root of [...CLONES, resolve('.'), '/', 'x']) {
      const p = clonePort(root);
      expect(p, root).toBeGreaterThanOrEqual(BASE_E2E_PORT);
      expect(p, root).toBeLessThan(BASE_E2E_PORT + PORT_SLOTS);
    }
  });

  it('keeps a realistic clone set collision-free at the block size we ship (#69)', () => {
    // A tight block is the tempting "cleanup" here, and it is wrong: at 10 slots the
    // birthday odds for 4 clones are ~30%, and the first attempt at #69 really did map
    // two clones on this machine to the SAME port — a per-clone scheme that isn't.
    // 200 slots is what every caller passes; this fails if someone shrinks it.
    const parents = ['/Users/dev/Projects', '/Users/dev2/Projects', '/home/x/src', 'C:\\dev'];
    const names = ['modoki', 'modoki-ai', 'modoki-ai2', 'modoki-win'];
    for (const parent of parents) {
      const ports = names.map((n) => clonePort(`${parent}/${n}`));
      expect(new Set(ports).size, `${parent} → ${JSON.stringify(ports)}`).toBe(names.length);
    }
  });

  it('spreads across the block rather than clustering on the base port', () => {
    // A broken hash (always 0, or a truncation that loses entropy) would still satisfy
    // every assertion above while putting every clone back on one port.
    const offsets = new Set(
      Array.from({ length: 200 }, (_, i) => clonePortOffset(`/Users/dev/Projects/clone-${i}`)),
    );
    expect(offsets.size).toBeGreaterThan(100);
  });
});
