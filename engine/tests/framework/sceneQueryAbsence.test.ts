/** `classifyWorldAbsence` (#1260) — which "no physics world" this is, and whether retrying helps.
 *  Pure, so the branches a headless suite cannot drive (a permanent Rapier load failure, a build with
 *  the module stripped) are pinned here; `sceneQueryOp.test.ts` covers the op wiring. */

import { describe, it, expect } from 'vitest';
import { classifyWorldAbsence, type AbsenceInput } from '../../app/debug/sceneQueryAbsence';

const base: AbsenceInput = { dim: '3d', hasBodies: true, moduleInBuild: true, playState: 'playing', rapier: { state: 'ready' } };
const reasonOf = (over: Partial<AbsenceInput>) => classifyWorldAbsence({ ...base, ...over });

describe('classifyWorldAbsence', () => {
  it('no bodies outranks everything — no play state or retry can build a world', () => {
    expect(reasonOf({ hasBodies: false, playState: 'stopped', rapier: { state: 'failed', error: 'x' } }).reason).toBe('no-bodies');
  });

  it('a build without the module never builds a world, and does not say retry', () => {
    const a = reasonOf({ moduleInBuild: false });
    expect(a.reason).toBe('no-physics-module');
    expect(a.hint).not.toMatch(/retry/i);
  });

  it('stopped says start the sim, even while Rapier is loading', () => {
    const a = reasonOf({ playState: 'stopped', rapier: { state: 'loading' } });
    expect(a.reason).toBe('stopped');
    expect(a.hint).toMatch(/start the sim/i);
  });

  it('a permanent load failure says retrying cannot help, and names the error', () => {
    const a = reasonOf({ rapier: { state: 'failed', error: '[physics3D] WASM 404' } });
    expect(a.reason).toBe('physics-failed');
    expect(a.hint).toContain('WASM 404');
    expect(a.hint).toMatch(/cannot help/);
  });

  it('still loading and not yet ticked are the two retryable answers', () => {
    expect(reasonOf({ rapier: { state: 'loading' } }).reason).toBe('physics-loading');
    const a = reasonOf({});
    expect(a.reason).toBe('not-built-yet');
    expect(a.hint).toMatch(/retry after a frame/i);
    expect(a.hint).not.toMatch(/start the sim/i);
    expect(reasonOf({ playState: 'paused' }).reason).toBe('not-built-yet');
  });

  it('names the dimension it was asked about', () => {
    expect(reasonOf({ dim: '2d', hasBodies: false }).hint).toContain('RigidBody2D');
  });
});
