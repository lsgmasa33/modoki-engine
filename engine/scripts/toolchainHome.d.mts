/** Type sidecar for toolchainHome.mjs — see engine/tests/architecture/mjsTypeSidecars.test.ts.
 *  The export SET here is guarded against the implementation; keep them in step. */

/** The OS "application support" root Electron puts userData dirs under.
 *
 *  ⚠️ Pure/platform-injectable, and the three branches do NOT read the same inputs: win32 honours
 *  `APPDATA`, linux honours `XDG_CONFIG_HOME`, **darwin honours neither** and derives from `home`
 *  alone. The parameters exist so that asymmetry is pinnable from any platform — the darwin branch
 *  is the one no leg this repo runs would otherwise execute. */
export declare function appSupportRoot(
  platform?: NodeJS.Platform,
  env?: NodeJS.ProcessEnv,
  home?: string,
): string;

/** `engine/electron/userDataDir.ts`'s SHARED_DIR — the machine-level root the provisioned Build
 *  Support toolchain lives under, shared by every clone rather than per-app. */
export declare const SHARED_DIR: 'Modoki';

/** The toolchain dir when `MODOKI_TOOLCHAIN_DIR` is unset — where the Electron editor provisions.
 *  A conversion resolves its pinned ffmpeg/ffprobe under it (#1297). */
export declare function defaultToolchainDir(): string;
