/** ColorField's hex commit path — the behavior that lives in `commitHex`, not in the
 *  pure parser (see colorHex.test.ts for that).
 *
 *  Two rules carry the design:
 *   - alpha is a float but the hex carries 8 bits, so an RGB-only edit must NOT rewrite
 *     alpha (an authored 0.5 would drift to 0.502 the first time you touched the color);
 *   - a color with no alpha channel (a Light, `emissive`) shows 6 digits, and pasting an
 *     8-digit value applies the RGB and drops the alpha rather than refusing the paste. */
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';

const { ColorField } = await import('../../src/editor/panels/assetViews/widgets');

afterEach(cleanup);

const hexBox = (label: string) => screen.getByLabelText(`${label} hex`) as HTMLInputElement;
const type = (el: HTMLInputElement, v: string) => fireEvent.change(el, { target: { value: v } });

describe('ColorField — alpha-bearing field', () => {
  const setup = (alpha = 0.5) => {
    const onChange = vi.fn(), onAlphaChange = vi.fn();
    render(<ColorField label="bg" value={0x112233} onChange={onChange} alpha={alpha} onAlphaChange={onAlphaChange} />);
    return { onChange, onAlphaChange };
  };

  it('renders an 8-digit hex carrying the alpha byte', () => {
    setup(17 / 255);
    expect(hexBox('bg').value).toBe('#11223311');
  });

  it('commits color and alpha from a pasted #rrggbbaa', () => {
    const { onChange, onAlphaChange } = setup(1);
    type(hexBox('bg'), '#aabbcc11');
    expect(onChange).toHaveBeenCalledWith(0xaabbcc);
    expect(onAlphaChange).toHaveBeenCalledTimes(1);
    expect(onAlphaChange.mock.calls[0][0]).toBeCloseTo(17 / 255, 6);
  });

  it('does NOT rewrite alpha when only the rgb half changed (the drift guard)', () => {
    // stored alpha 0.5 renders as byte 0x80; committing the same byte back must not
    // write 128/255 = 0.502 over the authored 0.5.
    const { onChange, onAlphaChange } = setup(0.5);
    expect(hexBox('bg').value).toBe('#11223380');
    type(hexBox('bg'), '#ff000080');
    expect(onChange).toHaveBeenCalledWith(0xff0000);
    expect(onAlphaChange).not.toHaveBeenCalled();
  });

  it('does not re-commit an unchanged color', () => {
    const { onChange, onAlphaChange } = setup(0.5);
    type(hexBox('bg'), '#11223380');
    expect(onChange).not.toHaveBeenCalled();
    expect(onAlphaChange).not.toHaveBeenCalled();
  });

  it('ignores partial input while typing, then commits the full value', () => {
    const { onChange } = setup(1);
    const box = hexBox('bg');
    for (const partial of ['#', '#f', '#ff', '#fff', '#ffff', '#fffff']) {
      type(box, partial);
      expect(onChange).not.toHaveBeenCalled();
    }
    type(box, '#ffffff');
    expect(onChange).toHaveBeenCalledWith(0xffffff);
  });
});

describe('ColorField — mixed multi-select', () => {
  it('blanks the hex to the mixed placeholder rather than showing the primary value', () => {
    render(<ColorField label="c" value={0x112233} onChange={vi.fn()} mixed />);
    expect(hexBox('c').value).toBe('');
  });

  it('commits the primary entity\'s OWN hex — the equality guard must not no-op a mixed set', () => {
    // The guards compare against the PRIMARY's value, which says nothing about the other
    // selected entities. Typing #112233 to normalize a mixed selection has to write, or
    // the others silently keep their old colors.
    const onChange = vi.fn();
    render(<ColorField label="c" value={0x112233} onChange={onChange} mixed />);
    type(hexBox('c'), '#112233');
    expect(onChange).toHaveBeenCalledWith(0x112233);
  });

  it('commits the primary\'s own alpha byte when only alpha is mixed', () => {
    const onAlphaChange = vi.fn();
    render(<ColorField label="c" value={0x112233} onChange={vi.fn()} alpha={0.5} onAlphaChange={onAlphaChange} alphaMixed />);
    type(hexBox('c'), '#11223380');
    expect(onAlphaChange).toHaveBeenCalledTimes(1);
    expect(onAlphaChange.mock.calls[0][0]).toBeCloseTo(128 / 255, 6);
  });

  it('does not broadcast a transient empty buffer to the whole selection', () => {
    const onChange = vi.fn();
    render(<ColorField label="c" value={0x112233} onChange={onChange} mixed />);
    type(hexBox('c'), '');
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('ColorField — no alpha channel', () => {
  const setup = () => {
    const onChange = vi.fn();
    render(<ColorField label="color" value={0xfff4e0} onChange={onChange} />);
    return { onChange };
  };

  it('renders a 6-digit hex and no alpha slider', () => {
    setup();
    expect(hexBox('color').value).toBe('#fff4e0');
    expect(screen.queryByLabelText('color alpha')).toBeNull();
  });

  it('applies the rgb and DROPS the alpha when an 8-digit value is pasted', () => {
    const { onChange } = setup();
    type(hexBox('color'), '#aabbcc11');
    expect(onChange).toHaveBeenCalledWith(0xaabbcc);   // alpha silently discarded
  });

  it('accepts a bare hex with no leading #', () => {
    const { onChange } = setup();
    type(hexBox('color'), 'ff8000');
    expect(onChange).toHaveBeenCalledWith(0xff8000);
  });

  it('holds an invalid entry in the box without committing it', () => {
    const { onChange } = setup();
    const box = hexBox('color');
    type(box, 'nonsense');
    expect(onChange).not.toHaveBeenCalled();
    expect(box.value).toBe('nonsense');  // stays so the user can keep editing
    fireEvent.blur(box);
    expect(box.value).toBe('#fff4e0');   // reconciles back on blur
  });
});
