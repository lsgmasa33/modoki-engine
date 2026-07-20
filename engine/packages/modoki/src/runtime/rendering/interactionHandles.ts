/** Interaction-handle provider registry — the INPUT twin of screenBounds.ts.
 *
 *  Percept made surfaces READABLE: `screenBounds` turns "where is this entity on
 *  screen?" into numbers so Claude can reason without a screenshot. Enact needs the
 *  same for INPUT: the Canvas2D / SVG authoring editors (Skin bones, Dopesheet
 *  keyframes, Collider2D vertices, gizmo axes) have draggable HANDLES whose screen
 *  position Claude cannot discover — no DOM accessibility tree, and a downscaled
 *  capture ≠ CSS coords. Raw `drag` is useless if you can't aim it.
 *
 *  So each such editor registers a provider here that reports its live handles as
 *  viewport CSS-pixel points (the SAME coordinate space as `screenBounds` /
 *  `getBoundingClientRect`, so a handle coord drops straight into `drag`/`tap`).
 *  The `enact-handles` agent op merges them; `drag-handle`/`tap-handle` resolve a
 *  handle by id and issue the trusted gesture at its live coords.
 *
 *  Mirrors `screenBounds.ts`'s registration pattern exactly: providers register on
 *  mount, unregister on unmount; a provider that throws is skipped. */

/** One draggable/clickable handle in an authoring editor, in viewport CSS px. */
export interface InteractionHandle {
  /** Stable id UNIQUE across all providers — namespace it by editor+kind+index, e.g.
   *  'collider:vert:0', 'dope:key:Transform.x:3', 'skin:bone:root'. This is how
   *  `drag-handle`/`tap-handle` address it, so it must survive between a read and the
   *  immediately-following gesture (fine while the game is paused/authoring). */
  id: string;
  /** Handle category — 'collider-vertex' | 'keyframe' | 'tangent' | 'bone-joint' |
   *  'gizmo-axis' | 'slice-rect' | 'gradient-stop' | … — for filtering. */
  kind: string;
  /** Which editor produced it — 'collider2d' | 'dopesheet' | 'curves' | 'skin' | … */
  editor: string;
  /** Handle CENTRE in viewport CSS px (origin top-left) — the point to drag/click. */
  x: number;
  y: number;
  /** Optional human-readable label ('vertex 0', 'key t=0.5 Transform.x'). */
  label?: string;
  /** Optional provider-specific data (bone name, keyframe time/value, entity id) —
   *  passed through verbatim so Claude can pick the right handle semantically.
   *  By convention `meta.disabled: true` marks a control that is present but inert (a
   *  greyed-out Paste). That is DATA; a screenshot only offers a shade of grey. */
  meta?: Record<string, unknown>;
  /** The handle's full box, not just its centre — so an agent can compute overlap and
   *  aim off-centre. Canvas handles are points and omit it; DOM chrome always has one. */
  rect?: { x: number; y: number; w: number; h: number };
  /** Descriptor of whatever currently covers this handle's centre (a modal, an open menu,
   *  a scrim). Absent when nothing does, or when occlusion could not be checked. A trusted
   *  click hit-tests by coordinate, so an occluded handle CANNOT be clicked where it
   *  appears to be — the silent-miss class of bug, surfaced as data.
   *
   *  Filled in by `computeHandles`, not by providers: occlusion is a property of anything
   *  addressed by COORDINATE, which is every handle — not a DOM-chrome feature. */
  occludedBy?: string | null;
  /** The DOM element this handle lives in — its own element for chrome, the owning
   *  `<canvas>` for a Canvas2D/SVG editor's handle. Supplied so occlusion can be checked
   *  uniformly: an element is covered iff the topmost element at the handle's point is
   *  neither it nor a descendant.
   *
   *  NOT SERIALIZABLE. `computeHandles` strips it before the handle crosses the agent
   *  bridge as JSON. A provider that omits it gets no occlusion check (and is counted in
   *  `occlusionUnchecked`) rather than a silently wrong "not occluded". */
  owner?: unknown;
}

/** Optional narrowing for a handle query. */
export interface HandleFilter {
  editor?: string;
  kind?: string;
  /** Restrict to these handle ids. */
  ids?: string[];
}

/** A handle computer. Returns the editor's current handles (empty when it has none
 *  to offer — e.g. nothing selected, or the editor isn't in the right sub-mode). */
export type HandleProvider = () => InteractionHandle[];

const providers = new Set<HandleProvider>();

/** An authoring editor registers its handle computer (returns an unregister fn). */
export function registerHandleProvider(fn: HandleProvider): () => void {
  providers.add(fn);
  return () => { providers.delete(fn); };
}

/** Ids already reported as duplicated, so the warning fires once per id rather than on
 *  every `modoki_handles` poll. */
const warnedDuplicates = new Set<string>();

/** Collect handles from every registered provider, optionally filtered. A provider
 *  that throws is skipped (one bad editor can't break the whole report).
 *
 *  DUPLICATE IDS ARE A BUG, and a silent one: `resolveHandle` takes the FIRST match, so a
 *  second handle sharing an id is simply never reachable and `tap_handle` drives the wrong
 *  element with no signal. Canvas ids are generated and unique by construction; chrome ids
 *  are hand-authored `data-ui-id` strings on the honour system. Warn loudly (dev only —
 *  this is an editor-side registry) rather than let a wrong click look like a right one. */
export function collectHandles(filter?: HandleFilter): InteractionHandle[] {
  const idSet = filter?.ids && filter.ids.length ? new Set(filter.ids) : undefined;
  const out: InteractionHandle[] = [];
  const seen = new Set<string>();
  for (const p of providers) {
    let handles: InteractionHandle[];
    try { handles = p(); } catch { continue; } // skip a failing editor
    for (const h of handles) {
      if (filter?.editor && h.editor !== filter.editor) continue;
      if (filter?.kind && h.kind !== filter.kind) continue;
      if (idSet && !idSet.has(h.id)) continue;
      if (seen.has(h.id) && !warnedDuplicates.has(h.id)) {
        warnedDuplicates.add(h.id);
        console.error(`[interactionHandles] duplicate handle id ${JSON.stringify(h.id)} — tap_handle/drag_handle resolve the FIRST match, so the others are unreachable. Give each surface a unique id (a shared component must take its id from the caller).`);
      }
      seen.add(h.id);
      out.push(h);
    }
  }
  return out;
}

/** Resolve a single handle by exact id (for `drag-handle`/`tap-handle`). Returns null
 *  if no live handle currently has that id. */
export function resolveHandle(id: string): InteractionHandle | null {
  return collectHandles({ ids: [id] })[0] ?? null;
}
