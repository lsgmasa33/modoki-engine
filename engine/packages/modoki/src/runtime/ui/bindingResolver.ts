/** Binding resolver — resolves text templates from a store state object, falling
 *  back to the read-source registry (Manager/System-exposed live values). */

import { getReadValue } from './readSourceRegistry';

/** Resolve "{field}" placeholders in a text template. Each placeholder resolves
 *  against the store `state` first, then a registered read source, else stays
 *  literal (`{field}`). `null`/`undefined` count as "absent": a `null` store
 *  field falls through to a read source (and renders empty if neither resolves),
 *  rather than rendering the literal string "null". Falsy-but-present values
 *  (0, false, '') DO resolve — they're meaningful. */
export function resolveTemplate(template: string, state: Record<string, unknown>): string {
  if (!template.includes('{')) return template;
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    let val = state[key];
    if (val == null) val = getReadValue(key); // == catches null + undefined
    return val != null ? String(val) : `{${key}}`;
  });
}

/** Evaluate a state-driven visibility binding. Reads `field` from the store state (then the
 *  read-source registry), then: no `op` ⇒ truthy test; otherwise compare against `value` —
 *  numeric when both sides look numeric, else string. An empty `field` is "no binding" (true, so
 *  the caller's authored isVisible wins). An unknown `op` never hides (returns true). */
export function evalVisibility(state: Record<string, unknown>, field: string, op: string, value: string): boolean {
  if (!field) return true;
  let raw = state[field];
  if (raw == null) raw = getReadValue(field); // == catches null + undefined
  if (!op) return !!raw && raw !== 'false' && raw !== '0';   // truthy (string 'false'/'0' count as false)
  const rn = Number(raw), vn = Number(value);
  const numeric = raw != null && raw !== '' && !Number.isNaN(rn) && !Number.isNaN(vn);
  if (numeric) {
    switch (op) {
      case '==': return rn === vn;
      case '!=': return rn !== vn;
      case '>': return rn > vn;
      case '>=': return rn >= vn;
      case '<': return rn < vn;
      case '<=': return rn <= vn;
      default: return true;
    }
  }
  const s = String(raw ?? '');
  switch (op) {
    case '==': return s === value;
    case '!=': return s !== value;
    case '>': return s > value;
    case '>=': return s >= value;
    case '<': return s < value;
    case '<=': return s <= value;
    default: return true;
  }
}
