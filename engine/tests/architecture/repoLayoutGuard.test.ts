/**
 * TRIPWIRE for `engine/tests/helpers/repoLayout.ts`.
 *
 * Several tests skip cleanly when private-repo-only content is absent (private agent
 * tooling, the `oss/` publish overlay, real `games/`/`demos/` projects) so the PUBLIC
 * engine snapshot's CI doesn't fail on layout it never ships. That skip is driven by the
 * predicates in `repoLayout.ts` — `hasPrivateTooling()`, `hasOssOverlay()`,
 * `hasRealProjects()`.
 *
 * The danger: if one of those predicates breaks and starts returning `false`
 * everywhere (a wrong path, a moved file, a typo), the tests that gate on it go quiet
 * IN THIS REPO TOO — and a test that never runs looks exactly like a test that passes.
 * That is a far worse failure than the one this whole mechanism exists to avoid.
 *
 * So this asserts the converse: in THIS (private) checkout, every one of those
 * predicates MUST be true. If this test fails, do not "fix" it by loosening a
 * predicate — the predicate is lying, and every test gated on it is silently disabled.
 */
import { describe, it, expect } from 'vitest';
import { hasPrivateTooling, hasOssOverlay, hasRealProjects } from '../helpers/repoLayout';

describe('repoLayout predicates all resolve true in the private repo (tripwire)', () => {
  it('hasPrivateTooling() — this clone has a committed .mcp.json', () => {
    expect(hasPrivateTooling()).toBe(true);
  });

  it('hasOssOverlay() — this clone has the oss/ publish overlay', () => {
    expect(hasOssOverlay()).toBe(true);
  });

  it('hasRealProjects() — this clone has at least one games/ or demos/ project', () => {
    expect(hasRealProjects()).toBe(true);
  });
});
