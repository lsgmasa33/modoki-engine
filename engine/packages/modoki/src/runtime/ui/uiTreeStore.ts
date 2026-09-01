/** uiTreeStore — Zustand store for the UI entity tree.
 *
 *  Replaces the old polling architecture in useUIEntities. Instead of querying
 *  ECS every frame and comparing 50+ fields per node, we use a dirty flag:
 *  - Any ECS write sets `uiDirty = true` (O(1))
 *  - `uiTreeProjection()` runs once per frame via the pipeline at PROJECTION priority
 *  - If dirty, rebuilds the tree from ECS and updates the Zustand store
 *  - If clean, returns immediately (zero cost when UI is idle)
 *  - React components subscribe via Zustand selectors — no polling needed */

import { create } from 'zustand';
import { onWorldSwap } from '../core/ecs/world';
import { getAllTraits, getTraitByName } from '../core/ecs/traitRegistry';
import { addDirtyListener } from '../core/ecs/entityUtils';
import { isSimRunning } from '../core/playState';
import { deactivatedEntities } from '../core/ecs/transformPropagationSystem';
import { markUIDirty, isUIDirty, clearUIDirty } from '../core/uiDirty';
import { spriteEpoch } from '../core/textureRefs';
import { resolveUIFontFamily, resetFontRefWarnings } from './fontFamilyRef';
import { scrollSnapChildStyle } from './scrollViewDom';
import { NO_BEHAVIOR_REQUEST } from '../traits/UIScrollView';
export { onEditorDirty, setEditorDirtyCallback, markUIDirty } from '../core/uiDirty';
import type { World } from 'koota';
import type { UIActionBinding } from './bindings';
import type { AnchorMode } from '../traits/UIAnchor';
export interface UINodeData {
  entityId: number;
  guid: string;
  // ── Layout ──
  width: number; height: number;
  widthUnit: string; heightUnit: string;
  flexDirection: string; flexWrap: string; justifyContent: string; alignItems: string;
  gap: number; gapUnit: string; flexGrow: number; flexShrink: number;
  paddingTop: number; paddingTopUnit: string;
  paddingLeft: number; paddingLeftUnit: string;
  paddingRight: number; paddingRightUnit: string;
  paddingBottom: number; paddingBottomUnit: string;
  marginTop: number; marginTopUnit: string;
  marginRight: number; marginRightUnit: string;
  marginBottom: number; marginBottomUnit: string;
  marginLeft: number; marginLeftUnit: string;
  minWidth: number; minWidthUnit: string; maxWidth: number; maxWidthUnit: string;
  minHeight: number; minHeightUnit: string; maxHeight: number; maxHeightUnit: string;
  alignSelf: string; zIndex: number; rotation: number; scale: number;
  overflow: string; isVisible: boolean; pointerThrough: boolean;
  scrollbarStyle: string; scrollbarThumbColor: number; scrollbarTrackColor: number;
  // ── Style ──
  backgroundColor: number; backgroundOpacity: number;
  borderRadius: number; borderWidth: number; borderColor: number; borderOpacity: number;
  opacity: number;
  // ── Text ──
  text: string;
  /** The RESOLVED CSS `font-family` value — `UIElement.fontFamily` (a font-asset GUID) run
   *  through the manifest, else `UIElement.systemFont`, else '' (#231). Resolved here rather
   *  than in `UINode` so the DOM layer stays a pure style writer and the precedence lives in
   *  exactly one place (`ui/fontFamilyRef.ts`). */
  fontFamily: string; fontSize: number; fontSizeUnit: string; fontWeight: string; fontStyle: string;
  textColor: number; textOpacity: number; textAlign: string;
  lineHeight: number; letterSpacing: number; letterSpacingUnit: string;
  textShadowColor: number; textShadowOpacity: number; textShadowOffsetX: number; textShadowOffsetY: number; textShadowBlur: number;
  textStrokeColor: number; textStrokeOpacity: number; textStrokeWidth: number;
  textOverflow: string; maxLines: number;
  // ── Image ──
  imageSrc: string; imageMode: string;
  /** Cache-busting epoch for `imageSrc` — see where it is built, and `spriteEpoch`. */
  imageEpoch: number;
  /** This UI entity also carries a `VideoPlayer` — UINode mounts the clip into its box
   *  (`UIVideoMount`), cropped by `imageMode`. Video as SCENERY, distinct from the
   *  fullscreen `VideoOverlay` cutscene, which sits above everything. */
  hasVideo: boolean;
  // ── Element type ──
  elementType: string; placeholder: string;
  // ── Range (slider) ──
  rangeMin: number; rangeMax: number; rangeStep: number;
  // ── Separate traits (optional) ──
  binding?: { textBinding: string; inputBinding: string; visibleBinding?: string; visibleOp?: string; visibleValue?: string };
  action?: { bindings: UIActionBinding[] };
  // `AnchorMode`, not `string` — the projection sits between the trait (which is
  // already a union) and the layout modules (whose switches have no `default`), so
  // widening here would hand an unrecognised mode straight through to a silently
  // unpositioned element.
  anchor?: { anchor: AnchorMode; top: number; topUnit: string; right: number; rightUnit: string; bottom: number; bottomUnit: string; left: number; leftUnit: string; pivotX: number; pivotY: number; safeArea: boolean; zIndex: number };
  canvas2D?: { referenceWidth: number; referenceHeight: number; scaleMode: string };
  /** UIToggle trait — this entity renders as an on/off switch (a track with a knob)
   *  rather than a plain box. Optional nested block, not scalars: a toggle is rare,
   *  and its absence has to survive `_scalarKeys` being derived from whichever node
   *  happens to be built first. */
  toggle?: { value: boolean; trackOnColor: number; trackOffColor: number; trackOpacity: number; knobColor: number; knobOpacity: number; knobInset: number; trackRadius: number; knobRadius: number; disabled: boolean };
  /** TouchControl trait — this element is an on-screen input control (a d-pad arrow, a jump
   *  button). Optional nested block for the same reason `toggle` is one: rare, and `_scalarKeys`
   *  is derived from whichever node happens to be built first.
   *
   *  The projection carries it; it does NOT carry whether the control is currently held. A
   *  press is applied straight to the DOM by `input/touchControlSource.ts`, because rebuilding
   *  the whole UI tree on every press and release of a d-pad would be a frame's work for a
   *  highlight, at thumb frequency. */
  touch?: { action: string; showOn: string; pressedOpacity: number };
  /** UIScrollView trait — this element is a scrolling box. Carries the AUTHORED motion fields
   *  plus the one-shot `scrollTo*` request, and deliberately **NOT** the live `scrollX`/`scrollY`.
   *
   *  ⚠️ That omission is load-bearing, not an oversight. Scroll position flows the OTHER way —
   *  `UINode` writes it into the trait on every DOM scroll event without dirtying the tree. If it
   *  rode down in the projection, every scroll event would change this node, `nodesEqual` would
   *  fail, and the whole "a scroll frame costs nothing" property would be gone. */
  scroll?: { axis: string; snap: string; snapStop: string; overscroll: string; scrollbar: string; wheel: string; scrollToX: number; scrollToY: number; scrollToBehavior: string; scrollBehavior: string };
  /** True when this node is a pooled `UIEntries` entry. Its only job here is to name the SNAP
   *  TARGETS of an enclosing scroll view — see `stampSnapTargets`. */
  isEntry?: boolean;
  /** True when this node IS a virtualized view (it carries `UIEntries`), as opposed to being one
   *  of its pooled rows.
   *
   *  ⚠️ Read by `useScrollAnchoring`, which must not touch such a box: a virtualized view holds
   *  every row under one `__uiEntriesContent` wrapper whose `offsetTop` never moves (the offset
   *  rides as PADDING inside it), so anchoring to it degrades into restoring the raw number
   *  while the browser's own anchoring has been switched off — a regression. Published as a
   *  trait fact rather than inferred from the child count, because a count is a proxy that one
   *  authored header child silently breaks. */
  isEntriesView?: boolean;
  /** `scroll-snap-align` + `scroll-snap-stop`, stamped by the enclosing scroll view.
   *
   *  ⚠️ It rides the NODE rather than being applied by the scroll view's own element because
   *  CSS snapping is declared on the box and honoured on the TARGET, and those are different
   *  elements. `scrollSnapChildStyle` shipped in #250 with a unit test and NO caller, so
   *  `UIScrollView.snap` styled the container and nothing ever snapped — the repo's
   *  unreachable-mechanism defect class, found by measuring the pager's DOM. */
  snapChild?: Record<string, string>;
  /** TextAnimation trait — whole-element CSS text animation (fade/wave/bounce/jitter/
   *  rainbow/typewriter) realized by UINode. Shared trait with the 2D/3D geometry paths. */
  textAnim?: { effect: string; speed: number; amplitude: number; frequency: number; loop: boolean; fadeIn: boolean };
  children: UINodeData[];
}

// ── Zustand store ──

interface UITreeState {
  tree: UINodeData[];
}

export const useUITreeStore = create<UITreeState>(() => ({
  tree: [],
}));

// ── Dirty flag (core/uiDirty.ts owns the state — see the import above) ──

// Register listeners lazily on first projection call to avoid module-level side effects in tests
let _initialized = false;
function ensureInitialized() {
  if (_initialized) return;
  _initialized = true;
  // Wire the dirty callback into entityUtils so writeTraitField/deleteEntity trigger rebuilds.
  // F5 (intentionally NOT gated to UI-trait writes): this fires on ANY helper-API trait
  // write — a 3D transform, a 2D sprite, anything — which over-invalidates in the editor
  // (a gizmo drag rebuilds the whole UI tree per pointermove). It is left ungated on
  // purpose: (1) reconciliation already preserves node refs so React does NOT re-render
  // (the expensive part is avoided — only the query + per-node nodesEqual run); (2) gating
  // to UI traits only would BREAK the active-highlight (F1), which reads a non-UI trait
  // (e.g. SkeletalAnimator.clip) on a target entity and relies on a `setTrait` to THAT
  // trait dirtying the UI so the highlight re-resolves. In-game this is a non-issue —
  // hot per-frame mutation goes through raw updateEach/entity.set, which bypasses this
  // path. Measure before optimizing; if it ever shows up, gate on a UI-trait OR
  // highlight-watched-trait predicate, not UI-trait-only.
  addDirtyListener(markUIDirty);
  // Force rebuild on world swap (scene change)
  onWorldSwap(() => {
    markUIDirty();
    // Forget which broken font refs have been warned about: the NEXT scene may author the same
    // dangling GUID and independently needs the diagnostic (#231).
    resetFontRefWarnings();
    _prevById = new Map(); // drop old-scene refs so they're never reused
    useUITreeStore.setState({ tree: [] });
  });
}

// ── Tree builder (extracted from old useUIEntities) ──

// Reuse Maps across frames — clear instead of reallocating
const _nodes = new Map<number, UINodeData>();
const _parentMap = new Map<number, number>();
const _sortMap = new Map<number, number>();

// Previous frame's emitted nodes, keyed by entityId. buildTree reconciles the
// freshly-built tree against this so an entity whose data (and whole subtree) is
// unchanged keeps its OLD object reference — letting React.memo(UINode) bail out
// instead of re-rendering every node on any UI change (e.g. one animated field).
let _prevById = new Map<number, UINodeData>();

// Node keys that aren't plain scalars — compared specially in nodesEqual.
const _nestedKeys = new Set(['children', 'binding', 'action', 'anchor', 'canvas2D', 'textAnim', 'toggle', 'touch', 'scroll', 'snapChild']);
// Derived ONCE from a real node, so every scalar field is covered automatically:
// add a field to UINodeData and it's compared without editing this file.
let _scalarKeys: string[] | null = null;
function scalarKeysOf(node: UINodeData): string[] {
  if (!_scalarKeys) _scalarKeys = Object.keys(node).filter((k) => !_nestedKeys.has(k));
  return _scalarKeys;
}

/** Shallow-equal two optional nested trait blocks (same keys by construction). */
function shallowOptEqual(a: Record<string, unknown> | undefined, b: Record<string, unknown> | undefined): boolean {
  if (a === b) return true;       // both undefined, or the same ref
  if (!a || !b) return false;     // exactly one present
  for (const k in a) if (a[k] !== (b as Record<string, unknown>)[k]) return false;
  return true;
}

/** True iff two nodes are interchangeable for rendering: identical scalar fields,
 *  identical nested-trait data, and the SAME child references. Children are
 *  reconciled bottom-up before a parent is tested, so equal child refs imply
 *  fully-equal subtrees. Exported for tests (exhaustiveness guard). */
export function nodesEqual(a: UINodeData, b: UINodeData): boolean {
  // Children by reference (depth-first reconciliation already ran).
  if (a.children.length !== b.children.length) return false;
  for (let i = 0; i < a.children.length; i++) if (a.children[i] !== b.children[i]) return false;
  // Optional nested trait blocks.
  if (!shallowOptEqual(a.anchor as Record<string, unknown> | undefined, b.anchor as Record<string, unknown> | undefined)) return false;
  if (!shallowOptEqual(a.binding as Record<string, unknown> | undefined, b.binding as Record<string, unknown> | undefined)) return false;
  if (!shallowOptEqual(a.canvas2D as Record<string, unknown> | undefined, b.canvas2D as Record<string, unknown> | undefined)) return false;
  if (!shallowOptEqual(a.textAnim as Record<string, unknown> | undefined, b.textAnim as Record<string, unknown> | undefined)) return false;
  if (!shallowOptEqual(a.toggle as Record<string, unknown> | undefined, b.toggle as Record<string, unknown> | undefined)) return false;
  if (!shallowOptEqual(a.touch as Record<string, unknown> | undefined, b.touch as Record<string, unknown> | undefined)) return false;
  if (!shallowOptEqual(a.scroll as Record<string, unknown> | undefined, b.scroll as Record<string, unknown> | undefined)) return false;
  if (!shallowOptEqual(a.snapChild as Record<string, unknown> | undefined, b.snapChild as Record<string, unknown> | undefined)) return false;
  // action.bindings is an array — ref-compare, but treat two empties as equal
  // (the builder allocates a fresh [] when the trait carries none).
  if (a.action || b.action) {
    if (!a.action || !b.action) return false;
    const ab = a.action.bindings, bb = b.action.bindings;
    if (ab !== bb && !(ab.length === 0 && bb.length === 0)) return false;
  }
  // Every scalar field (dynamic key list ⇒ exhaustive).
  const ar = a as unknown as Record<string, unknown>;
  const br = b as unknown as Record<string, unknown>;
  const keys = scalarKeysOf(a);
  for (let i = 0; i < keys.length; i++) { const k = keys[i]; if (ar[k] !== br[k]) return false; }
  return true;
}

/** Depth-first: reconcile each child first, then reuse this node's previous-frame
 *  object reference when nothing in its subtree changed. Populates `nextPrev`. */
function reconcileNode(node: UINodeData, nextPrev: Map<number, UINodeData>): UINodeData {
  for (let i = 0; i < node.children.length; i++) node.children[i] = reconcileNode(node.children[i], nextPrev);
  const prev = _prevById.get(node.entityId);
  const out = prev && nodesEqual(prev, node) ? prev : node;
  nextPrev.set(node.entityId, out);
  return out;
}

// Cache trait lookups (resolve once, reuse across frames)
let _traitsCached = false;
let _renderUIMeta: any, _uiElMeta: any, _attrMeta: any, _bindingMeta: any, _actionMeta: any, _anchorMeta: any, _canvas2dMeta: any, _textAnimMeta: any, _videoMeta: any, _toggleMeta: any, _touchMeta: any, _scrollMeta: any, _entryMeta: any, _entriesMeta: any;

function cacheTraits() {
  const allTraits = getAllTraits();
  _renderUIMeta = allTraits.find(m => m.name === 'RenderableUI');
  _uiElMeta = allTraits.find(m => m.name === 'UIElement');
  _attrMeta = allTraits.find(m => m.name === 'EntityAttributes');
  _bindingMeta = allTraits.find(m => m.name === 'UIBinding');
  _actionMeta = allTraits.find(m => m.name === 'UIAction');
  _anchorMeta = allTraits.find(m => m.name === 'UIAnchor');
  _canvas2dMeta = allTraits.find(m => m.name === 'Canvas2D');
  _textAnimMeta = allTraits.find(m => m.name === 'TextAnimation');
  _videoMeta = allTraits.find(m => m.name === 'VideoPlayer');
  _toggleMeta = allTraits.find(m => m.name === 'UIToggle');
  _scrollMeta = allTraits.find(m => m.name === 'UIScrollView');
  _entryMeta = allTraits.find(m => m.name === 'UIEntry');
  _entriesMeta = allTraits.find(m => m.name === 'UIEntries');
  _touchMeta = allTraits.find(m => m.name === 'TouchControl');
  _traitsCached = !!(_renderUIMeta && _uiElMeta);
}

function sortBySortOrder(a: UINodeData, b: UINodeData) {
  return (_sortMap.get(a.entityId) ?? 0) - (_sortMap.get(b.entityId) ?? 0);
}

function sortChildren(n: UINodeData) {
  n.children.sort(sortBySortOrder);
  for (let i = 0; i < n.children.length; i++) sortChildren(n.children[i]);
}

/** Build the tree, or **`null` when it CANNOT be built yet** (traits not registered).
 *
 *  ⚠️ The null is the whole point, and it replaces a `[]` that was a latent bug. The caller
 *  clears the dirty flag, so returning an empty tree here CONSUMED the rebuild request and left
 *  the UI permanently empty unless something else happened to dirty it later. The old comment
 *  said this "self-corrects on the next markUIDirty rebuild" — nothing guarantees there is a next
 *  one. `loadSceneFile` fires exactly ONE markUIDirty for the whole batch, so if that is the
 *  signal that lands here too early, no UI is ever rendered: no Canvas2D node means
 *  `Canvas2DMount` never mounts, which means a 2D game draws NOTHING, with no error anywhere. */
/** Collect the pooled entries under a scroll view, without crossing into a NESTED scroll view
 *  (its own entries are its own snap targets, not this one's). */
function collectEntries(node: UINodeData, out: UINodeData[]): void {
  for (const c of node.children) {
    if (c.isEntry) out.push(c);
    if (c.scroll) continue;
    collectEntries(c, out);
  }
}

/** Stamp `scroll-snap-align` onto a scroll view's snap TARGETS.
 *
 *  Targets are the pooled ENTRIES when the view has any — an entry is the unit a pager or a
 *  grid is meant to rest on, and it is two levels below the box now that the offset is carried
 *  by a content child and a row (see `entriesSystem`'s ENTRIES_ROW_NAME). A view with no
 *  entries snaps to its direct children instead, which is the plain authored-children case the
 *  trait's own doc calls out as useful on its own.
 *
 *  Stamping an entry rather than a row serves BOTH axes at once: an entry box has an extent on
 *  each, so `both mandatory` needs no second rule. */
export function stampSnapTargets(node: UINodeData): void {
  if (node.scroll && node.scroll.snap !== 'none') {
    const css = scrollSnapChildStyle(node.scroll);
    const entries: UINodeData[] = [];
    collectEntries(node, entries);
    for (const t of (entries.length ? entries : node.children)) t.snapChild = css;
  }
  for (const c of node.children) stampSnapTargets(c);
}

function buildTree(world: World): UINodeData[] | null {
  if (!_traitsCached) cacheTraits();
  if (!_traitsCached) {
    // Traits not registered yet — expected during the initial-dirty build that runs before
    // game/editor setup registers traits. Signal "not yet" so the caller KEEPS the request
    // pending rather than swallowing it. (A game that genuinely forgets to register UI traits
    // surfaces via loadSceneFile's unknown-trait warnings, not here.)
    return null;
  }

  _nodes.clear();
  _parentMap.clear();
  _sortMap.clear();

  // Active-highlight rules collected during the node pass, resolved after it so
  // we can read the (non-UI) target entity's live value without a nested query.
  const highlights: { node: UINodeData; target: string; component: string; property: string; value: string; color: number; textColor: number }[] = [];

  world.query(_renderUIMeta.trait, _uiElMeta.trait).updateEach(
    ([ui]: any[], entity: any) => {
      const id = entity.id();

      // Entity active flag: an inactive entity — OR any descendant of an inactive
      // entity — is skipped entirely (no node built, so it and its subtree drop out
      // of the rendered tree). deactivatedEntities is the parent-chain cascade set
      // computed each frame by transformPropagationSystem (TRANSFORM=200), which runs
      // before this projection (PROJECTION=300), so it's current. Distinct from
      // UIElement.isVisible (a per-element hide that keeps the node in the tree).
      if (deactivatedEntities.has(id)) return;

      const node: UINodeData = {
        entityId: id,
        guid: '',
        width: ui.width, height: ui.height,
        widthUnit: ui.widthUnit || 'px', heightUnit: ui.heightUnit || 'px',
        flexDirection: ui.flexDirection, flexWrap: ui.flexWrap || 'nowrap', justifyContent: ui.justifyContent,
        alignItems: ui.alignItems, gap: ui.gap, gapUnit: ui.gapUnit || 'px',
        flexGrow: ui.flexGrow, flexShrink: ui.flexShrink,
        paddingTop: ui.paddingTop, paddingTopUnit: ui.paddingTopUnit || 'px',
        paddingLeft: ui.paddingLeft, paddingLeftUnit: ui.paddingLeftUnit || 'px',
        paddingRight: ui.paddingRight, paddingRightUnit: ui.paddingRightUnit || 'px',
        paddingBottom: ui.paddingBottom, paddingBottomUnit: ui.paddingBottomUnit || 'px',
        marginTop: ui.marginTop || 0, marginTopUnit: ui.marginTopUnit || 'px',
        marginRight: ui.marginRight || 0, marginRightUnit: ui.marginRightUnit || 'px',
        marginBottom: ui.marginBottom || 0, marginBottomUnit: ui.marginBottomUnit || 'px',
        marginLeft: ui.marginLeft || 0, marginLeftUnit: ui.marginLeftUnit || 'px',
        minWidth: ui.minWidth || 0, minWidthUnit: ui.minWidthUnit || 'px',
        maxWidth: ui.maxWidth || 0, maxWidthUnit: ui.maxWidthUnit || 'px',
        minHeight: ui.minHeight || 0, minHeightUnit: ui.minHeightUnit || 'px',
        maxHeight: ui.maxHeight || 0, maxHeightUnit: ui.maxHeightUnit || 'px',
        alignSelf: ui.alignSelf || 'auto', zIndex: ui.zIndex || 0, rotation: ui.rotation || 0,
        // `?? 1`, NOT `|| 1`: 0 is a legitimate authored scale (a pop-in clip's first keyframe),
        // and `||` would silently promote it to full size — the animation would start already-open.
        scale: ui.scale ?? 1,
        overflow: ui.overflow, isVisible: ui.isVisible,
        pointerThrough: ui.pointerThrough === true,
        scrollbarStyle: ui.scrollbarStyle || 'auto',
        scrollbarThumbColor: ui.scrollbarThumbColor ?? 0x888888,
        scrollbarTrackColor: ui.scrollbarTrackColor ?? 0xdddddd,
        backgroundColor: ui.backgroundColor || 0, backgroundOpacity: ui.backgroundOpacity || 0,
        borderRadius: ui.borderRadius || 0, borderWidth: ui.borderWidth || 0,
        // `??`, not `||`, for the same reason as `scale` above: 0 is PURE BLACK, a legitimate
        // authored colour, and `||` silently repainted it as the 0x333333 default. `textColor`
        // two lines down already had this right. (`fontSize: ui.fontSize || 16` below is the same
        // SHAPE but not the same bug — no scene authors `fontSize: 0`, and the trait default is
        // 16, so that fallback is unreachable for a real trait. Left alone deliberately.)
        //
        // ⚠️ This change is VISIBLE, not theoretical: eleven elements in
        // `games/alien-animal/runtime/assets/scenes/alien-animal.scene.json` author
        // `borderColor: 0` with a non-zero `borderWidth` (Credits Button/Panel, Close Button,
        // the seven Clip buttons, Cycle Button). They rendered #333333 before and render #000000
        // now — i.e. what their author actually asked for. Called out because "a one-character
        // fix" and "eleven borders in a shipped project got darker" are the same edit.
        borderColor: ui.borderColor ?? 0x333333, borderOpacity: ui.borderOpacity ?? 1, opacity: ui.opacity ?? 1,
        text: ui.text || '', fontFamily: resolveUIFontFamily(ui.fontFamily as string, ui.systemFont as string),
        fontSize: ui.fontSize || 16, fontSizeUnit: ui.fontSizeUnit || 'px', fontWeight: ui.fontWeight || 'normal',
        fontStyle: ui.fontStyle || 'normal', textColor: ui.textColor ?? 0xffffff, textOpacity: ui.textOpacity ?? 1,
        textAlign: ui.textAlign || 'left',
        lineHeight: ui.lineHeight || 0, letterSpacing: ui.letterSpacing || 0, letterSpacingUnit: ui.letterSpacingUnit || 'px',
        textShadowColor: ui.textShadowColor || 0, textShadowOpacity: ui.textShadowOpacity ?? 1, textShadowOffsetX: ui.textShadowOffsetX || 0,
        textShadowOffsetY: ui.textShadowOffsetY || 0, textShadowBlur: ui.textShadowBlur || 0,
        textStrokeColor: ui.textStrokeColor || 0, textStrokeOpacity: ui.textStrokeOpacity ?? 1, textStrokeWidth: ui.textStrokeWidth || 0,
        textOverflow: ui.textOverflow || 'clip', maxLines: ui.maxLines || 0,
        imageSrc: ui.imageSrc || '', imageMode: ui.imageMode || 'cover',
        // The RESOLUTION epoch of whatever imageSrc points at. It is in the node data — not read
        // inside UINode — because this tree's reconciler hands back the PREVIOUS node object when
        // the data is equal, so `React.memo(UINode)` bails and the inline `resolveDomImageUrl`
        // never re-runs. A texture re-import changes the URL without changing the ref, so without
        // this the DOM kept the pre-import image until the trait was touched or the scene
        // reloaded (bug `udpbnC6DHswvCj115B7M`, QA-ASSET-0007). Only nodes that HAVE an image
        // carry it, so an unrelated re-import cannot churn the rest of the tree.
        imageEpoch: ui.imageSrc ? spriteEpoch(ui.imageSrc) : 0,
        elementType: ui.elementType || 'div', placeholder: ui.placeholder || '',
        rangeMin: ui.rangeMin ?? 0, rangeMax: ui.rangeMax ?? 100, rangeStep: ui.rangeStep ?? 1,
        // A PLAIN SCALAR, always written, never an optional nested block: `_scalarKeys`
        // is derived once from whichever node happens to be built first, so an
        // only-sometimes-present key can be missed entirely — and a node whose video
        // appeared or vanished would then keep its old object reference and never
        // re-render (the same trap the textAnim play-gate comment below records).
        hasVideo: !!(_videoMeta && entity.has(_videoMeta.trait)),
        children: [],
      };

      if (_bindingMeta && entity.has(_bindingMeta.trait)) {
        const b = entity.get(_bindingMeta.trait) as any;
        node.binding = {
          textBinding: b.textBinding, inputBinding: b.inputBinding,
          visibleBinding: b.visibleBinding || '', visibleOp: b.visibleOp || '', visibleValue: String(b.visibleValue ?? ''),
        };
        // Active-highlight: defer resolution (needs the target entity's live value).
        if (typeof b.highlightColor === 'number' && b.highlightColor >= 0 && b.highlightTarget && b.highlightProperty) {
          highlights.push({
            node, target: b.highlightTarget, component: b.highlightComponent || '',
            property: b.highlightProperty, value: String(b.highlightValue ?? ''), color: b.highlightColor,
            textColor: typeof b.highlightTextColor === 'number' ? b.highlightTextColor : -1,
          });
        }
      }
      if (_actionMeta && entity.has(_actionMeta.trait)) {
        const a = entity.get(_actionMeta.trait) as any;
        node.action = { bindings: a.bindings || [] };
      }
      if (_touchMeta && entity.has(_touchMeta.trait)) {
        const tc = entity.get(_touchMeta.trait) as any;
        node.touch = {
          action: tc.action || 'moveLeft',
          showOn: tc.showOn || 'touch',
          pressedOpacity: typeof tc.pressedOpacity === 'number' ? tc.pressedOpacity : 0.6,
        };
      }
      if (_anchorMeta && entity.has(_anchorMeta.trait)) {
        const anc = entity.get(_anchorMeta.trait) as any;
        node.anchor = {
          anchor: anc.anchor,
          top: anc.top || 0, topUnit: anc.topUnit || 'px',
          right: anc.right || 0, rightUnit: anc.rightUnit || 'px',
          bottom: anc.bottom || 0, bottomUnit: anc.bottomUnit || 'px',
          left: anc.left || 0, leftUnit: anc.leftUnit || 'px',
          pivotX: anc.pivotX || 0, pivotY: anc.pivotY || 0,
          safeArea: anc.safeArea, zIndex: anc.zIndex,
        };
      }
      if (_canvas2dMeta && entity.has(_canvas2dMeta.trait)) {
        const c = entity.get(_canvas2dMeta.trait) as any;
        node.canvas2D = { referenceWidth: c.referenceWidth, referenceHeight: c.referenceHeight, scaleMode: c.scaleMode };
      }
      if (_toggleMeta && entity.has(_toggleMeta.trait)) {
        const t = entity.get(_toggleMeta.trait) as any;
        node.toggle = {
          value: t.value === true,
          trackOnColor: t.trackOnColor ?? 0x4aa3ff, trackOffColor: t.trackOffColor ?? 0x767676,
          trackOpacity: t.trackOpacity ?? 1,
          knobColor: t.knobColor ?? 0xffffff, knobOpacity: t.knobOpacity ?? 1,
          knobInset: t.knobInset ?? 2,
          trackRadius: t.trackRadius ?? 999, knobRadius: t.knobRadius ?? 999,
          disabled: t.disabled === true,
        };
      }
      // ⚠️ ALWAYS written, never conditionally. `_scalarKeys` is derived ONCE from whichever
      // node is reconciled first in the session, so a key that is only sometimes present can be
      // permanently excluded from `nodesEqual` — the exact trap `hasVideo` above is written this
      // way to avoid. Inert today (UIEntry is added once and never removed), and a landmine the
      // moment it is not.
      node.isEntry = !!(_entryMeta && entity.has(_entryMeta.trait));
      // Same ALWAYS-written rule as `isEntry` directly above, and for the same `_scalarKeys` reason.
      node.isEntriesView = !!(_entriesMeta && entity.has(_entriesMeta.trait));
      if (_scrollMeta && entity.has(_scrollMeta.trait)) {
        const sv = entity.get(_scrollMeta.trait) as any;
        node.scroll = {
          axis: sv.axis ?? 'y', snap: sv.snap ?? 'none', snapStop: sv.snapStop ?? 'normal',
          overscroll: sv.overscroll ?? 'auto', scrollbar: sv.scrollbar ?? 'auto', wheel: sv.wheel ?? 'native',
          scrollToX: sv.scrollToX ?? -1, scrollToY: sv.scrollToY ?? -1,
          // Both halves of the motion decision ride down: the transient per-request override and
          // the authored default it falls back to (#409). `pendingScrollTo` resolves the pair.
          scrollToBehavior: sv.scrollToBehavior ?? NO_BEHAVIOR_REQUEST,
          scrollBehavior: sv.scrollBehavior ?? 'instant',
        };
      }
      // Play-GATE the animation here in the projection (not in UINode) so it toggles
      // on the node itself: UIRenderer marks the UI dirty on play-state change, and a
      // node whose textAnim appears/disappears fails nodesEqual → the UINode actually
      // re-renders. Gating in UINode via isSimRunning() instead left the node
      // structurally identical across a Play/Stop, so React.memo skipped the re-render
      // and the CSS animation never mounted in a panel with no per-frame re-render
      // (the editor Game view) until an unrelated reload forced one.
      if (_textAnimMeta && isSimRunning() && entity.has(_textAnimMeta.trait)) {
        const ta = entity.get(_textAnimMeta.trait) as any;
        if (ta.effect && ta.effect !== 'none') {
          node.textAnim = { effect: ta.effect, speed: ta.speed ?? 1, amplitude: ta.amplitude ?? 0.1, frequency: ta.frequency ?? 1, loop: ta.loop ?? true, fadeIn: ta.fadeIn ?? true };
        }
      }

      _nodes.set(id, node);

      if (_attrMeta && entity.has(_attrMeta.trait)) {
        const attr = entity.get(_attrMeta.trait) as any;
        node.guid = attr.guid || '';
        _parentMap.set(id, attr.parentId || 0);
        _sortMap.set(id, attr.sortOrder || 0);
      }
    },
  );

  // Resolve active-highlight rules: light up an element while a target entity's
  // live property equals this element's value. Reads the source of truth directly
  // (e.g. SkeletalAnimator.clip) — no mirrored store flag. One guid→entity scan,
  // built only when a highlight rule is present.
  // NOTE (F1): this runs only when the tree rebuilds, i.e. on a UI dirty signal. A
  // watched value mutated via a raw entity.set (bypassing markUIDirty) won't re-resolve
  // until the next dirty — see the REPAINT INVARIANT on the UIBinding trait.
  if (highlights.length && _attrMeta) {
    const byGuid = new Map<string, any>();
    world.query(_attrMeta.trait).updateEach(([attr]: any[], entity: any) => {
      if (attr.guid) byGuid.set(attr.guid, entity);
    });
    for (const h of highlights) {
      const targetEntity = byGuid.get(h.target);
      if (!targetEntity) continue;
      const compMeta = getTraitByName(h.component);
      if (!compMeta || !targetEntity.has(compMeta.trait)) continue;
      const live = (targetEntity.get(compMeta.trait) as any)?.[h.property];
      if (String(live ?? '') === h.value) {
        h.node.backgroundColor = h.color;
        h.node.backgroundOpacity = 1;
        if (h.textColor >= 0) h.node.textColor = h.textColor;
      }
    }
  }

  // Build tree from flat nodes. Cycle-safe: any node whose parent chain doesn't
  // terminate at a root within _nodes.size hops is treated as a root and
  // logged in dev so the editor can flag the bad parentId.
  const roots: UINodeData[] = [];
  const maxDepth = _nodes.size;
  for (const [id, node] of _nodes) {
    let cur = id;
    let depth = 0;
    let parentId = _parentMap.get(cur) || 0;
    while (parentId && _nodes.has(parentId) && depth <= maxDepth) {
      cur = parentId;
      parentId = _parentMap.get(cur) || 0;
      depth++;
    }
    if (depth > maxDepth) {
      if (import.meta.env?.DEV) {
        console.warn(`[uiTreeStore] parentId cycle detected for entity ${id}; treating as root`);
      }
      roots.push(node);
      continue;
    }
    const directParentId = _parentMap.get(id) || 0;
    const parent = _nodes.get(directParentId);
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  roots.sort(sortBySortOrder);
  for (let i = 0; i < roots.length; i++) sortChildren(roots[i]);
  for (let i = 0; i < roots.length; i++) stampSnapTargets(roots[i]);

  // Reuse unchanged node objects from last frame so React.memo(UINode) skips them.
  const nextPrev = new Map<number, UINodeData>();
  const reconciled = roots.map((r) => reconcileNode(r, nextPrev));
  _prevById = nextPrev;
  return reconciled;
}

// ── Projection system (registered in pipeline at PROJECTION priority) ──

/** ECS system that rebuilds the UI tree when dirty. Register at SYSTEM_PRIORITY.PROJECTION. */
export function uiTreeProjection(world: World) {
  ensureInitialized();
  if (!isUIDirty()) return;
  // ⚠️ Build FIRST, clear the flag only if the build actually produced a tree. The flag used to
  // be cleared up front, so a build that could not run yet (traits not registered — `buildTree`
  // returns null) silently ATE the rebuild request: the request is gone, the tree stays empty,
  // and recovery depends on some unrelated code dirtying the UI again later. Nothing guarantees
  // that. Keeping the flag set costs one retry per frame until traits exist — which is what
  // "dirty" already means — and turns a permanent, silent blank UI into a one-frame delay.
  const tree = buildTree(world);
  if (tree === null) return;
  clearUIDirty();
  useUITreeStore.setState({ tree });
}
