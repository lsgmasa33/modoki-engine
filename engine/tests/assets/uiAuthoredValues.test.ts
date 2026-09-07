/**
 * Preventative corpus guard for the #671 (entry-prefab-root) and #809 (lineHeight-as-multiplier)
 * `sceneValidation` arms — the equivalent of `prefabInertSize.test.ts` for these two newer checks:
 * enumerate every committed scene/prefab and assert `validateSceneData` reports NEITHER finding
 * over the real content.
 *
 * ⚠️ Do not read the zero below as a live measurement, or "re-tune" it against a future count.
 * #809's own migration took its corpus count from 17 findings to 0 — a docblock phrased as "this
 * currently catches N" goes stale the moment ANY branch changes UI content (the #549 scar, cited
 * directly in `sceneValidation.ts`'s own `LINE_HEIGHT_MULTIPLIER_CEILING` docs). This is a
 * PREVENTATIVE guard, not an inventory: its job is to keep the count at zero, and the "zero
 * findings" assertion alone cannot tell "clean" from "the check stopped running" — that is what
 * the positive controls below are for.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { validateSceneData } from '../../packages/modoki/src/runtime/loaders/sceneValidation';
import { repoFiles } from '../../scripts/repoCorpus.mjs';
import { hasAnyProject, hasInternalGames } from '../helpers/repoLayout';
import { assertDeclaredListIsComplete } from '../helpers/declaredList';

type RawEntity = { traits?: Record<string, unknown> };
type RawScene = { entities?: RawEntity[] };
type RawPrefab = { id?: string; rootLocalId?: number; entities?: { localId?: number; traits?: Record<string, unknown> }[] };

// git-backed enumeration (#771/#799), not a filesystem walk — a walk would pick up a LOCAL
// playable-export or a stale build dir on whichever clone happens to have run one, making this
// guard's result depend on what its runner built rather than on the committed corpus.
// `floor: 0` at module scope, same reasoning as `prefabInertSize.test.ts`: this must not throw on
// a checkout that ships no games/demos content at all (the public release snapshot) — the real
// non-vacuity pin lives in the `skipIf`-gated sanity test below, where it can be skipped honestly.
const scenes = repoFiles({
  under: ['games', 'demos'],
  match: /\.scene\.json$/,
  exclude: ['dist', 'ios', 'android', 'ads', 'release', 'node_modules'],
  floor: 0,
});
const prefabFiles = repoFiles({
  under: ['games', 'demos'],
  match: /\.prefab\.json$/,
  exclude: ['dist', 'ios', 'android', 'ads', 'release', 'node_modules'],
  floor: 0,
});

/** These two arms are the ones this guard polices — filtered out of `validateSceneData`'s full
 *  warning list so a finding from an unrelated arm (ref integrity, the #16/#757 size/margin
 *  checks, which already have their own guards) can't be mistaken for one of these two. Matches
 *  both `entryPrefabRootWarnings` ("...used as entry kind...") and `entryBankWarnings`
 *  ("...UIEntries.prefabs...") for #671, and `lineHeightUnitWarnings` for #809. */
const isGuardedFinding = (w: string) => /lineHeight|entry kind|UIEntries\.prefabs/.test(w);

function loadPrefabsByGuid(): Map<string, RawPrefab> {
  const map = new Map<string, RawPrefab>();
  for (const { abs } of prefabFiles) {
    try {
      const data = JSON.parse(fs.readFileSync(abs, 'utf8')) as RawPrefab;
      if (typeof data.id === 'string') map.set(data.id, data);
    } catch { /* an unparseable prefab is a different, louder failure the loader already reports */ }
  }
  return map;
}

describe('committed UI content authors no #671/#809 finding', () => {
  it.skipIf(!hasAnyProject())('found scenes/prefabs to scan (sanity: the guard is not passing vacuously)', () => {
    // Without this, a broken enumeration (a moved project root, a `match` that stops matching)
    // turns the whole file into a silent pass — the failure mode that makes a coverage guard
    // worse than none. Floors sit well under the measured counts (58 scenes / 85 prefabs) so
    // ordinary corpus growth/shrinkage doesn't trip it — see the module docblock for why this
    // number is a floor, not a pinned measurement.
    expect(scenes.length).toBeGreaterThan(hasInternalGames() ? 20 : 0);
    expect(prefabFiles.length).toBeGreaterThan(hasInternalGames() ? 20 : 0);
  });

  it('no scene/prefab authors an inert entry-prefab-root value or a multiplier-shaped lineHeight', () => {
    const prefabsByGuid = loadPrefabsByGuid();
    const getPrefab = (ref: string) => prefabsByGuid.get(ref);
    const findings: string[] = [];
    for (const { rel, abs } of scenes) {
      let data: unknown;
      try { data = JSON.parse(fs.readFileSync(abs, 'utf8')); } catch { continue; } // a louder failure elsewhere
      const { warnings } = validateSceneData(data, undefined, getPrefab, undefined);
      for (const w of warnings) if (isGuardedFinding(w)) findings.push(`${rel} -> ${w}`);
    }
    expect(
      findings,
      `#671/#809 validator finding(s) in committed content:\n${findings.join('\n')}`,
    ).toEqual([]);
  });

  // ── POSITIVE CONTROLS ──────────────────────────────────────────────────────────────────────
  // A "zero findings" assertion above means nothing if the arm cannot fire at all — this repo's
  // dominant defect class is a mechanism that cannot fire (a field nothing reads, a check gated on
  // the wrong condition). Each control mutates a REAL scene/prefab pair drawn from the corpus
  // itself (rather than a hand-built fixture) and asserts the specific arm reports it, so a change
  // that silently disarms either check goes red HERE instead of the corpus test just quietly
  // staying at "0 findings" either way. Gated on `hasInternalGames()`, not `hasAnyProject()`: the
  // shapes these need (a UIElement+fontSize entity; a UIEntries view pointing at a resolvable
  // prefab) are drawn from `games/`, and the public demos-only snapshot is not guaranteed to carry
  // either — see `hasInternalGames()`'s own docs on why the loose predicate is the wrong gate here.
  it.skipIf(!hasInternalGames())('CONTROL: an injected lineHeight multiplier is caught', () => {
    let firedOn: string | undefined;
    for (const { rel, abs } of scenes) {
      let data: RawScene;
      try { data = JSON.parse(fs.readFileSync(abs, 'utf8')); } catch { continue; }
      const victim = (data.entities ?? []).find((e) => {
        const uel = e.traits?.UIElement as Record<string, unknown> | undefined;
        return !!uel && typeof uel.fontSize === 'number';
      });
      if (!victim) continue;
      (victim.traits!.UIElement as Record<string, unknown>).lineHeight = 1.4;
      const { warnings } = validateSceneData(data);
      if (warnings.some((w) => /lineHeight/.test(w))) { firedOn = rel; break; }
    }
    expect(
      firedOn,
      'no scene in the corpus produced a lineHeight finding after injecting a 1.4 multiplier — the arm may be disarmed',
    ).toBeDefined();
  });

  it.skipIf(!hasInternalGames())('CONTROL: an injected entry-prefab-root margin is caught through the view->prefab JOIN', () => {
    const prefabsByGuid = loadPrefabsByGuid();
    let firedOn: string | undefined;
    for (const { rel, abs } of scenes) {
      let data: RawScene;
      try { data = JSON.parse(fs.readFileSync(abs, 'utf8')); } catch { continue; }
      const view = (data.entities ?? []).find((e) => e.traits?.UIEntries);
      if (!view) continue;
      let bank: { prefab?: string }[];
      try { bank = JSON.parse(String((view.traits!.UIEntries as Record<string, unknown>).prefabs || '[]')); } catch { continue; }
      const guid = bank[0]?.prefab;
      const original = guid ? prefabsByGuid.get(guid) : undefined;
      if (!original) continue;
      const mutated: RawPrefab = JSON.parse(JSON.stringify(original));
      const rootLocal = mutated.rootLocalId ?? mutated.entities?.[0]?.localId;
      const root = mutated.entities?.find((e) => e.localId === rootLocal) ?? mutated.entities?.[0];
      if (!root) continue;
      root.traits = { ...(root.traits ?? {}), UIElement: { ...(root.traits?.UIElement as Record<string, unknown> ?? {}), marginBottom: 8 } };
      const { warnings } = validateSceneData(
        data, undefined, (ref: string) => (ref === guid ? mutated : prefabsByGuid.get(ref)),
      );
      if (warnings.some((w) => /entry kind/.test(w))) { firedOn = `${rel} (prefab ${guid})`; break; }
    }
    expect(
      firedOn,
      'no scene/prefab pair in the corpus produced an entry-kind finding after injecting a marginBottom — the JOIN may be disarmed',
    ).toBeDefined();
  });
});

/** #676 — spacing done with whitespace, which the DOM collapses.
 *
 *  Two halves of ONE mechanism (`white-space: normal` eats any whitespace run), enforced in two
 *  different places on purpose:
 *
 *  - **Newlines** have no accepted instances, so they are checked by `collapsedNewlineWarnings` in
 *    `sceneValidation.ts` — loud, on a dev hot-reload and through `/api/validate-scene` /
 *    `modoki_validate_scene` (never on a production runtime load) — and asserted at ZERO here.
 *  - **Space runs** have twelve accepted instances (owner, 2026-09-07): the `·` and `──`
 *    separators stay legible when they tighten, and Court's shipping rules lines are not worth
 *    restructuring for a few px of list indent. Warning on those every time a dev hot-reloads or
 *    validates a shipping game's scene would print twelve lines, which is how a check gets muted
 *    and takes its useful half with it. So the space-run rule lives HERE, at the gate, where an
 *    exemption can carry a written reason instead of being silence.
 *
 *  ⚠️ The ledger is not a way to make the guard quiet. A NEW space-run site fails and must either
 *  be converted to layout or earn a row with a reason — the point is that accepting one becomes a
 *  visible, reviewed act rather than a thing nobody notices. */
describe('committed UI content does not fake spacing with whitespace (#676)', () => {
  /** `${rel}::${entityName}` — the path is part of the identity because `space-console` authors the
   *  same entity NAMES in two scenes (Station and Warp), and a name-only key would silently
   *  collapse those into one row that vouches for both. */
  function textSites(predicate: (text: string) => boolean): string[] {
    const out: string[] = [];
    for (const { rel, abs } of scenes) {
      let data: RawScene;
      try { data = JSON.parse(fs.readFileSync(abs, 'utf8')) as RawScene; } catch { continue; }
      for (const e of data.entities ?? []) {
        const uel = e.traits?.UIElement as Record<string, unknown> | undefined;
        const text = uel?.text;
        if (typeof text !== 'string' || !text || !predicate(text)) continue;
        // Skip the paths that legitimately reach a `pre-wrap` span, where authored whitespace IS
        // honoured — the same two exclusions `collapsedNewlineWarnings` makes, kept in step with
        // it deliberately: a guard stricter than the runtime check would fail on correct content.
        // `maxLines` is deliberately NOT one of them — it clamps height, not whitespace (F2).
        if (uel?.autoFitText === true) continue;
        if (e.traits?.TextAnimation) continue;
        const name = (e.traits?.EntityAttributes as { name?: unknown } | undefined)?.name;
        out.push(`${rel}::${typeof name === 'string' ? name : '?'}`);
      }
    }
    return out.sort();
  }

  /** ⚠️ This drives `validateSceneData` rather than re-scanning the text itself, deliberately.
   *  A second scan here would be a second implementation of the same rule — it would pass happily
   *  while `collapsedNewlineWarnings` sat disarmed, which is precisely the "green because it never
   *  ran" failure the controls above exist to prevent. Going through the validator means this test
   *  covers BOTH the content and the arm. (The space-run half below cannot do this: the validator
   *  deliberately does not check space runs at all — see this describe block's docblock.) */
  it('no scene authors a newline the DOM will collapse', () => {
    const findings: string[] = [];
    for (const { rel, abs } of scenes) {
      let data: unknown;
      try { data = JSON.parse(fs.readFileSync(abs, 'utf8')); } catch { continue; }
      for (const w of validateSceneData(data).warnings) {
        if (/authors \d+ lines/.test(w)) findings.push(`${rel} -> ${w}`);
      }
    }
    expect(
      findings,
      'authored newlines collapse to a single space on the plain text path, so this renders as one '
      + 'run-on paragraph. Split it into sibling text elements in a column with an authored gap '
      + '(docs/ui-system.md § spacing is layout). Do NOT add white-space: pre-wrap — that was '
      + `considered and declined, see the doc.\n${findings.join('\n')}`,
    ).toEqual([]);
  });

  it.skipIf(!hasInternalGames())('CONTROL: an injected newline is caught through the validator', () => {
    let firedOn: string | undefined;
    for (const { rel, abs } of scenes) {
      let data: RawScene;
      try { data = JSON.parse(fs.readFileSync(abs, 'utf8')) as RawScene; } catch { continue; }
      const victim = (data.entities ?? []).find((e) => {
        const uel = e.traits?.UIElement as Record<string, unknown> | undefined;
        return !!uel && typeof uel.text === 'string' && !!uel.text
          && uel.autoFitText !== true && !e.traits?.TextAnimation;
      });
      if (!victim) continue;
      const uel = victim.traits!.UIElement as Record<string, unknown>;
      uel.text = `${String(uel.text)}\nsecond line`;
      if (validateSceneData(data).warnings.some((w) => /authors \d+ lines/.test(w))) { firedOn = rel; break; }
    }
    expect(
      firedOn,
      'no scene produced a newline finding after injecting one — collapsedNewlineWarnings may be disarmed',
    ).toBeDefined();
  });

  it.skipIf(!hasInternalGames())('every space-run site is a reviewed exemption', () => {
    assertDeclaredListIsComplete({
      label: 'UIElement.text space runs (#676)',
      declared: [],
      population: textSites((t) => /[ \t]{2,}/.test(t)),
      // Well under the twelve rows below: this floor exists to catch the MARKER breaking (a regex
      // that stops matching makes every assertion here vacuous), not to pin the corpus. Converting
      // a few of these to layout later is expected and must not fail the gate — the stale-exemption
      // check is what handles that, by telling you to delete the row.
      floor: 8,
      fix: 'A new authored string is faking spacing with consecutive spaces. Convert it to layout '
        + '(separate flex children + an authored gap), or add an exempt row here saying why the '
        + 'collapse is acceptable for that specific string.',
      exempt: [
        { item: 'demos/2d-physics-demo/runtime/assets/scenes/platformer.scene.json::Credits Link',
          reason: 'the · separator is a visible glyph, so the grouping survives the collapse — only the padding tightens' },
        { item: 'demos/particle-demo/runtime/assets/scenes/main.scene.json::Now Showing',
          reason: 'a numeric label prefix; the collapse costs one space of indent and loses no structure' },
        { item: 'games/3d-test/runtime/assets/scenes/ui-focus-demo.scene.json::Status',
          reason: 'parenthetical hint, still legible single-spaced; this scene is an input-focus test fixture, not shipped UI' },
        { item: 'games/3d-test/runtime/assets/scenes/ui-focus-demo.scene.json::Subtitle',
          reason: '· separators remain visible; the sibling PromptLine in this scene WAS converted, being the one whose grouping carried meaning' },
        { item: 'games/court/runtime/assets/scenes/main.scene.json::RulesLine1',
          reason: 'shipping game: the double space is list indent after "1.", so the collapse costs a few px and no meaning — not worth restructuring a shipping dialog' },
        { item: 'games/court/runtime/assets/scenes/main.scene.json::RulesLine2', reason: 'as RulesLine1' },
        { item: 'games/court/runtime/assets/scenes/main.scene.json::RulesLine3', reason: 'as RulesLine1' },
        { item: 'games/court/runtime/assets/scenes/main.scene.json::RulesLine4', reason: 'as RulesLine1' },
        { item: 'games/space-console/runtime/assets/scenes/Station.scene.json::CreditHead_42',
          reason: 'decorative ── rule around a heading; the dashes carry the structure, the spaces only pad them' },
        { item: 'games/space-console/runtime/assets/scenes/Station.scene.json::CreditHead_47', reason: 'as CreditHead_42' },
        { item: 'games/space-console/runtime/assets/scenes/Warp.scene.json::CreditHead_42', reason: 'as Station CreditHead_42 (Warp duplicates the credits block)' },
        { item: 'games/space-console/runtime/assets/scenes/Warp.scene.json::CreditHead_47', reason: 'as Station CreditHead_42 (Warp duplicates the credits block)' },
      ],
    });
  });

  it('CONTROL: the space-run marker still matches', () => {
    // Same reasoning as the controls above — an "everything is exempt" pass and a "the regex
    // stopped matching" pass look identical from the outside.
    expect(/[ \t]{2,}/.test('a  b')).toBe(true);
    expect(/[ \t]{2,}/.test('a b')).toBe(false);
  });
});
