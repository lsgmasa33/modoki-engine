/** An ACTION op replies with the fields it changed, not the whole editor state (#1553;
 *  docs/mcp-tool-conventions.md §8).
 *
 *  Seventeen action ops used to spread `readEditorState()` into their reply — ~1.7k chars a call,
 *  10% of all MCP result tax on `play_control` alone, and over `modoki_batch`'s 1,500-char verbatim
 *  cap, so a batch elided the one field its step was run to see. Two guards:
 *
 *  - **The population** — `readEditorState(` may be called only by the full read (`editor-state`),
 *    the `wait_for` editor condition, and `editorStateFields` itself. Scanned from the source so an op
 *    added later that spreads it again goes red without anyone listing that op here.
 *  - **The shape** — the real ops, run headless, answer exactly their own keys. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import {
  createTestWorld, type TestWorld, EntityAttributes, Transform, setPlayState,
} from '@modoki/engine/runtime';
import { clearHistory, markSceneSaved } from '@modoki/engine/editor';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { registerEditorAgentOps, ACTION_HEALTH_KEYS } from '../../app/editor/agentEditorOps';
import { runAgentOp } from '../../app/debug/agentBridge';
import { stripComments, readScannedSource } from '@modoki/engine/testing';
import { assertExemptionLedger } from '@modoki/engine/testing/exemptionLedger';

registerAllTraits();
registerEditorAgentOps();

const OPS_SRC = fileURLToPath(new URL('../../app/editor/agentEditorOps.ts', import.meta.url));

/** Every line of code that calls `readEditorState(` — comments stripped through the shared scanner
 *  (#419), and the paren required, so a mention of the name (a type alias,
 *  `ReturnType<typeof readEditorState>`) is not a call. */
function callLines(code: string): string[] {
  return code.split('\n').filter((l) => /\breadEditorState\(/.test(l)).map((l) => l.trim());
}
/** The same over a raw snippet — the scanner's own accept/refuse tests below. */
const readEditorStateCallLines = (src: string) => callLines(stripComments(src));

/** The four legitimate callers, each SPENT once (`exempt`, count 1) rather than `sanctioned`: a
 *  sanctioned item is skipped however often it occurs, so a new op written as
 *  `const s = readEditorState(); return { ok: true, ...s };` matched the editorStateFields line and
 *  passed (#1553 second review). With a count, a second copy of any line is an offender. */
const CALLERS = [
  { item: 'function readEditorState() {', reason: 'the definition' },
  { item: 'const s = readEditorState();', reason: 'editorStateFields — the one reader action replies go through' },
  { item: "registerAgentOp('editor-state', () => readEditorState());", reason: 'the full read, modoki_get_editor_state' },
  { item: 'editorState: () => readEditorState() as unknown as Record<string, unknown>,', reason: "wait_for's editor condition, which replies with the observed keys only" },
];

describe('readEditorState has no action-op caller (#1553)', () => {
  it('every call site is one of the sanctioned four', () => {
    const lines = callLines(readScannedSource(OPS_SRC).code);
    assertExemptionLedger({
      label: 'readEditorState callers in actionReplyShape',
      population: lines.map((l) => ({ item: l, site: `agentEditorOps.ts: ${l}` })),
      exempt: CALLERS.map((c) => ({ ...c, count: 1 })),
      floor: CALLERS.length,
      fix: 'an op spreads the whole editor state again — reply with editorStateFields(<the fields it changed>) (#1553).',
    });
  });

  // The accept/refuse sides of the scanner itself, so the guard above cannot pass by matching nothing.
  it('the scanner sees a spread call and ignores a mention in a comment or a type', () => {
    expect(readEditorStateCallLines('  return { ...readEditorState(), ok: true };')).toHaveLength(1);
    expect(readEditorStateCallLines('// used to return readEditorState() here')).toEqual([]);
    expect(readEditorStateCallLines('/* readEditorState() */ const x = 1;')).toEqual([]);
    expect(readEditorStateCallLines('type EditorState = ReturnType<typeof readEditorState>;')).toEqual([]);
  });
});

let game: TestWorld;

beforeAll(() => {
  game = createTestWorld({});
  setPlayState('stopped');
  clearHistory();
  markSceneSaved();
  game.spawn(Transform(), EntityAttributes({ name: 'ShapeA', layer: '3d' }));
});

afterAll(() => {
  game.dispose();
});

const keysOf = (reply: unknown) => Object.keys(reply as object).sort();

describe('each action op answers its own fields (#1553)', () => {
  it.each([
    ['set-selection', { guids: [] }, ['ok', 'selection']],
    ['set-gizmo', { mode: 'rotate' }, ['gizmoMode', 'gizmoSpace', 'ok']],
    ['set-scene-view-mode', { mode: 'ui' }, ['ok', 'sceneViewMode']],
    ['set-animation-view-mode', { mode: 'curves' }, ['animationView', 'animationViewMode', 'ok']],
    ['set-collider-edit', { on: false }, ['colliderEditMode', 'ok']],
    ['select-sprite-slice', { guid: null }, ['ok', 'spriteEditorSelection']],
    ['undo', {}, ['did', 'undo', 'unsavedChanges']],
    ['redo', {}, ['did', 'undo', 'unsavedChanges']],
    ['stop', {}, ['advancing', 'ok', 'playState', 'runMode']],
  ] as const)('%s %j', async (op, params, keys) => {
    const reply = await runAgentOp(op, params);
    // The health fields ride on every action reply while unhealthy — and headless, the frame loop and
    // the renderer gate are. Everything ELSE must be exactly the op's own keys.
    const health = new Set<string>(ACTION_HEALTH_KEYS);
    expect(keysOf(reply).filter((k) => !health.has(k))).toEqual([...keys].sort());
  });

  // The health faults are pinned per key in actionReplyHealth.test.ts.

  it('the fields are READ BACK, not echoed — set-gizmo reports the space it did not touch', async () => {
    await runAgentOp('set-gizmo', { space: 'local' });
    const reply = await runAgentOp('set-gizmo', { mode: 'scale' }) as { gizmoMode: string; gizmoSpace: string };
    expect(reply).toMatchObject({ gizmoMode: 'scale', gizmoSpace: 'local' });
  });
});
