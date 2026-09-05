/** AssetRefField drop invariant (editor-inspector Tests P1).
 *  The load-bearing rule: an asset drop must write a stable GUID, never a raw asset
 *  path (the runtime hard-rejects path refs). Dropping resolves guid-from-payload →
 *  guid-from-manifest → REFUSE. Fonts are no exception since #231 — a font drop writes the
 *  GUID too, and additionally registers the FontFace so DOM text can use it.
 *  Driven by dispatching the `asset-drop` CustomEvent the dragGhost emits. */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';

// ── module mocks: keep the field free of the editor store / manifest / font IO ──
const selectAsset = vi.fn();
vi.mock('../../src/editor/store/editorStore', () => ({
  useEditorStore: (sel: (s: { selectAsset: typeof selectAsset }) => unknown) => sel({ selectAsset }),
}));

// getGuidForPath resolves only the one known path; everything else is "no guid yet".
const KNOWN_PATH = '/games/x/assets/Cube.mat.json';
const KNOWN_PATH_GUID = 'guid-from-manifest';
vi.mock('../../src/runtime/loaders/assetManifest', () => ({
  isGuid: (v: string) => v.startsWith('guid-'),
  isExternalUrl: (v: string) => /^(https?:|data:|blob:)/i.test(v),
  resolveGuidToPath: (g: string) => (g === KNOWN_PATH_GUID ? KNOWN_PATH : null),
  getGuidForPath: (p: string) => (p === KNOWN_PATH ? KNOWN_PATH_GUID : undefined),
}));

const loadFont = vi.fn((_p: string) => Promise.resolve('My Family'));
vi.mock('../../src/runtime/loaders/fontLoader', () => ({
  loadFont: (p: string) => loadFont(p),
  fontPathFromFamily: () => null,
  fontFamilyFromPath: (p: string) => p.split('/').pop()!.replace(/\.[^.]+$/, ''),
}));

import { AssetRefField, isAcceptableTypedRef } from '../../src/editor/panels/AssetRefField';

/** Dispatch the asset-drop CustomEvent the dragGhost fires onto the field wrapper. */
function drop(el: Element, detail: { path: string; guid?: string }) {
  el.dispatchEvent(new CustomEvent('asset-drop', { detail: JSON.stringify(detail) }));
}

describe('AssetRefField — GUID-only drop invariant', () => {
  beforeEach(() => {
    selectAsset.mockClear();
    loadFont.mockClear();
  });
  afterEach(() => cleanup());

  function renderField(props: Partial<Parameters<typeof AssetRefField>[0]> = {}) {
    const onChange = vi.fn();
    const { container } = render(
      <AssetRefField label="Material" value="" onChange={onChange} dataUiId="test.assetRefField" {...props} />,
    );
    return { onChange, wrapper: container.firstElementChild! };
  }

  it('writes the payload GUID verbatim when one is present', () => {
    const { onChange, wrapper } = renderField();
    drop(wrapper, { path: KNOWN_PATH, guid: 'guid-explicit' });
    expect(onChange).toHaveBeenCalledWith('guid-explicit'); // payload guid wins, not the path
  });

  it('falls back to the manifest GUID for a path with no payload guid', () => {
    const { onChange, wrapper } = renderField();
    drop(wrapper, { path: KNOWN_PATH }); // no guid in payload
    expect(onChange).toHaveBeenCalledWith(KNOWN_PATH_GUID);
  });

  it('REFUSES a drop whose path has no resolvable GUID (never writes a raw path)', () => {
    const { onChange, wrapper } = renderField();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    drop(wrapper, { path: '/games/x/assets/Unregistered.mat.json' });
    expect(onChange).not.toHaveBeenCalled();           // no raw path written
    expect(warn).toHaveBeenCalled();                   // warns + hints to rescan
    warn.mockRestore();
  });

  it('honors the accept filter — a non-matching extension is ignored', () => {
    const { onChange, wrapper } = renderField({ accept: ['.mat.json'] });
    drop(wrapper, { path: '/games/x/assets/foo.mesh.json', guid: 'guid-mesh' });
    expect(onChange).not.toHaveBeenCalled();
  });

  /** #231: EVERY font field stores a GUID now — `UIElement.fontFamily` included. It used to
   *  be the one field a drop resolved to a CSS family NAME instead, which is what made it
   *  invisible to the build's ref walk. Regression for both halves: the ref written is the
   *  GUID, and the face is still registered with the browser (a DOM consumer needs the
   *  FontFace, and nothing else would add it before the next scene load). */
  it('stores the GUID on a font drop — and registers the face', async () => {
    const { onChange, wrapper } = renderField({ accept: ['.ttf'] });
    drop(wrapper, { path: '/games/x/assets/Roboto.ttf', guid: 'guid-font' });
    await Promise.resolve(); await Promise.resolve();
    expect(loadFont).toHaveBeenCalledWith('/games/x/assets/Roboto.ttf');
    expect(onChange).toHaveBeenCalledWith('guid-font');   // never the family name
  });

  it('a font whose FontFace fails to load still writes the ref', async () => {
    // The ref is valid regardless — a failed fetch/decode is a rendering fallback, not a
    // reason to drop an authored assignment (and never an unhandled rejection).
    (loadFont as unknown as { mockRejectedValueOnce: (e: Error) => void })
      .mockRejectedValueOnce(new Error('boom'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { onChange, wrapper } = renderField({ accept: ['.ttf'] });
    drop(wrapper, { path: '/games/x/assets/Roboto.ttf', guid: 'guid-font' });
    await Promise.resolve(); await Promise.resolve();
    expect(onChange).toHaveBeenCalledWith('guid-font');
    warn.mockRestore();
  });

  // ── Typed-input guard: a GUID-only field must REJECT a stray string ──
  // Regression for the "metalnessTexture": "1" bug — typing "1" into an empty
  // texture slot used to commit the literal, which the runtime fetched as `/1`.
  it('does NOT commit a stray typed string into a GUID-only ref field', () => {
    const { onChange } = renderField({ accept: ['.png', '.jpg', '.webp'] });
    const input = document.querySelector('input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '1' } });
    expect(onChange).not.toHaveBeenCalled();   // "1" is not a GUID/URL/keyword → rejected
  });

  it('commits a pasted GUID (and clearing to empty) into a ref field', () => {
    const { onChange } = renderField({ accept: ['.png'] });
    const input = document.querySelector('input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'guid-pasted' } });
    expect(onChange).toHaveBeenCalledWith('guid-pasted');
    fireEvent.change(input, { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith('');  // empty always commits (clear)
  });
});

describe('isAcceptableTypedRef — what manual text entry may commit', () => {
  it('accepts empty, GUIDs, and external URLs for any field', () => {
    expect(isAcceptableTypedRef('')).toBe(true);
    expect(isAcceptableTypedRef('guid-abc')).toBe(true);
    expect(isAcceptableTypedRef('https://cdn.example/x.png')).toBe(true);
    expect(isAcceptableTypedRef('data:image/png;base64,AAAA')).toBe(true);
  });
  it('rejects stray strings (e.g. "1") in a GUID-only field', () => {
    expect(isAcceptableTypedRef('1', ['.png'])).toBe(false);
    expect(isAcceptableTypedRef('foo', ['sprite'])).toBe(false);
  });
  it('rejects a font-family NAME in every font field (#231)', () => {
    // Both UIElement.fontFamily and Text2D/Text3D.font hold a GUID now, so a typed family
    // name is rejected in both — it would resolve to nothing at runtime. A system typeface
    // is authored in `UIElement.systemFont`, a plain string field that never routes here.
    expect(isAcceptableTypedRef('Helvetica Neue', ['.ttf'])).toBe(false);
    expect(isAcceptableTypedRef('Helvetica Neue', ['.png'])).toBe(false);
  });
  it('allows primitive sprite keywords only for sprite/image fields', () => {
    expect(isAcceptableTypedRef('circle', ['sprite'])).toBe(true);
    expect(isAcceptableTypedRef('triangle', ['.png'])).toBe(true);
    expect(isAcceptableTypedRef('circle', ['.mat.json'])).toBe(false);
  });
});
