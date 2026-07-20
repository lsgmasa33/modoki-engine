/** Time / Journal / Store debug tabs — DOM integration tests (Phase 3).
 *
 *  Each reads a runtime-safe source (getTimeScale/setTimeScale, journalEvents,
 *  read-source registry) so it ships in a game bundle. Guards the control paths:
 *  timeScale presets + pause, journal enabled/disabled + filter + clear, and the
 *  read-only store value list. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { getCurrentWorld } from '@modoki/engine/runtime';
import { Time } from '../../packages/modoki/src/runtime/traits/Time';
import { getTimeScale } from '../../packages/modoki/src/runtime/systems/getTime';
import { emit, clearJournal, setJournalEnabled } from '../../packages/modoki/src/runtime/systems/journal';
import { registerReadSource } from '../../packages/modoki/src/runtime/ui/readSourceRegistry';
import { TimeTab } from '../../packages/modoki/src/runtime/debug/tabs/TimeTab';
import { JournalTab } from '../../packages/modoki/src/runtime/debug/tabs/JournalTab';
import { StoreTab } from '../../packages/modoki/src/runtime/debug/tabs/StoreTab';

afterEach(() => cleanup());

describe('TimeTab', () => {
  let timeEntity: ReturnType<ReturnType<typeof getCurrentWorld>['spawn']>;
  beforeEach(() => {
    timeEntity = getCurrentWorld().spawn(Time);
  });
  afterEach(() => {
    if (timeEntity?.isAlive()) timeEntity.destroy();
  });

  it('applies a preset time scale to the world', () => {
    const { getByText } = render(<TimeTab />);
    fireEvent.click(getByText('2×'));
    expect(getTimeScale(getCurrentWorld())).toBe(2);
  });

  it('pauses (timeScale 0) and resumes to the last non-zero scale', () => {
    const { getByText } = render(<TimeTab />);
    fireEvent.click(getByText('0.5×'));
    expect(getTimeScale(getCurrentWorld())).toBe(0.5);
    fireEvent.click(getByText(/Pause/));
    expect(getTimeScale(getCurrentWorld())).toBe(0);
    fireEvent.click(getByText(/Resume/));
    expect(getTimeScale(getCurrentWorld())).toBe(0.5); // restored, not reset to 1
  });
});

describe('JournalTab', () => {
  beforeEach(() => {
    clearJournal();
    setJournalEnabled(true);
  });
  afterEach(() => {
    clearJournal();
    setJournalEnabled(false);
  });

  it('shows a disabled hint when journaling is off', () => {
    setJournalEnabled(false);
    const { getByText } = render(<JournalTab />);
    expect(getByText(/Journal is disabled/)).toBeTruthy();
  });

  it('lists emitted events and filters by type', () => {
    emit('match', { count: 3 });
    emit('score', { points: 100 });
    const { queryByText, getByPlaceholderText } = render(<JournalTab />);
    expect(queryByText('match')).not.toBeNull();
    expect(queryByText('score')).not.toBeNull();
    fireEvent.change(getByPlaceholderText('filter by type…'), { target: { value: 'match' } });
    expect(queryByText('match')).not.toBeNull();
    expect(queryByText('score')).toBeNull();
  });

  it('clears the journal', () => {
    emit('win');
    const { queryByText, getByText } = render(<JournalTab />);
    expect(queryByText('win')).not.toBeNull();
    fireEvent.click(getByText('Clear'));
    expect(queryByText('win')).toBeNull();
  });
});

describe('StoreTab', () => {
  let unregister: (() => void) | null = null;
  afterEach(() => {
    unregister?.();
    unregister = null;
  });

  it('lists registered read-source values read-only', () => {
    unregister = registerReadSource('debug.coins', () => 250);
    const { queryByText } = render(<StoreTab />);
    expect(queryByText('debug.coins')).not.toBeNull();
    expect(queryByText('250')).not.toBeNull();
  });

  it('filters values by name', () => {
    const u1 = registerReadSource('debug.coins', () => 1);
    const u2 = registerReadSource('debug.level', () => 2);
    unregister = () => {
      u1();
      u2();
    };
    const { queryByText, getByPlaceholderText } = render(<StoreTab />);
    fireEvent.change(getByPlaceholderText('filter…'), { target: { value: 'level' } });
    expect(queryByText('debug.level')).not.toBeNull();
    expect(queryByText('debug.coins')).toBeNull();
  });
});
