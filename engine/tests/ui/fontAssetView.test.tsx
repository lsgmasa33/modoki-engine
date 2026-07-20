/** FontAssetView — Phase 1 UI logic (integration).
 *  - `fieldType` is now an editable msdf/mtsdf select (was static "MTSDF" text).
 *  - `atlasMax` (runtime dynamic-page size) is hidden for a baked font (it has no
 *    baked effect — msdf-atlas-gen auto-sizes) and shown only in dynamic mode.
 *  Backend + store are mocked so the view mounts headless. See
 *  docs/asset-inspector-plan.md Phase 1. */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../../packages/modoki/src/editor/backend/editorBackend', () => ({
  backendFetch: vi.fn(async () => ({ ok: true, json: async () => ({}) })),
}));
vi.mock('../../packages/modoki/src/editor/store/editorStore', () => ({
  useEditorStore: (sel: (s: unknown) => unknown) => sel({ refreshAssets: () => {}, setImportStatus: () => {} }),
}));

import { FontAssetView } from '../../packages/modoki/src/editor/panels/assetViews/FontAssetView';

afterEach(() => cleanup());

describe('FontAssetView — field type + atlasMax honesty', () => {
  it('renders an editable msdf/mtsdf field-type select', async () => {
    const { findByDisplayValue, getByText } = render(<FontAssetView path="/x/f.ttf" name="f.ttf" />);
    // Default settings resolve to mtsdf; the select shows it (was static text before).
    const select = (await findByDisplayValue(/MTSDF/)) as HTMLSelectElement;
    expect(select.tagName).toBe('SELECT');
    expect(getByText(/MSDF \(3-channel/)).not.toBeNull();
  });

  it('hides the runtime page-size control for a baked font, shows it in dynamic mode', async () => {
    const { queryByText, getByDisplayValue } = render(<FontAssetView path="/x/f.ttf" name="f.ttf" />);
    // Baked is the default → the runtime-page control is not shown.
    await waitFor(() => expect(queryByText('Runtime page size (px)')).toBeNull());
    // Switch the Glyph source (mode) select to dynamic.
    const modeSelect = getByDisplayValue('baked') as HTMLSelectElement;
    fireEvent.change(modeSelect, { target: { value: 'dynamic' } });
    await waitFor(() => expect(queryByText('Runtime page size (px)')).not.toBeNull());
  });
});
