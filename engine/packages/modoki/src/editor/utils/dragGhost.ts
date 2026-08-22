/** Shared drag ghost helpers — used by Hierarchy and Assets panels.
 *  Creates a floating label with ✊ that follows the mouse during drag,
 *  and hides the browser's default drag image.
 *
 *  Also manages a global "asset drag payload" + hovered drop target so that
 *  asset drops work even when FlexLayout intercepts native drop events.
 *  The dragover handler tracks which [data-drop-target] is hovered, and
 *  dragend completes the drop via a CustomEvent ('asset-drop'). */

// ── Global asset drag state ──────────────────────────────────
let _assetPayload: string | null = null;
let _hoveredDropTarget: Element | null = null;
let _dropHandlerInstalled = false;

/** Match an asset against an accept list. Tokens starting with '.' match the path
 *  extension; any other token matches the asset's `type` (e.g. 'sprite'). Empty/absent
 *  accept means accept anything. Shared with AssetRefField's drop handler so the
 *  highlight and the drop agree. */
export function acceptMatchesAsset(accept: string[] | null | undefined, path: string, type?: string): boolean {
  if (!accept || accept.length === 0) return true;
  return accept.some((tok) => (tok.startsWith('.') ? path.endsWith(tok) : tok === type));
}

/** Check if the dragged asset matches the drop target's data-accept tokens.
 *  No data-accept (or empty) means accept anything. */
function matchesAccept(el: Element, payload: string): boolean {
  const accept = el.getAttribute('data-accept');
  if (!accept) return true;
  try {
    const { path, type } = JSON.parse(payload) as { path: string; type?: string };
    return acceptMatchesAsset(accept.split(','), path, type);
  } catch { return false; }
}

/** Install a global dragover listener (once, never removed).
 *  Intentional singleton — the editor never unmounts, and the handler
 *  early-returns when _assetPayload is null (one null check per event). */
function installDropTracking() {
  if (_dropHandlerInstalled) return;
  _dropHandlerInstalled = true;

  // Inject highlight style once
  const style = document.createElement('style');
  style.textContent = '[data-drop-target].asset-drag-over { outline: 2px solid #3498db; }';
  document.head.appendChild(style);

  // Track which [data-drop-target] the cursor is over during drag.
  // Respects data-accept attribute: only highlight if the dragged asset matches.
  document.addEventListener('dragover', (e) => {
    if (!_assetPayload) return;
    const el = (e.target as HTMLElement)?.closest?.('[data-drop-target]');
    if (el && matchesAccept(el, _assetPayload)) {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'link';
      if (_hoveredDropTarget !== el) {
        _hoveredDropTarget?.classList.remove('asset-drag-over');
        el.classList.add('asset-drag-over');
        _hoveredDropTarget = el;
      }
    } else if (_hoveredDropTarget) {
      _hoveredDropTarget.classList.remove('asset-drag-over');
      _hoveredDropTarget = null;
    }
  }, true);
}

/** Call from onDragStart to store the asset payload for drop tracking */
export function setAssetDragPayload(payload: string) {
  _assetPayload = payload;
  installDropTracking();
}

/** What the in-flight asset drag is, or null when none is in flight.
 *
 *  ⚠️ This exists because **`dataTransfer.getData()` returns `''` during `dragover`** —
 *  the drag data store is in *protected mode* until `drop`, exposing only `types`. So a
 *  drop target CANNOT decide acceptance from the DataTransfer, which is why the Hierarchy
 *  and the Skin parts list both accepted every asset on dragover and then discarded the
 *  ones they could not use (#306): the affordance said yes because it had nothing to say
 *  no with. The payload is captured module-side at dragstart by `setAssetDragPayload`,
 *  whose single producer is the Assets panel's row `onDragStart`, so it is readable at
 *  dragover time.
 *
 *  Null while an `application/editor-asset` drag is in flight means the payload came from
 *  somewhere other than this document (a foreign/stale drag). Callers should treat that as
 *  "not droppable" rather than as "unknown, allow it" — the drop handler reads the payload
 *  back through the same JSON and would discard it anyway.
 *
 *  The accept RULES live in `editor/panels/assetDropPolicy.ts`; this only reports the facts. */
export function getAssetDragInfo(): { type: string | null; path: string } | null {
  if (!_assetPayload) return null;
  try {
    const { type, path } = JSON.parse(_assetPayload) as { type?: string; path?: string };
    // A payload with no `path` is not one the Assets panel wrote — every producer sets it,
    // and an accept rule keying off the extension would silently see '' and refuse.
    if (typeof path !== 'string') return null;
    return { type: typeof type === 'string' ? type : null, path };
  } catch { return null; }
}

/** Call from onDragEnd — if cursor is over a drop target, dispatch asset-drop */
export function completeAssetDrop() {
  if (_hoveredDropTarget && _assetPayload) {
    _hoveredDropTarget.classList.remove('asset-drag-over');
    _hoveredDropTarget.dispatchEvent(new CustomEvent('asset-drop', { detail: _assetPayload }));
  }
  _hoveredDropTarget?.classList.remove('asset-drag-over');
  _hoveredDropTarget = null;
  _assetPayload = null;
}

// ── Drag ghost (visual feedback) ─────────────────────────────

/** The live ghost element + the label it was started with, so a drop target can
 *  repaint it as a refusal mid-drag and restore it on leave. */
let _ghostEl: HTMLElement | null = null;
let _ghostLabel = '';
let _ghostRefusal: string | null = null;

const GHOST_BG_OK = '#3a3a5c';
const GHOST_BG_REFUSED = '#5c2b2b';

function paintGhost() {
  if (!_ghostEl) return;
  const refused = _ghostRefusal !== null;
  _ghostEl.style.background = refused ? GHOST_BG_REFUSED : GHOST_BG_OK;
  const icon = _ghostEl.querySelector('[data-ghost-icon]');
  const text = _ghostEl.querySelector('[data-ghost-label]');
  if (icon) icon.textContent = refused ? '\u{1F6AB}' : '\u270A';
  if (text) text.textContent = refused ? `${_ghostLabel} — ${_ghostRefusal}` : _ghostLabel;
}

/** Mark the in-flight drag as refused by the target under the cursor, with the reason
 *  shown in the ghost that follows the pointer; pass null to clear it.
 *
 *  This is the *explanation* half of a refusal — the refusal itself is the target simply
 *  NOT calling `preventDefault()` on dragover, which is what makes the browser paint the
 *  no-drop cursor and what makes `modoki_dnd` report `accepted:false`. Both halves are
 *  needed: the bare no-drop cursor says "not here" without saying why, and a reason with
 *  an accepting dragover is the accept-then-discard bug this replaces (#306).
 *
 *  Idempotent, so a dragover firing every few pixels costs one comparison. */
export function setDragGhostRefusal(reason: string | null) {
  if (_ghostRefusal === reason) return;
  _ghostRefusal = reason;
  paintGhost();
}

export function startDragGhost(e: React.DragEvent, label: string) {
  // Clean up any previous ghost
  endDragGhost();

  // Offscreen transparent image hides browser's default drag ghost
  const blank = document.createElement('img');
  blank.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  blank.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;';
  document.body.appendChild(blank);
  e.dataTransfer.setDragImage(blank, 0, 0);
  requestAnimationFrame(() => blank.remove());

  // Floating ghost follows cursor
  const ghost = document.createElement('div');
  ghost.id = 'editor-drag-ghost';
  // textContent, not an interpolated innerHTML — the label is an asset/entity NAME, which
  // is user-authored and can legally contain markup characters.
  const icon = document.createElement('span');
  icon.setAttribute('data-ghost-icon', '');
  icon.style.fontSize = '16px';
  const text = document.createElement('span');
  text.setAttribute('data-ghost-label', '');
  ghost.append(icon, text);
  ghost.style.cssText = `position:fixed;top:-9999px;left:-9999px;padding:2px 8px;background:${GHOST_BG_OK};color:#fff;font:11px monospace;border-radius:3px;white-space:nowrap;pointer-events:none;z-index:99999;display:flex;align-items:center;gap:4px;`;
  document.body.appendChild(ghost);
  _ghostEl = ghost;
  _ghostLabel = label;
  _ghostRefusal = null;
  paintGhost();

  const moveGhost = (ev: MouseEvent) => {
    ghost.style.left = ev.clientX + 8 + 'px';
    ghost.style.top = ev.clientY + 8 + 'px';
  };
  document.addEventListener('dragover', moveGhost as EventListener);

  // Self-heal: if React's onDragEnd never fires (drop into another frame, an exception
  // mid-drop handler, devtools boundary), a native dragend/drop still force-cleans up so
  // the ghost + dragover listener + sticky `editor-mousedown` cursor don't leak. capture
  // so we see it even if a handler stops propagation; once so it auto-detaches. (panels F10)
  const forceEnd = () => endDragGhost();
  document.addEventListener('dragend', forceEnd, { capture: true, once: true });
  document.addEventListener('drop', forceEnd, { capture: true, once: true });

  (window as any).__editorDragCleanup = () => {
    ghost.remove();
    if (_ghostEl === ghost) { _ghostEl = null; _ghostLabel = ''; _ghostRefusal = null; }
    document.removeEventListener('dragover', moveGhost as EventListener);
    document.removeEventListener('dragend', forceEnd, { capture: true } as EventListenerOptions);
    document.removeEventListener('drop', forceEnd, { capture: true } as EventListenerOptions);
  };
}

/** Arm the "closed hand" grab cursor for a potential drag, on a row's mousedown.
 *  Only the PRIMARY (left) button arms it — a right-click (context menu) or middle
 *  click must not show grabbing. Self-heals: a one-shot window mouseup (capture)
 *  clears the class no matter where the release lands, so it can't get stuck when
 *  the pointer-up happens off the row (e.g. after picking "Rename" from the context
 *  menu, whose mouseup never reaches the row). */
export function armGrabCursor(e: { button: number }) {
  if (e.button !== 0) return;
  document.body.classList.add('editor-mousedown');
  window.addEventListener('mouseup', () => document.body.classList.remove('editor-mousedown'), { capture: true, once: true });
}

export function endDragGhost() {
  (window as any).__editorDragCleanup?.();
  delete (window as any).__editorDragCleanup;
  // Remove any leftover ghost element (safety net)
  document.getElementById('editor-drag-ghost')?.remove();
  // ...and drop the refusal state with it, so the next drag never starts pre-refused
  // (the cleanup above only clears it when THIS module created the element).
  _ghostEl = null; _ghostLabel = ''; _ghostRefusal = null;
  // Clean up any leftover cursor class (onMouseUp doesn't fire during drag)
  document.body.classList.remove('editor-mousedown');
}
