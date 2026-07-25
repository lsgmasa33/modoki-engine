/** LoadingOverlay — fullscreen fade-in overlay shown during scene preload.
 *  Non-interactive (pointer-events: none) so the underlying scene keeps
 *  receiving input until the swap actually happens. */

import { useEffect, useState } from 'react';

interface Props {
  visible: boolean;
  /** When set, shows a progress bar + label instead of the spinner — the OTA
   *  mandatory-update download gate (docs/ota-updates.md, Phase 3b) is the only
   *  caller today. `fraction: null` = indeterminate (total bytes not yet known). */
  progress?: { fraction: number | null; label: string } | null;
}

export default function LoadingOverlay({ visible, progress }: Props) {
  // Delay mount briefly so a fast preload (< 120 ms) doesn't flash an overlay.
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    if (!visible) {
      setMounted(false);
      return;
    }
    const t = setTimeout(() => setMounted(true), 120);
    return () => clearTimeout(t);
  }, [visible]);

  if (!visible && !mounted) return null;

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background: '#0a0a1a',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#e6e6ff',
        fontSize: 14,
        fontFamily: 'system-ui, sans-serif',
        pointerEvents: 'none',
        opacity: mounted && visible ? 1 : 0,
        transition: 'opacity 160ms ease-out',
        zIndex: 1000,
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 12,
        }}
      >
        {progress ? (
          <>
            <div
              style={{
                width: 180,
                height: 6,
                borderRadius: 3,
                background: 'rgba(230, 230, 255, 0.2)',
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  height: '100%',
                  borderRadius: 3,
                  background: '#e6e6ff',
                  ...(progress.fraction != null
                    ? { width: `${Math.round(Math.min(1, Math.max(0, progress.fraction)) * 100)}%`, transition: 'width 120ms ease-out' }
                    : { width: '35%', animation: 'loading-overlay-indeterminate 1.1s ease-in-out infinite' }),
                }}
              />
            </div>
            <span>{progress.label}</span>
          </>
        ) : (
          <>
            <div
              style={{
                width: 28,
                height: 28,
                border: '3px solid rgba(230, 230, 255, 0.25)',
                borderTopColor: '#e6e6ff',
                borderRadius: '50%',
                animation: 'loading-overlay-spin 0.9s linear infinite',
              }}
            />
            <span>Loading…</span>
          </>
        )}
      </div>
      <style>{`
        @keyframes loading-overlay-spin { to { transform: rotate(360deg); } }
        @keyframes loading-overlay-indeterminate {
          0% { margin-left: -35%; }
          100% { margin-left: 100%; }
        }
      `}</style>
    </div>
  );
}
