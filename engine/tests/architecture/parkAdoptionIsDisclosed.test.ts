/** ⚠️ **A panel that OPENS ON A PARKED EDIT and offers a Retry must say which document it opened —
 *  and the population is DERIVED, not hand-listed** (#902).
 *
 *  Asking the registry before the file is correct and must stay: a parked write is not on disk, so
 *  re-reading the file would show — and re-seed the live cache with — the PRE-edit document
 *  (`pendingAssetDoc`'s docblock, #831/#843, QA-CTX-0008). The defect is that the diversion was
 *  SILENT, which one sequence turns into lost work:
 *
 *  1. the file is corrupt or too-new, so the panel REFUSES it and tells the human to repair and Retry;
 *  2. an agent op parks an edit for that path (every agent op parks unconditionally);
 *  3. the human repairs the file and clicks **Retry**;
 *  4. the load takes the park branch, the banner clears — and Cmd+S replaces the repair.
 *
 *  ## Why the corpus is derived from TWO properties, and what that caught
 *
 *  #902 named five panels: the `useParkedAssetDoc` editors. That is the wrong population for THIS
 *  defect. What makes a site vulnerable is **park-first load AND a Retry control** — the Retry is
 *  what makes the panel promise a re-read it does not perform — and that intersection is SEVEN:
 *  the five, plus `AtlasAssetView` and `MaterialBatchView`. Both were missed by the ticket's list.
 *
 *  This matters beyond the two: #896's history is three rounds of fixing four of five sites and
 *  leaving the fifth, and a hand-list here would repeat it one level up. Derived, an eighth site is
 *  covered the day it is written.
 *
 *  ⚠️ **The three park-first views with NO Retry are excluded BY THE DERIVATION, not by an
 *  exemption list.** `MaterialAssetView`, `AnimSetAssetView` and `ShaderAssetView` consult the park
 *  first and never offer a Retry, so step 1's promise cannot be made and step 3 cannot happen. They
 *  still adopt silently on a remount — the same disclosure gap without the trap — and if one ever
 *  grows a Retry button it is pulled into this guard automatically, which is the point.
 *
 *  ⚠️ **Why a source scan and not a render test.** `docs/editor.md` § Panels: editor `.tsx` is not
 *  mounted in jsdom, because that asserts the mock rather than the panel. The limit, stated rather
 *  than implied: **this proves the disclosure is WIRED, not that it renders in a reachable place.**
 *  Two panels have already shipped a banner below their own early return, where it could never
 *  appear — that class is invisible to any scan and needs the live check. The loader half that IS a
 *  plain decision (`materialBatchLoad`'s `adopted`) is unit-tested directly. */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { readScannedSource } from '@modoki/engine/testing';
import { repoFiles } from '../../scripts/repoCorpus.mjs';

const PANELS = 'engine/packages/modoki/src/editor/panels';

/** Does this panel consult the park registry on load?
 *
 *  ⚠️ **TWO markers, because there are two ways to consult it — and the comment here used to name a
 *  predicate the code did not have.** `pendingAssetDoc(` reaches the six direct consumers;
 *  `parked:` reaches a batch view, which hands the registry to its extracted loader as a
 *  DEPENDENCY. `MaterialBatchView` satisfied the first marker only by accident — its dependency
 *  literal happens to be `parked: (p) => pendingAssetDoc(p, 'material')` — so a batch view passing a
 *  hoisted helper (`parked: registryLookup`) would have dropped out of this corpus entirely, taking
 *  every rule in this file with it. That is the fail-open shape the sibling guard grew a count floor
 *  for.
 *
 *  Extracted from `parkFirstPanels` so it can be pinned on a STRING: a corpus predicate exercised
 *  only by the repo's current files is one nobody can show the behaviour of, and this one has
 *  already been wrong once. */
function consultsTheRegistry(code: string): boolean {
  return /\bpendingAssetDoc\s*\(/.test(code) || /\bparked\s*:/.test(code);
}

/** Every panel whose load prefers a PARKED asset document over the file. */
function parkFirstPanels(): Array<{ rel: string; code: string }> {
  const out: Array<{ rel: string; code: string }> = [];
  for (const { abs, rel } of repoFiles({ under: PANELS, match: /\.tsx$/, floor: 3 })) {
    if (rel.includes('.test.')) continue;
    const code = readScannedSource(abs).code;
    if (!consultsTheRegistry(code)) continue;
    out.push({ rel, code });
  }
  return out;
}

/** …and of those, the ones that offer the human a RETRY — the promise of a re-read. */
function hasRetry(code: string): boolean {
  return /\bonRetry=/.test(code) || /\bretryLoad\b/.test(code) || /data-ui-label="Retry"/.test(code);
}

describe('a park-first panel with a Retry discloses that it opened on the park (#902)', () => {
  it('splits the park-first panels by whether they promise a re-read', () => {
    const all = parkFirstPanels();
    const withRetry = all.filter((p) => hasRetry(p.code)).map((p) => path.basename(p.rel)).sort();
    const without = all.filter((p) => !hasRetry(p.code)).map((p) => path.basename(p.rel)).sort();

    // Non-vacuity with NAMED expectations, on BOTH sides: an empty scan, or a `hasRetry` that
    // answered true for everything, would make the real assertion below pass having proved nothing.
    // ⚠️ The two names #902's own list did not have are `AtlasAssetView` and `MaterialBatchView`.
    expect(withRetry).toEqual([
      'AnimationEditor.tsx', 'AtlasAssetView.tsx', 'MaterialBatchView.tsx', 'ParticleEditor.tsx',
      'SkinEditor.tsx', 'SpriteAnimEditor.tsx', 'TimelineEditor.tsx',
    ]);
    // The boundary, pinned so shrinking it is a deliberate act: these adopt silently on a remount
    // too, but they never tell the human to Retry, so the sequence above cannot start.
    expect(without).toEqual([
      'AnimSetAssetView.tsx', 'MaterialAssetView.tsx', 'ShaderAssetView.tsx',
    ]);

    // ⚠️ The corpus PREDICATE, pinned on strings — the lists above cannot show it, because every
    // file in the repo today happens to satisfy the first marker.
    expect(consultsTheRegistry("const parked = pendingAssetDoc(path, 'atlas');")).toBe(true);
    expect(consultsTheRegistry('  parked: registryLookup,')).toBe(true);
    expect(consultsTheRegistry("  parked: (p) => pendingAssetDoc(p, 'material'),")).toBe(true);
    expect(consultsTheRegistry('const doc = await fetchDoc(path);')).toBe(false);
  });

  it('each one RENDERS the shared notice', () => {
    const missing = parkFirstPanels()
      .filter((p) => hasRetry(p.code))
      // ⚠️ `<ParkAdoptedBanner`, not the bare name: a bare-name regex is satisfied by the file's own
      // IMPORT, so deleting the JSX would keep this green. (Measured — the sibling guard for #903
      // shipped that mistake and it took a mutation check to find.)
      .filter((p) => !/<ParkAdoptedBanner\b/.test(p.code))
      .map((p) => p.rel);

    expect(missing, [
      'These panels prefer a PARKED document over the file AND offer a Retry, but never tell the',
      'human when the Retry adopted the park instead of re-reading the repaired file. The park',
      'winning is correct; the swap being silent is the defect — Cmd+S then replaces the repair.',
      '',
      'Fix: hold a per-COMPONENT `parkAdopted` flag (the registry cannot answer this — a park is',
      'equally present when the panel opened on the FILE and the human then edited), set it in the',
      'adoption branch, clear it at the top of every load, and render <ParkAdoptedBanner> with this',
      "panel's own reload as `onReload`.",
      '',
      ...missing,
    ].join('\n')).toEqual([]);
  });

  it('each one CLEARS the notice on a fresh load, so it cannot outlive the state it announces', () => {
    // A notice that is raised and never lowered is worse than none: after one adoption every
    // subsequent load — including the one that finally read the repaired file — still claims the
    // panel is showing an unsaved edit. Same class as a "pending" flag that survives the transition
    // it announces.
    //
    // ⚠️ **Counting, not merely matching, and the difference is what this assertion is FOR.** The
    // first version tested `/setParkAdopted\(false\)/` and stayed GREEN when the load-path reset was
    // deleted — because the `onKeep` handler in the JSX calls the same setter with the same
    // argument. A presence check cannot tell a load reset from a dismiss handler. Two call sites is
    // what distinguishes them, and the dismiss one is the copy that survives a careless edit
    // (it sits inline in the banner it dismisses).
    //
    // The limit, stated: this proves there are two lowering call sites, not that one of them is in
    // the load effect. Nothing a scan can do proves that; the live check is what covers it.
    const CLEARS: Array<{ when: RegExp; ok: (code: string) => boolean }> = [
      // A panel with its own boolean flag: cleared on every load AND on dismiss.
      { when: /setParkAdopted\(/, ok: (c) => (c.match(/setParkAdopted\(false\)/g) ?? []).length >= 2 },
      // The batch view has no boolean — it derives the notice from the loader's report, so the
      // per-load reset IS that assignment. Without it the list only ever grows.
      { when: /setAdopted\(/, ok: (c) => /setAdopted\(\s*fromPark\s*\)/.test(c) },
    ];

    const missing = parkFirstPanels()
      .filter((p) => hasRetry(p.code) && /<ParkAdoptedBanner\b/.test(p.code))
      .filter((p) => {
        const rule = CLEARS.find((r) => r.when.test(p.code));
        return !rule || !rule.ok(p.code);   // no recognised setter at all is also a failure
      })
      .map((p) => p.rel);
    expect(missing, `These panels raise the park notice but never lower it on a fresh load:\n${missing.join('\n')}`).toEqual([]);
  });

  it('a SET-shaped notice is never grown outside the loader (MaterialBatchView\'s class)', () => {
    // ⚠️ Review finding, and the one that would have shipped a destructive button under the human's
    // cursor. `MaterialBatchView` added to `adopted` from its `useAssetViewRefreshers` callback,
    // justified by "a refresher fires because ANOTHER surface parked this path". That is false:
    // `persistAssetEdit` ends with `_assetViewSetters.get(path)?.(updated)` — the setter registered
    // for that path, which is THIS panel's own — and `writeAll` calls it for every member. So one
    // drag of the Roughness slider on three materials raised three banners saying the panel had
    // opened on an unsaved edit it had in fact just made, each offering to discard the human's own
    // work, with `onKeep` useless because the next tick re-added the path.
    //
    // Only the LOADER knows whether THIS load took the park branch — which is exactly what
    // `ParkAdoptedBanner`'s docblock says, and a refresher is a registry-derived signal that cannot
    // tell the two cases apart.
    //
    // ⚠️ **This rule matches the defect's SHAPE — a call that grows the set — not its location.**
    // The first version scanned "inside a refresher callback" and was withdrawn: its block regex
    // could not terminate on `useAssetViewRefresher(path, useCallback(…, []));`, ran past the end,
    // swallowed the following load effect, and flagged `AtlasAssetView` for a `setParkAdopted(true)`
    // that is correct. A guard that fails on a correct file is worse than no guard. Legitimate
    // writes REPLACE the set (`setAdopted(fromPark)`) or shrink it (`onKeep`'s filter); adding to it
    // is the defect and nothing else needs to.
    const ADDS = /set(?:Adopted|ParkAdopted)\s*\([\s\S]{0,200}?(?:\[\s*\.\.\.|\.concat\s*\()/;
    const offenders = parkFirstPanels().filter((p) => ADDS.test(p.code)).map((p) => p.rel);
    expect(offenders, [
      'These panels ADD to the park-adopted set instead of letting the loader replace it. Whatever',
      'event drives that add is not "this load opened on a park" — the loader is the only thing that',
      'knows, and every other signal fires on the panel\'s own edit too.',
      '',
      ...offenders,
    ].join('\n')).toEqual([]);

    // Non-vacuity: the detector must catch the defect's literal shape, pinned directly rather than
    // inferred from the corpus being clean.
    expect(ADDS.test('setAdopted((a) => (a.includes(p) ? a : [...a, p]));')).toBe(true);
    expect(ADDS.test('setAdopted((a) => a.concat(p));')).toBe(true);
    expect(ADDS.test('setAdopted(fromPark);')).toBe(false);
    expect(ADDS.test('setAdopted((a) => a.filter((x) => x !== p));')).toBe(false);
    expect(ADDS.test('setParkAdopted(true);')).toBe(false);
  });

  // ⚠️ **THE REACH OF THE RULE ABOVE, stated because its first title over-claimed it.** It was
  // called "only the LOADER may mark a member adopted", which is the property we want — but the
  // regex catches only a write that GROWS A SET, and only `MaterialBatchView` keeps a set. The five
  // boolean editors hold `parkAdopted`, and the same defect there (`setParkAdopted(true)` raised
  // from an edit-time signal rather than from the load) matches nothing here; the self-pin above
  // deliberately asserts `setParkAdopted(true)` does NOT match, because the park branch and the
  // `if (existing)` branch both legitimately call it.
  //
  // Verified UNREACHABLE today rather than merely unlikely: none of the five registers
  // `useAssetViewRefreshers`, their load effects key only on `[asset?.path, nonce]`, and every
  // writer of those nonces nulls the document first — so the `if (existing)` branch cannot run on
  // the same tick as an edit, which is what made the MaterialBatchView case fire. A coverage gap,
  // not a live defect, and it stops being one the moment a boolean editor gains a refresher.

  it("each panel's onReload is a REAL re-read, not a bare local nonce", () => {
    // ⚠️ Review finding, and the sharpest one in this change: ParticleEditor's Discard & reload was
    // wired to `setReloadNonce`, and a bare nonce re-runs the load effect, which early-returns on
    // `if (existing)` — truthy precisely BECAUSE the park branch had just loaded the adopted doc.
    // With the park now discarded, that branch marks the DISCARDED document as the saved baseline
    // and returns. Net: the repaired file is never read, the notice disappears, and the next edit
    // parks a wholesale replace of the stale doc over the repair. #902's own loss, through the
    // button that fixes it.
    //
    // The rule the corpus is held to: a panel with a store-doc early return must reload through
    // `reloadEditingAsset` (which NULLS the doc slot, removing that return) — never a local nonce.
    //
    // ⚠️ **`assetEditorRefusesUnreadableDoc.test.ts`'s retry rule does NOT cover this; the two are
    // complementary, not redundant.** Measured: put ParticleEditor's `onReload` back on
    // `setReloadNonce` and that rule stays GREEN, because `reloadEditingAsset(` is still in the file
    // — wired to the REFUSAL banner. It asserts the panel HAS a correct retry; this asserts the park
    // notice's own reload IS one. A panel keeping `retryLoad` for `AssetLoadRefusedBanner` while
    // wiring `ParkAdoptedBanner.onReload` to a nonce passes there and fails here.
    // AtlasAssetView and MaterialBatchView keep local reloads legitimately: neither reads a document
    // out of the editor store, so neither has the branch this is about.
    const STORE_DOC_EARLY_RETURN = /const existing = useEditorStore\.getState\(\)\./;
    const offenders = parkFirstPanels()
      .filter((p) => hasRetry(p.code) && STORE_DOC_EARLY_RETURN.test(p.code))
      .filter((p) => {
        // The banner's reload prop must not be a local nonce bump.
        const m = p.code.match(/<ParkAdoptedBanner[\s\S]*?onReload=\{([^}]*)\}/);
        return !m || /setReloadNonce/.test(m[1]);
      })
      .map((p) => p.rel);

    expect(offenders, [
      'These panels read their document out of the editor store (so their load effect early-returns',
      'on `if (existing)`) and wire Discard & reload to a LOCAL nonce. A nonce re-runs the effect',
      'without nulling the doc, so it hits that early return and never re-reads the file — after the',
      'park was already discarded. Use `retryLoad` (reloadEditingAsset), which nulls the slot.',
      '',
      ...offenders,
    ].join('\n')).toEqual([]);

    // Non-vacuity: the filter must actually select the five store-doc editors, or the rule above
    // is asserting over an empty set.
    const withStoreDoc = parkFirstPanels()
      .filter((p) => hasRetry(p.code) && STORE_DOC_EARLY_RETURN.test(p.code))
      .map((p) => path.basename(p.rel)).sort();
    expect(withStoreDoc).toEqual([
      'AnimationEditor.tsx', 'ParticleEditor.tsx', 'SkinEditor.tsx',
      'SpriteAnimEditor.tsx', 'TimelineEditor.tsx',
    ]);
  });

  it('re-raises the notice on a load that keeps an existing doc while a park is live', () => {
    // ⚠️ The other direction of the same flag, also a review finding. `setParkAdopted(false)` runs
    // unconditionally at the top of each effect, and the `if (existing)` branch returns without
    // re-raising — so a bare REMOUNT (tab away and back), or the rename path that branch's own
    // comment names, cleared a notice whose state was still fully true. The information is already
    // computed in that branch: it calls `pendingAssetDoc` to decide the saved baseline.
    const missing = parkFirstPanels()
      .filter((p) => hasRetry(p.code) && /const existing = useEditorStore\.getState\(\)\./.test(p.code))
      .filter((p) => !/else setParkAdopted\(true\);/.test(p.code))
      .map((p) => p.rel);
    expect(missing, [
      'These panels lower the park notice at the top of the load effect and take the `if (existing)`',
      'branch without re-raising it, so a remount or a rename clears a true statement.',
      '',
      ...missing,
    ].join('\n')).toEqual([]);
  });

  it('offers the EXIT, not only the notice — Discard & reload is the shared component\'s job', () => {
    // The notice alone leaves the human exactly where #902 found them: told to repair the file,
    // holding a panel that will overwrite it, with no way to reach the repair. `discardDirtyAssets`
    // lives in the shared banner precisely so no panel has to re-derive that decision — and so a
    // panel cannot ship the notice while quietly omitting the exit.
    const banner = readScannedSource(
      path.resolve(process.cwd(), 'engine/packages/modoki/src/editor/panels/AssetLoadRefusedBanner.tsx'),
    ).code;
    expect(/discardDirtyAssets\s*\(\s*\[\s*path\s*\]\s*\)/.test(banner)).toBe(true);
    expect(/onReload\s*\(\s*\)/.test(banner)).toBe(true);
  });
});
