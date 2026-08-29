/** The `set-animation-view-mode` agent op — the renderer side of `modoki_animation_view_mode` (#369).
 *
 *  WHY THE OP VALIDATES, when its neighbour `set-scene-view-mode` does not. That op silently drops
 *  an unrecognised mode and returns a state read, so a bad call is indistinguishable from a good
 *  one. Here that would be worse than usual: the two Animation views publish DIFFERENT interaction
 *  handles, and the tangent handles (`curves:tan:in|out:*`) live in Curves alone — so a typo'd
 *  `'curve'` reporting success leaves the caller reading an empty `modoki_handles editor=curves`
 *  as "this clip has no tangents" rather than "the view never switched".
 *
 *  This tier is the ONLY automated cover for the refusal. The MCP tool's `z.enum` rejects a bad
 *  mode before the request is made, so neither the live smoke case nor the stub-backend tier can
 *  reach the op's own guard — but `/api/editor-action` is a raw POST route that does. */

import { describe, it, expect, beforeEach } from 'vitest';
import { useEditorStore } from '@modoki/engine/editor';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { registerEditorAgentOps } from '../../app/editor/agentEditorOps';
import { runAgentOp } from '../../app/debug/agentBridge';

registerAllTraits();
registerEditorAgentOps();

type AnimView = { mode: 'dopesheet' | 'curves'; panelMounted: boolean; panelNote?: string; tangentsNeedActiveTrack?: string };
type Reply = {
  ok: boolean; error?: string; options?: string[];
  animationViewMode: 'dopesheet' | 'curves'; animationView?: AnimView;
};
const setView = (mode?: unknown) =>
  runAgentOp('set-animation-view-mode', mode === undefined ? {} : { mode }) as Promise<Reply>;

beforeEach(() => {
  useEditorStore.setState({ animationViewMode: 'dopesheet', animationPanelMounted: false });
});

describe('set-animation-view-mode', () => {
  it('switches the view and reports it back', async () => {
    const r = await setView('curves');
    expect(r).toMatchObject({ ok: true, animationViewMode: 'curves' });
    // Read the STORE too, not just the reply: an op that built its own answer without reaching
    // the store would satisfy the line above and leave the panel exactly where it was.
    expect(useEditorStore.getState().animationViewMode).toBe('curves');
  });

  it('switches back, so both arms are exercised', async () => {
    useEditorStore.getState().setAnimationViewMode('curves');
    const r = await setView('dopesheet');
    expect(r).toMatchObject({ ok: true, animationViewMode: 'dopesheet' });
    expect(useEditorStore.getState().animationViewMode).toBe('dopesheet');
  });

  it('REFUSES an unknown mode and leaves the view untouched', async () => {
    useEditorStore.getState().setAnimationViewMode('curves');
    const r = await setView('curve');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('dopesheet');
    expect(r.options).toEqual(['dopesheet', 'curves']);
    // The half-applied case is the damaging one: the caller could not tell which they got.
    expect(useEditorStore.getState().animationViewMode).toBe('curves');
  });

  it('REFUSES a missing mode rather than defaulting to one', async () => {
    // Defaulting would silently move the human's panel on a malformed call — and 'dopesheet',
    // the natural default, is precisely the view that hides the tangent handles.
    useEditorStore.getState().setAnimationViewMode('curves');
    const r = await setView();
    expect(r.ok).toBe(false);
    expect(useEditorStore.getState().animationViewMode).toBe('curves');
  });

  it('a refusal carries the CURRENT view, so the caller need not spend a second call', async () => {
    useEditorStore.getState().setAnimationViewMode('curves');
    const r = await setView(42);
    expect(r.ok).toBe(false);
    expect(r.animationViewMode).toBe('curves');
  });

  it("reports panelMounted, so ok:true cannot mean 'a view is showing' when none is", async () => {
    // The #367 lesson applied one panel over: FlexLayout mounts only the SELECTED tab, so an
    // Animation tab that exists in the layout but was never clicked does not mount — and then
    // NEITHER view registers a handle provider. Reporting the mode alone would answer
    // `curves` for an editor showing no Animation view at all, which is the readiness lie.
    const r = await setView('curves');
    expect(r.ok).toBe(true);
    expect(r.animationView?.mode).toBe('curves');
    expect(r.animationView?.panelMounted).toBe(false);
    expect(r.animationView?.panelNote).toContain('NOT mounted');

    useEditorStore.getState().setAnimationPanelMounted(true);
    const r2 = await setView('dopesheet');
    expect(r2.animationView?.panelMounted).toBe(true);
    expect(r2.animationView?.panelNote).toBeUndefined();
  });

  it('warns, in curves ONLY, that tangent handles need an active track as well', async () => {
    // The defect the close-out review caught: switching to curves is necessary and NOT
    // sufficient. CurvesView publishes tangents for the ACTIVE track only, and with nothing
    // selected that resolves only when exactly one numeric curve is visible — measured live,
    // a 1-track clip gave 2 tangents and a 2-track clip in the same view gave 0. Without this
    // note the empty list reads as "this clip has no tangents".
    const curves = await setView('curves');
    expect(curves.animationView?.tangentsNeedActiveTrack).toContain('ACTIVE');
    expect(curves.animationView?.tangentsNeedActiveTrack).toContain('animation.trackList.row');
    // Absent in dopesheet, where there are no tangent handles for it to be about.
    const dope = await setView('dopesheet');
    expect(dope.animationView?.tangentsNeedActiveTrack).toBeUndefined();
  });

  it('the read-back route reports it too', async () => {
    await setView('curves');
    const state = await runAgentOp('editor-state', {}) as { animationViewMode: string; animationView: AnimView };
    // The whole point of the field: an agent must be able to ANSWER "which view am I in?"
    // without a screenshot, because an empty handle list cannot answer it.
    expect(state.animationViewMode).toBe('curves');
    // And the qualified twin, which is what makes the empty list DIAGNOSABLE rather than just
    // attributable — the flat scalar cannot say "no view is mounted".
    expect(state.animationView.mode).toBe('curves');
    expect(state.animationView.panelMounted).toBe(false);
  });
});
