/** The UI tree's producers for #1928's boot-content gate (`core/bootContentGate.ts`).
 *
 *  ## BootImageProbe — holds the boot splash until a visible UI image has decoded
 *
 *  Rendered by `UINode` beside the image it shows — a plain CSS background or a 9-slice `<img>` —
 *  so it exists exactly when that image is on screen: a hidden node returns before it, and a
 *  stripped visual (`uiVisualsHidden`) does not render it. While a boot is armed it registers with
 *  `bootContentGate` and decodes the SAME url the element paints, which warms the browser's cache
 *  for that url; the gate is released when the decode settles, success or failure. Outside a boot
 *  (every frame after the reveal, and always in the editor) `trackBootContent` returns null and
 *  this does nothing at all.
 *
 *  A component rather than a hook because `UINodeInner` returns early on several branches, so a
 *  hook placed at the image block would change the hook order between renders.
 *
 *  ## BootContentHold — holds the boot while something not yet mounted is on its way
 *
 *  `UINode` lazy-loads `Canvas2DMount` (a 3D-only build must be able to drop it), so on a real
 *  device the board's mount — and with it its own registration — landed AFTER the reveal's wait
 *  had found the set empty: measured on an iPad mini 5, the gate waited for the backdrop and never
 *  saw the board. This is that `<Suspense>`'s fallback. It holds a token for exactly as long as
 *  the chunk is loading; React then swaps it for `Canvas2DMount`, whose own token takes over in
 *  the same commit (the gate only declares the set empty at a microtask boundary, so that handoff
 *  cannot read as "everything arrived").
 */
import { useEffect } from 'react';
import { trackBootContent } from '../core/bootContentGate';

export function BootImageProbe({ url }: { url: string }): null {
  useEffect(() => {
    const done = trackBootContent(`ui-image:${url.slice(url.lastIndexOf('/') + 1)}`);
    if (!done) return;
    const img = new Image();
    if (typeof img.decode === 'function') {
      img.src = url;
      img.decode().then(done, done);
    } else {
      img.onload = img.onerror = done;
      img.src = url;
    }
    // Unmounted before it decoded (the node hid, the scene changed): it is no longer on screen,
    // so the boot must not wait for it.
    return done;
  }, [url]);
  return null;
}

export function BootContentHold({ label }: { label: string }): null {
  useEffect(() => trackBootContent(label) ?? undefined, [label]);
  return null;
}
