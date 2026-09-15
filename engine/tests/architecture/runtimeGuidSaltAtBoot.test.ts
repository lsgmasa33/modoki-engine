/** The app entry salts runtime-guid generations once per page load (#1223 D5).
 *
 *  `saltRuntimeGuidGeneration` is unit-tested in `packages/modoki/tests/runtime/runtimeGuidSalt.test.ts`,
 *  but nothing there fails when the ONE call that makes it run in the real app is deleted: the headless
 *  harness never runs `app/main.tsx` by design, so it cannot notice. This pins the call itself. It reads
 *  the source with comments stripped, and requires the parenthesised CALL at statement level, so a
 *  comment or a bare import naming the function does not satisfy it. */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { readScannedSource } from '@modoki/engine/testing';

const MAIN = path.resolve(__dirname, '../../app/main.tsx');

describe('app/main.tsx salts runtime-guid generations at boot (#1223 D5)', () => {
  // Mutation: delete the `saltRuntimeGuidGeneration()` statement from app/main.tsx.
  it('calls saltRuntimeGuidGeneration() as a top-level statement', () => {
    const code = readScannedSource(MAIN).code;
    expect(code).toMatch(/^saltRuntimeGuidGeneration\(\)\s*;?\s*$/m);
  });
});
