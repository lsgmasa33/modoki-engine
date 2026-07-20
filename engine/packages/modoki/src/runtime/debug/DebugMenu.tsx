/** DebugMenu — the debug overlay entry. Two independent surfaces:
 *   1. FloatingWidgetLayer — small, half-transparent, draggable stat widgets (FPS/
 *      Memory/GPU) that stay on screen WHILE PLAYING (spawned from the Stats tab).
 *   2. A FULLSCREEN modal (toggled by F12 / 3-finger tap) with a left tab sidebar —
 *      World / Time / Journal / Store / Cheats / Console / Device, etc.
 *
 *  The widgets live outside the modal so closing the modal doesn't dismiss them.
 *  `anchor`: 'viewport' (shipped game, fixed/fullscreen) or 'container' (editor
 *  GameView — absolute within the device preview so it doesn't cover editor chrome).
 *
 *  Lives in `runtime/**`: NO wall-clock / Math.random. The 3-finger gesture uses a
 *  touch-count latch. See docs/debug-menu-plan.md. */

import { useEffect, useMemo, useState, useSyncExternalStore, type CSSProperties } from 'react';
import {
  getDebugTabs,
  getDebugCommands,
  getDebugCommandTabs,
  subscribeDebugMenu,
  getDebugMenuVersion,
  type DebugCommandDef,
} from './debugMenuRegistry';
import { FloatingWidgetLayer } from './FloatingWidgetLayer';
import { ErrorToaster } from './ErrorToaster';

export interface DebugMenuProps {
  anchor?: 'viewport' | 'container';
}

function isEditingText(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
}

function CommandList({ tab }: { tab: string }) {
  const commands = getDebugCommands(tab);
  if (commands.length === 0) return <div style={emptyStyle}>No commands registered.</div>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {commands.map((c: DebugCommandDef, i) => (
        <button key={`${c.label}-${i}`} style={commandBtnStyle} onClick={() => runSafe(c)}>
          {c.label}
        </button>
      ))}
    </div>
  );
}

function runSafe(c: DebugCommandDef) {
  try {
    c.run();
  } catch (e) {
    console.error(`[debug-menu] command "${c.label}" threw:`, e);
  }
}

export function DebugMenu({ anchor = 'viewport' }: DebugMenuProps) {
  const [open, setOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);

  useSyncExternalStore(subscribeDebugMenu, getDebugMenuVersion, getDebugMenuVersion);

  const tabs = useMemo(() => {
    const full = getDebugTabs();
    const fullTitles = new Set(full.map((t) => t.title));
    const cmdOnly = getDebugCommandTabs()
      .filter((title) => !fullTitles.has(title))
      .map((title) => ({ id: `cmd:${title}`, title, order: 90, Component: () => <CommandList tab={title} /> }));
    return [...full, ...cmdOnly].sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.title.localeCompare(b.title));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getDebugMenuVersion()]);

  // Toggle gestures: F12 (keyboard) + 3-finger tap (touch, latch-debounced).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F12' && !isEditingText()) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    let threeFingerLatched = false;
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 3 && !threeFingerLatched) {
        threeFingerLatched = true;
        setOpen((o) => !o);
      }
    };
    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length < 3) threeFingerLatched = false;
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('touchstart', onTouchStart, { passive: true });
    window.addEventListener('touchend', onTouchEnd, { passive: true });
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('touchstart', onTouchStart);
      window.removeEventListener('touchend', onTouchEnd);
    };
  }, []);

  useEffect(() => {
    if (tabs.length === 0) return;
    if (!activeId || !tabs.some((t) => t.id === activeId)) setActiveId(tabs[0].id);
  }, [tabs, activeId]);

  const position = anchor === 'container' ? 'absolute' : 'fixed';
  const ActiveComponent = tabs.find((t) => t.id === activeId)?.Component;

  return (
    <>
      {/* Floating stat widgets + error toaster — always mounted, independent of the
          modal, so they're visible while playing. */}
      <FloatingWidgetLayer anchor={anchor} />
      <ErrorToaster anchor={anchor} />

      {/* Fullscreen tabbed modal. */}
      {open && (
        <div
          style={{ ...backdropStyle, position }}
          data-debug-menu
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div style={dialogStyle} onClick={(e) => e.stopPropagation()}>
            <div style={sidebarStyle}>
              <div style={sidebarHeaderStyle}>
                <span style={{ fontWeight: 700, letterSpacing: 0.5 }}>DEBUG</span>
              </div>
              <div style={tabListStyle}>
                {tabs.map((t) => (
                  <button
                    key={t.id}
                    style={{ ...tabBtnStyle, ...(t.id === activeId ? tabBtnActiveStyle : null) }}
                    onClick={() => setActiveId(t.id)}
                  >
                    {t.title}
                  </button>
                ))}
              </div>
            </div>
            <div style={contentWrapStyle}>
              <button style={closeBtnStyle} onClick={() => setOpen(false)} aria-label="Close debug menu">
                ✕
              </button>
              <div style={contentStyle}>{ActiveComponent ? <ActiveComponent /> : <div style={emptyStyle}>No tabs.</div>}</div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// --- styles ----------------------------------------------------------------

const backdropStyle: CSSProperties = {
  inset: 0,
  background: 'rgba(6,6,12,0.55)',
  backdropFilter: 'blur(2px)',
  WebkitBackdropFilter: 'blur(2px)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 2147483000,
  fontFamily: 'system-ui, sans-serif',
  fontSize: 13,
  pointerEvents: 'auto',
};
const dialogStyle: CSSProperties = {
  display: 'flex',
  width: '92%',
  height: '90%',
  maxWidth: 940,
  maxHeight: 720,
  background: 'rgba(16,16,28,0.97)',
  color: '#e6e6ff',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 10,
  boxShadow: '0 12px 48px rgba(0,0,0,0.6)',
  overflow: 'hidden',
};
const sidebarStyle: CSSProperties = {
  width: 132,
  flexShrink: 0,
  display: 'flex',
  flexDirection: 'column',
  background: 'rgba(255,255,255,0.03)',
  borderRight: '1px solid rgba(255,255,255,0.08)',
};
const sidebarHeaderStyle: CSSProperties = { padding: '14px 14px 10px', fontSize: 13, color: '#e6e6ff', borderBottom: '1px solid rgba(255,255,255,0.06)' };
const tabListStyle: CSSProperties = { display: 'flex', flexDirection: 'column', padding: 6, gap: 2, overflowY: 'auto' };
const tabBtnStyle: CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: '#8b8ba7',
  cursor: 'pointer',
  fontSize: 13,
  padding: '8px 10px',
  borderRadius: 6,
  textAlign: 'left',
};
const tabBtnActiveStyle: CSSProperties = { color: '#e6e6ff', background: 'rgba(99,102,241,0.28)' };
const contentWrapStyle: CSSProperties = { flex: 1, position: 'relative', display: 'flex', flexDirection: 'column', minWidth: 0 };
const closeBtnStyle: CSSProperties = {
  position: 'absolute',
  top: 10,
  right: 12,
  background: 'transparent',
  border: 'none',
  color: '#8b8ba7',
  cursor: 'pointer',
  fontSize: 16,
  lineHeight: 1,
  padding: 4,
  zIndex: 1,
};
const contentStyle: CSSProperties = { flex: 1, overflowY: 'auto', padding: '16px 18px' };
const emptyStyle: CSSProperties = { color: '#6b6b85', fontStyle: 'italic', fontSize: 12 };
const commandBtnStyle: CSSProperties = {
  background: 'rgba(99,102,241,0.18)',
  border: '1px solid rgba(99,102,241,0.4)',
  color: '#c7d2fe',
  cursor: 'pointer',
  fontSize: 13,
  padding: '8px 10px',
  borderRadius: 6,
  textAlign: 'left',
};
