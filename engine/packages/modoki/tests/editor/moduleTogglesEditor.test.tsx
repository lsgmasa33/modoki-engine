/** ModuleTogglesEditor — the 'module-toggles' Project Settings widget. It edits
 *  build.modules (a record of ModuleToggle = 'auto' | boolean) as six tri-state
 *  Auto|On|Off rows, always writing the WHOLE modules object back (so every key
 *  persists, not just the one clicked). Dependency-light (React only) → jsdom. */
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, within } from '@testing-library/react';
import ModuleTogglesEditor from '../../src/editor/panels/ModuleTogglesEditor';

const MODULE_KEYS = ['render3d', 'render2d', 'physics2d', 'physics3d', 'npr', 'gpuParticles'];

/** Find a module's row by its `data-ui-id`.
 *
 *  This used to walk UP from a button whose `title` was exactly the module key — which only
 *  worked while all three segments of a row shared one title, i.e. while the row was
 *  un-addressable by an agent (the defect fixed here). Now each segment carries its own
 *  `title` AND its own `data-ui-id`, so the row is named directly. Anchoring the test on the
 *  same attribute the agent tooling aims at means a future rename cannot pass this suite while
 *  silently breaking `modoki_tap_handle`. */
function rowFor(container: HTMLElement, key: string): HTMLElement {
  const row = container.querySelector(`[data-ui-id="module-toggles.row.${key}"]`);
  if (!row) throw new Error(`no row for ${key}`);
  return row as HTMLElement;
}

describe('ModuleTogglesEditor', () => {
  it('renders one tri-state row per engine module', () => {
    const { container } = render(<ModuleTogglesEditor value={{}} onChange={vi.fn()} />);
    for (const key of MODULE_KEYS) {
      const row = rowFor(container, key);
      const labels = within(row).getAllByRole('button').map((b) => b.textContent);
      expect(labels).toEqual(['Auto', 'On', 'Off']);
    }
  });

  it('clicking On writes the full modules object with only that key changed', () => {
    const onChange = vi.fn();
    const value = { render3d: 'auto', render2d: 'auto', physics2d: 'auto', physics3d: 'auto', npr: 'auto', gpuParticles: 'auto' };
    const { container } = render(<ModuleTogglesEditor value={value} onChange={onChange} />);
    const row = rowFor(container, 'physics2d');
    fireEvent.click(within(row).getByText('On'));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({
      render3d: 'auto', render2d: 'auto', physics2d: true, physics3d: 'auto', npr: 'auto', gpuParticles: 'auto',
    });
  });

  it('clicking Off writes false; preserves the other keys already set', () => {
    const onChange = vi.fn();
    const { container } = render(<ModuleTogglesEditor value={{ render3d: true, physics3d: false }} onChange={onChange} />);
    fireEvent.click(within(rowFor(container, 'render2d')).getByText('Off'));
    expect(onChange).toHaveBeenCalledWith({
      render3d: true, render2d: false, physics2d: 'auto', physics3d: false, npr: 'auto', gpuParticles: 'auto',
    });
  });

  it('names every segment individually, and marks the SELECTED one, for agent addressing', () => {
    // The three segments of a row were indistinguishable (all `title={m.key}`, no id), so the
    // only way to aim at "Off for physics3d" was a DOM index — which breaks silently the day
    // OPTIONS is reordered. `data-ui-state` then answers "what is it set to?" without reading
    // a background colour out of a screenshot. Both are consumed by chromeHandles.ts.
    const { container } = render(
      <ModuleTogglesEditor value={{ physics3d: false }} onChange={vi.fn()} />,
    );
    const id = (s: string) => container.querySelector(`[data-ui-id="module-toggles.physics3d.${s}"]`);
    expect(id('auto')?.textContent).toBe('Auto');
    expect(id('on')?.textContent).toBe('On');
    expect(id('off')?.textContent).toBe('Off');
    // Off is the stored value, so ONLY that segment reports itself selected.
    expect(id('off')?.getAttribute('data-ui-state')).toBe('selected');
    expect(id('auto')?.hasAttribute('data-ui-state')).toBe(false);
    expect(id('on')?.hasAttribute('data-ui-state')).toBe(false);
  });

  it('normalizes a missing/garbage value to Auto (defensive)', () => {
    const onChange = vi.fn();
    // value is not an object → all rows Auto; clicking one still yields a full object.
    const { container } = render(<ModuleTogglesEditor value={undefined} onChange={onChange} />);
    fireEvent.click(within(rowFor(container, 'npr')).getByText('On'));
    expect(onChange).toHaveBeenCalledWith({
      render3d: 'auto', render2d: 'auto', physics2d: 'auto', physics3d: 'auto', npr: true, gpuParticles: 'auto',
    });
  });
});
