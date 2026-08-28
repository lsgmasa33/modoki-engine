/**
 * A click on an interactive control must not ALSO read as a click on whatever is behind it.
 *
 * The bug this pins, reported on games/court: the settings panel dismisses by binding `click` on
 * its full-screen root (tap the backdrop to close), and the volume sliders live inside it. Every
 * adjustment closed the dialog, because `<input type="range">` had no click handler and the event
 * bubbled straight to the root. The TOGGLE branch had stopped propagation since it was written;
 * `range` and the text input simply never did.
 *
 * Asserted at the DOM, on the real `UINode`, because that is the only layer where the defect
 * exists — every trait, every projection and every binding was already correct.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import React from 'react';
import { UINode } from '../../packages/modoki/src/runtime/ui/UINode';

const NODE_DEFAULTS = {
  entityId: 1, guid: 'g1', children: [],
  width: 100, height: 40, widthUnit: 'px', heightUnit: 'px',
  flexDirection: 'row', flexWrap: 'nowrap', justifyContent: 'flex-start', alignItems: 'stretch',
  gap: 0, flexGrow: 0, flexShrink: 1,
  paddingTop: 0, paddingLeft: 0, paddingRight: 0, paddingBottom: 0,
  marginTop: 0, marginRight: 0, marginBottom: 0, marginLeft: 0,
  minWidth: 0, maxWidth: 0, minHeight: 0, maxHeight: 0,
  alignSelf: 'auto', zIndex: 0, overflow: 'visible', isVisible: true, pointerThrough: false,
  backgroundColor: 0, backgroundOpacity: 0, borderRadius: 0, borderWidth: 0,
  borderColor: 0x333333, borderOpacity: 1, opacity: 1,
  text: '', fontFamily: '', fontSize: 16, fontWeight: 'normal', fontStyle: 'normal',
  textColor: 0xffffff, textOpacity: 1, textAlign: 'left', lineHeight: 0, letterSpacing: 0,
  textShadowColor: 0, textShadowOpacity: 1, textShadowOffsetX: 0, textShadowOffsetY: 0,
  textShadowBlur: 0, textStrokeColor: 0, textStrokeOpacity: 1, textStrokeWidth: 0,
  textOverflow: 'clip', maxLines: 0, imageSrc: '', imageMode: 'cover',
  elementType: 'div', placeholder: '', rangeMin: 0, rangeMax: 100, rangeStep: 1,
  rotation: 0, scale: 1,
};

/** Render one UINode inside a backdrop that closes on click — the panel shape exactly. */
function renderInBackdrop(node: Record<string, unknown>) {
  const onBackdropClick = vi.fn();
  const { container } = render(
    React.createElement('div', { onClick: onBackdropClick },
      React.createElement(UINode, {
        node: { ...NODE_DEFAULTS, ...node } as never,
        storeState: { vol: 50, name: 'x' },
      })),
  );
  return { onBackdropClick, el: container.querySelector('[data-entity-id]') as HTMLElement };
}

describe('the control swallows its own click', () => {
  it('a range slider does not reach the backdrop', () => {
    const { onBackdropClick, el } = renderInBackdrop({
      elementType: 'range',
      binding: { inputBinding: 'vol' },
      action: { bindings: [{ event: 'change', kind: 'call', action: 'x' }] },
    });
    expect(el.tagName).toBe('INPUT');
    fireEvent.click(el);
    expect(onBackdropClick).not.toHaveBeenCalled();
  });

  it('a text input does not reach the backdrop', () => {
    // Latent rather than reported — no shipped game has yet put a text field inside a
    // dismiss-on-backdrop panel — but it is the identical defect, one branch up.
    const { onBackdropClick, el } = renderInBackdrop({
      elementType: 'input',
      binding: { inputBinding: 'name' },
      action: { bindings: [{ event: 'change', kind: 'call', action: 'x' }] },
    });
    expect(el.tagName).toBe('INPUT');
    fireEvent.click(el);
    expect(onBackdropClick).not.toHaveBeenCalled();
  });
});

describe('the control that is NOT interactive still passes its click through', () => {
  it('a plain div reaches the backdrop', () => {
    // The control assertion: the two above must pass because those BRANCHES stop the event, not
    // because the harness never delivers one. A plain node has nothing to swallow it.
    const { onBackdropClick, el } = renderInBackdrop({ elementType: 'div' });
    fireEvent.click(el);
    expect(onBackdropClick).toHaveBeenCalledTimes(1);
  });
});
