/** Guard: `dev:stop` must not kill the Vite the Electron editor owns (#129).
 *
 *  `stopDevServer.mjs` has always DOCUMENTED this carve-out ("The Electron editor owns the
 *  Vite it spawned and stops it on quit — quit the editor to stop that one") while doing the
 *  opposite: the editor spawns `$REPO/node_modules/vite/bin/vite.js`, the exact path the
 *  reap matches, so every `npm run dev:stop` killed the editor's dev server and printed
 *  `Done.` The editor stayed up with a dead server behind it — which presents as "the app is
 *  broken" rather than "something was stopped", and once read as a game bug.
 *
 *  The discriminator is `--configLoader runner`, a flag `devServer.ts` passes and a plain
 *  `npm run dev` does not. That is a coupling ACROSS two files with nothing else linking
 *  them: if devServer.ts ever drops the flag (it exists for a packaging reason — a read-only
 *  install must not have a bundled config written into its tree — not for this one), the
 *  carve-out silently stops matching and the bug returns with no test failing. Hence this. */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO = path.resolve(__dirname, '../../..');
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf8');

describe('dev:stop leaves the editor-owned Vite alone (#129)', () => {
  it('the editor still spawns Vite with the flag stopDevServer uses to identify it', () => {
    const devServer = read('engine/electron/devServer.ts');
    expect(
      devServer,
      'devServer.ts no longer passes `--configLoader runner`, which is what stopDevServer.mjs '
        + 'uses to tell the editor-owned Vite from the one `npm run dev` starts. Without it, '
        + '`npm run dev:stop` goes back to killing a running editor\'s dev server (#129). Update '
        + 'BOTH files together, or find another discriminator.',
    ).toMatch(/'--configLoader',\s*'runner'/);
  });

  it('stopDevServer.mjs actually tests for that flag before reaping', () => {
    const stop = read('engine/scripts/stopDevServer.mjs');
    expect(stop).toMatch(/--configloader[= ]runner/i);
    // The carve-out must EXCLUDE those pids from the kill list, not merely mention them.
    expect(
      /editorOwned/.test(stop) && /targets\s*=\s*mine\.filter/.test(stop),
      'stopDevServer.mjs mentions the flag but no longer filters the editor-owned processes '
        + 'out of its kill list',
    ).toBe(true);
  });

  it('`npm run dev` stays a bare vite invocation, so the flag keeps discriminating', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(
      pkg.scripts.dev,
      "`npm run dev` gained a --configLoader flag — it would now look editor-owned to dev:stop, "
        + 'which would then refuse to stop the very server it exists to stop.',
    ).not.toMatch(/configLoader/);
  });

  it('there is a scripted way to stop a launched editor', () => {
    // The other half of #129: `launch-editor.sh` had no counterpart, and the backend port that
    // MODOKI_BACKEND advertises has no /api/exit (that route is on the VITE port), so the only
    // stop was `kill <pid>` by hand.
    expect(fs.existsSync(path.join(REPO, 'engine/scripts/stop-editor.sh'))).toBe(true);
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts['editor:stop']).toBeTruthy();
  });
});
