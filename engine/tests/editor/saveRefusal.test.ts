/** #901 — a modal asset editor's Save refusal reaches the human, and says which remedy applies.
 *
 *  `SpriteEditor.save` and `NineSliceEditor.save` each return without writing in two cases, and
 *  both reported only to `console.error`. The dialog stays open by design, so the human sees that
 *  SOMETHING happened — but never what, which makes a correct guard indistinguishable from a Save
 *  button that is simply broken.
 *
 *  These assertions are on the pure wording module rather than on a mounted dialog, per
 *  `docs/editor.md` § Panels: mounting a modal in jsdom asserts the mock. The rendering half —
 *  that the notice appears in the footer beside Save — is an e2e concern and a live check. */
import { describe, it, expect } from 'vitest';
import {
  saveRefusalMessage, saveRefusalConsoleMessage, type SaveRefusal,
} from '@modoki/engine/editor';

const NEVER_READ: SaveRefusal = { kind: 'meta-never-read' };
const WRITE_FAILED: SaveRefusal = { kind: 'write-failed' };

describe('saveRefusalMessage — what the human is told, in the dialog', () => {
  it('the two refusals give OPPOSITE remedies', () => {
    // ⚠️ This is the whole reason `SaveRefusal` is a union rather than a boolean or a bare string.
    // A failed write should be retried — the dialog is staying open precisely so Save can be
    // pressed again. A failed READ must not be: the base document is what is wrong, so retrying
    // refuses identically forever. One sentence covering both would misdirect one of them.
    const neverRead = saveRefusalMessage(NEVER_READ);
    const writeFailed = saveRefusalMessage(WRITE_FAILED);

    expect(writeFailed).toContain('press Save again');
    expect(neverRead, 'retrying cannot help when the base document is the problem')
      .not.toContain('press Save again');
    expect(neverRead).toContain('Close and reopen');
  });

  it('each says the edit is not lost', () => {
    // The dialog staying open is deliberate (owner, 2026-08-18) and the message has to carry that,
    // or a human reading "not saved" reasonably assumes the work is gone and stops trying.
    for (const r of [NEVER_READ, WRITE_FAILED]) {
      const m = saveRefusalMessage(r);
      expect(m.toLowerCase(), `"${r.kind}" must say the edit survives`).toMatch(/still here|intact/);
    }
  });

  it('names the CONSEQUENCE for the read refusal, not just the failure', () => {
    // Why the guard exists at all: a wholesale write from a failed read strips the GUID and every
    // scene/prefab reference to the asset dangles. A message that says only "could not save" gives
    // the human no way to judge whether to force it some other way.
    expect(saveRefusalMessage(NEVER_READ)).toMatch(/strip its ID|break every reference/);
  });
});

describe('saveRefusalConsoleMessage — the debugging half, which is NOT dropped', () => {
  it('carries the path and the tag the human-facing sentence deliberately omits', () => {
    // BOTH channels (#890/#891). The ruling was that a refusal must REACH the human — not that the
    // log line was wrong. The log is for whoever is debugging and needs the path; the dialog is for
    // whoever is editing and needs the remedy. Dropping either loses a reader.
    const m = saveRefusalConsoleMessage(NEVER_READ, 'SpriteEditor', '/assets/t.png');
    expect(m).toContain('[SpriteEditor]');
    expect(m).toContain('/assets/t.png');

    // …and the human-facing one carries neither, on purpose: a path in a dialog the human opened
    // ON that asset is noise.
    expect(saveRefusalMessage(NEVER_READ)).not.toContain('/assets/t.png');
  });

  it('is tagged per editor, so two dialogs are told apart in one console', () => {
    const sprite = saveRefusalConsoleMessage(WRITE_FAILED, 'SpriteEditor', '/a.png');
    const nine = saveRefusalConsoleMessage(WRITE_FAILED, 'NineSliceEditor', '/a.png');
    expect(sprite).not.toBe(nine);
    expect(nine).toContain('[NineSliceEditor]');
  });
});
