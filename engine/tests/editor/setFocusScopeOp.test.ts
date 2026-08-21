/** The `set-focus-scope` agent op — the RENDERER side of the panel guard (#301).
 *
 *  This op used to hand its `panel` param straight to `setFocusedPanel`, which is a bare
 *  `set()`. It therefore stored ANY string and echoed it back, which had two consequences:
 *
 *   1. `modoki_focus {panel:"Game"}` answered `{ok:true, focusedPanel:"Game"}` — but the
 *      editor's game-input gate compares against `'game'`, so it stayed SHUT and every
 *      following `modoki_press_key` reached nothing, each also reporting ok. That is the
 *      QA-PHYS-0003 symptom (80 presses, all ok, a character controller wrongly declared
 *      broken) reached by a second route: there the panel was forgotten, here a wrong value
 *      is accepted.
 *   2. `/api/input/key`'s `focusedPanel !== panel` guard could never fire, because the echo
 *      always equalled the input. Its "is that panel open?" message promised a check that
 *      did not exist. That route's half is covered in electron/inputRoutes.test.ts; this
 *      file pins the half that actually knows which panels are open.
 *
 *  Refusal is on OPEN-NESS rather than a fixed id list on purpose — a game can register
 *  custom panels, so no enum could be right, and open-ness is what the error message
 *  already claimed. */

import { describe, it, expect, beforeEach } from 'vitest';
import { useEditorStore } from '@modoki/engine/editor';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { registerEditorAgentOps } from '../../app/editor/agentEditorOps';
import { runAgentOp } from '../../app/debug/agentBridge';

registerAllTraits();
registerEditorAgentOps();

type Reply = { ok: boolean; error?: string; focusedPanel: string | null; openPanels: string[] };
const setScope = (panel: string | null | undefined) =>
  runAgentOp('set-focus-scope', panel === undefined ? {} : { panel }) as Promise<Reply>;

beforeEach(() => {
  useEditorStore.getState().setOpenPanels(['scene', 'game', 'hierarchy']);
  useEditorStore.setState({ focusedPanel: null });
});

describe('set-focus-scope: only an OPEN panel may take the keyboard scope', () => {
  it('accepts an open panel', async () => {
    const r = await setScope('game');
    expect(r).toMatchObject({ ok: true, focusedPanel: 'game' });
    expect(useEditorStore.getState().focusedPanel).toBe('game');
  });

  it('REFUSES a miscased id and leaves the scope untouched', async () => {
    // The #301 failure exactly. Note what is asserted second: a half-applied focus would be
    // worse than none, because the caller could not tell which it got.
    useEditorStore.getState().setFocusedPanel('hierarchy');
    const r = await setScope('Game');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('no open panel "Game"');
    expect(r.error).toContain('case-sensitive');
    expect(r.focusedPanel).toBe('hierarchy');
    expect(useEditorStore.getState().focusedPanel).toBe('hierarchy');
  });

  it('REFUSES a real panel id that has no open tab', async () => {
    // 'profiler' is in PANEL_LABELS, so a vocabulary-only check would have waved it through
    // — and the scope would then name a panel whose bindings are unregistered.
    const r = await setScope('profiler');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('no open panel "profiler"');
    expect(useEditorStore.getState().focusedPanel).toBeNull();
  });

  it('names the open panels on a refusal, so the caller can recover in one round trip', async () => {
    const r = await setScope('nope');
    expect(r.openPanels).toEqual(['game', 'hierarchy', 'scene']);
  });

  it('accepts a CUSTOM panel id once it is open', async () => {
    // Games register their own panels (docs/agent-tools.md), which is why the vocabulary
    // cannot be a z.enum in the tool schema and the refusal has to live here.
    useEditorStore.getState().setOpenPanels(['scene', 'court-levels']);
    const r = await setScope('court-levels');
    expect(r).toMatchObject({ ok: true, focusedPanel: 'court-levels' });
  });

  it('REFUSES a NON-STRING panel instead of storing it', async () => {
    // Reachable, not theoretical: `set-focus-scope` is on the `/api/editor-action` allowlist,
    // so `{action:'set-focus-scope', panel:12345}` reaches this op without passing the MCP
    // tool's `z.string()`. Measured on a live editor before the fix: ok:true, and
    // `get_editor_state.focusedPanel` then reported the NUMBER 12345 — which the input gate
    // (`p !== null && p !== 'game'`) reads as "some panel owns the keyboard", suppressing all
    // game input permanently with no panel to blame.
    useEditorStore.getState().setFocusedPanel('scene');
    const r = await runAgentOp('set-focus-scope', { panel: 12345 }) as Reply;
    expect(r.ok).toBe(false);
    expect(r.error).toContain('must be a string');
    expect(useEditorStore.getState().focusedPanel).toBe('scene');
  });

  it('allows null — clearing the scope names no panel', async () => {
    useEditorStore.getState().setFocusedPanel('scene');
    const r = await setScope(null);
    expect(r.ok).toBe(true);
    expect(useEditorStore.getState().focusedPanel).toBeNull();
  });

  it('is a pure READ when no panel is given', async () => {
    useEditorStore.getState().setFocusedPanel('scene');
    const r = await setScope(undefined);
    expect(r).toMatchObject({ ok: true, focusedPanel: 'scene' });
  });

  it('reports openPanels sorted and de-duplicated by the store', async () => {
    // Two tabs of the same component make the layout walk emit a duplicate; the store
    // normalises so the agent-facing list does not depend on tab order.
    useEditorStore.getState().setOpenPanels(['hierarchy', 'scene', 'scene']);
    const r = await setScope('scene');
    expect(r.openPanels).toEqual(['hierarchy', 'scene']);
  });
});
