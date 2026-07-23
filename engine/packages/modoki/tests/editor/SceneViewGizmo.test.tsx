// @vitest-environment jsdom
/** Integration (jsdom + @testing-library/react): the SceneViewGizmo corner widget wiring — that
 *  it renders 6 axis cones + the projection hub, that clicking a cone fires snapEditorViewToAxis
 *  with the right world-axis dir, that the hub fires toggleEditorProjection (NOT a snap), that it
 *  reflects the bus projection state, and that its rAF loop re-lays-out when the camera rotates.
 *
 *  The sceneViewBus is mocked (mutable holder via vi.hoisted); sceneViewMath is REAL, so the
 *  projection geometry is the shipping math. The widget lays out inside requestAnimationFrame, so
 *  we shim rAF onto setTimeout and step exactly ONE tick per frame with advanceTimersToNextTimer
 *  (a plain advanceTimersByTime would runaway on the self-rescheduling loop). */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import * as THREE from 'three';

const mock = vi.hoisted(() => ({
  cam: null as THREE.PerspectiveCamera | null,
  projection: 'perspective' as 'perspective' | 'orthographic',
  snapSpy: vi.fn(),
  toggleSpy: vi.fn(),
}));

vi.mock('../../src/editor/scene/sceneViewBus', () => ({
  getEditorViewportCamera: () => mock.cam,
  snapEditorViewToAxis: mock.snapSpy,
  toggleEditorProjection: mock.toggleSpy,
  getEditorProjection: () => mock.projection,
}));

import { SceneViewGizmo } from '../../src/editor/panels/SceneViewGizmo';

/** Advance exactly one rAF tick (the widget re-schedules itself, so step one timer at a time). */
const frame = () => act(() => { vi.advanceTimersToNextTimer(); });
const q = (root: ParentNode, sel: string) => root.querySelector(sel);

beforeEach(() => {
  vi.useFakeTimers();
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => setTimeout(() => cb(0), 0)) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as typeof cancelAnimationFrame;
  mock.cam = new THREE.PerspectiveCamera();
  mock.cam.updateMatrixWorld();
  mock.projection = 'perspective';
  mock.snapSpy.mockClear();
  mock.toggleSpy.mockClear();
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('SceneViewGizmo', () => {
  it('renders 6 axis cones and the projection hub after the first frame', () => {
    const { container } = render(<SceneViewGizmo />);
    frame();
    expect(container.querySelectorAll('[data-ui-id^="sceneview.gizmo.axis."]')).toHaveLength(6);
    expect(q(container, '[data-ui-id="sceneview.gizmo.projection"]')).not.toBeNull();
  });

  it('clicking an axis cone snaps to that world-axis dir', () => {
    const { container } = render(<SceneViewGizmo />);
    frame();
    fireEvent.pointerDown(q(container, '[data-ui-id="sceneview.gizmo.axis.+y"]')!);
    expect(mock.snapSpy).toHaveBeenCalledTimes(1);
    const d = mock.snapSpy.mock.calls[0][0] as THREE.Vector3;
    expect([d.x, d.y, d.z]).toEqual([0, 1, 0]);

    fireEvent.pointerDown(q(container, '[data-ui-id="sceneview.gizmo.axis.-z"]')!);
    const d2 = mock.snapSpy.mock.calls[1][0] as THREE.Vector3;
    expect([d2.x, d2.y, d2.z]).toEqual([0, 0, -1]);
  });

  it('clicking the hub toggles projection and does NOT snap', () => {
    const { container } = render(<SceneViewGizmo />);
    frame();
    fireEvent.pointerDown(q(container, '[data-ui-id="sceneview.gizmo.projection"]')!);
    expect(mock.toggleSpy).toHaveBeenCalledTimes(1);
    expect(mock.snapSpy).not.toHaveBeenCalled();
  });

  it('reflects the bus projection state on the hub (P ↔ O + label)', () => {
    const { container } = render(<SceneViewGizmo />);
    frame();
    const hub = () => q(container, '[data-ui-id="sceneview.gizmo.projection"]')!;
    expect(q(hub(), 'text')!.textContent).toBe('P');

    act(() => { mock.projection = 'orthographic'; vi.advanceTimersToNextTimer(); });
    expect(q(hub(), 'text')!.textContent).toBe('O');
    expect(hub().getAttribute('data-ui-label')).toBe('projection: orthographic');
  });

  it('re-lays-out the tripod when the camera quaternion changes', () => {
    const { container } = render(<SceneViewGizmo />);
    frame();
    const coneX = () => q(container, '[data-ui-id="sceneview.gizmo.axis.+x"] circle')!.getAttribute('cx');
    const before = coneX();
    act(() => {
      mock.cam!.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
      mock.cam!.updateMatrixWorld();
      vi.advanceTimersToNextTimer();
    });
    expect(coneX()).not.toBe(before);
  });
});
