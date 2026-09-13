/** #1156 — the agent `set-selection` op is one of the writers that tells the Hierarchy to reveal
 *  the lead row. Re-selecting the entity already selected changes no selection value, so without
 *  its `requestEntityReveal()` call a row collapsed since stays hidden. The Hierarchy side is
 *  pinned in `packages/modoki/tests/editor/hierarchyReveal.test.tsx`; this pins the CALL, through
 *  `runAgentOp` against the real op and store, so dropping it goes red.
 *  Rule: docs/editor.md § Revealing the selected row. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestWorld, type TestWorld, getCurrentWorld, EntityAttributes, Transform } from '@modoki/engine/runtime';
import { useEditorStore } from '@modoki/engine/editor';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { registerEditorAgentOps } from '../../app/editor/agentEditorOps';
import { runAgentOp } from '../../app/debug/agentBridge';

registerAllTraits();
registerEditorAgentOps();

const GUID = '00001156-0000-4000-8000-000000001156';
let game: TestWorld | undefined;
const request = () => useEditorStore.getState().entityRevealRequest;

beforeEach(() => {
  game = createTestWorld({});
  vi.stubGlobal('localStorage', { setItem: () => {}, getItem: () => null, removeItem: () => {} });
  getCurrentWorld().spawn(Transform(), EntityAttributes({ guid: GUID, name: 'RevealProbe' }));
  useEditorStore.setState({ selectedEntityId: null, selectedEntityIds: [], selectedAsset: null });
});
afterEach(() => {
  game?.dispose(); game = undefined;
  vi.unstubAllGlobals();
});

describe('set-selection requests a Hierarchy reveal (#1156)', () => {
  it('re-selecting the entity ALREADY selected still bumps the request', async () => {
    await runAgentOp('set-selection', { guid: GUID });
    const lead = useEditorStore.getState().selectedEntityId;
    expect(lead, 'precondition: the probe resolved and is the lead').not.toBeNull();
    const before = request();
    await runAgentOp('set-selection', { guid: GUID });
    expect(useEditorStore.getState().selectedEntityId, 'the lead did not change').toBe(lead);
    expect(request()).toBe(before + 1);
  });

  it('accept side: a clear and an asset selection do not request an entity reveal', async () => {
    const before = request();
    await runAgentOp('set-selection', {});
    await runAgentOp('set-selection', { asset: { path: '/assets/x.png', type: 'texture', name: 'x.png' } });
    expect(request()).toBe(before);
  });
});
