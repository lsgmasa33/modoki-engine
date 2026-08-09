/** The resource-manifest half of `check-scene-churn.mjs` — the re-save review gate.
 *
 *  Tested because this gate has already been silently weak once. It compared only the
 *  manifest's LENGTH (`RESOURCES n -> m`), and a count is the one property a dropped ref can
 *  preserve while still being a drop — so it reported "0 semantic changes" for the
 *  games/space-invader re-save that closed #123, which swapped a legacy page-texture GUID for
 *  the sprite GUID the scene actually references. A gate that goes quiet is worse than no
 *  gate, because the pass it green-lights is the one nobody re-reads. */
import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain .mjs script helper, no type declarations by design
import { diffResources, sceneBodyText } from '../../scripts/lib/resourceDiff.mjs';

type Note = { note: string; regression: boolean };
const notes = (r: Note[]) => r.map((n) => n.note);
const regressions = (r: Note[]) => r.filter((n) => n.regression).length;

const SPRITE = '7b5534ab-5bc6-4082-a813-a291f3a69e54';
const PAGE = '46fcca1d-6a0c-4804-b548-530805ff1bb8';
const ANIM = 'd4b39fb4-043f-4eca-ac0a-9558e3d49dad';

/** A scene whose game trait references `refs` — shaped like the real space-invader case. */
const scene = (resources: Array<{ type: string; path: string }>, ...refs: string[]) => ({
  version: 12,
  resources,
  entities: [{ traits: { SpaceInvaderAssets: Object.fromEntries(refs.map((r, i) => [`ref${i}`, r])) } }],
});

describe('check-scene-churn resource diff', () => {
  it('flags a 1-for-1 swap that keeps the count identical (the #123 blind spot)', () => {
    const after = scene([{ type: 'texture', path: PAGE }], SPRITE);
    const r = diffResources(
      [{ type: 'texture', path: SPRITE }],
      after.resources,
      sceneBodyText(after),
    ) as Note[];
    // Same length before and after — the old count comparison saw nothing at all here.
    expect(regressions(r)).toBe(1);
    expect(notes(r).join('\n')).toMatch(/REGRESSION.*DROPPED texture:7b5534ab.*STILL REFERENCED/);
    expect(notes(r).join('\n')).toMatch(/ADDED texture:46fcca1d/);
  });

  it('does NOT flag a dropped ref the scene no longer references', () => {
    const after = scene([], SPRITE); // ANIM is gone from body AND manifest
    const r = diffResources([{ type: 'spriteanim', path: ANIM }], after.resources, sceneBodyText(after)) as Note[];
    expect(regressions(r)).toBe(0);
    expect(notes(r)[0]).toBe(`RESOURCE DROPPED spriteanim:${ANIM} (no longer referenced — check nothing reaches it indirectly)`);
  });

  it('reports a retype as ONE note, not a drop plus an add', () => {
    const after = scene([{ type: 'material', path: SPRITE }], SPRITE);
    const r = diffResources([{ type: 'texture', path: SPRITE }], after.resources, sceneBodyText(after)) as Note[];
    expect(notes(r)).toEqual([`RESOURCE RETYPED ${SPRITE}  texture -> material`]);
    expect(regressions(r)).toBe(0);
  });

  it('is silent when nothing changed', () => {
    const res = [{ type: 'texture', path: SPRITE }];
    const after = scene(res, SPRITE);
    expect(diffResources(res, after.resources, sceneBodyText(after))).toEqual([]);
  });

  it('treats an added ref as informational, never a regression', () => {
    const after = scene([{ type: 'spriteanim', path: ANIM }], ANIM);
    const r = diffResources([], after.resources, sceneBodyText(after)) as Note[];
    expect(regressions(r)).toBe(0);
    expect(notes(r)).toEqual([`RESOURCE ADDED spriteanim:${ANIM}`]);
  });

  it('does not let the manifest itself count as a reference', () => {
    // sceneBodyText must strip `resources` — otherwise a dropped ref is always "still
    // referenced" (it appears in the very list being compared) and every drop reads as a
    // regression, which would train the operator to ignore the loudest signal the gate has.
    const after = scene([{ type: 'texture', path: PAGE }]); // no entity references PAGE
    expect(sceneBodyText(after)).not.toContain(PAGE);
    const r = diffResources([{ type: 'texture', path: SPRITE }], after.resources, sceneBodyText(after)) as Note[];
    expect(regressions(r)).toBe(0);
  });
});
