/** #994 — `render-scene` refuses with a §5 CODE when no 3D surface is mounted, instead of
 *  throwing.
 *
 *  Why the code and not the prose: a thrown Error reaches the relay routes, which turn any throw
 *  into a hard-coded 504 (a 500 on the Electron host). The MCP client maps that to
 *  `NOT_AVAILABLE_HERE` — "could not look: the route is absent" — so an ORDINARY editor state (an
 *  project built without the 3D renderer module; a Game tab never opened this session) was reported
 *  to the agent as a dead tool, and to `test:mcp:live` as a DEFECT. `NO_RENDERER` is already in
 *  that sweep's `ENV_CODES`, which is why the harness needed no change.
 *
 *  The ACCEPT side is the half that matters: with a renderer registered the op must still RENDER.
 *  A guard that refuses unconditionally would satisfy every refusal assertion here and break the
 *  tool completely. */

import { describe, it, expect, afterEach } from 'vitest';
import { registerSceneRenderer, unregisterSceneRenderer, hasSceneRenderer } from '@modoki/engine/runtime';
import { runAgentOp } from '../../app/debug/agentBridge';

type Refusal = { ok?: boolean; code?: string; error?: string; options?: string[] };

const FRAME = { width: 4, height: 4, dataUrl: 'data:image/jpeg;base64,/9j/4AAQ' };

let registered: ((opts: unknown) => Promise<typeof FRAME>) | null = null;
afterEach(() => {
  if (registered) unregisterSceneRenderer(registered as never);
  registered = null;
});

describe('render-scene refuses NO_RENDERER rather than throwing (#994)', () => {
  it('with no renderer mounted, answers a §5 envelope — not a rejection', async () => {
    expect(hasSceneRenderer()).toBe(false);
    const r = await runAgentOp('render-scene', {}) as Refusal;
    expect(r.ok).toBe(false);
    expect(r.code).toBe('NO_RENDERER');
  });

  it('the refusal says WHY in the editor\'s own terms, and never blames the route', async () => {
    const r = await runAgentOp('render-scene', {}) as Refusal;
    // The failure this fixes is an agent reading "route absent" and relaunching a healthy editor.
    expect(r.error).toMatch(/Scene3D/i);
    expect(r.error).toMatch(/NOT a missing route/i);
    expect(r.error).toMatch(/NOT a wedged editor/i);
  });

  it('`options` point at a field that ANSWERS this question — `surfaces`, not `panelMounted`', async () => {
    const r = await runAgentOp('render-scene', {}) as Refusal;
    const options = r.options ?? [];
    expect(options.length).toBeGreaterThan(0);
    // `surfaces` lists `game-3d` exactly when a renderer is registered: Scene3D is the repo's only
    // `registerSceneRenderer` caller and registers the bounds provider in the same effect.
    expect(options.join(' ')).toMatch(/surfaces/);
    // get_scene_state is the real "I still need the answer" exit: it needs no renderer at all.
    expect(options.join(' ')).toMatch(/get_scene_state/);
    // ⚠️ MEASURED, not assumed (work-qa editor, games/3d-test, 2026-09-09): panelMounted was FALSE
    // while surfaces listed game-3d and render-scene returned a frame. A refusal citing it would
    // send the reader to a field that does not answer this question — the same defect one layer up.
    expect(JSON.stringify(r)).not.toMatch(/panelMounted/);
  });

  it('ACCEPT SIDE — with a renderer registered it RENDERS, and forwards the caller\'s options', async () => {
    let seen: unknown;
    registered = async (opts: unknown) => { seen = opts; return FRAME; };
    registerSceneRenderer(registered as never, 'test-surface');
    const r = await runAgentOp('render-scene', { width: 4, height: 4, quality: 50 }) as
      Refusal & { dataUrl?: string; surface?: string };
    expect(r.ok).not.toBe(false);
    expect(r.code).toBeUndefined();
    expect(r.dataUrl).toBe(FRAME.dataUrl);
    expect(r.surface).toBe('test-surface');
    expect(seen).toMatchObject({ width: 4, height: 4, quality: 50 });
  });
});
