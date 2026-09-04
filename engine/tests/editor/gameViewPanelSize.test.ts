/** `describeGameView`'s `panelSize` contract — the COLLAPSED case (#688).
 *
 *  The field's own doc block in `agentEditorOps.ts` has now been wrong three times in the same
 *  direction, and each wrong version was a number reported with authority that nothing had
 *  measured. This tier pins the third: a Game panel that is mounted but collapsed to zero area.
 *
 *  Why an omission is asserted rather than a floor. Matching `GameView.tsx`'s sibling observer
 *  (skip a zero, keep the last good size) would answer with a STALE extent presented as a live
 *  one — by this doc block's own standard the worse of the two failures. So `panelSize` is
 *  omitted and a `panelNote` explains it, reusing the shape already proven for `panelMounted:
 *  false`. These tests fail if anyone "fixes" it back into a floor, because a floor would make
 *  `panelSize` present again.
 *
 *  Note the store's own default is `{width: 0, height: 0}` — so a COLD editor whose Game tab has
 *  mounted but never been measured hits this path too, not just a dragged-flat splitter. */

import { describe, it, expect, beforeEach } from 'vitest';
import { useEditorStore } from '@modoki/engine/editor';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { registerEditorAgentOps } from '../../app/editor/agentEditorOps';
import { runAgentOp } from '../../app/debug/agentBridge';

registerAllTraits();
registerEditorAgentOps();

type GameView = {
  free: boolean;
  panelMounted: boolean;
  panelSize?: { w: number; h: number };
  panelNote?: string;
};
const readGameView = async () =>
  ((await runAgentOp('editor-state', {})) as { gameView: GameView }).gameView;

beforeEach(() => {
  useEditorStore.setState({ gameViewMounted: true, gameAreaSize: { width: 640, height: 360 } });
});

describe('describeGameView panelSize (#688)', () => {
  it('reports a real measured area', async () => {
    const gv = await readGameView();
    expect(gv.free).toBe(true); // the default preset is FREE_PRESET; panelSize is free-only
    expect(gv.panelMounted).toBe(true);
    expect(gv.panelSize).toEqual({ w: 640, h: 360 });
    expect(gv.panelNote).toBeUndefined();
  });

  it('OMITS panelSize when the panel is mounted but collapsed, and says why', async () => {
    // The defect: this answered `panelSize: {0,0}` with `panelMounted: true` and NO note, so an
    // agent sizing a capture or explaining a refused aim acted on "the panel is zero pixels
    // wide" rather than "the panel is collapsed".
    useEditorStore.setState({ gameAreaSize: { width: 0, height: 0 } });
    const gv = await readGameView();
    expect(gv.panelMounted).toBe(true); // collapsed is NOT unmounted — this stays honestly true
    expect(gv.panelSize).toBeUndefined();
    expect(gv.panelNote).toContain('COLLAPSED');
  });

  it('treats a single collapsed AXIS the same way — a zero width is as unusable as a zero area', async () => {
    // A splitter dragged flat in one direction only. `fitScale`-style consumers divide by both,
    // so half a measurement is not a usable one.
    useEditorStore.setState({ gameAreaSize: { width: 0, height: 360 } });
    expect((await readGameView()).panelSize).toBeUndefined();
    useEditorStore.setState({ gameAreaSize: { width: 640, height: 0 } });
    expect((await readGameView()).panelSize).toBeUndefined();
  });

  it('keeps the two notes DISTINCT — unmounted and collapsed are different repairs', async () => {
    // Unmounted: select the tab. Collapsed: drag the splitter open. An agent handed the wrong
    // one of those does the wrong thing and reports the panel as broken.
    useEditorStore.setState({ gameViewMounted: false, gameAreaSize: { width: 0, height: 0 } });
    const unmounted = await readGameView();
    expect(unmounted.panelNote).toContain('NOT mounted');
    expect(unmounted.panelSize).toBeUndefined();

    useEditorStore.setState({ gameViewMounted: true });
    const collapsed = await readGameView();
    expect(collapsed.panelNote).toContain('COLLAPSED');
    expect(collapsed.panelNote).not.toBe(unmounted.panelNote);
  });
});
