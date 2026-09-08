/** Every panel that PARKS a `.meta.json` edit shows that the edit is unsaved (#870).
 *
 *  WHY. Since #845 an Inspector import-settings change parks instead of writing, so there is
 *  unsaved work in the one place the human is looking. `pendingMeta.ts` exported the entire
 *  observability surface for it — `subscribePendingMeta`, `getPendingMetaVersion`, and
 *  `isMetaDirty`, whose own docblock says *"A panel's dirty indicator"* — and **every one of them
 *  had zero consumers**. Eight panels parked; none showed anything.
 *
 *  It requires BOTH halves, because either alone is a dark indicator: a badge rendered from a
 *  constant never lights, and a subscription nothing renders tells the human nothing.
 *
 *  ⚠️ **What it CANNOT see, stated so nobody reads more into a green run than is there:** both
 *  checks are FILE-scoped, so a panel that calls `useMetaDirty` for one path and renders the badge
 *  from a different value — or for a different path — still passes. It proves the two halves are
 *  PRESENT in the file, not that they are connected to each other or to the path the panel parks.
 *  The connection is what `tests/editor/useMetaDirty.test.tsx` covers behaviourally, and the two
 *  batch views were checked by hand (`TextureBatchView`/`ModelBatchView` each pass the same
 *  `paths` they park). Asserting
 *  only the render half was this guard's own first version, and review caught it — the mutation
 *  that exposes it is "delete the `useMetaDirty` call and pass `dirty={false}`".
 *
 *  ⚠️ **The exports existing was not evidence the indicator existed, and that is exactly what made
 *  it quiet.** Anyone reading `pendingMeta.ts` sees a complete observability API and concludes the
 *  panels use it. This guard is the difference between the API existing and it being WIRED — the
 *  same distinction `metaReadPreferringPark.test.ts` draws for the read helper, and the same
 *  recurring class as `family/authoring-surface` (a field the Inspector shows and nothing reads),
 *  running in the opposite direction: here the field is read and written correctly and the STATE
 *  about it is what nothing displays.
 *
 *  Source-scan, comment-stripped through the one shared scanner, for the reason `docs/editor.md`
 *  § Panels gives: editor `.tsx` carries no tests of its own. The BEHAVIOUR of the subscription is
 *  tested separately and mutation-checked (`tests/editor/useMetaDirty.test.tsx`); this file only
 *  answers "is every parking panel wired to it at all", which no unit test can see. */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { repoFiles } from '../../scripts/repoCorpus.mjs';
import { readScannedSource } from '@modoki/engine/testing';

const PANELS = path.resolve(__dirname, '../../packages/modoki/src/editor/panels');
const PREFIX = 'engine/packages/modoki/src/editor/panels/';

/** THROW rather than tolerate a miss, so a drift in the enumeration root cannot silently stop
 *  matching — same convention, and same reason, as `metaReadPreferringPark.test.ts`. */
function panelFiles(): string[] {
  return repoFiles({ under: PANELS, match: /\.tsx$/, floor: 10 }).map(({ rel }) => {
    if (!rel.startsWith(PREFIX)) {
      throw new Error(`metaDirtyIndicator: ${rel} is not under "${PREFIX}" — the enumeration root and this prefix strip have drifted.`);
    }
    return rel.slice(PREFIX.length);
  });
}

const read = (rel: string) => readScannedSource(path.join(PANELS, rel)).code;

/** Panels that park a `.meta.json` edit and deliberately render no badge of their own. */
const EXEMPT: Record<string, string> = {
  'Inspector.tsx':
    'the model-postprocessor row parks `asset.path`, and this same component renders '
    + '<ModelAssetView path={asset.path} …> directly below, which DOES carry the badge for that '
    + 'path. A badge here would put two markers on screen for one edit. This holds because the '
    + 'badge is keyed on the PATH, not on which control made the edit.',
};

/** `true` if `code` (comment-stripped) CALLS `parkMetaEdit`.
 *
 *  ⚠️ The trailing `(` matters, and it is not pedantry — the sibling guard's seeder check was
 *  written without one and silently matched the file's own `import` statement, going vacuously
 *  green for the single regression it existed to catch. An import names the symbol bare; a call
 *  follows it with a paren. */
/** ⚠️ Two routes, one property (#903). The batch views no longer call `parkMetaEdit` themselves —
 *  they hand a PLAN to `parkPlannedMetaEdits`, which parks each member. They park just as much as
 *  they ever did, so a detector that names only the old route drops them OUT of the corpus below
 *  and this guard goes silently blind to two panels. Widened rather than letting the count fall,
 *  which is what the vacuity check caught. */
const parks = (code: string) => /\b(parkMetaEdit|parkPlannedMetaEdits)\s*\(/.test(code);
/** `true` if `code` RENDERS the badge. A JSX element, so `<` is the discriminator against the
 *  import and against the component's own definition. */
const showsBadge = (code: string) => /<UnsavedMetaBadge\b/.test(code);
/** `true` if `code` SUBSCRIBES to the registry.
 *
 *  ⚠️ Rendering the badge is NOT the same as wiring it, and asserting only the first is how this
 *  guard came within one review of claiming something it did not check. Measured: delete
 *  `const metaDirty = useMetaDirty(path)` from a panel and pass `dirty={false}`, and the badge is
 *  permanently dark while `showsBadge` stays true — the exports-exist-so-it-must-work failure this
 *  guard was written to close, reappearing inside the guard itself. Both are required now. */
const subscribes = (code: string) => /\buseMetaDirty\s*\(/.test(code);

describe('a parked .meta.json edit is visible in the panel that made it (#870)', () => {
  it('panelFiles enumerates a real, non-trivial corpus (sanity: the scan works)', () => {
    expect(panelFiles().length).toBeGreaterThan(10);
  });

  it('every panel that parks a .meta.json edit renders the unsaved badge', () => {
    const silent = panelFiles()
      .filter((rel) => !(rel in EXEMPT))
      .filter((rel) => { const c = read(rel); return parks(c) && !(showsBadge(c) && subscribes(c)); });
    expect(
      silent,
      [
        'These panels PARK a .meta.json import-settings edit and show nothing to say it is unsaved.',
        'Since #845 that edit does not reach disk until Cmd+S, so the human who made it gets no',
        'sign it is still pending — and the HMR reload banner, which is the only other surface,',
        'appears at the moment the edit is about to be DESTROYED. Render',
        '<UnsavedMetaBadge dirty={useMetaDirty(<your path(s)>)} dataUiId="assetView.<kind>.unsaved" />,',
        'or add an entry to EXEMPT with the reason the human still sees it. BOTH halves are',
        'required: a badge rendered from a constant is dark forever, and a subscription nothing',
        'renders tells the human nothing.',
        '',
        ...silent,
      ].join('\n'),
    ).toEqual([]);
  });

  /** The premise this rule rests on. If nothing parks, the check above is vacuous and would stay
   *  green through a refactor that renamed `parkMetaEdit` out from under it. */
  it('the corpus really does contain parking panels — the rule is not vacuous', () => {
    const parking = panelFiles().filter((rel) => parks(read(rel)));
    expect(parking.length, 'no panel parks a .meta.json edit — has parkMetaEdit been renamed?')
      .toBeGreaterThanOrEqual(8);
  });

  it('every exemption still parks — a stale exemption hides nothing', () => {
    const stale = Object.keys(EXEMPT).filter((rel) => !parks(read(rel)));
    expect(stale, 'These exemptions no longer park a .meta.json edit — drop the entry.').toEqual([]);
  });

  it('every exemption is a real file this scan enumerates', () => {
    // A typo'd path exempts nothing while still reading as "handled" — the filter only skips names
    // that MATCH, so a wrong one protects a file that was never at risk and leaves the real one
    // unexamined.
    const known = new Set(panelFiles());
    expect(Object.keys(EXEMPT).filter((rel) => !known.has(rel))).toEqual([]);
  });

  // ⚠️ Both detectors pinned directly. A guard whose detector matches an import rather than a use
  // is green for the wrong reason, and the corpus being clean cannot tell the difference.
  it('the detectors match a USE and not a mention', () => {
    expect(parks('parkMetaEdit(path, updated);')).toBe(true);
    expect(parks("import { parkMetaEdit } from '../scene/pendingMeta';")).toBe(false);
    // …and the batch route, pinned the same way, so widening the detector did not widen it into
    // matching the import too.
    expect(parks("parkPlannedMetaEdits(next, 'TextureBatchView');")).toBe(true);
    expect(parks("import { parkPlannedMetaEdits } from './metaBatchLoad';")).toBe(false);
    expect(showsBadge('<UnsavedMetaBadge dirty={d} dataUiId="x" />')).toBe(true);
    expect(showsBadge("import { UnsavedMetaBadge } from './UnsavedMetaBadge';")).toBe(false);
    expect(subscribes('const metaDirty = useMetaDirty(path);')).toBe(true);
    expect(subscribes('const metaDirty = useMetaDirty (paths);')).toBe(true);
    expect(subscribes("import { useMetaDirty } from '../useMetaDirty';")).toBe(false);
    expect(subscribes('import {\n  useMetaDirty,\n} from "../useMetaDirty";')).toBe(false);
  });

  /** The premise the ADDED half rests on: some panel really does subscribe, so a rename of
   *  `useMetaDirty` cannot make the new requirement vacuously satisfiable by nobody. */
  it('the corpus really does contain subscribing panels', () => {
    const wired = panelFiles().filter((rel) => subscribes(read(rel)));
    expect(wired.length, 'no panel calls useMetaDirty — has it been renamed?').toBeGreaterThanOrEqual(8);
  });
});
