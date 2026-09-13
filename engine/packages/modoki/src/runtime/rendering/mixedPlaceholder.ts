/** The placeholder a field shows when its value DIFFERS across a multi-selection — and the one
 *  agent-readable signal that it does (#1152 close-out).
 *
 *  Declared in the runtime, not in the editor's `fields.tsx` where it used to live, because two sides
 *  need the same string: every mixed editor control renders it (an empty text/number field's
 *  placeholder, or the selected `<option>` of a select), and `engine/app/debug/chromeHandles.ts` reads
 *  it back to report `meta.mixed`. That reader also runs on device and must not import the editor.
 *  Keying the reader on what every mixed control already RENDERS is the point: a per-producer marker
 *  was missed by the Inspector's main number field and five texture selects in the first attempt.
 *
 *  ⚠️ A module of its own, with NO imports and no side effects — deliberately. It first lived in
 *  `interactionHandles.ts`, whose module body calls `onWorldSwap`, so `fields.tsx` importing it made
 *  every editor suite that mocks `core/ecs/world` wholesale throw at load (four suites, caught by
 *  `npm run verify`). A constant the editor imports must not drag a registry in with it. */
export const MIXED_PLACEHOLDER = '----';
