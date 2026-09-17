/** Guard: every project's `MyViewController` must disable the web view's text interaction (#1360).
 *
 *  ## The trap
 *
 *  Double-tapping a shipped game on iOS raises the text-selection magnifier. The obvious fix —
 *  `-webkit-user-select: none` — is already in `engine/app/App.css` and **cannot** work, because
 *  this is not DOM text selection at all.
 *
 *  Measured on Masaki's iPad (iPad11,1, iOS 26.6.2) against Court, 2026-09-18, with a
 *  `selectionchange` probe installed in the page: across 36 real finger touches the magnifier
 *  appeared every time, while `document.getSelection()` stayed EMPTY (`rangeCount: 0`) and
 *  `selectionchange` never fired once. Every touch landed on a `<canvas>` — Court draws its text in
 *  PixiJS, so there was no DOM text under the finger to select. The loupe is WebKit's
 *  `UITextInteraction` on the web view's content view, which runs BEFORE the page is consulted;
 *  `-webkit-user-select: none` suppresses the LONG-PRESS loupe and never the DOUBLE-TAP one.
 *
 *  So the only layer that can fix it is the web view, and `MyViewController.swift` is the one Swift
 *  file the engine owns per game (generated + healed by `engine/plugins/healNativeConfig.ts`).
 *
 *  ## Why a guard rather than a comment
 *
 *  The block is inserted by a heal that runs on project open and on build. A project scaffolded
 *  while the heal is unavailable, one whose `MyViewController.swift` someone takes ownership of, or
 *  a future `cap add ios` that changes the class line the insert anchors on, all produce a project
 *  that silently ships the magnifier — with nothing failing and nothing to see. That is the same
 *  shape as #368 (a dead debug bridge behind a perfectly rendering game), and the same answer: a
 *  test, because a comment cannot enforce anything across projects that do not exist yet.
 *
 *  ## The deployment-target assertion is load-bearing, not decoration
 *
 *  `isTextInteractionEnabled` is iOS 14.5+. The generated block calls it with NO `#available`
 *  guard, which is safe only because every project's `IPHONEOS_DEPLOYMENT_TARGET` is well above
 *  that. Lower one below 14.5 and the Swift stops compiling — on a machine that may not be the one
 *  that lowered it. Asserting the floor here is what makes the bare call a decision rather than a
 *  coincidence. */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readScannedSource } from '@modoki/engine/testing';
import { REPO_ROOT, hasNativeProjects } from '../helpers/repoLayout';
import { repoFiles } from '../../scripts/repoCorpus.mjs';
// IMPORTED, never retyped. A copy of the marker text here would be a constant SHADOWING the one
// `healNativeConfig.ts` owns, and the failure is not hypothetical: rename `TI_BEGIN` and the heal's
// `fenceRe` stops matching the 19 committed files, so the class-anchor branch inserts a SECOND
// block into each — 19 duplicate overrides, every iOS target dead — while a guard holding the OLD
// literals stays green on all of them. Importing means a rename either keeps matching or fails
// loudly here.
import { TI_BEGIN, TI_END, TI_BLOCK } from '../../plugins/healNativeConfig';

/** The API's own floor — see the header. Not the projects' target (16.4), which may move. */
const TEXT_INTERACTION_MIN_IOS = 14.5;

/** Tracked `MyViewController.swift` files. `includeUntracked: false` for the same reason
 *  `sceneDelegateBridgeVC.test.ts` gives: an untracked one is a local experiment. */
function bridgeControllers(): string[] {
  return repoFiles({
    // Git's own (non-anchored) glob crosses `/` — see repoLayoutGuard.test.ts's identical note.
    match: /.+\/ios\/App\/App\/MyViewController\.swift$/,
    floor: 0,
    includeUntracked: false,
  }).map((f) => f.rel);
}

describe('iOS web-view text interaction is disabled in every project (#1360)', () => {
  const files = bridgeControllers();

  // Anti-vacuity, exactly as in sceneDelegateBridgeVC.test.ts: `repoFiles` swallows a git failure
  // into `[]`, and every assertion below is skipIf'd on that — so a renamed path or a non-checkout
  // cwd would skip the whole guard, which is indistinguishable from passing. The public OSS
  // snapshot legitimately has no native content (publish-engine-oss.sh strips `ios` from every
  // staged demo), hence gating on the same predicate rather than asserting flat.
  it.skipIf(!hasNativeProjects())('finds bridge view controllers to check — a vacuous pass is a failure', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.skipIf(files.length === 0)('every MyViewController turns text interaction OFF', () => {
    // `.code` (comments STRIPPED) on purpose: the point is that the call is live Swift. Asserting
    // against `.raw` would be satisfied by the line sitting inside a comment — which is exactly how
    // this guard would be "fixed" by someone commenting the override out to chase a build error.
    const offenders = files.filter(
      (f) => !/\.preferences\.isTextInteractionEnabled\s*=\s*false/.test(
        readScannedSource(path.join(REPO_ROOT, f)).code,
      ),
    );
    expect(
      offenders,
      `${offenders.join(', ')} — this project ships the iOS double-tap text-selection magnifier over `
        + `the game. CSS cannot fix it (the loupe appears with an EMPTY document selection — see this `
        + `file's header): the web view is the only layer that can. Run the project open/build heal, `
        + `or see engine/plugins/healNativeConfig.ts's TI_BLOCK and docs/input.md.`,
    ).toEqual([]);
  });

  it.skipIf(files.length === 0)('every MyViewController imports WebKit for WKWebViewConfiguration', () => {
    const offenders = files.filter(
      (f) => !/^import WebKit$/m.test(readScannedSource(path.join(REPO_ROOT, f)).code),
    );
    expect(
      offenders,
      `${offenders.join(', ')} — the override's return type is WKWebViewConfiguration, which is `
        + `WebKit's. Capacitor's own headers import it but that does not re-export into this file, `
        + `so the target fails to compile.`,
    ).toEqual([]);
  });

  it.skipIf(files.length === 0)('the fenced markers survive, so the heal can still rewrite its own block', () => {
    // `.raw` here, NOT `.code`: the markers ARE comments, so the stripper that makes the assertion
    // above meaningful would blank exactly what this one is looking for. A guard reading `.code`
    // for these would pass on every file unconditionally.
    const offenders = files.filter((f) => {
      const { raw } = readScannedSource(path.join(REPO_ROOT, f), {
        comments: 'include',
        reason: 'The fence markers ARE comments (`// modoki:text-interaction-{begin,end}`), so the '
          + 'default strip blanks exactly what this assertion looks for and the guard would pass '
          + 'unconditionally on every file. This is the inverse of the assertion above, which reads '
          + '`.code` on purpose so a commented-out override cannot satisfy it.',
      });
      // The WHOLE block, not just its markers. Asserting three properties (markers, the assignment,
      // the import) left every other line of TI_BLOCK unpinned: drop `override`, drop the `super`
      // call, change the parameter label, or return a fresh WKWebViewConfiguration instead of
      // super's, and all 19 committed files could drift from what the plugin now generates with
      // both test files green — the only detector being an Xcode build, which no gate runs.
      return !raw.includes(TI_BEGIN) || !raw.includes(TI_END) || !raw.includes(TI_BLOCK);
    });
    expect(
      offenders,
      `${offenders.join(', ')} — this file's fenced block is missing or no longer byte-identical to `
        + `TI_BLOCK in engine/plugins/healNativeConfig.ts. Without both markers the heal cannot find `
        + `its own block, so it re-inserts a SECOND copy at the class anchor (duplicate override = `
        + `compile error) or reports the file as hand-owned and silently stops applying. Re-run the `
        + `heal (open the project, or build) rather than editing these files by hand.`,
    ).toEqual([]);
  });

  it.skipIf(files.length === 0)(`every project targets iOS >= ${TEXT_INTERACTION_MIN_IOS}, which is what lets the call go unguarded`, () => {
    const tooLow: string[] = [];
    let checked = 0;
    for (const f of files) {
      const pbx = path.join(REPO_ROOT, f.replace(/\/App\/App\/MyViewController\.swift$/, ''), 'App/App.xcodeproj/project.pbxproj');
      if (!fs.existsSync(pbx)) continue;
      // `"16.4"` (quoted) and `16.4.1` (three-component) both exist in the wild. The old pattern
      // `([0-9.]+);` cannot match past a quote, and `Number('16.4.1')` is NaN — and `NaN < 14.5` is
      // FALSE, so a three-component version would sail through unchecked. Accept both forms, and
      // compare on the major.minor pair rather than on a float parse.
      for (const m of fs.readFileSync(pbx, 'utf8').matchAll(/IPHONEOS_DEPLOYMENT_TARGET = "?([0-9]+(?:\.[0-9]+)*)"?;/g)) {
        checked++;
        const [maj = 0, min = 0] = m[1].split('.').map(Number);
        if (maj < Math.floor(TEXT_INTERACTION_MIN_IOS)
          || (maj === Math.floor(TEXT_INTERACTION_MIN_IOS) && min < Math.round((TEXT_INTERACTION_MIN_IOS % 1) * 10))) {
          tooLow.push(`${f} (${m[1]})`);
        }
      }
    }
    // Anti-vacuity, like the file-list gate above — and for the same reason. Zero pbxprojs found, or
    // a pattern that stops matching (a quoted value, a renamed setting), both yield `tooLow === []`
    // and a green test that has measured NOTHING. The header calls this assertion load-bearing; an
    // unguarded `for` loop is how a load-bearing assertion quietly becomes decoration.
    expect(checked, 'no IPHONEOS_DEPLOYMENT_TARGET was read at all — this assertion measured nothing')
      .toBeGreaterThan(0);
    expect(
      tooLow,
      `${tooLow.join(', ')} — isTextInteractionEnabled is iOS ${TEXT_INTERACTION_MIN_IOS}+ and the `
        + `generated block calls it with no #available guard. Either raise the target back, or add `
        + `the guard to TI_BLOCK in engine/plugins/healNativeConfig.ts and re-heal every project.`,
    ).toEqual([]);
  });
});
