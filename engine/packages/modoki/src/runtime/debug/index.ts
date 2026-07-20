/** `@modoki/engine/runtime/debug` — the in-game debug-menu UI subpath.
 *
 *  Separate from the main runtime index so importing the UI (DebugMenu + tabs, which
 *  pull React component code) is opt-in: the app shell lazy-imports this behind a
 *  build-flag gate, so a release game with `enableDebugMenu` off tree-shakes it out.
 *  The pure registry (registerDebugTab/registerDebugCommand/isDebugMenuEnabled) is
 *  re-exported from the main runtime index for cheap game-side registration.
 *
 *  Importing this module registers the built-in tabs (Stats, ...). */

import { registerDebugTab } from './debugMenuRegistry';
import { registerStatWidget } from './widgetStore';
import { installConsoleCapture } from './consoleCapture';
import { installDrawCallProbe } from './drawCallProbe';
import { FpsWidget } from './widgets/FpsWidget';
import { MemoryWidget } from './widgets/MemoryWidget';
import { GpuWidget } from './widgets/GpuWidget';
import { StatsTab } from './tabs/StatsTab';
import { WorldTab } from './tabs/WorldTab';
import { TimeTab } from './tabs/TimeTab';
import { JournalTab } from './tabs/JournalTab';
import { StoreTab } from './tabs/StoreTab';
import { PlayerPrefsTab } from './tabs/PlayerPrefsTab';
import { CheatsTab } from './tabs/CheatsTab';
import { ConsoleTab } from './tabs/ConsoleTab';
import { DeviceTab } from './tabs/DeviceTab';

// Start capturing console.* as soon as the (enabled) debug-menu chunk loads.
installConsoleCapture();
// Make per-frame draw-call/triangle stats accurate under multi-pass rendering.
installDrawCallProbe();

// Built-in floating stat widgets (spawned from the Stats launcher). Cascade their
// default positions so stacked widgets don't perfectly overlap.
registerStatWidget({ id: 'fps', title: 'FPS', order: 0, Component: FpsWidget, defaultPos: { x: 16, y: 16 } });
registerStatWidget({ id: 'memory', title: 'Memory', order: 10, Component: MemoryWidget, defaultPos: { x: 16, y: 96 } });
registerStatWidget({ id: 'gpu', title: 'GPU', order: 20, Component: GpuWidget, defaultPos: { x: 16, y: 176 } });

registerDebugTab({ id: 'stats', title: 'Stats', order: 0, Component: StatsTab });
registerDebugTab({ id: 'world', title: 'World', order: 10, Component: WorldTab });
registerDebugTab({ id: 'time', title: 'Time', order: 20, Component: TimeTab });
registerDebugTab({ id: 'journal', title: 'Journal', order: 30, Component: JournalTab });
registerDebugTab({ id: 'store', title: 'Store', order: 40, Component: StoreTab });
registerDebugTab({ id: 'prefs', title: 'Prefs', order: 45, Component: PlayerPrefsTab });
registerDebugTab({ id: 'cheats', title: 'Cheats', order: 50, Component: CheatsTab });
registerDebugTab({ id: 'console', title: 'Console', order: 60, Component: ConsoleTab });
registerDebugTab({ id: 'device', title: 'Device', order: 70, Component: DeviceTab });

export { DebugMenu } from './DebugMenu';
export { Sparkline, sparkPoints, type SparklineProps } from './Sparkline';
export { registerStatWidget, toggleWidget, isWidgetOpen, type StatWidgetDef } from './widgetStore';
export * from './debugMenuRegistry';
