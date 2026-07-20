/** Preview3DShell — the React wrapper around createPreviewScene shared by the Mesh
 *  and Material inspector previews. Owns the container + mount/dispose, a wireframe
 *  toggle + reset-camera button, and loading/error overlays. Callers supply a
 *  `populate` that fills the scene's contentRoot; it re-runs when `resetKey` changes.
 *  Degrades gracefully to an error message when WebGL is unavailable. */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPreviewScene, type PreviewSceneHandle } from './previewScene';

const PREVIEW_W = 320;
const PREVIEW_H = 220;

export function Preview3DShell({ populate, resetKey, width = PREVIEW_W, height = PREVIEW_H }: {
  /** Fill `handle.contentRoot` with owned (clone/fresh) geometry+materials. May be async. */
  populate: (handle: PreviewSceneHandle, signal: AbortSignal) => Promise<void> | void;
  /** Re-run `populate` whenever this changes (e.g. the asset path, or edited data). */
  resetKey: string;
  width?: number;
  height?: number;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<PreviewSceneHandle | null>(null);
  const populateRef = useRef(populate);
  populateRef.current = populate;
  const [wireframe, setWireframe] = useState(false);
  // Mirror `wireframe` so the async populate applies the CURRENT toggle to
  // freshly-added content even if it was flipped mid-load (the separate [wireframe]
  // effect ran while contentRoot was still empty and won't re-fire). Matches the
  // wireframeRef pattern in ModelPreview.
  const wireframeRef = useRef(wireframe);
  wireframeRef.current = wireframe;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Mount: build the WebGL scene once (recreate only on size change). NOTE: the
  // populate effect keys on `resetKey`, NOT the scene handle — so a runtime width/
  // height change would rebuild the scene EMPTY until the next resetKey change. Both
  // callers use the fixed default size, so this is latent; pass a stable size.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let handle: PreviewSceneHandle | null = null;
    try {
      handle = createPreviewScene(container, { width, height });
    } catch {
      setError('3D preview unavailable (no WebGL).');
      setLoading(false);
      return;
    }
    handleRef.current = handle;
    return () => { handleRef.current = null; handle?.dispose(); };
  }, [width, height]);

  // Populate on mount + whenever the resetKey changes. Reads populate via a ref so a
  // new closure each render doesn't retrigger (only resetKey drives a rebuild).
  useEffect(() => {
    const h = handleRef.current;
    if (!h) return; // WebGL unavailable → error already shown
    const ac = new AbortController();
    setLoading(true);
    setError(null);
    h.clearContent();
    (async () => {
      try {
        await populateRef.current(h, ac.signal);
        if (ac.signal.aborted) return;
        h.setWireframe(wireframeRef.current);
        h.frameContent();
        setLoading(false);
      } catch (e) {
        if (ac.signal.aborted) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      }
    })();
    return () => ac.abort();
  }, [resetKey]);

  useEffect(() => { handleRef.current?.setWireframe(wireframe); }, [wireframe]);

  const resetCamera = useCallback(() => { handleRef.current?.frameContent(); }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 6 }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 11 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, color: '#bbb' }}>
          <input type="checkbox" checked={wireframe} onChange={(e) => setWireframe(e.target.checked)} />
          Wireframe
        </label>
        <button
          onClick={resetCamera}
          style={{ background: '#2a2a2a', color: '#bbb', border: '1px solid #444', padding: '2px 6px', fontSize: 11, cursor: 'pointer' }}
        >
          Reset
        </button>
      </div>
      <div
        ref={containerRef}
        style={{ width, height, background: '#1a1a1a', border: '1px solid #333', position: 'relative' }}
      >
        {loading && !error && (
          <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: '#888', fontSize: 11, pointerEvents: 'none' }}>
            Loading…
          </div>
        )}
        {error && (
          <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: '#e88', fontSize: 11, padding: 8, textAlign: 'center', pointerEvents: 'none' }}>
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
