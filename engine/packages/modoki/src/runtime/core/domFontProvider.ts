/** Provider slot for the "font ref → CSS family name" seam.
 *
 *  `UIElement.fontFamily` holds a font-ASSET GUID (#231) but is consumed as a DOM
 *  `font-family` string, so the UI tree (L2 `ui/`) has to resolve a manifest ref — something
 *  only L3 `loaders/` can do. Same shape as `textureProvider`: the subsystem calls the seam,
 *  `loaders/registerProviders.ts` installs the implementation.
 *
 *  Deliberately NOT part of `textureProvider`: one slot per TYPE flowing through it
 *  (providerSlot.ts), and a CSS family name is not a texture. */

import { createProviderSlot } from './providerSlot';

export interface DomFontProvider {
  /** A font-asset GUID → the CSS family name its file registers under
   *  (`fontFamilyFromPath`), or `undefined` when the GUID resolves to nothing. */
  familyForGuid(guid: string): string | undefined;
}

export const domFontProvider = createProviderSlot<DomFontProvider>('domFontProvider');
