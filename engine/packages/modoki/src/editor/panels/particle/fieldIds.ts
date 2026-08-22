/** `data-ui-id` namespacing for the Particle Editor's property fields (#287).
 *
 *  Deliberately a CONTEXT rather than a `uiId` prop threaded through ~60 call sites: every
 *  field in that panel already goes through one of the shared widgets (`Num`/`MinMax`/
 *  `Vec3Row`/`Check`/`Enum`/`Color`), so tagging the widgets once tags the whole panel — and a
 *  field added later is tagged by construction instead of by somebody remembering. It is the
 *  same argument CLAUDE.md makes for binding a prefab wholesale rather than enumerating its
 *  fields: a hand-maintained list of "the ones we tagged" goes stale invisibly.
 *
 *  It lives HERE, not inline in `ParticleEditor.tsx`, so it is testable: importing that panel
 *  drags in three.js + a WebGPU renderer + the particle backend at module load, and the repo's
 *  rule is that panel DECISIONS belong in a plain module beside the panel (docs/editor.md
 *  § Panels) rather than being asserted against a jsdom mock. */

import { createContext, useContext } from 'react';

/** The active <Section>'s slug, or '' outside one. */
export const SectionIdContext = createContext<string>('');

/** `Rate / sec` → `rate-sec`, `Size (w,h,d)` → `size-w-h-d`, `Angle°` → `angle`. Lossy on
 *  purpose: an id is an address, not a label, and the punctuation carries no meaning. */
export function particleFieldSlug(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** The id a labelled field resolves to.
 *
 *  The SECTION half is load-bearing, not decoration: `label` alone is not unique. "Mode" and
 *  "Shape" each name a field in BOTH the Collision and Render sections, and those two sections
 *  mount together — so a bare `particle.mode` would be an id resolving to whichever the DOM
 *  happened to order first, which is precisely the by-DOM-index fragility the convention
 *  exists to kill. (Within one section the repeats — Collision's "Center"/"Radius" across its
 *  sphere/box/cylinder branches — are mutually exclusive and never co-mount.)
 *
 *  Outside a Section this returns `undefined`: UNTAGGED beats wrongly-tagged, because a
 *  2-segment id would both break the `<panel>.<region>.<name>` shape the guard asserts and
 *  collide across sections. */
export function useFieldId(label: string): string | undefined {
  const section = useContext(SectionIdContext);
  return section ? `particle.${section}.${particleFieldSlug(label)}` : undefined;
}
