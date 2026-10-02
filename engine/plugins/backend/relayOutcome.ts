/** What became of one relayed M→R op — the ONE place that decides it (#1957).
 *
 *  `ctx.requestBrowser` either resolves with what the renderer sent back or rejects, and the router
 *  used to answer "did the renderer answer, and what did it mean?" separately at each route: a §5
 *  refusal decoded as an unreadable shape (scene-mutate told the agent "may have ALREADY APPLIED" about
 *  a call that changed nothing), a literal 500, a timeout reported as a retryable NOT_AVAILABLE_HERE, a
 *  status helper used as a guard, and a bare `catch {}` that skipped a refusal. Each route re-derived
 *  the answer, and each derivation was wrong in its own way. So the answer is derived HERE, once, and
 *  the routes read a discriminated union.
 *
 *  ## The four ways a relay can fail
 *
 *  | `RelayFailure`  | What it proves                                         | Status | Guard may treat as "no renderer" |
 *  |-----------------|--------------------------------------------------------|--------|----------------------------------|
 *  | `timeout`       | the request was SENT and no answer came: outcome UNKNOWN | 504 + `TIMEOUT` | no — a busy renderer IS attached |
 *  | `unreachable`   | no surface to deliver to, or it was torn down          | 504    | yes                              |
 *  | `unregistered`  | delivered, but nothing has the op (`unknown agent op`) | 504    | no — a window may hold state     |
 *  | `op-threw`      | the op ANSWERED, by throwing                           | 400    | no                               |
 *
 *  (A teardown is `unreachable` because the live world died with the renderer. An op with a DISK effect in flight at
 *  that moment — save-all, an asset write — may still have finished; that residue is accepted, not proven away.)
 *
 *  ⚠️ **A timeout is "delivered, outcome unknown", never "not delivered".** Both transports send the
 *  request and THEN arm their timer (`requestRenderer` in `electron/main.ts`; the Vite registry), and
 *  the renderer has no cancellation path — so a write that times out may still apply. Reporting it as a
 *  retryable gateway failure told an agent to retry an `addEntity` and make two entities. It travels
 *  as `code:'TIMEOUT', delivered:true` with options that say to re-read before retrying.
 *
 *  ⚠️ **`relayProvesNoRenderer` and `relayFailureStatus` are two questions with OPPOSITE safe answers**
 *  on `unknown agent op` and on a timeout (#1013 close-out F1): a status says "could not look", a guard
 *  must prove nothing is at risk. Both are derived from `classifyRelayFailure` below, so they cannot
 *  drift — but they must stay two functions. See the banner on `relayProvesNoRenderer` below. */
import { ERROR_CODES, type ErrorCode } from '../../tools/shared/mcpResult';

/** The transport's own word that a request was SENT and no reply came in time. Thrown by both hosts'
 *  relays; the message is unchanged, so a caller that only has the string still classifies it. */
export class RelayTimeoutError extends Error {
  /** Always true: the timer is armed after the send. The field is what makes that a fact a reply can carry. */
  readonly delivered = true as const;
  constructor(message: string) {
    super(message);
    this.name = 'RelayTimeoutError';
  }
}

export type RelayFailure = 'timeout' | 'unreachable' | 'unregistered' | 'op-threw';

function messageOf(e: unknown): string {
  return String(e instanceof Error ? e.message : e);
}

/** Did the relay itself fail, rather than the op answering? The single maintained list of both
 *  hosts' transport wordings — every string `failPendingRenderer` (electron/main.ts) and the Vite
 *  HMR relay actually send.
 *
 *  ⚠️ **Extracted (#867) because a SECOND hand-copy was written and was born incomplete.** The
 *  move/delete repair added its own regex to decide "no renderer" vs "the repair failed", and it
 *  missed `no editor renderer window`, `editor window closed`, `project changed — renderer
 *  reloading` and `Object has been destroyed` — every Electron string, i.e. the whole default
 *  editor surface. This list has now been found incomplete three times by review; a copy of it is
 *  the wrong shape of thing to own. Read the history above before touching the pattern. */
export function isRelayTransportFailure(msg: string): boolean {
  return /no (editor )?renderer|unknown agent op|timed out waiting for the (renderer|browser)|renderer went away|renderer reloading|window (is )?closed|object has been destroyed|\b(renderer|window|webcontents|view)\b (has been |was |is )?destroyed|websocket not ready/i.test(msg);
}

/** Was the relay failure a TIMEOUT — sent, and the renderer never answered in the window?
 *  The typed error is the transport's own statement; the wording is kept as a fallback for a caller
 *  holding only the message (and for a transport that predates the class). */
export function isRelayTimeout(e: unknown): boolean {
  if (e instanceof RelayTimeoutError || (e instanceof Error && e.name === 'RelayTimeoutError')) return true;
  return /timed out waiting for the (renderer|browser)/i.test(messageOf(e));
}

/** The one classifier. Every relay rejection the router sees goes through here. */
export function classifyRelayFailure(e: unknown): RelayFailure {
  if (isRelayTimeout(e)) return 'timeout';
  const msg = messageOf(e);
  if (/unknown agent op/i.test(msg)) return 'unregistered';
  return isRelayTransportFailure(msg) ? 'unreachable' : 'op-threw';
}

/** Which status a thrown relay error deserves.
 *
 *  Everything used to be a **504**, which reads as "the editor hung" — so a DELIBERATE, correct
 *  refusal was indistinguishable from a dead renderer. Measured while running batch use case 8:
 *  `load-scene` refused because the editor had unsaved live-world changes (exactly right, and its
 *  message says what to do), and it arrived as `backend 504`. An agent reading that chases a
 *  wedged editor instead of calling `save_all`.
 *
 *  Only the RELAY's own failures are gateway failures; an error the op raised is the op answering,
 *  so it is a 400. The two transport signatures come from `requestRenderer` in `electron/main.ts`
 *  (and the Vite HMR relay's equivalents). Matching on the message is deliberately conservative:
 *  an unrecognized error is treated as the OP speaking, which is the common case. */
export function relayFailureStatus(e: unknown): number {
  // Match BOTH hosts' relay wordings. This listed only the Electron strings, so on the Vite dev
  // server every renderer transport failure — "timed out waiting for the BROWSER", "dev server
  // websocket not ready" — fell through to 400 and surfaced as REFUSED_BY_OP: an unreachable
  // renderer reported as a deliberate op refusal, which is the "could not look" vs "it said no"
  // confusion §5 exists to prevent, mirrored across the two backends (§9).
  //
  // The list must cover every string `failPendingRenderer` (electron/main.ts) actually sends, and
  // it did not (independent review, 2026-07-30): `'project changed — renderer reloading'` fell
  // through to 400, so a request killed by a deliberate renderer TEARDOWN was reported to the
  // agent as an op refusal — the same could-not-look/it-said-no inversion this function exists to
  // fix, in the opposite direction. (`'editor window closed'` was already covered by `window
  // closed`.) A teardown is retryable once the renderer is back; a refusal is not, so telling the
  // two apart changes what the agent does next.
  // ⚠️ **`project changed` was REMOVED as a bare alternative** — subject-less, exactly what the
  // `destroyed` scar below says must never recur, and strictly redundant: its only producer
  // (`electron/main.ts`) sends `'project changed — renderer reloading'`, which the
  // `renderer reloading` alternative already matches. Left in place it would have let any op
  // refusal whose prose contains "project changed" make `relayProvesNoRenderer` return true, and
  // that hard-codes `mutateUnsaved = absent` and writes the scene file.
  // ⚠️ **`unknown agent op` is here because the op being ABSENT is "could not look", not "it said
  // no"** (#1013 close-out F5). `runAgentOp` throws it when the bridge is connected from a game
  // page rather than `#/editor`, or in the window before `registerEditorAgentOps()` has run — so
  // every editor-only route (`eval`, `eval-api`, `editor-journal`, `wait-for-edit`) hits it during
  // a normal launch race. Adopting `relayFailureStatus` at those routes moved them from 504 →
  // `NOT_AVAILABLE_HERE` to 400 → `REFUSED_BY_OP`, and `ERROR_CODES` defines the latter as "the
  // operation itself declined" — a claim about an operation that does not exist. Subject-named, per
  // the scar below: `unknown agent op`, never a bare `unknown`.
  // ⚠️ **`destroyed` WAS A BARE ALTERNATIVE, AND IT MATCHED THE REFUSALS THIS FUNCTION EXISTS TO
  // PROTECT** (bug BHdZZ52JIu4afJmoX7O6). It is here for Electron's own `Object has been
  // destroyed`, thrown when a BrowserWindow/webContents dies mid-request — a genuine transport
  // failure. But `load-scene`'s unsaved-work refusal reads "…the scene edits would be DESTROYED
  // (gone from the world, the file, and the undo stack)", so an op answering clearly and correctly
  // was reported as `HTTP 504 / NOT_AVAILABLE_HERE`: "this editor cannot do that", when the truth
  // was "save first, or pass discardUnsaved". That is precisely the could-not-look vs it-said-no
  // inversion described above, produced BY the fix for it.
  //
  // Reproduced 2026-08-22 against a live editor: create_entity, then load_scene with no
  // discardUnsaved → 504 with the correct message. The wording that tripped it is the WORD
  // "destroyed" in ordinary prose, so the lesson generalises: every alternative here must name its
  // SUBJECT. A bare verb will eventually appear in an op's own explanation of what it refuses to
  // do — that is the vocabulary these messages are written in.
  // ⚠️ `\b` around the subject group, and it is NOT decoration: without it `view` matches inside
  // `preview`, `overview` and `review`, so "…the PREVIEW was destroyed…" would be misclassified as
  // transport — this fix reintroducing its own bug one word smaller. Caught in review, before it
  // could bite.
  return classifyRelayFailure(e) === 'op-threw' ? 400 : 504;
}

/** **Does this relay rejection PROVE there is no renderer holding state we must respect?**
 *
 *  ⚠️ **Fail-closed by construction, because the two questions that look alike have OPPOSITE safe
 *  answers** (#1013 close-out F1 — a data-loss regression this file's own shape invited).
 *  `isRelayTransportFailure` answers "did the transport fail", which is the right question for a
 *  STATUS (`relayFailureStatus`) and the wrong one for a GUARD. A guard needs "can I prove nothing
 *  is at risk", and `unknown agent op` is exactly the case where those diverge: the editor ops are
 *  absent, but the WINDOW may be very much alive and holding unsaved work.
 *
 *  The scar: #1013 added `unknown agent op` to `isRelayTransportFailure` — correct for the routes
 *  it was fixing, where an absent op really is "could not look". `unsavedGate` and
 *  `applyMovesInRenderer` were immune because each already tested that string explicitly first.
 *  `/api/scene-mutate`'s state probe was not, and its comment said it used "the same classifier
 *  pair as `unsavedGate`, deliberately not a second copy" — but `unsavedGate` is the pair PLUS a
 *  guard, so it had copied the half that could not stand alone. Measured on the broken tree: a
 *  mutate that answered **503 NO_RENDERER, file untouched** became **200 `ok:true, changed:1` with
 *  the file rewritten**, skipping the unsaved-work probe entirely and hot-reloading the scene out
 *  from under live edits. Reachable two ways — ⚠️ **the first is CLOSED as of #1030**, which made
 *  the relay settle on the first AUTHORITATIVE reply; it is kept here because the guard must not
 *  depend on that, and because the second way is still open. The relay is a BROADCAST and was
 *  first-reply-wins, so a
 *  second tab on the runtime route answers `unknown agent op` instantly and beats the editor tab;
 *  and the launch race / a bridge connected from a game page rather than `#/editor`, which
 *  `relayFailureStatus`'s own comment already names.
 *
 *  ⚠️ An earlier version of this banner also claimed *"a game-code boot fault means
 *  `registerEditorAgentOps()` never runs"*. **That is refuted by the tree** — `gameBootFaults.ts`
 *  is the module that FIXED it, and every game hook now goes through `runGameHook`
 *  (`editor/setup.ts`), which catches, records the fault and returns, so step 5's
 *  `registerEditorAgentOps()` is unconditionally reached; an import-time throw falls back to
 *  `virtual:modoki-games`. Corrected rather than deleted because it would have sent anyone
 *  debugging a live `unknown agent op` to read a module that cannot produce one.
 *
 *  ⚠️ `applyMovesInRenderer` deliberately does NOT use this and must not be "made consistent": it
 *  is a REPAIR path, so a build that genuinely never registered the editor ops has nothing in
 *  memory to repair and `absent` is its safe answer. Same string, opposite correct outcome — which
 *  is the whole reason this is a named question rather than a shared predicate.
 *
 *  ⚠️ **That is the honest scope of the blessing, and it is narrower than it first read.**
 *  `apply-asset-path-moves` is itself registered inside `registerEditorAgentOps`, so under the
 *  broadcast race above `unknown agent op` does NOT prove the editor tab lacks it — a live editor
 *  can be holding bindings and a parked write on the old path while a runtime tab answers first,
 *  and that repair is skipped SILENTLY (no warn, no `repairFailed`).
 *
 *  ⚠️ **FIXED in #1030 — at the TRANSPORT, not here.** A client with no handler for an op now
 *  answers `{declined:true}` instead of rejecting, and the registry counts declines, settling
 *  `absent` only once every announced bridge client has declined. So `unknown agent op` reaching
 *  this function now really does mean nothing out there has the op. The asymmetry this banner
 *  describes is unchanged and still deliberate; what is gone is the race that made it dangerous.
 *  Do not add a second guard at that site for it. */
export function relayProvesNoRenderer(e: unknown): boolean {
  // The ops being unregistered says nothing about whether a window is up holding state, and a TIMEOUT
  // is a busy renderer that IS attached: only `unreachable` proves the absence.
  return classifyRelayFailure(e) === 'unreachable';
}

/** What a route answers for a relay rejection — status and body, from the one classifier.
 *  A timeout names itself (`TIMEOUT`, `delivered:true`) so the agent re-reads before it retries; the
 *  other kinds keep the shape they always had, whose status alone already carries their code. */
export function relayFailureReply(e: unknown, prefix = ''): { status: number; body: Record<string, unknown> } {
  const error = `${prefix}${messageOf(e)}`;
  // The status comes from `relayFailureStatus`, the one place a relay status is named (`relayRefusalStatus.test.ts`).
  const status = relayFailureStatus(e);
  if (classifyRelayFailure(e) !== 'timeout') return { status, body: { error } };
  return {
    status,
    body: {
      error: `${error} — the request WAS delivered, so whether it applied is UNKNOWN (the editor cannot cancel it).`,
      code: 'TIMEOUT' satisfies ErrorCode,
      delivered: true,
      options: [
        'if this call CHANGES something, re-read the state it targets (modoki_get_scene_state / modoki_get_editor_state) before retrying — a retried create applies twice',
        'a read is safe to retry once the editor is responsive (modoki_identity is the cheapest probe)',
      ],
    },
  };
}

/** An op that answered with a §5 refusal ENVELOPE rather than a result (#994), or null.
 *
 *  The discriminator is a `code` from the CLOSED set (`mcpResult.ts`'s `ERROR_CODES`) alongside
 *  `ok:false` — deliberately narrow, because the ordinary `{ok:false, reason}` an op returns for a
 *  bad parameter must keep its 200 + `isFailureBody` handling. Only an op that has named a code is
 *  claiming to know which §5 failure this is, and only that claim earns a status of its own.
 *
 *  ⚠️ Why a route must relay this at all, when the op could just throw: it CANNOT. A throw becomes
 *  a hard-coded 504 at ~24 catch sites, which the MCP client reads as `NOT_AVAILABLE_HERE` — "the
 *  route is absent". So an op that knows the real code has no way to say it except by RETURNING it,
 *  and the route has no way to honour it except by looking. That is the inversion #994 fixes. */
export function opRefusal(result: unknown): { code: ErrorCode; error?: string; options?: string[] } | null {
  if (!result || typeof result !== 'object') return null;
  const r = result as { ok?: unknown; code?: unknown };
  if (r.ok !== false || typeof r.code !== 'string') return null;
  if (!(ERROR_CODES as readonly string[]).includes(r.code)) return null;
  return result as { code: ErrorCode; error?: string; options?: string[] };
}

/** The HTTP status a §5 refusal travels on. The CODE is what the agent reacts to (`codeFromBody`
 *  in the MCP client lets a body code beat the status-derived one), so this only has to avoid
 *  lying to anything that reads the status alone — and 200 would, since `writeDataUrlToTemp` never
 *  ran and there is no frame.
 *
 *  503 for `NO_RENDERER` matches every envelope this router already emits for it — one in the
 *  unsaved-work probe and two in `/api/scene-mutate` (grep `code: 'NO_RENDERER'`; all three are
 *  503). ⚠️ That count was wrong on the first attempt too, in the very comment written to stop
 *  citing stale line numbers — so grep it, do not trust this sentence's arithmetic either.
 *
 *  One code, one status, so the mapping is a rule rather than a per-site choice. Anything the ops
 *  start naming beyond `NO_RENDERER` is still the op ANSWERING, which `relayFailureStatus` (below)
 *  already argues is a 400 rather than a gateway failure.
 *
 *  ⚠️ Deliberately NOT citing line numbers: they were `:1028`/`:2372` when written and one of
 *  them already pointed at nothing two commits later. A line number in a comment is the
 *  shadowing-constant class — it has to be kept in sync by hand and silently goes stale. */
export function refusalStatus(code: ErrorCode): number {
  return code === 'NO_RENDERER' ? 503 : 400;
}

export type RelayOutcome =
  /** The op returned something that is not a §5 refusal envelope. */
  | { kind: 'answered'; value: unknown }
  /** The op returned a §5 refusal envelope (`opRefusal`). */
  | { kind: 'refused'; body: Record<string, unknown>; code: ErrorCode }
  /** The relay rejected; `failure` says what that proves. */
  | { kind: 'failed'; failure: RelayFailure; error: unknown };

/** Relay one op and say what became of it. Never throws. */
export async function relayOp(
  ctx: { requestBrowser(op: string, params: unknown, timeoutMs?: number): Promise<unknown> },
  op: string, params: unknown, timeoutMs?: number,
): Promise<RelayOutcome> {
  let raw: unknown;
  try {
    raw = await ctx.requestBrowser(op, params, timeoutMs);
  } catch (e) {
    return { kind: 'failed', failure: classifyRelayFailure(e), error: e };
  }
  const refusal = opRefusal(raw);
  return refusal ? { kind: 'refused', body: raw as Record<string, unknown>, code: refusal.code } : { kind: 'answered', value: raw };
}
