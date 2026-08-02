/** DebugMenu — the debug overlay entry. Two independent surfaces:
 *   1. FloatingWidgetLayer — small, half-transparent, draggable stat widgets (FPS/
 *      Memory/GPU) that stay on screen WHILE PLAYING (spawned from the Stats tab).
 *   2. A FULLSCREEN modal (toggled by F12 / 3-finger tap) whose tabs live behind a
 *      ☰ button — World / Time / Journal / Store / Cheats / Console / Device, etc.
 *
 *  The tab list is a DROPDOWN, not a persistent sidebar: on a phone-sized viewport a
 *  132px column of tab names was a third of the width, and the tabs that matter most
 *  on device (World tree, Console, Journal) are exactly the ones that want it. The
 *  body is a fixed-height flex column that does NOT scroll — each tab fills it and
 *  scrolls its own list (see tabLayout.ts).
 *
 *  The widgets live outside the modal so closing the modal doesn't dismiss them.
 *  `anchor`: 'viewport' (shipped game, fixed/fullscreen) or 'container' (editor
 *  GameView — absolute within the device preview so it doesn't cover editor chrome).
 *
 *  Lives in `runtime/**`: NO wall-clock / Math.random. The 3-finger gesture uses a
 *  touch-count latch. See docs/debug-menu-plan.md. */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
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
import { registerPointerBlocker } from '../core/pointerBlockers';
import { scrollRootStyle } from './tabLayout';

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
    <div style={scrollRootStyle(6)}>
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
  const [tabsOpen, setTabsOpen] = useState(false);

  useSyncExternalStore(subscribeDebugMenu, getDebugMenuVersion, getDebugMenuVersion);

  // Mirrors for the once-installed key listener below (it can't see fresh state).
  const openRef = useRef(open);
  const tabsOpenRef = useRef(tabsOpen);
  openRef.current = open;
  tabsOpenRef.current = tabsOpen;

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
        setTabsOpen(false);
        return;
      }
      // Escape backs out one level: the tab dropdown first, then the modal. Gated on
      // the modal being open so it never eats a game's own Escape handling. Reads
      // refs, not state — this listener is installed once ([] deps).
      if (e.key === 'Escape' && openRef.current) {
        e.preventDefault();
        if (tabsOpenRef.current) setTabsOpen(false);
        else setOpen(false);
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
  const activeTab = tabs.find((t) => t.id === activeId);
  const ActiveComponent = activeTab?.Component;
  const activeTitle = activeTab?.title;

  // Register the fullscreen modal as a pointer-block root WHILE OPEN — it sits on
  // top of the running game, and without this the engine's window-level pointer
  // source (`pointerSource.ts`) would ALSO see a tap on the debug panel as a tap on
  // the game underneath (the React `onClick` stopPropagation below only stops
  // React's own synthetic click bubbling, not the raw `pointerdown` the engine
  // reads). Callback ref because the backdrop is conditionally rendered (`open`).
  const blockRef = useRef<(() => void) | null>(null);
  const backdropRef = useCallback((el: HTMLDivElement | null) => {
    blockRef.current?.();
    blockRef.current = null;
    if (el) blockRef.current = registerPointerBlocker(el);
  }, []);

  return (
    <>
      {/* Floating stat widgets + error toaster — always mounted, independent of the
          modal, so they're visible while playing. */}
      <FloatingWidgetLayer anchor={anchor} />
      <ErrorToaster anchor={anchor} />

      {/* Fullscreen tabbed modal. */}
      {open && (
        <div
          ref={backdropRef}
          style={{ ...backdropStyle, position }}
          data-debug-menu
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div style={dialogStyle} onClick={(e) => e.stopPropagation()}>
            <div style={headerStyle}>
              <button
                style={hamburgerStyle}
                onClick={() => setTabsOpen((t) => !t)}
                aria-label="Debug menu tabs"
                aria-expanded={tabsOpen}
                aria-haspopup="menu"
              >
                ☰
              </button>
              <span style={titleStyle}>{activeTitle ?? 'DEBUG'}</span>
              <span style={{ flex: 1 }} />
              <span style={brandStyle}>DEBUG</span>
              <button style={closeBtnStyle} onClick={() => setOpen(false)} aria-label="Close debug menu">
                ✕
              </button>
            </div>

            {/* Tab dropdown. The scrim is a sibling so a click ANYWHERE else in the
                dialog dismisses it without also reaching the tab body underneath. */}
            {tabsOpen && (
              <>
                <div style={scrimStyle} onClick={() => setTabsOpen(false)} />
                <div style={dropdownStyle} role="menu">
                  {tabs.map((t) => (
                    <button
                      key={t.id}
                      role="menuitem"
                      style={{ ...tabBtnStyle, ...(t.id === activeId ? tabBtnActiveStyle : null) }}
                      onClick={() => {
                        setActiveId(t.id);
                        setTabsOpen(false);
                      }}
                    >
                      <span style={{ width: 12, flexShrink: 0 }}>{t.id === activeId ? '✓' : ''}</span>
                      {t.title}
                    </button>
                  ))}
                </div>
              </>
            )}

            <div style={contentStyle}>{ActiveComponent ? <ActiveComponent /> : <div style={emptyStyle}>No tabs.</div>}</div>
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
  flexDirection: 'column',
  position: 'relative', // the tab dropdown + its scrim are absolute within the dialog
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
const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  flexShrink: 0,
  padding: '8px 10px',
  background: 'rgba(255,255,255,0.03)',
  borderBottom: '1px solid rgba(255,255,255,0.08)',
};
const hamburgerStyle: CSSProperties = {
  background: 'rgba(255,255,255,0.06)',
  border: '1px solid rgba(255,255,255,0.15)',
  color: '#e6e6ff',
  cursor: 'pointer',
  fontSize: 15,
  lineHeight: 1,
  // ≥36px square: this is a touch target on device (3-finger tap opens the menu).
  width: 36,
  height: 36,
  borderRadius: 6,
  flexShrink: 0,
};
const titleStyle: CSSProperties = { fontWeight: 600, fontSize: 14, color: '#e6e6ff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const brandStyle: CSSProperties = { fontWeight: 700, fontSize: 11, letterSpacing: 0.5, color: '#6b6b85', flexShrink: 0 };
const scrimStyle: CSSProperties = { position: 'absolute', inset: 0, zIndex: 2 };
const dropdownStyle: CSSProperties = {
  position: 'absolute',
  top: 48,
  left: 8,
  zIndex: 3,
  minWidth: 168,
  maxHeight: 'calc(100% - 60px)',
  overflowY: 'auto',
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  padding: 6,
  background: 'rgba(24,24,40,0.99)',
  border: '1px solid rgba(255,255,255,0.14)',
  borderRadius: 8,
  boxShadow: '0 10px 30px rgba(0,0,0,0.55)',
};
const tabBtnStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
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
const closeBtnStyle: CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: '#8b8ba7',
  cursor: 'pointer',
  fontSize: 16,
  lineHeight: 1,
  padding: 4,
  flexShrink: 0,
};
// The body does NOT scroll — it's a fixed-height flex column each tab fills and
// scrolls internally (see tabLayout.ts). `minHeight: 0` so a tall tab can shrink.
const contentStyle: CSSProperties = { flex: 1, minHeight: 0, minWidth: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', padding: '14px 16px' };
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
