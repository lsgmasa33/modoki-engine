/** `capacitor-modoki-system`'s web `openUrl` enforces the same https rule as the engine's
 *  `system.openUrl` (#1196 close-out).
 *
 *  The two are separate JavaScript copies (the engine never imports plugin JS, see `systemControls.ts`),
 *  so this replays the engine rule's vector table against the plugin copy. It lives in the app suite,
 *  not the modoki package suite, because the package typecheck's `rootDir` cannot reach another package's
 *  source. */

import { describe, expect, it } from 'vitest';
import { isHttpsUrl } from '../../packages/capacitor-modoki-system/src/web';
import { OPENABLE_URLS, REFUSED_URLS } from '../../packages/modoki/tests/runtime/openUrlVectors';

describe("capacitor-modoki-system's web openUrl uses the engine's https rule", () => {
  it.each(OPENABLE_URLS)('accepts %s', (_label, url) => expect(isHttpsUrl(url)).toBe(true));
  it.each(REFUSED_URLS)('refuses %s', (_label, url) => expect(isHttpsUrl(url)).toBe(false));
});
