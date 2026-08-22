/** Type sidecar for `viteConfigChoice.mjs` — see that file for the design rationale.
 *  Hand-written because the module is plain JS (`build-web.mjs` is a Node script that
 *  cannot import TypeScript), while `engine/tests/plugins/packagedViteConfig.test.ts`
 *  imports it and is typechecked via `engine/tsconfig.test.json`. */

/** Is this `engine/` directory inside a packaged app? Path marker OR `MODOKI_PACKAGED`. */
export declare function isPackagedEngineDir(
  engineDir: string,
  env?: NodeJS.ProcessEnv,
): boolean;

/** Which Vite config to pass to `vite build`, as a REPO-RELATIVE path. The packaged CJS copy
 *  when packaged and staged (its loader branch never writes inside the signed bundle), else the
 *  `.ts` source — warning loudly if packaged and the copy is missing. */
export declare function chooseViteConfig(
  engineDir: string,
  exists?: (p: string) => boolean,
  env?: NodeJS.ProcessEnv,
  warn?: (m: string) => void,
): string;
