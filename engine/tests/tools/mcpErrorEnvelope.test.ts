/** The §5 error envelope, asserted over the REAL tool surface.
 *
 *  `docs/mcp-tool-conventions.md` §5: every failure names what was attempted, why it failed, and
 *  what to do instead. "It didn't work" is a bug by definition.
 *
 *  Why these tests exist as they do:
 *
 *  - **Structured, so it can be asserted.** The audit found the same failure reported four ways,
 *    and no test could tell a deliberate refusal from a wedged renderer because both arrived as
 *    free prose. A closed `code` set gives tests a spine; `what`/`why`/`options` carry specifics.
 *  - **Through the real handlers.** These call the actual tools against a stub backend, so a
 *    classification only passes if the CODE PATH produces it — not because a helper can.
 *  - **The sweep-guard at the bottom is the load-bearing one.** Any tool module that hand-rolls
 *    `{isError: true}` bypasses the envelope entirely, and no per-tool test would notice a NEW
 *    tool doing it. That is exactly how the surface diverged the first time.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadSurface, realRequests, STUB_BACKEND, type Surface } from './mcpSurface';
import { ERROR_CODES, type ErrorCode } from '../../tools/modoki-mcp/src/result';
import { CONTRACTS } from '../../tools/modoki-mcp/src/contracts';
import { getTool } from '../../tools/modoki-mcp/src/registry';

let surface: Surface | undefined;
afterEach(() => { surface?.restore(); surface = undefined; });

/** The envelope, parsed. Fails loudly if the failure is not an envelope at all — which is the
 *  regression these tests are here to catch. */
function envelope(s: Surface, r: { content: Array<{ text: string }>; isError?: boolean }) {
  expect(r.isError, `expected a FAILED tool call, got: ${s.text(r as never)}`).toBe(true);
  const text = s.text(r as never);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`failure was not a parseable §5 envelope — got free text: ${text.slice(0, 300)}`);
  }
  const err = (parsed as { error?: Record<string, unknown> }).error;
  expect(err, `failure JSON has no \`error\` key: ${text.slice(0, 300)}`).toBeDefined();
  return err as { code: ErrorCode; tool?: string; what: string; why: string; got?: unknown; expected?: string; options?: string[] };
}

const TOOLS_DIR = join(__dirname, '../../tools/modoki-mcp/src/tools');

describe('§5 — the shape of a failure', () => {
  it('is a parseable envelope with a code from the CLOSED set, and names the tool', async () => {
    const s = (surface = loadSurface(() => ({ status: 500, body: { error: 'boom' } })));
    const e = envelope(s, await s.call('modoki_get_editor_state'));
    expect(ERROR_CODES).toContain(e.code);
    // Stamped centrally in `registerAll`, so it cannot drift after a rename.
    expect(e.tool).toBe('modoki_get_editor_state');
    expect(e.what).toBeTruthy();
    expect(e.why).toBeTruthy();
  });

  it('a call site that names the tool ITSELF is not overwritten', async () => {
    // `activeScenePath` refuses on behalf of the tool it was called for, passing `tool` explicitly.
    const s = (surface = loadSurface((req) =>
      req.path.startsWith('/api/editor-state') ? { body: { ok: true } } : undefined));
    const e = envelope(s, await s.call('modoki_set_transform', { entity: { name: 'Capsule' }, space: 'local', position: [1, 2, 3] }));
    expect(e.code).toBe('NOT_FOUND');
    // The REGISTERED name, matching the central stamp — the two used to disagree (`set_transform`
    // here vs `modoki_set_transform` from registerAll), so the same field carried two naming
    // conventions and neither the docs' example nor a caller could rely on it.
    expect(e.tool).toBe('modoki_set_transform');
  });
});

describe('§5 — classification: the code must match what actually went wrong', () => {
  it('backend unreachable is NOT_AVAILABLE_HERE, and says how to start the editor', async () => {
    const s = (surface = loadSurface(() => { throw new Error('ECONNREFUSED'); }));
    const e = envelope(s, await s.call('modoki_get_editor_state'));
    expect(e.code).toBe('NOT_AVAILABLE_HERE');
    expect(e.options?.join(' ')).toContain('launch-editor.sh');
    // The port matters: pointed at the sibling clone, every call "succeeds" against the wrong tree.
    // This used to assert the literal `5181` — work-ai2's port, present only because the hint
    // ENUMERATED every clone's port inline. That expectation was wrong in the same way the hint
    // was (#349): a shared string that names one clone's number is correct on one clone and
    // stale the day a clone is added, and the sibling hint in game-debug-mcp proved it by
    // sitting at three-of-five for months. Assert the durable property instead — that the hint
    // names the variable you must set and points at the one place the answer lives.
    expect(e.options?.join(' ')).toContain('MODOKI_BACKEND');
    expect(e.options?.join(' ')).toMatch(/editorPorts\.mjs|clones-and-ports\.md/);
  });

  it('a timeout is TIMEOUT, not a generic failure — a wedged editor is retryable', async () => {
    const s = (surface = loadSurface(() => {
      const e = new Error('timed out'); e.name = 'TimeoutError'; throw e;
    }));
    const e = envelope(s, await s.call('modoki_get_editor_state'));
    expect(e.code).toBe('TIMEOUT');
  });

  it('a 200 whose body says the op did NOT happen is REFUSED_BY_OP (C7), not a success', async () => {
    const s = (surface = loadSurface((req) =>
      req.path === '/api/scene-mutate'
        ? { body: { ok: false, changed: 0, errors: ['unknown trait field "poistion"'] } }
        : undefined));
    const e = envelope(s, await s.call('modoki_set_transform', { entity: { name: 'Capsule' }, space: 'local', position: [1, 2, 3] }));
    expect(e.code).toBe('REFUSED_BY_OP');
    expect(e.why).toContain('poistion');
    // The whole body is kept: `changed`/`warnings`/`hint` are how the caller diagnoses it.
    expect(JSON.stringify(e.got)).toContain('changed');
  });

  // QA-TOOL-0003 — `codeFromBody` (context.ts): a backend that names a SPECIFIC code wins over
  // the generic status-derived one, at both `isFailureBody` refusal sites (getJson's
  // checkFailure branch, and the POST branch here). MEASURED live: with two entities named
  // `DUP_probe`, `modoki_set_transform {entity:{name:'DUP_probe'}}` returned `REFUSED_BY_OP`
  // instead of `AMBIGUOUS` — the generic fallback is what this closes.
  it('a body-supplied `code` wins over the generic REFUSED_BY_OP', async () => {
    const s = (surface = loadSurface((req) =>
      req.path === '/api/scene-mutate'
        ? { body: { ok: false, changed: 0, errors: ["2 entities are named \"DUP_probe\" — address by guid"], code: 'AMBIGUOUS' } }
        : undefined));
    const e = envelope(s, await s.call('modoki_set_transform', { entity: { name: 'DUP_probe' }, space: 'local', position: [1, 2, 3] }));
    expect(e.code).toBe('AMBIGUOUS');
  });

  it('a body with no `code` — or a junk value not in the closed set — still falls back to REFUSED_BY_OP', async () => {
    const s = (surface = loadSurface((req) =>
      req.path === '/api/scene-mutate'
        ? { body: { ok: false, changed: 0, errors: ['unknown trait field "poistion"'] } }
        : undefined));
    const e = envelope(s, await s.call('modoki_set_transform', { entity: { name: 'Capsule' }, space: 'local', position: [1, 2, 3] }));
    expect(e.code).toBe('REFUSED_BY_OP');

    const sJunk = (surface = loadSurface((req) =>
      req.path === '/api/scene-mutate'
        ? { body: { ok: false, changed: 0, errors: ['unknown trait field "poistion"'], code: 'NOT_A_REAL_CODE' } }
        : undefined));
    const eJunk = envelope(sJunk, await sJunk.call('modoki_set_transform', { entity: { name: 'Capsule' }, space: 'local', position: [1, 2, 3] }));
    expect(eJunk.code).toBe('REFUSED_BY_OP');
  });

  it('V3 — a 200 answering the SPA HTML is NOT_AVAILABLE_HERE, never an answer', async () => {
    // Measured on the default backend: a missing `/api` route falls through to the editor page and
    // answers 200 with index.html, which the transport happily reported as a successful read whose
    // payload happened to be a string. Every GET tool was exposed to it.
    const s = (surface = loadSurface(() => ({ status: 200, body: '<!DOCTYPE html><html><body>editor</body></html>' })));
    const e = envelope(s, await s.call('modoki_get_editor_state'));
    expect(e.code).toBe('NOT_AVAILABLE_HERE');
    expect(e.why).toContain('NOT');   // "…This is NOT an empty result."
  });

  // A 404 is TWO failures and must not share one code. The first cut of `httpFailure` mapped every
  // 404 to "the route is absent — relaunch the editor", and the LIVE smoke caught it: a
  // `validate_scene` on a typo'd path sent the reader chasing a phantom editor problem. This test
  // originally asserted that bug, so it is also a reminder that a test written alongside the code
  // pins whatever the author believed, not whatever is true — the live run is what adjudicated.
  it('a 404 naming a missing RESOURCE is NOT_FOUND, and says which one', async () => {
    const s = (surface = loadSurface(() => ({
      status: 404, body: { error: 'scene not found: /assets/scenes/nope.json' },
    })));
    const e = envelope(s, await s.call('modoki_validate_scene', { path: '/assets/scenes/nope.json' }));
    expect(e.code).toBe('NOT_FOUND');
    expect(e.why).toContain('/assets/scenes/nope.json');
    // It must NOT send the reader off to relaunch an editor that is working fine.
    expect(e.options?.join(' ') ?? '').not.toContain('relaunch');
  });

  it('an ABSENT ROUTE is NOT_AVAILABLE_HERE — using the messages the hosts REALLY emit', async () => {
    // This fed `{status:404, body:{}}` — a shape NEITHER backend produces. Both author a message
    // for a missing route (`no backend route for …` from the Electron host; `no such API route: …`
    // added to the Vite host by this audit's own S2.2 fix), so the discriminator "does the body
    // carry an error string" classified every absent route as NOT_FOUND, and this test green-lit a
    // branch nothing could reach. A guard fed an impossible input proves nothing about production.
    for (const body of [
      { error: 'no backend route for GET /api/enact-handles' },                       // Electron host
      { error: 'no such API route: GET /api/enact-handles', hint: 'some routes exist only on the Electron host' }, // Vite host
      {},                                                                              // a bare 404, kept for completeness
    ]) {
      const s = (surface = loadSurface(() => ({ status: 404, body })));
      const e = envelope(s, await s.call('modoki_get_editor_state'));
      expect(e.code, JSON.stringify(body)).toBe('NOT_AVAILABLE_HERE');
      expect(e.options?.join(' '), JSON.stringify(body)).toContain('relaunch');
      s.restore(); surface = undefined;
    }
  });

  it('…and a missing RESOURCE 404 is still NOT_FOUND — the two must not collapse together', async () => {
    const s = (surface = loadSurface(() => ({ status: 404, body: { error: 'scene not found: /assets/scenes/nope.json' } })));
    expect(envelope(s, await s.call('modoki_validate_scene', { path: '/assets/scenes/nope.json' })).code).toBe('NOT_FOUND');
  });

  it('reads the cause from `errors[]` too, not only `error` — else `why` claims there is none', async () => {
    // Our routes use both shapes interchangeably (scene-mutate answers per-op `errors[]`). Reading
    // only the singular form demoted the real message into `got` while `why` said "HTTP 400 with no
    // explanation" — with the explanation two lines below it in the same payload. Every unit test
    // here happened to use an `{error}` body, so only an end-to-end call could see it.
    const s = (surface = loadSurface((req) =>
      req.path === '/api/scene-mutate'
        ? { status: 400, body: { ok: false, changed: 0, errors: ['setTrait names field(s) that do not exist: Transform.poistion'] } }
        : undefined));
    const e = envelope(s, await s.call('modoki_set_transform', { entity: { name: 'cube' }, space: 'local', position: [1, 2, 3] }));
    expect(e.why).toContain('Transform.poistion');
    expect(e.why).not.toContain('no explanation');
  });

  it('a 403 is the wrong-editor refusal, and says to check identity', async () => {
    const s = (surface = loadSurface(() => ({ status: 403, body: { error: 'token mismatch' } })));
    const e = envelope(s, await s.call('modoki_get_editor_state'));
    expect(e.options?.join(' ')).toContain('modoki_identity');
  });

  it('a REQUIRES_SAVE refusal offers BOTH real options — save, or build on-disk deliberately', async () => {
    const s = (surface = loadSurface((req) =>
      req.path.startsWith('/api/editor-state') ? { body: { ok: true, unsavedChanges: true } } : undefined));
    const e = envelope(s, await s.call('modoki_build', { platform: 'web' }));
    expect(e.code).toBe('REQUIRES_SAVE');
    expect(e.options?.join(' ')).toContain('modoki_save_all');
    expect(e.options?.join(' ')).toContain('force:true');
    // And it must NOT have started the build.
    expect(s.requests.some((r) => r.path.startsWith('/api/build'))).toBe(false);
  });

  it('ota_publish refuses unsaved work too — it ships to INSTALLED apps (S1)', async () => {
    // modoki_build had this gate; ota_publish had none, despite the higher stakes: a build makes a
    // local artifact you can inspect, this ships over the air and answers "Published".
    const s = (surface = loadSurface((req) =>
      req.path.startsWith('/api/editor-state') ? { body: { ok: true, unsavedChanges: true } } : undefined));
    const e = envelope(s, await s.call('modoki_ota_publish', { version: 'v9' }));
    expect(e.code).toBe('REQUIRES_SAVE');
    expect(e.why).toContain('INSTALLED APPS');
    expect(e.options?.join(' ')).toContain('modoki_save_all');
    expect(s.requests.some((r) => r.path.startsWith('/api/ota/publish'))).toBe(false);
  });

  it('ota_publish with force:true proceeds — the escape hatch is real', async () => {
    const s = (surface = loadSurface((req) =>
      req.path.startsWith('/api/editor-state') ? { body: { ok: true, unsavedChanges: true } } : undefined));
    await s.call('modoki_ota_publish', { version: 'v9', force: true });
    expect(s.requests.some((r) => r.path.startsWith('/api/ota/publish'))).toBe(true);
  });

  // The `mandatory` query param is read as a TRI-STATE by the route (vite-asset-scanner.ts):
  // '1' sets it, '0' clears it, ABSENT inherits the existing release's value — matching
  // ota-publish.mjs's sticky-mandatory CLI contract. `if (mandatory) qs.set('mandatory', '1')`
  // silently collapsed `mandatory:false` into "absent" (inherit), so an agent asking for a
  // ROUTINE update on a currently-mandatory release shipped it mandatory anyway, with the success
  // echo printing `mandatory=unchanged` and nothing contradicting the caller.
  it('ota_publish sends the mandatory tri-state faithfully: true, false and omitted are THREE distinct wire states', async () => {
    const s = (surface = loadSurface());
    await s.call('modoki_ota_publish', { version: 'v10', mandatory: true, force: true });
    expect(s.requests.find((r) => r.path.startsWith('/api/ota/publish'))!.path).toContain('mandatory=1');

    const s2 = (surface = loadSurface());
    await s2.call('modoki_ota_publish', { version: 'v10', mandatory: false, force: true });
    expect(s2.requests.find((r) => r.path.startsWith('/api/ota/publish'))!.path).toContain('mandatory=0');

    const s3 = (surface = loadSurface());
    await s3.call('modoki_ota_publish', { version: 'v10', force: true });
    const omittedPath = s3.requests.find((r) => r.path.startsWith('/api/ota/publish'))!.path;
    expect(omittedPath).not.toContain('mandatory=');
  });

  it('a no-op the caller asked to CHANGE is refused, not reported as done', async () => {
    const s = (surface = loadSurface());
    const e = envelope(s, await s.call('modoki_set_transform', { entity: { name: 'Capsule' }, space: 'local' }));
    expect(e.code).toBe('REFUSED_BY_OP');
    expect(e.expected).toContain('position');
    expect(s.requests.some((r) => r.path === '/api/scene-mutate')).toBe(false);
  });
});

describe('S2 batch 2 — failures that used to read as successes', () => {
  it('the identity probe RETRIES after a failure instead of memoizing it', async () => {
    // It memoized failure too: the promise was assigned before the fetch and the catch swallowed
    // everything, so a first call made while the editor was still booting — the ordinary case when
    // `claude` and the editor start together — disarmed the wrong-clone banner for the life of the
    // process, and every later call then succeeded silently against an unverified backend.
    let identityCalls = 0;
    const s = (surface = loadSurface((req) => {
      if (req.path !== '/api/identity') return undefined;
      identityCalls++;
      if (identityCalls === 1) throw new Error('ECONNREFUSED');   // editor still booting
      return { body: { repoRoot: '/tmp/other-clone', projectRoot: '/tmp/other-clone/games/x', backendPort: 5181 } };
    }));
    await s.call('modoki_get_editor_state');   // probe 1 fails
    await s.call('modoki_get_editor_state');   // must probe AGAIN, not reuse the failure
    expect(identityCalls).toBeGreaterThanOrEqual(2);
  });

  it('a render_sequence that produced NO frames is a failure, not a success with an empty array', async () => {
    // The "keep the partial frames" hatch fired on any 4xx/5xx whose body had a `paths` array —
    // and `paths` is always present, empty when the first frame failed. A wedged renderer therefore
    // came back as ok with zero frames; inside a batch with result:'none' even the text was dropped.
    const s = (surface = loadSurface((req) =>
      req.path.startsWith('/api/render-sequence')
        ? { status: 504, body: { error: 'renderer wedged', framesWritten: 0, paths: [] } }
        : undefined));
    const e = envelope(s, await s.call('modoki_render_sequence', { frames: 3 }));
    expect(['NOT_AVAILABLE_HERE', 'REFUSED_BY_OP', 'TIMEOUT']).toContain(e.code);
  });

  it('a render_sequence that produced SOME frames is PARTIAL — the frames survive, the failure does too', async () => {
    const s = (surface = loadSurface((req) =>
      req.path.startsWith('/api/render-sequence')
        ? { status: 504, body: { error: 'timed out at frame 3', framesWritten: 2, paths: ['/tmp/a.png', '/tmp/b.png'] } }
        : undefined));
    const e = envelope(s, await s.call('modoki_render_sequence', { frames: 5 }));
    expect(e.code).toBe('PARTIAL');
    expect(JSON.stringify(e.got)).toContain('/tmp/a.png');   // the real frames are kept
    expect(e.why).toContain('INCOMPLETE');
  });

  it('add_native_target refuses unsaved work — it runs a web build from the FILE', async () => {
    const s = (surface = loadSurface((req) =>
      req.path.startsWith('/api/editor-state') ? { body: { ok: true, unsavedChanges: true } } : undefined));
    const e = envelope(s, await s.call('modoki_add_native_target', { platform: 'ios' }));
    expect(e.code).toBe('REQUIRES_SAVE');
    expect(s.requests.some((r) => r.path.startsWith('/api/add-native-target'))).toBe(false);
  });

  it('every build-family tool is denied inside a batch, derived from the contract table', async () => {
    // The DENIED list was a hand-written literal covering 2 of 3; add_native_target (a 15-minute
    // SSE) was fully batchable and the whole-batch deadline cannot stop it, because the deadline is
    // only checked BETWEEN steps.
    // The title claims the DERIVATION is tested, so the test must READ the derivation — a literal
    // list is a second hand-written copy of the thing under test, and this one already omitted the
    // fourth kind:'build' tool (modoki_ota_keygen). It would have stayed green with DENIED reverted.
    const s = (surface = loadSurface());
    const buildTools = Object.entries(CONTRACTS).filter(([, c]) => c.kind === 'build').map(([n]) => n);
    expect(buildTools.length, 'the contract table must declare some build tools').toBeGreaterThanOrEqual(3);
    for (const tool of buildTools) {
      const e = envelope(s, await s.call('modoki_batch', { steps: [{ tool, args: {} }] }));
      expect(e.why, tool).toMatch(/its own call/);
    }
    // …and the DESCRIPTION must name them too — it is the only thing the model reads before
    // authoring a batch, and it listed 2 of the 4.
    const desc = s.descriptionOf('modoki_batch');
    for (const tool of buildTools) expect(desc, `${tool} missing from the batch description`).toContain(tool);
  });
});

describe('§5 — batch failures distinguish "nothing ran" from "some of it ran"', () => {
  it('a pre-flight rejection is REFUSED_BY_OP and says NO step ran', async () => {
    const s = (surface = loadSurface());
    const e = envelope(s, await s.call('modoki_batch', { steps: [{ tool: 'modoki_no_such_tool', args: {} }] }));
    expect(e.code).toBe('REFUSED_BY_OP');
    expect(e.why).toContain('NO step ran');
    // Nothing but the identity probe should have gone out.
    expect(s.requests.filter((r) => r.path !== '/api/identity')).toHaveLength(0);
  });

  it('a mid-batch failure is PARTIAL and says the earlier steps were NOT rolled back', async () => {
    const s = (surface = loadSurface((req) =>
      req.path === '/api/scene-mutate' ? { status: 500, body: { error: 'boom' } } : undefined));
    const e = envelope(s, await s.call('modoki_batch', {
      steps: [
        { tool: 'modoki_get_editor_state', args: {} },
        { tool: 'modoki_set_transform', args: { entity: { name: 'Capsule' }, space: 'local', position: [1, 2, 3] } },
      ],
    }));
    expect(e.code).toBe('PARTIAL');
    expect(e.why).toContain('NOT a transaction');
    expect(e.options?.join(' ')).toContain('per STEP');
  });
});

describe('§5 — the envelope is bounded, and the code survives the bound', () => {
  it('an enormous echoed backend body cannot displace the code, why, or options', async () => {
    const huge = 'x'.repeat(400_000);
    const s = (surface = loadSurface(() => ({ status: 500, body: { error: 'boom', dump: huge } })));
    const r = await s.call('modoki_get_editor_state');
    const e = envelope(s, r);
    expect(e.code).toBeTruthy();
    expect(e.why).toContain('boom');
    // Bounded field-by-field, so the ENVELOPE stays parseable — never elided as a whole, which
    // would have cost the reader the one part that tells them what to do.
    expect(s.text(r).length).toBeLessThan(20_000);
  });
});

describe('§5 — no tool may bypass the envelope', () => {
  const files = readdirSync(TOOLS_DIR).filter((f) => f.endsWith('.ts'));

  it('the guard has real targets (a text guard that scans nothing passes silently)', () => {
    // Nine guards in this suite once scanned an EMPTY target after the tools moved, and stayed
    // green. Only the ones asserting a minimum count noticed.
    expect(files.length).toBeGreaterThanOrEqual(8);
  });

  it('no tool module hand-rolls a failure result', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(join(TOOLS_DIR, f), 'utf8');
      // `fail(...)` / `httpFailure(...)` are the only sanctioned constructors; both live in the
      // context. A literal `isError` in a tool module means a failure that skipped the envelope.
      if (/isError\s*:/.test(src)) offenders.push(f);
    }
    expect(offenders, 'construct failures with ctx.fail(...) — see conventions §5').toEqual([]);
  });

  it('the free-text `err(msg)` constructor is GONE from the context', () => {
    // Keeping it "as an escape hatch" is how the surface diverged: nothing forced a call site to
    // supply a code, a cause, or the options, so most supplied none of the three. Its absence is
    // what makes §5 enforced by the type checker rather than by this file.
    const ctxSrc = readFileSync(join(TOOLS_DIR, '../context.ts'), 'utf8');
    expect(ctxSrc).not.toMatch(/^\s*err:\s*\(msg/m);
    for (const f of files) {
      expect(readFileSync(join(TOOLS_DIR, f), 'utf8'), `${f} still destructures err from ctx`)
        .not.toMatch(/\berr\s*,/);
    }
  });

  it('every code in the closed set is spelled the same in the conventions doc', () => {
    // A code the doc doesn't list is a code nobody can look up; a code the doc lists but the
    // surface can't emit is a promise the surface doesn't keep.
    const doc = readFileSync(join(__dirname, '../../../docs/mcp-tool-conventions.md'), 'utf8');
    for (const code of ERROR_CODES) expect(doc, `${code} is not documented`).toContain(code);
  });
});

describe('§5 — the stub backend origin never leaks into a message', () => {
  it('reports the configured backend, not a hardcoded port', async () => {
    const s = (surface = loadSurface(() => { throw new Error('ECONNREFUSED'); }));
    expect(envelope(s, await s.call('modoki_identity')).what).toContain(STUB_BACKEND);
  });
});

describe('S2 batch 5 — filters that were silently accepted or silently dropped', () => {
  it('mutate_scene validates INSIDE each op, not just at the top level (S2.11)', async () => {
    // The batch's headline guarantee — "args validated against its real schema before ANY step
    // runs" — was one level deep: `.strict()` applies to the top, and `ops` was an array of free
    // records. `{op:'setTrait', …, feilds:{…}}` validated, applyOps took the no-fields branch (a
    // re-tag of an existing trait, a genuine no-op), and under resultDefault:'none' the step was
    // suppressed into `quiet` with the batch reporting ok:true. Invisible at every layer.
    const s = (surface = loadSurface());
    await expect(s.call('modoki_mutate_scene', {
      ops: [{ op: 'setTrait', entity: { name: 'X' }, trait: 'Light', feilds: { intensity: 2 } }],
    })).rejects.toThrow(/fields.*not.*feilds|Unrecognized/i);
    expect(s.requests.some((r) => r.path === '/api/scene-mutate')).toBe(false);
  });

  it('a well-formed op still passes (the schema must not reject the vocabulary)', async () => {
    const s = (surface = loadSurface());
    for (const op of [
      { op: 'setTrait', entity: { name: 'X' }, trait: 'Light', fields: { intensity: 2 } },
      { op: 'setTrait', entity: { guid: 'g' }, trait: 'Transform', fields: { x: 1 }, space: 'world' },
      { op: 'removeTrait', entity: { id: 3 }, trait: 'Light' },
      { op: 'addEntity', name: 'Box', parentId: 0, traits: { Transform: {}, EntityAttributes: { layer: '3d' } } },
      { op: 'removeEntity', entity: { name: 'Box' } },
      { op: 'setBaseScene', baseScene: null },
    ]) {
      await expect(s.call('modoki_mutate_scene', { ops: [op] }), JSON.stringify(op)).resolves.toBeDefined();
    }
  });

  it('an unknown OP NAME is refused with the vocabulary, not passed through', async () => {
    const s = (surface = loadSurface());
    await expect(s.call('modoki_mutate_scene', { ops: [{ op: 'setTrai', entity: { name: 'X' }, trait: 'Light' }] }))
      .rejects.toThrow();
  });

  it('get_layout_bounds takes guids and name, and the ROUTER parses them (S2.17)', async () => {
    // It accepted only volatile numeric ids — the one Percept read whose target could go stale
    // between two calls in the same turn. And a param the tool sends but the route does not parse
    // is silently dropped, so both ends had to change.
    const s = (surface = loadSurface());
    await s.call('modoki_get_layout_bounds', { guids: ['abc-123'], name: 'Player' });
    const q = s.last()!.path;
    expect(q).toContain('guids=abc-123');
    expect(q).toContain('name=Player');
  });
});

describe('S2 batch 6 — render/preview tools that claimed more than they did', () => {
  it('render_sequence REFUSES when the editor is stopped — every frame would be identical', async () => {
    // Time does not advance while stopped (getSimDelta/getVisualDelta return 0), so the one thing
    // a sequence exists for is impossible from the editor's DEFAULT state — and it used to return
    // N byte-identical frames and report success.
    const s = (surface = loadSurface((req) =>
      req.path.startsWith('/api/render-sequence')
        ? { status: 409, body: { ok: false, error: 'REFUSED: the editor is STOPPED, so time does not advance and every frame would be IDENTICAL — a sequence cannot show motion from here. Nothing was rendered.', playState: 'stopped', hint: 'Press Play first' } }
        : undefined));
    const e = envelope(s, await s.call('modoki_render_sequence', { frames: 4 }));
    expect(e.code).toBe('REFUSED_BY_OP');
    expect(e.why).toMatch(/STOPPED/);
    expect(e.why).toMatch(/IDENTICAL/);
  });

  it('render_sequence forwards forceRender:true so identical frames can be rendered deliberately', async () => {
    // RENAMED from `force` (2026-08-22, owner). The old expectation was not wrong when it was
    // written — it was defending a param name that §2 says cannot stand: `force` means "proceed
    // even though there is unsaved work" on build / add_native_target / ota_publish / load_scene /
    // prefab, and meant "render even though every frame will be identical" here. One word, two
    // unrelated meanings, on a surface whose whole thesis is that a name means one thing.
    const s = (surface = loadSurface((req) =>
      req.path.startsWith('/api/render-sequence') ? { body: { paths: ['/tmp/a.jpg'], frames: 1, requestedFps: 10, actualFps: 9.7, spanMs: 103, tMs: [0] } } : undefined));
    await s.call('modoki_render_sequence', { frames: 1, forceRender: true });
    expect(JSON.stringify(s.last()!.body)).toContain('"forceRender":true');
  });

  it('…and the OLD `force` is now refused by name, not silently ignored', async () => {
    // The reason renaming is safe here: `.strict()` (§1) turns the stale spelling into a refusal
    // that lists the tool's real parameters, so a caller carrying the old name is TOLD. Silently
    // accepting it under the wrong mental model — "I forced past my unsaved work" — was the
    // outcome worth avoiding.
    const s = (surface = loadSurface());
    await expect(s.call('modoki_render_sequence', { frames: 1, force: true }))
      .rejects.toThrow(/unrecognized parameter.*forceRender/s);
  });

  it('render_sequence reports the ACHIEVED rate, not just the requested one', async () => {
    // The old reply echoed the REQUESTED fps, while the real spacing is 1/fps PLUS a synchronous
    // render + IPC round-trip — so any conclusion from frameIndex × 1/fps was wrong by however
    // long the renderer took.
    const s = (surface = loadSurface((req) =>
      req.path.startsWith('/api/render-sequence')
        ? { body: { paths: ['/a', '/b', '/c'], frames: 3, requestedFps: 10, actualFps: 4.2, spanMs: 476, tMs: [0, 240, 476] } }
        : undefined));
    const r = s.json(await s.call('modoki_render_sequence', { frames: 3 })) as Record<string, unknown>;
    expect(r.requestedFps).toBe(10);
    expect(r.actualFps).toBe(4.2);
    expect(r.tMs).toEqual([0, 240, 476]);
  });
});

describe('review follow-ups — defects the adversarial pass found in this audit\'s OWN changes', () => {
  it('layout_bounds: a target that resolves to NOTHING returns empty, never the whole scene', async () => {
    // `targeted.length ? new Set(targeted) : null` silently widened a stale-guid query back to
    // every entity — so asking about ONE entity and receiving 200 rects read as "here it is, among
    // others". Same silent-widening class as a dropped filter.
    const s = (surface = loadSurface((req) =>
      req.path.startsWith('/api/layout-bounds') ? { body: { count: 0, entityCount: 0, entities: [], unresolved: ['stale-guid'] } } : undefined));
    await s.call('modoki_get_layout_bounds', { guids: ['stale-guid'] });
    expect(s.last()!.path).toContain('guids=stale-guid');
  });
});

describe('S3 — params that were accepted for the wrong ACTION', () => {
  it('watch: a READ filter on a START call is refused, naming `names` (S3.19)', async () => {
    // The pre-fix behaviour: `name` type-checks (it is a real param of this tool, just of the read
    // half), the start branch forwards only the start keys, so the SCOPE was dropped and the caller
    // got a watch over every entity carrying the component — reported ok:true.
    const s = (surface = loadSurface((req) =>
      req.path === '/api/watch/start' ? { body: { ok: true, id: 'w1' } } : undefined));
    const e = envelope(s, await s.call('modoki_watch', { action: 'start', component: 'Transform', name: 'puck' }));
    expect(e.code).toBe('UNKNOWN_PARAM');
    // The guard is now a per-action ALLOWLIST, so the refusal names the action rather than
    // classifying the param as "read-time" — see the ACCEPTS table in tools/runtime.ts.
    expect(e.why).toMatch(/not accepted by action:'start'/);
    expect(e.why).toMatch(/EVERY entity carrying the component/);
    expect(e.options?.join(' ')).toMatch(/names/);
    // The load-bearing half: the wrongly-scoped watch was never opened.
    expect(realRequests(s).some((r) => r.path === '/api/watch/start')).toBe(false);
  });

  it('watch: a START param on a READ call is refused too (the mirror case)', async () => {
    const s = (surface = loadSurface((req) =>
      req.path.startsWith('/api/watch/read') ? { body: { ok: true, series: [] } } : undefined));
    const e = envelope(s, await s.call('modoki_watch', { action: 'read', id: 'w1', epsilon: 0.5 }));
    expect(e.code).toBe('UNKNOWN_PARAM');
    expect(e.why).toMatch(/not accepted by action:'read'/);
    expect(e.options?.join(' ')).toMatch(/action:'start'/);
    expect(realRequests(s).some((r) => r.path.startsWith('/api/watch/read'))).toBe(false);
  });

  /** REGRESSION (independent review, 2026-07-30). The S3.19 guard was two "X-only" DENY lists
   *  checked asymmetrically — READ_ONLY strays only on `start`, START_ONLY strays on everything
   *  else — so a key in NEITHER list was neither refused nor forwarded: silently dropped, the exact
   *  class S3.19 claims to close. Four keys sat in that gap. Both cases below reported ok:true. */
  it('watch: `names` on a READ is refused, not silently dropped into an unfiltered read', async () => {
    const s = (surface = loadSurface((req) =>
      req.path.startsWith('/api/watch/read') ? { body: { ok: true, series: [] } } : undefined));
    const e = envelope(s, await s.call('modoki_watch', { action: 'read', id: 'w1', names: ['puck'] }));
    expect(e.code).toBe('UNKNOWN_PARAM');
    expect(e.why).toMatch(/EVERY series, unfiltered/);
    // It must point at `name`, the read-time filter that does what the caller meant.
    expect(e.options?.join(' ')).toMatch(/name/);
    expect(realRequests(s).some((r) => r.path.startsWith('/api/watch/read'))).toBe(false);
  });

  it('watch: a scope param on CLEAR is refused, so a scoped clear cannot become a clear-ALL', async () => {
    // The worst of the four: `clear` forwards only `{id}`, so a read-side scope key vanished and
    // the call destroyed EVERY watch on the human's editor while reporting success.
    const s = (surface = loadSurface(() => ({ body: { ok: true, cleared: 3 } })));
    const e = envelope(s, await s.call('modoki_watch', { action: 'clear', name: 'puck' }));
    expect(e.code).toBe('UNKNOWN_PARAM');
    expect(e.why).toMatch(/clear EVERY watch/);
    expect(realRequests(s).some((r) => r.path === '/api/watch/clear')).toBe(false);
  });

  it('watch: the allowlist has no gap — every param is accepted by some action and refused by the rest', async () => {
    // The structural claim, not another instance: for each of the four actions, a param belonging
    // only to a DIFFERENT action must be refused. A deny-list cannot make this promise.
    const cases: Array<[string, Record<string, unknown>]> = [
      ['start', { action: 'start', component: 'Transform', limit: 5 }],
      ['read', { action: 'read', id: 'w1', component: 'Transform' }],
      ['list', { action: 'list', id: 'w1' }],
      ['clear', { action: 'clear', samples: true }],
    ];
    for (const [action, args] of cases) {
      const s2 = loadSurface(() => ({ body: { ok: true } }));
      try {
        const r = await s2.call('modoki_watch', args);
        expect(r.isError, `action:'${action}' accepted a param that belongs to another action`).toBe(true);
        expect(realRequests(s2), `action:'${action}' still made a request`).toEqual([]);
      } finally { s2.restore(); }
    }
  });

  it('…and a correctly-scoped start still goes through (the guard is not a wall)', async () => {
    const s = (surface = loadSurface((req) =>
      req.path === '/api/watch/start' ? { body: { ok: true, id: 'w1', matchedNow: 1 } } : undefined));
    const r = await s.call('modoki_watch', { action: 'start', component: 'Transform', names: ['puck'] });
    expect(r.isError).toBeFalsy();
    expect(s.last()!.body).toMatchObject({ component: 'Transform', names: ['puck'] });
  });
});

describe('S3.21 — the over-cap hint names the CALLED tool\'s own filters', () => {
  /** A payload that is certain to blow MAX_PAYLOAD_CHARS. */
  const huge = (rows: number) => ({ logs: Array.from({ length: rows }, (_, i) => ({ i, msg: 'x'.repeat(200) })) });

  it('a capped get_console_logs is told about level/since/limit, not trait=/where=/layer=', async () => {
    const s = (surface = loadSurface((req) =>
      req.path.startsWith('/api/console-logs') ? { body: huge(2000) } : undefined));
    const r = s.json(await s.call('modoki_get_console_logs')) as { elided?: boolean; hint?: string };
    expect(r.elided, 'fixture must actually exceed the cap').toBe(true);
    expect(r.hint).toMatch(/level=/);
    // The pre-fix hint advertised get_scene_state's filters to every tool — parameters this tool's
    // strict schema refuses, so acting on the hint produced UNKNOWN_PARAM.
    expect(r.hint).not.toMatch(/trait=|where=|layer=/);
  });

  it('a capped get_scene_state still names its own (larger) filter set', async () => {
    const s = (surface = loadSurface((req) =>
      req.path.startsWith('/api/scene-state') ? { body: huge(2000) } : undefined));
    const r = s.json(await s.call('modoki_get_scene_state')) as { elided?: boolean; hint?: string };
    expect(r.elided).toBe(true);
    expect(r.hint).toMatch(/trait=/);
    expect(r.hint).toMatch(/where=/);
  });

  it('every filter a capped response advertises is a real parameter of that tool', async () => {
    // The guard that makes the fix durable: the hint is built from the contract table, which can go
    // stale. Intersecting with the schema means a stale declaration cannot advertise a dead param.
    const s = (surface = loadSurface(() => ({ body: huge(2000) })));
    for (const name of ['modoki_get_console_logs', 'modoki_list_assets', 'modoki_get_scene_state']) {
      const r = s.json(await s.call(name)) as { hint?: string };
      const advertised = [...(r.hint ?? '').matchAll(/([a-zA-Z]+)=/g)].map((m) => m[1]);
      expect(advertised.length, `${name}'s capped hint advertised no filter at all`).toBeGreaterThan(0);
      // Checked against the tool's SCHEMA, not against `contracts.filters`. The intent (per the
      // comment above) is "a stale declaration cannot advertise a DEAD param", and the schema is
      // what makes a param real. Asserting containment in `filters` conflated two different things
      // and re-encoded a bug: a hint may legitimately mention an EXPANDING option next to the
      // narrowing ones ("…or all=true for every entry"), and `all` is not a filter — it makes the
      // response bigger. `mcpToolContracts.test.ts` separately holds `filters` itself to being
      // real, accepted by the handler, and non-expanding.
      const params = Object.keys(getTool(name)!.shape);
      for (const f of advertised) {
        expect(params, `${name}'s hint advertises '${f}', which is not a parameter of it`).toContain(f);
      }
      // NOT asserted: that every declared filter appears in this hint. These are the tools' OWN
      // summary hints (prose, written per tool), not the retargeted over-cap hint that
      // `retargetNarrowHint` builds from `contracts.filters` — so a hint naming three of four
      // filters is an editorial choice, not drift. The declaration itself is held to being real,
      // handler-accepted and non-expanding by `mcpToolContracts.test.ts`.
    }
  });
});

describe('S3.6 — modoki_dnd endpoints must actually aim', () => {
  it('an endpoint with neither selector nor a complete {x,y} is refused by the schema', async () => {
    const s = (surface = loadSurface());
    // `call()` validates through the tool's own strict schema, exactly like the transport and
    // modoki_batch — so this asserts the SURFACE refuses, not that a handler happens to.
    await expect(s.call('modoki_dnd', { from: { selector: '#row' }, to: {} })).rejects.toThrow(/selector.*x,y|x,y.*selector/i);
    await expect(s.call('modoki_dnd', { from: { selector: '#row' }, to: { x: 5 } })).rejects.toThrow();
    expect(realRequests(s)).toEqual([]);
  });

  it('a misspelled endpoint key is refused instead of read as "no aim"', async () => {
    const s = (surface = loadSurface());
    await expect(s.call('modoki_dnd', { from: { selecter: '#row' }, to: { selector: '#folder' } })).rejects.toThrow();
    expect(realRequests(s)).toEqual([]);
  });

  it('…and a properly-aimed pair still goes through', async () => {
    const s = (surface = loadSurface());
    const r = await s.call('modoki_dnd', { from: { selector: '#row' }, to: { x: 10, y: 20 } });
    expect(r.isError).toBeFalsy();
    expect(s.last()!.path).toBe('/api/editor-action');
  });
});

describe('Phase 6 — a MUTATING GET\'s ok:false is a failure, a plain read\'s is an answer', () => {
  it('journal {action:"start"} without a type reports the route\'s refusal as a FAILURE', async () => {
    // Measured live against the editor on 5181: the route answers
    // `200 {ok:false, reason:'action needs type= …'}` and `getJson` did not check it, so the refusal
    // reached the agent as a successful call — the C7 class, on the one GET family where `ok` is a
    // success flag rather than the answer.
    const s = (surface = loadSurface((req) =>
      req.path.startsWith('/api/journal')
        ? { body: { ok: false, reason: 'action needs type= naming the diagnostic to capture (e.g. @contact)' } }
        : undefined));
    const e = envelope(s, await s.call('modoki_journal', { action: 'start' }));
    expect(e.code).toBe('REFUSED_BY_OP');
    // `reason` (not just `error`) must reach `why` — otherwise the one useful sentence is demoted
    // to "the operation reported ok:false".
    expect(e.why).toMatch(/action needs type=/);
  });

  it('editor_journal {clear:true} likewise', async () => {
    const s = (surface = loadSurface((req) =>
      req.path.startsWith('/api/editor-journal') ? { body: { ok: false, error: 'REFUSED: clear with a filter' } } : undefined));
    const e = envelope(s, await s.call('modoki_editor_journal', { clear: true }));
    expect(e.code).toBe('REFUSED_BY_OP');
    expect(e.why).toMatch(/REFUSED/);
  });

  it('a PLAIN journal read is NOT failed by an ok:false body — there `ok` can be the answer', async () => {
    // The reason the check is opt-in per call site rather than a flipped default: `diagnose` and
    // `validate_scene` answer `ok:false` to mean "unhealthy", and failing those would make an
    // honest negative result look like a broken tool.
    const s = (surface = loadSurface((req) =>
      req.path.startsWith('/api/journal') ? { body: { ok: false, events: [], count: 0 } } : undefined));
    const r = await s.call('modoki_journal', { type: 'match' });
    expect(r.isError).toBeFalsy();
  });

  it('modoki_diagnose still reports an unhealthy scene as a SUCCESSFUL read', async () => {
    const s = (surface = loadSurface((req) =>
      req.path.startsWith('/api/diagnose') ? { body: { ok: false, summary: '2 dangling refs' } } : undefined));
    const r = await s.call('modoki_diagnose');
    expect(r.isError).toBeFalsy();
    expect(s.json(r)).toMatchObject({ ok: false, summary: '2 dangling refs' });
  });
});
