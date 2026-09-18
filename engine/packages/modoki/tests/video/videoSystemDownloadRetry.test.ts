/** #1397 — a `download`-policy clip whose download failed was sticky until its clip or scene
 *  changed (`failed`), so a network blip blanked the video for the rest of the scene. Owner ruling
 *  2026-09-18 ("retry, still stop on 404"): a TRANSIENT failure — no response, a dropped body, a
 *  status other than 404/410 — backs off and is retried per clip; a 404/410 or a cache REFUSAL
 *  stays sticky. The per-frame reconcile must still never start a download per frame. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createWorld, type World } from 'koota';

const handles: Array<{ url: string }> = [];
vi.mock('../../src/runtime/video/videoService', () => ({
  applyTimeScale: () => {},
  videoFadeGain: () => 1,
  playVideo: (opts: { url: string }) => {
    handles.push({ url: opts.url });
    return {
      element: { currentTime: 0, duration: 10, style: {} } as unknown as HTMLVideoElement,
      play: () => {}, pause: () => {}, seek: () => {}, setVolume: () => {}, setMuted: () => {},
      setRate: () => {}, setLoop: () => {}, setTimeMode: () => {},
      get ended() { return false; }, get playing() { return true; }, get timeMode() { return 'diegetic'; },
      dispose: () => {},
    };
  },
}));

import { VideoPlayer } from '../../src/runtime/traits/VideoPlayer';
import { setPlayState } from '../../src/runtime/core/playState';
import {
  videoSystem, setVideoSourceResolver, setVideoDownloader, __resetVideoSystem,
} from '../../src/runtime/video/videoSystem';
import { setManualNow, advanceManual, restoreRealClock } from '../../src/runtime/core/clock';
import { RETRY_BASE_MS } from '../../src/runtime/core/loadFailureMemo';
import { AssetNetworkError, MissingAssetError } from '../../src/runtime/core/assetLoadErrors';

let world: World;
let download: ReturnType<typeof vi.fn>;
const settle = () => new Promise((r) => setTimeout(r, 0));
async function frames(n: number) { for (let i = 0; i < n; i++) { videoSystem(world); await settle(); } }

beforeEach(() => {
  handles.length = 0;
  __resetVideoSystem();
  setManualNow(0);
  setPlayState('playing');
  setVideoSourceResolver((clip) => ({ url: `https://cdn.test/${clip}.mp4`, policy: 'download', cacheKey: clip }));
  download = vi.fn();
  setVideoDownloader(download as never);
  world = createWorld();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  world.destroy();
  __resetVideoSystem();
  setPlayState('stopped');
  restoreRealClock();
  vi.restoreAllMocks();
});

describe('videoSystem — a failed download is classified before it is remembered (#1397)', () => {
  it('a dropped connection backs off, then retries and plays — was: blank until the clip changed', async () => {
    download.mockRejectedValueOnce(new AssetNetworkError(new TypeError('Failed to fetch')));
    world.spawn(VideoPlayer({ clip: 'intro', autoplay: true }));
    await frames(6);
    expect(download).toHaveBeenCalledTimes(1); // no per-frame storm inside the backoff

    advanceManual(RETRY_BASE_MS);
    download.mockResolvedValueOnce('blob:local-intro');
    await frames(2); // the retry, then the frame that turns its URL into a handle
    expect(download).toHaveBeenCalledTimes(2);
    expect(handles.map((h) => h.url)).toContain('blob:local-intro');
  });

  it('a 5xx is transient too', async () => {
    download.mockResolvedValue('blob:local-intro');
    download.mockRejectedValueOnce(new MissingAssetError('503', { status: 503, absent: false }));
    world.spawn(VideoPlayer({ clip: 'intro', autoplay: true }));
    await frames(2);
    advanceManual(RETRY_BASE_MS);
    await frames(1);
    expect(download).toHaveBeenCalledTimes(2);
  });

  it('a 404 stays blank until the clip changes, however long the session runs', async () => {
    download.mockRejectedValue(new MissingAssetError('404', { status: 404, absent: true }));
    world.spawn(VideoPlayer({ clip: 'intro', autoplay: true }));
    await frames(2);
    advanceManual(60 * 60 * 1000);
    await frames(2);
    expect(download).toHaveBeenCalledTimes(1);
  });

  it('a cache REFUSAL stays blank too — the same bytes would be refused again', async () => {
    download.mockRejectedValue(new Error('video cache refused intro: over budget'));
    world.spawn(VideoPlayer({ clip: 'intro', autoplay: true }));
    await frames(2);
    advanceManual(60 * 60 * 1000);
    await frames(2);
    expect(download).toHaveBeenCalledTimes(1);
  });

  it('entities sharing a clip share ONE download, and its failure is ONE backoff step, not N', async () => {
    const shared = new AssetNetworkError(new TypeError('Failed to fetch'));
    download.mockRejectedValue(shared); // the cache hands every sharer the same rejection
    for (let i = 0; i < 3; i++) world.spawn(VideoPlayer({ clip: 'intro', autoplay: true }));
    await frames(1);
    const before = download.mock.calls.length;
    advanceManual(RETRY_BASE_MS); // one step: retried now, not after 4 s
    await frames(1);
    expect(download.mock.calls.length).toBeGreaterThan(before);
  });
});
