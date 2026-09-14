/** World tab (runtime ECS inspector) — DOM integration + unit tests (Phase 2).
 *
 *  Proves the debug menu's world inspector reads the live ECS tree and writes trait
 *  fields back through the runtime primitives (`buildEntityTree`/`readTraitData`/
 *  `writeTraitField`) — the same ones the editor panels use, WITHOUT importing the
 *  editor. Guards tree render, selection, the trait/field readout, an editable-field
 *  round-trip, and collapse. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import { getCurrentWorld, setCurrentWorld, Transform, EntityAttributes, markStructureDirty } from '@modoki/engine/runtime';
import { createWorld } from 'koota';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { WorldTab, formatValue, colorToHex, hexToColorNumber } from '../../packages/modoki/src/runtime/debug/tabs/WorldTab';

registerAllTraits();

// Hold the spawned entity handles so we can destroy them per test — the world is
// shared across a file, so leftovers would produce duplicate 'hero' nodes and break
// testing-library's single-match getByText.
let parent: ReturnType<ReturnType<typeof getCurrentWorld>['spawn']>;
let child: typeof parent;

beforeEach(() => {
  parent = getCurrentWorld().spawn(Transform({ x: 4.25, y: 0, z: 0 }), EntityAttributes({ name: 'hero', layer: '3d' }));
  child = getCurrentWorld().spawn(Transform({ x: 1, y: 0, z: 0 }), EntityAttributes({ name: 'sword', layer: '3d', parentId: parent.id() }));
});

afterEach(() => {
  cleanup();
  if (child?.isAlive()) child.destroy();
  if (parent?.isAlive()) parent.destroy();
});

describe('WorldTab hierarchy', () => {
  it('renders entity names from the live tree', () => {
    const { queryByText } = render(<WorldTab />);
    expect(queryByText('hero')).not.toBeNull();
    expect(queryByText('sword')).not.toBeNull();
  });

  it('collapses a node to hide its children', () => {
    const { getByText, queryByText } = render(<WorldTab />);
    expect(queryByText('sword')).not.toBeNull();
    const heroRow = getByText('hero').parentElement as HTMLElement;
    const caret = heroRow.querySelector('span') as HTMLElement; // first span = caret
    fireEvent.click(caret);
    expect(queryByText('sword')).toBeNull();
  });
});

// #868: the collapse set and the selection were held as bare ids — koota's recycled index — so a
// node deleted and replaced by a new entity on the same index handed the newcomer its collapsed
// state and put the newcomer in the inspector, where an edit writes to it.
describe('WorldTab state across a recycled index (#868)', () => {
  /** Destroy `hero`+`sword` (child first, so the parent's index is reclaimed first) and spawn a
   *  different pair onto the same indices. */
  const replaceWithVillain = () => {
    const heroId = parent.id();
    child.destroy();
    parent.destroy();
    const villain = getCurrentWorld().spawn(Transform({ x: 7, y: 0, z: 0 }), EntityAttributes({ name: 'villain', layer: '3d' }));
    const shield = getCurrentWorld().spawn(Transform({ x: 0, y: 0, z: 0 }), EntityAttributes({ name: 'shield', layer: '3d', parentId: villain.id() }));
    expect(villain.id()).toBe(heroId);
    act(() => markStructureDirty());
    return { villain, shield };
  };

  it('a new entity on a collapsed node\'s index is not collapsed', () => {
    const { getByText, queryByText } = render(<WorldTab />);
    fireEvent.click((getByText('hero').parentElement as HTMLElement).querySelector('span') as HTMLElement);
    expect(queryByText('sword')).toBeNull();

    const { villain, shield } = replaceWithVillain();
    try {
      expect(queryByText('villain')).not.toBeNull();
      expect(queryByText('shield')).not.toBeNull();
    } finally { shield.destroy(); villain.destroy(); }
  });

  it('a new entity on the selected node\'s index is not shown in the inspector', () => {
    const { getByText, queryByText } = render(<WorldTab />);
    fireEvent.click(getByText('hero'));
    expect(queryByText('Transform')).not.toBeNull();

    const { villain, shield } = replaceWithVillain();
    try {
      expect(queryByText('Transform')).toBeNull();
    } finally { shield.destroy(); villain.destroy(); }
  });
});

describe('WorldTab across a world swap (#868)', () => {
  it('drops the selection when a new world is promoted, even with an entity on the same index', () => {
    const original = getCurrentWorld();
    const { getByText, queryByText } = render(<WorldTab />);
    fireEvent.click(getByText('hero'));
    expect(queryByText('Transform')).not.toBeNull();

    const next = createWorld();
    try {
      let other;
      do { other = next.spawn(Transform({ x: 0, y: 0, z: 0 }), EntityAttributes({ name: 'other', layer: '3d' })); } while (other.id() < parent.id());
      expect(other.id()).toBe(parent.id());
      act(() => setCurrentWorld(next));
      expect(queryByText('Transform')).toBeNull();
    } finally {
      act(() => setCurrentWorld(original));
      next.destroy();
    }
  });
});

describe('WorldTab inspector', () => {
  it('shows the selected entity traits + fields', () => {
    const { getByText, queryByText } = render(<WorldTab />);
    fireEvent.click(getByText('hero'));
    expect(queryByText('Transform')).not.toBeNull();
    expect(queryByText('x')).not.toBeNull(); // a Transform field
  });

  it('writes an edited number field back to the world', () => {
    const { getByText, container } = render(<WorldTab />);
    fireEvent.click(getByText('hero'));
    const numberInputs = [...container.querySelectorAll('input[type=number]')] as HTMLInputElement[];
    const xInput = numberInputs.find((i) => i.value === '4.25');
    expect(xInput, 'x field input (value 4.25) should be present').toBeTruthy();
    fireEvent.change(xInput!, { target: { value: '9' } });
    expect((parent.get(Transform) as { x: number }).x).toBe(9);
  });
});

describe('color field conversion (numeric colors ↔ hex, no live-world corruption)', () => {
  it('converts a numeric color to #rrggbb for the picker', () => {
    expect(colorToHex(0xff0000)).toBe('#ff0000');
    expect(colorToHex(0)).toBe('#000000');
    expect(colorToHex(0xffffff)).toBe('#ffffff');
    expect(colorToHex(0x3399cc)).toBe('#3399cc');
  });

  it('passes through a valid hex string and falls back on junk', () => {
    expect(colorToHex('#12ab34')).toBe('#12ab34');
    expect(colorToHex(undefined)).toBe('#ffffff');
    expect(colorToHex(NaN)).toBe('#ffffff');
  });

  it('writes hex back as a number (round-trips)', () => {
    expect(hexToColorNumber('#ff0000')).toBe(0xff0000);
    expect(hexToColorNumber('#000000')).toBe(0);
    expect(hexToColorNumber(colorToHex(0x3399cc))).toBe(0x3399cc);
  });
});

describe('formatValue', () => {
  it('formats nullish, ints, floats, arrays, objects', () => {
    expect(formatValue(null)).toBe('—');
    expect(formatValue(undefined)).toBe('—');
    expect(formatValue(3)).toBe('3');
    expect(formatValue(1.23456)).toBe('1.235');
    expect(formatValue([1, 2, 3])).toBe('[3]');
    expect(formatValue({ a: 1 })).toBe('{…}');
    expect(formatValue('hi')).toBe('hi');
  });
});
