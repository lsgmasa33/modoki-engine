/** Floating stat widgets — store unit + launcher/layer integration (Phase 4.5).
 *
 *  Guards the spawn-a-floating-widget flow: the Stats tab is a launcher whose buttons
 *  toggle widgets in the store, and FloatingWidgetLayer renders the open ones as
 *  draggable windows that persist independently of the fullscreen modal. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import {
  registerStatWidget,
  getStatWidgets,
  toggleWidget,
  isWidgetOpen,
  getOpenWidgets,
  closeWidget,
  getWidgetVersion,
  __resetWidgetStore,
} from '../../packages/modoki/src/runtime/debug/widgetStore';
import { FloatingWidgetLayer } from '../../packages/modoki/src/runtime/debug/FloatingWidgetLayer';
import { StatsTab } from '../../packages/modoki/src/runtime/debug/tabs/StatsTab';

const Body = () => <div>WIDGET-BODY</div>;

beforeEach(() => __resetWidgetStore());
afterEach(() => cleanup());

describe('widgetStore', () => {
  it('registers, toggles open/closed, and tracks position', () => {
    registerStatWidget({ id: 'w1', title: 'W1', Component: Body, defaultPos: { x: 5, y: 7 } });
    expect(getStatWidgets().map((w) => w.id)).toEqual(['w1']);
    expect(isWidgetOpen('w1')).toBe(false);

    toggleWidget('w1');
    expect(isWidgetOpen('w1')).toBe(true);
    expect(getOpenWidgets()).toEqual([{ def: expect.objectContaining({ id: 'w1' }), pos: { x: 5, y: 7 } }]);

    toggleWidget('w1');
    expect(isWidgetOpen('w1')).toBe(false);
  });

  it('bumps the version on change and closes explicitly', () => {
    const v0 = getWidgetVersion();
    registerStatWidget({ id: 'w1', title: 'W1', Component: Body });
    expect(getWidgetVersion()).toBeGreaterThan(v0);
    toggleWidget('w1');
    expect(isWidgetOpen('w1')).toBe(true);
    closeWidget('w1');
    expect(isWidgetOpen('w1')).toBe(false);
  });
});

describe('Stats launcher + floating layer', () => {
  it('spawns a floating widget from the launcher and dismisses it via close', () => {
    registerStatWidget({ id: 'w1', title: 'W1', Component: Body });
    const { getByText, queryByText, getByLabelText } = render(
      <>
        <StatsTab />
        <FloatingWidgetLayer anchor="viewport" />
      </>,
    );
    // Launcher shows the spawn button; widget not yet on screen.
    expect(getByText('Performance monitors')).toBeTruthy();
    expect(queryByText('WIDGET-BODY')).toBeNull();

    fireEvent.click(getByText('W1')); // spawn
    expect(isWidgetOpen('w1')).toBe(true);
    expect(queryByText('WIDGET-BODY')).not.toBeNull();

    fireEvent.click(getByLabelText('Close W1')); // ✕ button
    expect(queryByText('WIDGET-BODY')).toBeNull();
    expect(isWidgetOpen('w1')).toBe(false);
  });
});
