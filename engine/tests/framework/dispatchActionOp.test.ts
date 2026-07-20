/** dispatch-action op — every "did not dispatch" answer must be a SURFACED failure, and
 *  engine.playClip must not report success against an entity with no animator. (MCP re-audit F8 + F5)
 *
 *  The op signals a no-op via `{dispatched:false, reason}` at HTTP 200. The MCP client's
 *  `isFailureBody` inspects `ok`/`error`/`errors` — NOT `dispatched` — so before F8 an unknown action
 *  name / stale targetGuid / not-playing dispatch was emitted as a non-error tool call. F5: with no
 *  animator trait, `switchableClipNames` is empty (indistinguishable from clips-not-loaded), so the
 *  clip-name guard was skipped and the op answered `dispatched:true` while `engine.playClip` only
 *  console.warned. Both are now `{ok:false, dispatched:false}`. */

import { describe, it, expect, afterEach } from 'vitest';
import { createTestWorld, type TestWorld, Transform, EntityAttributes } from '@modoki/engine/runtime';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { runAgentOp } from '../../app/debug/agentBridge';

registerAllTraits();

let game: TestWorld | undefined;
afterEach(() => { game?.dispose(); game = undefined; });

type DispatchReply = { ok?: boolean; dispatched: boolean; reason?: string; known?: string[] };

describe('dispatch-action: a no-op is a surfaced failure (F8)', () => {
  it('an unknown action name → ok:false, dispatched:false, with the known list', async () => {
    game = createTestWorld({ actions: { 'my.real': () => {} } });
    const r = await runAgentOp('dispatch-action', { name: 'totally.bogus' }) as DispatchReply;
    expect(r.ok).toBe(false);
    expect(r.dispatched).toBe(false);
    expect(r.known).toContain('my.real');
  });

  it('a stale targetGuid → ok:false, dispatched:false', async () => {
    game = createTestWorld({ actions: { 'my.real': () => {} } });
    const r = await runAgentOp('dispatch-action', { name: 'my.real', targetGuid: 'ghost-guid' }) as DispatchReply;
    expect(r.ok).toBe(false);
    expect(r.dispatched).toBe(false);
    expect(r.reason).toMatch(/stale|no entity/i);
  });

  it('a valid action DOES dispatch — ok is NOT false, dispatched:true, and the handler ran', async () => {
    let hits = 0;
    game = createTestWorld({ actions: { 'my.real': () => { hits++; } } });
    const r = await runAgentOp('dispatch-action', { name: 'my.real' }) as DispatchReply;
    expect(r.dispatched).toBe(true);
    expect(r.ok).not.toBe(false); // success carries no ok:false, so isFailureBody passes it
    expect(hits).toBe(1);
  });
});

describe('dispatch-action: engine.playClip requires an animator (F5)', () => {
  it('a target with NO animator trait → ok:false, dispatched:false, reason names the animator', async () => {
    game = createTestWorld({ actions: { 'engine.playClip': () => {} } });
    game.spawn(Transform({ x: 0 }), EntityAttributes({ guid: 'noanim', name: 'NoAnim' }));
    const r = await runAgentOp('dispatch-action', { name: 'engine.playClip', targetGuid: 'noanim', params: { clip: 'Walk' } }) as DispatchReply;
    expect(r.ok).toBe(false);
    expect(r.dispatched).toBe(false);
    expect(r.reason).toMatch(/animator/i);
  });
});
