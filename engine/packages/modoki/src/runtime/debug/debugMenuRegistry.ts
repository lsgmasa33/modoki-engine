/** Debug-menu registry — the extensibility seam for the in-game debug menu.
 *
 *  This module is PURE (only a `type` import of React) so it is safe to re-export
 *  from the main runtime index: a game can `registerDebugTab` / `registerDebugCommand`
 *  from `@modoki/engine/runtime` WITHOUT pulling the debug-menu UI (DebugMenu + tabs)
 *  into its eager bundle. The UI lives behind the `@modoki/engine/runtime/debug`
 *  subpath, lazy-imported (and build-flag-gated) by the app shell.
 *
 *  Ships in game builds; runtime behaviour is gated by {@link isDebugMenuEnabled}
 *  (pushed from `app/main.tsx`, mirroring `setJournalEnabled`). See
 *  docs/debug-menu-plan.md. */

import type React from 'react';

/** A full custom tab in the debug menu. */
export interface DebugTabDef {
  /** Stable unique id (used for de-dup + teardown). */
  id: string;
  /** Tab-bar label. */
  title: string;
  /** Sort key (ascending; default 100). Built-in tabs use 0..99. */
  order?: number;
  /** The tab body. Receives no props — read ECS/stores internally. */
  Component: React.ComponentType;
}

/** A one-off button grouped into a tab (the lightweight form — no React needed). */
export interface DebugCommandDef {
  /** Target tab title; grouped under the built-in "Cheats" tab by default. */
  tab?: string;
  /** Button label. */
  label: string;
  /** Fired on click. */
  run: () => void;
  /** Sort key within its group (ascending; default 100). */
  order?: number;
}

const DEFAULT_ORDER = 100;
const DEFAULT_COMMAND_TAB = 'Cheats';

const tabs = new Map<string, DebugTabDef>();
const commands: DebugCommandDef[] = [];
const listeners = new Set<() => void>();
let version = 0;

function bump(): void {
  version++;
  for (const l of listeners) l();
}

/** Register (or replace, by id) a full custom debug tab. */
export function registerDebugTab(def: DebugTabDef): void {
  tabs.set(def.id, def);
  bump();
}

/** Remove a tab by id (e.g. from a game's `unregisterSystems` on game switch). */
export function unregisterDebugTab(id: string): void {
  if (tabs.delete(id)) bump();
}

/** All registered tabs, sorted by `order` then title. */
export function getDebugTabs(): DebugTabDef[] {
  return [...tabs.values()].sort(
    (a, b) => (a.order ?? DEFAULT_ORDER) - (b.order ?? DEFAULT_ORDER) || a.title.localeCompare(b.title),
  );
}

/** Register a one-off command button (grouped into a tab). */
export function registerDebugCommand(def: DebugCommandDef): void {
  commands.push(def);
  bump();
}

/** Remove a previously-registered command (by identity or matching label+tab). */
export function unregisterDebugCommand(def: DebugCommandDef): void {
  const i = commands.indexOf(def);
  if (i >= 0) {
    commands.splice(i, 1);
    bump();
  }
}

/** Commands grouped under a given tab title, sorted by `order`. */
export function getDebugCommands(tab: string = DEFAULT_COMMAND_TAB): DebugCommandDef[] {
  return commands
    .filter((c) => (c.tab ?? DEFAULT_COMMAND_TAB) === tab)
    .sort((a, b) => (a.order ?? DEFAULT_ORDER) - (b.order ?? DEFAULT_ORDER));
}

/** Distinct tab titles that have at least one registered command. */
export function getDebugCommandTabs(): string[] {
  const seen: string[] = [];
  for (const c of commands) {
    const t = c.tab ?? DEFAULT_COMMAND_TAB;
    if (!seen.includes(t)) seen.push(t);
  }
  return seen;
}

/** Subscribe to registry changes (for React's useSyncExternalStore). */
export function subscribeDebugMenu(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Monotonic version — changes whenever tabs/commands change. */
export function getDebugMenuVersion(): number {
  return version;
}

// --- enablement gate (pushed from app/main.tsx, mirrors setJournalEnabled) -------

let _enabled = false;

/** Set by the app bootstrap: true in the editor/dev and in a shipped game build
 *  that opts in via `project.config.json` `build.debugBuild`. */
export function setDebugMenuEnabled(enabled: boolean): void {
  _enabled = enabled;
}

/** Whether the debug menu is active in this build. Games can check this to skip
 *  registering debug-only tabs/cheats in a release build. */
export function isDebugMenuEnabled(): boolean {
  return _enabled;
}

/** Test-only: wipe all registered tabs/commands + reset the gate. */
export function __resetDebugMenuRegistry(): void {
  tabs.clear();
  commands.length = 0;
  _enabled = false;
  bump();
}
