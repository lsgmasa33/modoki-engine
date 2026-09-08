/** Shape decoder for the `apply-scene-ops` relay reply (#647).
 *
 *  `/api/scene-mutate`'s LIVE path asks the renderer to apply the ops and then reads three named
 *  ARRAY fields straight off the answer — `errors`, `warnings`, `unresolved`. It used to do that
 *  through a bare `as` cast, so a reply missing any of them threw `Cannot read properties of
 *  undefined (reading 'length')` (or `live.warnings is not iterable`) out of the route's own
 *  try/catch.
 *
 *  ⚠️ **Why that was worse than the #644 it descends from.** The catch's remedy is "the relay
 *  failed" → HTTP 500 → `NOT_AVAILABLE_HERE` → *"relaunch the editor"*. But the relay RETURNED.
 *  The ops had ALREADY APPLIED to the live world. A caller told "the mutation failed" retries it
 *  and double-applies — and where #644's blast radius was a read, this one's is a WRITE.
 *
 *  So an unreadable shape is `PARTIAL`, never a retryable failure: the honest answer is "this
 *  build cannot read what came back, and the world may already have changed", which sends the
 *  caller to re-read the live world rather than to fire the same ops again.
 *
 *  ## Why this can happen at all
 *
 *  The producer (`applySceneOpsLive`, `engine/app/editor/agentEditorOps.ts`) lives in the RENDERER
 *  bundle and versions independently of this backend host (Electron main / the Vite plugin). A
 *  matched pair always agrees — the in-tree producer emits all three arrays unconditionally — so
 *  there is no in-tree repro. The reachable cases are version skew, a different relay peer, and a
 *  relay that answers a bare error string. That independence is exactly what made #644 happen on
 *  the device wire.
 *
 *  Same shape as `decodeAimReply` in `./deviceAim.ts` and `parseConsoleLogsReply` in
 *  `engine/tools/game-debug-mcp/src/reply.ts`: `unknown` in, discriminated union out, never a
 *  throw, never a cast, and an unrecognised value described BY KEYS ONLY — a scene op can carry
 *  authored strings, and an error message is not the place to echo them.
 */
import { describeShape, type ErrorCode } from '../../tools/shared/mcpResult';
import type { EntityRef } from '../../packages/modoki/src/runtime/scene/sceneMutate';

/** The fields the live path actually reads. `created`/`code` are already optional at the call
 *  site (optional-chained / truthiness-checked), so they are decoded leniently. */
export type SceneOpsLiveReply = {
  changed: number;
  errors: string[];
  warnings: string[];
  unresolved: EntityRef[];
  created?: Array<{ op: number; id: number; guid: string; name: string }>;
  code?: ErrorCode;
};

export type SceneOpsOutcome =
  | { kind: 'ok'; reply: SceneOpsLiveReply }
  /** The relay answered, but not in a shape this build can read. The ops MAY have applied. */
  | { kind: 'unreadable'; got: string };

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === 'string');
}

export function decodeSceneOpsReply(raw: unknown): SceneOpsOutcome {
  let v = raw;
  // The relay's transport has historically handed back a JSON STRING rather than an object
  // (`decodeAimReply`'s header records that exact drift, caught only on device). Tolerate it
  // rather than calling a perfectly good reply unreadable.
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch { /* not JSON — fall through to the shape refusal below */ }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { kind: 'unreadable', got: describeShape(v) };
  const o = v as Record<string, unknown>;

  // The three fields the route reads with `.length` / a spread. All three must be present and
  // array-typed, because a partial answer is precisely the case that used to throw.
  if (!isStringArray(o.errors) || !isStringArray(o.warnings) || !Array.isArray(o.unresolved)) {
    return { kind: 'unreadable', got: describeShape(v) };
  }
  // `changed` drives the `hint` and the caller's own reporting. A non-number here would surface
  // as `undefined` in the response rather than throw, which is the quiet half of the same defect.
  if (typeof o.changed !== 'number' || !Number.isFinite(o.changed)) {
    return { kind: 'unreadable', got: describeShape(v) };
  }

  return {
    kind: 'ok',
    reply: {
      changed: o.changed,
      errors: o.errors,
      warnings: o.warnings,
      unresolved: o.unresolved as EntityRef[],
      ...(Array.isArray(o.created) ? { created: o.created as SceneOpsLiveReply['created'] } : {}),
      ...(typeof o.code === 'string' ? { code: o.code as ErrorCode } : {}),
    },
  };
}
