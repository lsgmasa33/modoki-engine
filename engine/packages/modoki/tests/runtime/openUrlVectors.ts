/** The URL shapes `system.openUrl` must open and refuse (#1196), shared by the engine rule
 *  (`systemControls.test.ts`) and the plugin's web copy (`systemControlsRegistration.test.ts`), so
 *  the two JavaScript copies of one rule cannot drift apart.
 *
 *  REFUSE holds two groups. Plain wrong-scheme cases come first. The rest parse as https under
 *  WHATWG `new URL()`, but iOS 16's `URL(string:)` returns nil for them (Court's floor is 16.4), so
 *  accepting one gives a link that opens in the editor and does nothing on a phone. */

export const OPENABLE_URLS: ReadonlyArray<readonly [label: string, url: string]> = [
  ['a plain page', 'https://apiarygames.com/privacy.html'],
  ['a query and a fragment', 'https://apiarygames.com/p?x=1&y=2#section'],
  ['a percent-encoded space', 'https://apiarygames.com/privacy%20policy.html'],
  ['a punycode host', 'https://xn--bcher-kva.example/'],
  ['an explicit port', 'https://apiarygames.com:443/terms.html'],
  ['no path', 'https://apiarygames.com'],
];

export const REFUSED_URLS: ReadonlyArray<readonly [label: string, url: unknown]> = [
  ['http', 'http://apiarygames.com/privacy.html'],
  ['javascript', 'javascript:alert(1)'],
  ['tel', 'tel:+15555550100'],
  ['a bare path', 'apiarygames.com/privacy.html'],
  ['a number', 42],
  ['no host', 'https://'],
  ['an upper-case scheme', 'HTTPS://apiarygames.com/privacy.html'],
  // WHATWG repairs these; iOS 16 finds no URL (or no host) in them.
  ['a missing //', 'https:apiarygames.com/privacy.html'],
  ['a leading space', ' https://apiarygames.com/privacy.html'],
  ['a third slash', 'https:///apiarygames.com/privacy.html'],
  ['backslashes', 'https:\\\\apiarygames.com\\privacy.html'],
  ['an unencoded space in the path', 'https://apiarygames.com/privacy policy.html'],
  ['a pipe', 'https://apiarygames.com/path|x'],
  ['a non-ASCII path', 'https://apiarygames.com/ä'],
  ['a non-ASCII host', 'https://bücher.example/'],
  ['a bad percent escape', 'https://apiarygames.com/%zz'],
  ['a trailing %', 'https://apiarygames.com/a%'],
  ['a double quote', 'https://apiarygames.com/a"b'],
  ['braces', 'https://apiarygames.com/{x}'],
  ['a caret', 'https://apiarygames.com/a^b'],
  ['angle brackets', 'https://apiarygames.com/a<b>'],
  ['a second #', 'https://apiarygames.com/#a#b'],
];
