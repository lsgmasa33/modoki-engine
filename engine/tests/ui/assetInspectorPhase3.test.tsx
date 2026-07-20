/** Asset Inspector — Phase 3 converter-param exposure (integration).
 *  Covers the UASTC-knob visibility + commit in the pure TextureSettingsControls.
 *  The audio sample-rate/bit-depth controls + both converters' arg/cache behavior
 *  are covered by unit tests (audioConvert/audioCache/textureConvert/textureCache).
 *  See docs/asset-inspector-plan.md Phase 3. */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { TextureSettingsControls } from '../../packages/modoki/src/editor/panels/assetViews/TextureAssetView';
import { deriveSettingsForType, type TextureImportSettings, type TextureType } from '../../packages/modoki/src/runtime/loaders/textureSettings';

afterEach(() => cleanup());

function renderControls(type: TextureType, settings: TextureImportSettings, onChange = vi.fn()) {
  const utils = render(
    <TextureSettingsControls type={type} settings={settings} onChangeType={vi.fn()} onChange={onChange} />,
  );
  return { ...utils, onChange };
}

describe('TextureSettingsControls — UASTC knobs', () => {
  it('shows UASTC Level + RDO λ for a KTX2-UASTC (3d) texture', () => {
    const { queryByText } = renderControls('3d', deriveSettingsForType('3d')); // ktx2-uastc
    expect(queryByText('UASTC Level')).not.toBeNull();
    expect(queryByText('UASTC RDO λ')).not.toBeNull();
  });

  it('hides them for a UI/WebP texture (no UASTC variant emitted)', () => {
    const { queryByText } = renderControls('ui', deriveSettingsForType('ui')); // webp
    expect(queryByText('UASTC Level')).toBeNull();
    expect(queryByText('UASTC RDO λ')).toBeNull();
  });

  it('commits a chosen UASTC level', () => {
    const { getByDisplayValue, onChange } = renderControls('3d', { ...deriveSettingsForType('3d'), uastcLevel: 2 });
    // Level 2 shows "2 (default)"; pick 4.
    const select = getByDisplayValue('2 (default)') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: '4' } });
    expect(onChange).toHaveBeenCalledWith({ uastcLevel: 4 });
  });

  it('clamps the RDO λ on commit', () => {
    const { getByDisplayValue, onChange } = renderControls('3d', { ...deriveSettingsForType('3d'), uastcRdoLambda: 1 });
    const input = getByDisplayValue('1') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '9' } }); // above max 4
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith({ uastcRdoLambda: 4 });
  });
});
