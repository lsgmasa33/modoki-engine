/** Main's side of the unsaved-work gate (#1419): before a window close, an app quit, a project
 *  switch or a reload throws the renderer away, ask the renderer's gate
 *  (`scene/unsavedGate.ts` → `confirmDiscardUnsaved(action, 'page-unload')`) and wait for the
 *  human's Save / Discard / Cancel.
 *
 *  **Two phases, because one timeout cannot serve both jobs.** The human may take minutes over the
 *  modal, so the answer itself has no deadline. But a HUNG renderer never answers at all, and a gate
 *  that waits forever on one would make the window unclosable. So the renderer ACKs the moment the
 *  request lands (before it asks anything), and only the ack has a deadline:
 *  - no renderer to ask, or no ack within `ackTimeoutMs` → **proceed**. A renderer that cannot
 *    answer cannot save either, and the user must always be able to close the app;
 *  - acked → wait for the final answer, however long it takes;
 *  - the renderer dies mid-question (`releaseAll`) → proceed, for the same reason.
 *
 *  Pure over an injected `send` and timer, so the policy is unit-tested without Electron. */

export interface UnsavedGateRequest { id: number; action: string }
export interface UnsavedGateReply { id: number; stage: 'ack' | 'final'; proceed?: boolean }

export interface UnsavedGateClientOptions {
  /** Deliver a request to the renderer. False when there is no live renderer to deliver it to. */
  send: (req: UnsavedGateRequest) => boolean;
  ackTimeoutMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

export interface UnsavedGateClient {
  /** Resolves true when `action` may proceed. Never rejects. */
  ask: (action: string) => Promise<boolean>;
  /** Route a `unsaved-gate-reply` bridge event here. */
  onReply: (reply: unknown) => void;
  /** The renderer is gone (window closed, reload, crash): every pending question proceeds. */
  releaseAll: () => void;
  /** Is a question outstanding? Main uses it to ignore a second close while the first is asked. */
  pending: () => boolean;
}

export function createUnsavedGateClient(opts: UnsavedGateClientOptions): UnsavedGateClient {
  const ackTimeoutMs = opts.ackTimeoutMs ?? 3000;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const waiting = new Map<number, { resolve: (v: boolean) => void; ackTimer: unknown }>();
  let nextId = 1;

  const settle = (id: number, proceed: boolean) => {
    const w = waiting.get(id);
    if (!w) return;
    waiting.delete(id);
    if (w.ackTimer !== null) clearTimer(w.ackTimer);
    w.resolve(proceed);
  };

  return {
    ask: (action) => new Promise<boolean>((resolve) => {
      const id = nextId++;
      const ackTimer = setTimer(() => {
        console.warn(`[modoki-electron] unsaved-work gate: no answer from the renderer in ${ackTimeoutMs}ms — proceeding with "${action}"`);
        settle(id, true);
      }, ackTimeoutMs);
      waiting.set(id, { resolve, ackTimer });
      if (!opts.send({ id, action })) settle(id, true);
    }),
    onReply: (reply) => {
      const r = reply as Partial<UnsavedGateReply> | null;
      if (!r || typeof r.id !== 'number') return;
      const w = waiting.get(r.id);
      if (!w) return;
      if (r.stage === 'ack') {
        if (w.ackTimer !== null) clearTimer(w.ackTimer);
        w.ackTimer = null;
        return;
      }
      // Anything but an explicit true keeps the window: a malformed final answer from a live
      // renderer is a bug to see, not a reason to throw its work away.
      settle(r.id, r.proceed === true);
    },
    releaseAll: () => { for (const id of [...waiting.keys()]) settle(id, true); },
    pending: () => waiting.size > 0,
  };
}
