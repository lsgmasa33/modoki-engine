/** `PREFAB_FORMAT_VERSION` (engine/packages/modoki/src/runtime/core/version.ts) was bumped
 *  2 → 3 in #762's UIAnchor.zIndex follow-up (613dc5909), but the Playwright spec
 *  `editor-hierarchy.spec.ts` asserts the serialized bytes with a DELIBERATE numeric literal
 *  — `expect(prefab.version).toBe(3)` — rather than importing the constant, so a wrong
 *  constant can't vouch for itself. That literal stayed at 2 through the bump.
 *
 *  The problem: e2e is not part of `npm run verify`, so every clone stayed green and the
 *  mismatch surfaced only on the free public runner AFTER the push to `main` — two public
 *  CI runs red before the hub noticed. This guard reads both sides as text (no import — a
 *  Playwright spec can't be imported into vitest, and importing the constant would defeat
 *  the point of comparing two independently-authored sources) and fails locally, inside
 *  `verify`, the moment they disagree. */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// ⚠️ `runtime/core/version.ts`, NOT `editor/scene/prefab.ts` — the constant MOVED there in #1468
// so the dev server could reach it for the prefab format gate. This guard finds it by TEXT, so the
// move would otherwise have made `readConstant` throw its own "could not find" assertion rather
// than silently pass; that is the right failure, but it still has to be pointed at the new home.
const PREFAB_TS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../packages/modoki/src/runtime/core/version.ts',
);
const E2E_SPEC = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../e2e/editor-hierarchy.spec.ts',
);

function readConstant(): number {
  const src = readFileSync(PREFAB_TS, 'utf8');
  const m = src.match(/PREFAB_FORMAT_VERSION\s*=\s*(\d+)/);
  // A silent `undefined` here would make the equality check below pass vacuously if the
  // spec's regex also failed to match — assert the match exists before comparing anything.
  expect(m, `could not find PREFAB_FORMAT_VERSION = <n> in ${PREFAB_TS}`).toBeTruthy();
  return Number(m![1]);
}

function readSpecLiteral(): number {
  const src = readFileSync(E2E_SPEC, 'utf8');
  const m = src.match(/expect\(prefab\.version\)\.toBe\((\d+)\)/);
  expect(m, `could not find expect(prefab.version).toBe(<n>) in ${E2E_SPEC}`).toBeTruthy();
  return Number(m![1]);
}

describe('prefab format version stays in sync with the e2e literal (#762 follow-up)', () => {
  it('finds PREFAB_FORMAT_VERSION in version.ts', () => {
    expect(Number.isNaN(readConstant())).toBe(false);
  });

  it('finds the deliberate numeric literal in editor-hierarchy.spec.ts', () => {
    expect(Number.isNaN(readSpecLiteral())).toBe(false);
  });

  it('the e2e literal matches PREFAB_FORMAT_VERSION', () => {
    const constant = readConstant();
    const literal = readSpecLiteral();
    expect(
      literal,
      `PREFAB_FORMAT_VERSION is ${constant} (${PREFAB_TS}) but editor-hierarchy.spec.ts ` +
        `still asserts expect(prefab.version).toBe(${literal}) (${E2E_SPEC}). Bumping ` +
        `PREFAB_FORMAT_VERSION means updating that literal in the e2e spec too.`,
    ).toBe(constant);
  });
});
