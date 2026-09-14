/** #1117: `assert-app-renders.sh` removes what it mints in the temp dir.
 *
 *  It mints two logs and a whole Chromium profile per run, and nothing removed them. The profile now
 *  goes on every exit. A log goes on a PASS or when it is empty, because a failure prints the path
 *  of a non-empty log for the reader. Driven for real into a private TMPDIR: an app path with no
 *  executable fails right after the mint, with both logs still empty. */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';

const SCRIPT = path.resolve(__dirname, '../../scripts/assert-app-renders.sh');

describe.skipIf(process.platform === 'win32')('assert-app-renders.sh temp lifetime', () => {
  it('leaves nothing behind when it fails before launching (profile removed, empty logs removed)', () => {
    const tmp = makeScratchDir('modoki-rendergate-');
    const r = spawnSync('bash', [SCRIPT, path.join(tmp, 'NoSuch.app')], {
      env: { ...process.env, TMPDIR: `${tmp}/` },
      encoding: 'utf8',
      timeout: 60_000,
    });
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, out).toBe(1);
    // Non-vacuity: it failed AFTER the mktemp lines, at the executable check.
    expect(out).toMatch(/\[render\] FAIL: no executable at/);
    expect(fs.readdirSync(tmp)).toEqual([]);
  });
});
