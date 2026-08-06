/** Profiler panel (profiler plan P5) — the EDITOR's dockable view of the marker data.
 *
 *  WHY THIS EXISTS SEPARATELY FROM THE IN-GAME TAB. The debug menu's Profiler tab only reaches a
 *  human who is running the GAME with `debugBuild` on and the menu open. Verified on a live
 *  editor: the debug menu is not mounted in the editor at all — no DOM, no global — so a human
 *  doing normal editor work could not see the profiler at any point. The editor is where they
 *  work, so the profiler has to be a dockable panel here too, per the editor-surface convention
 *  (inspection tools are dockable panels; modals are one-shot dialogs).
 *
 *  Both surfaces render the SAME component over the SAME core modules, so the panel, the in-game
 *  tab and the MCP payload cannot disagree about a frame — which is the whole ordering the plan
 *  is built on.
 *
 *  MOUNTING TURNS PROFILING ON. In a game the markers are enabled by the debug-menu chunk (which
 *  a release build tree-shakes out); the editor has no such hook, and a project with `debugBuild`
 *  off would otherwise show a permanently empty panel. Opening the panel IS the opt-in.
 *
 *  It deliberately does NOT turn profiling off on unmount: the aggregation window would be
 *  discarded, so closing and reopening the panel — or docking it elsewhere, which remounts —
 *  would silently reset the measurement a human was in the middle of reading. Leaving it on
 *  costs two clock reads and a ring write per frame in a dev-only build. */

import { useEffect } from 'react';
import { ProfilerTab } from '../../runtime/debug/tabs/ProfilerTab';
import { setProfilerEnabled, isProfilerEnabled } from '../../runtime/core/profilerMarkers';

export default function Profiler() {
  useEffect(() => {
    if (!isProfilerEnabled()) setProfilerEnabled(true);
  }, []);
  return <ProfilerTab />;
}
