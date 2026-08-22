/** Enact — trusted input (Electron only): tap/drag/pointer/hover/scroll/keys/handles/text.
 *
 *  Registered by `registerAllTools` (`../registerAll.ts`). Side-effect-free on import:
 *  nothing here runs until the register function is called, which is what lets a test
 *  build a context against a stub backend and call these handlers. See `../context.ts`.
 */

import { z } from 'zod';
import type { ToolDef } from '../toolDef.js';
import type { ToolContext } from '../context.js';
import { ALLOW_OCCLUDED_BASE, MODIFIERS_BASE, allowOccludedParam, entitySpec, modifierEnum, pointSpec } from '../shapes.js';

export function registerInputTools(tool: ToolDef, ctx: ToolContext): void {
  const { getJson, postJson, evalRenderer, editorAction } = ctx;

  /** Built-in panel ids, shared by the two `panel` params so they cannot drift. Deliberately
   *  NOT a z.enum: a game can register custom panels, so the real vocabulary is only knowable
   *  server-side — which is where the refusal lives (#301). */
  const IDS = 'scene | game | hierarchy | inspector | console | assets | animation-editor | '
    + 'timeline-editor | particle-editor | spriteanim-editor | skin-editor | profiler | ai';

  // ── tap — trusted input (Electron editor only) ──
  tool(
    'modoki_tap',
    'Inject a REAL trusted click — flows through Chromium hit-testing so PixiJS and ' +
      'Three.js both receive it. THREE WAYS TO AIM, best first: `entity` ({guid|name|id}) for a ' +
      'scene entity, `selector` (a CSS selector) for editor chrome, or page CSS `x,y` as a last ' +
      'resort. The first two resolve to a live point INSIDE this call — no read-then-tap race — ' +
      'so prefer them; `x,y` read from an earlier get_scene_state call is aiming at where the ' +
      'target WAS. The response reports `matched` (what resolved), `hitTarget` (the topmost ' +
      'element at that point). A target something COVERS is REFUSED, naming the cover — the click ' +
      'would land on that instead, and reporting ok for it would be a false success; pass ' +
      '`allowOccluded:true` to click anyway. An entity aim also reports `occlusionScope`: read ' +
      '`occluded:false` as trustworthy for "element" (UI) but NOT for "canvas" (2D/3D), where a ' +
      'mesh in front of the target is not detected. Then verify with get_scene_state. ' +
      "`button:'right'` opens a context menu; `clickCount:2` double-clicks; " +
      "`modifiers:['shift'|'meta']` multi-select on canvas. Requires the Electron editor.",
    {
      x: z.number().optional().describe('Page CSS x. Required unless `selector` is given.'),
      y: z.number().optional().describe('Page CSS y. Required unless `selector` is given.'),
      // The example must name a selector that EXISTS: `inspector.header.kebab` did not (the
      // Inspector has no kebab menu at all), and being the docstring example is exactly how a
      // wrong selector propagates — it was copied into a QA case brief before anyone checked.
      selector: z.string().optional().describe("CSS selector to aim at, e.g. '[data-ui-id=\"inspector.header.delete\"]'. Overrides x/y."),
      entity: entitySpec.optional(),
      button: z.enum(['left', 'right', 'middle']).optional().describe("Mouse button (default 'left')."),
      clickCount: z.number().optional().describe('1 = single (default), 2 = double-click.'),
      modifiers: z.array(modifierEnum).optional().describe(`${MODIFIERS_BASE}.`),
      allowOccluded: allowOccludedParam,
    },
    async ({ x, y, selector, entity, button, clickCount, modifiers, allowOccluded }) => postJson('/api/input/tap', { x, y, selector, entity, button, clickCount, modifiers, allowOccluded }),
  );

  // ── drag — trusted gesture (Electron editor only) ──
  tool(
    'modoki_drag',
    'Inject a REAL trusted drag with intermediate moves (gesture thresholds like match-3 ' +
      'swaps / gizmo drags need them). Each endpoint is `{entity}` ({guid|name|id}), ' +
      '`{selector}`, or page CSS `{x,y}` — the first two resolved to a live point in the ' +
      "same call). `button:'middle'`/'right' = " +
      "orbit-pan the 3D viewport; `modifiers:['shift']` = gizmo snap. A modifier is genuinely " +
      'HELD for the gesture — pressed as a real key after the mousedown and released after the ' +
      'mouseup, not just set as a bit on the mouse events — so a listener that tracks the ' +
      "modifier's LEVEL (the SceneView 3D gizmo's snap does) sees it down for every intermediate " +
      'move. For HTML5 drag-and-drop ' +
      '(asset→slot, reparent) use modoki_dnd, NOT this. Requires the Electron editor.',
    {
      from: pointSpec.describe('Drag origin: {entity} | {selector} | {x,y}.'),
      to: pointSpec.describe('Drag destination: {entity} | {selector} | {x,y}.'),
      steps: z.number().optional().describe('Intermediate move count (default 10).'),
      button: z.enum(['left', 'right', 'middle']).optional().describe("Mouse button (default 'left')."),
      modifiers: z.array(modifierEnum).optional().describe(`${MODIFIERS_BASE}, held for the WHOLE drag as a real keyDown/keyUp around the gesture — so a listener tracking the modifier's LEVEL (the 3D gizmo's snap) sees it down for every intermediate move.`),
      allowOccluded: allowOccludedParam.describe(`${ALLOW_OCCLUDED_BASE}. Applies to BOTH endpoints; set it on \`from\`/\`to\` individually to allow just one — e.g. a covered destination while keeping the press honest.`),
    },
    async ({ from, to, steps, button, modifiers, allowOccluded }) => postJson('/api/input/drag', { from, to, steps, button, modifiers, allowOccluded }),
  );

  // ── pointer — SUSTAINED (held-across-calls) trusted press (Electron editor only) ──
  tool(
    'modoki_pointer',
    'Sustained/HELD trusted pointer — the stateful twin of modoki_drag, split into separate ' +
      'calls. `action:"down"` presses at a point and LEAVES the button held; `action:"move"` ' +
      're-aims the held pointer (a drag-move); `action:"up"` releases. Between calls the press ' +
      'PHYSICALLY persists (no mouseUp is sent), so you can read state that exists only WHILE the ' +
      'button is held — a slingshot pull preview, a charge-up meter, a drag-to-aim rubber-band — ' +
      'with get_scene_state / modoki_eval / a screenshot mid-gesture (the atomic modoki_drag can\'t ' +
      'expose it). Typical loop: down → (read) → move → (read) → up. Aim by `{entity}`, `{selector}`, or `{x,y}`. ' +
      'move/up reuse the held button; a move/up with nothing held is refused (409). ' +
      'THE HOLD IS NOT INDEFINITE: the backend releases it for you after 120s with no move/up, and ' +
      'a later modoki_tap/drag/tap_handle/drag_handle releases it immediately (a second mouse ' +
      'gesture cannot coexist with a held press). Both dispatch the real mouseup, and the next ' +
      'move/up then tells you it happened. This exists because a press left held latches the ' +
      "renderer's pointer input and kills dragging for the HUMAN too, with no error anywhere " +
      '(#302) — so release with `action:"up"` when you are done, and keep a long gesture moving. ' +
      'modoki_get_editor_state reports `heldPointer` if you need to check. ' +
      'Requires the Electron editor.',
    {
      action: z.enum(['down', 'move', 'up']).describe("'down' press+hold, 'move' re-aim the held pointer, 'up' release."),
      x: z.number().optional().describe('Page CSS x. Required unless `selector` is given.'),
      y: z.number().optional().describe('Page CSS y. Required unless `selector` is given.'),
      selector: z.string().optional().describe('CSS selector to aim at (resolved server-side). Overrides x/y.'),
      entity: entitySpec.optional(),
      button: z.enum(['left', 'right', 'middle']).optional().describe("Mouse button for 'down' (default 'left'); ignored on move/up (the held button is reused)."),
      modifiers: z.array(modifierEnum).optional().describe(`${MODIFIERS_BASE}.`),
      allowOccluded: allowOccludedParam.describe(`${ALLOW_OCCLUDED_BASE}. Applies to \`action:'down'\` only — a move/up is delivered to whatever captured the press, so what sits under the destination cannot stop it.`),
    },
    async ({ action, x, y, selector, entity, button, modifiers, allowOccluded }) =>
      postJson('/api/input/pointer', { action, x, y, selector, entity, button, modifiers, allowOccluded }),
  );

  // ── hover — trusted bare mouse-move (Electron editor only) ──
  tool(
    'modoki_hover',
    'Move the mouse with NO button held — triggers hover states, tooltips, and ' +
      'hover-to-open submenus that a click or drag-move cannot. Aim with `entity` ' +
      '({guid|name|id}), a CSS `selector`, or page CSS `x,y`. Requires the Electron editor.',
    {
      x: z.number().optional().describe('Page CSS x. Required unless `selector` is given.'),
      y: z.number().optional().describe('Page CSS y. Required unless `selector` is given.'),
      selector: z.string().optional().describe('CSS selector to aim at. Overrides x/y.'),
      entity: entitySpec.optional(),
      modifiers: z.array(modifierEnum).optional().describe(`${MODIFIERS_BASE}.`),
      allowOccluded: allowOccludedParam,
    },
    async ({ x, y, selector, entity, modifiers, allowOccluded }) => postJson('/api/input/hover', { x, y, selector, entity, modifiers, allowOccluded }),
  );

  // ── scroll — trusted mouse-wheel (Electron editor only) ──
  tool(
    'modoki_scroll',
    'Inject a trusted mouse-wheel. deltaY > 0 scrolls the content DOWN (wheel ' +
      'toward you); deltaX scrolls horizontally. Unlocks orbit-cam wheel-zoom, scrolling a ' +
      'long list/panel (aim it with a `selector` for that panel, or `entity` for a scene '  +
      'entity), and cursor-anchored zoom ' +
      'in the Canvas2D editors (Skin/Slicer/Particle). ~120 units ≈ one wheel tick. ' +
      'Pass `modifiers` to drive a modifier-gated wheel handler — e.g. Ctrl/Cmd+wheel UI-zoom ' +
      'or the Curve Editor value-axis zoom (a bare wheel never trips those). ' +
      'A scroll with no non-zero delta is REFUSED (it would deliver nothing while reporting ok) — ' +
      'the same no-op refusal modoki_drag makes. Requires the Electron editor.',
    {
      x: z.number().optional().describe('Page CSS x. Required unless `selector` is given.'),
      y: z.number().optional().describe('Page CSS y. Required unless `selector` is given.'),
      selector: z.string().optional().describe('CSS selector to aim at. Overrides x/y.'),
      entity: entitySpec.optional(),
      deltaX: z.number().optional().describe('Horizontal wheel delta (default 0). At least ONE of deltaX/deltaY must be non-zero — a zero-delta scroll is REFUSED, not dispatched as a silent no-op.'),
      deltaY: z.number().optional().describe('Vertical wheel delta; positive = content down. Default 0, but a call with neither delta non-zero is REFUSED (~120 ≈ one wheel tick).'),
      modifiers: z.array(modifierEnum)
        .optional().describe(`${MODIFIERS_BASE}, set on the wheel event (e.g. ["control"] or ["meta"] for Ctrl/Cmd+wheel zoom).`),
      allowOccluded: allowOccludedParam,
    },
    async ({ x, y, selector, entity, deltaX, deltaY, modifiers, allowOccluded }) => postJson('/api/input/scroll', { x, y, selector, entity, deltaX, deltaY, modifiers, allowOccluded }),
  );

  // ── eval — evaluate JS in the editor renderer (Electron editor only) ──
  tool(
    'modoki_eval',
    'Evaluate JavaScript in the editor RENDERER and return the value — the editor twin of ' +
      'device_eval. Reads/pokes LIVE renderer state a static file read cannot (a global like ' +
      'window.__3d, window.innerWidth/devicePixelRatio, a React fiber value, WGSL validation, or ' +
      'dispatching a bridge event), so you no longer need a raw CDP client for it. Runs as a ' +
      'function body: use `return` to yield a value. The result is safe-stringified in the renderer, ' +
      'so return a PROJECTION for anything large/circular (e.g. `return {w: innerWidth, h: innerHeight}` ' +
      '— a bare `window` or DOM node serializes poorly). A thrown error is reported as a tool error. ' +
      '`await` is allowed (the body is an async function), so several promise-returning modoki.* ops ' +
      'compose in ONE call; an un-awaited promise nested in the result reports itself rather than ' +
      'serializing to {}. Requires the Electron editor.',
    {
      code: z.string().describe('JavaScript to run in the editor renderer. Use `return` for a value.'),
      timeoutMs: z.number().int().positive().optional().describe(
        'How long the body may run before it is abandoned. Default 5000, max 25000 (clamped, not ' +
        'refused). Raise it when the code awaits something slow — e.g. modoki.waitForEdit(), which ' +
        'parks by design and could never outlive the old fixed budget. The device twin caps LOWER ' +
        '(4500): its TCP transport has a fixed 5s per-request deadline it cannot exceed.',
      ),
    },
    async ({ code, timeoutMs }) => evalRenderer(code, timeoutMs),
  );

  // ── eval-api — discovery for modoki_eval's injected `modoki` object ──
  tool(
    'modoki_eval_api',
    'Discovery for modoki_eval: lists every registered agent op as both its raw op name and the ' +
      'generated camelCase method modoki_eval\'s injected `modoki` object exposes for it ' +
      '(`layout-bounds` -> `modoki.layoutBounds(params)`), plus the fixed helpers `modoki.call(op, params)`, ' +
      '`modoki.ops()`, `modoki.api(path, init)` (a host route with no matching op, via backendFetch), and ' +
      '`modoki.composite(label, fn)` (collapse a script\'s edits into ONE undo entry). Call this before ' +
      'writing a modoki_eval script instead of reading source to find the surface. Requires the Electron editor.',
    {},
    async () => getJson('/api/eval-api'),
  );

  // ── menu — introspect + fire NATIVE application-menu items (Electron editor only) ──
  tool(
    'modoki_menu',
    'Introspect or fire the editor\'s NATIVE application-menu items. `modoki_press_key` CANNOT ' +
      'trigger native menu accelerators (Chromium swallows them), so menu-only actions — View → ' +
      'Zoom In/Out/Actual Size, and any relayed menu item — are otherwise unreachable from MCP. ' +
      'Call with no args (or `list:true`) to get the menu tree (each node carries the `path` and ' +
      '`id` you can fire, plus `enabled`/`accelerator`); pass `path` (e.g. "View/Zoom In", ' +
      'case-insensitive, `/` or `>` separators) or `id` to invoke that item\'s click — the same ' +
      'callback a human\'s click runs. A miss lists the available actionable paths. ' +
      'Requires the Electron editor.',
    {
      path: z.string().optional().describe('Label path of the item to fire, e.g. "View/Zoom In".'),
      id: z.string().optional().describe('Menu item id to fire (alternative to path).'),
      list: z.boolean().optional().describe('Return the full menu tree instead of firing an item.'),
    },
    async ({ path, id, list }) =>
      (list || (!path && !id)) ? postJson('/api/menu', { list: true }) : postJson('/api/menu', { path, id }),
  );

  // ── press_key — standalone trusted key chord (Electron editor only) ──
  tool(
    'modoki_press_key',
    'Press a single trusted key chord (keyDown+keyUp) into the focused element — the ' +
      'standalone keys typeText can only send as a terminal submitKey: Escape (close modal/' +
      'picker), Delete/Backspace, arrows (nudge), and editor hotkeys (W/E/R gizmo mode, F ' +
      "frame, X space, Cmd+Z undo). `key` is an Electron keyCode ('Escape', 'Delete', " +
      "'ArrowUp', 'w'). The key is HELD ~3 frames so per-frame game input sampling (nav/jump/" +
      'confirm) registers the edge. If keys do not reach the GAME, a DOM text field is likely ' +
      'focused (Console filter, inspector) — call modoki_focus (no selector) first to blur it. ' +
      'PANEL-SCOPED CHORDS: editor shortcuts resolve against the FOCUSED PANEL, so a bare `w` ' +
      'sent while the wrong panel is focused does NOTHING — silently, because the dispatcher ' +
      'yields rather than erroring. Pass `panel` to set the keyboard scope first instead of ' +
      'tapping-and-hoping; the response echoes `focusedPanel`. ' +
      'TWO GATES STOP A KEY REACHING THE GAME, and naming only the first cost a QA run a '
      + 'false "the character controller is broken" (QA-PHYS-0003): (1) a focused text field, '
      + 'which modoki_focus with no selector clears, and (2) the KEYBOARD SCOPE — while any '
      + 'panel other than the Game panel owns it, the editor gate suppresses input to the '
      + 'running game entirely. A bare modoki_focus {} fixes only the first. Pass panel:"game" '
      + 'to drive the game. The response now echoes `focusedPanel` on every press, and warns '
      + 'when a press reached NOTHING (no editor binding claimed it and the gate blocked it). '
      + 'CAVEAT: this is renderer-level input — it does NOT trigger native Electron MENU ' +
      'accelerators, so a chord the OS menu claims (Cmd+R reload, Cmd+Alt+I devtools, and on ' +
      'Windows/Linux F12) reaches page handlers here but behaves differently for a human. ' +
      'Requires the Electron editor.',
    {
      key: z.string().describe("Electron keyCode, e.g. 'Escape', 'Delete', 'ArrowLeft', 'w', 'z'."),
      modifiers: z.array(modifierEnum).optional().describe(`${MODIFIERS_BASE}, e.g. ['meta'] for Cmd+key.`),
      panel: z.string().optional().describe(
        'Focus this panel BEFORE pressing, so a panel-scoped chord resolves there. Ids (CASE-'
        + 'SENSITIVE — "Game" is not "game"): ' + IDS + '. A game may also register custom '
        + 'panels, so this is the built-in set, not the whole vocabulary. REFUSED if that panel '
        + 'has no open tab, naming the ones that do — the press is then NOT sent, so a refusal '
        + 'never leaves you guessing whether the key landed. `modoki_get_editor_state.openPanels` '
        + 'lists them.',
      ),
    },
    async ({ key, modifiers, panel }) => postJson('/api/input/key', { key, modifiers, panel }),
  );

  // ── focus — move keyboard focus / blur a text field (Electron editor only) ──
  tool(
    'modoki_focus',
    'Move keyboard focus in the editor window: focus the element matching `selector`, or — ' +
      'with NO selector — blur the currently-focused element (focus falls back to <body>). ' +
      'General-purpose (focus any panel/canvas/input, or defocus a text field). One common ' +
      "use is unblocking trusted key input for the GAME: the game's input sampler drops keys " +
      'while a DOM text field (Console filter, inspector) holds focus, and a viewport click ' +
      'does NOT blur it — so call this (no selector) before modoki_press_key. ⚠️ THAT IS ONLY ' +
      'HALF THE STORY: blurring does NOT move the keyboard scope, and while a panel other ' +
      'than the Game panel owns the scope the editor gate suppresses game input outright — so ' +
      'to DRIVE THE GAME pass panel:"game" (here or on modoki_press_key). A bare {} that is ' +
      'expected to do that instead reports success and changes nothing, which is exactly the ' +
      'false negative QA-PHYS-0003 measured. A non-focusable target (canvas/div) is given tabindex=-1 so it can ' +
      'take focus. Returns {focused, blurred, ok, activeElement} — a MISS is a named failure ' +
      '(invalid selector / no element matched / element refused focus), never a bare ok:false. ' +
      'KEYBOARD SCOPE vs DOM FOCUS are different things: `panel` sets which panel the editor ' +
      'keymap resolves chords against, `selector` sets document.activeElement. Clicking a ' +
      'Hierarchy row moves the scope but leaves activeElement on <body>, which is why both ' +
      'exist. Pass `panel` to steer panel-scoped shortcuts; the response echoes `focusedPanel`. ' +
      'Requires the Electron editor.',
    {
      selector: z.string().optional().describe('CSS selector to focus. Omit to blur the active element.'),
      panel: z.string().optional().describe(
        'Set the editor KEYBOARD SCOPE to this panel (independent of DOM focus). Ids (CASE-'
        + 'SENSITIVE — "Game" is not "game"): ' + IDS + '. A game may also register custom '
        + 'panels, so this is the built-in set, not the whole vocabulary. REFUSED if that panel '
        + 'has no open tab, naming the ones that do; `selector` is then NOT focused either, so '
        + 'the call is all-or-nothing. `modoki_get_editor_state.openPanels` lists them.',
      ),
    },
    async ({ selector, panel }) => postJson('/api/input/focus', { selector, panel }),
  );

  // ── dnd — HTML5 drag-and-drop synthesis (dev + DMG) ──
  // An endpoint must actually AIM somewhere: a `{}` (or a typo'd key, which strict now catches)
  // used to reach the relay as an unaimed drag and be reported as a completed one.
  const dndEndpoint = z.object({
    selector: z.string().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
  }).strict('a dnd endpoint accepts only: selector, x, y')
    .refine((e) => !!e.selector || (typeof e.x === 'number' && typeof e.y === 'number'),
      { message: 'a dnd endpoint needs {selector} or BOTH {x,y} — this tool cannot be aimed by entity (HTML5 DnD is a DOM-element protocol)' });
  tool(
    'modoki_dnd',
    'Synthesize an HTML5 drag-and-drop (dragstart→dragover→drop) — the DnD interactions a ' +
      'trusted pointer-drag CANNOT emit: Hierarchy reparent/reorder, Assets file-move & ' +
      'prefab-instantiate, Skin sprite-onto-part / part-reorder / bone-reparent. Address ' +
      'each endpoint by CSS `selector` (targets its center) OR viewport `{x,y}`. Lets the ' +
      "app's own dragstart handler fill the DataTransfer (never fabricated). Returns the " +
      'MIME `types` written (empty ⇒ wrong source element) and `accepted` (target took the ' +
      'drop). AIM: this is the ONE input tool that cannot be aimed by `entity` — HTML5 DnD is a ' +
      'DOM-element protocol (the source element\'s own dragstart handler fills the DataTransfer), ' +
      'so an endpoint is a DOM `selector` or raw viewport {x,y}; there is no scene-entity endpoint ' +
      'to resolve, and inside modoki_batch a raw {x,y} endpoint is refused (use selectors). ' +
      'OCCLUSION: `from`/`to` each carry the shared `matched`/`hitTarget`/`occluded` provenance, but ' +
      'a covered endpoint is a WARNING, not a refusal (unlike every other aimed input tool): the ' +
      'events are dispatched straight at the element, bypassing hit-testing, so the drop really ' +
      'does land and refusing would reject a call that works. What it CANNOT be is a gesture a ' +
      'human could perform — their drag is hit-tested into the cover — so `occluded:true` comes ' +
      'with a warning saying exactly that. Do not rest a verdict on a covered drop. Works in dev ' +
      'AND the DMG.',
    {
      // STRICT + refined, unlike the shared `pointSpec` (which carries an `entity` this route
      // cannot honour — see the description). An all-optional inline object accepted `{}` and a
      // misspelled `selecter`, both of which reach the relay as "no aim at all" (S3.6).
      from: dndEndpoint.describe('Drag SOURCE: {selector} (preferred — resolved server-side, cannot go stale) or {x,y} CSS px.'),
      to: dndEndpoint.describe('Drop TARGET: {selector} (preferred) or {x,y} CSS px.'),
    },
    async ({ from, to }) => editorAction('dom-dnd', { from, to }),
  );

  // ── handles — numeric handle geometry for the Canvas2D/SVG editors (dev + DMG) ──
  tool(
    'modoki_handles',
    'List the draggable/clickable HANDLES the authoring editors offer RIGHT NOW, in ' +
      'viewport CSS px — the input twin of get_layout_bounds. Canvas2D/SVG editors (Skin ' +
      'bones, Dopesheet/Curves keyframes, Collider2D vertices, gizmo axes) have no DOM ' +
      'accessibility tree, so this is how you discover WHERE to aim before drag_handle/' +
      'tap_handle. CALLED BARE it returns COUNTS — `byEditor` and `byKind` (plus the viewport ' +
      'and the occlusion/offScreen/disabled counters) — which answers "what can I aim at right ' +
      'now?". Pass `editor` (collider2d/dopesheet/curves/skin), `kind`, or `ids` for the ' +
      'geometry: each handle then has a stable `id`, `x`,`y`, optional `label`/`meta`. The full ' +
      'list is opt-in because a Dopesheet enumerates every key of every track (~374 bytes each, ' +
      'so 2,000 keys ≈ 187k tokens). Counts of 0 ⇒ open the right editor and enter its sub-mode ' +
      '(e.g. Collider-edit) first. A FILTERED call that matches nothing does not just return an ' +
      'empty list: it names what IS live (`byEditor`/`byKind` + a hint), so a typo\'d filter cannot ' +
      'read as a correct negative answer. Works in dev AND the DMG.',
    {
      editor: z.string().optional().describe('Filter to one editor, e.g. "collider2d", "dopesheet", "skin".'),
      kind: z.string().optional().describe('Filter to one handle kind, e.g. "collider-vertex", "keyframe", "bone-joint".'),
      ids: z.string().optional().describe('Comma-separated handle ids to restrict to.'),
    },
    async ({ editor, kind, ids }) => {
      const qs = new URLSearchParams();
      if (editor) qs.set('editor', editor);
      if (kind) qs.set('kind', kind);
      if (ids) qs.set('ids', ids);
      const q = qs.toString();
      return getJson(`/api/enact-handles${q ? `?${q}` : ''}`);
    },
  );

  // ── tap_handle — trusted click on a named handle (Electron editor only) ──
  tool(
    'modoki_tap_handle',
    'Click a handle by its `id` (from modoki_handles) — resolves the handle\'s live CSS ' +
      'coords in the renderer, then issues a trusted click there. Use to select a keyframe/' +
      'vertex/bone without eyeballing pixels. `button`/`clickCount`/`modifiers` as in ' +
      'modoki_tap (e.g. clickCount:2 to insert/rename, modifiers:["shift"] to add to a ' +
      'marquee selection). Reports `occluded` (BOOLEAN — same meaning as modoki_tap) plus ' +
      '`occludedBy` naming the covering element. An off-screen, disabled, or OCCLUDED handle is ' +
      'REFUSED rather than tapped: a press that provably lands on the covering element is a miss, ' +
      'and reporting one as ok:true is how a covered handle reads as an inert one. Pass ' +
      '`allowOccluded:true` to press anyway and see what happens. Requires the Electron editor.',
    {
      id: z.string().describe('Handle id from modoki_handles.'),
      button: z.enum(['left', 'right', 'middle']).optional().describe("Mouse button to click with (default 'left'). This tool CLICKS — the 'held during the drag' wording here was copy-pasted from modoki_drag_handle."),
      clickCount: z.number().optional().describe('1 = single (default), 2 = double-click — same meaning as modoki_tap.'),
      modifiers: z.array(modifierEnum).optional().describe(`${MODIFIERS_BASE}, e.g. ["shift"] to add to a marquee selection — same meaning as modoki_tap.`),
      allowOccluded: allowOccludedParam.describe(`${ALLOW_OCCLUDED_BASE}. Here the target is a HANDLE, and a covered one reads as an inert one — which is how a working gizmo handle under the SceneView toolbar got filed as a high-severity bug.`),
    },
    async ({ id, button, clickCount, modifiers, allowOccluded }) => postJson('/api/input/tap-handle', { id, button, clickCount, modifiers, allowOccluded }),
  );

  // ── drag_handle — trusted drag of a named handle (Electron editor only) ──
  tool(
    'modoki_drag_handle',
    'Drag a handle by its `id` (from modoki_handles) to a destination — the aimed-input ' +
      'primitive for the Canvas2D/SVG editors (move a Collider2D vertex, slide a keyframe in ' +
      'time, pose a bone). Destination is ONE of: `to:{x,y}` (absolute CSS px), `toId` ' +
      '(another handle\'s position — e.g. snap one vertex onto another), or `delta:{dx,dy}` ' +
      '(offset from the handle\'s current position). Resolves live coords server-side so ' +
      'there is no query→drag race. `modifiers:["shift"]` = gizmo/snap, and is HELD as a real ' +
      'key for the whole drag (see modoki_drag). Occlusion is reported PER ' +
      'ENDPOINT — `fromTarget`/`toTarget` each carry `occluded` (boolean) + `occludedBy` — so a ' +
      'covered source and a covered destination are distinguishable (they need different fixes); ' +
      '`toTarget` appears only for a `toId` destination. An off-screen, disabled, or OCCLUDED ' +
      'endpoint is REFUSED rather than dragged (the press would land on the cover, which reads as ' +
      '"this handle does nothing"); `allowOccluded:true` forces it. Requires the Electron editor.',
    {
      id: z.string().describe('Handle id to drag (from modoki_handles).'),
      to: z.object({ x: z.number(), y: z.number() }).optional().describe('Absolute destination in viewport CSS px.'),
      toId: z.string().optional().describe('Drag onto another handle by its id.'),
      delta: z.object({ dx: z.number(), dy: z.number() }).optional().describe('Offset from the handle\'s current position.'),
      steps: z.number().optional().describe('Intermediate move count (default 10).'),
      button: z.enum(['left', 'right', 'middle']).optional().describe("Mouse button held for the drag (default 'left')."),
      modifiers: z.array(modifierEnum).optional().describe(`${MODIFIERS_BASE}, held for the WHOLE drag as a real keyDown/keyUp around the gesture — so a listener tracking the modifier's LEVEL (the 3D gizmo's snap) sees it down for every intermediate move.`),
      allowOccluded: allowOccludedParam.describe(`${ALLOW_OCCLUDED_BASE}. Reported PER ENDPOINT — \`fromTarget\`/\`toTarget\` each carry their own \`occluded\`, since a covered source and a covered destination need different fixes.`),
    },
    async ({ id, to, toId, delta, steps, button, modifiers, allowOccluded }) => postJson('/api/input/drag-handle', { id, to, toId, delta, steps, button, modifiers, allowOccluded }),
  );

  // ── type — trusted keyboard input into the focused element (Electron editor only) ──
  tool(
    'modoki_type_text',
    'Type text into the CURRENTLY-FOCUSED element via trusted keyboard events (real ' +
      'Chromium input, so a React controlled input like the Inspector fires its onChange). ' +
      'FOCUS THE TARGET FIRST with modoki_tap on the input. `clearFirst` selects-all + ' +
      'deletes so the field is replaced rather than appended. `submitKey` presses a ' +
      "terminal key: 'Tab'/'Escape' BLUR the field (use to verify commit-on-blur), " +
      "'Enter' submits. `typed` is MEASURED (the focused element's value delta), not the length of " +
      'what you asked for, and `valueAfter` echoes the field — so a short insert is a FAILURE naming ' +
      'what landed. NON-ASCII (Japanese, emoji, accented) text DOES insert — measured on Electron ' +
      '43. This used to say it could not, and steered agents to modoki_eval, which is a ' +
      'NON-input write a controlled input never sees, so the advice was worse than the path it ' +
      'replaced. When text really does not land, the live cause is a field that reformats or ' +
      'rejects input as you type — read `valueAfter`, it names what is actually there. ' +
      'Requires the Electron editor.',
    {
      text: z.string().describe('Text to type into the focused input.'),
      clearFirst: z.boolean().optional().describe('Empty the field before typing (replace vs append). A field it could not empty is reported as an ERROR naming what is still in it, never a silent append.'),
      submitKey: z.string().optional().describe("Terminal key after typing: 'Enter', 'Tab', or 'Escape'."),
    },
    async ({ text, clearFirst, submitKey }) => postJson('/api/input/type', { text, clearFirst, submitKey }),
  );
}
