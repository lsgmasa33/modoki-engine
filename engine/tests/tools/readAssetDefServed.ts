/** Ask the `read-asset-def` OP which types it serves, instead of inferring it (#855).
 *
 *  `assetTypeParity.test.ts` used to establish its truth like this:
 *
 *      const READ_ASSET_DEF_TYPES = ASSET_SCHEMA_TYPES.filter((t) => !(t in NOT_READABLE));
 *
 *  — a hand-maintained exemption map subtracted from a sibling constant. That is an *inference*
 *  about what the op serves, and the file never called the op, so every assertion in it compared
 *  one derived constant against another and neither was the server. It could not fail for the
 *  reason it existed.
 *
 *  What that cost, measured: #831 added `atlas` to `ASSET_SCHEMA_TYPES`, the derived list grew to
 *  8, the two hand-kept MCP copies still had 7, and the test went red naming exactly that
 *  difference. The cheapest way to green was to widen the enums — so that is what happened, at the
 *  hub, in `de3cdce48`. But the op has no `atlas` branch, so `modoki_read_asset_def {type:'atlas'}`
 *  then passed zod and failed at the backend. Reverted in `ac546c720`. **A tool that ACCEPTS a
 *  type it cannot serve is worse than one that refuses it**, and the guard pushed it that way while
 *  staying green — because nothing in it could tell "the enum drifted from the op" from "the enum
 *  drifted from a list that has nothing to do with the op".
 *
 *  So: probe the op. Both surfaces answer a probe for a type they DO dispatch with the miss
 *  refusal (`not in the live <kind> cache`) and a type they do NOT with `unsupported type '<kind>'`,
 *  and those two strings are the distinguishing observation. Every probe passes an explicit `type`,
 *  which bypasses `inferAssetDefType` — otherwise an unknown suffix lands in the "cannot tell what
 *  kind of asset" branch instead, which answers a different question.
 *
 *  ⚠️ The two surfaces cannot be probed from one module graph. `registerAgentOp` (agentBridge.ts)
 *  is register-or-replace on ONE module-level Map keyed by name, and `registerEditorAgentOps` has a
 *  one-shot `registered` guard that cannot be un-set — so importing the editor ops permanently
 *  replaces the runtime twin for that file. The two probes therefore live next to each op's own
 *  behaviour tests, where whoever edits the op will see them:
 *
 *    - editor twin (`agentEditorOps.ts`) → `engine/tests/editor/readAssetDef.test.ts`
 *    - device twin (`agentBridge.ts`)    → `engine/tests/framework/liveLifecycleOps.test.ts`
 */

/** What a probe of ONE type learned about the op.
 *
 *  - `served`    — the op dispatched it: it answered, or refused with the live-cache miss.
 *  - `no-branch` — the op has no arm for it; it fell through to `unsupported type`.
 *  - `other`     — a refusal of its own (today: `material`, which is dispatched but deliberately
 *                  never readable). Kept distinct from `no-branch` on purpose: "I will not" and
 *                  "I cannot" are different facts, and collapsing them is how `material` and
 *                  `atlas` came to look interchangeable to the old guard.
 */
export type ServedVerdict = 'served' | 'no-branch' | 'other';

/** Run `read-asset-def` on one surface and hand back its ERROR TEXT — `''` when it answered.
 *  Exists because the two surfaces disagree on shape, not just wording: the editor op THROWS,
 *  the device op RETURNS `{ok:false, error, options}`. */
export type ReadAssetDefProbe = (args: { path: string; type: string }) => Promise<string>;

/** A path nothing loads, so a served type always reaches its cache-miss refusal rather than an
 *  answer. Kept obviously synthetic — the live MCP sweep reading a real-looking absent path is
 *  what motivated the op's `{load:false}` peek in the first place. */
export function probePathFor(type: string): string {
  return `/assets/__read-asset-def-parity__/probe.${type}.json`;
}

export type ProbeReport = {
  /** Types the op dispatches — the answer the MCP enums are supposed to be a copy of. */
  served: string[];
  /** Types with no arm at all. */
  noBranch: string[];
  /** Types dispatched but refused for their own stated reason, mapped to that reason. */
  other: Record<string, string>;
};

/** Probe every `types` entry against one surface and classify what came back. */
export async function probeServedTypes(
  types: readonly string[],
  probe: ReadAssetDefProbe,
): Promise<ProbeReport> {
  const report: ProbeReport = { served: [], noBranch: [], other: {} };
  for (const type of types) {
    const message = await probe({ path: probePathFor(type), type });
    switch (classifyReadAssetDef(type, message)) {
      case 'served': report.served.push(type); break;
      case 'no-branch': report.noBranch.push(type); break;
      default: report.other[type] = message; break;
    }
  }
  return report;
}

/** Classify one probe's reply. Matches on the op's own refusal wordings, which both surfaces
 *  share (the device's is unprefixed, the editor's is prefixed and parenthesised — `includes`
 *  spans both). The cache name is checked against the type PROBED, so an arm that dispatches
 *  `shader` into the particle cache reads as `other`, not as a pass. */
export function classifyReadAssetDef(type: string, message: string): ServedVerdict {
  // The op answered at all — it plainly has an arm for this type.
  if (message === '') return 'served';
  if (message.includes(`unsupported type '${type}'`)) return 'no-branch';
  if (message.includes(`not in the live ${type} cache`)) return 'served';
  return 'other';
}
