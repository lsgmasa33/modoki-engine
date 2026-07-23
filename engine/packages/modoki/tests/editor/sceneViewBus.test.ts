// @vitest-environment jsdom
/** sceneViewBus — the cross-panel registry that replaced the old window.__sceneView* globals
 *  (editor-sceneview F14). These tests pin the contract a real-browser e2e depends on:
 *  the editor camera is mirrored onto `window.__sceneViewCamera` for debug/e2e poking, AND
 *  that mirror is DELETED on cleanup (the dangling-reference bug F14 was about). Removing the
 *  mirror "because it's a global" must turn THIS red, not slip past unit tests to the e2e. */
import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import {
  setEditorViewportCamera, getEditorViewportCamera,
  setFocusEntityHandler, focusEntityInSceneView,
  setViewportController, snapEditorViewToAxis, toggleEditorProjection, getEditorProjection,
  type ViewportController,
} from '../../src/editor/scene/sceneViewBus';

const winCam = () => (window as unknown as { __sceneViewCamera?: THREE.Camera }).__sceneViewCamera;

describe('sceneViewBus — editor camera registry (F14)', () => {
  beforeEach(() => setEditorViewportCamera(null)); // reset module-level state between cases

  it('exposes the camera via getEditorViewportCamera AND mirrors it onto window.__sceneViewCamera', () => {
    const cam = new THREE.PerspectiveCamera();
    setEditorViewportCamera(cam);
    expect(getEditorViewportCamera()).toBe(cam);
    // The e2e (editor-hierarchy "F key frames…") pokes this handle directly — keep it.
    expect(winCam()).toBe(cam);
  });

  it('DELETES the window mirror on cleanup so no panel holds a disposed-camera ref', () => {
    setEditorViewportCamera(new THREE.PerspectiveCamera());
    expect(winCam()).toBeDefined();
    setEditorViewportCamera(null); // SceneView cleanup path
    expect(getEditorViewportCamera()).toBeNull();
    expect('__sceneViewCamera' in window).toBe(false); // deleted, not just set undefined
  });
});

describe('sceneViewBus — focus-entity command (F14)', () => {
  beforeEach(() => setFocusEntityHandler(() => {})); // overwrite any prior handler

  it('routes focusEntityInSceneView to the registered handler', () => {
    let got = -1;
    setFocusEntityHandler((id) => { got = id; });
    focusEntityInSceneView(42);
    expect(got).toBe(42);
  });

  it('unregister only clears the live handler — a stale remount cleanup cannot clobber it', () => {
    const calls: string[] = [];
    const unregisterA = setFocusEntityHandler(() => calls.push('A'));
    setFocusEntityHandler(() => calls.push('B')); // B is now live (a "remount")
    unregisterA(); // A's stale cleanup must NOT remove B
    focusEntityInSceneView(1);
    expect(calls).toEqual(['B']);
  });
});

describe('sceneViewBus — viewport orientation controller (SceneViewGizmo)', () => {
  // No public reset for the controller, so each case installs its own and unregisters; the
  // "no viewport mounted" case runs first via an explicit unregister.
  const mkCtrl = (over: Partial<ViewportController> = {}): { ctrl: ViewportController; calls: unknown[][] } => {
    const calls: unknown[][] = [];
    const ctrl: ViewportController = {
      snapToAxis: (d) => calls.push(['snap', d.x, d.y, d.z]),
      toggleProjection: () => calls.push(['toggle']),
      getProjection: () => 'perspective',
      ...over,
    };
    return { ctrl, calls };
  };

  it('returns false / null when no viewport controller is registered', () => {
    const { ctrl } = mkCtrl();
    setViewportController(ctrl)(); // register then immediately unregister → none live
    expect(snapEditorViewToAxis(new THREE.Vector3(0, 1, 0))).toBe(false);
    expect(toggleEditorProjection()).toBe(false);
    expect(getEditorProjection()).toBeNull();
  });

  it('fires each command through to the registered controller', () => {
    const { ctrl, calls } = mkCtrl({ getProjection: () => 'orthographic' });
    const un = setViewportController(ctrl);
    expect(snapEditorViewToAxis(new THREE.Vector3(0, 1, 0))).toBe(true);
    expect(calls[0]).toEqual(['snap', 0, 1, 0]);
    expect(toggleEditorProjection()).toBe(true);
    expect(calls[1]).toEqual(['toggle']);
    expect(getEditorProjection()).toBe('orthographic');
    un();
  });

  it('unregister only clears the live controller — a stale remount cleanup cannot clobber it', () => {
    const { ctrl: A } = mkCtrl({ getProjection: () => 'perspective' });
    const { ctrl: B } = mkCtrl({ getProjection: () => 'orthographic' });
    const unA = setViewportController(A);
    setViewportController(B); // B is live (a "remount")
    unA();                    // A's stale cleanup must NOT remove B
    expect(getEditorProjection()).toBe('orthographic');
  });

  it('unregister nulls the controller so later commands no-op', () => {
    const { ctrl } = mkCtrl();
    const un = setViewportController(ctrl);
    un();
    expect(getEditorProjection()).toBeNull();
    expect(snapEditorViewToAxis(new THREE.Vector3(1, 0, 0))).toBe(false);
  });
});
