/** The way out a writer's not-authored refusal names (#1873 addendum): the source's own exit, else "stop Play" or "exit
 *  the preview" — whichever is RUNNING, and only while one is. A restore still landing (or one that failed) reads
 *  'stopped', and its refusal used to tell the user to stop a Play that was not running. One helper, `notAuthoredAdvice`,
 *  for every writer: Create Prefab, Apply, and the prefab-edit save. */
import { describe, it, expect, afterEach } from 'vitest';
import { setRunMode, createTestWorld, Transform, EntityAttributes, type TestWorld } from '@modoki/engine/runtime';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { notAuthoredAdvice, registerPosedWorldSource, whyWorldNotAuthored } from '../../packages/modoki/src/editor/scene/authoredWorld';
import { createPrefabFromEntity } from '../../packages/modoki/src/editor/panels/assetOps';

registerAllTraits();

const LANDING = '#1873 test: a restore is still landing';
let game: TestWorld | undefined;
afterEach(() => {
  registerPosedWorldSource(LANDING, () => false);
  setRunMode('stopped');
  game?.dispose(); game = undefined;
});

describe('notAuthoredAdvice (#1873)', () => {
  // Mutation: return 'exit the preview or stop Play first' whatever the mode (the five sites' old fallback) — the
  // 'stopped' case and the two mode cases go red.
  it('names the running mode, and nothing while stopped', () => {
    registerPosedWorldSource(LANDING, () => true);
    setRunMode('stopped');
    expect(whyWorldNotAuthored()).toBe(LANDING);
    expect(notAuthoredAdvice(LANDING), 'nothing is running to stop').toBeUndefined();
    setRunMode('playing');
    expect(notAuthoredAdvice(whyWorldNotAuthored())).toBe('stop Play first');
    setRunMode('preview');
    expect(notAuthoredAdvice(whyWorldNotAuthored())).toBe('exit the preview first');
    expect(notAuthoredAdvice(null)).toBeUndefined();
  });

  it("a source's own exit wins, whatever the mode", () => {
    registerPosedWorldSource(LANDING, () => true, { exit: 'try again once it lands' });
    setRunMode('stopped');
    expect(notAuthoredAdvice(LANDING)).toBe('try again once it lands');
  });

  // The call site: Create Prefab over a stopped, landing world says the reason and no Play advice.
  // Mutation: `notAuthoredRefusal` goes back to `notAuthoredExit(reason) ?? 'exit the preview / stop Play first'`.
  it('Create Prefab in a stopped world that is not authored names no Play to stop', async () => {
    game = createTestWorld({});
    const r = game.spawn(Transform(), EntityAttributes({ name: 'R', guid: 'g-adv-r' }));
    registerPosedWorldSource(LANDING, () => true);
    setRunMode('stopped');
    const res = await createPrefabFromEntity(r.id(), '/assets/prefabs/A.prefab.json', 'Save prefab "R"', async () => true);
    expect(res).toEqual({ refused: `Create Prefab refused — ${LANDING}.`, notAuthored: LANDING });
  });
});
