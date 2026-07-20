/** Timeline review C5 — the ItemInspector NumField must distinguish a CLEARED optional field (unset →
 *  undefined) from a typed 0. Before the fix `Number(e.target.value) || 0` collapsed an empty field to
 *  0, so an optional clip/cue field (duration/volume/pitch) could never round-trip to "unset" and a
 *  control clip's "no duration" (spawn-and-leave) silently became duration:0 (spawn-and-despawn). */
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import ItemInspector from '../../src/editor/panels/timeline/ItemInspector';
import type { TrackDef } from '../../src/runtime/timeline/types';
import type { TrackItemPatch } from '../../src/editor/panels/timeline/itemEdit';

afterEach(cleanup);

function renderInspector(track: TrackDef, itemIdx: number) {
  const onEdit = vi.fn<(patch: TrackItemPatch, field: string) => void>();
  const r = render(
    <ItemInspector
      track={track} itemIdx={itemIdx}
      audioAssets={[{ guid: 'g-a', label: 'a' }]} prefabAssets={[]} actionNames={[]}
      onEdit={onEdit} onDelete={() => {}}
    />,
  );
  const numInputs = () => Array.from(r.container.querySelectorAll('input[type="number"]')) as HTMLInputElement[];
  return { onEdit, numInputs };
}

describe('ItemInspector NumField — unset vs 0 (review C5)', () => {
  it('clearing an OPTIONAL field (audio volume) emits undefined, not 0', () => {
    const track: TrackDef = { id: 'a', name: 'A', target: '', type: 'audio', cues: [{ t: 1, clip: 'g-a', volume: 0.8, pitch: 1 }] };
    const { onEdit, numInputs } = renderInspector(track, 0);
    // Audio inspector number inputs in order: [t, vol, pitch].
    const vol = numInputs()[1];
    expect(vol.value).toBe('0.8');
    fireEvent.change(vol, { target: { value: '' } });
    expect(onEdit).toHaveBeenCalledWith({ volume: undefined }, 'vol');
  });

  it('clearing an OPTIONAL control-clip duration emits undefined (→ spawn-and-leave, not duration:0)', () => {
    const track: TrackDef = { id: 'c', name: 'C', target: '', type: 'control', clips: [{ start: 1, duration: 2, prefab: 'g-p' }] };
    const { onEdit, numInputs } = renderInspector(track, 0);
    // Control (prefab) number inputs: [start, dur, x, y, z, rx, ...]; index 1 is dur.
    const dur = numInputs()[1];
    expect(dur.value).toBe('2');
    fireEvent.change(dur, { target: { value: '' } });
    expect(onEdit).toHaveBeenCalledWith({ duration: undefined }, 'dur');
  });

  it('typing 0 keeps 0 (only an EMPTY field is treated as unset)', () => {
    const track: TrackDef = { id: 'a', name: 'A', target: '', type: 'audio', cues: [{ t: 1, clip: 'g-a', volume: 0.8, pitch: 1 }] };
    const { onEdit, numInputs } = renderInspector(track, 0);
    fireEvent.change(numInputs()[1], { target: { value: '0' } });
    expect(onEdit).toHaveBeenCalledWith({ volume: 0 }, 'vol');
  });

  it('clearing a REQUIRED field (audio t) still emits 0, not undefined', () => {
    const track: TrackDef = { id: 'a', name: 'A', target: '', type: 'audio', cues: [{ t: 1.5, clip: 'g-a' }] };
    const { onEdit, numInputs } = renderInspector(track, 0);
    fireEvent.change(numInputs()[0], { target: { value: '' } }); // t is required → clears to 0
    expect(onEdit).toHaveBeenCalledWith({ t: 0 }, 't');
  });
});
