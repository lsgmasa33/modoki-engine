/** The app half of `device_console_logs`' disclosure (#1214): `handleConsoleLogs` reports the WHOLE
 *  ring beside the level-filtered rows, so the tool can say "no errors, but 3 warnings" instead of
 *  "No console logs.". The tool half is in filterDisclosure.test.ts. */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { recordConsoleRingEntry, __resetConsoleRingForTest } from '@modoki/engine/runtime/core/consoleRing';

vi.mock('@capacitor/app', () => ({ App: { getInfo: async () => ({}) } }));
vi.mock('capacitor-game-debug', () => ({ GameDebug: {} }));

const { handleConsoleLogs } = await import('../../app/debug/bridge');

afterEach(() => __resetConsoleRingForTest());

describe('handleConsoleLogs', () => {
  it('a level filter narrows the rows but not ringTotal/byLevel', () => {
    __resetConsoleRingForTest();
    recordConsoleRingEntry('warn', ['w1']);
    recordConsoleRingEntry('warn', ['w2']);
    recordConsoleRingEntry('log', ['l1']);
    const r = handleConsoleLogs({ level: 'error' });
    expect(r.logs).toEqual([]);
    expect(r.ringTotal).toBe(3);
    expect(r.byLevel).toEqual({ warn: 2, log: 1 });
  });
});
