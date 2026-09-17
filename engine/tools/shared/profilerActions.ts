/** The `profiler` op's actions, split by METHOD (#1213 B-6).
 *
 *  The list used to exist four times — the op's `switch` labels, the GET route's inline `MUTATING`
 *  array, and a `z.enum` in each MCP server — and the op itself checked nothing: an unknown action
 *  fell through to `default: read`, so a POST (or an eval, or a device relay) of `capture-strat`
 *  answered a live read and the caller believed a capture had started. The MCP enums hid that from
 *  tool calls only. ONE declaration now: the op refuses against it, the route splits GET/POST by it,
 *  and both tool schemas derive their enum from it.
 *
 *  Dependency-free ON PURPOSE, like `inputVocabulary.ts`: the Node backend, both MCP servers and the
 *  device-shipped bridge import it as a VALUE. */

/** Actions that only read — served by GET. `read` first: it is the default. */
export const PROFILER_READ_ACTIONS = ['read', 'capture-read', 'boot'] as const;
/** Actions that change profiler state — POST only (conventions §4). */
export const PROFILER_MUTATING_ACTIONS = ['capture-start', 'capture-stop', 'capture-clear', 'gpu-on', 'gpu-off', 'reset', 'boot-reset'] as const;
export const PROFILER_ACTIONS = [...PROFILER_READ_ACTIONS, ...PROFILER_MUTATING_ACTIONS] as const;
export type ProfilerAction = (typeof PROFILER_ACTIONS)[number];

export function isProfilerAction(action: unknown): action is ProfilerAction {
  return typeof action === 'string' && (PROFILER_ACTIONS as readonly string[]).includes(action);
}
