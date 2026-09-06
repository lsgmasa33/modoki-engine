/** atlasPersist's `persistAtlasDoc` (#308 close-out, part D-2) — the write+report AtlasAssetView's
 *  `update` callback used to inline directly in the component (`void writeAssetFile(...).then((ok)
 *  => { if (!ok) reportWriteFailed(...) })`), which meant it could only be covered by mounting the
 *  panel — forbidden per CLAUDE.md § Panels ("editor `.tsx` is not expected to carry tests"). Extracted
 *  into this plain `.ts` module so a failing write reports (console + toast) and a succeeding one
 *  stays silent, without rendering anything. Uses the REAL `useEditorStore` for the toast assertion,
 *  matching the rest of the suite's convention (`assetUndo.test.ts`). */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';

const writeAssetFileSpy = vi.fn();
vi.mock('../../src/editor/panels/assetOps', () => ({
  writeAssetFile: (...args: unknown[]) => writeAssetFileSpy(...args),
}));

import {
  persistAtlasDoc, classifyAtlasLoad, canPersistAtlasDoc, buildNextAtlasDoc, DEFAULT_ATLAS_DOC,
  persistAtlasDocIfUnchanged, createAtlasWriteQueue,
} from '../../src/editor/panels/assetViews/atlasPersist';
import { useEditorStore } from '../../src/editor/store/editorStore';
import { sha256Hex } from '../../src/editor/utils/contentHash';
import { ATLAS_FORMAT_VERSION } from '../../src/runtime/loaders/spriteAtlas';

let consoleSpies: Array<{ mockRestore: () => void }> = [];
const spyConsole = (level: 'error' | 'warn') => {
  const s = vi.spyOn(console, level).mockImplementation(() => {});
  consoleSpies.push(s);
  return s;
};

beforeEach(() => {
  writeAssetFileSpy.mockReset();
  useEditorStore.setState({ toast: null });
});
afterEach(() => { for (const s of consoleSpies) s.mockRestore(); consoleSpies = []; });

describe('persistAtlasDoc', () => {
  it('writes the content and stays silent (no console, no toast) on success', async () => {
    const error = spyConsole('error');
    writeAssetFileSpy.mockResolvedValue(true);
    const result = await persistAtlasDoc('/a.atlas.json', '{"members":[]}\n');
    expect(writeAssetFileSpy).toHaveBeenCalledWith('/a.atlas.json', '{"members":[]}\n');
    expect(result).toBe(true);
    expect(error).not.toHaveBeenCalled();
    expect(useEditorStore.getState().toast).toBeNull();
  });

  it('reports (console error + toast) when the write is rejected', async () => {
    const error = spyConsole('error');
    writeAssetFileSpy.mockResolvedValue(false);
    const result = await persistAtlasDoc('/a.atlas.json', '{"members":[]}\n');
    expect(result).toBe(false);
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toContain('/a.atlas.json');
    const toast = useEditorStore.getState().toast;
    expect(toast).not.toBeNull();
    expect(toast!.kind).toBe('warn');
    expect(toast!.message).toContain('a.atlas.json');
  });
});

/** #430 — a failed/aborted load used to leave the panel silently editable on DEFAULT_ATLAS_DOC,
 *  so the first edit after a bad load overwrote the real `.atlas.json`. `classifyAtlasLoad` is
 *  the load effect's decision logic, extracted so it's covered without mounting the panel. */
describe('classifyAtlasLoad', () => {
  it('a non-ok HTTP response classifies as failed, with no doc to apply', () => {
    const result = classifyAtlasLoad({ kind: 'httpError' });
    expect(result).toEqual({ loadState: 'failed' });
  });

  it('a network throw classifies as failed', () => {
    const result = classifyAtlasLoad({ kind: 'networkError' });
    expect(result).toEqual({ loadState: 'failed' });
  });

  it('an abort classifies as null — not failed, caller does nothing', () => {
    const result = classifyAtlasLoad({ kind: 'aborted' });
    expect(result).toBeNull();
  });

  it('a well-formed body classifies as ok, normalized doc attached', () => {
    const body = { id: 'g1', version: 1, members: ['a', 'b'], pageSize: 512, padding: 1, extrude: 2 };
    const result = classifyAtlasLoad({ kind: 'ok', body });
    expect(result).toEqual({ loadState: 'ok', doc: body, raw: body });
  });

  it('a malformed body (missing/wrong-typed fields) still classifies as ok, normalized to defaults', () => {
    const body = { members: 'not-an-array', pageSize: 'big' };
    const result = classifyAtlasLoad({ kind: 'ok', body });
    expect(result).toEqual({
      loadState: 'ok',
      doc: {
        id: undefined, version: undefined,
        members: [],
        pageSize: DEFAULT_ATLAS_DOC.pageSize,
        padding: DEFAULT_ATLAS_DOC.padding,
        extrude: DEFAULT_ATLAS_DOC.extrude,
      },
      raw: body,
    });
  });

  it('an empty body (parsed `{}`) still classifies as ok — a loaded-empty atlas is editable, not failed', () => {
    const result = classifyAtlasLoad({ kind: 'ok', body: {} });
    expect(result?.loadState).toBe('ok');
  });

  // Review finding 4: a body that parses but isn't a plain object must not classify as 'ok' —
  // `{...raw}` / the `Partial<AtlasSourceDoc>` cast both assume an object, so `null`/an array/a
  // string/a number would otherwise be absorbed into a "valid" doc with no `id` (the #430 loss,
  // reached through a different response shape) or, for a string, spread character-by-character
  // into the written file.
  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'anything'],
    ['a number', 42],
  ])('a non-object JSON body (%s) classifies as failed', (_label, body) => {
    const result = classifyAtlasLoad({ kind: 'ok', body });
    expect(result).toEqual({ loadState: 'failed' });
  });

  it('an object body with wrong-typed fields is still ok — the empty-atlas distinction is the whole fix', () => {
    const result = classifyAtlasLoad({ kind: 'ok', body: { members: 'not-an-array', pageSize: 'big' } });
    expect(result?.loadState).toBe('ok');
  });
});

// Format-version REFUSAL (#784, docs/format-versioning.md § 2b-bis). `.atlas.json` is REFUSE
// disposition: a too-new/unreadable document parses fine but must not become an editable `doc`
// — a distinct outcome from `failed` (network/HTTP), because the banner text and the fix are
// different ("update this build" vs. "retry the load").
describe('classifyAtlasLoad — format-version refusal', () => {
  it('a too-new version classifies as refused, not ok — and not the generic "failed"', () => {
    const body = { id: 'g1', version: 99, members: [], pageSize: 512, padding: 1, extrude: 2 };
    const result = classifyAtlasLoad({ kind: 'ok', body });
    expect(result?.loadState).toBe('refused');
    expect((result as { message: string }).message).toContain('99');
  });

  it('an unreadable (non-numeric) version classifies as refused', () => {
    const body = { id: 'g1', version: 'two', members: [] };
    const result = classifyAtlasLoad({ kind: 'ok', body });
    expect(result?.loadState).toBe('refused');
  });

  it('an ok (at or below this build) version still classifies as ok, unaffected', () => {
    const body = { id: 'g1', version: 1, members: [] };
    const result = classifyAtlasLoad({ kind: 'ok', body });
    expect(result?.loadState).toBe('ok');
  });

  it('an absent version still classifies as ok — legacy/fresh documents are readable', () => {
    const body = { id: 'g1', members: [] };
    const result = classifyAtlasLoad({ kind: 'ok', body });
    expect(result?.loadState).toBe('ok');
  });
});

// Direct regression test for 2b (#784): `AtlasAssetView.update()` used to build
// `{ ...prev, ...patch, version: 1 as const }` — the trailing literal clobbered whatever
// version the document actually carried, on EVERY edit. `buildNextAtlasDoc` is the extracted
// replacement `update()` now calls.
describe('buildNextAtlasDoc', () => {
  const base = { id: 'g1', version: 2, members: ['a'], pageSize: 512, padding: 1, extrude: 2 };

  it('never overrides the document\'s own version with a literal', () => {
    const out = buildNextAtlasDoc(base, { padding: 5 });
    expect(out.version).toBe(2); // NOT re-stamped to 1
    expect(out.padding).toBe(5); // the edit itself still applies
  });

  it('applies the patch over the previous doc otherwise unchanged', () => {
    const out = buildNextAtlasDoc(base, { members: ['a', 'b'] });
    expect(out).toEqual({ ...base, members: ['a', 'b'] });
  });

  it('a patch that explicitly sets version is still honored (this is not a version-immutability guard)', () => {
    const out = buildNextAtlasDoc(base, { version: 5 });
    expect(out.version).toBe(5);
  });

  // #784 phase C adversarial review, finding 3: dropping the clobbering literal ALSO dropped the
  // stamp for a document that had no version to begin with — `normalizeAtlasBody` sets
  // `version: undefined` for a versionless file, and `serializeAtlasDoc` strips `undefined`
  // keys, so a versionless atlas stayed versionless through every edit instead of getting
  // stamped on the first one, same as it did before #784 phase C2a's fix.
  it('a versionless doc gains ATLAS_FORMAT_VERSION on its first edit', () => {
    const versionless = { id: 'g2', members: ['a'], pageSize: 512, padding: 1, extrude: 2 };
    const out = buildNextAtlasDoc(versionless, { padding: 5 });
    expect(out.version).toBe(ATLAS_FORMAT_VERSION);
    expect(out.padding).toBe(5);
  });

  it('a doc already carrying its OWN version keeps that value unchanged (not re-stamped)', () => {
    const out = buildNextAtlasDoc(base, { padding: 9 });
    expect(out.version).toBe(base.version); // 2, not ATLAS_FORMAT_VERSION
  });
});

describe('canPersistAtlasDoc', () => {
  it('refuses while loading, even with a matching path', () => {
    expect(canPersistAtlasDoc('loading', '/a.atlas.json', '/a.atlas.json')).toBe(false);
  });

  it('refuses when the load failed, even with a matching path', () => {
    expect(canPersistAtlasDoc('failed', '/a.atlas.json', '/a.atlas.json')).toBe(false);
  });

  it('allows once loaded ok with a matching path', () => {
    expect(canPersistAtlasDoc('ok', '/a.atlas.json', '/a.atlas.json')).toBe(true);
  });

  // The finding that matters most: `loadState === 'ok'` is not enough on its own. A selection
  // change from atlas A to atlas B can repaint the panel with `loadState === 'ok'` still set from
  // A's load, A's `doc`/`rawDoc`, and `path` already updated to B — the window between the `path`
  // prop changing and B's load effect landing. A write in that window would serialize A's content
  // onto B's file, the exact loss #430 fixed, reached a different way.
  it('refuses when loadedPath !== path even with loadState === "ok" — the A-to-B selection window', () => {
    expect(canPersistAtlasDoc('ok', '/a.atlas.json', '/b.atlas.json')).toBe(false);
  });

  it('refuses when loadedPath is null (no load has landed yet) regardless of loadState', () => {
    expect(canPersistAtlasDoc('ok', null, '/a.atlas.json')).toBe(false);
  });

  it('refuses a "refused" (format-version) load state, even with a matching path', () => {
    expect(canPersistAtlasDoc('refused', '/a.atlas.json', '/a.atlas.json')).toBe(false);
  });
});

/** #439, made atomic by #469 — the compare-and-swap write guard. The panel writes the WHOLE
 *  `.atlas.json` document on every control interaction; nothing reliably notifies it of a
 *  same-path content change on disk (a `git checkout` under a live editor, CLAUDE.md's
 *  documented hazard, or a second rapid edit racing this one — the #469 regression), so the
 *  guarantee has to sit on the WRITE. `persistAtlasDocIfUnchanged` now hashes what it read and
 *  hands the precondition to an injected conditional writer — the compare-and-write happen as
 *  ONE server-side operation, so there is no gap for a second write to land in. */
describe('persistAtlasDocIfUnchanged', () => {
  it('writes when the precondition matches the loaded baseline, and returns "written"', async () => {
    const writeIfMatch = vi.fn(async () => 'written' as const);
    const loadedText = '{"members":[]}\n';
    const expected = await sha256Hex(loadedText);

    const outcome = await persistAtlasDocIfUnchanged(
      '/a.atlas.json', '{"members":["x"]}\n', loadedText, writeIfMatch,
    );

    expect(outcome).toBe('written');
    expect(writeIfMatch).toHaveBeenCalledWith('/a.atlas.json', '{"members":["x"]}\n', expected);
  });

  // The ticket's own repro (#439, and its own regression #469): a `.atlas.json` whose `members`
  // changed on disk (e.g. a `git checkout` under a live editor, or a second racing write) must
  // NOT be overwritten by a subsequent padding nudge the panel queued against a stale baseline.
  // Here the server is the one deciding "changed", so the seam under test is: did this function
  // hash the STALE `loadedText` (not the new content) and hand the writer's verdict through
  // unchanged?
  it('#439 repro: hashes the STALE loaded text (not the new content), and passes the writer\'s conflict through untouched', async () => {
    const writeIfMatch = vi.fn(async () => 'conflict' as const);
    const staleLoadedText = '{"members":["original"],"padding":1}\n';
    const paddingNudgeContent = '{"members":["original"],"padding":2}\n';
    const expectedIfMatch = await sha256Hex(staleLoadedText);

    const outcome = await persistAtlasDocIfUnchanged(
      '/court.atlas.json', paddingNudgeContent, staleLoadedText, writeIfMatch,
    );

    expect(outcome).toBe('conflict');
    expect(writeIfMatch).toHaveBeenCalledWith('/court.atlas.json', paddingNudgeContent, expectedIfMatch);
    // Never hashes the OUTGOING content as the precondition — that would always "match" itself
    // and defeat the guard entirely.
    expect(expectedIfMatch).not.toBe(await sha256Hex(paddingNudgeContent));
  });

  it('returns "conflict" without even asking the writer when loadedText is null (no baseline)', async () => {
    const writeIfMatch = vi.fn(async () => 'written' as const);

    const outcome = await persistAtlasDocIfUnchanged(
      '/a.atlas.json', '{"members":["x"]}\n', null, writeIfMatch,
    );

    expect(outcome).toBe('conflict');
    expect(writeIfMatch).not.toHaveBeenCalled();
  });

  it('returns "failed" and reports (console error + toast) when the writer reports "failed"', async () => {
    const error = spyConsole('error');
    const writeIfMatch = vi.fn(async () => 'failed' as const);

    const outcome = await persistAtlasDocIfUnchanged(
      '/a.atlas.json', '{"members":["x"]}\n', '{"members":[]}\n', writeIfMatch,
    );

    expect(outcome).toBe('failed');
    expect(error).toHaveBeenCalledTimes(1);
    const toast = useEditorStore.getState().toast;
    expect(toast).not.toBeNull();
    expect(toast!.kind).toBe('warn');
  });

  it('a "conflict" from the writer is passed through with no failure report', async () => {
    const error = spyConsole('error');
    const writeIfMatch = vi.fn(async () => 'conflict' as const);

    const outcome = await persistAtlasDocIfUnchanged(
      '/a.atlas.json', '{"members":["x"]}\n', '{"members":[]}\n', writeIfMatch,
    );

    expect(outcome).toBe('conflict');
    expect(error).not.toHaveBeenCalled();
    expect(useEditorStore.getState().toast).toBeNull();
  });
});

/** A fake `/api/write-file` `ifMatch` route: hashes its own current content the same way the
 *  real server hashes the file on disk, and only writes if the caller's `ifMatch` matches. Lets
 *  these tests drive `persistAtlasDocIfUnchanged`/`createAtlasWriteQueue` against something that
 *  behaves like the real atomic route without a backend.
 *
 *  The compare-then-write below is deliberately done with Node's SYNCHRONOUS `crypto`, exactly
 *  matching the real route's own atomicity guarantee (`editorBackendRouter.ts`'s "no `await`
 *  between the compare and the write" comment) — using the async `sha256Hex` here would open a
 *  window this fake doesn't actually have in production, and would make these tests report a
 *  race that the real server's synchronous check prevents. */
function makeFakeServer(initial: string) {
  let content = initial;
  const hashSync = (text: string) => crypto.createHash('sha256').update(Buffer.from(text, 'utf-8')).digest('hex');
  const writeIfMatch = vi.fn(async (_path: string, newContent: string, expectedSha256: string) => {
    if (hashSync(content) !== expectedSha256) return 'conflict' as const;
    content = newContent;
    return 'written' as const;
  });
  return { writeIfMatch, get content() { return content; } };
}

/** #469 review finding 1 — the fix converts fast typing into a false conflict that DISCARDS the
 *  user's edit. `AtlasAssetView.update()` used to capture `loadedText` and call
 *  `persistAtlasDocIfUnchanged` directly, once per keystroke, with nothing serializing the calls.
 *  Two edits firing before the first write's response lands both carry the SAME pre-write
 *  `ifMatch`; the atomic server route (correctly) lets only one land and 409s the other — but
 *  that 409 is SELF-inflicted, not a real third-party change, and the panel cannot tell the
 *  difference: it discards the losing edit and reloads from disk. `createAtlasWriteQueue` fixes
 *  this by keeping only one write in flight per panel; a superseded write collapses into the
 *  next one instead of racing it. */
describe('createAtlasWriteQueue (#469 review finding 1)', () => {
  it('reproduces the bug at the primitive level: two same-baseline writes issued in parallel spuriously conflict, with no external change involved', async () => {
    // This is exactly the call pattern AtlasAssetView.update() used PRE-fix: both writes capture
    // the same pre-write baseline and are issued without anything serializing them.
    const server = makeFakeServer('{"padding":0}\n');
    const staleBaseline = '{"padding":0}\n';

    const [outcomeA, outcomeB] = await Promise.all([
      persistAtlasDocIfUnchanged('/a.atlas.json', '{"padding":1}\n', staleBaseline, server.writeIfMatch),
      persistAtlasDocIfUnchanged('/a.atlas.json', '{"padding":12}\n', staleBaseline, server.writeIfMatch),
    ]);

    // Nothing external ever touched the file — both writes came from THIS panel — yet one of
    // them is reported as a conflict, which is exactly the false-conflict bug review finding 1
    // describes. (The queue below exists so this call pattern never happens.)
    expect([outcomeA, outcomeB].sort()).toEqual(['conflict', 'written']);
  });

  it('serializes two same-tick writes so both land, in order, with no false conflict — the fix', async () => {
    const server = makeFakeServer('{"padding":0}\n');
    let loadedText = '{"padding":0}\n';
    const onConflict = vi.fn();
    const queue = createAtlasWriteQueue(server.writeIfMatch, {
      getLoadedText: () => loadedText,
      getCurrentPath: () => '/a.atlas.json',
      onWritten: (content) => { loadedText = content; },
      onConflict,
    });

    // Fire both "keystrokes" in the same tick — no await between them, exactly like two rapid
    // `onChange` calls on a number input.
    queue.enqueue('/a.atlas.json', '{"padding":1}\n');
    queue.enqueue('/a.atlas.json', '{"padding":12}\n');

    // Let the queue's chained microtasks/macrotasks drain. A fixed tick count is not safe here:
    // each link hops through a real async `crypto.subtle.digest` (#469's sha256 precondition),
    // and CI runners vary in how many event-loop turns that takes — GH's windows-latest runner in
    // particular needs more than the 2-3 ticks that always sufficed on Linux/macOS, which turned
    // this exact wait into a reproducible (not flaky) red on Windows. Poll for the actual outcome
    // instead of guessing a tick count.
    await vi.waitFor(() => { expect(server.content).toBe('{"padding":12}\n'); });

    expect(onConflict).not.toHaveBeenCalled();
    // The final content is the LATEST edit — every write is the full document, so it already
    // carries whatever the superseded one would have written.
    expect(loadedText).toBe('{"padding":12}\n');
  });

  it('collapses a write superseded before it starts — the middle of three rapid edits is skipped, not raced', async () => {
    const server = makeFakeServer('{"padding":0}\n');
    let loadedText = '{"padding":0}\n';
    const onConflict = vi.fn();
    const queue = createAtlasWriteQueue(server.writeIfMatch, {
      getLoadedText: () => loadedText,
      getCurrentPath: () => '/a.atlas.json',
      onWritten: (content) => { loadedText = content; },
      onConflict,
    });

    queue.enqueue('/a.atlas.json', '{"padding":1}\n');
    queue.enqueue('/a.atlas.json', '{"padding":12}\n');
    queue.enqueue('/a.atlas.json', '{"padding":128}\n');

    // Poll instead of a fixed tick count — see the wait above for why (#469 review, Windows CI).
    await vi.waitFor(() => { expect(server.content).toBe('{"padding":128}\n'); });

    expect(onConflict).not.toHaveBeenCalled();
    // writeIfMatch is called EXACTLY once: all three `enqueue()` calls above run synchronously,
    // with no `await` between them, so `pending` is overwritten twice before the queue's first
    // chained link ever gets a turn to run — that link reads `pending` as the LATEST job
    // (padding:128) and the second/third links then find `pending` already claimed (`null`) and
    // do nothing. `toBeLessThanOrEqual(2)` (the loose form this replaces) would also pass if the
    // middle edit had instead RACED the first write and produced a second call — asserting the
    // exact count is what actually proves the middle edit was skipped, not raced.
    expect(server.writeIfMatch.mock.calls.length).toBe(1);
  });

  it('a GENUINE third-party conflict still surfaces exactly as before — the queue never masks a real disk change', async () => {
    const server = makeFakeServer('{"padding":0}\n');
    const onConflict = vi.fn();
    const onWritten = vi.fn();
    // loadedText never advances (simulating: this panel's baseline is stale relative to disk,
    // e.g. a `git checkout` happened underneath it) — every write against it must conflict.
    const staleForever = '{"padding":-1}\n';
    const queue = createAtlasWriteQueue(server.writeIfMatch, {
      getLoadedText: () => staleForever,
      getCurrentPath: () => '/a.atlas.json',
      onWritten,
      onConflict,
    });

    queue.enqueue('/a.atlas.json', '{"padding":1}\n');
    // Poll instead of a fixed tick count — see the wait above for why (#469 review, Windows CI).
    await vi.waitFor(() => { expect(onConflict).toHaveBeenCalledTimes(1); });

    expect(onWritten).not.toHaveBeenCalled();
    expect(server.content).toBe('{"padding":0}\n'); // untouched
  });

  // Review finding 2 — `Inspector.tsx` mounts `AtlasAssetView` with no `key={asset.path}`, so a
  // selection change (atlas A → atlas B) is a prop change on the SAME instance: this queue, and
  // any job already chained onto it for A, survive the switch. A job for A that hasn't issued
  // yet when the panel moves to B must not run against B's baseline/conflict target at all.
  it('drops a queued write whose path no longer matches the panel\'s current path, once the panel has moved on', async () => {
    const server = makeFakeServer('{"padding":0}\n');
    let loadedText = '{"padding":0}\n';
    let currentPath = '/a.atlas.json';
    const onConflict = vi.fn();
    const queue = createAtlasWriteQueue(server.writeIfMatch, {
      getLoadedText: () => loadedText,
      getCurrentPath: () => currentPath,
      onWritten: (content) => { loadedText = content; },
      onConflict,
    });

    queue.enqueue('/a.atlas.json', '{"padding":1}\n');
    // Let the first write actually land before the selection changes. Poll instead of a fixed
    // tick count — see the wait in the earlier test for why (#469 review, Windows CI).
    await vi.waitFor(() => { expect(server.content).toBe('{"padding":1}\n'); });

    // User selects atlas B — a second edit for A (e.g. a stepper click that was already queued
    // just before the selection changed) is enqueued after the switch.
    currentPath = '/b.atlas.json';
    queue.enqueue('/a.atlas.json', '{"padding":2}\n');
    // Nothing observable changes when a job is correctly dropped, so there is no positive signal
    // to poll for — give the chain a generous real-time margin instead (well past a single link's
    // worth of async hops, including the sha256 digest) rather than a fixed, easy-to-undercount
    // tick number.
    await new Promise((r) => setTimeout(r, 30));
    await new Promise((r) => setTimeout(r, 30));

    // Dropped, not written, and not reported as a conflict against B: A's file is untouched,
    // the server was never even asked, and B never gets a false "changed on disk" banner.
    expect(server.content).toBe('{"padding":1}\n');
    expect(server.writeIfMatch.mock.calls.length).toBe(1);
    expect(onConflict).not.toHaveBeenCalled();
  });

  // Review finding 3 — `chain = chain.then(async () => {...})` with no `.catch` meant a link that
  // THROWS (rather than resolving to 'failed') left `chain` permanently rejected: every
  // subsequent `chain.then(...)` from a LATER `enqueue()` would then never run, silently ending
  // persistence for the life of the mount. The fix is a `.catch` on the link itself, so the chain
  // recovers and the next queued write still issues.
  it('a link that throws does not break the chain — the next enqueued write still issues', async () => {
    const error = spyConsole('error');
    const server = makeFakeServer('{"padding":0}\n');
    let loadedText = '{"padding":0}\n';
    const onConflict = vi.fn();
    let calls = 0;
    const throwingWriteIfMatch = vi.fn(async (path: string, content: string, expectedSha256: string) => {
      calls += 1;
      if (calls === 1) throw new Error('boom');
      return server.writeIfMatch(path, content, expectedSha256);
    });
    const queue = createAtlasWriteQueue(throwingWriteIfMatch, {
      getLoadedText: () => loadedText,
      getCurrentPath: () => '/a.atlas.json',
      onWritten: (content) => { loadedText = content; },
      onConflict,
    });

    queue.enqueue('/a.atlas.json', '{"padding":1}\n'); // this link throws
    // Poll instead of a fixed tick count — see the wait earlier in this describe block for why
    // (#469 review, Windows CI): this test has an extra async hop over the others (the throwing
    // link's own recovery through `.catch`), which is exactly what made a fixed 2-3 ticks land
    // short on windows-latest while it always cleared in time on Linux/macOS.
    await vi.waitFor(() => { expect(throwingWriteIfMatch).toHaveBeenCalledTimes(1); });

    queue.enqueue('/a.atlas.json', '{"padding":2}\n'); // must still issue despite the prior throw
    await vi.waitFor(() => { expect(server.content).toBe('{"padding":2}\n'); });

    expect(loadedText).toBe('{"padding":2}\n');
    expect(onConflict).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalled(); // the throw is still reported, not swallowed silently
  });
});
