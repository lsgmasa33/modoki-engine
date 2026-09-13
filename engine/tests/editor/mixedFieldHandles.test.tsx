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

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { BufferedTextInput, BufferedNumberInput } from '@modoki/engine/editor';
import { NumberField } from '../../packages/modoki/src/editor/panels/assetViews/widgets';
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
});
