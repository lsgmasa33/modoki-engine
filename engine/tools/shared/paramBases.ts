/** Param wordings BOTH MCP servers share (#1559, conventions §2). They lived in modoki-mcp's
 *  `shapes.ts`, so the device server restated them — `precision` three ways across six device tools,
 *  `timeoutMs` three ways across three — and nothing checked the device surface for it. The one-meaning
 *  check now runs over both surfaces, which is what moved these here. */

/** The shared half of every `timeoutMs` description (#1154 made it three tools). Each tool
 *  CONCATENATES its own default and ceiling, which really do differ. */
export const TIMEOUT_MS_BASE = 'How long to wait before giving up, in ms';

/** `precision`, in ONE wording (§2).
 *
 *  It said the same thing four ways across seven tools — the long form, a terse "(read)" form, a
 *  per-tool field list, and a scene-query variant. Nothing was wrong with any of them, which is the
 *  point: a param an agent has to re-read per tool to check it still means what it meant is the
 *  cost §2 is about, and every one of these drifted by being restated rather than shared.
 *
 *  A tool keeps the one genuinely per-tool part — WHICH floats get rounded — by appending it. */
export const PRECISION_BASE = 'Significant digits for returned floats (default 9; 0 = exact). Verify with a TOLERANCE, never ===';
