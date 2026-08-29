/** QualityTiersEditor's decision logic (docs/rendering.md § "Quality tiers") — the
 *  parts that must be exactly right for a reason bigger than this one panel: `configCount()`
 *  and A2's boot-probe gate read PRESENCE of `mid`/`low`, not any particular value, so a "remove"
 *  that leaves a stray key (or nulls/empties it instead of omitting it) silently re-arms a probe
 *  the owner explicitly wanted gone for a single-config project. */

import { describe, it, expect } from 'vitest';
import {
  normalizeAuthoredTiers, seedTier, addTier, removeTier, withField, withPostFX,
  MATRIX_ROWS, MATRIX_GROUPS, readRenderingPath, writeRenderingPath,
  authoredTiersOf, withAuthoredTiers,
} from '../../packages/modoki/src/editor/panels/qualityTiersModel';
import {
  TIER_SETTINGS, configCount, NO_POSTFX, UNCLAMPED_OVERRIDES, POSTFX_EFFECTS, TIER_DEFAULT_FIELDS,
  type AuthoredTiers, type TierRenderOverrides,
} from '../../packages/modoki/src/runtime/rendering/qualityTier';
import {
  resetRenderSettings, getRenderSettings,
} from '../../packages/modoki/src/runtime/rendering/renderSettings';
import { DEFAULT_PROJECT_CONFIG } from '../../project-config';

describe('normalizeAuthoredTiers', () => {
  it('returns {} for undefined/null/non-object values', () => {
    expect(normalizeAuthoredTiers(undefined)).toEqual({});
    expect(normalizeAuthoredTiers(null)).toEqual({});
    expect(normalizeAuthoredTiers('nonsense')).toEqual({});
    expect(normalizeAuthoredTiers(42)).toEqual({});
  });

  it('passes through mid/low when they are objects, and drops anything else', () => {
    const mid = { pixelRatioCap: 1 };
    const out = normalizeAuthoredTiers({ mid, low: 'not-an-object', extra: true });
    expect(out).toEqual({ mid });
    expect('low' in out).toBe(false);
  });
});

describe('seedTier — "Add low" gives measured behaviour, not blank fields (owner requirement)', () => {
  it('seeds low from TIER_SETTINGS.low', () => {
    expect(seedTier('low')).toEqual(TIER_SETTINGS.low);
  });

  it('seeds mid from TIER_SETTINGS.mid', () => {
    expect(seedTier('mid')).toEqual(TIER_SETTINGS.mid);
  });

  it('is a deep copy — mutating the seed must never mutate the engine table', () => {
    const seeded = seedTier('low');
    seeded.pixelRatioCap = 999;
    (seeded.postFX as Record<string, boolean>).npr = true;
    expect(TIER_SETTINGS.low.pixelRatioCap).not.toBe(999);
    expect(TIER_SETTINGS.low.postFX.npr).toBe(false);
    // Also not the same postFX object reference (NO_POSTFX is shared across tiers/sessions).
    expect(seedTier('low').postFX).not.toBe(NO_POSTFX);
  });
});

describe('addTier', () => {
  it('adds a seeded tier to an undefined AuthoredTiers', () => {
    const out = addTier(undefined, 'low');
    expect(out).toEqual({ low: TIER_SETTINGS.low });
  });

  it('adds alongside an existing tier without disturbing it', () => {
    const existingMid = seedTier('mid');
    const out = addTier({ mid: existingMid }, 'low');
    expect(out.mid).toBe(existingMid);
    expect(out.low).toEqual(TIER_SETTINGS.low);
  });

  it('never mutates the input object', () => {
    const input: AuthoredTiers = { mid: seedTier('mid') };
    const before = { ...input };
    addTier(input, 'low');
    expect(input).toEqual(before);
  });
});

describe('removeTier — THE invariant: omit the key, never null/empty it', () => {
  it('removing the only tier yields an object where the key is fully ABSENT', () => {
    const authored: AuthoredTiers = { low: seedTier('low') };
    const result = removeTier(authored, 'low');
    expect('low' in result).toBe(false);
    // Not present as undefined either — a real omission, not a nulled/blanked field.
    expect(Object.prototype.hasOwnProperty.call(result, 'low')).toBe(false);
    expect(JSON.stringify(result)).not.toContain('low');
  });

  it('removing one of two tiers leaves the other completely untouched', () => {
    const mid = seedTier('mid');
    const low = seedTier('low');
    const result = removeTier({ mid, low }, 'low');
    expect('low' in result).toBe(false);
    expect(result.mid).toBe(mid);
  });

  it('configCount() drops by exactly one when a tier is removed', () => {
    const authored: AuthoredTiers = { mid: seedTier('mid'), low: seedTier('low') };
    expect(configCount(authored)).toBe(3);
    const afterRemovingLow = removeTier(authored, 'low');
    expect(configCount(afterRemovingLow)).toBe(2);
    const afterRemovingBoth = removeTier(afterRemovingLow, 'mid');
    expect(configCount(afterRemovingBoth)).toBe(1);
  });

  it('removing an absent tier is a no-op, not an error, and stays keyless', () => {
    const authored: AuthoredTiers = { mid: seedTier('mid') };
    const result = removeTier(authored, 'low');
    expect(result).toEqual(authored);
    expect('low' in result).toBe(false);
  });

  it('removing from undefined yields {} — never null, never a stray key', () => {
    expect(removeTier(undefined, 'low')).toEqual({});
  });

  it('never mutates the input object', () => {
    const authored: AuthoredTiers = { mid: seedTier('mid'), low: seedTier('low') };
    const before = structuredClone(authored);
    removeTier(authored, 'low');
    expect(authored).toEqual(before);
  });
});

describe('withField', () => {
  it('sets one field and leaves the rest of the config unchanged', () => {
    const cfg = seedTier('low');
    const next = withField(cfg, 'pixelRatioCap', 2);
    expect(next.pixelRatioCap).toBe(2);
    expect(next).not.toBe(cfg);
    expect({ ...next, pixelRatioCap: cfg.pixelRatioCap }).toEqual(cfg);
  });

  it('never mutates the input config', () => {
    const cfg = seedTier('mid');
    const before = structuredClone(cfg);
    withField(cfg, 'shadowMapCeiling', 2048);
    expect(cfg).toEqual(before);
  });
});

describe('withPostFX — toggling one effect', () => {
  it('flips exactly the requested effect and leaves the other four untouched', () => {
    const cfg = seedTier('low'); // NO_POSTFX — every effect starts false
    const next = withPostFX(cfg, 'bloom', true);
    expect(next.postFX.bloom).toBe(true);
    for (const effect of ['npr', 'ao', 'dof', 'vignette'] as const) {
      expect(next.postFX[effect]).toBe(cfg.postFX[effect]);
    }
  });

  it('never mutates the input config or its (possibly shared) postFX object', () => {
    const cfg = seedTier('low');
    const beforePostFX = { ...cfg.postFX };
    withPostFX(cfg, 'npr', true);
    expect(cfg.postFX).toEqual(beforePostFX);
  });

  it('produces a NEW postFX object, not a mutated shared one', () => {
    const cfg = seedTier('low');
    const next = withPostFX(cfg, 'npr', true);
    expect(next.postFX).not.toBe(cfg.postFX);
  });
});

// A tiny sanity check that the fixture tiers really do have all ten TierRenderOverrides fields —
// if the engine adds an eleventh field, seedTier picks it up automatically (it clones the whole
// object) and this test documents that expectation rather than enumerating fields by hand.
describe('seeded tiers carry the full TierRenderOverrides shape', () => {
  const FIELDS: (keyof TierRenderOverrides)[] = [
    'pixelRatioCap', 'antialias', 'shadows', 'shadowMapCeiling', 'postFX',
    'maxDirectional', 'maxLocal', 'ibl', 'iblOffAmbientBoost', 'iblOffExposure',
  ];
  it.each(['mid', 'low'] as const)('%s has every field', (tier) => {
    const seeded = seedTier(tier);
    for (const f of FIELDS) expect(seeded[f]).not.toBeUndefined();
  });
});

// ── The matrix (#403) ──────────────────────────────────────────────────────────────────────

/** The two mechanisms that can honour a `three.*` Default cell. A row pointing at `three.<f>` for
 *  an `<f>` in NEITHER writes a config key nothing reads — the silent-drop failure.
 *
 *  ⚠️ There are TWO sets, not one, and conflating them was a real mistake in this guard's first
 *  draft: it demanded every `three.*` path be a `TIER_DEFAULT_FIELDS` member, which is false by
 *  design for the trio below. Those three reached the tier long before #403 and still do, through
 *  `applyTierToThree`/`getEffectiveThreeSettings` — they are deliberately NOT default-tier fields
 *  (adding them to `TIER_DEFAULT_FIELDS` would apply them twice, once as the base and once as the
 *  clamp). */
const CLAMPED_BY_APPLY_TIER_TO_THREE: readonly string[] = ['pixelRatioCap', 'antialias', 'shadows'];

/** Every `three.*` Default path in `rows` that no mechanism reads. `[]` means the matrix and the
 *  resolver agree. Extracted so the rule can be exercised against a KNOWN-BAD input as well as
 *  against the real table — a rule only ever run on data that satisfies it is untested. */
function unhonouredDefaultPaths(rows: readonly { defaultPath: string | null }[]): string[] {
  const honoured = new Set<string>([...TIER_DEFAULT_FIELDS, ...CLAMPED_BY_APPLY_TIER_TO_THREE]);
  return rows
    .map((r) => r.defaultPath)
    .filter((p): p is string => typeof p === 'string' && p.startsWith('three.'))
    .filter((p) => !honoured.has(p.slice('three.'.length)));
}

describe('the matrix row table', () => {
  it('gives every row that has no project-level default a NOTE saying what governs it instead', () => {
    // A blank cell is indistinguishable from a field that failed to render — the shape of every
    // "authored but unwired" bug this repo keeps finding. Post-FX is the only such group today.
    for (const row of MATRIX_ROWS) {
      if (row.defaultPath === null) expect(row.defaultNote, row.field).toBeTruthy();
    }
  });

  it('gives every row a help string, and none of them names an internal test device', () => {
    // Owner requirement (#403): these strings are read by whoever opens Project Settings, and the
    // fleet's model names mean nothing outside this repo. The MEASUREMENTS stay; the hardware is
    // described by band. The device-by-device provenance lives in TIER_SETTINGS' own comments.
    const banned = /\bY6\b|\bA23\b|iPhone\s?8|Galaxy|Huawei|Adreno|Mali|iPad mini/i;
    for (const row of MATRIX_ROWS) {
      expect(row.help, row.field).toBeTruthy();
      expect(banned.test(row.help), `${row.field}: ${row.help}`).toBe(false);
    }
    for (const group of MATRIX_GROUPS) {
      if (group.note) expect(banned.test(group.note), group.title).toBe(false);
    }
  });

  it('covers every tier-clampable field exactly once — no setting is unreachable in the UI', () => {
    // ⚠️ THE GUARD THAT MATTERS HERE. The matrix is now the ONLY surface for these fields (their
    // standalone Project Settings entries were removed with it), so a field missing from this
    // table is a setting nobody can author — the "partially wired authoring surface" failure, in
    // the direction where the field is silently absent rather than silently inert.
    const rowFields = MATRIX_ROWS.filter((r) => r.kind !== 'postfx').map((r) => r.field);
    const engineFields = Object.keys(UNCLAMPED_OVERRIDES).filter((k) => k !== 'postFX');
    expect([...rowFields].sort()).toEqual([...engineFields].sort());

    const postfxRows = MATRIX_ROWS.filter((r) => r.kind === 'postfx').map((r) => r.field);
    expect([...postfxRows].sort()).toEqual([...POSTFX_EFFECTS].sort());
  });

  it('every default-authorable field is reachable end to end: type -> config -> runtime read -> UI cell', () => {
    // ⚠️ THE CHAIN GUARD (close-out finding). `TIER_DEFAULT_FIELDS` is what the resolver reads;
    // `DEFAULT_PROJECT_CONFIG.rendering.three` is what a project can author; the matrix is where a
    // human sets it. All three are separate declarations, and a field present in one but missing
    // from another fails SILENTLY in the worst direction — an authored value nothing parses, or a
    // dialog cell writing a key the runtime never looks at. This asserts the three agree.
    const declared = [...TIER_DEFAULT_FIELDS].sort();

    // ⚠️ NON-VACUITY FLOOR FIRST. Every assertion below iterates `declared`, so an empty
    // `TIER_DEFAULT_FIELDS` would run zero loop bodies and pass green — the guard switching itself
    // off using the very data it exists to check. An absolute floor is the only thing that cannot
    // be disabled by the break it is watching for (same reasoning as `tierConfigFieldParity`'s).
    expect(declared.length).toBeGreaterThanOrEqual(8);

    // …the config can author each one (else the Default cell writes a key `mergeProjectConfig`
    // drops, and the value silently never reaches the engine).
    for (const f of declared) {
      expect(DEFAULT_PROJECT_CONFIG.rendering.three, f).toHaveProperty(f);
    }

    // …and each one has a matrix row whose Default cell points at it. `three.<field>` is the path
    // shape, so a row that drifted to a different path shows up here rather than in a bug report.
    const byPath = new Map(
      MATRIX_ROWS.filter((r) => r.defaultPath !== null).map((r) => [r.defaultPath, r.field]),
    );
    for (const f of declared) {
      expect(byPath.get(`three.${f}`), `no matrix Default cell writes three.${f}`).toBe(f);
    }

    // ⚠️ AND THE CONVERSE — the direction that actually leaks (close-out review, 2nd pass). The
    // loops above walk `TIER_DEFAULT_FIELDS`, so they only prove "everything the RESOLVER reads is
    // authorable". They say nothing about a field the MATRIX writes that the resolver never reads,
    // and that is the reachable failure: add a ninth field to `TierRenderOverrides`,
    // `UNCLAMPED_OVERRIDES`, `TierOverridesConfig`, `ThreeRenderSettings`, the config defaults and
    // a matrix row — but forget `TIER_DEFAULT_FIELDS` — and EVERY other guard in this repo passes
    // (the row/engine-key comparison sees it on both sides; the path check resolves it on the live
    // settings; the config-parity checks have it everywhere). The Default cell would write
    // `rendering.three.<f>`, `projectTierDefaults` would never read it, and the authored value
    // would be dropped in silence. `TIER_DEFAULT_FIELDS` single-sources the READER (the type and
    // the read derive from it); `MatrixRow.defaultPath` is still a separate hand-written string,
    // and this is the assertion that ties the two together.
    // ⚠️ AND THE CONVERSE — the direction that actually leaks (close-out review, 2nd pass). The
    // loops above walk `TIER_DEFAULT_FIELDS`, so they only prove "everything the RESOLVER reads is
    // authorable". They say nothing about a field the MATRIX writes that nothing reads, and that
    // is the reachable failure: add a ninth field to `TierRenderOverrides`, `UNCLAMPED_OVERRIDES`,
    // `TierOverridesConfig`, `ThreeRenderSettings`, the config defaults and a matrix row — but
    // forget `TIER_DEFAULT_FIELDS` — and every other guard in this repo passes while the Default
    // cell writes a key `projectTierDefaults` never reads.
    expect(unhonouredDefaultPaths(MATRIX_ROWS)).toEqual([]);
  });

  it('the converse rule itself REJECTS a row nothing would read — it is not vacuously empty', () => {
    // ⚠️ The assertion above passes on real data, which on its own is indistinguishable from a rule
    // that can never fail. This is the distinguishing observation: the same helper, handed exactly
    // the defect the review described, must name it. (A source mutation cannot isolate this — every
    // way of introducing the leak in `qualityTiersModel.ts` also trips the coverage or path guard,
    // which is defence in depth but proves nothing about THIS rule.)
    const leaky = [...MATRIX_ROWS, {
      field: 'anisotropy', label: 'Anisotropy', kind: 'number' as const,
      defaultPath: 'three.anisotropy', help: 'synthetic',
    }];
    expect(unhonouredDefaultPaths(leaky)).toEqual(['three.anisotropy']);
  });

  it('does NOT offer a Default cell for textureMaxSize — the build only emits variants a tier names', () => {
    // ⚠️ REGRESSION GUARD, and it caught a real defect in this feature's own close-out. Every
    // OTHER field in this matrix is honoured by the runtime alone, so making it default-authorable
    // is purely a config question. `textureMaxSize` is not: it does not shrink a texture, it
    // SELECTS an already-emitted smaller variant, and `sizesToEmit` (vite-asset-scanner.ts) emits
    // those by reading `tiers.{mid,low}.textureMaxSize` only.
    //
    // THE FAILURE THIS PINS: give this row a `defaultPath` and a project that authors a default
    // cap of 512 with no mid/low tiers gets NO 512 variant built; `resolveTextureVariantUrl`
    // guards the lookup (`settings.sizes?.includes(cap)`) so it is not a 404 — it silently falls
    // back to the full-size texture. The field stores the number, the dialog displays it, and
    // every texture ships and loads at full resolution. An unwired field is a lie with a tooltip.
    const row = MATRIX_ROWS.find((r) => r.field === 'textureMaxSize');
    expect(row).toBeDefined();
    expect(row!.defaultPath).toBeNull();
    expect(row!.defaultNote).toBeTruthy();
    // It must still be authorable PER TIER — the row exists, it is only the Default cell that does
    // not. Dropping the row entirely would fix this test and lose the feature.
    expect(row!.kind).toBe('number');
  });

  it('points every Default path at a real field of the engine`s own render settings', () => {
    // The paths are strings, so nothing but a test can catch a typo — and a mistyped path fails
    // SILENTLY as a cell that reads undefined and writes a key the runtime never looks at.
    resetRenderSettings();
    const rendering: unknown = { ...getRenderSettings() };
    for (const row of MATRIX_ROWS) {
      if (row.defaultPath === null) continue;
      expect(readRenderingPath(rendering, row.defaultPath), row.field).toBeDefined();
    }
  });
});

describe('readRenderingPath / writeRenderingPath', () => {
  it('reads a nested path, and returns undefined rather than throwing on a missing one', () => {
    const r = { targetFps: 30, three: { ibl: false } };
    expect(readRenderingPath(r, 'targetFps')).toBe(30);
    expect(readRenderingPath(r, 'three.ibl')).toBe(false);
    expect(readRenderingPath(r, 'three.nope')).toBeUndefined();
    expect(readRenderingPath(r, 'pixi.antialias')).toBeUndefined();
    expect(readRenderingPath(undefined, 'three.ibl')).toBeUndefined();
  });

  it('writes without mutating — the draft is compared by reference, so an in-place write is invisible', () => {
    const before = { targetFps: 60, three: { ibl: true, exposure: 1.2 } };
    const after = writeRenderingPath(before, 'three.ibl', false);
    expect(before.three.ibl).toBe(true);        // untouched
    expect(after.three).not.toBe(before.three); // new spine all the way down
    expect(readRenderingPath(after, 'three.ibl')).toBe(false);
  });

  it('preserves every sibling it did not touch', () => {
    // The widget is bound to the WHOLE `rendering` block, so a write that dropped a sibling would
    // silently wipe an unrelated setting (`web.sizeMode`, `tierSwitchMessage`) on every save.
    const before = {
      targetFps: 60, tierSwitchMessage: 'hi', web: { sizeMode: 'free' },
      three: { ibl: true, exposure: 1.2 }, pixi: { antialias: true },
    };
    const after = writeRenderingPath(before, 'three.ibl', false);
    expect(after.tierSwitchMessage).toBe('hi');
    expect(after.web).toEqual({ sizeMode: 'free' });
    expect(after.pixi).toEqual({ antialias: true });
    expect((after.three as Record<string, unknown>).exposure).toBe(1.2);
  });

  it('creates a missing intermediate object rather than throwing', () => {
    expect(readRenderingPath(writeRenderingPath({}, 'pixi.antialias', false), 'pixi.antialias')).toBe(false);
  });
});

describe('authoredTiersOf / withAuthoredTiers', () => {
  it('round-trips the tiers through the rendering block', () => {
    const withMid = withAuthoredTiers({ targetFps: 60 }, { mid: TIER_SETTINGS.mid });
    expect(authoredTiersOf(withMid).mid).toEqual(TIER_SETTINGS.mid);
    expect(withMid.targetFps).toBe(60);
  });

  it('writes an EMPTY tiers object rather than dropping the key, so a removal actually saves', () => {
    // `undefined` is treated as ABSENT by deepMergeConfigPatch, i.e. "leave the file alone" — so
    // omitting the key would make removing the last tier silently not happen. See the module header.
    const cleared = withAuthoredTiers({ three: { tiers: { low: TIER_SETTINGS.low } } }, {});
    expect(readRenderingPath(cleared, 'three.tiers')).toEqual({});
    expect(configCount(authoredTiersOf(cleared))).toBe(1);
  });

  it('reads {} out of a block that never had tiers', () => {
    expect(authoredTiersOf({ targetFps: 60 })).toEqual({});
    expect(authoredTiersOf(undefined)).toEqual({});
  });
});
