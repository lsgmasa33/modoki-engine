/** Which (material x render-target) pairs a post-FX stack's INTERNAL stage quads draw (#323).
 *
 *  ── What this is for ─────────────────────────────────────────────────────────────────────────
 *  `PostFXStack.compileSceneAsync()` precompiles the SCENE pass by delegating to three's
 *  `PassNode.compileAsync`. Nothing precompiles the stack's own stages: bloom's mip pyramid
 *  (`highPass` + 5 × `separable` + `comp`), DOF's targets, GTAO, an `rtt()` wrapper, and the
 *  terminal colour-transform quad each build their GPU pipeline on their FIRST DRAW, and
 *  `RenderPipeline` exposes no compile entry point at all (r184). Measured on a Galaxy A23 from a
 *  Dawn trace: 8 pipelines / ~330 ms of off-thread GPU compile inside `demos/postfx-demo`'s worst
 *  remaining boot gap.
 *
 *  Each of those stages is an ordinary `QuadMesh` (`three/src/renderers/common/QuadMesh.js` —
 *  a plain `THREE.Mesh` drawn with `renderer.render(this, _camera)`), so it IS compilable; what is
 *  missing is a way to find it. This module is that walk, kept pure and separate so the pairing
 *  logic is unit-testable without a GPU.
 *
 *  ── Two pieces ───────────────────────────────────────────────────────────────────────────────
 *  `driveNodeUpdates` runs the graph's `updateBefore` hooks by hand (which is where three assigns
 *  fragment nodes, sizes targets and binds inter-stage textures), and
 *  `stageCompileJobsFromDraws` turns the draws those hooks attempted — recorded by the stubbed
 *  renderer in `precompileSession.ts` — into the compiles to issue. Observation, not inference:
 *  see that function's header for the `DepthOfFieldNode` case that killed the inference version.
 *
 *  ⚠️ Deliberately duck-typed and total. A three version bump that changes any of this must cost
 *  the optimisation, never the boot — so every reach is a presence check and an unrecognised graph
 *  yields zero jobs. The tripwire tests in `stageCompileJobs.test.ts` are what make that LOUD
 *  instead of silent.
 */

/** One `renderer.compileAsync(new QuadMesh(material), camera)` to issue, with the render target
 *  that selects the right render context for it. */
export interface StageCompileJob {
  /** Material name (three labels its stage materials `Bloom_comp`, `DoF_CoC`, …) — for the
   *  dev-only census line only. */
  readonly node: string;
  /** How the pair was obtained. Always `'observed'` today; kept so the census can say. */
  readonly field: string;
  /** The live stage material. NEVER cloned and never disposed — see `PostFXStack`. */
  readonly material: MaterialLike;
  /** A representative target with this attachment signature. */
  readonly target: RenderTargetLike;
  /** The signature `target` represents. */
  readonly signature: string;
  /** Stable identity of this (material × signature) pair, for the caller's already-compiled set.
   *  Materials carry no id this module may rely on, so it is minted per material object. */
  readonly key: string;
}

export interface MaterialLike { readonly isNodeMaterial?: boolean; readonly name?: string }
export interface RenderTargetLike {
  readonly isRenderTarget?: boolean;
  readonly textures?: ReadonlyArray<unknown>;
  readonly texture?: { format?: number; type?: number };
  readonly samples?: number;
  readonly depthBuffer?: boolean;
  readonly stencilBuffer?: boolean;
}

export interface StageCompileScan {
  readonly jobs: StageCompileJob[];
  /** How many draws the recorder saw — the census number a regression shows up in. */
  readonly walked: number;
  /** Distinct materials found (before signature pairing). */
  readonly materials: number;
  /** True if the cap truncated the job list. */
  readonly capped: boolean;
}

/** Upper bound on Phase 2 compiles.
 *
 *  ⚠️ A SAFETY cap, not a budget. A graph that keeps producing pairs must degrade to "warms fewer
 *  than it could", never to unbounded work at ~130 ms per pipeline on an A23. Since the pairs are
 *  now OBSERVED rather than inferred there is no cross-product to blow it: the shipped stacks want
 *  bloom 7, DOF 5, `rtt()` 1, `ParticlePassNode` 1, GTAO 1 — 15 with every stage enabled at once,
 *  which the Director's tour does reach. Raised from the inference era's headroom accordingly. */
export const MAX_STAGE_COMPILES = 24;

/** The `attachmentState` string `RenderContexts.get()` computes, verbatim (r184,
 *  `three/src/renderers/common/RenderContexts.js`). Returns `null` for anything that is not a
 *  usable render target. */
export function attachmentSignature(rt: RenderTargetLike | null | undefined): string | null {
  if (!rt || rt.isRenderTarget !== true) return null;
  const textures = rt.textures;
  const texture = rt.texture;
  if (!Array.isArray(textures) || textures.length === 0 || !texture) return null;
  if (typeof texture.format !== 'number' || typeof texture.type !== 'number') return null;
  return `${textures.length}:${texture.format}:${texture.type}:${rt.samples}:${rt.depthBuffer}:${rt.stencilBuffer}`;
}

/** Turn the draws a stubbed renderer RECORDED into the compiles to issue.
 *
 *  ── Why observation and not a walk over the node's fields ────────────────────────────────────
 *  The first version of this paired every material a node owned with every distinct attachment
 *  signature that SAME node owned. That is exact only for a node whose targets are degenerate:
 *  `BloomNode` has 7 materials and 11 targets sharing ONE signature, `GTAONode` has one of each.
 *  `DepthOfFieldNode` is neither — 5 materials over 6 targets spanning THREE signatures
 *  (`_CoCRT` is `count: 2` + `RedFormat`, `_CoCBlurredRT` is `RedFormat`, the rest are RGBA), so
 *  the cross-product produced 5 x 3 = 15 jobs where only 5 pairs are ever drawn. Ten wasted
 *  compiles at ~130 ms each on an A23 — and, worse, they ate the cap and TRUNCATED bloom's seven
 *  real jobs whenever the two stages were enabled together, which is exactly what
 *  `demos/postfx-demo`'s Director tour does.
 *
 *  There is no need to guess. `driveNodeUpdates` runs the graph's `updateBefore` hooks, and in a
 *  post-FX graph those hooks ARE the draws — `_quadMesh.material = X; setRenderTarget(Y);
 *  render()`. With the recorder installed (`precompileSession.ts`) that sequence is handed to us
 *  as the exact (material, target) pairs three itself uses. No node needs to be recognised, and a
 *  stage three adds tomorrow is covered the day it ships.
 *
 *  Deduped by (material, attachment SIGNATURE) rather than by target, because size is not a
 *  pipeline-key input: bloom's five mip levels are one job per material, and DOF's `_blur16Material`
 *  drawing into both the near and far target is one job.
 *
 *  A draw with no render target is skipped — that is a draw to the canvas, i.e. the terminal quad,
 *  which `compileStagesAsync` handles directly. So is a scene draw (`PassNode.updateBefore`),
 *  which has no material at all and is covered by `compileSceneAsync`.
 */
export function stageCompileJobsFromDraws(
  draws: readonly DrawLike[],
  cap: number = MAX_STAGE_COMPILES,
  exclude: ReadonlySet<string> = new Set(),
): StageCompileScan {
  const jobs: StageCompileJob[] = [];
  let capped = false;
  const emitted = new Set<string>();
  const seenMaterials = new Set<unknown>();
  if (!Array.isArray(draws)) return { jobs, walked: 0, materials: 0, capped: false };

  for (const draw of draws) {
    const material = draw?.material as MaterialLike | undefined;
    if (!material || typeof material !== 'object') continue;
    const signature = attachmentSignature(draw.target as RenderTargetLike | null);
    if (signature === null) continue;
    seenMaterials.add(material);
    const key = `${signature}|${jobKeyFor(material)}`;
    if (emitted.has(key) || exclude.has(key)) continue;
    if (jobs.length >= cap) { capped = true; break; }
    emitted.add(key);
    jobs.push({
      node: (material as { name?: string }).name ?? 'stage',
      field: 'observed',
      material,
      target: draw.target as RenderTargetLike,
      signature,
      key,
    });
  }
  return { jobs, walked: draws.length, materials: seenMaterials.size, capped };
}

/** The shape `stageCompileJobsFromDraws` reads off a recorded draw — structurally
 *  `DrawObservation` from `precompileSession.ts`, restated so this module stays dependency-free
 *  and unit-testable without a renderer. */
export interface DrawLike {
  readonly material: unknown;
  readonly target: unknown;
}

/** Materials have no stable id this module may rely on, so identity is the key. A WeakMap keeps
 *  the string side-table from pinning them alive. */
const _matKeys = new WeakMap<object, string>();
let _nextMatKey = 0;
function jobKeyFor(material: MaterialLike): string {
  const obj = material as unknown as object;
  let k = _matKeys.get(obj);
  if (k === undefined) { k = `m${_nextMatKey++}`; _matKeys.set(obj, k); }
  return k;
}

/** How many walk→compile rounds `PostFXStack.compileStagesAsync` may run.
 *
 *  Each round makes the NEXT level of nesting visible (see that method's Phase 2 note). The
 *  shipped stacks settle in two; four leaves headroom for a deeper composition without ever
 *  becoming an unbounded loop. */
export const MAX_STAGE_COMPILE_ROUNDS = 4;

/** Run every node's `updateBefore` hook by hand, over the whole stack graph, with renders stubbed.
 *
 *  ── Why this exists (#323, second pass) ──────────────────────────────────────────────────────
 *  A stage's materials are minted by its `setup()`, which runs when the graph CONTAINING it is
 *  built. That is fine for a stage sitting directly in the terminal quad's graph — compiling the
 *  terminal quad builds it, which is how `demos/particle-demo` was fully covered. It is NOT fine
 *  across an `rtt()` boundary, which is what `demos/postfx-demo` composes at SS > 1: the wrapper
 *  presents itself to the terminal graph as a plain texture, and everything inside it (bloom, on
 *  that project) is built only when the WRAPPER'S OWN quad material is built.
 *
 *  And that quad's material is empty until it draws: `RTTNode.updateBefore` is what assigns
 *  `_quadMesh.material.fragmentNode = this._rttNode`. So before this function existed, the round
 *  that compiled the wrapper's quad compiled a material with a NULL fragment node — it built
 *  nothing, bloom's `setup()` never ran, and the next round found nothing new. Measured on
 *  `demos/postfx-demo`: the walk saw 4 of ~10 stage materials and the seven bloom pipelines still
 *  built inside the first frame.
 *
 *  ⚠️ **`updateBefore` is only safe to call because renders are stubbed** (see
 *  `suppressRenderCalls`) — in a post-FX graph these hooks ARE the draws. With the stub in place
 *  what survives is exactly what the compile needs: fragment nodes assigned, render targets sized,
 *  inter-stage texture values bound.
 *
 *  ⚠️ Driven per ROUND, not once. This makes the wrapper's quad compilable; compiling it is what
 *  runs the inner stage's `setup()`; and only then can the next drive populate that stage's own
 *  uniforms. The two mechanisms are a pair — neither alone reaches a nested stage.
 *
 *  Every reach is duck-typed and every hook is individually caught: a node whose `updateBefore`
 *  cannot run outside a real draw (bloom's, in round 1, indexes a materials array `setup()` has
 *  not filled yet) must cost its own stage, never the walk and never the boot. */
export function driveNodeUpdates(outputNode: unknown, frame: unknown): { fired: number; failed: number } {
  const root = outputNode as { traverse?(cb: (n: unknown) => void): void } | null;
  let fired = 0;
  let failed = 0;
  if (!root || typeof root.traverse !== 'function') return { fired, failed };
  const seen = new Set<unknown>();
  try {
    root.traverse((n) => {
      if (!n || typeof n !== 'object' || seen.has(n)) return;
      seen.add(n);
      const node = n as { updateBefore?: unknown; getUpdateBeforeType?: unknown };
      const hook = node.updateBefore;
      if (typeof hook !== 'function') return;
      // ⚠️ Gate on the node's DECLARED update type, exactly as three's own
      // `NodeFrame.updateBeforeNode` does. `Node.prototype.updateBefore` is an ABSTRACT STUB that
      // logs `THREE.Abstract function.` — every node inherits it, so an unguarded call fires on
      // all ~3,100 nodes of a stack graph and floods the console with warnings that look like a
      // renderer fault. Caught the first time this ran on `demos/postfx-demo`.
      const typeOf = node.getUpdateBeforeType;
      if (typeof typeOf !== 'function') return;
      let updateType: unknown;
      try { updateType = (typeOf as () => unknown).call(node); } catch { return; }
      if (updateType === undefined || updateType === null || updateType === 'none') return;
      try {
        (hook as (f: unknown) => void).call(n, frame);
        fired++;
      } catch {
        failed++;
      }
    });
  } catch {
    // A graph shape this walk cannot read costs the optimisation, never the boot.
  }
  return { fired, failed };
}
