/** Argument parsing for the dSYM upload tool (#279).
 *
 *  Both cases below are REGRESSIONS, not hypotheticals — each one uploaded something it should not
 *  have during the close-out that produced this file. The tool's mistake mode is silent on the
 *  receiving end (Crashlytics accepts symbols whose UUIDs match nothing and simply never
 *  symbolicates), so the guard has to be here rather than in the outcome. */

import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain .mjs helper shared with the CLI script; no types, by design.
import { parseUploadDsymsArgs } from '../../scripts/uploadDsymsArgs.mjs';

describe('upload-dsyms argument parsing', () => {
  it('does NOT upload unless --upload is given', () => {
    expect(parseUploadDsymsArgs(['games/court']).doUpload).toBe(false);
    expect(parseUploadDsymsArgs(['games/court', '--upload']).doUpload).toBe(true);
  });

  /** The reason the default is inverted. `npm run upload:dsyms games/court --dry-run` reaches the
   *  script as `['games/court']` — npm eats `--dry-run`, which is one of its own options — so under
   *  the old "upload unless --dry-run" shape this exact argv uploaded for real while the caller
   *  believed they had asked for a preview. Under the current shape the swallowed flag can only
   *  ever make the tool safer, which is the property being pinned. */
  it('treats an argv whose safety flag the runner swallowed as list-only', () => {
    expect(parseUploadDsymsArgs(['games/court']).doUpload).toBe(false);
  });

  it('reads the project path, not a flag value that happens to repeat it', () => {
    // `args.indexOf(a)` inside a `find` reported the FIRST occurrence of a repeated string, so this
    // argv previously resolved the project from the --dsym VALUE.
    const r = parseUploadDsymsArgs(['games/court', '--dsym', 'games/court']);
    expect(r.projectArg).toBe('games/court');
    expect(r.dsym).toBe('games/court');
  });

  it('never reads a --dsym value as the project, even when it comes first', () => {
    const r = parseUploadDsymsArgs(['--dsym', '/tmp/x.dSYM', 'games/sling']);
    expect(r.projectArg).toBe('games/sling');
    expect(r.dsym).toBe('/tmp/x.dSYM');
  });

  it('reports a missing project rather than inventing one', () => {
    expect(parseUploadDsymsArgs(['--upload']).projectArg).toBeUndefined();
    expect(parseUploadDsymsArgs([]).projectArg).toBeUndefined();
  });
});
