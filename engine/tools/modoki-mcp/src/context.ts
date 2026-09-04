/** The MCP server's transport + formatting context — everything a tool handler needs to
 *  reach the editor backend, with NO module-level side effects.
 *
 *  WHY THIS IS A FACTORY, not module-level consts (which is what it was): `index.ts` used to
 *  hold all of this AND call `main()` at import, so vitest could not import the tool surface at
 *  all. Guard tests were reduced to scanning source as TEXT (see the header of
 *  `engine/tests/tools/mcpFormatterGuard.test.ts`), and a tool could be — and was — 100% dead
 *  while the suite stayed green: `modoki_prefab` 400'd on EVERY call for months.
 *
 *  So the backend is a PARAMETER, not `process.env` read at import: a test constructs a context
 *  pointed at a stub backend and calls real handlers. Only `index.ts` reads the environment.
 *
 *  Keep this module free of side effects. */

import { createFormatter, isFailureBody, ERROR_CODES, type ToolResult, type ToolErrorDetail, type ErrorCode } from './result.js';
import { identityMismatch, tokenMismatchWarning, describeIdentity, type BackendIdentity } from '../../shared/identity.js';

export type ToolContext = {
  /** Backend base URL, trailing slash stripped. Interpolated into error messages. */
  backend: string;
  /** Formatters: compact, size-capped, identity-warning-banners. See `result.ts`. */
  ok: (data: unknown) => ToolResult;
  /** The §5 structured refusal — and the ONLY way to fail. `tool` may be omitted; `registerAll`
   *  stamps it from the registered name.
   *
   *  There is deliberately NO free-text `err(msg)` on this context any more. There was, and it is
   *  how the surface reported the same failure four different ways: nothing forced a call site to
   *  supply a code, a cause, or the options, so most sites supplied none of the three. Removing it
   *  makes §5 enforced by the TYPE CHECKER rather than by a guard test that has to notice a new
   *  call site. If a failure genuinely has no useful code, that is a signal the code set is
   *  missing one — extend `ERROR_CODES` deliberately instead of routing around it. */
  fail: (detail: ToolErrorDetail) => ToolResult;
  /** A backend 4xx/5xx as a §5 envelope. For tools that use raw `call` and shape the body
   *  themselves; `getJson`/`postJson` apply it for you. */
  httpFailure: (what: string, status: number, body: unknown) => ToolResult;
  /** Raw call — parsed JSON (or text) + HTTP status. Prefer getJson/postJson. */
  call: (path: string, init?: RequestInit, timeoutMs?: number) => Promise<{ status: number; body: unknown }>;
  /** True when `body` is the SPA's `index.html` rather than JSON — a missing `/api` route on the
   *  dev server falls through and answers 200 with the app shell (V3). `getJson`/`postJson` apply
   *  this for free; exposed (#648) for the rare raw-`call()` site that cannot use them (a §5 label
   *  more specific than `getJson` hardcodes, or a shape guard that must not throw into `getJson`'s
   *  own `transform`-then-catch) but still needs the same guard. */
  htmlFallthrough: (body: unknown) => boolean;
  /** The `NOT_AVAILABLE_HERE` envelope for a `htmlFallthrough` hit — see above. */
  noSuchRoute: (path: string) => ToolResult;
  /** GET = "tell me this" → `ok` in the body may be the ANSWER (`diagnose`, `validate_scene`),
   *  so this deliberately does NOT run `isFailureBody` BY DEFAULT. See the C7 convention in
   *  `docs/debug-tools-mcp.md`; do not "fix" that by flipping the default.
   *
   *  Pass `checkFailure:true` for a MUTATING GET (`?action=`/`?clear=` — where `ok` IS a success
   *  flag, not an answer). Without it, `modoki_journal {action:'start'}` missing its `type` reported
   *  the route's `{ok:false, reason:…}` refusal as a successful call (measured live, Phase 6). */
  /** `transform` (#370) rewrites the parsed body just before it is encoded — and is applied to a
   *  4xx body too, so a failure envelope cannot carry what the transform exists to remove. Added so
   *  a tool can REDACT a secret without dropping to raw `call`: doing that loses the unreachable-
   *  backend envelope, the SPA-fallthrough guard (a dev server answers a missing /api route with
   *  index.html, 200) and the `ensureIdentity` wrong-clone banner — three guarantees that are
   *  invisible until the day they matter. */
  getJson: (path: string, timeoutMs?: number, checkFailure?: boolean, transform?: (body: unknown) => unknown) => Promise<ToolResult>;
  /** POST = "do this" → `ok` is a SUCCESS FLAG, so this DOES run `isFailureBody` (C7).
   *  `what` labels the failure envelope in the CALLER's terms (§5): without it a refusal reads
   *  "POST /api/scene-mutate on the editor backend", which describes our plumbing rather than the
   *  thing the caller asked for. Pass it wherever the intent isn't obvious from the route. */
  postJson: (path: string, payload: unknown, timeoutMs?: number, what?: string) => Promise<ToolResult>;
  evalRenderer: (code: string, timeoutMs?: number) => Promise<ToolResult>;
  editorAction: (action: string, params?: Record<string, unknown>, timeoutMs?: number) => Promise<ToolResult>;
  unsavedChangesWarning: () => Promise<string | null>;
  consumeBuildStream: (path: string, timeoutMs: number) => Promise<ToolResult>;
  ensureIdentity: () => Promise<void>;
  unreachable: (e: unknown) => ToolResult;
  /** The armed "you are driving the OTHER clone's editor" warning, or null. A function, not a
   *  value: it is armed asynchronously by the first `ensureIdentity()`, so a snapshot taken at
   *  registration time would always read null. `modoki_batch` folds it into its own report. */
  getIdentityWarning: () => string | null;
};

export function createToolContext(config: { backend: string; token?: string }): ToolContext {
  const BACKEND = config.backend.replace(/\/$/, '');

  /** C6 — the instance token identifying WHICH editor+project this config was written for.
   *  Baked into `.mcp.json` by AI → Connect Claude Code. A port names a socket, not an
   *  editor: if another editor now holds our port, the backend refuses these requests (403)
   *  instead of silently applying them to the wrong project. Absent ⇒ send nothing; the
   *  backend validates if-present, so a hand-written config still works. */
  const TOKEN = config.token || '';
  const AUTH_HEADERS: Record<string, string> = TOKEN ? { 'X-Modoki-Token': TOKEN } : {};

  /** Set once the backend has been identified as a DIFFERENT checkout than ours. Prepended
   *  to every tool result, because a mismatch makes every other result a lie — the calls
   *  succeed, they just land in the other clone's editor. */
  let identityWarning: string | null = null;

  /** Compact, size-capped result formatting for every tool — see `result.ts`. */
  const { ok, fail } = createFormatter(() => identityWarning);

  /** Default per-request timeout. A wedged renderer (or a half-open socket) would
   *  otherwise hang the user's Claude session forever with no error. */
  const DEFAULT_TIMEOUT_MS = 30_000;

  /** Call the editor backend. Returns parsed JSON (or raw text) + HTTP status.
   *  Aborts after `timeoutMs` so the MCP tool can't hang indefinitely. */
  async function call(path: string, init?: RequestInit, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<{ status: number; body: unknown }> {
    const res = await fetch(BACKEND + path, {
      ...init,
      // Every call carries the token (C6) — merged UNDER the caller's headers so an explicit
      // Content-Type still wins. Callers only ever pass plain-object headers.
      headers: { ...AUTH_HEADERS, ...(init?.headers as Record<string, string> | undefined) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let body: unknown = text;
    try { body = text ? JSON.parse(text) : undefined; } catch { /* keep raw text */ }
    return { status: res.status, body };
  }

  function unreachable(e: unknown): ToolResult {
    const timedOut = e instanceof Error && e.name === 'TimeoutError';
    return timedOut
      ? fail({
          code: 'TIMEOUT',
          what: `reach the Modoki editor backend at ${BACKEND}`,
          why: 'the backend accepted the request but did not answer in time — the editor may be busy, or the renderer wedged.',
          options: [
            'retry once — a scene load or a shader compile can outlast the default timeout',
            'check the editor is responsive (modoki_identity is the cheapest probe)',
            'if it stays wedged, relaunch it with engine/scripts/launch-editor.sh',
          ],
        })
      : fail({
          code: 'NOT_AVAILABLE_HERE',
          what: `reach the Modoki editor backend at ${BACKEND}`,
          why: `the connection failed — no editor is listening on that port (${e instanceof Error ? e.message : String(e)}).`,
          expected: 'a running editor whose backend port matches MODOKI_BACKEND',
          options: [
            'start the editor: engine/scripts/launch-editor.sh games/<id>',
            // This used to assert "this clone's backend port is 5181" — hardcoded from whichever
            // clone the message was written on, and therefore WRONG on every other one. It sent a
            // reader on modoki-qa (5183) to work-ai2's editor. A hint that confidently names the
            // wrong port is worse than no hint, so state the convention and point at the one
            // source that cannot be stale: the launch banner.
            // …and having said that, this line then enumerated all five ports itself — correct
            // on the day it was written and one more copy to keep in step (#349 found four such
            // copies, two already stale). The convention now has ONE authored home; cite it.
            'each clone pins its own backend port (engine/scripts/editorPorts.mjs; docs/clones-and-ports.md § RULE 2) — set MODOKI_BACKEND (or env.MODOKI_BACKEND in .claude/settings.local.json) to YOUR clone\'s port',
            'the launch banner prints the port it actually bound — trust it over any table',
          ],
        });
  }

  /** A specific code the BACKEND supplied beats one derived from the HTTP status. Three of the
   *  closed set (`AMBIGUOUS`/`AMBIGUOUS_SURFACE`/`OCCLUDED`) are refusals a route can name
   *  precisely — measured live: `modoki_set_transform {entity:{name:'DUP_probe'}}` against two
   *  same-named entities came back as the generic `REFUSED_BY_OP`, indistinguishable from any
   *  other refusal without string-matching prose. `fallback` is whatever this call site would
   *  have used anyway, so an ordinary body with no `code` (or a junk value that isn't in the
   *  closed set) is unaffected. */
  function codeFromBody(body: unknown, fallback: ErrorCode): ErrorCode {
    if (body && typeof body === 'object') {
      const c = (body as { code?: unknown }).code;
      if (typeof c === 'string' && (ERROR_CODES as readonly string[]).includes(c)) return c as ErrorCode;
    }
    return fallback;
  }

  /** A backend HTTP failure, as a §5 envelope. One builder so every route reports a 4xx/5xx the
   *  same way — the audit found `backend ${status}: ${JSON.stringify(body)}` repeated at six sites
   *  and nowhere did it say what the caller should do next. */
  function httpFailure(what: string, status: number, body: unknown): ToolResult {
    // Read BOTH shapes. Our routes use `error` (a single message) and `errors[]` (per-op, e.g.
    // scene-mutate) interchangeably, and reading only the singular form demoted the most useful
    // message to `got` while `why` claimed "HTTP 400 with no explanation" — with the explanation
    // sitting two lines below it in the same payload. Caught end-to-end through the MCP tool; the
    // unit tests all happened to use `{error}` bodies, so none of them could see it.
    const detail = ((): string | undefined => {
      if (!body || typeof body !== 'object') return undefined;
      const b = body as { error?: unknown; errors?: unknown };
      if (typeof b.error === 'string' && b.error) return b.error;
      const list = Array.isArray(b.errors) ? b.errors.filter((e): e is string => typeof e === 'string' && !!e) : [];
      return list.length ? list.join('; ') : undefined;
    })();
    // A 404 is TWO different failures and they must not share a code — this is the "could not look
    // vs nothing is there" distinction §5 is built around, and the first cut of this function got
    // it wrong: it reported EVERY 404 as "the route is absent, relaunch the editor". The live smoke
    // caught it on `validate_scene {path:'…/does-not-exist.json'}`, where the route is perfectly
    // present and it is the SCENE that isn't — sending the reader to relaunch their editor over a
    // typo'd path.
    //
    // Our routes answer a missing RESOURCE with 404 + `{error:'<what> not found: <which>'}`. A
    // genuinely absent route has no such JSON to offer, so the presence of a route-authored error
    // message is the discriminator.
    // A 404 is TWO different failures. The first cut discriminated on "did the body carry an error
    // string", reasoning that an absent route has none to offer — but BOTH hosts author one
    // (`no backend route for …` in electron/backendServer.ts, and `no such API route: …` added to
    // the Vite host by the S2.2 fix in this same audit), so that test classified every missing
    // route as NOT_FOUND, "the named target does not exist". The V3 fix removed the last input
    // that reached the NOT_AVAILABLE_HERE branch and left it dead.
    //
    // Match the two route-miss messages explicitly instead. A message-shape check is a weaker
    // discriminator than a structured flag would be, so both hosts should grow one — but this is
    // the seam that must not be WRONG in the meantime, and both strings are ours.
    const routeMissing = status === 404 && (!detail || /no backend route for|no such API route/i.test(detail));
    const statusCode: ErrorCode = status === 404
      ? (routeMissing ? 'NOT_AVAILABLE_HERE' : 'NOT_FOUND')
      : status >= 500 ? 'NOT_AVAILABLE_HERE' : 'REFUSED_BY_OP';
    const code = codeFromBody(body, statusCode);
    return fail({
      code,
      what,
      why: detail
        ? `the backend refused with HTTP ${status}: ${detail}`
        : `the backend answered HTTP ${status} with no explanation.`,
      got: body,
      ...(routeMissing
        ? { options: ['the route is absent — this editor build may predate the tool; relaunch the editor from this checkout'] }
        : status === 403
          ? { options: ['the backend belongs to a DIFFERENT editor/project (C6) — call modoki_identity, then point MODOKI_BACKEND at your own editor'] }
          : {}),
    });
  }

  /** V3 — a missing `/api` route on the dev server falls through to the SPA and answers **200 with
   *  `index.html`**, which `getJson` then reported as a successful call whose payload happened to be
   *  a string. Measured: every GET tool is exposed to it on the default backend. HTML is never a
   *  valid API payload, so detect it here rather than at 26 call sites. */
  function htmlFallthrough(body: unknown): boolean {
    if (typeof body !== 'string') return false;
    const head = body.slice(0, 200).toLowerCase();
    return head.includes('<!doctype html') || head.includes('<html');
  }

  function noSuchRoute(path: string): ToolResult {
    return fail({
      code: 'NOT_AVAILABLE_HERE',
      what: `read ${path} from the editor backend`,
      why: 'the backend answered 200 with the editor HTML page, not JSON — the dev server has no such route and fell through to the SPA. This is NOT an empty result.',
      expected: 'a JSON body',
      options: [
        'check the route spelling',
        'the route may not exist in this editor build — relaunch the editor from this checkout',
      ],
    });
  }

  /** Ask the backend who it is, once per process, and arm `identityWarning` if it turns out
   *  to be the sibling clone's editor. Best-effort: a backend too old to have the route, or
   *  one that is down, must not break the tool being called — the tool's own error is the
   *  more useful message. Awaited before the first real request so the warning lands on it.
   *  `_identityProbe` is the in-flight promise, so concurrent tool calls share one probe. */
  let _identityProbe: Promise<void> | null = null;
  async function ensureIdentity(): Promise<void> {
    if (_identityProbe) return _identityProbe;
    _identityProbe = (async () => {
      let identified = false;
      try {
        const { status, body } = await call('/api/identity', undefined, 5_000);
        if (status !== 200 || !body || typeof body !== 'object') return;
        const id = body as BackendIdentity;
        if (typeof id.repoRoot !== 'string') return; // an older backend, or a proxy
        // The editor's OWN verdict beats our cwd heuristic: a token mismatch is authoritative
        // (and means every other call is already 403ing), so it wins when both would fire.
        identityWarning = tokenMismatchWarning(id, BACKEND) ?? identityMismatch(id, process.cwd(), BACKEND);
        console.error(identityWarning ?? describeIdentity(id, BACKEND));
        identified = true;
      } catch { /* editor down / route absent — let the real call report it */ }
      finally {
        // MEMOIZE ONLY SUCCESS. This used to memoize the failure too: the promise was assigned
        // before the fetch and the catch swallowed everything, so if the FIRST tool call happened
        // while the editor was still booting — the ordinary case when `claude` and the editor start
        // together — the probe never ran again and the wrong-clone / token-mismatch banner stayed
        // disarmed for the life of the MCP process. Every later call then succeeded silently
        // against a backend nobody had verified. Clearing the memo on failure costs one cheap
        // 5s-capped request on the next call and restores the guarantee.
        if (!identified) _identityProbe = null;
      }
    })();
    return _identityProbe;
  }

  /** `checkFailure` — run `isFailureBody` on a 200, for a GET whose `ok` is a SUCCESS FLAG.
   *
   *  GETs do not check it by default on purpose: for `diagnose`/`validate_scene`, `ok:false` is the
   *  ANSWER ("this scene is unhealthy"), and failing the call would make an honest negative result
   *  look like a broken tool. But the MUTATING GETs are the opposite case — `modoki_journal
   *  {action:'start'}` with no `type` answers `200 {ok:false, reason:'action needs type=…'}`, and
   *  with no check that refusal reached the agent as a SUCCESSFUL call (measured live against the
   *  editor on 5181, Phase 6). Opt in per call site rather than flipping the default, because the
   *  two families genuinely disagree about what `ok` means. */
  async function getJson(
    path: string, timeoutMs?: number, checkFailure?: boolean, transform?: (body: unknown) => unknown,
  ): Promise<ToolResult> {
    try {
      await ensureIdentity();
      const { status, body } = await call(path, undefined, timeoutMs);
      if (status >= 400) return httpFailure(`read ${path} from the editor backend`, status, transform ? transform(body) : body);
      if (htmlFallthrough(body)) return noSuchRoute(path);
      if (checkFailure) {
        const failure = isFailureBody(body);
        if (failure) {
          return fail({
            code: codeFromBody(body, 'REFUSED_BY_OP'),
            what: `GET ${path} on the editor backend`,
            why: failure.split('\n\nfull response:')[0],
            got: body,
          });
        }
      }
      return ok(transform ? transform(body) : body);
    } catch (e) {
      return unreachable(e);
    }
  }

  async function postJson(path: string, payload: unknown, timeoutMs?: number, what?: string): Promise<ToolResult> {
    const label = what ?? `POST ${path} on the editor backend`;
    try {
      await ensureIdentity();
      const { status, body } = await call(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }, timeoutMs);
      // Render endpoints return a 504 with a partial `{paths}` on a mid-sequence
      // failure — surface those frames (not just an error) so the agent keeps what
      // was rendered. The body already carries the error message.
      if (status >= 400) {
        // Render endpoints answer a MID-SEQUENCE failure with a 504 + the frames already written,
        // and those frames are worth keeping. But `paths` is ALWAYS present — empty when the very
        // first frame failed — so this hatch used to turn a TOTAL failure (wedged renderer, no
        // frames at all) into a plain success carrying an empty array. Inside a batch with
        // result:'none' even the error text was dropped and the batch reported ok:true.
        //
        // Keep the frames, but never lose the failure: a non-empty partial is reported as PARTIAL
        // (isError, with the paths in `got`), and an empty one is just a failure.
        const paths = (body as { paths?: unknown })?.paths;
        if (body && typeof body === 'object' && Array.isArray(paths) && paths.length > 0) {
          return fail({
            code: 'PARTIAL',
            what: label,
            why: `the render stopped part-way: ${paths.length} frame(s) were written before it failed (HTTP ${status}). The frames below are real and usable; the sequence is INCOMPLETE.`,
            got: body,
            options: [
              'use the frames that exist, or re-run the sequence after fixing the cause',
              'a shorter sequence, or a longer per-frame budget, usually gets past a mid-sequence timeout',
            ],
          });
        }
        return httpFailure(label, status, body);
      }
      if (htmlFallthrough(body)) return noSuchRoute(path);
      // A 200 whose body says the op didn't happen is a FAILURE — surface it as one (C7).
      const failure = isFailureBody(body);
      return failure
        ? fail({
            code: codeFromBody(body, 'REFUSED_BY_OP'),
            what: label,
            why: failure.split('\n\nfull response:')[0],
            got: body,
          })
        : ok(body);
    } catch (e) {
      return unreachable(e);
    }
  }

  /** Evaluate JS in the editor renderer (`/api/eval`) and shape the reply. The renderer runs
   *  `code` as a function body and safe-stringifies the result, so a THROWN eval comes back as a
   *  successful `{ result: "Error: …" }` string rather than a 4xx — detect that prefix and surface
   *  it as a tool error, so a failed eval is never misread as a successful string value (the same
   *  false-success guard device_eval applies via isDeviceError). */
  async function evalRenderer(code: string, timeoutMs?: number): Promise<ToolResult> {
    try {
      await ensureIdentity();
      // THREE nested deadlines, each strictly larger than the one inside it, or the outermost
      // fires first and reports the wrong cause: eval budget (renderer) < relay (backend, +10s)
      // < this client abort (+15s). The client's 30s default was already smaller than a 25s
      // eval + 10s relay, so it has to be sized here rather than left at the default.
      const clientTimeout = Number.isFinite(timeoutMs) && (timeoutMs as number) > 0
        ? Math.max(50, Math.min(25_000, Math.floor(timeoutMs as number))) + 15_000
        : undefined;
      const { status, body } = await call('/api/eval', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(timeoutMs == null ? { code } : { code, timeoutMs }),
      }, clientTimeout);
      if (status >= 400) return httpFailure('evaluate JS in the editor renderer', status, body);
      const result = (body as { result?: unknown } | null)?.result;
      if (typeof result === 'string' && result.startsWith('Error:')) {
        return fail({
          code: 'REFUSED_BY_OP',
          what: 'evaluate JS in the editor renderer',
          why: `the code threw: ${result}`,
          got: code.length > 400 ? code.slice(0, 400) + '…' : code,
          options: [
            'the renderer runs `code` as a FUNCTION BODY — a bare expression needs an explicit `return`',
            'globals available there: window.__3d (runtime GameView), document, the editor stores',
          ],
        });
      }
      return ok(result);
    } catch (e) {
      return unreachable(e);
    }
  }


  /** POST an editor action to the relay. `action` is the op name; `params` is the
   *  rest of the body. Editor actions can touch scenes/resources, so allow generous
   *  time. */
  async function editorAction(action: string, params: Record<string, unknown> = {}, timeoutMs = 65_000): Promise<ToolResult> {
    // `action` is the ROUTING key of this relay, and the route strips it before relaying — so a
    // param of the same name is UNREACHABLE through here, whichever way the spread is ordered.
    //
    // This has now caught two tools. `modoki_prefab` spread its own args (which include
    // `action:'instantiate'`) over the routing key, so every prefab call sent 'instantiate' as the
    // OP NAME and came back as a 400 listing the valid ops — loud, and fixed by renaming the param
    // to `prefabAction`. The comment left behind ("a tool needing one must pick another name") was
    // a convention with nothing enforcing it, and `modoki_write_player_prefs` walked into the
    // OTHER, quieter half of the same trap: putting `action` LAST protects the routing key, and by
    // doing so it silently DROPS the tool's own param. The op then ran with `action: undefined`.
    // Caught live (#288 Phase 2); T1/T2 could not see it, because the request the tool built was
    // exactly the request the contract declared.
    //
    // So: refuse, rather than document. A dropped argument is a call that does something other
    // than what was asked and reports it as fine — §0's rank-1 false success. A tool that genuinely
    // needs an `action` param belongs on its OWN route (see `/api/player-prefs`), not here.
    if (Object.prototype.hasOwnProperty.call(params, 'action')) {
      return fail({
        code: 'REFUSED_BY_OP',
        what: `run the editor action "${action}"`,
        why: '`action` is this relay\'s routing key and is stripped before the op sees it, so a param '
          + 'of that name is silently dropped rather than delivered. This is a TOOL DEFECT, not a caller mistake.',
        got: { action: params.action },
        options: [
          'rename the tool\'s param (modoki_prefab uses `prefabAction`)',
          'or give the tool its own POST route instead of the /api/editor-action relay',
        ],
      });
    }
    return postJson('/api/editor-action', { ...params, action }, timeoutMs, `run the editor action "${action}"`);
  }

  /** Refuse-reason when the editor has live-world work that is NOT on disk, else null. (C7)
   *
   *  A backend that is genuinely ABSENT (headless, no editor running) must not block a build —
   *  there is no unsaved editor to be stale against, and that is a real answer.
   *
   *  But "could not check" is NOT that answer, and used to be reported as it (independent review,
   *  2026-07-30): a 5s timeout, a non-200, or a malformed body all returned null = "clean, proceed".
   *  A merely BUSY editor (a long scene load, a GLB/KTX2 decode) misses 5s easily, so the gate that
   *  the tool description promises unconditionally — "REFUSED when the editor has UNSAVED live-world
   *  changes" — silently failed OPEN, on the one tool family that ships code to installed apps.
   *  §5 of docs/mcp-tool-conventions.md: could-not-look is never reported as nothing-is-there.
   *
   *  So: unreachable → null (no editor). Answered-and-clean → null. Anything else → refuse, naming
   *  the uncertainty. Every caller already offers `force:true` for a deliberate override. */
  async function unsavedChangesWarning(): Promise<string | null> {
    let status: number;
    let body: unknown;
    try {
      ({ status, body } = await call('/api/editor-state', undefined, 5_000));
    } catch (e) {
      // Distinguish "nothing is listening" from "it did not answer in time". Only the first
      // means there is no unsaved editor; a timeout means we simply do not know.
      const name = e instanceof Error ? e.name : '';
      const msg = e instanceof Error ? e.message : String(e);
      if (name === 'TimeoutError' || name === 'AbortError' || /timed? ?out/i.test(msg)) {
        return (
          `the editor did not answer /api/editor-state within 5s, so whether it has UNSAVED work is UNKNOWN. ` +
          `A busy editor (scene load, GLB/KTX2 decode) misses that window, and a build reads the scene FILE — ` +
          `proceeding could silently ship an artifact missing live edits.`
        );
      }
      return null; // genuinely unreachable — no editor to be stale against
    }
    if (status !== 200 || !body || typeof body !== 'object') {
      return (
        `could not read the editor's unsaved state (/api/editor-state answered ${status}${
          body && typeof body === 'object' ? '' : ' with an unusable body'
        }), so whether there is UNSAVED work is UNKNOWN — not known to be clean.`
      );
    }
    const st = body as { unsavedChanges?: unknown; scenePath?: unknown };
    if (st.unsavedChanges === false) return null; // answered, and clean
    if (st.unsavedChanges !== true) {
      return (
        `the editor answered /api/editor-state without an \`unsavedChanges\` boolean (got ` +
        `${JSON.stringify(st.unsavedChanges)}), so whether there is UNSAVED work is UNKNOWN.`
      );
    }
    return (
      `the editor has UNSAVED changes, and a build reads the scene FILE — the artifact would be ` +
      `missing them (create_entity / duplicate_entity / prefab edit the live world and do NOT save).`
    );
  }

  /** Consume a build-family SSE stream (/api/build, /api/add-native-target) to
   *  completion. The server emits `event: step|status|message` frames; `status`
   *  carries DONE | FAILED:<tail> | <progress>. Returns the final outcome + a log
   *  tail so the agent sees WHY a build failed, not just THAT it did. */
  async function consumeBuildStream(path: string, timeoutMs: number): Promise<ToolResult> {
    // Like the JSON tools: identify the editor FIRST, so a wrong-editor warning lands on this
    // result too. A build can plausibly be the session's first call, and it's the LAST tool
    // whose target you want to be guessing about.
    await ensureIdentity();
    let res: Response;
    try {
      res = await fetch(BACKEND + path, { headers: { ...AUTH_HEADERS, Accept: 'text/event-stream' }, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      return unreachable(e);
    }
    if (!res.ok || !res.body) {
      // Surface the BODY, not just the status. A 403 here carries the actionable wrong-editor
      // explanation (C6); reporting a bare "build stream did not open" would turn the one
      // message that names the cause into a generic build failure the agent would then go and
      // "debug" against the wrong editor.
      const detail = await res.text().catch(() => '');
      let msg = detail;
      try { msg = (JSON.parse(detail) as { error?: string }).error ?? detail; } catch { /* raw text */ }
      return httpFailure(`open the build stream at ${path}`, res.status, msg || 'build stream did not open');
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const log: string[] = [];
    let buf = '';
    let outcome: { ok: boolean; step?: string; error?: string } | null = null;
    const pushLog = (line: string) => { log.push(line); if (log.length > 200) log.shift(); };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // SSE frames are separated by a blank line.
        let sep: number;
        while ((sep = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          let event = 'message';
          let data = '';
          for (const raw of frame.split('\n')) {
            if (raw.startsWith('event:')) event = raw.slice(6).trim();
            else if (raw.startsWith('data:')) data += raw.slice(5).trim();
          }
          let parsed: unknown = data;
          try { parsed = JSON.parse(data); } catch { /* keep raw */ }
          if (event === 'message') { if (parsed) pushLog(String(parsed)); }
          else if (event === 'status') {
            const status = String(parsed);
            if (status === 'DONE') { outcome = { ok: true }; }
            else if (status.startsWith('FAILED')) {
              const details = status.slice('FAILED:'.length).trim();
              outcome = { ok: false, step: details.split('\n')[0] || 'unknown step', error: details.split('\n').slice(1).join('\n') };
            } else { pushLog(status); }
          }
        }
        if (outcome) break;
      }
    } catch (e) {
      return fail({
        code: 'NOT_AVAILABLE_HERE',
        what: `run the build at ${path}`,
        why: `the build stream broke mid-run: ${e instanceof Error ? e.message : String(e)}. Whether the build itself finished is UNKNOWN — the connection died, not necessarily the build.`,
        got: log.slice(-40).join('\n'),
        options: ['check the editor is still running, then look at its terminal for the rest of the build'],
      });
    } finally {
      try { await reader.cancel(); } catch { /* ignore */ }
    }
    if (!outcome) {
      return fail({
        code: 'NOT_AVAILABLE_HERE',
        what: `run the build at ${path}`,
        why: 'the build stream closed without a final DONE/FAILED status, so the outcome is unknown.',
        got: log.slice(-40).join('\n'),
        options: ['re-run the build', 'check the editor terminal — a crashed build step can close the stream silently'],
      });
    }
    if (!outcome.ok) {
      return fail({
        code: 'REFUSED_BY_OP',
        what: `run the build at ${path}`,
        why: `the build FAILED at step: ${outcome.step}${outcome.error ? ` — ${outcome.error}` : ''}`,
        got: log.slice(-40).join('\n'),
        options: ['fix the cause in the log tail above, then re-run', 'the failing STEP names which stage to look at (web compile / cap sync / native build)'],
      });
    }
    return ok({ ok: true, log: log.slice(-40) });
  }

  return {
    backend: BACKEND,
    ok, fail, httpFailure, call, getJson, postJson, evalRenderer, editorAction,
    unsavedChangesWarning, consumeBuildStream, ensureIdentity, unreachable,
    htmlFallthrough, noSuchRoute,
    getIdentityWarning: () => identityWarning,
  };
}
