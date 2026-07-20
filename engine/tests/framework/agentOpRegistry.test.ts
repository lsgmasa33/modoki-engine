/** agentBridge op registry — the dispatch table the bridge transport (Vite HMR
 *  in dev, Electron IPC in the DMG) funnels every request through. The built-in
 *  runtime ops are registered at import; editor ops are injected later via
 *  registerAgentOp (engine/app/editor/agentEditorOps.ts). */

import { describe, it, expect } from 'vitest';
import { registerAgentOp, listAgentOps } from '../../app/debug/agentBridge';

describe('agent op registry', () => {
  it('pre-registers the built-in runtime ops', () => {
    const ops = listAgentOps();
    expect(ops).toContain('scene-state');
    expect(ops).toContain('render-scene');
    expect(ops).toContain('console-logs');
  });

  it('registers the enable-Claude-more runtime ops (journal/dispatch/layout/diagnose/time)', () => {
    const ops = listAgentOps();
    for (const op of ['journal-events', 'dispatch-action', 'game-introspect', 'clear-journal',
      'layout-bounds', 'diagnose', 'set-timescale']) {
      expect(ops).toContain(op);
    }
  });

  it('registerAgentOp adds a new op (editor injection path)', () => {
    expect(listAgentOps()).not.toContain('test-only-op');
    registerAgentOp('test-only-op', () => 42);
    expect(listAgentOps()).toContain('test-only-op');
  });
});
