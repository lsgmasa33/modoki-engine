/** Warn-once for an unrecognised value in a hand-authored JSON string vocabulary (#73).
 *
 *  Several trait/asset-JSON fields hold a fixed string union (a `bodyType`, a `shape`, a
 *  `scaleMode`, …) that the consumer branches on with a silent fallback — a typo produces a
 *  plausible WRONG result instead of a diagnosable one. The fix is never to change what the
 *  fallback DOES (that's a behaviour change, out of scope per #73) — only to stop it being
 *  silent. Call this immediately before taking the fallback branch.
 *
 *  Dedupes on `scope|field|value` in a module-level Set so a value that keeps recurring
 *  (e.g. every frame of a per-particle hot path) logs exactly once. These are AUTHORED
 *  vocabularies (a handful of distinct bad strings per scope/field over a session), so the
 *  Set cannot grow unbounded from runtime-varying data the way a per-entity key would.
 *
 *  Modeled on the existing per-file warn-once helpers (`warnShapeOnce` in
 *  physics2DSystem.ts/physics3DSystem.ts, similar ones in audioBufferCache/meshTemplateCache/
 *  riggedModelCache/modelGlbUrl) and on `oneOf()` in project-config.ts — this is the shared
 *  version for the 8 sites found by the #73 sweep; the existing per-file ones are left alone
 *  (out of scope, not being refactored onto this). */

const warnedVocab = new Set<string>();

/** Warn once (per `scope|field|value`) that `value` is not a recognised member of a field's
 *  authored vocabulary. `consequence` names what the existing fallback behaviour actually
 *  does (e.g. `treated as 'dynamic'`) — never invent a new one, just describe the current
 *  fallthrough so the message is honest about what happens next. */
export function warnVocabOnce(scope: string, field: string, value: unknown, consequence: string): void {
  const key = `${scope}|${field}|${String(value)}`;
  if (warnedVocab.has(key)) return;
  warnedVocab.add(key);
  console.warn(`[${scope}] unknown ${field} '${String(value)}' — ${consequence}.`);
}
