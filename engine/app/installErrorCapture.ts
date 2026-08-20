/**
 * Side-effect module: installs the engine's global JS error capture (#275).
 *
 * ⚠️ IT EXISTS ONLY FOR ITS POSITION, and that is the whole point. `main.tsx` used to call
 * `installGlobalErrorHandlers()` as its first STATEMENT, which is not the same as first: ES module
 * imports are hoisted and evaluated in source order before any statement of the importing module
 * runs, so `./App.tsx` and its entire transitive graph — the engine runtime barrel, PixiJS, three,
 * every game trait registration — had already executed by then. A top-level throw anywhere in
 * there escaped capture entirely, and that failure looks to a player like a blank screen on launch
 * with nothing reported: precisely the invisible launch-day crash this phase was built to end.
 *
 * Imported ABOVE `./App.tsx` in `main.tsx`, a side-effect import is the only construct that runs
 * early enough. Keep it there, and keep this file's own import list minimal — anything it pulls in
 * is itself uncovered.
 */

import { installGlobalErrorHandlers } from '@modoki/engine/runtime';

installGlobalErrorHandlers();
