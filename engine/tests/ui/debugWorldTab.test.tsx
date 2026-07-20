/** World tab (runtime ECS inspector) — DOM integration + unit tests (Phase 2).
 *
 *  Proves the debug menu's world inspector reads the live ECS tree and writes trait
 *  fields back through the runtime primitives (`buildEntityTree`/`readTraitData`/
 *  `writeTraitField`) — the same ones the editor panels use, WITHOUT importing the
 *  editor. Guards tree render, selection, the trait/field readout, an editable-field
 *  round-trip, and collapse. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { getCurrentWorld, Transform, EntityAttributes } from '@modoki/engine/runtime';
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
