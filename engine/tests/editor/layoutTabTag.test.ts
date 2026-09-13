/** Unit: dock tabs become agent-addressable chrome (#1152, #1153).
 *
 *  FlexLayout renders the tab buttons itself, so the tag rides the tab's CONTENT via
 *  `onRenderTab`. The attribute decision is pinned here; the wiring is a source tripwire, in the
 *  style of chromeTagging.test.ts, because EditorApp.tsx cannot be mounted in jsdom. The live
 *  proof (the tag renders, and a trusted tap on it switches the tab) is the T3 check. */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { readScannedSource } from '@modoki/engine/testing';
import { layoutTabTagAttrs, LAYOUT_TAB_ID_PREFIX } from '../../packages/modoki/src/editor/layoutTabTag';

const tab = (component: string | undefined, selected: boolean) => ({
  getComponent: () => component,
  isSelected: () => selected,
});

describe('layoutTabTagAttrs', () => {
  it('names the tab by its COMPONENT, as a chrome tab, with its selection as state', () => {
    expect(layoutTabTagAttrs(tab('console', true))).toEqual({
      'data-ui-id': 'layout.tab.console',
      'data-ui-kind': 'tab',
      'data-ui-state': 'selected',
    });
    expect(layoutTabTagAttrs(tab('assets', false))!['data-ui-state']).toBe('unselected');
  });

  it('the id is <panel>.<region>.<name>, like every other chrome id', () => {
    expect(LAYOUT_TAB_ID_PREFIX.split('.').filter(Boolean)).toHaveLength(2);
  });

  it('a tab with no component is left untagged — there is nothing to name it by', () => {
    expect(layoutTabTagAttrs(tab(undefined, true))).toBeNull();
    expect(layoutTabTagAttrs(tab('', true))).toBeNull();
  });

  it('EditorApp still wires it into the Layout (source tripwire)', () => {
    // Comment-stripped (#812): a comment mentioning the wiring must not satisfy this on its own.
    const src = readScannedSource(path.resolve(__dirname, '../../packages/modoki/src/editor/EditorApp.tsx')).code;
    expect(src).toContain('onRenderTab={onRenderTab}');
    expect(src).toMatch(/layoutTabTagAttrs\(node\)/);
  });
});
