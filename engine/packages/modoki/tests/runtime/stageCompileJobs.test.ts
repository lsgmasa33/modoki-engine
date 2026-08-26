/** The post-FX STAGE-quad precompile walk (#323).
 *
 *  Two halves, and the second is the one that earns its keep:
 *   1. the pairing/cap/bail-out logic, over a fake node graph — no GPU, no three;
 *   2. a TRIPWIRE against the three actually installed. Every private field this feature reaches
 *      for is asserted here, so a version bump turns `npm test` RED instead of silently dropping
 *      the optimisation. Same discipline as `sidePinnedVariants`' r184 line-number quoting in
 *      `scene3DSync.ts`: the failure mode this whole workstream keeps producing is a precompile
 *      that succeeds and warms nothing, and silence is what makes it expensive.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  stageCompileJobsFromDraws, driveNodeUpdates, attachmentSignature,
  MAX_STAGE_COMPILES, MAX_STAGE_COMPILE_ROUNDS,
} from '../../src/runtime/rendering/postfx/stageCompileJobs';

/** A render target shaped exactly as far as `attachmentSignature` looks. */
const rt = (o: Partial<{ count: number; format: number; type: number; samples: number; depth: boolean; stencil: boolean }> = {}) => ({
  isRenderTarget: true,
  textures: new Array(o.count ?? 1).fill(0),
  texture: { format: o.format ?? 1023, type: o.type ?? 1016 },
  samples: o.samples ?? 0,
  depthBuffer: o.depth ?? false,
  stencilBuffer: o.stencil ?? false,
});

const mat = (name: string) => ({ isNodeMaterial: true, name });

/** A minimal stand-in for a TSL node graph: `traverse` visits the node and its children. */
function graph(nodes: object[]): { traverse(cb: (n: unknown) => void): void } {
  return { traverse: (cb) => { for (const n of nodes) cb(n); } };
}

describe('attachmentSignature — the RenderContexts.get() key, verbatim', () => {
  it('folds colour-target count, format, type, samples and depth/stencil presence', () => {
    expect(attachmentSignature(rt())).toBe('1:1023:1016:0:false:false');
    expect(attachmentSignature(rt({ count: 3, samples: 4, depth: true })))
      .toBe('3:1023:1016:4:true:false');
  });

  it('ignores SIZE — it is not a pipeline-key input, which is why bloom\'s five mips share a job', () => {
    const big = { ...rt(), width: 500, height: 350 };
    const small = { ...rt(), width: 32, height: 22 };
    expect(attachmentSignature(big)).toBe(attachmentSignature(small));
  });

  it('returns null for anything that is not a usable render target', () => {
    expect(attachmentSignature(null)).toBeNull();
    expect(attachmentSignature(undefined)).toBeNull();
    expect(attachmentSignature({ isRenderTarget: false } as never)).toBeNull();
    expect(attachmentSignature({ isRenderTarget: true, textures: [], texture: { format: 1, type: 1 } })).toBeNull();
    expect(attachmentSignature({ isRenderTarget: true, textures: [0], texture: {} })).toBeNull();
  });
});

/** One recorded draw: the material bound and the target it went to. */
const draw = (material: object, target: unknown) => ({ material, target });

describe('stageCompileJobsFromDraws — the OBSERVED material→target pairs', () => {
  it('emits one job per (material, attachment signature) actually drawn', () => {
    const m0 = mat('a'); const m1 = mat('b');
    const t = rt();
    const { jobs, materials, walked } = stageCompileJobsFromDraws([draw(m0, t), draw(m1, t)]);
    expect(jobs).toHaveLength(2);
    expect(materials).toBe(2);
    expect(walked).toBe(2);
    expect(jobs.map((j) => j.material)).toEqual([m0, m1]);
  });

  it('collapses one material drawn into several SAME-signature targets — bloom\'s five mips', () => {
    const m = mat('Bloom_separable');
    const mips = [rt(), rt(), rt(), rt(), rt()];   // differ only in size, which is not a key input
    const { jobs } = stageCompileJobsFromDraws(mips.map((t) => draw(m, t)));
    expect(jobs).toHaveLength(1);
  });

  it('keeps one material drawn into DIFFERENT signatures as separate jobs', () => {
    const m = mat('shared');
    const { jobs } = stageCompileJobsFromDraws([
      draw(m, rt()), draw(m, rt({ count: 2 })), draw(m, rt({ samples: 4 })),
    ]);
    expect(jobs).toHaveLength(3);
  });

  /** ⚠️ THE REGRESSION THIS FUNCTION EXISTS FOR. The previous version paired every material a node
   *  owned with every distinct signature that node owned. `DepthOfFieldNode` (three r184) has 5
   *  materials over 6 targets spanning 3 signatures, so it produced 15 jobs where 5 pairs are
   *  drawn — 10 wasted ~130 ms compiles that also ate the cap and truncated bloom's real 7
   *  whenever the two ran together, which `demos/postfx-demo`'s Director tour does. */
  it('DOF: five materials over three signatures yields FIVE jobs, not fifteen', () => {
    // Exactly `DepthOfFieldNode.updateBefore`'s draw sequence (r184), in order.
    const CoC = mat('DoF_CoC'), CoCBlur = mat('DoF_CoCBlur');
    const blur64 = mat('DoF_blur64'), blur16 = mat('DoF_blur16'), comp = mat('DoF_composite');
    const CoCRT = rt({ count: 2, format: 1028 });     // RedFormat, count 2
    const CoCBlurredRT = rt({ format: 1028 });        // RedFormat, count 1
    const blur64RT = rt(), blur16NearRT = rt(), blur16FarRT = rt(), compositeRT = rt();
    const { jobs, materials } = stageCompileJobsFromDraws([
      draw(CoC, CoCRT),
      draw(CoCBlur, CoCBlurredRT),
      draw(blur64, blur64RT),
      draw(blur16, blur16NearRT),
      draw(blur64, blur64RT),        // far pass reuses the same material AND target
      draw(blur16, blur16FarRT),     // far pass, same signature as near
      draw(comp, compositeRT),
    ]);
    expect(materials).toBe(5);
    expect(jobs).toHaveLength(5);
    expect(new Set(jobs.map((j) => j.signature)).size).toBe(3);
    // And each job carries a target that really was bound for that material.
    expect(jobs.find((j) => j.material === CoC)!.target).toBe(CoCRT);
    expect(jobs.find((j) => j.material === CoCBlur)!.target).toBe(CoCBlurredRT);
  });

  it('DOF and bloom together fit well inside the cap', () => {
    const dof = Array.from({ length: 7 }, (_, i) => draw(mat(`d${i % 5}`), rt({ count: (i % 3) + 1 })));
    const bloomMats = Array.from({ length: 7 }, (_, i) => mat(`b${i}`));
    const bloom = bloomMats.map((m) => draw(m, rt()));
    const { jobs, capped } = stageCompileJobsFromDraws([...dof, ...bloom]);
    expect(capped).toBe(false);
    expect(jobs.length).toBeLessThanOrEqual(MAX_STAGE_COMPILES);
    // Every bloom material must survive — the truncation this replaced is what dropped them.
    for (const m of bloomMats) expect(jobs.some((j) => j.material === m)).toBe(true);
  });

  it('skips a draw with no render target — that is the canvas, i.e. the terminal quad', () => {
    expect(stageCompileJobsFromDraws([draw(mat('terminal'), null)]).jobs).toHaveLength(0);
  });

  it('skips a draw with no material — a scene pass, covered by compileSceneAsync', () => {
    expect(stageCompileJobsFromDraws([{ material: undefined, target: rt() }]).jobs).toHaveLength(0);
  });

  it('truncates at the cap and SAYS it truncated', () => {
    const many = Array.from({ length: 50 }, (_, i) => draw(mat(`m${i}`), rt()));
    const { jobs, capped } = stageCompileJobsFromDraws(many);
    expect(jobs).toHaveLength(MAX_STAGE_COMPILES);
    expect(capped).toBe(true);
  });

  it('honours a caller-supplied cap so a multi-round caller can budget across rounds', () => {
    const many = Array.from({ length: 10 }, (_, i) => draw(mat(`m${i}`), rt()));
    expect(stageCompileJobsFromDraws(many, 3).jobs).toHaveLength(3);
  });

  it('drops pairs the caller already compiled, keyed by (material, signature)', () => {
    const m = mat('a'); const t = rt();
    const first = stageCompileJobsFromDraws([draw(m, t)]);
    expect(first.jobs).toHaveLength(1);
    const second = stageCompileJobsFromDraws([draw(m, t)], MAX_STAGE_COMPILES, new Set([first.jobs[0].key]));
    expect(second.jobs).toHaveLength(0);
  });

  it('keys by the MATERIAL OBJECT, not its name — two same-named blurs stay distinct', () => {
    const { jobs } = stageCompileJobsFromDraws([
      draw(mat('Bloom_separable'), rt()), draw(mat('Bloom_separable'), rt()),
    ]);
    expect(new Set(jobs.map((j) => j.key)).size).toBe(2);
  });

  it('yields nothing rather than throwing on junk input', () => {
    for (const bad of [null, undefined, 42, {}, 'nope']) {
      expect(stageCompileJobsFromDraws(bad as never).jobs).toHaveLength(0);
    }
    expect(stageCompileJobsFromDraws([null, undefined, 3] as never).jobs).toHaveLength(0);
  });

  it('MAX_STAGE_COMPILE_ROUNDS bounds the walk→compile loop', () => {
    expect(MAX_STAGE_COMPILE_ROUNDS).toBeGreaterThan(1);
    expect(MAX_STAGE_COMPILE_ROUNDS).toBeLessThan(10);
  });
});

/** A node as far as `driveNodeUpdates` looks at one. `type` mirrors `NodeUpdateType`. */
const node = (type: string | undefined, hook?: () => void) => ({
  getUpdateBeforeType: type === undefined ? undefined : () => type,
  updateBefore: hook ?? (() => {}),
});

describe('driveNodeUpdates — running three\'s update hooks by hand (#323, nested stages)', () => {
  it('fires a node that declares a real update type', () => {
    let called = 0;
    const n = node('render', () => { called++; });
    expect(driveNodeUpdates(graph([n]), {})).toEqual({ fired: 1, failed: 0 });
    expect(called).toBe(1);
  });

  it('passes the caller\'s frame straight through — hooks read `.renderer` off it', () => {
    const frame = { renderer: { marker: 1 } };
    let seen: unknown;
    const n = node('frame', function (this: unknown, ...a: unknown[]) { seen = a[0]; });
    driveNodeUpdates(graph([n as never]), frame);
    expect(seen).toBe(frame);
  });

  it('NEVER calls the abstract stub — a node declaring `none` is skipped', () => {
    let called = 0;
    expect(driveNodeUpdates(graph([node('none', () => { called++; })]), {}))
      .toEqual({ fired: 0, failed: 0 });
    expect(called).toBe(0);
  });

  it('skips a node with no `getUpdateBeforeType` at all, rather than guessing', () => {
    let called = 0;
    // `Node.prototype.updateBefore` exists on EVERY three node and logs `THREE.Abstract function.`
    // — the console flood this gate exists to prevent.
    expect(driveNodeUpdates(graph([{ updateBefore: () => { called++; } }]), {}))
      .toEqual({ fired: 0, failed: 0 });
    expect(called).toBe(0);
  });

  it('skips a node whose type accessor throws', () => {
    let called = 0;
    const n = { getUpdateBeforeType: () => { throw new Error('nope'); }, updateBefore: () => { called++; } };
    expect(driveNodeUpdates(graph([n]), {})).toEqual({ fired: 0, failed: 0 });
    expect(called).toBe(0);
  });

  it('a THROWING hook is counted and the walk carries on — round 1 bloom does exactly this', () => {
    const boom = node('render', () => { throw new Error('materials not built yet'); });
    let after = 0;
    const ok = node('render', () => { after++; });
    expect(driveNodeUpdates(graph([boom, ok]), {})).toEqual({ fired: 1, failed: 1 });
    expect(after).toBe(1);
  });

  it('fires each node once even when the graph hands it over repeatedly', () => {
    let called = 0;
    const n = node('render', () => { called++; });
    driveNodeUpdates({ traverse: (cb: (x: unknown) => void) => { cb(n); cb(n); cb(n); } }, {});
    expect(called).toBe(1);
  });

  it('bails out silently on a graph it cannot walk', () => {
    for (const bad of [null, undefined, 7, {}, { traverse: 'no' }]) {
      expect(driveNodeUpdates(bad, {})).toEqual({ fired: 0, failed: 0 });
    }
    expect(driveNodeUpdates({ traverse: () => { throw new Error('three changed'); } }, {}))
      .toEqual({ fired: 0, failed: 0 });
  });
});

/** ⚠️ TRIPWIRE. `PostFXStack.compileStagesAsync` reaches into three's private structure because
 *  `RenderPipeline` exposes no compile entry point. Each identifier below is one the feature reads;
 *  a three bump that renames one must fail HERE, loudly, rather than turning the precompile into a
 *  silent no-op that resurfaces months later as a boot regression on a phone.
 *
 *  ⚠️ Asserted against three's SOURCE TEXT, not by importing it, and that is forced rather than
 *  chosen: this suite aliases `three/webgpu` and `three/tsl` to stubs (see `vitest.config.ts`), so
 *  neither `RenderPipeline` nor `BloomNode` can be constructed here at all. Same shape as
 *  `sidePinnedVariants`' r184 line-number quoting in `scene3DSync.ts` — pin the fact, name the
 *  version, fail loudly when it moves. */
describe('three r184 tripwire — the private surface #323 depends on', () => {
  const threeDir = path.resolve(__dirname, '../../../../../node_modules/three');
  const read = (rel: string) => readFileSync(path.join(threeDir, rel), 'utf8');

  it('is pinned to the three this was measured against', () => {
    const { version } = JSON.parse(read('package.json')) as { version: string };
    // Not an equality assert: a patch bump must not go red. A MINOR bump is exactly when the
    // identifiers below are worth re-reading, and the rest of this describe is what catches it.
    expect(version.startsWith('0.18')).toBe(true);
  });

  it('RenderPipeline still owns _quadMesh, _update and outputNode', () => {
    const src = read('src/renderers/common/RenderPipeline.js');
    expect(src).toContain('this._quadMesh = new QuadMesh( material )');
    expect(src).toMatch(/\n\t_update\(\) \{/);
    expect(src).toContain('this.outputNode = outputNode');
    expect(src).toContain('this.needsUpdate = true');
  });

  it('QuadMesh is still an ordinary Mesh drawn through renderer.render — what makes it compilable', () => {
    const src = read('src/renderers/common/QuadMesh.js');
    expect(src).toContain('class QuadMesh extends Mesh');
    expect(src).toContain('renderer.render( this, _camera )');
  });

  it('BloomNode still mints its materials in setup() and its targets in the constructor', () => {
    const src = read('examples/jsm/tsl/display/BloomNode.js');
    // The names are no longer READ — pairs come from observed draws — but this asymmetry is still
    // load-bearing: it is WHY the walk runs in rounds. A stage's materials do not exist until the
    // graph containing it is built.
    expect(src.indexOf('this._separableBlurMaterials.push')).toBeGreaterThan(src.indexOf('setup( builder )'));
    expect(src.indexOf('this._renderTargetsHorizontal = []')).toBeLessThan(src.indexOf('setup( builder )'));
  });

  it('BloomNode still draws every stage through _quadMesh.render — how the pairs are observed', () => {
    const src = read('examples/jsm/tsl/display/BloomNode.js');
    expect(src).toContain('_quadMesh.material = this._highPassFilterMaterial;');
    expect(src).toContain('_quadMesh.material = this._compositeMaterial;');
    // FOUR literal call sites, not seven draws: the high pass, two inside the mip loop, and the
    // composite. The loop is exactly why counting draws at RUNTIME beats reading the source.
    expect(src.match(/_quadMesh\.render\( renderer \)/g)?.length).toBe(4);
  });

  /** ⚠️ The node that killed the inference version. Asserted so a future change back to
   *  "every material x every signature on the node" is caught by a failing count, not by a boot
   *  regression on `demos/postfx-demo` — whose Director tour enables DOF and bloom together. */
  it('DepthOfFieldNode still has FIVE materials over targets spanning THREE signatures', () => {
    const src = read('examples/jsm/tsl/display/DepthOfFieldNode.js');
    for (const m of ['_CoCMaterial', '_CoCBlurredMaterial', '_blur64Material', '_blur16Material', '_compositeMaterial']) {
      expect(src).toContain(m);
    }
    // The three signatures: `count: 2` + RedFormat, RedFormat, and plain HalfFloat RGBA.
    expect(src).toContain('format: RedFormat, count: 2');
    expect(src).toContain('format: RedFormat }');
    // And it draws them the same observable way, so the pairs are readable without knowing any
    // of the names above.
    expect(src.match(/_quadMesh\.render\( renderer \)/g)?.length).toBe(7);
    expect(src).toContain('_quadMesh.material = this._CoCMaterial;');
  });

  it('compileAsync still drives node updateBefore itself — the reason renders are stubbed', () => {
    const src = read('src/renderers/common/Renderer.js');
    // In the compile drain loop, one line after the async node build.
    expect(src).toContain('await this._nodes.getForRenderAsync( renderObject );');
    expect(src).toContain('this._nodes.updateBefore( renderObject );');
  });

  it('compileAsync still takes depth/stencil from the RENDERER where _renderScene takes them from the TARGET', () => {
    const src = read('src/renderers/common/Renderer.js');
    // The asymmetry `mirrorDepthStencil` exists for. If three ever fixes it, the mirror becomes a
    // no-op rather than a bug — but this test is where the news arrives.
    expect(src).toContain('renderContext.depth = this.depth;');
    expect(src).toContain('renderContext.depth = renderTarget.depthBuffer;');
  });

  it('RenderContexts still keys a context by the attachment string this module reproduces', () => {
    const src = read('src/renderers/common/RenderContexts.js');
    expect(src).toContain(
      'attachmentState = `${ count }:${ format }:${ type }:${ renderTarget.samples }:'
      + '${ renderTarget.depthBuffer }:${ renderTarget.stencilBuffer }`',
    );
  });

  it('Node.updateBefore is still an ABSTRACT WARN STUB gated by updateBeforeType', () => {
    const src = read('src/nodes/core/Node.js');
    // Both halves matter. The stub is why `driveNodeUpdates` must gate; `updateBeforeType`
    // defaulting to NONE is what it gates ON.
    expect(src).toContain('this.updateBeforeType = NodeUpdateType.NONE;');
    expect(src).toMatch(/updateBefore\( \/\*frame\*\/ \) \{\s*\n\s*warn\( 'Abstract function\.' \);/);
    expect(src).toContain('getUpdateBeforeType() {');
  });

  it('NodeFrame still gates updateBefore on the declared type — driveNodeUpdates mirrors this', () => {
    const src = read('src/nodes/core/NodeFrame.js');
    expect(src).toContain('const updateType = node.getUpdateBeforeType();');
    expect(src).toContain('if ( updateType === NodeUpdateType.FRAME )');
    expect(src).toContain('} else if ( updateType === NodeUpdateType.RENDER ) {');
  });

  it('RTTNode still assigns its quad material\'s fragmentNode inside updateBefore', () => {
    const src = read('src/nodes/utils/RTTNode.js');
    // THE fact the nested-stage case turns on: the wrapper's quad material is EMPTY until this
    // line runs, so compiling it before driving updateBefore builds nothing and the stage inside
    // the wrapper never gets its `setup()`.
    expect(src).toContain('this._quadMesh.material.fragmentNode = this._rttNode;');
    expect(src).toContain('updateBefore( { renderer } ) {');
  });

  it('the pipeline cache key still does NOT fold the render context id — why no call-depth pin', () => {
    const src = read('src/renderers/common/Pipelines.js');
    expect(src).toContain("return stageVertex.id + ',' + stageFragment.id + ',' + this.backend.getRenderCacheKey( renderObject );");
  });
});
