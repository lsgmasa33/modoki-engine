/** Types for `androidSplashTheme.mjs` — the module is plain Node (the icon wrapper script cannot
 *  import TypeScript), so its shape is declared here for the TS consumers that import it. */

export declare function splashEdgeColour(srcPath: string, ringFrac?: number): Promise<string>;
export declare function withSplashTheme(xml: string, colour: string): string;
export declare function applyAndroidSplashTheme(opts: {
  projectRoot: string;
  splashSrcAbs?: string;
}): Promise<{ changed: boolean; colour: string | null; notes: string[] }>;
