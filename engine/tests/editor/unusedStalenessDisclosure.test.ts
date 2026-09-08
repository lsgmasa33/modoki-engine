/** #889 close-out review — the Clean Up dialog READS the staleness the route discloses.
 *
 *  ## Why this test exists
 *
 *  `/api/unused-assets` gained `staleInputs` / `staleInputsUnknown` / `staleInputsNote` because its
 *  answer is computed from files on DISK and **feeds a delete**: `CleanupAssetsDialog` lists the
 *  orphans, pre-selects every one of them, and posts the selection to `/api/delete-asset`. So an
 *  asset referenced ONLY by an edit the human has not saved reads as unused and gets trashed.
 *
 *  ⚠️ **The route's own comment named that dialog as the reason — and the dialog parsed none of it.**
 *  `interface UnusedResponse` declared four fields and not these three, so the disclosure reached
 *  AGENTS through the MCP surface while the human path threw it away. A field nobody reads is the
 *  same as a field nobody sends, and the half that was missing was the half with the delete button.
 *
 *  Asserted on the plain decision function rather than a mounted dialog, per `docs/editor.md`
 *  § Panels: mounting a modal in jsdom asserts the mock. */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readScannedSource } from '@modoki/engine/testing';
import { readUnusedStaleness } from '@modoki/engine/editor';

const REPO = path.resolve(__dirname, '../../..');

const ROW = { path: '/assets/scenes/Lvl-0002.scene.json', registry: 'liveScene', detail: 'unsaved live-world edits in the OPEN scene' };

describe('readUnusedStaleness — what the human is shown before they delete', () => {
  it('surfaces a disclosed hold, with the note the route composed', () => {
    const s = readUnusedStaleness({
      staleInputs: [ROW],
      staleInputsNote: 'unsaved live-world edits … — this answer was computed from the files on DISK',
    });
    expect(s, 'the whole point: the dialog can see it').not.toBeNull();
    expect(s!.inputs).toEqual([ROW]);
    expect(s!.unknown).toBe(false);
    expect(s!.note).toContain('DISK');
  });

  it('surfaces an UNANSWERABLE probe too — "could not look" is not "nothing is there"', () => {
    // Collapsing this into the clean case would make a busy renderer indistinguishable from a
    // clean one, in the dialog whose next click deletes.
    const s = readUnusedStaleness({
      staleInputsUnknown: { reason: 'timed out waiting for the renderer' },
      staleInputsNote: 'an editor renderer may be attached and it did not answer',
    });
    expect(s).not.toBeNull();
    expect(s!.unknown).toBe(true);
    expect(s!.inputs, 'it could not look, so it names nothing specific').toEqual([]);
  });

  it('ACCEPT SIDE: a clean scan shows NOTHING', () => {
    // ⚠️ The half that decides whether the banner means anything. A warning on every clean scan is
    // one people learn to dismiss unread — and then the scan that matters is dismissed with it.
    // The route omits the fields entirely rather than sending `staleInputs: []`, so absence is the
    // signal and this must return null rather than a falsy-but-present object.
    expect(readUnusedStaleness({ })).toBeNull();
    expect(readUnusedStaleness({ staleInputs: [], staleInputsNote: '' })).toBeNull();
    expect(readUnusedStaleness(null)).toBeNull();
    expect(readUnusedStaleness(undefined)).toBeNull();
  });

  it('a HALF-populated body fails closed rather than rendering an empty warning box', () => {
    // A field without its note, or a note with neither field, is a route mid-change or a proxy
    // that dropped something. Rendering "⚠ " with no sentence is worse than rendering nothing.
    expect(readUnusedStaleness({ staleInputs: [ROW] }), 'rows but no note').toBeNull();
    expect(readUnusedStaleness({ staleInputsNote: 'something' }), 'note but no cause').toBeNull();
  });

  it('a non-array staleInputs is not trusted into the UI', () => {
    // The wire is JSON from a route this module does not control; a malformed field must not reach
    // `.length` in the render.
    const s = readUnusedStaleness({
      staleInputs: 'oops' as unknown as typeof ROW[], staleInputsNote: 'n',
    });
    expect(s, 'no rows and not unknown → nothing to show').toBeNull();
  });
});

describe('the CONSUMER is wired — the half a pure-function test cannot reach', () => {
  /** ⚠️ **This suite's other cases prove a function EXISTS, not that anything calls it.**
   *
   *  Found by the close-out's follow-up review, and it is this ticket's own defect class committed
   *  one level up: #889's finding was a route computing `staleInputs` that no consumer read, and
   *  the fix for it was — measured — deletable with the whole suite still green. Severing
   *  `const staleness = readUnusedStaleness(data)` in the dialog left **3010 tests passing**. The
   *  producer had a test; the wire had none; and the surface on the other end of that wire is the
   *  one whose next click trashes files.
   *
   *  A source assertion rather than a jsdom mount, per `docs/editor.md` § Panels — and it is the
   *  idiom the repo already uses for exactly this: `unsavedGateCoverage.test.ts`'s "the RENDERER
   *  side of the gate is wired" pins its own cross-process seam the same way. */
  const dialog = readScannedSource(
    path.join(REPO, 'engine/packages/modoki/src/editor/panels/CleanupAssetsDialog.tsx'),
  ).code;

  it('CleanupAssetsDialog CALLS readUnusedStaleness on the scan result', () => {
    // ⚠️ The paren is required. Without it the assertion is satisfied by the IMPORT line, and the
    // guard passes for a dialog that merely mentions the symbol — the same trap
    // `metaParkGateCoverage` documents for `writeMetaConditional`.
    expect(
      /readUnusedStaleness\s*\(/.test(dialog),
      'the Clean Up dialog no longer reads the staleness the route discloses. The orphan list is '
      + 'computed from files on DISK and every row is PRE-SELECTED for deletion, so without this '
      + 'the human deletes an asset that is referenced only by an edit they have not saved.',
    ).toBe(true);
  });

  it('…and RENDERS what it read', () => {
    // Calling it and dropping the result is the same defect with an extra step.
    expect(
      /staleness\.note/.test(dialog),
      'the dialog computes the staleness and never shows it — a consumer that reads a value and '
      + 'renders nothing is indistinguishable from one that never read it',
    ).toBe(true);
  });

  it('the banner is BOUNDED — an unbounded note pushes the Delete button out of the modal', () => {
    // `staleness.note` comes from `describeHolds`, which enumerates EVERY held path grouped by
    // kind, and the probe is global (`paths: null`). The modal is maxHeight:80vh with no overflow
    // and the orphan list holds a minHeight, so on a busy editor an uncapped banner pushes the
    // footer outside the box with nothing to scroll. The `warnings` block below it caps itself for
    // exactly this reason; this one must too.
    // ⚠️ RAW source here, not the comment-stripped `dialog` above — this assertion is about a
    // STYLE PROPERTY, and stripping shifts offsets by however much prose the style block carries,
    // which made a fixed window miss it. The two assertions below name properties no comment in
    // that block uses, so the raw read costs nothing.
    const raw = fs.readFileSync(
      path.join(REPO, 'engine/packages/modoki/src/editor/panels/CleanupAssetsDialog.tsx'), 'utf-8',
    );
    const at = raw.indexOf('data-testid="cleanup-stale"');
    expect(at, 'the stale banner is gone or renamed — re-point this guard').toBeGreaterThan(-1);
    // Its own element only. Bounded on purpose rather than scanning the file: the `warnings` block
    // further down carries both properties, so a file-wide match would pass for a banner with
    // neither — the guard would be green about the wrong element.
    const banner = raw.slice(at, raw.indexOf('>', raw.indexOf('}}', at)));
    expect(/maxHeight/.test(banner), 'the banner needs a maxHeight').toBe(true);
    expect(/overflowY/.test(banner), 'and something to scroll with').toBe(true);
  });
});
