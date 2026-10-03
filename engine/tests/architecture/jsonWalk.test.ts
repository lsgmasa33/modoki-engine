/** #2119: the raw-JSON scripts that look for trait values (`show-refs.mjs`, the font-family
 *  migration) walk every object of a document through `walkObjects`, so a trait bag on a scene v20
 *  entry's member row, on a node in a row's `own`, or in a pre-v20 channel is found wherever it
 *  sits. Before, each named the containers it descended into and read no member row at all. */
import { describe, it, expect } from 'vitest';
import { walkObjects } from '../../scripts/jsonWalk.mjs';
import { migrateFontFamilies } from '../../scripts/fontFamilyMigration.mjs';

const ui = (fontFamily: string) => ({ UIElement: { fontFamily } });

/** One trait bag in every place a scene or prefab document states one. */
const doc = {
  version: 20,
  entities: [
    { guid: 'plain', traits: ui('entity'), children: [{ traits: ui('child') }] },
    {
      prefab: 'p',
      traits: { EntityAttributes: { sortOrder: 0 } },
      members: {
        '/': { traits: ui('rootRow') },
        '/m1': { traits: ui('memberRow'), own: [{ guid: 'n', traits: ui('ownNode'), children: [{ traits: ui('ownChild') }] }] },
      },
      overrides: { '3': ui('legacyOverride') },
      added: [{ traits: ui('legacyAdded') }],
      nestedOverrides: { '2': { '4': ui('legacyNested') } },
    },
  ],
};

function fontsFound(json: unknown): string[] {
  const found: string[] = [];
  walkObjects(json, (obj: Record<string, { fontFamily?: string }>) => {
    if (obj.UIElement?.fontFamily) found.push(obj.UIElement.fontFamily);
  });
  return found.sort();
}

describe('walkObjects (#2119)', () => {
  it('reaches a trait bag in every channel a scene / prefab document states one in', () => {
    expect(fontsFound(doc)).toEqual([
      'child', 'entity', 'legacyAdded', 'legacyNested', 'legacyOverride', 'memberRow', 'ownChild', 'ownNode', 'rootRow',
    ]);
  });

  it('names where it found each one', () => {
    const at: string[] = [];
    walkObjects(doc, (obj: Record<string, unknown>, where: string) => { if ('UIElement' in obj) at.push(where); });
    expect(at).toContain('root.entities[1].members["/m1"].own[0].traits');
    expect(at).toContain('root.entities[1].members["/"].traits');
  });

  // show-refs' own cover is `showRefsCorpus.test.ts` (its member-row refs, printed and resolved).
  it('the font-family migration rewrites a family on a member row and in a row\'s own node, and retypes its resource', () => {
    const json = structuredClone(doc) as typeof doc & { resources?: { type: string; path: string }[] };
    json.resources = [{ type: 'font', path: 'memberRow' }];
    const index = new Map(['memberRow', 'ownNode', 'rootRow'].map((f, i) => [f, `0000000${i}-0000-4000-8000-000000000000`]));
    const out = migrateFontFamilies(json, index);
    expect(out.refs).toBe(3);
    expect(out.dirty).toBe(true);
    const m = json.entities[1].members!;
    expect(m['/'].traits.UIElement.fontFamily).toBe(index.get('rootRow'));
    expect(m['/m1'].traits.UIElement.fontFamily).toBe(index.get('memberRow'));
    expect(m['/m1'].own[0].traits.UIElement.fontFamily).toBe(index.get('ownNode'));
    // A family no font asset has is left alone and reported.
    expect(m['/m1'].own[0].children[0].traits.UIElement.fontFamily).toBe('ownChild');
    expect(out.unmatched).toContain('ownChild');
    expect(json.resources).toEqual([{ type: 'font-family', path: index.get('memberRow') }]);
  });
});
