/** The four `UIElement` margin tooltips must keep their anchored-element caveat (#757).
 *
 *  WHY A SEPARATE TEST: `inspectorMarginGating.test.tsx` asserts that the gate's tooltip SUPERSEDES
 *  the field's registered hint — but it mounts the Inspector against a MOCK trait registry whose
 *  tooltip strings are hand-copied from `registerTraits.ts`. So it is asserting the mock. Delete the
 *  caveat from the real registration and that suite stays green, because nothing there ever reads
 *  the real one. This closes that hole by reading the actual registry.
 *
 *  Why the caveat is load-bearing rather than decoration: `applyAnchorStyle` clears all four margins
 *  on any anchored element, so the field is inert there. The Inspector greys it out and explains
 *  why, but the greying only fires when a sibling `UIAnchor` is readable — the registered tooltip is
 *  what an author sees everywhere else, including in a prefab being authored before it is placed.
 *
 *  ⚠️ Narrow by design: this pins the CAVEAT's presence, not the exact wording, so a rewrite that
 *  keeps the meaning does not fail. It does NOT try to keep the mock in
 *  `inspectorMarginGating.test.tsx` in sync — that mock only has to be REALISTIC, and this test is
 *  what makes the real string's disappearance loud. */

import { describe, it, expect } from 'vitest';
import { UIElement } from '@modoki/engine/runtime';
import { getTraitMeta } from '@modoki/engine/runtime';
import { registerAllTraits } from '../../app/ecs/registerTraits';

const MARGIN_KEYS = ['marginTop', 'marginRight', 'marginBottom', 'marginLeft'] as const;

describe('UIElement margin tooltips carry the anchored-element caveat (#757)', () => {
  it('every one of the four says margin is flow-layout only and points at the anchor offsets', () => {
    registerAllTraits();
    const fields = getTraitMeta(UIElement)?.fields as Record<string, { tooltip?: string }> | undefined;
    expect(fields).toBeDefined();
    for (const key of MARGIN_KEYS) {
      const tip = fields?.[key]?.tooltip ?? '';
      expect(tip, `${key} has no tooltip at all`).not.toBe('');
      // The caveat, by meaning rather than by exact wording.
      expect(tip.toLowerCase(), `${key} tooltip does not mention flow layout: ${tip}`).toContain('flow layout');
      expect(tip.toLowerCase(), `${key} tooltip does not mention anchored: ${tip}`).toContain('anchor');
    }
  });

  it('the four unit companions exist, so the caveat is not attached to a field with no partner', () => {
    registerAllTraits();
    const fields = getTraitMeta(UIElement)?.fields as Record<string, unknown> | undefined;
    for (const key of MARGIN_KEYS) expect(fields?.[`${key}Unit`], `${key}Unit missing`).toBeDefined();
  });
});
