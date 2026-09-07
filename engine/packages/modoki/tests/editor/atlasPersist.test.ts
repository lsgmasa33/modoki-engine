/** atlasPersist's LOAD-STATE and document-BUILDING decision logic (#430, #784) — the half of
 *  `AtlasAssetView` that is plain logic, extracted so it is covered without mounting the panel
 *  (CLAUDE.md § Panels: editor `.tsx` is not expected to carry tests).
 *
 *  ⚠️ **Three suites were DELETED here, not lost (#831).** `persistAtlasDoc`,
 *  `persistAtlasDocIfUnchanged` and `createAtlasWriteQueue` no longer exist: the panel parks its
 *  edit in the dirty-asset registry and `flushDirtyAssets` writes it at Cmd+S. Where each
 *  guarantee is asserted now:
 *
 *   - the WRITE FAILURE report (`persistAtlasDoc`) → `flushDirtyAssets` leaves the entry parked
 *     and records the reason; `engine/tests/editor/dirtyAssetFlushReporting.test.ts`.
 *   - the COMPARE-AND-SWAP (`persistAtlasDocIfUnchanged`) → parked as `DirtyAsset.ifMatch` and
 *     applied by `/api/asset-write`; `engine/tests/plugins/assetWriteIfMatch.test.ts`.
 *   - the WRITE QUEUE (`createAtlasWriteQueue`) → structurally absent. Parking is synchronous and
 *     last-write-wins in a `Map`, so there are no concurrent writes to serialize. Deleting a guard
 *     because "it cannot happen now" is the shape that comes back, so the claim is asserted
 *     rather than asserted-in-prose: see `engine/tests/editor/atlasParksNotWrites.test.ts`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  classifyAtlasLoad, canPersistAtlasDoc, buildNextAtlasDoc, DEFAULT_ATLAS_DOC, normalizeAtlasBody,
} from '../../src/editor/panels/assetViews/atlasPersist';
import { ATLAS_FORMAT_VERSION } from '../../src/runtime/loaders/spriteAtlas';

let consoleSpies: Array<{ mockRestore: () => void }> = [];
const spyConsole = (level: 'error' | 'warn') => {
  const s = vi.spyOn(console, level).mockImplementation(() => {});
  consoleSpies.push(s);
  return s;
};

afterEach(() => { for (const s of consoleSpies) s.mockRestore(); consoleSpies = []; });

describe('classifyAtlasLoad', () => {
  it('a non-ok HTTP response classifies as failed, with no doc to apply', () => {
    const result = classifyAtlasLoad({ kind: 'httpError' });
    expect(result).toEqual({ loadState: 'failed' });
  });

  it('a network throw classifies as failed', () => {
    const result = classifyAtlasLoad({ kind: 'networkError' });
    expect(result).toEqual({ loadState: 'failed' });
  });

  it('an abort classifies as null — not failed, caller does nothing', () => {
    const result = classifyAtlasLoad({ kind: 'aborted' });
    expect(result).toBeNull();
  });

  it('a well-formed body classifies as ok, normalized doc attached', () => {
    const body = { id: 'g1', version: 1, members: ['a', 'b'], pageSize: 512, padding: 1, extrude: 2 };
    const result = classifyAtlasLoad({ kind: 'ok', body });
    expect(result).toEqual({ loadState: 'ok', doc: body, raw: body });
  });

  it('a malformed body (missing/wrong-typed fields) still classifies as ok, normalized to defaults', () => {
    const body = { members: 'not-an-array', pageSize: 'big' };
    const result = classifyAtlasLoad({ kind: 'ok', body });
    expect(result).toEqual({
      loadState: 'ok',
      doc: {
        id: undefined, version: undefined,
        members: [],
        pageSize: DEFAULT_ATLAS_DOC.pageSize,
        padding: DEFAULT_ATLAS_DOC.padding,
        extrude: DEFAULT_ATLAS_DOC.extrude,
      },
      raw: body,
    });
  });

  it('an empty body (parsed `{}`) still classifies as ok — a loaded-empty atlas is editable, not failed', () => {
    const result = classifyAtlasLoad({ kind: 'ok', body: {} });
    expect(result?.loadState).toBe('ok');
  });

  // Review finding 4: a body that parses but isn't a plain object must not classify as 'ok' —
  // `{...raw}` / the `Partial<AtlasSourceDoc>` cast both assume an object, so `null`/an array/a
  // string/a number would otherwise be absorbed into a "valid" doc with no `id` (the #430 loss,
  // reached through a different response shape) or, for a string, spread character-by-character
  // into the written file.
  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'anything'],
    ['a number', 42],
  ])('a non-object JSON body (%s) classifies as failed', (_label, body) => {
    const result = classifyAtlasLoad({ kind: 'ok', body });
    expect(result).toEqual({ loadState: 'failed' });
  });

  it('an object body with wrong-typed fields is still ok — the empty-atlas distinction is the whole fix', () => {
    const result = classifyAtlasLoad({ kind: 'ok', body: { members: 'not-an-array', pageSize: 'big' } });
    expect(result?.loadState).toBe('ok');
  });
});

// Format-version REFUSAL (#784, docs/format-versioning.md § 2b-bis). `.atlas.json` is REFUSE
// disposition: a too-new/unreadable document parses fine but must not become an editable `doc`
// — a distinct outcome from `failed` (network/HTTP), because the banner text and the fix are
// different ("update this build" vs. "retry the load").
describe('classifyAtlasLoad — format-version refusal', () => {
  it('a too-new version classifies as refused, not ok — and not the generic "failed"', () => {
    const body = { id: 'g1', version: 99, members: [], pageSize: 512, padding: 1, extrude: 2 };
    const result = classifyAtlasLoad({ kind: 'ok', body });
    expect(result?.loadState).toBe('refused');
    expect((result as { message: string }).message).toContain('99');
  });

  it('an unreadable (non-numeric) version classifies as refused', () => {
    const body = { id: 'g1', version: 'two', members: [] };
    const result = classifyAtlasLoad({ kind: 'ok', body });
    expect(result?.loadState).toBe('refused');
  });

  it('an ok (at or below this build) version still classifies as ok, unaffected', () => {
    const body = { id: 'g1', version: 1, members: [] };
    const result = classifyAtlasLoad({ kind: 'ok', body });
    expect(result?.loadState).toBe('ok');
  });

  it('an absent version still classifies as ok — legacy/fresh documents are readable', () => {
    const body = { id: 'g1', members: [] };
    const result = classifyAtlasLoad({ kind: 'ok', body });
    expect(result?.loadState).toBe('ok');
  });
});

// Direct regression test for 2b (#784): `AtlasAssetView.update()` used to build
// `{ ...prev, ...patch, version: 1 as const }` — the trailing literal clobbered whatever
// version the document actually carried, on EVERY edit. `buildNextAtlasDoc` is the extracted
// replacement `update()` now calls.
describe('buildNextAtlasDoc', () => {
  const base = { id: 'g1', version: 2, members: ['a'], pageSize: 512, padding: 1, extrude: 2 };

  it('never overrides the document\'s own version with a literal', () => {
    const out = buildNextAtlasDoc(base, { padding: 5 });
    expect(out.version).toBe(2); // NOT re-stamped to 1
    expect(out.padding).toBe(5); // the edit itself still applies
  });

  it('applies the patch over the previous doc otherwise unchanged', () => {
    const out = buildNextAtlasDoc(base, { members: ['a', 'b'] });
    expect(out).toEqual({ ...base, members: ['a', 'b'] });
  });

  it('a patch that explicitly sets version is still honored (this is not a version-immutability guard)', () => {
    const out = buildNextAtlasDoc(base, { version: 5 });
    expect(out.version).toBe(5);
  });

  // #784 phase C adversarial review, finding 3: dropping the clobbering literal ALSO dropped the
  // stamp for a document that had no version to begin with — `normalizeAtlasBody` sets
  // `version: undefined` for a versionless file, and `buildAtlasDocToPark` strips `undefined`
  // keys, so a versionless atlas stayed versionless through every edit instead of getting
  // stamped on the first one, same as it did before #784 phase C2a's fix.
  it('a versionless doc gains ATLAS_FORMAT_VERSION on its first edit', () => {
    const versionless = { id: 'g2', members: ['a'], pageSize: 512, padding: 1, extrude: 2 };
    const out = buildNextAtlasDoc(versionless, { padding: 5 });
    expect(out.version).toBe(ATLAS_FORMAT_VERSION);
    expect(out.padding).toBe(5);
  });

  it('a doc already carrying its OWN version keeps that value unchanged (not re-stamped)', () => {
    const out = buildNextAtlasDoc(base, { padding: 9 });
    expect(out.version).toBe(base.version); // 2, not ATLAS_FORMAT_VERSION
  });
});

describe('canPersistAtlasDoc', () => {
  it('refuses while loading, even with a matching path', () => {
    expect(canPersistAtlasDoc('loading', '/a.atlas.json', '/a.atlas.json')).toBe(false);
  });

  it('refuses when the load failed, even with a matching path', () => {
    expect(canPersistAtlasDoc('failed', '/a.atlas.json', '/a.atlas.json')).toBe(false);
  });

  it('allows once loaded ok with a matching path', () => {
    expect(canPersistAtlasDoc('ok', '/a.atlas.json', '/a.atlas.json')).toBe(true);
  });

  // The finding that matters most: `loadState === 'ok'` is not enough on its own. A selection
  // change from atlas A to atlas B can repaint the panel with `loadState === 'ok'` still set from
  // A's load, A's `doc`/`rawDoc`, and `path` already updated to B — the window between the `path`
  // prop changing and B's load effect landing. A write in that window would serialize A's content
  // onto B's file, the exact loss #430 fixed, reached a different way.
  it('refuses when loadedPath !== path even with loadState === "ok" — the A-to-B selection window', () => {
    expect(canPersistAtlasDoc('ok', '/a.atlas.json', '/b.atlas.json')).toBe(false);
  });

  it('refuses when loadedPath is null (no load has landed yet) regardless of loadState', () => {
    expect(canPersistAtlasDoc('ok', null, '/a.atlas.json')).toBe(false);
  });

  it('refuses a "refused" (format-version) load state, even with a matching path', () => {
    expect(canPersistAtlasDoc('refused', '/a.atlas.json', '/a.atlas.json')).toBe(false);
  });
});
