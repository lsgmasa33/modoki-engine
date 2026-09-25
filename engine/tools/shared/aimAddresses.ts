/**
 * ONE rule for how many addresses an aim may give — shared by every surface that reads a caller's
 * aim: the editor host (`engine/electron/inputRoutes.ts` `resolvePoint`), the renderer
 * (`engine/app/debug/domResolve.ts` `resolveCore`) and the device MCP
 * (`engine/tools/game-debug-mcp/src/mcp-tools.ts`). It lives in `tools/shared` because that is the
 * one directory all three already import.
 */

/** One of the four ways to say WHERE an aim lands. */
export type AimAddress = 'entity' | 'selector' | 'label' | 'x,y';

/** The addresses an aim spec gives — ONE is an aim, TWO is two targets for one point (#1556).
 *
 *  ⚠️ **Two is REFUSED (`AMBIGUOUS`), never settled by precedence** (owner, 2026-09-25, a deliberate
 *  breaking change). The old rule let `entity` beat `selector` beat `{x,y}` silently, so a call
 *  whose two addresses disagreed pressed one target and answered ok about it, while `label` beside
 *  either was already refused "because picking one by precedence would silently ignore the other".
 *  One predicate for every surface that reads a caller's aim — the editor host (`resolvePoint`),
 *  the renderer (`resolveCore`, which is what `modoki_dnd` reaches), and the DEVICE MCP (which
 *  checks the caller's spec BEFORE it adds `ENTITY_AIM_SKEW_SELECTOR`, the one deliberate second
 *  address on the wire) — so the rule cannot be implemented twice and drift.
 *
 *  What counts, matching how the resolvers have always read a spec: an `entity` object with at least
 *  one key (`{}` is what a conditional builder sends when it had nothing), a non-empty `selector`, any
 *  `label` (its resolver refuses an empty one by name), and EITHER coordinate — a lone stray `x`
 *  beside a selector is exactly the leftover precedence used to drop. Scroll wheel deltas
 *  (`deltaX`/`deltaY`, `dx`/`dy`) are not an address and are not read here. */
export function aimAddresses(spec: {
  entity?: unknown; selector?: unknown; label?: unknown; x?: unknown; y?: unknown;
} | null | undefined): AimAddress[] {
  if (!spec) return [];
  const out: AimAddress[] = [];
  const e = spec.entity;
  if (e && typeof e === 'object' && !Array.isArray(e) && Object.keys(e).length > 0) out.push('entity');
  if (typeof spec.selector === 'string' && spec.selector) out.push('selector');
  if (spec.label !== undefined) out.push('label');
  if (spec.x != null || spec.y != null) out.push('x,y');
  return out;
}

/** The refusal sentence for a spec giving more than one address, or null. Unprefixed: the editor
 *  opens it with `tap:`/`from:`, the device MCP puts it in its envelope's `why`. */
export function ambiguousAimMessage(addresses: readonly AimAddress[]): string | null {
  if (addresses.length < 2) return null;
  const named = addresses.map((a) => (a === 'x,y' ? '{x,y}' : a));
  return `give ONE of entity, selector, label or {x,y} — this aim gave ${named.join(' AND ')}, which are `
    + 'two addresses for one target, and picking one by precedence would silently ignore the other.';
}
