// @vitest-environment jsdom
/** The shared countdown (#1879 review F2). One banner, so two countdowns must not share it: the second WAITS for the
 *  first, and the visible Cancel always cancels the countdown it belongs to. Measured before the fix: a game-code
 *  countdown with a refresh countdown started over it — the one visible Cancel cancelled the refresh, and the hidden
 *  game-code countdown still elapsed (its reload discards unsaved work). And a countdown over the persistent "Running
 *  STALE" banner erased it for good.
 *  Mutations, measured: `if (running) waiting.push(begin); else begin();` → `begin();` → the first case goes red; the
 *  persistent restore in `nextCountdown` dropped → "the persistent banner comes back" goes red. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startCountdown, showBanner } from '../../app/debug/countdownBanner';

const banner = () => document.querySelector('[data-ui-id="hmr.banner"]') as HTMLElement | null;
const press = (id: string) => (document.querySelector(`[data-ui-id="hmr.banner.${id}"]`) as HTMLButtonElement).click();

function countdown(name: string, log: string[]) {
  return startCountdown({
    text: (ms) => `${name} in ${Math.ceil(ms / 1000)}s`,
    now: { id: 'now', label: 'Now' },
    onElapse: () => log.push(`${name}:elapsed`),
    onCancel: () => log.push(`${name}:cancelled`),
  });
}

beforeEach(() => { vi.useFakeTimers(); document.body.innerHTML = ''; });
afterEach(() => { vi.useRealTimers(); });

describe('startCountdown', () => {
  it('a second countdown waits for the first, and a Cancel cancels the visible one', () => {
    const log: string[] = [];
    countdown('game', log);
    countdown('refresh', log);
    expect(document.querySelectorAll('[data-ui-id="hmr.banner"]')).toHaveLength(1);
    expect(banner()!.textContent).toContain('game in 5s');
    press('cancel');
    expect(log).toEqual(['game:cancelled']);
    expect(banner()!.textContent, 'the queued one starts once the first ends').toContain('refresh in 5s');
    vi.advanceTimersByTime(5250);
    expect(log).toEqual(['game:cancelled', 'refresh:elapsed']);
    expect(banner()).toBeNull();
  });

  it('a stopped countdown lets the next start, and runs neither callback', () => {
    const log: string[] = [];
    const first = countdown('a', log);
    countdown('b', log);
    first.stop();
    expect(banner()!.textContent).toContain('b in 5s');
    vi.advanceTimersByTime(5250);
    expect(log).toEqual(['b:elapsed']);
  });

  it('the persistent banner comes back once a countdown over it ends', () => {
    const log: string[] = [];
    showBanner('Running STALE game code — reload to apply', [{ id: 'reload', label: 'Reload', onClick: () => {} }], 'warn', { persistent: true });
    countdown('refresh', log);
    expect(banner()!.textContent).toContain('refresh in');
    vi.advanceTimersByTime(5250);
    expect(log).toEqual(['refresh:elapsed']);
    expect(banner()!.textContent).toContain('Running STALE game code');
  });
});
