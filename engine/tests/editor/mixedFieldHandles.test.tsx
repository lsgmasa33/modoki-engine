// @vitest-environment jsdom
/** Integration: the REAL mixed-value field components read back as `meta.mixed` (#1152 close-out).
 *
 *  The unit tests in chromeHandles.test.ts hand-write the DOM a mixed field renders, so they cannot
 *  see a component that renders mixed some OTHER way — which is exactly how the first fix shipped:
 *  it stamped a marker in `fields.tsx`, and review found the Inspector's `NumberField` (a separate
 *  component) never went through it. This renders the components themselves and reads them through
 *  the real provider, so a producer that stops rendering MIXED_PLACEHOLDER fails here.
 *
 *  jsdom has no layout; the provider skips zero-size elements, so rects are stubbed. */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { BufferedTextInput, BufferedNumberInput } from '@modoki/engine/editor';
import { NumberField, DropdownField, ColorField, MixedSelect, MixedCheckbox } from '../../packages/modoki/src/editor/panels/assetViews/widgets';
import { EntityRefField, FieldValueWidget } from '../../packages/modoki/src/editor/panels/inspectorFields';
import { AnchorPickerField } from '../../packages/modoki/src/editor/panels/Inspector';
import { TriCheckbox } from '../../packages/modoki/src/editor/panels/ApplyPrefabDialog';
import { TextureSettingsControls } from '../../packages/modoki/src/editor/panels/assetViews/TextureAssetView';
import { deriveSettingsForType } from '../../packages/modoki/src/runtime/loaders/textureSettings';
import { chromeHandles } from '../../app/debug/chromeHandles';

const realRect = Element.prototype.getBoundingClientRect;
beforeAll(() => {
  Element.prototype.getBoundingClientRect = function () {
    return { left: 10, top: 10, width: 50, height: 16, right: 60, bottom: 26, x: 10, y: 10, toJSON: () => ({}) } as DOMRect;
  };
});
afterAll(() => { Element.prototype.getBoundingClientRect = realRect; });
afterEach(() => { cleanup(); });

const meta = (id: string) => chromeHandles().find((h) => h.id === id)?.meta;
/** A handle whose meta is empty omits `meta` entirely, so "no mixed" must also prove the handle EXISTS. */
const exists = (id: string) => chromeHandles().some((h) => h.id === id);
const noop = () => {};

describe('mixed field components → meta.mixed', () => {
  it('BufferedNumberInput and BufferedTextInput (fields.tsx)', () => {
    render(<>
      <BufferedNumberInput value={3} onChange={noop} mixed dataUiId="inspector.field.Transform.x" />
      <BufferedTextInput value="a" onChange={noop} mixed dataUiId="inspector.field.Name.value" />
      <BufferedNumberInput value={3} onChange={noop} dataUiId="inspector.field.Transform.z" />
    </>);
    expect(meta('inspector.field.Transform.x')).toEqual({ mixed: true, value: '' });
    expect(meta('inspector.field.Name.value')).toEqual({ mixed: true, value: '' });
    expect(meta('inspector.field.Transform.z')).toEqual({ value: '3' });
  });

  it('NumberField (widgets.tsx) — its number box AND its slider, which parks at min when mixed', () => {
    render(<NumberField label="intensity" value={4} onChange={noop} mixed hint={{ type: 'number', min: 0, max: 10 }} dataUiId="inspector.field.Light.intensity" />);
    expect(meta('inspector.field.Light.intensity')).toMatchObject({ mixed: true, value: '' });
    expect(meta('inspector.field.Light.intensity.slider')).toMatchObject({ mixed: true });
  });

  it('a READ-ONLY mixed NumberField shows the placeholder, not the first entity\'s value (close-out)', () => {
    // Inspector passes readOnly for an anchor-disabled or hint.readOnly field alongside mixed.
    render(<NumberField label="x" value={12} onChange={noop} mixed readOnly dataUiId="inspector.field.UITransform.x" />);
    expect(meta('inspector.field.UITransform.x')).toEqual({ mixed: true, value: '' });
  });

  it('an unmixed NumberField reads its value, not mixed', () => {
    render(<NumberField label="intensity" value={4} onChange={noop} hint={{ type: 'number', min: 0, max: 10 }} dataUiId="inspector.field.Light.intensity" />);
    expect(meta('inspector.field.Light.intensity')!.mixed).toBeUndefined();
    expect(meta('inspector.field.Light.intensity.slider')!.mixed).toBeUndefined();
  });

  it('a mixed number field holding HALF-TYPED input is STILL mixed — nothing was committed (#1170 close-out)', () => {
    // Chromium reports `value === ''` + `validity.badInput` for a `type="number"` box holding `-`
    // or `1e`. The selection is still mixed (a mixed field commits nothing until a value parses), so
    // reporting `{value:''}` without `mixed` would claim a definite empty value. jsdom has no such
    // parser, so the validity is stubbed; a reader that keys on badInput goes red here.
    const onChange = vi.fn();
    render(<NumberField label="x" value={1} onChange={onChange} mixed dataUiId="inspector.field.T.x" />);
    const input = document.querySelector('[data-ui-id="inspector.field.T.x"]')!;
    Object.defineProperty(input, 'validity', { configurable: true, value: { badInput: true } });
    expect(meta('inspector.field.T.x')).toEqual({ mixed: true, value: '' });
    expect(onChange).not.toHaveBeenCalled();
  });
});

// ── #1170: the controls that rendered mixed some other way, or carried no handle at all ──

describe('#1170 — selects and checkboxes through the shared mixed shapes', () => {
  it('DropdownField (every Inspector enum, Wrap S/T) has a handle and reads mixed', () => {
    render(<>
      <DropdownField label="mode" value="a" options={['a', 'b']} onChange={noop} mixed dataUiId="inspector.field.T.mode" />
      <DropdownField label="wrap" value="b" options={['a', 'b']} onChange={noop} dataUiId="assetView.texture.wrapS" />
    </>);
    expect(meta('inspector.field.T.mode')).toEqual({ mixed: true, value: '' });
    expect(meta('assetView.texture.wrapS')).toEqual({ value: 'b' });
  });

  it('MixedSelect with labelled options (the Inspector unit select, MiniSelect, ModelBatchView postprocessor)', () => {
    // The unit select used to render its mixed row as `--`, which the reader never matched.
    const onChange = vi.fn();
    render(<MixedSelect value="px" options={[{ value: 'px', label: 'Pixels' }, { value: '%', label: 'Percent' }]} onChange={onChange} mixed
      dataUiId="inspector.field.UITransform.widthUnit" />);
    expect(meta('inspector.field.UITransform.widthUnit')).toEqual({ mixed: true, value: '' });
    fireEvent.change(document.querySelector('[data-ui-id="inspector.field.UITransform.widthUnit"]')!, { target: { value: '%' } });
    expect(onChange).toHaveBeenCalledWith('%');
  });

  it('MixedCheckbox (MaterialBatchView transparent, texture toggles) and TriCheckbox (ApplyPrefabDialog rows)', () => {
    render(<>
      <MixedCheckbox checked mixed onChange={noop} dataUiId="assetView.materialBatch.transparent" />
      <MixedCheckbox checked onChange={noop} dataUiId="assetView.texture.flipY" />
      <TriCheckbox state="mixed" onChange={noop} dataUiId="prefab.dialog.entity.3" />
      <TriCheckbox state="on" onChange={noop} dataUiId="prefab.dialog.item.k" />
    </>);
    expect(meta('assetView.materialBatch.transparent')).toEqual({ mixed: true, state: 'mixed' });
    expect(meta('assetView.texture.flipY')).toEqual({ checked: true, state: 'checked' });
    expect(meta('prefab.dialog.entity.3')).toEqual({ mixed: true, state: 'mixed' });
    expect(meta('prefab.dialog.item.k')).toEqual({ checked: true, state: 'checked' });
  });
});

describe('#1170 — composite fields', () => {
  it('ColorField: hex, picker and alpha each carry a handle; a mixed color marks the hex AND the picker', () => {
    render(<ColorField label="bg" value={0x112233} onChange={noop} mixed dataUiId="inspector.field.UIElement.backgroundColor" />);
    expect(meta('inspector.field.UIElement.backgroundColor')).toEqual({ mixed: true, value: '' });
    expect(meta('inspector.field.UIElement.backgroundColor.picker')).toMatchObject({ mixed: true });
  });

  it('ColorField: a mixed ALPHA marks the slider (it parks on the primary\'s alpha), not the picker', () => {
    render(<ColorField label="bg" value={0x112233} onChange={noop} alpha={0.5} onAlphaChange={noop} alphaMixed dataUiId="c" />);
    expect(meta('c.alpha')).toMatchObject({ mixed: true });
    expect(meta('c.picker')!.mixed).toBeUndefined();
  });

  it('an unmixed ColorField reads its values, not mixed', () => {
    render(<ColorField label="bg" value={0x112233} onChange={noop} alpha={0.5} onAlphaChange={noop} dataUiId="c" />);
    expect(meta('c')).toEqual({ value: '#11223380' });
    expect(meta('c.picker')!.mixed).toBeUndefined();
    expect(meta('c.alpha')!.mixed).toBeUndefined();
  });

  it('EntityRefField: the drop target carries a handle and a mixed ref says so', () => {
    render(<>
      <EntityRefField label="target" value="abc" onChange={noop} mixed dataUiId="inspector.field.Follow.target" />
      <EntityRefField label="target" value="" onChange={noop} dataUiId="inspector.field.Follow.other" />
    </>);
    expect(meta('inspector.field.Follow.target')).toEqual({ mixed: true });
    expect(exists('inspector.field.Follow.other')).toBe(true);
    expect(meta('inspector.field.Follow.other')).toBeUndefined();
  });

  it('AnchorPickerField: the grid reads mixed and every cell is an unselected button', () => {
    render(<AnchorPickerField value="center" onChange={noop} mixed dataUiId="inspector.field.UIAnchor.anchor" />);
    expect(meta('inspector.field.UIAnchor.anchor')).toEqual({ mixed: true });
    const cell = chromeHandles().find((h) => h.id === 'inspector.field.UIAnchor.anchor.center');
    expect(cell).toMatchObject({ kind: 'button', meta: { state: 'unchecked' } });
  });

  it('an unmixed AnchorPickerField marks only its current cell', () => {
    render(<AnchorPickerField value="center" onChange={noop} dataUiId="a" />);
    expect(exists('a')).toBe(true);
    expect(meta('a')).toBeUndefined();
    const checked = chromeHandles().filter((h) => h.id.startsWith('a.') && h.meta?.state === 'checked').map((h) => h.id);
    expect(checked).toEqual(['a.center']);
  });
});

describe('#1170 — FieldValueWidget forwards its id on EVERY branch', () => {
  it.each([
    ['boolean', { type: 'boolean' }, true, { mixed: true, state: 'mixed' }],
    ['color', { type: 'color' }, 0xff0000, { mixed: true, value: '' }],
    ['entityRef', { type: 'entityRef' }, 'abc', { mixed: true }],
    ['enum', { type: 'enum', options: ['a', 'b'] }, 'a', { mixed: true, value: '' }],
  ] as const)('%s', (_name, hint, value, expected) => {
    render(<FieldValueWidget hint={hint as never} value={value} onChange={noop} mixed dataUiId="uiActions.binding.0.value" />);
    expect(meta('uiActions.binding.0.value')).toEqual(expected);
  });
});

describe('#1170 — texture WebP Quality / UASTC RDO λ keep their tagged input when mixed', () => {
  it.each([
    ['2d', 'webpQuality', 'assetView.texture.webpQuality'],
    ['3d', 'uastcRdoLambda', 'assetView.texture.uastcRdoLambda'],
  ] as const)('%s texture: %s reads mixed and a typed value commits to the batch', (type, key, id) => {
    const onChange = vi.fn();
    render(<TextureSettingsControls type={type} settings={deriveSettingsForType(type)} mixed={new Set([key])} onChangeType={noop} onChange={onChange} />);
    // The swapped-in stand-in was untagged, so this handle did not exist at all when mixed.
    expect(meta(id)).toEqual({ mixed: true, value: '' });
    // Editable, not read-only (owner decision on #1170): typing sets the whole selection.
    // ⚠️ `readOnly` is asserted separately: fireEvent.change fires React's onChange on a read-only
    // input too, so the commit alone cannot tell editable from the old read-only stand-in.
    const input = document.querySelector<HTMLInputElement>(`[data-ui-id="${id}"]`)!;
    expect(input.readOnly).toBe(false);
    fireEvent.change(input, { target: { value: '2' } });
    expect(onChange).toHaveBeenCalledWith({ [key]: expect.any(Number) });
  });
});

describe('#1170 close-out — a half-typed keystroke in a MIXED text-number field writes nothing', () => {
  it.each(['-', '.', '-.'])('typing %j into mixed WebP Quality commits nothing; a real number then does', (partial) => {
    const onChange = vi.fn();
    render(<TextureSettingsControls type="2d" settings={deriveSettingsForType('2d')} mixed={new Set(['webpQuality'])} onChangeType={noop} onChange={onChange} />);
    const input = document.querySelector<HTMLInputElement>('[data-ui-id="assetView.texture.webpQuality"]')!;
    fireEvent.change(input, { target: { value: partial } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '70' } });
    expect(onChange).toHaveBeenCalledWith({ webpQuality: 70 });
  });

  it('an UNMIXED field still commits a lone "-" as today (the fix is scoped to mixed)', () => {
    const onChange = vi.fn();
    render(<BufferedNumberInput value={3} onChange={onChange} dataUiId="u" />);
    fireEvent.change(document.querySelector('[data-ui-id="u"]')!, { target: { value: '-' } });
    expect(onChange).toHaveBeenCalledWith(0);
  });
});

describe('#1170 close-out — a native step (wheel, arrows, spin buttons) on a focused MIXED number field writes nothing', () => {
  // `useWheelStep` stepped from `parseNumber('')` = 0 and committed the result to the whole batch:
  // one notch on a mixed WebP Quality turned 80 and 90 into 1. Editable-while-mixed made it reachable.
  it.each([
    ['2d', 'webpQuality', 'assetView.texture.webpQuality', -120],
    ['3d', 'uastcRdoLambda', 'assetView.texture.uastcRdoLambda', 120],
  ] as const)('%s texture: a wheel on mixed %s is refused', (type, key, id, deltaY) => {
    const onChange = vi.fn();
    render(<TextureSettingsControls type={type} settings={deriveSettingsForType(type)} mixed={new Set([key])} onChangeType={noop} onChange={onChange} />);
    const input = document.querySelector<HTMLInputElement>(`[data-ui-id="${id}"]`)!;
    input.focus();
    fireEvent.wheel(input, { deltaY });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('a MIXED field the user has typed into steps from THAT value (the other half of the guard)', () => {
    // The guard keys on the box being EMPTY, not on `mixed` alone: once a real value is typed the
    // wheel has a base, and refusing it would make the field feel dead mid-edit.
    const onChange = vi.fn();
    render(<BufferedNumberInput value={3} step={1} mixed onChange={onChange} dataUiId="w" />);
    const input = document.querySelector<HTMLInputElement>('[data-ui-id="w"]')!;
    input.focus();
    fireEvent.change(input, { target: { value: '5' } });
    fireEvent.wheel(input, { deltaY: -120 });
    expect(onChange.mock.calls).toEqual([[5], [6]]);
  });

  // NumberField is a real `type="number"`: the browser steps it natively (wheel, ArrowUp/Down, spin
  // buttons), which jsdom does not model. What jsdom CAN model is the one thing the guard keys on —
  // Chromium dispatches a native step as a plain `Event`, typing as an `InputEvent` with `inputType`.
  // The native write itself was measured live (a mixed `UIElement.zIndex` 10/20 → both 1 on one notch).
  const nativeStep = (el: HTMLInputElement, value: string) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const typed = (el: HTMLInputElement, value: string) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
  };

  it('NumberField: a native STEP on an empty MIXED box commits nothing', () => {
    const onChange = vi.fn();
    render(<NumberField label="z" value={10} onChange={onChange} step={1} mixed dataUiId="inspector.field.UIElement.zIndex" />);
    const input = document.querySelector<HTMLInputElement>('[data-ui-id="inspector.field.UIElement.zIndex"]')!;
    nativeStep(input, '1');
    expect(onChange).not.toHaveBeenCalled();
    expect(meta('inspector.field.UIElement.zIndex')).toEqual({ mixed: true, value: '' });
  });

  it('NumberField: TYPING into an empty mixed box commits, and a step after that is allowed', () => {
    const onChange = vi.fn();
    render(<NumberField label="z" value={10} onChange={onChange} step={1} mixed dataUiId="n" />);
    const input = document.querySelector<HTMLInputElement>('[data-ui-id="n"]')!;
    typed(input, '5');
    nativeStep(input, '6');
    expect(onChange.mock.calls).toEqual([[5], [6]]);
  });

  it('NumberField: an UNMIXED box the user CLEARED still commits a native step (the guard is mixed-only)', () => {
    const onChange = vi.fn();
    render(<NumberField label="z" value={10} onChange={onChange} step={1} dataUiId="n" />);
    const input = document.querySelector<HTMLInputElement>('[data-ui-id="n"]')!;
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '');
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
    expect(input.value).toBe('');
    onChange.mockClear();
    nativeStep(input, '1');
    expect(onChange).toHaveBeenCalledWith(1);
  });

  it('NumberField: an UNMIXED box still commits a native step', () => {
    const onChange = vi.fn();
    render(<NumberField label="z" value={10} onChange={onChange} step={1} dataUiId="n" />);
    nativeStep(document.querySelector<HTMLInputElement>('[data-ui-id="n"]')!, '11');
    expect(onChange).toHaveBeenCalledWith(11);
  });

  it('an UNMIXED field still steps on the wheel (the accept side of the same guard)', () => {
    const onChange = vi.fn();
    render(<BufferedNumberInput value={3} step={1} onChange={onChange} dataUiId="w" />);
    const input = document.querySelector<HTMLInputElement>('[data-ui-id="w"]')!;
    input.focus();
    fireEvent.wheel(input, { deltaY: -120 });
    expect(onChange).toHaveBeenCalledWith(4);
  });
});
