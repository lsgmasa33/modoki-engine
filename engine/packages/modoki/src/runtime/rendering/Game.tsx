/** Game — initializes the Canvas2D pool and Scene2D rendering.
 *  No longer renders a PixiJS <Application> — canvases are mounted by UIRenderer
 *  via Canvas2DMount into UINode divs. */

import { useState, useEffect } from 'react';
import { initPool, destroyPool } from './canvas2DPool';
import { startScene2D, stopScene2D } from './Scene2D';

/** Hook that initializes the Canvas2D pool and Scene2D rendering loop.
 *  Call once at the app level. */
export function useCanvas2DInit() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    initPool().then(() => {
      if (!cancelled) {
        startScene2D();
        setReady(true);
      }
    });
    return () => {
      cancelled = true;
      stopScene2D();
      destroyPool();
      setReady(false);
    };
  }, []);

  return ready;
}

/** Legacy component — renders nothing, just initializes the pool + Scene2D.
 *  Kept for backward compatibility with existing App.tsx / GameView.tsx layouts. */
export default function Game() {
  useCanvas2DInit();
  return null;
}
