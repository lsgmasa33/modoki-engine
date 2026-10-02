/** #1988 — the Clean Up dialog's line about atlas member sources (`packedIntoAtlas`).
 *
 *  The route lists them APART from `orphans` so the dialog can never select or delete them; this is
 *  the decision behind the one line that tells the human why the build drops files the list does not
 *  show. Asserted on the plain function, per `docs/editor.md` § Panels. */
import { describe, it, expect } from 'vitest';
import { readPackedIntoAtlas } from '@modoki/engine/editor';
import { originBadge } from '../../packages/modoki/src/editor/panels/findReferencesFormat';

describe('readPackedIntoAtlas (#1988)', () => {
  it('is null when the route omitted the field, sent none, or no body arrived', () => {
    expect(readPackedIntoAtlas(undefined)).toBeNull();
    expect(readPackedIntoAtlas(null)).toBeNull();
    expect(readPackedIntoAtlas({})).toBeNull();
    expect(readPackedIntoAtlas({ packedIntoAtlas: [] })).toBeNull();
    expect(readPackedIntoAtlas({ packedIntoAtlas: 'nope' as unknown as [] })).toBeNull();
  });

  it('counts the sources, sums their bytes, and names each atlas once', () => {
    expect(readPackedIntoAtlas({
      packedIntoAtlas: [
        { path: '/assets/a.png', bytes: 100, atlases: ['/assets/y.atlas.json'] },
        { path: '/assets/b.png', bytes: 250, atlases: ['/assets/x.atlas.json', '/assets/y.atlas.json'] },
      ],
    })).toEqual({ count: 2, bytes: 350, atlases: ['/assets/x.atlas.json', '/assets/y.atlas.json'] });
  });

  it('skips a null entry instead of throwing, and counts only what it read', () => {
    const body = { packedIntoAtlas: [null, { path: '/assets/a.png', bytes: 5, atlases: ['/assets/x.atlas.json'] }] };
    expect(readPackedIntoAtlas(body as never)).toEqual({ count: 1, bytes: 5, atlases: ['/assets/x.atlas.json'] });
    expect(readPackedIntoAtlas({ packedIntoAtlas: [null] } as never)).toBeNull();
  });
});

// Find References' badge for the graph's atlas → source edge: a human label, not the raw token.
describe('originBadge — atlas-source (#1988)', () => {
  it('labels the edge', () => expect(originBadge('atlas-source')).toBe('packed into atlas'));
});
