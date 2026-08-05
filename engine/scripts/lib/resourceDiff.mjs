/** Identity diff of two scene `resources` manifests — the part of `check-scene-churn.mjs`
 *  that has already been wrong once, extracted so it can be tested without a git fixture.
 *
 *  The gate used to compare only the manifest's LENGTH (`RESOURCES n -> m`). A count is the
 *  one property a dropped ref can preserve while still being a drop, so it was silent on a
 *  1-for-1 swap: the games/space-invader re-save that closed #123 swapped a legacy
 *  page-texture GUID for the sprite GUID the scene actually references, and the gate said
 *  "0 semantic changes". */

/** @typedef {{ note: string, regression: boolean }} ResourceNote */

/**
 * @param {Array<{type: string, path: string}>|undefined} before  HEAD's manifest
 * @param {Array<{type: string, path: string}>|undefined} after   the re-saved manifest
 * @param {string} bodyText  the NEW scene serialized WITHOUT its `resources` array — used to
 *   decide whether a dropped ref is still referenced. A whole-body string scan on purpose,
 *   not a walk of known ref fields: the #123 case was a ref on a GAME trait, which is exactly
 *   what a known-fields walk cannot see. A false "still referenced" costs a second look; a
 *   false "gone" is the bug this gate exists to catch.
 * @returns {ResourceNote[]}
 */
export function diffResources(before, after, bodyText) {
  const byPath = (list) => new Map((list || []).map((r) => [r.path, r.type]));
  const A = byPath(before), B = byPath(after);
  /** @type {ResourceNote[]} */
  const notes = [];

  for (const [p, t] of A) {
    if (B.has(p)) {
      // Same ref, different type: not a drop-plus-add — it is the same asset acquired down a
      // different path, and two lines would bury that.
      if (B.get(p) !== t) notes.push({ note: `RESOURCE RETYPED ${p}  ${t} -> ${B.get(p)}`, regression: false });
      continue;
    }
    if (bodyText.includes(p)) {
      notes.push({ note: `⚠️ REGRESSION: RESOURCE DROPPED ${t}:${p} — STILL REFERENCED in the scene body`, regression: true });
    } else {
      notes.push({ note: `RESOURCE DROPPED ${t}:${p} (no longer referenced — check nothing reaches it indirectly)`, regression: false });
    }
  }
  for (const [p, t] of B) if (!A.has(p)) notes.push({ note: `RESOURCE ADDED ${t}:${p}`, regression: false });

  return notes;
}

/** The scene body a dropped ref is looked for in: everything EXCEPT the manifest itself
 *  (otherwise every ref trivially "still referenced" — it is in the list being compared). */
export function sceneBodyText(scene) {
  return JSON.stringify({ ...scene, resources: undefined });
}
