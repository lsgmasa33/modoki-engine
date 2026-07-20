/** TrackList — selected-PROPERTY value bar (the "show + key the value at the playhead"
 *  feature). When a single property row is selected with NO keyframe selected, the
 *  property list shows a VAL bar with the property's value at the playhead; editing it
 *  keys the property there (the panel wires onSetPropValue → upsertKey at the playhead).
 *  These cover the render gating + the edit→commit path deterministically (the live
 *  editor's tiny NumBox is impractical to drive by synthetic taps). */
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import TrackList, { type SelectedKeyInfo, type SelectedPropInfo } from '../../src/editor/panels/animation/TrackList';
import type { AnimationTrack } from '../../src/runtime/animation/types';

const track: AnimationTrack = {
  path: 'root/left_hip/left_leg', trait: 'Transform', field: 'rz', type: 'number',
  keys: [{ t: 0, v: -0.32, inTangent: 0, outTangent: 0 }],
};

function renderList(over: {
  selKey?: SelectedKeyInfo | null;
  selCount?: number;
  propVal?: SelectedPropInfo | null;
  onSetPropValue?: (v: number) => void;
} = {}) {
  const onSetPropValue = over.onSetPropValue ?? vi.fn();
  render(
    <TrackList
      tracks={[track]}
      width={220}
      selected={0}
      selectedTracks={new Set([0])}
      onSelect={vi.fn()}
      onRemove={vi.fn()}
      onReorder={vi.fn()}
      onAddProperty={vi.fn()}
      viewMode="dopesheet"
      onSetViewMode={vi.fn()}
      selKey={over.selKey ?? null}
      selCount={over.selCount ?? 0}
      onSetKeyValue={vi.fn()}
      onSetKeyFrame={vi.fn()}
      propVal={over.propVal ?? null}
      onSetPropValue={onSetPropValue}
    />,
  );
  return { onSetPropValue };
}

const propAt = (value: number, frame: number): SelectedPropInfo => ({ type: 'number', value, frame, label: 'Transform.rz' });

describe('TrackList — selected-property value bar', () => {
  it('shows the property value at the playhead when no key is selected', () => {
    renderList({ propVal: propAt(0.154017, 10) });
    expect(screen.getByText('VAL')).toBeTruthy();
    expect(screen.getByText(/keys @ f10/)).toBeTruthy();          // keys land at the playhead frame
    expect(screen.getByDisplayValue('0.154017')).toBeTruthy();    // shows the current value
  });

  it('editing the value keys the property — onSetPropValue fires with the typed number', () => {
    const onSetPropValue = vi.fn();
    renderList({ propVal: propAt(0.154017, 10), onSetPropValue });
    const input = screen.getByDisplayValue('0.154017');
    fireEvent.change(input, { target: { value: '0.9' } });
    fireEvent.blur(input); // NumBox commits on blur
    expect(onSetPropValue).toHaveBeenCalledWith(0.9);
  });

  it('a selected KEY takes precedence — shows the KEY bar, hides the property VAL bar', () => {
    renderList({
      selKey: { type: 'number', value: -0.32, frame: 0, label: 'Transform.rz' },
      selCount: 1,
      propVal: propAt(0.154017, 10),
    });
    expect(screen.getByText('KEY')).toBeTruthy();
    expect(screen.queryByText('VAL')).toBeNull();
  });

  it('hides the VAL bar when nothing (no key, no property value) is selected', () => {
    renderList({ propVal: null });
    expect(screen.queryByText('VAL')).toBeNull();
  });
});
