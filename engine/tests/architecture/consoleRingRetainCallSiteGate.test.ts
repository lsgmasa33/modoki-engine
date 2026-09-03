import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments, assertScanIsSane } from '@modoki/engine/testing';

/**
 * `ConsoleRingOptions.retainCallSite` (#626) opts a `warn`/`error` ring entry into retaining a live
 * `Error` object, captured at the console call site, so the editor Console panel can still show
 * WHERE a call came from even when it logged no `Error` itself. That per-entry retention is a real
 * cost — #154's low-end device budget must not pay it — so it must be turned on ONLY for the editor,
 * never unconditionally.
 *
 * Modeled on `deviceConsoleCaptureInstallOrder.test.ts`'s gate-text pins: this parses the actual
 * `installConsoleRing(...)` call rather than grepping loosely, so a comment that merely MENTIONS
 * `retainCallSite: __MODOKI_EDITOR__` cannot satisfy it in place of the real call doing so.
 */

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../app');
const INSTALL_CONSOLE_RING = path.join(appDir, 'installConsoleRing.ts');

describe('installConsoleRing retainCallSite gate (#626)', () => {
  it('passes retainCallSite: __MODOKI_EDITOR__ to installConsoleRing — never a bare `true`', () => {
    const src = fs.readFileSync(INSTALL_CONSOLE_RING, 'utf8');
    const stripped = stripComments(src);
    assertScanIsSane(src, stripped, 'app/installConsoleRing.ts');

    const lines = stripped.split('\n');
    const callIdx = lines.findIndex((l) => l.includes('installConsoleRing('));
    expect(callIdx, 'could not find the installConsoleRing(...) call in app/installConsoleRing.ts').toBeGreaterThanOrEqual(0);
    const call = lines[callIdx];

    expect(
      call,
      `app/installConsoleRing.ts's installConsoleRing(...) call must pass ` +
        `"retainCallSite: __MODOKI_EDITOR__" — retaining a live Error per warn/error ring entry is a ` +
        `real cost only the editor should pay. Got: "${call.trim()}"`,
    ).toContain('retainCallSite: __MODOKI_EDITOR__');
    expect(
      call,
      'app/installConsoleRing.ts must NOT pass a bare `retainCallSite: true` — that would turn the ' +
        "call-site capture on for EVERY build (including a device one), which is exactly #154's " +
        `low-end budget regression this gate exists to catch. Got: "${call.trim()}"`,
    ).not.toMatch(/retainCallSite:\s*true\b/);
  });
});
