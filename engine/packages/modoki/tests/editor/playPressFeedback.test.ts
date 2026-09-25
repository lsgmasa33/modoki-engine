/** A refused or non-reverting Play/Stop press TELLS the human (#1577).
 *
 *  The toolbar used to `void enterPlay()` / `void stopPlay()`, so the outcome #1574 returns reached
 *  only the agent op: on screen a correct refusal looked like a dead ▶. The decision half (which
 *  outcome speaks, with what text) is pinned against every outcome kind; the press half drives
 *  `pressPlay`/`pressStop` against a stubbed controller and reads the REAL editor store's toast —
 *  the controller's own outcomes are pinned in `playModeOutcome.test.ts`. */

import { describe, it, expect, afterEach, vi } from 'vitest';
import type { PlayOutcome, StopOutcome } from '../../src/editor/scene/playMode';

const h = vi.hoisted(() => ({
  play: null as null | (() => Promise<unknown>),
  stop: null as null | (() => Promise<unknown>),
}));
vi.mock('../../src/editor/scene/playMode', () => ({
  enterPlay: () => h.play!(),
  stopPlay: () => h.stop!(),
}));

import { playFeedback, stopFeedback, pressPlay, pressStop } from '../../src/editor/scene/playPressFeedback';
import { useEditorStore } from '../../src/editor/store/editorStore';

const toast = () => useEditorStore.getState().toast;

afterEach(() => {
  useEditorStore.setState({ toast: null });
  h.play = h.stop = null;
  vi.restoreAllMocks();
});

describe('playFeedback — which Play outcome the human hears', () => {
  it.each<[string, PlayOutcome]>([
    ['scene-swap', { kind: 'refused', reason: 'scene-swap', message: 'Play refused — a scene load is still in flight.' }],
    ['restore-failed', { kind: 'refused', reason: 'restore-failed', message: 'Play refused — the last restore FAILED.' }],
    ['load-landed', { kind: 'refused', reason: 'load-landed', message: 'Play cancelled — a scene load landed.' }],
    ['a queued Stop that did not revert', { kind: 'stopped-during-startup', reverted: false, message: 'Stop ran without reverting.' }],
  ])('%s → a warn toast carrying the outcome message', (_, o) => {
    expect(playFeedback(o)).toEqual({ text: (o as { message: string }).message, kind: 'warn' });
  });

  it.each<[string, PlayOutcome]>([
    ['started', { kind: 'started' }],
    ['resumed', { kind: 'resumed' }],
    ['already-playing', { kind: 'already-playing' }],
    ['a double-press (already-starting)', { kind: 'refused', reason: 'already-starting', message: 'another Play is starting' }],
    ['a queued Stop that reverted', { kind: 'stopped-during-startup', reverted: true, message: 'back to the authored snapshot' }],
  ])('%s → silent', (_, o) => {
    expect(playFeedback(o)).toBeNull();
  });
});

describe('stopFeedback — which Stop outcome the human hears', () => {
  it('a Stop that skipped its revert → a warn toast naming the reason', () => {
    expect(stopFeedback({ kind: 'stopped', reverted: false, reason: 'the scene changed during Play' }))
      .toEqual({ text: 'Stopped without reverting — the scene changed during Play.', kind: 'warn' });
  });
  it('a preview exit that skipped its revert → a warn toast naming the reason', () => {
    expect(stopFeedback({ kind: 'preview-exited', reverted: false, reason: 'the scene changed' }))
      .toEqual({ text: 'Preview exited without reverting — the scene changed.', kind: 'warn' });
  });
  it.each<[string, StopOutcome]>([
    ['a reverted Stop', { kind: 'stopped', reverted: true }],
    ['a reverted preview exit', { kind: 'preview-exited', reverted: true }],
    ['a preview exit that only waited on a panel restore', { kind: 'preview-exited' }],
    ['queued behind a starting Play', { kind: 'queued' }],
    ['already-stopped', { kind: 'already-stopped' }],
  ])('%s → silent', (_, o) => {
    expect(stopFeedback(o)).toBeNull();
  });
});

describe('the presses deliver it to the editor toast', () => {
  it('a refused ▶ raises the refusal as a warn toast', async () => {
    h.play = async () => ({ kind: 'refused', reason: 'scene-swap', message: 'Play refused — a scene load is still in flight.' });
    await pressPlay();
    expect(toast()).toMatchObject({ message: 'Play refused — a scene load is still in flight.', kind: 'warn' });
  });

  it('a started ▶ raises nothing', async () => {
    h.play = async () => ({ kind: 'started' });
    await pressPlay();
    expect(toast()).toBeNull();
  });

  it('a ⏹ that skipped its revert raises the reason', async () => {
    h.stop = async () => ({ kind: 'stopped', reverted: false, reason: 'the scene changed during Play' });
    await pressStop();
    expect(toast()).toMatchObject({ message: 'Stopped without reverting — the scene changed during Play.', kind: 'warn' });
  });

  it('a ⏹ whose restore THROWS resolves (no unhandled rejection) and tells the human', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.stop = async () => { throw new Error('reload failed'); };
    await expect(pressStop()).resolves.toBeUndefined();
    expect(toast()?.kind).toBe('warn');
    expect(toast()?.message).toContain('Stop could not restore the authored world (reload failed)');
    expect(err).toHaveBeenCalled();
  });

  it('a ▶ that THROWS resolves and tells the human', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    h.play = async () => { throw new Error('serialize failed'); };
    await expect(pressPlay()).resolves.toBeNull();
    expect(toast()).toMatchObject({ message: 'Play failed to start (serialize failed).', kind: 'warn' });
  });
});
