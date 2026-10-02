// @vitest-environment jsdom
/** #2033 close-out review: the shapes a setup-file `vi.mock('child_process')` did not reach, and the builtin guard
 *  (`tests/realTrashGuard.ts`) does: a jsdom file, a file whose own mock spreads the original module, and a default
 *  import. All three at once here; each was probed alone in the review. */

import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import cp from 'child_process';
import { moveToTrash } from '../../plugins/asset-fs-ops';
import { takeRealTrashCalls } from '../realTrashGuard';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';

vi.mock('child_process', async (orig) => ({ ...(await orig<typeof import('child_process')>()) }));

describe('#2033 realTrashGuard reaches every importer', () => {
  it('a jsdom file with its own spread mock: moveToTrash (a named import) and a default import are both blocked', () => {
    const p = path.join(makeScratchDir('real-trash-bypass'), 'a.json');
    fs.writeFileSync(p, '{}');
    expect(moveToTrash(p, 'darwin')).toMatchObject({ failed: [p] });
    expect(() => cp.execFileSync('osascript', ['-e', 'tell application "Finder" to delete theItems', p])).toThrow(/realTrashGuard/);
    expect(fs.existsSync(p)).toBe(true);
    expect(takeRealTrashCalls()).toHaveLength(2);
  });
});
