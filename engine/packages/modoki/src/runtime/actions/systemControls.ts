/**
 * Built-in system control layer — leaving the app for a system surface, as a UI action a scene can
 * author (#1196). Today that is one action:
 *
 *  - `system.openUrl` — open a web page in the system browser (`params: { url }`). What a settings
 *    screen's Privacy Policy / Terms of Use link uses, with the URL authored on the binding in the
 *    scene rather than in code.
 *
 * Plus one plain function, `copyToClipboard` (#1398), which is not an action because what it copies
 * (a player ID) is runtime data a scene binding cannot carry. A game's own action calls it.
 *
 * ── Where the page opens ────────────────────────────────────────────────────
 * - **Native (iOS / Android):** `capacitor-modoki-system`'s `openUrl` — Safari or the default Android
 *   browser, leaving the app (the owner's call, 2026-09-15: system browser, not an in-app sheet).
 *   Reached by NAME through `registerPlugin` with `import type` only, the `capacitorStore.ts`
 *   pattern, so the engine never imports the plugin's JavaScript and a game that does not list it
 *   still builds.
 * - **Web and the editor:** `window.open`. The engine opens the tab itself rather than calling the
 *   plugin, because the plugin's web implementation lives in the plugin's JavaScript, which the
 *   engine does not import. In the Electron editor, `setWindowOpenHandler` (`engine/electron/main.ts`)
 *   forwards an http(s) `window.open` to `shell.openExternal` and denies the in-app window, so the
 *   Game panel opens the system browser and never navigates the editor.
 *
 * ── Why app-wide, unlike `registerIapControls` ─────────────────────────────
 * Opening a page is a capability every build has on the web and in the editor, so an authored link
 * works in any project there. Only on native does it need the plugin, and a native build without it
 * REFUSES loudly (`log: 'error'`, a Crashlytics issue in a shipped build) instead of doing nothing —
 * the failure lands on the first device run rather than in store review.
 *
 * ── Refusals are synchronous ────────────────────────────────────────────────
 * Both refusals are decided BEFORE the plugin call, so they come back as the return value and the
 * dispatch-action agent op answers `ok:false` (#1129). What the OS does with a valid URL arrives
 * later and goes to the journal (`system.openUrl`, `{ url, opened }`), since a returned Promise is
 * only duck-typed for the input lock (#466), never read as a refusal.
 *
 * App-tier and event-driven — no per-frame tick, no wall-clock, no randomness.
 */

import { Capacitor, registerPlugin } from '@capacitor/core';
import type { World } from 'koota';

import type { ModokiSystemPlugin } from 'capacitor-modoki-system';
import { registerUIAction, refuseAction } from '../core/actionRegistry';
import { emit } from '../core/journal';

/** The native plugin's registered name — `jsName` in the Swift plugin, `@CapacitorPlugin(name)` in
 *  the Java one. */
const PLUGIN_NAME = 'ModokiSystem';

/** The plugin to call, resolved per tap and never at module scope — a top-level `registerPlugin` is
 *  an import-time side effect on a module the runtime barrel reaches (see `capacitorStore.ts`).
 *
 *  ⚠️ **On a device, `Capacitor.Plugins.ModokiSystem` normally exists before any JavaScript runs.**
 *  Both native bridges write a plain object there at document start, one method per native method,
 *  each forwarding to `Capacitor.nativePromise` (iOS `JSExport.exportJS`, Android
 *  `JSExport.getPluginJS`). A game that imports the plugin's JavaScript (wordweave, for its reminder
 *  row) replaces that object with a `registerPlugin` proxy at boot. So the action uses whatever is
 *  there, and **never calls `registerPlugin` a second time** (#1196 close-out): that returns the same
 *  proxy but `console.warn`s "already registered", and in a shipped build every `console.warn` is a
 *  Crashlytics issue (`core/globalErrors.ts`), one per player who taps a Privacy link.
 *
 *  It falls back to `registerPlugin` only when the entry has no `openUrl`: a JS bundle delivered by OTA
 *  to an older native binary whose plugin predates `openUrl`. The proxy then rejects with "not
 *  implemented", which the handler journals, where calling `undefined` would throw inside the tap. */
let registeredHere: ModokiSystemPlugin | null = null;
function system(): ModokiSystemPlugin {
  const bridged = (Capacitor as unknown as { Plugins?: Record<string, Partial<ModokiSystemPlugin>> }).Plugins?.[PLUGIN_NAME];
  if (typeof bridged?.openUrl === 'function') return bridged as ModokiSystemPlugin;
  return (registeredHere ??= registerPlugin<ModokiSystemPlugin>(PLUGIN_NAME));
}

/** RFC 3986's allowed ASCII, minus the delimiters each URL part adds on its own. */
const URL_CHARS = "A-Za-z0-9\\-._~!$&'()*+,;=:@%";
const OPENABLE_URL = new RegExp(
  `^https://[${URL_CHARS}\\[\\]]+(?:/[${URL_CHARS}/]*)?(?:\\?[${URL_CHARS}/?]*)?(?:#[${URL_CHARS}/?]*)?$`,
);
const BAD_PERCENT = /%(?![0-9A-Fa-f]{2})/;

/** True for the one URL shape `system.openUrl` opens: a literal lowercase `https://`, a host right
 *  after it, and nothing outside RFC 3986's ASCII allow-list. Every `%` must start a two-digit hex
 *  escape, and there can be at most one `#`.
 *
 *  ⚠️ **Stricter than `new URL()` on purpose** (#1196 close-out, two rounds). A browser repairs or
 *  encodes shapes the plugin then refuses on a phone, so the link opens in the editor and does nothing
 *  on the device, with the loud refusal never firing. Two groups:
 *  - `https:host/…`, `https:///host/…`, backslashes and a leading space: Foundation's `URL(string:)`
 *    finds no host (or no URL) in them on EVERY iOS version.
 *  - `|`, non-ASCII, `"`, `{}`, `^`, `<>`, a second `#` and bad escapes: iOS 16's `URL(string:)`
 *    returns nil (Court's floor is 16.4), while iOS 17+ percent-encodes them like a browser. That is
 *    why a new phone does not catch them, and it is not a reason to relax this for 17+. The rule only has to be at least as strict
 *  as the strictest native side: a URL refused here that a phone would have opened is an authoring fix,
 *  while the other direction ships a dead link. Hosts must be ASCII, so write an IDN host in punycode.
 *  The plugin's web copy is replayed against the same vectors (`engine/tests/plugins/modokiSystemWebUrlRule.test.ts`). Swift and Java
 *  state their own, looser checks, and this rule is the gate in front of them. */
export function isOpenableUrl(url: unknown): url is string {
  if (typeof url !== 'string' || !OPENABLE_URL.test(url) || BAD_PERCENT.test(url)) return false;
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

/** Put `text` on the system clipboard (#1398): a Settings "Copy player ID" button, where support
 *  needs the player to paste an exact value into an email. Resolves `true` only when the text was
 *  handed to a clipboard, and `false` otherwise. It never rejects, so the caller can show a
 *  "Copied" or a failure line without a try/catch.
 *
 *  - **Native:** `capacitor-modoki-system`'s `copyText` (`UIPasteboard` / `ClipboardManager`). NOT
 *    `navigator.clipboard`: a UI action runs from the ECS dispatch, which can fall outside the tap's
 *    user-activation window that WebKit requires for a clipboard write, and whether the app's
 *    `capacitor://` page counts as a secure context was never measured. The native pasteboard
 *    depends on neither. A native build without the plugin, or a bundle delivered by OTA to a binary
 *    whose plugin predates `copyText`, answers `false` and logs it at `error`, never a false success.
 *  - **Web and the editor:** `navigator.clipboard.writeText`. It checks PRESENCE first, because
 *    outside a secure context `navigator.clipboard` is undefined and `?.writeText` would resolve
 *    `undefined`, which reads as success with an untouched clipboard.
 *
 *  Journaled as `system.copyText` `{ copied }`, never with the text itself, because the value is an
 *  identifier and the journal is shipped in bug reports. */
export async function copyToClipboard(text: string, world?: World): Promise<boolean> {
  const copied = await writeClipboard(text);
  emit('system.copyText', { copied }, world, copied ? 'info' : 'warn');
  return copied;
}

async function writeClipboard(text: string): Promise<boolean> {
  if (typeof text !== 'string' || text === '') return false;
  if (Capacitor.isNativePlatform()) {
    if (!Capacitor.isPluginAvailable(PLUGIN_NAME)) {
      console.error('[copyToClipboard] this native build does not include capacitor-modoki-system — add it to the '
        + 'game\'s package.json and capacitor.config.json includePlugins, then cap sync.');
      return false;
    }
    const plugin = system();
    if (typeof plugin.copyText !== 'function') {
      console.error('[copyToClipboard] the native capacitor-modoki-system predates copyText (an OTA bundle on an older binary).');
      return false;
    }
    try {
      return (await plugin.copyText({ text })).copied === true;
    } catch (err) {
      // The registerPlugin fallback proxy rejects "not implemented" on a binary without copyText.
      console.error('[copyToClipboard] copyText failed:', err);
      return false;
    }
  }
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  if (!clipboard || typeof clipboard.writeText !== 'function') return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function registerSystemControls(): void {
  registerUIAction('system.openUrl', {
    params: {
      url: { type: 'string', tooltip: 'An https:// page to open in the system browser — e.g. the Privacy Policy or Terms of Use.' },
    },
    handler: ({ params, world }) => {
      const url = params?.url;
      // Authored scene data — validated, never trusted. `log: 'error'` because a bad URL here is an
      // authoring defect that ships, not a routine player-facing refusal.
      if (!isOpenableUrl(url)) {
        return refuseAction(
          `[system.openUrl] ${JSON.stringify(url ?? null)} is not an https:// URL — only https pages open. `
          + 'Set the binding\'s `url` param to the full page address.',
          { log: 'error' },
        );
      }

      if (Capacitor.isNativePlatform()) {
        if (!Capacitor.isPluginAvailable(PLUGIN_NAME)) {
          return refuseAction(
            '[system.openUrl] this native build does not include capacitor-modoki-system — add it to the '
            + 'game\'s package.json and capacitor.config.json includePlugins, then cap sync.',
            { log: 'error' },
          );
        }
        // Returned so the input lock (#466) holds until the OS has answered — a second tap during
        // the hand-off would otherwise open the page twice.
        return system().openUrl({ url }).then(
          ({ opened }) => emit('system.openUrl', { url, opened }, world, opened ? 'info' : 'warn'),
          (err: unknown) => emit('system.openUrl', { url, opened: false, error: String(err) }, world, 'warn'),
        );
      }

      if (typeof window === 'undefined') {
        return refuseAction('[system.openUrl] no window to open a page in (headless run).', { log: false });
      }
      // `window.open` returns null both for a popup blocker and for the editor's deny-and-forward
      // handler, which DID open the page — so its result cannot say whether the page opened.
      window.open(url, '_blank', 'noopener,noreferrer');
      emit('system.openUrl', { url, opened: true }, world);
      return undefined;
    },
  });
}
