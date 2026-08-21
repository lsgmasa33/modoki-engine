/** `/api/editor-action`'s routing key is literally `action`, and the route STRIPS it before
 *  relaying — so a tool with an `action` param of its own can never deliver it through that
 *  relay, whichever way the spread is ordered.
 *
 *  This has caught two tools, in opposite and instructive ways:
 *
 *   • `modoki_prefab` spread its args (including `action:'instantiate'`) OVER the routing key, so
 *     every call sent 'instantiate' as the OP NAME and came back a 400 listing the valid ops.
 *     Loud, immediately obvious, fixed by renaming the param to `prefabAction`.
 *   • `modoki_write_player_prefs` (#288 Phase 2) hit the QUIET half. The fix for the first bug —
 *     putting `action` last — protects the routing key by silently DROPPING the tool's own param.
 *     The op ran with `action: undefined`, and every layer in between reported success.
 *
 *  The comment left after the first fix ("a tool needing one must pick another name") was a
 *  convention with nothing enforcing it, and the second bug is what that costs. T1 and T2 could
 *  not see it either: the request the tool built was exactly the request its contract declared.
 *  So this file enforces both halves — the runtime refusal, and the structural rule that would
 *  have made the runtime refusal unnecessary.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createToolContext } from '../../tools/modoki-mcp/src/context';
import { loadSurface, type Surface } from './mcpSurface';

let surface: Surface | undefined;
afterEach(() => { surface?.restore(); surface = undefined; });

describe('editorAction refuses a params object carrying `action`', () => {
  const ctx = createToolContext({ backend: 'http://stub.modoki.test' });

  it('refuses instead of dropping it — and never reaches the network', async () => {
    // No fetch stub is installed here ON PURPOSE: if the refusal did not fire, this would attempt
    // a real request to a nonexistent host, so the assertion cannot pass vacuously.
    const r = await ctx.editorAction('some-op', { action: 'set', key: 'k' });
    const text = r.content.map((c) => c.text).join('');
    expect(text).toMatch(/REFUSED_BY_OP/);
    expect(text).toMatch(/routing key/);
    // The refusal must say this is a TOOL defect, not blame the caller — the person reading it is
    // the tool author, and "your argument was wrong" would send them to fix the call site.
    expect(text).toMatch(/TOOL DEFECT/);
    // …and it must name both real ways out, or it is just a stop sign.
    expect(text).toMatch(/prefabAction/);
    expect(text).toMatch(/own POST route/);
  });

  it('an ordinary params object still relays', async () => {
    surface = loadSurface();
    // Any tool that genuinely uses the relay proves the guard did not break the common path.
    await surface.call('modoki_set_timescale', { scale: 1 });
    expect(surface.last()?.path).toBe('/api/editor-action');
    expect((surface.last()?.body as { action?: string })?.action).toBe('set-timescale');
  });
});

/* A structural sibling — "no relay tool may DECLARE an `action` param" — was written here and
 * then DELETED, because it was both wrong and unnecessary.
 *
 * Wrong: `modoki_prefab` legitimately declares one and TRANSLATES it on the wire
 * (`editorAction('prefab', {...rest, prefabAction: action})`), so the declaration is not the
 * defect — sending it under that name is. The rule would have needed an exemption for the very
 * tool the trap is named after, which is how a heuristic guard starts drifting toward a list.
 *
 * Unnecessary: with the runtime refusal above in place, the collision is already caught by the
 * EXISTING table-driven T2 suite, which calls every tool with its `minimalArgs`. Verified by
 * putting the bug back — routing `modoki_write_player_prefs` through the relay again makes
 * `mcpToolContracts.test.ts` fail with "modoki_write_player_prefs never called
 * /api/editor-action; it called: (nothing)". So the refusal does not merely document the trap: it
 * converts an invisible wrong-argument bug into a loud no-request-at-all one that a guard already
 * watching the whole surface can see. That is the coverage; a second, weaker rule would only add
 * a place for an exemption to accumulate.
 */
