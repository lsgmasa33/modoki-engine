/** canvas2DDirty — dirty flag for the SceneView Canvas2DLayer.
 *
 *  Same pattern as uiTreeStore's _dirty flag, but for the editor's 2D canvas.
 *  The rAF draw callback checks this flag and early-exits when clean (O(1)).
 *  Any ECS write, selection change, viewport change, or image load sets it. */

import { addDirtyListener } from '../../runtime/ecs/entityUtils';
import { onWorldSwap } from '../../runtime/ecs/world';

let _dirty = true; // Start dirty so first frame draws
// Monotonic redraw version. A single boolean can only be consumed by ONE reader
// per dirty cycle, which starves the others when several Canvas2D layers render
// at once (each Canvas2D entity gets its own overlay). The version lets every
// layer track the last value it drew independently — see Canvas2DLayer.
let _version = 1;

/** Mark the 2D overlay as needing a redraw. */
export function mark2DDirty() { _dirty = true; _version++; }

/** Check and consume the dirty flag. Returns true if a redraw is needed.
 *  Single-consumer; prefer get2DDirtyVersion() when multiple readers exist. */
export function consume2DDirty(): boolean {
  if (!_dirty) return false;
  _dirty = false;
  return true;
}

/** Current redraw version. Each Canvas2D layer remembers the last version it
 *  drew and redraws when this differs — supports any number of readers. */
export function get2DDirtyVersion(): number { return _version; }

let _initialized = false;
let _unsubDirty: (() => void) | null = null;
let _unsubSwap: (() => void) | null = null;
/** Lazily wire up ECS dirty listeners. Call once on mount. */
export function ensureCanvas2DListeners() {
  if (_initialized) return;
  _initialized = true;
  _unsubDirty = addDirtyListener(mark2DDirty);
  _unsubSwap = onWorldSwap(mark2DDirty);
}

// HMR cleanup: unsubscribe so a hot-reloaded module doesn't leave an orphan
// dirty-listener pointing at this dead module instance (mirrors selectionRestore).
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    _unsubDirty?.(); _unsubDirty = null;
    _unsubSwap?.(); _unsubSwap = null;
    _initialized = false;
  });
}
