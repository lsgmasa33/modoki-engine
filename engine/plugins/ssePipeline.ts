/**
 * Every SSE stream ends with a status (#1259).
 *
 * The host-owned SSE routes (`/api/build`, `/api/ota/publish`, `/api/add-native-target`,
 * `/api/toolchain/install`) tell their dialog they are finished in exactly one way: the handler
 * sends a final `DONE` or `FAILED:…` status and ends the response. A REJECTION skips that path, and
 * before this module nothing else took it:
 *
 *  - the pipelines run in a DETACHED async body, so a rejection there reaches no caller. The build and
 *    OTA pipelines had only a `.finally` that freed the slot: the response stayed open and the dialog
 *    spun until a human closed it. Observed: `healNativeProject` rejects on a malformed project
 *    `package.json` (`ensureCapacitorDeps`'s bare `JSON.parse`);
 *  - the middleware itself is an `async` function, and connect catches only a SYNCHRONOUS throw. A
 *    rejection in the ~700 lines between a route setting its SSE headers and starting its pipeline
 *    spun the dialog too — and for `/api/build` it also held the build slot, which releases on the
 *    response's `close`, until the dialog was dismissed.
 *
 * So both seams go through this module rather than through a `try` at each await that might throw.
 * A per-site `try` is still worth having where it can WORD the failure better (the generated-input
 * writes in `/api/build`); it is no longer the only guard.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

/** The slice of a response this module touches — narrow so a test can hand it a plain object. */
export type SseResponse = Pick<ServerResponse, 'writableEnded' | 'destroyed' | 'headersSent' | 'getHeader' | 'write' | 'end'>;

/** Never throws: this runs inside the handler that exists to catch a failure, so a rejection value
 *  whose `String()` throws (a null-prototype object, a throwing `toString`) must not escape it. */
function messageOf(err: unknown): string {
  try {
    return err instanceof Error ? err.message : String(err);
  } catch {
    return 'unknown error (the rejection value could not be converted to text)';
  }
}

/** True for a response that has declared itself an SSE stream (the routes set this header before
 *  any other write). */
export function isSseResponse(res: SseResponse): boolean {
  return String(res.getHeader('Content-Type') ?? '').startsWith('text/event-stream');
}

/**
 * End an SSE response as a failed job: `FAILED:<headline>\n<message>`, then `end()`. The message rides
 * in the status only — every client shows a status's detail, and the Build Support dialog also appends
 * each log line, so a separate `ERROR:` line printed the message twice there.
 *
 * Writes NOTHING when the response is already over — ended by the handler (a rejection after the
 * handler's own `res.end()`, whether that followed `DONE` or a deliberate `FAILED:` refusal, must not
 * append a second verdict) or destroyed by a client disconnect (there is nobody to tell). Returns
 * whether it wrote.
 */
export function failSseResponse(res: SseResponse, headline: string, err: unknown): boolean {
  if (res.writableEnded || res.destroyed) return false;
  const message = messageOf(err);
  try {
    res.write(`event: status\ndata: ${JSON.stringify(`FAILED:${headline}\n${message}`)}\n\n`);
  } catch { /* client disconnected between the check and the write */ }
  try { res.end(); } catch { /* same */ }
  return true;
}

/**
 * Run a route's detached pipeline so that a rejection anywhere in `body` still ends the stream with a
 * `FAILED:` status. `onEnd` (the build slot's `onPipelineEnd`) runs exactly once, after the body
 * settles either way — the same guarantee the bare `.finally` gave.
 *
 * `body` is started synchronously, so a route that marks its pipeline started immediately before the
 * call still has no `await` between the mark and the body's first statement.
 */
export function runSsePipeline(
  res: SseResponse,
  headline: string,
  body: () => Promise<void>,
  onEnd?: () => void,
): Promise<void> {
  let run: Promise<void>;
  try {
    run = body();
  } catch (e) {
    run = Promise.reject(e);
  }
  return run
    .catch((e: unknown) => {
      failSseResponse(res, headline, e);
      logRejection(headline, e);
    })
    .finally(() => { onEnd?.(); });
}

type Next = (err?: unknown) => void;

/** Log a rejection AFTER the stream has its verdict, and never throw: `console.error` inspects the
 *  value, and a value whose `util.inspect.custom` throws would otherwise escape the catch before the
 *  status was written. */
function logRejection(where: string, e: unknown): void {
  try {
    console.error(`[sse] ${where}: rejected —`, e);
  } catch {
    try { console.error(`[sse] ${where}: rejected (the value could not be logged)`); } catch { /* nothing left to do */ }
  }
}

/**
 * Wrap an `async` connect middleware so its rejection is not dropped. An open SSE response is ended
 * with a `FAILED:` status (the dialog's only signal); anything else goes to `next(err)` — exactly what
 * connect already does for a SYNCHRONOUS throw, so a non-SSE route's rejection now fails the way its
 * throw always did instead of leaving the request hanging.
 */
export function catchMiddlewareRejection<Req extends IncomingMessage, Res extends SseResponse>(
  handler: (req: Req, res: Res, next: Next) => Promise<void>,
): (req: Req, res: Res, next: Next) => void {
  return (req, res, next) => {
    handler(req, res, next).catch((e: unknown) => {
      if (isSseResponse(res)) failSseResponse(res, 'Unexpected error', e);
      else if (!res.writableEnded && !res.destroyed) next(e);
      logRejection(`${req.method ?? ''} ${req.url ?? ''}`, e);
    });
  };
}
