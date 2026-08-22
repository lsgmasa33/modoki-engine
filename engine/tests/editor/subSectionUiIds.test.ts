/** `inspector.subsection.<title>` cannot collide between co-mounted SubSections (#287).
 *
 *  WHY THIS FILE EXISTS: a close-out review caught the comment in `widgets.tsx` citing a test
 *  by this name that had never been written. That is the exact failure this repo has a memory
 *  note about — a claim that reads verified and is not — so the honest fix was to make the
 *  citation true rather than delete it, especially because the reviewer also showed the
 *  safety is currently ACCIDENTAL: `SubSection`'s id is keyed on the title ALONE, with no
 *  owning-trait segment. Nothing stopped two traits from picking the same section name.
 *
 *  The id is `inspector.subsection.${slug(title)}`, and the Inspector renders one SubSection
 *  per `hint.section` within a trait card. Several trait cards mount together on one entity,
 *  so two DIFFERENT traits declaring the same section title would put two elements with the
 *  same id on screen at once — and `modoki_tap {selector}` would silently drive whichever the
 *  DOM ordered first. Within one trait a repeated title is the same section by construction
 *  (the Inspector groups by name), so that case is not a collision. */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../..');

/** Mirrors `subSectionSlug` in panels/assetViews/widgets.tsx. */
const slug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** Section titles declared in trait editor metadata, grouped by the file that declares them. */
function declaredSectionTitles(): Map<string, Set<string>> {
  const files = [
    'engine/app/ecs/registerTraits.ts',
    'engine/app/editor/setup.ts',
  ].filter((f) => fs.existsSync(path.join(ROOT, f)));
  const out = new Map<string, Set<string>>();
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const [, title] of src.matchAll(/section: '([^']+)'/g)) {
      out.set(f, (out.get(f) ?? new Set()).add(title));
    }
  }
  return out;
}

/** Literal <SubSection title="..."> titles rendered outside the Inspector (asset views). */
function literalSubSectionTitles(): string[] {
  const dir = path.join(ROOT, 'engine/packages/modoki/src/editor');
  const found: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.tsx')) {
        for (const [, t] of fs.readFileSync(p, 'utf8').matchAll(/<SubSection title="([^"]+)"/g)) found.push(t);
      }
    }
  };
  walk(dir);
  return found;
}

describe('SubSection ui ids', () => {
  it('finds the declarations at all (a scan matching nothing would pass vacuously)', () => {
    // Without this, renaming `section:` or the JSX prop turns every assertion below into a
    // statement about the empty set — green, and measuring nothing.
    const declared = [...declaredSectionTitles().values()].flatMap((s) => [...s]);
    expect(declared.length).toBeGreaterThan(10);
    expect(literalSubSectionTitles().length).toBeGreaterThan(0);
  });

  it('slugs distinct section titles to distinct ids', () => {
    // The slug is lossy (punctuation collapses), so two titles that LOOK different can land on
    // one id — "Edge Thresholds" and "Edge-Thresholds" both slug to `edge-thresholds`.
    const titles = [...new Set([...declaredSectionTitles().values()].flatMap((s) => [...s]))];
    const bySlug = new Map<string, string[]>();
    for (const t of titles) bySlug.set(slug(t), [...(bySlug.get(slug(t)) ?? []), t]);
    const collisions = [...bySlug].filter(([, ts]) => ts.length > 1);
    expect(collisions, `these titles slug to one id: ${JSON.stringify(collisions)}`).toEqual([]);
  });

  it('no asset-view SubSection title collides with a trait section title', () => {
    // TextureAssetView's "Advanced" is the live example. The Inspector shows either an entity
    // or an asset, so this is defence in depth rather than a live collision today — but the id
    // carries no owner segment, so nothing else would catch it if that ever changed.
    const traitTitles = new Set([...declaredSectionTitles().values()].flatMap((s) => [...s]).map(slug));
    const clashes = [...new Set(literalSubSectionTitles())].filter((t) => traitTitles.has(slug(t)));
    expect(clashes, `asset-view SubSection title(s) also used as a trait section: ${clashes}`).toEqual([]);
  });

  it('the slug helper matches the implementation it mirrors', () => {
    // If widgets.tsx changes its slugging, this file's copy must move with it or every
    // assertion above silently tests the wrong function.
    const src = fs.readFileSync(path.join(ROOT, 'engine/packages/modoki/src/editor/panels/assetViews/widgets.tsx'), 'utf8');
    expect(src).toContain("return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');");
  });
});
