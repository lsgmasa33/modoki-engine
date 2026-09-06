/** Guard: each preview panel gates on ITS OWN id (#810 follow-up).
 *
 *  `previewOwnership.ts`'s `panelDrivesPreview`/`panelMayStopPreview` are unit-tested as pure
 *  functions, and `previewDisplacementSharedFlag.test.ts` models the two panels' call sequences —
 *  but NOTHING reached the two `.tsx` call sites, and that gap was demonstrated, not theorised:
 *  an adversarial review swapped `TimelineEditor`'s `'timeline'` for `'animation'` — a plausible
 *  copy-paste slip that reintroduces #810 verbatim (the Timeline drives on the Animation panel's
 *  ▶, wins `_modeOwner` through its later async entry, stops the Animation rAF, and with no
 *  timeline doc open its own tick early-returns every frame, so ▶ plays nothing) — and all 252
 *  editor test files stayed green.
 *
 *  The panels are `.tsx` and `CLAUDE.md` § Tests forbids mounting them in jsdom (that asserts the
 *  mock), so this checks the one property a source census can check honestly: **a panel names
 *  itself**. It cannot prove the gate is wired into the right effect — the real gesture belongs in
 *  an e2e — but it does fail on the exact mutation that slipped through, which is more than the
 *  suite managed before.
 *
 *  Sibling in spirit to `rendererLossHandling.test.ts`: a comment-stripped source census over a
 *  small named set, asserting a pairing the type checker cannot. */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
// The ONE comment scanner (#419) — a hand-rolled regex stripper is a guarded offence here, and for
// a good reason: a naive one hid 82 lines of `Scene3D.tsx` from the determinism guard.
import { stripComments } from '@modoki/engine/testing';

const PANELS_DIR = path.resolve(__dirname, '../../packages/modoki/src/editor/panels');

/** file -> the ONLY panel id it may pass to the ownership helpers. */
const OWN_ID = new Map<string, string>([
  ['TimelineEditor.tsx', 'timeline'],
  ['AnimationEditor.tsx', 'animation'],
]);

const CALL_RE = /\bpanel(?:DrivesPreview|MayStopPreview)\s*\(([^)]*)\)/g;

describe('preview ownership call sites — a panel gates on its OWN id', () => {
  for (const [file, ownId] of OWN_ID) {
    it(`${file} passes only '${ownId}'`, () => {
      // Stripped so a mention in prose can neither satisfy nor break the check.
      const src = stripComments(fs.readFileSync(path.join(PANELS_DIR, file), 'utf8'));
      const args = [...src.matchAll(CALL_RE)].map((m) => m[1]);

      // The panel must actually USE the helpers — deleting the gate is the other half of the
      // mutation this guard exists for, and an empty match list must not pass vacuously.
      expect(args.length, `${file} calls neither ownership helper — the gate is gone`).toBeGreaterThan(0);

      const foreign = args.filter((a) => {
        const ids = [...a.matchAll(/'(timeline|animation)'/g)].map((m) => m[1]);
        return ids.some((id) => id !== ownId);
      });
      expect(foreign, `${file} names another panel's id`).toEqual([]);
    });
  }

  it('both panels are covered — the map is not silently short', () => {
    // A new preview panel added to this family without an entry here would be unguarded.
    for (const file of OWN_ID.keys()) {
      expect(fs.existsSync(path.join(PANELS_DIR, file)), `${file} moved or was renamed`).toBe(true);
    }
  });
});
