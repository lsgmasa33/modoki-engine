/** The `alphaField` contract, checked against the real trait registry.
 *
 *  A color field folds a SIBLING 0..1 number field into its A slider and its
 *  `#rrggbbaa` hex (Inspector.tsx: `foldAlpha = af && typeof data[af] === 'number'`),
 *  and hides that sibling as a standalone row (`h.alphaField === key` → null).
 *
 *  Both halves fail SILENTLY. Rename `backgroundOpacity` and:
 *    - the fold's typeof check goes false → the alpha slider and the 8th/7th hex
 *      digits just vanish, no error;
 *    - the hide stops matching → an orphan number row reappears.
 *  Nothing throws, and every ColorField unit test still passes, because the bug lives
 *  in the seam between registerTraits.ts and the Inspector — not inside either.
 *
 *  So: assert the seam. A trait added to registerTraits.ts is covered automatically. */

import { describe, it, expect } from 'vitest';
import { getAllTraits, type TraitMeta } from '@modoki/engine/runtime';
import { registerAllTraits } from '../../app/ecs/registerTraits';

registerAllTraits();

const colorFieldsWithAlpha = (): { trait: string; key: string; alphaField: string; meta: TraitMeta }[] =>
  getAllTraits().flatMap((meta) =>
    Object.entries(meta.fields)
      .filter(([, h]) => h.type === 'color' && h.alphaField)
      .map(([key, h]) => ({ trait: meta.name, key, alphaField: h.alphaField!, meta })),
  );

describe('alphaField wiring (color ↔ sibling opacity)', () => {
  it('the registry actually declares some — otherwise this suite is vacuous', () => {
    const found = colorFieldsWithAlpha();
    expect(found.length).toBeGreaterThan(0);
    // The known set at time of writing; a superset is fine, a shrinking set is a red flag.
    expect(found.map((f) => `${f.trait}.${f.key}`)).toEqual(
      expect.arrayContaining(['UIElement.backgroundColor', 'UIElement.textColor']),
    );
  });

  // The fold gate is `typeof data[af] === 'number'`, and `data` is the live trait value
  // seeded from the koota SCHEMA — not from `meta.fields`. So schema membership is the
  // real contract: Text3D.opacity / Text2D.outlineOpacity are folded despite having no
  // declared FieldHint at all (which also means they never render an orphan row).
  it.each(colorFieldsWithAlpha())('$trait $key → $alphaField is a number on the trait schema', ({ alphaField, meta }) => {
    const schema = (meta.trait as unknown as { schema?: Record<string, unknown> }).schema ?? {};
    expect(Object.keys(schema)).toContain(alphaField);  // the rename regression
    expect(typeof schema[alphaField]).toBe('number');   // a string/bool sibling no-ops the fold
  });

  it.each(colorFieldsWithAlpha())('$trait $key → $alphaField, when it declares a hint, declares a number', ({ alphaField, meta }) => {
    // A declared hint is optional. If present it must agree with the schema, or the
    // standalone row (had it not been hidden) would render the wrong widget.
    const hint = meta.fields[alphaField];
    if (hint) expect(hint.type).toBe('number');
  });

  it.each(colorFieldsWithAlpha())('$trait $key → $alphaField defaults inside 0..1', ({ alphaField, meta }) => {
    // It's an alpha: the A slider is hard-clamped to 0..1, so a default outside that
    // range would be unreachable by the slider and clipped on the first drag.
    const schema = (meta.trait as unknown as { schema?: Record<string, number> }).schema ?? {};
    const d = schema[alphaField];
    expect(d).toBeGreaterThanOrEqual(0);
    expect(d).toBeLessThanOrEqual(1);
  });

  it('no alpha sibling is itself a color, and none is claimed by two colors', () => {
    const found = colorFieldsWithAlpha();
    for (const f of found) expect(f.meta.fields[f.alphaField]?.type).not.toBe('color');
    // Two color fields folding the SAME sibling would make one of them silently
    // overwrite the other's alpha.
    const perTrait = new Map<string, string[]>();
    for (const f of found) perTrait.set(f.trait, [...(perTrait.get(f.trait) ?? []), f.alphaField]);
    for (const [trait, sibs] of perTrait)
      expect(new Set(sibs).size, `${trait} folds a sibling twice`).toBe(sibs.length);
  });

  it('no alpha sibling can render as an orphan standalone row', () => {
    // Two ways a sibling is kept out of the field list, and every one must take one:
    //  - it declares no FieldHint at all (Text3D.opacity) → never rendered; or
    //  - it declares one, and Inspector.tsx:763 suppresses it because a color on the
    //    same trait claims it (UIElement.backgroundOpacity).
    // A declared hint that ISN'T claimed would render a duplicate opacity row next to
    // the slider that already edits it.
    for (const { meta, alphaField } of colorFieldsWithAlpha()) {
      if (!meta.fields[alphaField]) continue;  // undeclared → nothing to hide
      const suppressed = Object.values(meta.fields).some((h) => h.type === 'color' && h.alphaField === alphaField);
      expect(suppressed, `${meta.name}.${alphaField} would render as an orphan row`).toBe(true);
    }
  });

  it('a color field never names ITSELF as its alpha sibling', () => {
    for (const { key, alphaField, trait } of colorFieldsWithAlpha())
      expect(alphaField, `${trait}.${key} folds itself`).not.toBe(key);
  });
});
