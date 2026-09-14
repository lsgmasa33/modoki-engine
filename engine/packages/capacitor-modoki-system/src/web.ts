import { WebPlugin } from '@capacitor/core';

import type { ModokiSystemPlugin } from './definitions';

export class ModokiSystemWeb extends WebPlugin implements ModokiSystemPlugin {
  // A browser has no per-app Settings page to open.
  async openAppSettings(): Promise<{ opened: boolean }> {
    return { opened: false };
  }

  // `window.open` returning null is not a failure signal here — see `openUrl` in definitions.ts.
  // The https-only rule is restated in Swift, Java and the engine's `system.openUrl` action, because
  // none of them can import this file.
  async openUrl(options: { url: string }): Promise<{ opened: boolean }> {
    if (!isHttpsUrl(options?.url) || typeof window === 'undefined') return { opened: false };
    window.open(options.url, '_blank', 'noopener,noreferrer');
    return { opened: true };
  }
}

// The engine's `isOpenableUrl` rule (its docblock says why `new URL()` alone is not enough: iOS 16
// refuses shapes a browser repairs). Exported only so the engine replays its vectors against this copy.
const URL_CHARS = "A-Za-z0-9\\-._~!$&'()*+,;=:@%";
const OPENABLE_URL = new RegExp(
  `^https://[${URL_CHARS}\\[\\]]+(?:/[${URL_CHARS}/]*)?(?:\\?[${URL_CHARS}/?]*)?(?:#[${URL_CHARS}/?]*)?$`,
);
const BAD_PERCENT = /%(?![0-9A-Fa-f]{2})/;

export function isHttpsUrl(url: unknown): url is string {
  if (typeof url !== 'string' || !OPENABLE_URL.test(url) || BAD_PERCENT.test(url)) return false;
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}
