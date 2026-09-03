/** `runtime/debug/consoleCapture.ts` — the in-game debug menu's projection of the shared console
 *  ring. Specifically its clear-watermark self-heal, which had no test at all and whose guard was
 *  wrong (#626 close-out). */

import { describe, it, expect, afterEach } from 'vitest';
import {
  installConsoleCapture,
  getConsoleEntries,
  clearConsoleEntries,
  __resetConsoleCaptureForTest,
} from '../../src/runtime/debug/consoleCapture';
import { __resetConsoleRingForTest, installConsoleRing } from '../../src/runtime/core/consoleRing';

const pristine = { log: console.log, info: console.info, warn: console.warn, error: console.error };

afterEach(() => {
  __resetConsoleCaptureForTest();
  console.log = pristine.log;
  console.info = pristine.info;
  console.warn = pristine.warn;
  console.error = pristine.error;
});

describe('runtime/debug consoleCapture — clear watermark', () => {
  it('a clear hides existing entries but a later log still arrives', () => {
    installConsoleCapture();
    console.log('before');
    expect(getConsoleEntries().some(e => e.text.includes('before'))).toBe(true);

    clearConsoleEntries();
    expect(getConsoleEntries()).toHaveLength(0);

    console.log('after');
    expect(getConsoleEntries().some(e => e.text.includes('after'))).toBe(true);
  });

  it('self-heals when the ring is reset out from under it — including `reset then log once`', () => {
    // The guard here compared the ring's VERSION against the highest previously seen and healed
    // only on a DECREASE. That misses the case below: `seq` and `version` both restart at 0, so one
    // log after the reset puts version back on the value already observed (1), `1 < 1` is false, no
    // heal fires, and `clearedBeforeSeq` then filters out every entry — the projection reads as
    // "captures nothing" with nothing failing anywhere. Keyed on the ring's EPOCH it cannot miss.
    installConsoleCapture();
    console.log('one-before-clear');
    clearConsoleEntries();
    expect(getConsoleEntries()).toHaveLength(0);

    __resetConsoleRingForTest();   // bypasses __resetConsoleCaptureForTest, as a sibling suite does
    installConsoleRing();
    console.log('after-the-reset');

    expect(getConsoleEntries().map(e => e.text)).toContain('after-the-reset');
  });
});
