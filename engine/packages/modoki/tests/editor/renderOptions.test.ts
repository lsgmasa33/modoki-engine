/** The render dialog's decisions (#1488): legal values, the output size, where the defaults come
 *  from, and the CLI arguments they become. */

import { describe, it, expect } from 'vitest';
import {
  renderOptionProblems, outputSize, scaleForOutputHeight, initialRenderOptions, renderCliArgs,
  etaSeconds, formatDuration, isAbsolutePath, FALLBACK_RENDER_OPTIONS, type RenderOptions,
} from '../../src/editor/recorder/renderOptions';

const ok: RenderOptions = { fps: 30, scale: 2, format: 'mp4', outDir: null, keepFrames: false };
const VP = { width: 540, height: 960 };

describe('renderOptionProblems', () => {
  it('accepts the fallback', () => {
    expect(renderOptionProblems(FALLBACK_RENDER_OPTIONS)).toEqual([]);
  });

  it('holds the FPS floor at 30 — below it the engine clamps a frame and the video plays slow', () => {
    expect(renderOptionProblems({ ...ok, fps: 29 })).toEqual([expect.stringMatching(/^FPS must be between 30 and 120/)]);
    expect(renderOptionProblems({ ...ok, fps: 30 })).toEqual([]);
    expect(renderOptionProblems({ ...ok, fps: 120 })).toEqual([]);
    expect(renderOptionProblems({ ...ok, fps: 121 })).toHaveLength(1);
    expect(renderOptionProblems({ ...ok, fps: Number.NaN })).toHaveLength(1);
  });

  it('bounds the scale to (0, 4]', () => {
    expect(renderOptionProblems({ ...ok, scale: 0 })).toHaveLength(1);
    expect(renderOptionProblems({ ...ok, scale: 4 })).toEqual([]);
    expect(renderOptionProblems({ ...ok, scale: 4.01 })).toHaveLength(1);
  });

  it('wants an absolute output folder, or none', () => {
    expect(renderOptionProblems({ ...ok, outDir: 'videos' })).toHaveLength(1);
    expect(renderOptionProblems({ ...ok, outDir: '/Users/me/videos' })).toEqual([]);
    expect(renderOptionProblems({ ...ok, outDir: 'C:\\videos' })).toEqual([]);
  });

  it('refuses a malformed request whole — every problem, not the first', () => {
    expect(renderOptionProblems({ fps: '30', scale: -1, format: 'gif', outDir: 3, keepFrames: 'no' })).toHaveLength(5);
    expect(renderOptionProblems(null)).toHaveLength(5);
  });
});

describe('isAbsolutePath', () => {
  it('knows posix, drive and UNC paths', () => {
    expect(isAbsolutePath('/a')).toBe(true);
    expect(isAbsolutePath('D:/a')).toBe(true);
    expect(isAbsolutePath('\\\\host\\share')).toBe(true);
    expect(isAbsolutePath('a/b')).toBe(false);
    expect(isAbsolutePath('C:')).toBe(false);
  });
});

describe('outputSize', () => {
  it('is the layout size times the scale', () => {
    expect(outputSize(VP, 2, 'mp4')).toEqual({ width: 1080, height: 1920 });
    expect(outputSize(VP, 1.5, 'mp4')).toEqual({ width: 810, height: 1440 });
  });

  it('pads an odd H.264 dimension by a pixel — libx264 refuses odd 4:2:0 (a 375×667 take failed)', () => {
    expect(outputSize({ width: 375, height: 667 }, 1, 'mp4')).toEqual({ width: 376, height: 668 });
  });

  it('pads only the width for ProRes 4:2:2', () => {
    expect(outputSize({ width: 375, height: 667 }, 1, 'mov')).toEqual({ width: 376, height: 667 });
  });
});

describe('scaleForOutputHeight', () => {
  it('turns a target height into a scale over the take\'s layout height', () => {
    expect(scaleForOutputHeight(1920, 960)).toBe(2);
    expect(scaleForOutputHeight(1080, 960)).toBe(1.125);
  });
  it('clamps into range, and answers null for nothing usable', () => {
    expect(scaleForOutputHeight(10000, 960)).toBe(4);
    expect(scaleForOutputHeight(0, 960)).toBeNull();
    expect(scaleForOutputHeight(1920, 0)).toBeNull();
  });
});

describe('initialRenderOptions', () => {
  it('falls back when nothing is known', () => {
    expect(initialRenderOptions(null, undefined, VP)).toEqual(FALLBACK_RENDER_OPTIONS);
  });

  it('takes Scale from the project\'s output height when nothing is remembered', () => {
    expect(initialRenderOptions(null, 1080, VP).scale).toBe(1.125);
  });

  it('prefers what the owner last chose in this project over the project setting', () => {
    const o = initialRenderOptions({ scale: 1.5, fps: 60, format: 'mov', keepFrames: true, outDir: '/v' }, 1080, VP);
    expect(o).toEqual({ scale: 1.5, fps: 60, format: 'mov', keepFrames: true, outDir: '/v' });
  });

  it('drops a stale remembered field on its own, keeping the others', () => {
    const o = initialRenderOptions({ fps: 24, format: 'mov' }, 1920, VP);
    expect(o.fps).toBe(30);
    expect(o.format).toBe('mov');
    expect(o.scale).toBe(2);
  });
});

describe('renderCliArgs', () => {
  it('always asks for machine-readable progress and a watched stdin', () => {
    expect(renderCliArgs('/p/t.take.json', ok)).toEqual(['/p/t.take.json', '--ndjson', '--watch-stdin', '--fps', '30', '--scale', '2']);
  });
  it('maps format, frames and folder to their flags', () => {
    const args = renderCliArgs('/p/t.take.json', { fps: 60, scale: 1.5, format: 'mov', outDir: '/out dir', keepFrames: true });
    expect(args).toEqual(['/p/t.take.json', '--ndjson', '--watch-stdin', '--fps', '60', '--scale', '1.5', '--prores', '--keep-frames', '--out', '/out dir']);
  });
});

describe('etaSeconds / formatDuration', () => {
  it('extrapolates the rate so far', () => {
    expect(etaSeconds(100, 400, 50)).toBe(150);
    expect(etaSeconds(0, 400, 5)).toBeNull();
    expect(etaSeconds(10, 0, 5)).toBeNull();
  });
  it('formats m:ss and h:mm:ss', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(184)).toBe('3:04');
    expect(formatDuration(3725)).toBe('1:02:05');
  });
});
