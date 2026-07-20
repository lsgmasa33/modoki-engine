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
import { onWorldSwap } from '../ecs/world';
import { getAllTraits, getTraitByName } from '../ecs/traitRegistry';
import { addDirtyListener } from '../ecs/entityUtils';
import { isSimRunning } from '../systems/playState';
import { deactivatedEntities } from '../../three/systems/transformPropagationSystem';
import type { World } from 'koota';
import type { UIActionBinding } from './bindings';
export interface UINodeData {
  entityId: number;
  guid: string;
  // ── Layout ──
  width: number; height: number;
  widthUnit: string; heightUnit: string;
  flexDirection: string; flexWrap: string; justifyContent: string; alignItems: string;
  gap: number; flexGrow: number; flexShrink: number;
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
  alignSelf: string; zIndex: number;
  overflow: string; isVisible: boolean;
  // ── Style ──
  backgroundColor: number; backgroundOpacity: number;
  borderRadius: number; borderWidth: number; borderColor: number; borderOpacity: number;
  opacity: number;
  // ── Text ──
  text: string;
  fontFamily: string; fontSize: number; fontWeight: string; fontStyle: string;
  textColor: number; textOpacity: number; textAlign: string;
  lineHeight: number; letterSpacing: number;
  textShadowColor: number; textShadowOpacity: number; textShadowOffsetX: number; textShadowOffsetY: number; textShadowBlur: number;
  textStrokeColor: number; textStrokeOpacity: number; textStrokeWidth: number;
  textOverflow: string; maxLines: number;
  // ── Image ──
  imageSrc: string; imageMode: string;
  // ── Element type ──
  elementType: string; placeholder: string;
  // ── Range (slider) ──
  rangeMin: number; rangeMax: number; rangeStep: number;
  // ── Separate traits (optional) ──
  binding?: { textBinding: string; inputBinding: string; visibleBinding?: string; visibleOp?: string; visibleValue?: string };
  action?: { bindings: UIActionBinding[] };
  anchor?: { anchor: string; top: number; topUnit: string; right: number; rightUnit: string; bottom: number; bottomUnit: string; left: number; leftUnit: string; pivotX: number; pivotY: number; safeArea: boolean; zIndex: number };
  canvas2D?: { referenceWidth: number; referenceHeight: number; scaleMode: string };
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

// ── Dirty flag ──

let _dirty = true; // Start dirty so first frame builds the tree

// Editor dirty subscriber set — Inspector, UIResizeOverlay, etc. subscribe for event-driven refresh.
const _editorDirtyListeners = new Set<() => void>();
let _singleEditorCb: (() => void) | null = null;

/** Subscribe to editor dirty notifications. Returns an unsubscribe function. */
export function onEditorDirty(fn: () => void): () => void {
  _editorDirtyListeners.add(fn);
  return () => { _editorDirtyListeners.delete(fn); };
}

/** Legacy single-callback API for backward compat (Inspector). */
export function setEditorDirtyCallback(fn: (() => void) | null) {
  if (_singleEditorCb) _editorDirtyListeners.delete(_singleEditorCb);
  _singleEditorCb = fn;
  if (fn) _editorDirtyListeners.add(fn);
}

function notifyEditorDirty() {
  for (const fn of _editorDirtyListeners) fn();
}

/** Mark the UI tree as needing a rebuild. Called from writeTraitField, deleteEntity, etc.
 *  Cost: setting a boolean + notifying editor subscribers. */
export function markUIDirty() {
  _dirty = true;
  notifyEditorDirty();
}

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
    _dirty = true;
    notifyEditorDirty();
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
const _nestedKeys = new Set(['children', 'binding', 'action', 'anchor', 'canvas2D', 'textAnim']);
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
let _renderUIMeta: any, _uiElMeta: any, _attrMeta: any, _bindingMeta: any, _actionMeta: any, _anchorMeta: any, _canvas2dMeta: any, _textAnimMeta: any;

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
  _traitsCached = !!(_renderUIMeta && _uiElMeta);
}

function sortBySortOrder(a: UINodeData, b: UINodeData) {
  return (_sortMap.get(a.entityId) ?? 0) - (_sortMap.get(b.entityId) ?? 0);
}

function sortChildren(n: UINodeData) {
  n.children.sort(sortBySortOrder);
  for (let i = 0; i < n.children.length; i++) sortChildren(n.children[i]);
}

function buildTree(world: World): UINodeData[] {
  if (!_traitsCached) cacheTraits();
  if (!_traitsCached) {
    // Traits not registered yet — expected during the initial-dirty build that
    // runs before game/editor setup registers traits. A UI entity can't exist
    // without RenderableUI/UIElement being registered first, so this transient
    // empty tree self-corrects on the next markUIDirty rebuild. (A game that
    // genuinely forgets to register UI traits surfaces via loadSceneFile's
    // unknown-trait warnings, not here.)
    return [];
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
        alignItems: ui.alignItems, gap: ui.gap,
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
        alignSelf: ui.alignSelf || 'auto', zIndex: ui.zIndex || 0,
        overflow: ui.overflow, isVisible: ui.isVisible,
        backgroundColor: ui.backgroundColor || 0, backgroundOpacity: ui.backgroundOpacity || 0,
        borderRadius: ui.borderRadius || 0, borderWidth: ui.borderWidth || 0,
        borderColor: ui.borderColor || 0x333333, borderOpacity: ui.borderOpacity ?? 1, opacity: ui.opacity ?? 1,
        text: ui.text || '', fontFamily: ui.fontFamily || '',
        fontSize: ui.fontSize || 16, fontWeight: ui.fontWeight || 'normal',
        fontStyle: ui.fontStyle || 'normal', textColor: ui.textColor ?? 0xffffff, textOpacity: ui.textOpacity ?? 1,
        textAlign: ui.textAlign || 'left',
        lineHeight: ui.lineHeight || 0, letterSpacing: ui.letterSpacing || 0,
        textShadowColor: ui.textShadowColor || 0, textShadowOpacity: ui.textShadowOpacity ?? 1, textShadowOffsetX: ui.textShadowOffsetX || 0,
        textShadowOffsetY: ui.textShadowOffsetY || 0, textShadowBlur: ui.textShadowBlur || 0,
        textStrokeColor: ui.textStrokeColor || 0, textStrokeOpacity: ui.textStrokeOpacity ?? 1, textStrokeWidth: ui.textStrokeWidth || 0,
        textOverflow: ui.textOverflow || 'clip', maxLines: ui.maxLines || 0,
        imageSrc: ui.imageSrc || '', imageMode: ui.imageMode || 'cover',
        elementType: ui.elementType || 'div', placeholder: ui.placeholder || '',
        rangeMin: ui.rangeMin ?? 0, rangeMax: ui.rangeMax ?? 100, rangeStep: ui.rangeStep ?? 1,
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
  if (!_dirty) return;
  _dirty = false;
  const tree = buildTree(world);
  useUITreeStore.setState({ tree });
}
