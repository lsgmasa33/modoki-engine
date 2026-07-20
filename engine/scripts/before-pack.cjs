/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * electron-builder `beforePack` orchestrator. beforePack accepts a SINGLE hook,
 * so this fans out to every native-tool stager that must run before packing +
 * signing. Each stager is independently graceful (logs + skips when its binary is
 * absent on the build machine), so one missing tool never fails the whole build.
 *
 * We bundle ONLY the tools that have no download path AND are needed by the core /
 * common import pipeline: toktx (KTX texture encode — core, no npm distribution)
 * and msdf-atlas-gen (font atlas bake — no macOS prebuilt or npm binary, but tiny).
 * ffmpeg/ffprobe are NOT bundled — they're npm-downloadable, so the packaged editor
 * provisions them on-demand into the userData toolchain (install('ffmpeg')), keeping
 * the base app lean. See the decision matrix in editor-shipping-strategy.
 *
 * Order is irrelevant — they stage into disjoint files under build/bin/, which
 * electron-builder then ships as extraResources → Contents/Resources/bin and signs.
 */

const stageToktx = require('./stage-toktx.cjs').default;
const stageMsdf = require('./stage-msdf.cjs').default;

exports.default = async function beforePack(context) {
  await stageToktx(context);
  await stageMsdf(context);
};
