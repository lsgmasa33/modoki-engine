/** journal-events op — the Tier-2 capture CONTROL path (action:start|stop) and the read-path
 *  capture reporting. These `ok:false` shapes are what the MCP client's isFailureBody depends on,
 *  and the captureHint is what stops an empty @contact read from being misread as "no contacts"
 *  rather than "not capturing". All had zero coverage.
 *
 *  Note: createTestWorld opens every Tier-2 capture by default (headless full observability), so
 *  each test starts with @contact ACTIVE and dispose() closes it again (verboseCaptureState is
 *  process-global). */

import { describe, it, expect, afterEach } from 'vitest';
import { createTestWorld, type TestWorld } from '@modoki/engine/runtime';
import { runAgentOp } from '../../app/debug/agentBridge';

let game: TestWorld | undefined;
afterEach(() => { game?.dispose(); game = undefined; });

type CaptureState = { types: string[]; active: string[] };
type Reply = { ok?: boolean; reason?: string; action?: string; type?: string; captures: CaptureState; captureHint?: string };
const journal = (args: Record<string, unknown>) => runAgentOp('journal-events', args) as Promise<Reply>;

describe('journal-events: Tier-2 capture control', () => {
  it('stop then start @contact flips captures.active and echoes it', async () => {
    game = createTestWorld(); // @contact active by default
    const stopped = await journal({ action: 'stop', type: '@contact' });
    expect(stopped.ok).toBe(true);
    expect(stopped.captures.active).not.toContain('@contact');

    const started = await journal({ action: 'start', type: '@contact' });
    expect(started.ok).toBe(true);
    expect(started.captures.active).toContain('@contact');
    expect(started.captures.types).toContain('@contact'); // @contact is a known Tier-2 type
  });

  it('action without a type → ok:false naming the requirement', async () => {
    game = createTestWorld();
    const r = await journal({ action: 'start' });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/type/i);
  });

  it('starting a NON-verbose (always-on) type → ok:false naming the watch-gated types', async () => {
    game = createTestWorld();
    const r = await journal({ action: 'start', type: 'match' });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/@contact/); // it lists the watch-gated types
  });
});

describe('journal-events: read-path capture reporting', () => {
  it('a bare read with @contact idle surfaces captureHint + excludes it from captures.active', async () => {
    game = createTestWorld();
    await journal({ action: 'stop', type: '@contact' }); // make it idle
    const r = await journal({});
    expect(r.captures.active).not.toContain('@contact');
    expect(r.captureHint).toMatch(/@contact/);
    expect(r.captureHint).toMatch(/start/i);
  });

  it('a bare read with @contact capturing has NO captureHint', async () => {
    game = createTestWorld(); // @contact active by default
    const r = await journal({});
    expect(r.captures.active).toContain('@contact');
    expect(r.captureHint).toBeUndefined();
  });
});
