/** Panel docking helpers (Phase A: game-registered editor panels).
 *
 *  dockPanel underpins the Window menu AND the openByDefault auto-dock of a
 *  game-registered panel. The load-bearing behavior: dock a fresh tab next to the
 *  Scene tabset the first time, then FOCUS (never duplicate) on repeat calls. */

import { describe, it, expect } from 'vitest';
import { Model, DockLocation, TabNode } from 'flexlayout-react';
import type { IJsonModel } from 'flexlayout-react';
import { dockPanel, toDockLocation } from '../../src/editor/panelDock';

const twoTabsetLayout: IJsonModel = {
  global: {},
  borders: [],
  layout: {
    type: 'row', weight: 100,
    children: [
      { type: 'tabset', weight: 50, children: [{ type: 'tab', name: 'Scene', component: 'scene' }] },
      { type: 'tabset', weight: 50, children: [{ type: 'tab', name: 'Inspector', component: 'inspector' }] },
    ],
  },
};

/** Count open tabs whose component === id. */
function tabCount(model: Model, id: string): number {
  let n = 0;
  model.visitNodes((node) => {
    if (node.getType() === 'tab' && (node as TabNode).getComponent() === id) n++;
  });
  return n;
}

/** The tabset id that holds the 'scene' tab (where CENTER docking lands). */
function sceneTabsetId(model: Model): string | null {
  let id: string | null = null;
  model.visitNodes((node) => {
    if (node.getType() === 'tabset') {
      const kids = (node as unknown as { getChildren?: () => { getComponent?: () => string }[] }).getChildren?.() ?? [];
      if (kids.some((c) => c.getComponent?.() === 'scene')) id = node.getId();
    }
  });
  return id;
}

describe('toDockLocation', () => {
  it('maps the four hints, defaulting unknown/undefined to CENTER', () => {
    expect(toDockLocation('bottom')).toBe(DockLocation.BOTTOM);
    expect(toDockLocation('left')).toBe(DockLocation.LEFT);
    expect(toDockLocation('right')).toBe(DockLocation.RIGHT);
    expect(toDockLocation('center')).toBe(DockLocation.CENTER);
    expect(toDockLocation(undefined)).toBe(DockLocation.CENTER);
  });
});

describe('dockPanel', () => {
  it('adds a new tab next to the Scene tabset on first dock', () => {
    const model = Model.fromJson(twoTabsetLayout);
    expect(tabCount(model, 'field')).toBe(0);
    const r = dockPanel(model, 'field', 'Field Editor');
    expect(r).toBe('added');
    expect(tabCount(model, 'field')).toBe(1);
    // Landed in the Scene tabset (CENTER default).
    const scenTs = sceneTabsetId(model);
    let landedInScene = false;
    model.visitNodes((node) => {
      if (node.getType() === 'tab' && (node as TabNode).getComponent() === 'field') {
        landedInScene = node.getParent()?.getId() === scenTs;
      }
    });
    expect(landedInScene).toBe(true);
  });

  it('focuses (never duplicates) when the tab already exists', () => {
    const model = Model.fromJson(twoTabsetLayout);
    dockPanel(model, 'field', 'Field Editor');
    const r = dockPanel(model, 'field', 'Field Editor');
    expect(r).toBe('focused');
    expect(tabCount(model, 'field')).toBe(1); // still exactly one
  });

  it('honors a non-CENTER dock location (splits off a new tabset)', () => {
    const model = Model.fromJson(twoTabsetLayout);
    const before = new Set<string>();
    model.visitNodes((n) => { if (n.getType() === 'tabset') before.add(n.getId()); });
    const r = dockPanel(model, 'field', 'Field Editor', toDockLocation('bottom'));
    expect(r).toBe('added');
    expect(tabCount(model, 'field')).toBe(1);
    // A BOTTOM dock creates a tabset that wasn't in the original set.
    let newTabset = false;
    model.visitNodes((n) => {
      if (n.getType() === 'tabset' && !before.has(n.getId())) {
        const kids = (n as unknown as { getChildren?: () => { getComponent?: () => string }[] }).getChildren?.() ?? [];
        if (kids.some((c) => c.getComponent?.() === 'field')) newTabset = true;
      }
    });
    expect(newTabset).toBe(true);
  });
});
