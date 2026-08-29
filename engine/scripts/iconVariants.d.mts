/** Types for `iconVariants.mjs` — the module is plain Node (the icon wrapper script cannot
 *  import TypeScript), so its shape is declared here for the TS consumers that import it. */

export declare const IOS_DARK_FILE: string;
export declare const IOS_TINTED_FILE: string;
export declare const ANDROID_MONOCHROME_FILE: string;

export interface VariantResult {
  /** Paths written, relative to the platform's product directory. */
  written: string[];
  /** Human-readable notes the caller logs — a missing override, an absent platform. */
  notes: string[];
}

export declare function withMonochromeLayer(xml: string, drawable?: string, inset?: string): string;

export declare function writeIosIconVariants(opts: {
  projectRoot: string;
  iconSrcAbs: string;
  darkSrcAbs?: string;
  tintedSrcAbs?: string;
  darkHex?: string;
}): Promise<VariantResult>;

export declare function writeAndroidIconVariants(opts: {
  projectRoot: string;
  iconSrcAbs: string;
  monochromeSrcAbs?: string;
}): Promise<VariantResult>;
