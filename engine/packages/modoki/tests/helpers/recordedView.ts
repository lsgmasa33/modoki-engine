/** The override VIEW, stated by a test (#2001 S8b). Every reader of "is this field an override of this instance?" asks
 *  `overrideKeysOf` (`editor/instance/instanceOverrideView.ts`), which reads the instance's record. A test that runs on a
 *  fake ECS (its own traits, a mocked entity index) has no record store, so it states what the record lists here, where
 *  it used to hand-build an override mark. The view itself, read from real records, is covered by the engine suites
 *  (`engine/tests/editor/overrideViewReaders.test.ts`, the fuzz).
 *
 *  Use, in the test file:
 *    vi.mock('../../src/editor/instance/instanceOverrideView', async (orig) =>
 *      (await import('../helpers/recordedView')).withRecordedView(await orig()));
 *  then `record(entity, 'Trait', 'field')`, and `clearRecorded()` in `beforeEach`. */

const recorded = new Map<number, Set<string>>();
const ROTATION = ['Transform.rx', 'Transform.ry', 'Transform.rz'];

/** State that the record lists `trait.field` on live `entity` (rotation as one group, as the view reads it). */
export function record(entity: { id(): number }, trait: string, field: string): void {
  let set = recorded.get(entity.id());
  if (!set) { set = new Set(); recorded.set(entity.id(), set); }
  const key = `${trait}.${field}`;
  for (const k of ROTATION.includes(key) ? ROTATION : [key]) set.add(k);
}

/** State that the record lists nothing on live `entity` (the undo of a write that recorded it). */
export function forget(entity: { id(): number }): void {
  recorded.delete(entity.id());
}

export function clearRecorded(): void {
  recorded.clear();
}

/** The view module with `overrideKeysOf` reading what the test stated. */
export function withRecordedView<T extends object>(actual: T): T {
  return { ...actual, overrideKeysOf: (entity: { id(): number }) => recorded.get(entity.id()) };
}
