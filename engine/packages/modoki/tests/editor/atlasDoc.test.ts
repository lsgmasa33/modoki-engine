/** `.atlas.json` round-trip — AtlasAssetView must not delete what it does not model.
 *
 *  One "+ Add member" click used to strip the file's top-level `texture` block (format /
 *  maxSize / mipmaps / wrap / colorspace — it decides how the packed page is actually
 *  encoded) because the view normalized the file into a typed struct and wrote the struct
 *  back. members[] stayed byte-identical, so the loss was invisible in the panel. */

import { describe, it, expect } from 'vitest';
import { parseAtlasDoc, serializeAtlasDoc } from '../../src/editor/panels/assetViews/atlasDoc';

const RAW = {
  id: '6745abbf-d4a3-40f4-a74d-a0ea526cef8e',
  version: 1,
  members: ['a-guid', 'b-guid'],
  pageSize: 2048,
  padding: 2,
  extrude: 1,
  texture: { format: 'ktx2-uastc', maxSize: 2048, mipmaps: false, wrapS: 'clamp', wrapT: 'clamp', colorspace: 'srgb' },
};

describe('atlas doc round-trip', () => {
  it('keeps the texture block through a member edit', () => {
    const doc = parseAtlasDoc(RAW);
    const out = JSON.parse(serializeAtlasDoc(RAW, { ...doc, members: [...doc.members, ''] }));
    expect(out.texture).toEqual(RAW.texture);
    expect(out.members).toEqual(['a-guid', 'b-guid', '']);
  });

  it('an add-then-remove round-trip reproduces the file exactly', () => {
    const doc = parseAtlasDoc(RAW);
    const added = { ...doc, members: [...doc.members, ''] };
    const removed = { ...added, members: added.members.filter((_, i) => i !== 2) };
    expect(serializeAtlasDoc(RAW, removed)).toBe(JSON.stringify(RAW, null, 2) + '\n');
  });

  it('carries through ANY unmodelled key, not just texture (forward compat)', () => {
    const raw = { ...RAW, someFutureField: { a: 1 } };
    const out = JSON.parse(serializeAtlasDoc(raw, parseAtlasDoc(raw)));
    expect(out.someFutureField).toEqual({ a: 1 });
  });

  it('preserves key ORDER, so an edit is a one-line diff', () => {
    const out = serializeAtlasDoc(RAW, parseAtlasDoc(RAW));
    expect(Object.keys(JSON.parse(out))).toEqual(Object.keys(RAW));
  });

  it('ends with a newline', () => {
    expect(serializeAtlasDoc(RAW, parseAtlasDoc(RAW)).endsWith('}\n')).toBe(true);
  });

  it('clearing maxPages drops the key rather than resurrecting the old value', () => {
    const raw = { ...RAW, maxPages: 4 };
    const doc = parseAtlasDoc(raw);
    expect(doc.maxPages).toBe(4);
    const out = JSON.parse(serializeAtlasDoc(raw, { ...doc, maxPages: undefined }));
    expect('maxPages' in out).toBe(false);
  });

  it('stamps version 1 on write', () => {
    const out = JSON.parse(serializeAtlasDoc({ ...RAW, version: 0 }, parseAtlasDoc(RAW)));
    expect(out.version).toBe(1);
  });
});
