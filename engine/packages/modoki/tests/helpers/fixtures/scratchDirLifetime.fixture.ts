/**
 * Run ONLY as a child vitest process by scratchDir.test.ts. The name does not match any suite
 * `include`, so a normal run never collects it. It creates a scratch dir in each place a suite
 * makes one, records every path to `SCRATCH_REPORT`, and then fails on purpose. The parent then
 * asserts that all of them were removed anyway.
 */
import { appendFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, it, expect } from 'vitest';
import { makeScratchDir } from '../scratchDir';

const report = (where: string, dir: string) => appendFileSync(process.env.SCRATCH_REPORT!, `${where}\t${dir}\n`);

report('module', makeScratchDir('modoki-scratch-fixture-module-'));

// The file's OWN afterAll throwing stops vitest's afterAll chain before the setup file's cleanup
// runs: the KNOWN GAP the parent pins.
if (process.env.SCRATCH_FIXTURE_THROW_AFTERALL) {
  afterAll(() => { throw new Error('deliberate afterAll failure'); });
}

describe('scratch dirs in every lifetime position', () => {
  beforeAll(() => { report('beforeAll', makeScratchDir('modoki-scratch-fixture-beforeall-')); });
  beforeEach(() => { report('beforeEach', makeScratchDir('modoki-scratch-fixture-beforeeach-')); });

  it('passes', () => {
    report('passing', makeScratchDir('modoki-scratch-fixture-pass-'));
    expect(true).toBe(true);
  });

  it('fails before any cleanup of its own could run', () => {
    report('failing', makeScratchDir('modoki-scratch-fixture-fail-'));
    throw new Error('deliberate failure: the dir above must still be removed');
  });
});
