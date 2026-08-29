/** Types for `iconAssets.mjs` — the module is plain Node (the icon wrapper script cannot
 *  import TypeScript), so its shape is declared here for the TS consumers that re-export it. */
export declare const ICON_TOOL: string;
export declare const ICON_COLORS: string;
export declare function iconColorArgs(): string[];
/** PNG options for every image the repo generates AND commits — see the .mjs for the
 *  measurements. Lossless; sharp's defaults optimise for encode speed, which is the wrong trade
 *  for a binary carried in git and in every app bundle. */
export declare const GENERATED_PNG: { compressionLevel: number; effort: number };
