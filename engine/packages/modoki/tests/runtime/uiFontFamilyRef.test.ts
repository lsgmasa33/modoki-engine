/** `resolveUIFontFamily` — the ONE place that decides what CSS `font-family` a UI element
 *  gets (#231), so this is where the precedence contract is pinned.
 *
 *  Two authored fields: `fontFamily` (a font-ASSET GUID) and `systemFont` (a plain CSS family
 *  name, for a typeface no asset can express). Precedence is one-way and deliberate —
 *  asset → systemFont → browser default — because "both are set" must never be a question a
 *  reader answers by experiment.
 *
 *  The legacy case matters as much as the new one: `fontFamily` held a family NAME before
 *  #231, and a scene authored then must keep rendering in the right typeface rather than
 *  silently reverting to the browser default. It warns, because such a value is invisible to
 *  the build's ref walk and the font may simply be absent from a production bundle. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveUIFontFamily, resetFontRefWarnings } from '../../src/runtime/ui/fontFamilyRef';
import { domFontProvider } from '../../src/runtime/core/domFontProvider';

const FONT_GUID = '30000000-0000-4000-8000-000000000001';
const OTHER_GUID = '30000000-0000-4000-8000-000000000002';
const AXES_GUID = '30000000-0000-4000-8000-000000000003';

beforeEach(() => {
  resetFontRefWarnings();
  domFontProvider.provide({
    familyForGuid: (g) => (g === FONT_GUID ? 'Varela Round'
      : g === AXES_GUID ? 'Geologica Variable Font CRSV,SHRP,slnt,wght'
      : undefined),
  });
});
afterEach(() => {
  domFontProvider.reset();
  // A test that FAILS never reaches its own `warn.mockRestore()`, and `vi.spyOn` returns the
  // ALREADY-INSTALLED mock rather than a fresh one — so the next test's spy inherits the dead
  // test's call count and fails too. One real failure then reads as two. Restore centrally.
  vi.restoreAllMocks();
});

describe('resolveUIFontFamily — precedence', () => {
  it('resolves a font-asset GUID through the manifest seam', () => {
    expect(resolveUIFontFamily(FONT_GUID, '')).toBe('"Varela Round"');
  });

  /** A family name comes from the FILENAME, and a variable font's filename carries its axis
   *  list — so the family legitimately contains COMMAS, which unquoted CSS reads as a stack of
   *  four families, none of them the registered one. The text then renders in the browser
   *  default, silently. Found by perturbing the authored ref against the live editor. */
  it('quotes an asset family so commas in it are not read as a CSS stack', () => {
    expect(resolveUIFontFamily(AXES_GUID, '')).toBe('"Geologica Variable Font CRSV,SHRP,slnt,wght"');
  });

  /** A stack is a legitimate, intended value in `systemFont` — quoting it would collapse four
   *  families into one nonexistent name and lose the fallbacks. Never quoted. */
  it('does NOT quote systemFont — a stack there is the point', () => {
    expect(resolveUIFontFamily('', 'Helvetica Neue, sans-serif')).toBe('Helvetica Neue, sans-serif');
  });

  it('falls back to systemFont when no asset is set', () => {
    expect(resolveUIFontFamily('', 'Helvetica Neue, sans-serif')).toBe('Helvetica Neue, sans-serif');
  });

  it('returns empty (browser default) when neither is set', () => {
    expect(resolveUIFontFamily('', '')).toBe('');
    expect(resolveUIFontFamily(undefined, undefined)).toBe('');
  });

  it('the ASSET wins when both are set', () => {
    expect(resolveUIFontFamily(FONT_GUID, 'Helvetica')).toBe('"Varela Round"');
  });
});

describe('resolveUIFontFamily — a ref that resolves to nothing', () => {
  it('falls through to systemFont and warns once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveUIFontFamily(OTHER_GUID, 'Helvetica')).toBe('Helvetica');
    expect(resolveUIFontFamily(OTHER_GUID, 'Helvetica')).toBe('Helvetica');
    // Warn-ONCE per value: a tree of 200 nodes inheriting one broken ref must not log 200 times.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(OTHER_GUID);
    warn.mockRestore();
  });

  it('never throws when nothing provided the seam (headless / DCE’d build)', () => {
    domFontProvider.reset();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveUIFontFamily(FONT_GUID, 'Helvetica')).toBe('Helvetica');
    warn.mockRestore();
  });
});

describe('resolveUIFontFamily — the warning is not silenced forever', () => {
  /** The warn-once key is dropped when the value resolves, so a font re-imported mid-session
   *  that breaks AGAIN warns again. Same self-healing shape as fontLoader's `familyWarned`;
   *  without it the second break is silent and the UI renders unstyled with a clean console. */
  it('warns again after a broken ref has resolved once in between', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let known = false;
    domFontProvider.provide({ familyForGuid: () => (known ? 'Varela Round' : undefined) });

    resolveUIFontFamily(FONT_GUID, '');                 // broken → warns
    expect(warn).toHaveBeenCalledTimes(1);
    known = true;
    expect(resolveUIFontFamily(FONT_GUID, '')).toBe('"Varela Round"');   // resolves → forgets
    known = false;
    resolveUIFontFamily(FONT_GUID, '');                 // broken again → warns again
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});

/** `authoredOn` — TWO traits carry a DOM font ref: `UIElement.fontFamily` (per element) and
 *  `UISettings.fontFamily` (the scene-wide default, #803). The warning has to name the right one:
 *  Court authors NO `UIElement` font at all now, so a warning saying `[UIElement]` sends the author
 *  hunting through elements for a field none of them has. And the legacy branch's
 *  "(pre-#231 authoring)" is a statement about history that is simply false of a field #803
 *  created — a diagnostic that confidently misexplains is worse than a vague one. */
describe('resolveUIFontFamily — the warning names the trait that authored the value (#803)', () => {
  it('an unresolved UISettings ref is reported as [UISettings], not [UIElement]', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    domFontProvider.provide({ familyForGuid: () => undefined });
    resolveUIFontFamily(FONT_GUID, '', 'UISettings');
    const msg = String(warn.mock.calls[0]?.[0] ?? '');
    expect(msg).toContain('[UISettings]');
    expect(msg).not.toContain('[UIElement]');
    warn.mockRestore();
  });

  it('defaults to [UIElement] when no trait is named — every existing 2-arg caller', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    domFontProvider.provide({ familyForGuid: () => undefined });
    resolveUIFontFamily(FONT_GUID, '');
    expect(String(warn.mock.calls[0]?.[0] ?? '')).toContain('[UIElement]');
    warn.mockRestore();
  });

  it('does NOT blame pre-#231 authoring for a family name on UISettings — that field is younger', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    resolveUIFontFamily('Helvetica Neue', '', 'UISettings');
    const msg = String(warn.mock.calls[0]?.[0] ?? '');
    expect(msg).toContain('[UISettings]');
    expect(msg).not.toContain('pre-#231');
    warn.mockRestore();
  });

  it('still says pre-#231 for a family name on UIElement, where it is true', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    resolveUIFontFamily('Helvetica Neue', '', 'UIElement');
    expect(String(warn.mock.calls[0]?.[0] ?? '')).toContain('pre-#231');
    warn.mockRestore();
  });
});

describe('resolveUIFontFamily — legacy family names (pre-#231)', () => {
  it('still renders a bare family name, warning once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveUIFontFamily('Varela Round', '')).toBe('Varela Round');
    expect(resolveUIFontFamily('Varela Round', '')).toBe('Varela Round');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/pre-#231|family NAME/);
    warn.mockRestore();
  });

  it('a legacy name still beats systemFont — it is the more specific authoring', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveUIFontFamily('Varela Round', 'Helvetica')).toBe('Varela Round');
    warn.mockRestore();
  });
});

/** A font REF must name a font ASSET. `fontFamilyFromPath` derives a family from any filename
 *  without looking at the extension, so without a type check a texture GUID pasted into
 *  `fontFamily` resolves to a plausible-looking family ("hero sprite") and is returned as a
 *  SUCCESS — the "resolves to nothing" warning never fires, and the DOM gets an inert
 *  `font-family` with no diagnostic anywhere. Reachable by typing a valid-shaped GUID into the
 *  field, which `isAcceptableTypedRef` accepts (it checks GUID shape, not asset type). */
describe('familyForFontRef — the asset has to be a font', () => {
  const FONT = '40000000-0000-4000-8000-000000000001';
  const TEXTURE = '40000000-0000-4000-8000-000000000002';

  async function loader() {
    const manifest = await import('../../src/runtime/loaders/assetManifest');
    manifest.clearManifest();
    manifest.registerAsset(FONT, '/games/x/assets/fonts/VarelaRound-Regular.ttf', 'font');
    manifest.registerAsset(TEXTURE, '/games/x/assets/tex/hero-sprite.png', 'texture');
    return import('../../src/runtime/loaders/fontLoader');
  }

  it('resolves a font GUID to its family', async () => {
    const { familyForFontRef } = await loader();
    expect(familyForFontRef(FONT)).toBe('Varela Round');
  });

  it('refuses a GUID naming a NON-font asset instead of inventing a family', async () => {
    const { familyForFontRef } = await loader();
    expect(familyForFontRef(TEXTURE)).toBeUndefined();   // NOT 'hero sprite'
  });

  it('refuses a GUID that names nothing', async () => {
    const { familyForFontRef } = await loader();
    expect(familyForFontRef('40000000-0000-4000-8000-0000000000ff')).toBeUndefined();
  });
});
