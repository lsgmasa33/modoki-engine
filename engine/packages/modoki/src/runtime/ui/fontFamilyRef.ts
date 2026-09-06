/** Resolve a `UIElement`'s authored font fields into the ONE CSS `font-family` value the DOM
 *  gets (#231).
 *
 *  Two fields, because a GUID cannot name `system-ui` or `Helvetica` (owner's call on #231):
 *    - `fontFamily` — a font-ASSET GUID, resolved through the manifest like every other ref,
 *      and therefore visible to the validator, `diagnose`, and the build's tree-shaker.
 *    - `systemFont` — a plain CSS family name, for the case a GUID cannot express.
 *
 *  **Precedence is one-way and settled: asset → systemFont → engine default (empty).** Both
 *  set is not a question the reader has to answer by experiment: the asset wins.
 *
 *  Resolution goes through `core/domFontProvider` rather than importing the manifest, because
 *  `ui/` is an L2 subsystem and `loaders/` is L3 (docs/architecture-layers.md). */

import { isGuid } from '../core/assetRefRules';
import { domFontProvider } from '../core/domFontProvider';

/** Wrap an asset-resolved family name in CSS quotes.
 *
 *  ⚠️ Not cosmetic: a family name is derived from the FILENAME (`fontFamilyFromPath`), and a
 *  variable font's filename routinely carries its axis list —
 *  `Geologica-VariableFont_CRSV,SHRP,slnt,wght.ttf` registers under the family
 *  `Geologica Variable Font CRSV,SHRP,slnt,wght`. Written into `font-family` UNQUOTED, CSS
 *  reads those commas as a font STACK of four families, none of which is the registered one,
 *  so the text silently renders in the browser default. Measured live on `games/court`
 *  (2026-08-21) while perturbing the authored ref.
 *
 *  Applied ONLY to an asset-resolved name, which is always exactly one family. `systemFont`
 *  and a legacy `fontFamily` value are passed through verbatim — a stack is a legitimate,
 *  intended value there (`Helvetica Neue, sans-serif`), and quoting it would break it. */
function cssQuote(family: string): string {
  return `"${family.replace(/(["\\])/g, '\\$1')}"`;
}

/** Warn-once per authored value — a tree with 200 nodes inheriting one broken ref logs once.
 *
 *  Kept per-VALUE and self-healing rather than per-session-forever, the same shape
 *  `fontLoader`'s `familyWarned` uses: a key is dropped the moment that value resolves (so a
 *  font re-imported mid-session can warn again if it breaks again), and the whole set is
 *  cleared on world swap (so a SECOND scene authoring the same broken ref still gets told —
 *  it independently needs the "re-pick the font" diagnostic, and silence there is a UI
 *  rendering unstyled with nothing in the console).
 *
 *  ⚠️ The swap hook lives in `uiTreeStore`'s EXISTING `onWorldSwap` callback, not at module
 *  scope here. Registering it here executes on IMPORT, and this module is pulled in by
 *  `uiTreeStore` — which 247 editor tests import while mocking `core/ecs/world` without an
 *  `onWorldSwap` export. A module-eval side effect in a widely-imported module makes every one
 *  of those mocks carry an export it does not care about; a call inside a function does not. */
const warned = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}

/** Test-only: forget the warn-once set so a later case can assert on the same warning. */
export function resetFontRefWarnings(): void {
  warned.clear();
}

/** `(fontFamily, systemFont)` → the CSS `font-family` value, or `''` for "browser default".
 *  Never throws and never blocks a render: a ref that resolves to nothing falls through to
 *  `systemFont`, exactly as an unset one would. */
export function resolveUIFontFamily(
  fontFamily: string | undefined,
  systemFont: string | undefined,
  /** Which TRAIT authored the value, for the diagnostics below. Two traits carry a DOM font
   *  ref: `UIElement.fontFamily` (per element) and `UISettings.fontFamily` (the scene-wide
   *  default, #803). A warning that names the wrong one sends the author hunting through
   *  elements for a field none of them authors — Court, whose only DOM font ref lives on
   *  `UISettings`, is exactly that case. Defaults to the older and far more common caller. */
  authoredOn: 'UIElement' | 'UISettings' = 'UIElement',
): string {
  const ref = fontFamily || '';
  const system = systemFont || '';
  if (!ref) return system;

  // Warn-once keys carry the trait: the same broken GUID on both surfaces is two distinct
  // authoring mistakes to fix, and one key would silence whichever was reached second.
  if (isGuid(ref)) {
    const family = domFontProvider.get()?.familyForGuid(ref);
    if (family) { warned.delete(`unresolved:${authoredOn}:${ref}`); return cssQuote(family); }
    warnOnce(
      `unresolved:${authoredOn}:${ref}`,
      `[${authoredOn}] fontFamily ${ref} resolves to no font asset — ` +
        (system
          ? `falling back to systemFont "${system}".`
          : 'falling back to the browser default. Re-pick the font in the Inspector.'),
    );
    return system;
  }

  // The field holds a CSS family NAME rather than a GUID. Still honoured so the text renders in
  // the intended typeface rather than silently reverting to the browser default — but warned,
  // because it is invisible to the build's ref walk (a family name is not a ref the tree-shaker
  // can follow to a file, so the font may simply be absent from a production bundle).
  //
  // On `UIElement` this is LEGACY, pre-#231 authoring, and saying so tells the author where it
  // came from. `UISettings.fontFamily` was created by #803 and never held a family name, so
  // there is nothing legacy about it — only a hand-typed value in an asset-ref field. Claiming
  // "pre-#231 authoring" there would be a confident falsehood in a diagnostic.
  warnOnce(
    `legacy:${authoredOn}:${ref}`,
    `[${authoredOn}] fontFamily "${ref}" is a CSS family NAME, not a font-asset GUID` +
      (authoredOn === 'UIElement' ? ' (pre-#231 authoring)' : '') +
      '. It still renders in the editor, but the build cannot see it as a reference — ' +
      're-pick the font in the Inspector, or move the name to the systemFont field if it is a ' +
      'system typeface.',
  );
  return ref;
}
