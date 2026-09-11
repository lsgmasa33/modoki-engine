/** A refusal that NAMES its §5 code — and the one place a relayed op's outcome becomes a reply (#1012).
 *
 *  An op that throws a plain `Error` cannot say WHICH refusal it is, so the route has to pick a code
 *  for it, and the route knows strictly less than the op: every such refusal reached the agent as
 *  the generic `REFUSED_BY_OP`, whether the entity id was stale (`NOT_FOUND`), the editor had unsaved
 *  work (`REQUIRES_SAVE`) or half a save had landed (`PARTIAL`). `docs/mcp-tool-conventions.md` §5
 *  says a state refusal is RETURNED with its code; `OpRefusal` is the thrown form of the same thing,
 *  for a helper buried under ten callers (`requireLiveId`, `guardUnsaved`) that would otherwise have
 *  to thread a return value through every one of them.
 *
 *  ⚠️ **The conversion lives HERE, not in `relayResponseFor`, because the editor has TWO transports.**
 *  The HMR relay answers through `relayResponseFor`; the Electron IPC handler deliberately does not —
 *  IPC reaches exactly one `webContents`, so there is no broadcast and no decline to count (the
 *  asymmetry, and why it stays, is `main.ts`'s `requestRenderer` docblock). A conversion placed in only one of
 *  them is dead in the other — the packaged editor, where it would matter most. Both call
 *  `opReplyFor`. The DEVICE relay (`bridge.ts` `delegateToAgentOps`) does not: its protocol is an
 *  `Error: <msg>` string sentinel, so an `OpRefusal` from a runtime op arrives there uncoded. No
 *  runtime op throws one — see `docs/mcp-tool-conventions.md` §5 before adding the first.
 *
 *  Classified by CLASS, never by message (§5 rider 3), the same way `CaptureUnavailableError` is.
 *  An in-process caller (`modoki.call` in an eval body, a test through `runAgentOp`) still sees the
 *  throw, message unchanged — only a relay reply carries the envelope. */

import type { ErrorCode } from '../../tools/shared/mcpResult';
import { toJsonSafe } from '@modoki/engine/runtime/core/jsonSafe';

export class OpRefusal extends Error {
  readonly code: ErrorCode;
  /** The real choices, when there is a finite set — §5's `options`. */
  readonly options?: string[];

  constructor(code: ErrorCode, message: string, opts: { options?: string[] } = {}) {
    super(message);
    this.name = 'OpRefusal';
    this.code = code;
    if (opts.options) this.options = opts.options;
  }
}

/** What a transport sends back for one op run: the op's result, or the message of what it threw.
 *  An `OpRefusal` becomes a RESULT — the `{ok:false, code, error, options}` envelope the router's
 *  `opRefusal` relays on its code's status — rather than an `error`, which reaches the router as a
 *  rejection that can only be classified by its prose.
 *
 *  ⚠️ **The result goes through `toJsonSafe` (#1068).** Both editor transports end in a bare
 *  `JSON.stringify` this code does not own: Vite's `hot.send` in the renderer, and the backend's
 *  response write after Electron's IPC. So an `Error` anywhere in a result (a journal payload, a
 *  captured rejection) reached the agent as `{}`, while the device bridge's `safeStringify` showed
 *  the same event as text. Rendering it here, where both transports already meet, fixes both at
 *  once. Copy-on-write: a result with nothing to render is sent as the same object. */
export async function opReplyFor(run: () => unknown): Promise<{ result: unknown } | { error: string }> {
  try {
    // `'result'`: the key the transport's stringify hands a root `toJSON`, since the value is sent as `{ result }`.
    return { result: toJsonSafe(await run(), 'result') };
  } catch (e) {
    if (e instanceof OpRefusal) {
      return { result: { ok: false, code: e.code, error: e.message, ...(e.options ? { options: e.options } : {}) } };
    }
    return { error: String(e instanceof Error ? e.message : e) };
  }
}
