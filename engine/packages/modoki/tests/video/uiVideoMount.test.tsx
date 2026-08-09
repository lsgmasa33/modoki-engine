/** `UIVideoMount` — a video played INSIDE a UI node (the "video as scenery" surface).
 *
 *  The behaviour worth pinning is not that it appends an element; it is WHICH host gets it.
 *  There is exactly ONE element per clip and the UI tree can be mounted twice (the editor
 *  renders it into both the Game and Scene panels), so before the priority rule the last host
 *  to tick won by accident — reported as "the video plays only on Scene view, not on the game
 *  view". These drive the real rAF loop against a fake `videoElementFor`. */
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup, act } from '@testing-library/react';

const h = vi.hoisted(() => ({ elementFor: vi.fn((_id: number) => undefined as HTMLVideoElement | undefined) }));
vi.mock('../../src/runtime/video/videoSystem', () => ({
  videoElementFor: (id: number) => h.elementFor(id),
}));

import { UIVideoMount } from '../../src/runtime/video/UIVideoMount';

let el: HTMLVideoElement;

/** Run the components' requestAnimationFrame ticks a few times. */
async function pump(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  }
}

beforeEach(() => {
  el = document.createElement('video');
  h.elementFor.mockReturnValue(el);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const hostOf = (root: HTMLElement) => root.querySelector('[data-modoki-ui-video]') as HTMLElement;

describe('UIVideoMount', () => {
  it('adopts the shared element into its own box and applies the fit', async () => {
    const { container } = render(<UIVideoMount entityId={7} fit="contain" />);
    await pump();
    expect(hostOf(container).contains(el)).toBe(true);
    expect(el.style.objectFit).toBe('contain');
  });

  it('gives the element to the HIGHER-priority host when the tree is mounted twice', async () => {
    // The editor case: the Game panel (priority 1) and the Scene panel (priority 0) both mount
    // the same UI entity. The running game must win regardless of which one ticks last — so the
    // LOSER is deliberately mounted second here. Without the priority rule that ordering is
    // exactly the reported bug (the Scene panel steals it), rather than a coin flip.
    const game = render(<UIVideoMount entityId={7} priority={1} />);
    const scene = render(<UIVideoMount entityId={7} priority={0} />);
    await pump();
    expect(hostOf(game.container).contains(el)).toBe(true);
    expect(hostOf(scene.container).contains(el)).toBe(false);
  });

  it('hands the element back to the loser once the winner unmounts', async () => {
    const scene = render(<UIVideoMount entityId={7} priority={0} />);
    const game = render(<UIVideoMount entityId={7} priority={1} />);
    await pump();
    game.unmount();
    await pump();
    expect(hostOf(scene.container).contains(el)).toBe(true);
  });

  it('drops the element when the handle goes away (Stop / scene swap)', async () => {
    const { container } = render(<UIVideoMount entityId={7} />);
    await pump();
    expect(hostOf(container).contains(el)).toBe(true);
    h.elementFor.mockReturnValue(undefined);
    await pump();
    expect(hostOf(container).contains(el)).toBe(false);
  });

  it('adopts the NEW element after a teardown-and-replay', async () => {
    const { container } = render(<UIVideoMount entityId={7} />);
    await pump();
    h.elementFor.mockReturnValue(undefined);
    await pump();
    const next = document.createElement('video');
    h.elementFor.mockReturnValue(next);
    await pump();
    expect(hostOf(container).contains(next)).toBe(true);
  });

  it('does not stop or clear the element on unmount — videoService owns its lifetime', async () => {
    el.src = 'blob:clip';
    const pause = vi.spyOn(el, 'pause');
    const { unmount } = render(<UIVideoMount entityId={7} />);
    await pump();
    unmount();
    await pump();
    expect(pause).not.toHaveBeenCalled();
    expect(el.src).toBe('blob:clip');
  });
});
