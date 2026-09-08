/** Cheats / Console / Device debug tabs + console capture — tests (Phase 4). */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import { registerUIAction, unregisterUIAction } from '@modoki/engine/runtime';
import {
  installConsoleCapture,
  getConsoleEntries,
  getConsoleErrorsSince,
  getConsoleVersion,
  clearConsoleEntries,
  __resetConsoleCaptureForTest,
} from '../../packages/modoki/src/runtime/debug/consoleCapture';
import {
  installConsoleRing,
  getConsoleRingEntries,
  __resetConsoleRingForTest,
} from '../../packages/modoki/src/runtime/core/consoleRing';
import {
  registerDebugCommand,
  __resetDebugMenuRegistry,
} from '../../packages/modoki/src/runtime/debug/debugMenuRegistry';
import { CheatsTab } from '../../packages/modoki/src/runtime/debug/tabs/CheatsTab';
import { ConsoleTab } from '../../packages/modoki/src/runtime/debug/tabs/ConsoleTab';
import { DeviceTab } from '../../packages/modoki/src/runtime/debug/tabs/DeviceTab';

afterEach(() => cleanup());

describe('consoleCapture', () => {
  beforeEach(() => __resetConsoleCaptureForTest());

  it('records console.* into the ring buffer and forwards to the original', () => {
    const original = console.log;
    installConsoleCapture();
    expect(console.log).not.toBe(original); // wrapped
    console.log('debug-capture-marker', 42);
    const hit = getConsoleEntries().find((e) => e.text.includes('debug-capture-marker'));
    expect(hit).toBeTruthy();
    expect(hit!.text).toContain('42');
    expect(hit!.level).toBe('log');
  });

  it('is idempotent (double install does not double-record)', () => {
    installConsoleCapture();
    installConsoleCapture();
    clearConsoleEntries();
    console.warn('once-only');
    expect(getConsoleEntries().filter((e) => e.text.includes('once-only'))).toHaveLength(1);
  });

  // The agent-evidence regression guard (#596/#597 Stage 3b). Clear must be a VIEW operation, not
  // a truncation of the shared ring — a human tidying the on-screen Console tab must not silently
  // destroy the buffer behind `modoki_get_console_logs` / `device_console_logs` / `diagnose`, on
  // device the one usable log surface. Fails if a future edit makes Clear truncate the shared ring.
  it('clearConsoleEntries() does not truncate the shared ring, only this view', () => {
    installConsoleCapture();
    console.log('kept-in-shared-ring');
    const ringCountBefore = getConsoleRingEntries().length;
    clearConsoleEntries();
    expect(getConsoleRingEntries()).toHaveLength(ringCountBefore); // shared ring: untouched
    expect(getConsoleEntries().find((e) => e.text.includes('kept-in-shared-ring'))).toBeUndefined(); // this view: gone
  });

  // The re-render guard: getConsoleVersion() is the useSyncExternalStore snapshot for ConsoleTab —
  // if it didn't move on a clear, getConsoleEntries()'s return value would change underneath an
  // unchanged snapshot and React would never re-render the (now-empty) list.
  it('clearConsoleEntries() changes getConsoleVersion()', () => {
    installConsoleCapture();
    console.log('version-probe');
    const before = getConsoleVersion();
    clearConsoleEntries();
    expect(getConsoleVersion()).toBeGreaterThan(before);
  });

  // Finding B (#596/#597 close-out review): getConsoleEntries() used to rebuild — a fresh
  // `[...pinned, ...tail]` copy, a new object PLUS a `.join(' ')`'d string per entry — on every
  // single call, even when nothing changed since the last one. ErrorToaster's effect and
  // ConsoleTab's render can both read at the SAME version; this is the distinguishing observation
  // that proves the second read is not rebuilding.
  it('getConsoleEntries() reuses the same array when read twice at the same version', () => {
    installConsoleCapture();
    console.log('memo-probe');
    const first = getConsoleEntries();
    const second = getConsoleEntries();
    expect(second).toBe(first); // same reference — not rebuilt
  });

  it('getConsoleEntries() DOES rebuild once new output arrives', () => {
    installConsoleCapture();
    console.log('one');
    const first = getConsoleEntries();
    console.log('two');
    const second = getConsoleEntries();
    expect(second).not.toBe(first);
    expect(second).toHaveLength(first.length + 1);
  });

  it('a Clear() invalidates the memo even at the same ring version (nothing new was logged)', () => {
    installConsoleCapture();
    console.log('to-be-cleared');
    const before = getConsoleEntries();
    expect(before).toHaveLength(1);
    clearConsoleEntries(); // ring version does not move on a clear — only clearedBeforeSeq does
    const after = getConsoleEntries();
    expect(after).toHaveLength(0);
  });

  // Finding B, other half: ErrorToaster no longer calls getConsoleEntries() on its hot path at
  // all — it uses this cheaper, error-only, since-a-watermark accessor instead.
  it('getConsoleErrorsSince() returns only error-level entries newer than the watermark', () => {
    installConsoleCapture();
    console.log('not-an-error');
    console.error('first-error');
    const afterFirst = getConsoleEntries().filter((e) => e.level === 'error');
    const watermark = afterFirst[afterFirst.length - 1].seq;
    console.log('also-not-an-error');
    console.error('second-error');

    const fresh = getConsoleErrorsSince(watermark);
    expect(fresh).toHaveLength(1);
    expect(fresh[0].text).toBe('second-error');
  });

  it('getConsoleErrorsSince() respects the clear watermark — a cleared error does not resurface', () => {
    installConsoleCapture();
    console.error('cleared-away');
    clearConsoleEntries();
    expect(getConsoleErrorsSince(0)).toEqual([]);
  });

  // Finding E (#596/#597 close-out review): a test that resets ONLY the shared ring (bypassing
  // this projection's own `__resetConsoleCaptureForTest()`) — exactly what `uncaughtCapture.test.ts`
  // used to do — used to leave `clearedBeforeSeq` stale at its old, now-impossible value, so
  // getConsoleEntries() read EMPTY forever, silently, until `seq` climbed back past it.
  it('self-heals a stale clearedBeforeSeq if the ring is reset without going through this projection', () => {
    installConsoleCapture();
    console.log('a'); console.log('b'); console.log('c');
    clearConsoleEntries(); // advances clearedBeforeSeq to the ring's current max seq (3)

    // Simulate the trap directly: reset ONLY the ring, never this projection's own watermark.
    __resetConsoleRingForTest();
    installConsoleRing();
    console.log('fresh-after-bare-ring-reset');

    const entries = getConsoleEntries();
    expect(entries.some((e) => e.text === 'fresh-after-bare-ring-reset')).toBe(true);
  });
});

describe('ConsoleTab', () => {
  beforeEach(() => {
    __resetConsoleCaptureForTest();
    installConsoleRing();
  });

  it('shows captured entries and filters by level', () => {
    console.log('a-log-line');
    console.error('an-error-line');
    const { queryByText, getByText } = render(<ConsoleTab />);
    expect(queryByText('a-log-line')).not.toBeNull();
    expect(queryByText('an-error-line')).not.toBeNull();
    fireEvent.click(getByText('error'));
    expect(queryByText('a-log-line')).toBeNull();
    expect(queryByText('an-error-line')).not.toBeNull();
  });

  it('clears the captured entries', async () => {
    console.log('to-be-cleared');
    const { queryByText, getByText } = render(<ConsoleTab />);
    expect(queryByText('to-be-cleared')).not.toBeNull();
    fireEvent.click(getByText('Clear'));
    // The store notifies its subscribers on a MICROTASK, not synchronously — a synchronous
    // notify is a setState during whatever render happens to be in progress, which is bug
    // `mfAJ8yTNTqOQbU3sqY46`. The version bumps immediately; only the listener call is deferred.
    await act(async () => {});
    expect(queryByText('to-be-cleared')).toBeNull();
  });

  it('draws no gap marker when nothing was dropped', () => {
    console.log('boot-1');
    console.log('tail-1');
    const { queryByText } = render(<ConsoleTab />);
    expect(queryByText(/earlier entr(y|ies) dropped/)).toBeNull();
  });

  // Finding A (#596/#597 close-out review): the ring is `[pinned boot prefix] ++ [rolling tail]` —
  // once it wraps, that is DISCONTIGUOUS. Rendering the two halves back-to-back with nothing
  // marking the seam reads as one continuous log, which is exactly what an agent (or a human)
  // reading the Console tab would wrongly conclude.
  it('draws exactly one gap marker at the pinned/tail boundary when entries were dropped', () => {
    __resetConsoleRingForTest();
    installConsoleRing({ capacity: 5, bootPrefix: 2 });
    console.log('boot-1');
    console.log('boot-2');
    for (let i = 0; i < 10; i++) console.log(`tail-${i}`); // tail cap 3: only tail-7..tail-9 survive

    const { getByText, queryByText, getAllByText } = render(<ConsoleTab />);
    expect(getByText('boot-1')).toBeTruthy();
    expect(getByText('boot-2')).toBeTruthy();
    expect(queryByText('tail-0')).toBeNull(); // evicted
    expect(getByText('tail-9')).toBeTruthy();
    expect(getAllByText(/7 earlier entries dropped/)).toHaveLength(1);
  });
});

describe('CheatsTab', () => {
  beforeEach(() => __resetDebugMenuRegistry());

  it('runs a registered debug command', () => {
    const run = vi.fn();
    registerDebugCommand({ tab: 'Cheats', label: 'Give Gold', run });
    const { getByText } = render(<CheatsTab />);
    fireEvent.click(getByText('Give Gold'));
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('lists registered UI actions', () => {
    registerUIAction('cheat.testAction', () => {});
    try {
      const { queryByText } = render(<CheatsTab />);
      expect(queryByText('cheat.testAction')).not.toBeNull();
    } finally {
      unregisterUIAction('cheat.testAction');
    }
  });
});

describe('DeviceTab', () => {
  it('renders platform + viewport info', () => {
    const { getByText } = render(<DeviceTab />);
    expect(getByText('Platform')).toBeTruthy();
    expect(getByText('web')).toBeTruthy(); // no Capacitor global in jsdom
    expect(getByText('Viewport')).toBeTruthy();
    expect(getByText('DPR')).toBeTruthy();
  });
});
