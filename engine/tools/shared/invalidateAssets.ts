/** The asset kinds whose engine-side cache the `invalidate-assets` op evicts (#1216 C-13).
 *
 *  The op grew audio and environments (#304) while `device_invalidate_assets` kept a hand-written
 *  `z.enum(['model','texture'])`, so the two it had learned were unreachable from the tool that exists
 *  to reach them. One tuple: the op's dispatch table is typed against it and the tool's enum derives
 *  from it. `/api/reimport` still forwards EVERY baked type and lets the op ignore the rest (`font`
 *  refreshes through the manifest hash; atlas/video hold no engine cache), so the op does not refuse an
 *  unknown type — only the tool's schema does.
 *
 *  Dependency-free, like `simStepTiming.ts`: the device-shipped bridge imports it as a value. */
export const INVALIDATABLE_ASSET_TYPES = ['model', 'texture', 'audio', 'environment'] as const;
export type InvalidatableAssetType = (typeof INVALIDATABLE_ASSET_TYPES)[number];
