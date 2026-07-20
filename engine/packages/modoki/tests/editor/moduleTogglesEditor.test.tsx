/** ModuleTogglesEditor — the 'module-toggles' Project Settings widget. It edits
 *  build.modules (a record of ModuleToggle = 'auto' | boolean) as six tri-state
 *  Auto|On|Off rows, always writing the WHOLE modules object back (so every key
 *  persists, not just the one clicked). Dependency-light (React only) → jsdom. */
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, within } from '@testing-library/react';
import ModuleTogglesEditor from '../../src/editor/panels/ModuleTogglesEditor';

const MODULE_KEYS = ['render3d', 'render2d', 'physics2d', 'physics3d', 'npr', 'gpuParticles'];

/** Find the row (bordered div) that contains a given segment button, by walking
 *  up from a button whose title === the module key. */
function rowFor(container: HTMLElement, key: string): HTMLElement {
  const btn = Array.from(container.querySelectorAll('button')).find((b) => b.getAttribute('title') === key);
  if (!btn) throw new Error(`no button for ${key}`);
  return btn.closest('div') as HTMLElement;
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
