/** Asset Inspector — Phase 1 quick wins (integration).
 *  Covers the WebP-quality control's visibility logic in the pure, prop-driven
 *  TextureSettingsControls. The font fieldType/atlasMax + spriteanim-button changes
 *  are covered by their own unit tests + live-verify (their host views are
 *  backend-coupled). See docs/asset-inspector-plan.md Phase 1. */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { TextureSettingsControls } from '../../packages/modoki/src/editor/panels/assetViews/TextureAssetView';
import { deriveSettingsForType, type TextureImportSettings, type TextureType } from '../../packages/modoki/src/runtime/loaders/textureSettings';

afterEach(() => cleanup());

function renderControls(type: TextureType, settings: TextureImportSettings, onChange = vi.fn()) {
  const utils = render(
    <TextureSettingsControls
      type={type}
      settings={settings}
      onChangeType={vi.fn()}
      onChange={onChange}
    />,
  );
  return { ...utils, onChange };
}

describe('TextureSettingsControls — WebP Quality visibility', () => {
  it('shows the WebP Quality control when a WebP file is emitted (ui/webp format)', () => {
    const { queryByText } = renderControls('ui', deriveSettingsForType('ui')); // webp format
    expect(queryByText('WebP Quality')).not.toBeNull();
  });

  it('shows it for a 2d KTX2 texture (a WebP browser sibling is emitted)', () => {
    const { queryByText } = renderControls('2d', deriveSettingsForType('2d')); // ktx2-uastc + webp sibling
    expect(queryByText('WebP Quality')).not.toBeNull();
  });

  it('hides it for a 3d KTX2 texture (no WebP variant emitted)', () => {
    const { queryByText } = renderControls('3d', deriveSettingsForType('3d')); // ktx2-uastc, no sibling
    expect(queryByText('WebP Quality')).toBeNull();
  });

  it('commits a clamped, rounded quality via onChange', () => {
    const { getByDisplayValue, onChange } = renderControls('ui', { ...deriveSettingsForType('ui'), webpQuality: 80 });
    const input = getByDisplayValue('80') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '150' } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith({ webpQuality: 100 });
  });
});
