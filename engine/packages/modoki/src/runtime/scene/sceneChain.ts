/** Base-scene chain resolution (base-scene persistence plan, Phase 4).
 *
 *  A scene may declare a `baseScene` ref (a guid) — the base is loaded additively
 *  and survives a swap to another scene sharing the same base (see
 *  docs/scene-loading.md, "Base scenes"). Resolving which scenes belong
 *  to a given "primary" scene's chain is a pure walk: start at the primary, follow
 *  each scene's `baseScene` ref upward until one has none.
 *
 *  Pure function, no SceneManager wiring — `fetchSceneMeta` is caller-supplied so
 *  this is trivially unit-testable and has no runtime dependency yet. Phase 5 wires
 *  a real implementation (path fetch for the primary, guid→path resolution via the
 *  asset manifest for every base hop) into SceneManager.loadScene. */

/** One resolved link in a scene's base chain. */
export interface SceneRef {
  path: string;
  guid: string;
}

/** What the walk needs to know about a single scene to continue upward. */
export interface SceneChainMeta {
  guid: string;
  path: string;
  /** This scene's own `baseScene` ref (a guid), if any. */
  baseScene?: string;
}

/** Resolve a scene's metadata given a locator — the starting scene's PATH for the
 *  first call, and each subsequent hop's `baseScene` GUID thereafter. Returns null
 *  when the locator can't be resolved (a dangling guid, a missing/unfetchable
 *  file). */
export type FetchSceneMeta = (locator: string) => Promise<SceneChainMeta | null>;

/** Runaway backstop for the chain walk, mirroring NavigationManager.MAX_HISTORY.
 *  A real project will never approach this — it exists so a malformed/cyclic
 *  authoring mistake degrades instead of looping forever. */
const MAX_CHAIN_DEPTH = 50;

/** Walk `baseScene` refs from `startPath` upward. A cycle, a dangling ref, or the
 *  depth cap all WARN and DEGRADE — the walk stops and returns whatever resolved,
 *  it never throws (an authoring mistake must not brick a scene load).
 *
 *  Returned chain order is root-most base FIRST, the starting (level) scene LAST —
 *  the order things must be additively loaded in so the level's own entities win. */
export async function resolveSceneChain(
  startPath: string,
  fetchSceneMeta: FetchSceneMeta,
): Promise<{ chain: SceneRef[]; warnings: string[] }> {
  const warnings: string[] = [];
  // Built level-first / root-last as we walk upward; reversed once at the end.
  const levelFirst: SceneRef[] = [];
  // Guids seen THIS walk only — cycle detection is per-call, never leaked across
  // resolveSceneChain calls (two independent chains may legitimately share a base).
  const visited = new Set<string>();

  let locator: string | undefined = startPath;
  let depth = 0;
  while (locator !== undefined) {
    if (depth >= MAX_CHAIN_DEPTH) {
      warnings.push(
        `[sceneChain] depth cap (${MAX_CHAIN_DEPTH}) reached resolving the chain for "${startPath}" — truncated.`,
      );
      break;
    }
    const meta = await fetchSceneMeta(locator);
    if (!meta) {
      warnings.push(
        `[sceneChain] could not resolve "${locator}" while walking the chain for "${startPath}" — stopping there.`,
      );
      break;
    }
    if (visited.has(meta.guid)) {
      warnings.push(
        `[sceneChain] cycle detected — scene "${meta.path}" (guid ${meta.guid}) already appears in the chain ` +
        `for "${startPath}" — stopping there.`,
      );
      break;
    }
    visited.add(meta.guid);
    levelFirst.push({ path: meta.path, guid: meta.guid });
    locator = meta.baseScene;
    depth++;
  }

  return { chain: levelFirst.reverse(), warnings };
}
