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
import { validateSceneData, collapsedNewlineWarnings } from '../../packages/modoki/src/runtime/loaders/sceneValidation';
import { repoFiles } from '../../scripts/repoCorpus.mjs';
import { hasAnyProject, hasInternalGames } from '../helpers/repoLayout';
import { assertDeclaredListIsComplete } from '../helpers/declaredList';
import { readScannedSource, stringTokens, stripComments } from '@modoki/engine/testing';

/** A whitespace run the DOM collapses to one space (`white-space: normal`). ONE constant for the
 *  scene half (#676) and the code half (#841), so the two halves cannot come to disagree. */
const SPACE_RUN = /[ \t]{2,}/;
/** An authored newline, which the same collapse eats. Used by the code half only — the scene half
 *  goes through `collapsedNewlineWarnings` instead, for the reason its own test gives. */
const NEWLINE = /\n/;

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
    // Prefabs too: a prefab's authored text renders exactly like a scene's, and one spawned from
    // code is never reached through any scene — scanning scenes alone left that text unguarded.
    for (const { rel, abs } of [...scenes, ...prefabFiles]) {
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

  /** A prefab's text reaches that validator only when a scene instantiates the prefab, so a prefab
   *  spawned from code (an arrow, a pooled row) was never checked. This calls the same arm on every
   *  prefab entity directly, rather than restating the rule. */
  it('no prefab authors a newline the DOM will collapse, instantiated by a scene or not', () => {
    const findings: string[] = [];
    let withText = 0;
    for (const { rel, abs } of prefabFiles) {
      let data: RawPrefab;
      try { data = JSON.parse(fs.readFileSync(abs, 'utf8')) as RawPrefab; } catch { continue; }
      for (const e of data.entities ?? []) {
        if (typeof (e.traits?.UIElement as { text?: unknown } | undefined)?.text === 'string') withText++;
        findings.push(...collapsedNewlineWarnings(e.traits, rel));
      }
    }
    // Measured 21 prefab entities with UIElement text when this landed; the floor catches the loop
    // reaching nothing, which would otherwise pass as "no findings".
    if (hasInternalGames()) expect(withText).toBeGreaterThan(10);
    expect(
      findings,
      `authored newlines in prefab text collapse exactly as scene text does (docs/ui-system.md § spacing is layout):\n${findings.join('\n')}`,
    ).toEqual([]);
  });

  it.skipIf(!hasInternalGames())('every space-run site is a reviewed exemption', () => {
    assertDeclaredListIsComplete({
      label: 'UIElement.text space runs (#676)',
      declared: [],
      population: textSites((t) => SPACE_RUN.test(t)),
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
    expect(SPACE_RUN.test('a  b')).toBe(true);
    expect(SPACE_RUN.test('a b')).toBe(false);
  });
});

/** #841 — the same collapse, reached from CODE.
 *
 *  The describe above gates authored JSON, but both instances #676 actually fixed were string
 *  literals in `.ts` (`iap-test`'s `parts.join('   ·   ')`, `postfx-demo`'s double-spaced template).
 *  This is that half. It reads string and template tokens located by the TypeScript parser
 *  (`stringTokens`), on comment-stripped source, and tests their COOKED text — so a `\n` escape and
 *  a raw newline inside a template are the same finding.
 *
 *  **Two corpora, scoped differently on purpose** (measured 2026-09-11):
 *  - **Game and demo code is scanned WITHOUT a "reaches UIElement.text" marker.** The one known
 *    space-run literal, wordweave's `hudFormat`, is authored in `traits.ts` and reaches the DOM from
 *    `screen.ts` — a per-file marker cannot see it, nor any other flow that crosses a file. Unmarked,
 *    this corpus is quiet: one space-run token and three newline files, all ledgered below.
 *  - **Engine code is scanned only where it WRITES UIElement text** (`UI_TEXT_WRITE`). Unmarked, its
 *    strings are shader source, CSS keyframes and console text — 60+ space runs and 21 newline files,
 *    none reaching a UIElement — so an unmarked scan would be a ledger of noise nobody reads.
 *
 *  ⚠️ **What it deliberately does NOT reach**, so green is not read as more than it is:
 *  - text built at runtime (LLM chat, player names) and separators computed at runtime
 *    (`' '.repeat(n)`, `padStart(n, ' ')` — zero such calls in game code when this landed);
 *  - engine code that passes game text through without a write marker;
 *  - `tools/` (Node CLI scripts that print to a terminal and never ship), `editor/` (editor-only
 *    panels) and tests;
 *  - JSX text, which is neither a string token nor UIElement text. */
describe('shippable code does not fake spacing with whitespace (#841)', () => {
  const SKIP_SEGMENTS = ['node_modules', 'dist', 'ios', 'android', 'ads', 'release', 'tests', 'test', '__tests__', 'tools', 'editor'];
  const isSource = ({ rel }: { rel: string }) => !/\.(test|spec|d)\.tsx?$/.test(rel);
  // `floor: 0` for the same public-snapshot reason as `scenes` at the top of this file; the
  // non-vacuity pins live in the gated sanity test below.
  const projectCode = repoFiles({ under: ['games', 'demos'], match: /\.tsx?$/, exclude: SKIP_SEGMENTS, floor: 0 })
    .filter(isSource);
  const engineCode = repoFiles({
    under: ['engine/packages/modoki/src/runtime', 'engine/app'], match: /\.tsx?$/, exclude: SKIP_SEGMENTS, floor: 400,
  }).filter(isSource);

  /** A write of UIElement text, in the shapes code uses to write one: a `set`, the trait CONSTRUCTOR
   *  (`spawn`/`add(UIElement({ … }))`), a chrome patch, a UIEntries patch object, a meta-spawn, a store
   *  value. Every alternative requires its call paren or object brace, so prose and type names that
   *  merely MENTION these do not match. ⚠️ A floor on matched files cannot tell which alternatives
   *  are live (two of these match no engine file today) — the CONTROL below pins each one. */
  const UI_TEXT_WRITE = /\.set\(\s*UIElement\b|\bUIElement\s*\(\s*\{|\bpatchUI\s*\(|\bUIElement\s*:\s*\{|\buiElMeta\.trait\s*\(|\bsetUIValues\s*\(/;

  const FIX = 'Spacing between two pieces of visible text must be LAYOUT — separate flex children with an '
    + 'authored gap — never consecutive spaces or a newline inside one string, which the DOM collapses '
    + '(docs/ui-system.md § spacing is layout). If this string never reaches a UIElement, add an exempt '
    + 'row saying where it goes instead.';

  type Site = { rel: string; line: number; text: string };
  function whitespaceSites(files: { rel: string; abs: string }[]): { spaceRuns: Site[]; newlines: Site[]; tokens: number } {
    const spaceRuns: Site[] = [];
    const newlines: Site[] = [];
    let tokens = 0;
    for (const { rel, abs } of files) {
      for (const t of stringTokens(readScannedSource(abs).code, rel)) {
        tokens++;
        if (SPACE_RUN.test(t.text)) spaceRuns.push({ rel, ...t });
        if (NEWLINE.test(t.text)) newlines.push({ rel, ...t });
      }
    }
    return { spaceRuns, newlines, tokens };
  }
  let projectScanCache: ReturnType<typeof whitespaceSites> | undefined;
  const projectScan = () => (projectScanCache ??= whitespaceSites(projectCode));

  it.skipIf(!hasInternalGames())('scanned the game and demo code (sanity: the guard is not passing vacuously)', () => {
    // Measured 245 files / 10,479 string tokens when this landed. Floors sit well under that so
    // ordinary corpus change does not trip them; they exist to catch the ENUMERATION or the TOKENIZER
    // breaking, either of which would otherwise read as "no findings".
    expect(projectCode.length).toBeGreaterThan(120);
    expect(projectScan().tokens).toBeGreaterThan(5000);
  });

  it.skipIf(!hasInternalGames())('every space run in game/demo code is a reviewed exemption', () => {
    assertDeclaredListIsComplete({
      label: 'string-literal space runs in game/demo code (#841)',
      declared: [],
      population: [...new Set(projectScan().spaceRuns.map((s) => `${s.rel}::${JSON.stringify(s.text)}`))].sort(),
      floor: 1,
      fix: FIX,
      exempt: [
        { item: 'games/wordweave/runtime/traits.ts::"LEVEL {level}    {found}/{total} WORDS    {extras}/{extraTotal} EXTRA"',
          reason: 'a DELIMITER, never displayed as one string: splitHudParts (screen.ts) splits the format on its '
            + 'space runs into separate HUD parts laid out by the row — the runs are the instruction, not the spacing' },
      ],
    });
  });

  it.skipIf(!hasInternalGames())('every newline literal in game/demo code is a reviewed exemption', () => {
    // Keyed by FILE and COUNT. Every known site is a file of non-UI text, where a per-literal ledger
    // would be thirteen rows saying the same thing about ChessAI.ts — but a bare file key would also
    // excuse the NEXT newline literal anyone adds to that file, UI-bound or not. The count makes a
    // new literal change the key, so it goes red and gets looked at.
    const perFile = new Map<string, number>();
    for (const s of projectScan().newlines) perFile.set(s.rel, (perFile.get(s.rel) ?? 0) + 1);
    assertDeclaredListIsComplete({
      label: 'string-literal newlines in game/demo code (#841) — rows are `<file> ×<literal count>`; a '
        + 'count that no longer matches means a newline literal was added to or removed from that file: '
        + 'confirm the new one never reaches UI text, then update the count',
      declared: [],
      population: [...perFile].map(([rel, n]) => `${rel} ×${n}`).sort(),
      floor: 1,
      fix: FIX,
      exempt: [
        { item: 'games/chess/runtime/ai/ChessAI.ts ×13', reason: 'assembles the LLM prompt (system prompt, board, move history) sent to the model — never rendered' },
        { item: 'games/chess/runtime/ChessManager.ts ×1', reason: 'the chat-reply LLM prompt — sent to the model, never rendered; the REPLY is runtime text this scan cannot see' },
        { item: 'games/wordweave/runtime/dictionary.ts ×1', reason: "'\\n' is the delimiter of the word list it indexes — parsing data, never displayed" },
      ],
    });
  });

  it('engine code that writes UIElement text carries no space-run or newline literal', () => {
    const marked = engineCode.filter(({ abs }) => UI_TEXT_WRITE.test(readScannedSource(abs).code));
    // Measured 2 (ui/sceneChrome.ts, ui/uiValues.ts). A floor, not a pin — it catches the marker
    // breaking, which would otherwise empty this scan and pass it.
    expect(marked.length, 'UI_TEXT_WRITE matched fewer engine files than when it landed — it may have stopped matching')
      .toBeGreaterThanOrEqual(2);
    const { spaceRuns, newlines } = whitespaceSites(marked);
    expect([...spaceRuns, ...newlines].map((s) => `${s.rel}:${s.line}  ${JSON.stringify(s.text)}`), FIX).toEqual([]);
  });

  it('CONTROL: the token scan flags space runs and newlines, and nothing the DOM does not collapse', () => {
    const src = [
      "const a = 'x  y';", //                  1 flag: space run
      "const b = 'x\\t\\ty';", //              2 flag: escaped tabs cook to a tab run
      "const c = 'x\\ny';", //                 3 flag: newline escape
      'const d = `x', //                       4 flag: raw newline inside a template
      'y`;',
      'const e = `x  ${a}`;', //               6 flag: a template's static part
      "const f = 'x y';", //                   7 single space
      "const g = 'x\u2007\u2007y';", //     8 figure space (U+2007) does not collapse
      "const h = 'x\u00a0\u00a0y';", //     9 no-break space (U+00A0) does not collapse
      "// const i = 'x  y';", //               10 inside a comment
      "/* const j = 'x\\ny'; */", //           11 inside a block comment
      'const k = <b>x  y</b>;', //             12 JSX text is not a string token
    ].join('\n');
    const tokens = stringTokens(stripComments(src, { regexLiterals: true }), 'control.tsx');
    expect(tokens.filter((t) => SPACE_RUN.test(t.text)).map((t) => t.line)).toEqual([1, 2, 6]);
    expect(tokens.filter((t) => NEWLINE.test(t.text)).map((t) => t.line)).toEqual([3, 4]);
  });

  it('CONTROL: UI_TEXT_WRITE matches the write shapes and not their neighbours', () => {
    for (const s of [
      'e.set(UIElement, { ...ui, text })', "world.spawn(UIElement({ text: 'a' }))", 'e.add(UIElement( { text }))',
      "patchUI(world, 'Title', { text })",
      'entries.push({ UIElement: { text } })', 'uiElMeta.trait({ text })', 'setUIValues({ hearts: 3 })',
    ]) expect(UI_TEXT_WRITE.test(s), s).toBe(true);
    for (const s of [
      'e.get(UIElement)', 'world.query(UIElement, Transform)', 'const patchUIs = 1', 'type UIElementData = {}',
    ]) expect(UI_TEXT_WRITE.test(s), s).toBe(false);
  });
});
