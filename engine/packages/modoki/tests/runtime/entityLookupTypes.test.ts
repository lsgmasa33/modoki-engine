/** #1151 — the three entity lookups return a TYPED koota handle, never `any`.
 *
 *  The per-world indices were `Map<number, any>` / `Map<string, any>`, so `findEntity`,
 *  `findEntityById` and `findEntityByGuid` all inferred `any` and a read of a field a koota handle
 *  does not have compiled. Six undo labels read `findEntity(id)?.name` — always `undefined`, since
 *  `name` lives on `EntityAttributes` — and shipped with typecheck green (#1138).
 *
 *  ⚠️ **The assertion here is the TYPECHECK, not the vitest run.** Each `@ts-expect-error` below
 *  demands a compile error on the next line. If a lookup returns `any` again, that line compiles,
 *  the directive becomes unused, and `tsc -p tsconfig.test.json` (a leg of `npm run verify`) fails
 *  with TS2578. The arrows are never called; vitest only proves the file loads. */
import { describe, it, expect } from 'vitest';
import { findEntity } from '../../src/runtime/core/ecs/entityUtils';
import { findEntityById, findEntityByGuid } from '../../src/runtime/core/ecs/world';

describe('entity lookups are typed, so a field the koota handle lacks does not compile (#1151)', () => {
  it('rejects `.name` on the result of each lookup', () => {
    const reads = [
      // @ts-expect-error — a koota handle has no `name`; it is EntityAttributes.name (#1138)
      () => findEntity(1)?.name,
      // @ts-expect-error — same, through the index read findEntity delegates to
      () => findEntityById(1)?.name,
      // @ts-expect-error — same, through the guid index
      () => findEntityByGuid('g')?.name,
    ];
    expect(reads).toHaveLength(3);
  });
});
