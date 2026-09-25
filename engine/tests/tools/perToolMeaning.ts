/** Param names that are DECLARED to mean a different thing per tool, so the §2 one-meaning check
 *  (`a param used by 3+ tools means ONE thing`) exempts them. Shared by the editor surface's check
 *  (`mcpRegistry.test.ts`, which also keeps the list honest through its exemption ledger) and the
 *  device surface's (`deviceToolSurface.test.ts`) — see mcpRegistry.test.ts for each entry's history. */
export const PER_TOOL_MEANING: readonly string[] = [
  'path', 'name', 'kind', 'id', 'ids', 'key', 'limit', 'all', 'from', 'to',
  'guid', 'guids', 'quality', 'selector', 'button', 'steps', 'entity', 'parentId',
  'parentGuid', 'action', 'type',
  // #1152/#1153: an AIM on the input tools ("press the element labelled X") and a FILTER on
  // modoki_handles ("list the handles labelled X"). Two jobs, deliberately one word: both match by
  // the same `labelMatches` rule, so the filter previews exactly what the aim would hit.
  'label',
  // `target` is the thing a tool is AIMED at, typed each time — the `path` pattern: a look-at point
  // on the render tools, an asset/entity GUID on modoki_find_references, a relative name-path on the
  // animation/timeline key-adders (#1560 gave anim_add_key the timeline's word for that path).
  'target',
];
