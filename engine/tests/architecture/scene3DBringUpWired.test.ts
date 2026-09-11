/** Scene3D is WIRED to the decisions `scene3DBringUp.ts` pins — a tested module nothing calls
 *  correctly is not a fix (#824).
 *
 *  #824 moved Scene3D's bring-up decisions out of its effect closure so a test could reach them, and
 *  `tests/runtime/scene3DBringUp.test.ts` now pins each decision. What that suite cannot see is how
 *  `Scene3D.tsx` USES the module — which is the same gap #824 was filed for, one layer out. Measured
 *  by the close-out review: `rebuild: bringUp.boot` (the rebuild silently loses its bound) and a
 *  no-op capture slot (`retire` that clears nothing, so #819's retirement never happens) both left
 *  all 144 tests across the bring-up, recovery and 3D sync suites green.
 *
 *  Deliberately a source scan rather than a mount: `Scene3D.tsx` is a component, and CLAUDE.md rules
 *  out mounting one in jsdom ("that asserts the mock"). The shape follows
 *  `videoTextureTeardownReachable.test.ts` — the behaviour is tested where it lives, and this only
 *  proves production reaches it the right way. Read through the ONE shared scanner (#419), so a
 *  mention in a comment cannot satisfy it.
 *
 *  ⚠️ **Every needle is anchored by the delimiter that ENDS its value** (`,` or the closing brace).
 *  The first version matched bare prefixes, and its own review showed what that buys:
 *  `isDisposed: () => disposed && false` and `current: () => captureRT && null` — the latter
 *  disables #819's retirement exactly as a no-op `retire` would — both passed. A prefix match
 *  cannot tell a value from the start of a longer, wrong one.
 *
 *  ⚠️ Known limit: `callArgument` counts braces inside string literals too (the scanner blanks
 *  comments, not strings). An unbalanced `'}'` inside one of these calls would end the slice early.
 *  None exists today; if one is added, this guard needs a real parser.
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readScannedSource } from '@modoki/engine/testing';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SCENE3D = 'engine/packages/modoki/src/runtime/rendering/Scene3D.tsx';

/** Comment-stripped, whitespace-collapsed — so a reflow does not red the guard, and a comment does
 *  not green it. */
const code = readScannedSource(path.join(repoRoot, SCENE3D)).code.replace(/\s+/g, ' ');

const occurrences = (needle: string) => code.split(needle).length - 1;

/** The balanced `{ … }` argument of the first `<callee>({` call — so an assertion is scoped to the
 *  one call it is about, not satisfied by the same text elsewhere in a 1,000-line file. */
function callArgument(callee: string): string {
  const open = `${callee}({`;
  const start = code.indexOf(open);
  expect(start, `${SCENE3D} no longer calls ${callee}({ … }) — update this guard with the new wiring`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = start + open.length - 1; i < code.length; i += 1) {
    if (code[i] === '{') depth += 1;
    else if (code[i] === '}') {
      depth -= 1;
      if (depth === 0) return code.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces after ${callee}({ in ${SCENE3D}`);
}

describe('Scene3D is wired to scene3DBringUp the way its tests assume (#824)', () => {
  it('hands recovery the BOUNDED rebuild — and nothing else calls either bring-up', () => {
    const recovery = callArgument('createRendererRecovery');
    expect(recovery, 'recovery must rebuild through bringUp.rebuild (bounded by REBUILD_BRINGUP_TIMEOUT_MS)').toContain('rebuild: bringUp.rebuild,');
    // Exactly once each, file-wide: a SECOND `bringUp.boot` (say, a loss handler calling it instead of
    // `recovery.request()`) rebuilds with no bound and no backoff while recovery sits wired and unused.
    expect(occurrences('bringUp.rebuild'), 'bringUp.rebuild must be referenced only as recovery\'s rebuild').toBe(1);
    expect(occurrences('bringUp.boot'), 'bringUp.boot must be called exactly once — the initial bring-up').toBe(1);
  });

  it('runs the FIRST bring-up through the unbounded boot(), and routes losses through recovery', () => {
    expect(code, 'the initial bring-up must stay unbounded — a bound there turned a slow cold start into a permanent failure').toContain('bringUp.boot().catch(');
    expect(code, 'a reported loss must go through recovery\'s single-flight latch and backoff').toContain('recovery.request();');
  });

  it('gives the bring-up the effect\'s real disposal, install and teardown', () => {
    const deps = callArgument('createScene3DBringUp');
    expect(deps).toContain('isDisposed: () => disposed,');
    expect(deps).toContain('install: (r) => install(r),');
    expect(deps).toContain('teardown: () => teardown(),');
  });

  it('gives the capture readback a slot that reads AND clears the pooled captureRT (#819)', () => {
    const at = code.indexOf('boundedCaptureReadback(');
    expect(at, `${SCENE3D} no longer calls boundedCaptureReadback`).toBeGreaterThanOrEqual(0);
    const call = code.slice(at, code.indexOf(');', at) + 2);
    // `current` must return the pool's target as-is: the helper retires only when
    // `slot.current() === rt`, so anything that is not exactly `captureRT` disables the retirement.
    expect(call).toContain('{ current: () => captureRT, retire: () => { captureRT = null; } }');
  });
});
