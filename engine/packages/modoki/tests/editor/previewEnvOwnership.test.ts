/** #1277: the editor previews' PMREM output render target was never freed.
 *
 *  Both previews kept only `pmrem.fromScene(...).texture` and disposed THAT on teardown. Neither
 *  disposal reaches the target: `generator.dispose()` deliberately does not free its own output,
 *  and a render-target texture's `dispose()` is a no-op because three registers the free listener
 *  on the TARGET (`setupRenderTarget`) while `deallocateTexture` early-returns on a texture that
 *  never went through `initTexture`. Full reasoning in `previewEnvironment.ts`'s docblock.
 *
 *  What makes these falsifiable rather than decorative: the fake target tracks `targetDisposed`
 *  and `textureDisposed` SEPARATELY, so the pre-#1277 shape — `texture.dispose()` and nothing
 *  else — fails them. A fake exposing a single `dispose()` (which is exactly what
 *  `previewSceneLoss.test.ts`'s PMREM stub was) cannot tell the two apart and stays green against
 *  the defect. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTeardownScope } from '../../src/runtime/core/teardownScope';
import { repoFiles } from '../../../../scripts/repoCorpus.mjs';

/** Stand-in for the WebGLRenderTarget `fromScene()` hands back. The two independent flags are the
 *  whole point — see the file docblock. */
class FakeTarget {
  targetDisposed = false;
  texture = { textureDisposed: false, dispose() { this.textureDisposed = true; } };
  dispose() { this.targetDisposed = true; }
}

const targets: FakeTarget[] = [];
const roomEnvs: { disposed: boolean }[] = [];
const generators: { disposed: boolean }[] = [];
let fromSceneThrows = false;

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  return {
    ...actual,
    PMREMGenerator: class {
      self = { disposed: false };
      constructor() { generators.push(this.self); }
      fromScene() {
        if (fromSceneThrows) throw new Error('GPU op failed');
        const t = new FakeTarget();
        targets.push(t);
        return t;
      }
      dispose() { this.self.disposed = true; }
    },
  };
});

vi.mock('three/examples/jsm/environments/RoomEnvironment.js', () => ({
  RoomEnvironment: class {
    self = { disposed: false };
    constructor() { roomEnvs.push(this.self); }
    dispose() { this.self.disposed = true; }
  },
}));

const subject = async () => (await import('../../src/editor/panels/previewEnvironment')).createPreviewEnvironment;
/** The helper only ever passes `renderer` straight to `PMREMGenerator`, which is mocked. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const anyRenderer = {} as any;

beforeEach(() => {
  targets.length = 0;
  roomEnvs.length = 0;
  generators.length = 0;
  fromSceneThrows = false;
});

describe('createPreviewEnvironment — the PMREM OUTPUT target is owned, not just its texture', () => {
  it('returns the target texture and frees the TARGET when the scope drains', async () => {
    const createPreviewEnvironment = await subject();
    const scope = createTeardownScope('test');

    const texture = createPreviewEnvironment(anyRenderer, scope);

    expect(targets).toHaveLength(1);
    expect(texture, 'the caller gets the target texture, to assign to scene.environment').toBe(targets[0].texture);
    expect(targets[0].targetDisposed, 'nothing is freed before teardown').toBe(false);

    scope.dispose();

    expect(targets[0].targetDisposed, 'the target is the only handle that frees the framebuffer').toBe(true);
  });

  it('the TEXTURE is not what gets disposed — the pre-#1277 shape fails here', async () => {
    const createPreviewEnvironment = await subject();
    const scope = createTeardownScope('test');
    createPreviewEnvironment(anyRenderer, scope);
    scope.dispose();

    // Disposing the texture is not wrong, merely useless (deallocateTexture early-returns on it).
    // The assertion that can actually fail is the target's: a "fix" that only moved the old
    // `texture.dispose()` call around would leave `targetDisposed` false.
    expect(targets[0].targetDisposed, 'the target must be freed').toBe(true);
    expect(targets[0].texture.textureDisposed, 'and the useless call is not what stands in for it').toBe(false);
  });

  it('frees the RoomEnvironment and the generator scratch on the normal path', async () => {
    const createPreviewEnvironment = await subject();
    createPreviewEnvironment(anyRenderer, createTeardownScope('test'));

    expect(roomEnvs[0].disposed, "the RoomEnvironment's geometries/materials are scratch").toBe(true);
    expect(generators[0].disposed, "the generator's ping-pong target and LOD meshes are scratch").toBe(true);
  });

  it('a throwing derivation still frees the scratch it already allocated', async () => {
    const createPreviewEnvironment = await subject();
    const scope = createTeardownScope('test');
    fromSceneThrows = true;

    expect(() => createPreviewEnvironment(anyRenderer, scope)).toThrow('GPU op failed');

    // The `finally` is what makes these two pass — by the time `fromScene()` can throw, three has
    // already allocated the ping-pong target, the LOD meshes and their materials.
    // ⚠️ It does NOT restore the renderer's render target, and an earlier version of this comment
    // said it did: that restore is `_cleanup()`, which three runs only on the normal path. See the
    // helper's docblock and #1298.
    expect(roomEnvs[0].disposed, 'the RoomEnvironment must be freed on the throw path too').toBe(true);
    expect(generators[0].disposed, 'and so must the generator scratch').toBe(true);
    // Deliberately NOT asserted here, because neither can fail: `targets` is only pushed by the
    // mock's own `fromScene` (which threw), so a length of 0 asserts the mock rather than the
    // helper; and `scope.dispose()` structurally cannot throw, since `teardownScope`'s `run()`
    // wraps every release in try/catch by design. Two green assertions that no production edit
    // can redden read as coverage and are not.
  });
});

/** Census guard: the helper is the ONE place under `src/editor/**` that derives an environment map
 *  from a render target. #1277 existed in two files because a five-line block was copy-pasted; a
 *  third copy must not land quietly. This reads source text on purpose — a behavioural test cannot
 *  see a file no other test imports.
 *
 *  ⚠️ Two limits, both named because an unstated limit is what makes a guard read wider than it is:
 *  ① the sweep is `src/editor/**` of THIS package, so editor code living in `engine/app/**` is not
 *  covered (latent, not live — the only two `new THREE.WebGLRenderer(` sites in the repo are both
 *  under `src/editor/panels/`); ② it catches the API a derivation NAMES, not the rule "a render
 *  target is the caller's to free" in general. `PMREMGenerator` alone was too narrow for even that:
 *  a `WebGLCubeRenderTarget` + `fromEquirectangularTexture` + keep-only-`.texture` is #1277 verbatim
 *  and names no PMREM at all — `envPmrem.ts` already uses `CubeRenderTarget` exactly that way — so
 *  the pattern below covers that shape too. Both gaps were found by the adversarial review of
 *  #1277, not by the tests passing. */
describe('no editor panel derives its own environment map outside the helper', () => {
  const EDITOR_ROOT = join(__dirname, '../../src/editor');
  /** Repo-relative POSIX, matched by suffix: `repoFiles()` returns git's own `rel`, and comparing
   *  by suffix keeps this independent of where the package sits in the tree. */
  const HELPER_REL = 'src/editor/panels/previewEnvironment.ts';
  /** The bare identifier, deliberately — NOT `new\s+(THREE\.)?PMREMGenerator\s*\(`, which is what
   *  this started as. Mutation-checked: that pattern let `new THREE_PROBE.PMREMGenerator(...)`
   *  through, because anything but the literal `THREE.` prefix falls outside the optional group —
   *  and a namespace import can be aliased to whatever the next author likes. A name-check that
   *  only recognises the spelling the current code happens to use reports spelling, not the rule.
   *  Matching the identifier anywhere costs a false positive on a file that merely NAMES the class
   *  in prose; that is the right trade here, because exactly one file is meant to mention it and
   *  the failure message says where to go instead. */
  const DERIVES_ENV = /\bPMREMGenerator\b|\bfromEquirectangularTexture\b|\bWebGLCubeRenderTarget\b|\bCubeRenderTarget\b/;

  /** Enumerated through the shared `repoCorpus.mjs`, not a hand-rolled `readdir` walk — a private
   *  walker drifts from what the repo's own gates call "the corpus", which is what
   *  `corpusProducerIsShared.test.ts` (Rule 2) exists to stop. Its `floor` is also a better
   *  anti-vacuity check than a hand-written count: an empty corpus throws instead of passing. */
  const editorSources = (): { rel: string; code: string }[] =>
    repoFiles({ under: EDITOR_ROOT, match: (rel) => /\.tsx?$/.test(rel), floor: 50 })
      .map(({ rel, abs }) => ({ rel, code: readFileSync(abs, 'utf8') }));

  it('previewEnvironment.ts is the only src/editor file that names an env-derivation API', () => {
    const offenders = editorSources()
      .filter((f) => !f.rel.endsWith(HELPER_REL))
      .filter((f) => DERIVES_ENV.test(f.code))
      .map((f) => f.rel);

    expect(offenders, 'derive the preview IBL through createPreviewEnvironment, which owns the output target (#1277)').toEqual([]);
  });

  it('the guard can see a real derivation — it is not matching nothing', () => {
    // Anchors the pattern against the one file that legitimately has the call. Without this, a
    // typo'd regex would make the census above vacuously green forever — mutation-checked by
    // misspelling the identifier, which reddens this case and only this one.
    const helper = editorSources().find((f) => f.rel.endsWith(HELPER_REL));
    expect(helper, 'the helper must be inside the swept corpus, or the exclusion above is a lie').toBeTruthy();
    expect(DERIVES_ENV.test(helper!.code)).toBe(true);
  });
});
