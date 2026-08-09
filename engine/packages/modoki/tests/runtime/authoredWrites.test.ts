/** authoredWrites — the dependency-free recorder itself: dedupe/count on repeat writes to the
 *  same (entity, trait, field) key, the MAX_RECORDS cap dropping only NEW keys past it, and
 *  clear resetting both the records and the drop counter. The write-site integration
 *  (`writeTraitField`'s three-condition gate) is covered separately in
 *  authoredWriteProbe.test.ts — this file is a pure unit test of the recorder's own bookkeeping. */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  noteAuthoredWriteWhileStopped,
  getAuthoredWritesWhileStopped,
  clearAuthoredWritesWhileStopped,
} from '../../src/runtime/core/ecs/authoredWrites';

describe('authoredWrites recorder', () => {
  beforeEach(() => {
    clearAuthoredWritesWhileStopped();
  });

  it('records a new (entity, trait, field) key once', () => {
    noteAuthoredWriteWhileStopped(1, 'Enemy', 'Transform', 'x');
    const { records, dropped } = getAuthoredWritesWhileStopped();
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual({ entityId: 1, name: 'Enemy', trait: 'Transform', field: 'x', count: 1 });
    expect(dropped).toBe(0);
  });

  it('dedupes a repeat write to the same key, bumping count instead of adding a record', () => {
    noteAuthoredWriteWhileStopped(1, 'Enemy', 'Transform', 'x');
    noteAuthoredWriteWhileStopped(1, 'Enemy', 'Transform', 'x');
    noteAuthoredWriteWhileStopped(1, 'Enemy', 'Transform', 'x');
    const { records } = getAuthoredWritesWhileStopped();
    expect(records).toHaveLength(1);
    expect(records[0].count).toBe(3);
  });

  it('keys on (entityId, trait, field) — a different field or trait or entity is a distinct record', () => {
    noteAuthoredWriteWhileStopped(1, 'Enemy', 'Transform', 'x');
    noteAuthoredWriteWhileStopped(1, 'Enemy', 'Transform', 'y');
    noteAuthoredWriteWhileStopped(1, 'Enemy', 'Health', 'x');
    noteAuthoredWriteWhileStopped(2, 'Enemy', 'Transform', 'x');
    const { records } = getAuthoredWritesWhileStopped();
    expect(records).toHaveLength(4);
  });

  it('caps at MAX_RECORDS=200 distinct keys, incrementing dropped for new keys past the cap', () => {
    for (let i = 0; i < 200; i++) {
      noteAuthoredWriteWhileStopped(i, `Entity${i}`, 'Transform', 'x');
    }
    let { records, dropped } = getAuthoredWritesWhileStopped();
    expect(records).toHaveLength(200);
    expect(dropped).toBe(0);

    // 201st DISTINCT key — dropped, not recorded.
    noteAuthoredWriteWhileStopped(200, 'Entity200', 'Transform', 'x');
    ({ records, dropped } = getAuthoredWritesWhileStopped());
    expect(records).toHaveLength(200);
    expect(dropped).toBe(1);

    // A few more distinct keys past the cap keep bumping dropped.
    noteAuthoredWriteWhileStopped(201, 'Entity201', 'Transform', 'x');
    noteAuthoredWriteWhileStopped(202, 'Entity202', 'Transform', 'x');
    ({ records, dropped } = getAuthoredWritesWhileStopped());
    expect(records).toHaveLength(200);
    expect(dropped).toBe(3);
  });

  it('a repeat write to an ALREADY-recorded key still counts past the cap (only new keys are dropped)', () => {
    for (let i = 0; i < 200; i++) {
      noteAuthoredWriteWhileStopped(i, `Entity${i}`, 'Transform', 'x');
    }
    noteAuthoredWriteWhileStopped(999, 'Overflow', 'Transform', 'x'); // dropped: new key past cap
    expect(getAuthoredWritesWhileStopped().dropped).toBe(1);

    // Repeat write to key 0 (already recorded, under the cap) — still increments its count,
    // and does NOT touch `dropped`.
    noteAuthoredWriteWhileStopped(0, 'Entity0', 'Transform', 'x');
    const { records, dropped } = getAuthoredWritesWhileStopped();
    const rec0 = records.find((r) => r.entityId === 0)!;
    expect(rec0.count).toBe(2);
    expect(dropped).toBe(1);
  });

  it('clear resets both the records and the dropped counter', () => {
    for (let i = 0; i < 201; i++) {
      noteAuthoredWriteWhileStopped(i, `Entity${i}`, 'Transform', 'x');
    }
    expect(getAuthoredWritesWhileStopped().dropped).toBe(1);

    clearAuthoredWritesWhileStopped();
    const { records, dropped } = getAuthoredWritesWhileStopped();
    expect(records).toHaveLength(0);
    expect(dropped).toBe(0);
  });
});
