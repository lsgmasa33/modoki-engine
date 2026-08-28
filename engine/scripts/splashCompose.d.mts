/** Types for `splashCompose.mjs` — the module is plain Node (the icon wrapper script cannot
 *  import TypeScript), so its shape is declared here for the TS consumers that import it. */

import type { SafeBox } from './splashLayout.d.mts';

export interface OverlayOptions {
  orientation?: string;
  titleSrc?: string;
  titleWidthPct?: number;
  titleOffsetPct?: number;
  badge?: boolean;
  badgeLightArt?: string;
  badgeDarkArt?: string;
}

export declare function splashOutputs(projectRoot: string, platform: 'ios' | 'android'): string[];

export declare function overlayLayersFor(
  opts: OverlayOptions & {
    base: string | Buffer;
    width: number;
    height: number;
  },
): Promise<{ layers: { input: Buffer; left: number; top: number }[]; clamped: string[] }>;

export declare function composeWebSplash(
  opts: OverlayOptions & { srcPath: string; size?: number },
): Promise<{ buffer: Buffer; clamped: string[] }>;

export interface SplashComposeReport {
  files: number;
  title: number;
  badge: number;
  clamped: string[];
  bytesSaved: number;
}

export declare function composeSplashOverlays(
  opts: OverlayOptions & {
    projectRoot: string;
    platform: 'ios' | 'android';
    optimise?: boolean;
  },
): Promise<SplashComposeReport>;

export type { SafeBox };
