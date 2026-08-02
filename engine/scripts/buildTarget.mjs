/** Pure `--target` parsing for engine/scripts/build-web.mjs, split out so it's unit-testable
 *  without spawning a subprocess (engine/tests/plugins/buildTargetParse.test.ts).
 *
 *  `--target` is REQUIRED, with NO default in either direction (#40). A `web` build and a
 *  `native` build need OPPOSITE base paths from this same script — sub-path hosting vs. the
 *  app root Capacitor serves from (see vite.config.ts's `resolvedBase`) — so defaulting to
 *  EITHER would be silently wrong for the other caller. Every caller must say which it wants. */

export const VALID_TARGETS = ['web', 'native', 'playable'];

/** Parse `argv` (already sliced past `node script.mjs`) + `env` into a build target decision.
 *  Pure — no process access, no I/O. Returns `{ ok: true, target, childEnv }` on success or
 *  `{ ok: false, message }` (the full text to print to stderr) on failure. `childEnv` is the
 *  env ADDITIONS the caller must merge into the child process env: always `MODOKI_BUILD_TARGET`,
 *  plus `VITE_PLAYABLE: '1'` when target is 'playable'. */
export function parseBuildTarget(argv, env) {
  const usage = `[build-web] --target is required (web | native | playable).
  web       honors build.webBasePath from project.config.json (sub-path hosting)
  native    base "/" — the dist that \`cap sync\` copies into an iOS/Android app
  playable  single self-contained HTML for an ad network

  e.g.  MODOKI_PROJECT=games/sling npm run build -- --target web`;

  let target;
  let sawFlag = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--target') {
      sawFlag = true;
      const next = argv[i + 1];
      // F2: a bare `--target` (last arg, or immediately followed by another flag) must be an
      // ERROR, not a silent fallback to MODOKI_BUILD_TARGET — otherwise a typo'd command can
      // build with a target the user never typed, the same silent-wrong-target class #40 exists
      // to eliminate.
      if (next === undefined || next.startsWith('--')) {
        return { ok: false, message: `[build-web] --target was given with no value.\n${usage}` };
      }
      target = next;
      break;
    }
    if (arg.startsWith('--target=')) {
      sawFlag = true;
      target = arg.slice('--target='.length);
      break;
    }
  }
  if (!sawFlag) target = env.MODOKI_BUILD_TARGET; // fallback for callers that can't pass argv

  if (!VALID_TARGETS.includes(target)) {
    return { ok: false, message: usage };
  }

  // F1: mirrors vite.config.ts:226's authoritative check (`process.env.VITE_PLAYABLE === '1'`)
  // exactly — a truthy check here (the old bug) treated `VITE_PLAYABLE=0` as "on" and hard-failed
  // a legitimate `--target web` build even though vite itself reads `0` as off.
  if (env.VITE_PLAYABLE === '1' && target !== 'playable') {
    return {
      ok: false,
      message: `[build-web] VITE_PLAYABLE is set but --target is '${target}' — these contradict. Use --target playable for a playable-ad build.`,
    };
  }

  const childEnv = { MODOKI_BUILD_TARGET: target };
  if (target === 'playable') childEnv.VITE_PLAYABLE = '1';

  return { ok: true, target, childEnv };
}
