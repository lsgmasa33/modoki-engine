/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * electron-builder afterAllArtifactBuild hook (ELECTRON_PLAN Phase 7) — notarize +
 * staple the .dmg *container* so it validates offline on first open. The afterSign
 * hook (scripts/notarize.cjs) already notarized + stapled the .app inside; this is
 * a second submission for the dmg artifact itself (notarization tickets are
 * per-artifact-hash, so the dmg needs its own). The .zip (auto-update) carries the
 * already-stapled app, so it needs no separate pass.
 *
 * Same credential paths as the afterSign hook (App Store Connect API key OR
 * app-specific password). No creds ⇒ skip (unsigned/dev builds still work).
 * macOS-only.
 */

const { execFileSync } = require('child_process');

module.exports = async function stapleDmg(context) {
  if (process.platform !== 'darwin') return;

  const env = process.env;
  const hasApiKey = env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER;
  const hasPassword = env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID;
  if (!hasApiKey && !hasPassword) {
    console.log('[staple-dmg] skipped — no Apple credentials in env.');
    return;
  }

  const dmgs = (context.artifactPaths || []).filter((p) => p.endsWith('.dmg'));
  if (!dmgs.length) return;

  const cred = hasApiKey
    ? ['--key', env.APPLE_API_KEY, '--key-id', env.APPLE_API_KEY_ID, '--issuer', env.APPLE_API_ISSUER]
    : ['--apple-id', env.APPLE_ID, '--password', env.APPLE_APP_SPECIFIC_PASSWORD, '--team-id', env.APPLE_TEAM_ID];

  for (const dmg of dmgs) {
    console.log(`[staple-dmg] notarizing ${dmg} (${hasApiKey ? 'API key' : 'app-specific password'}) …`);
    execFileSync('xcrun', ['notarytool', 'submit', dmg, '--wait', '--output-format', 'json', ...cred], { stdio: 'inherit' });
    console.log(`[staple-dmg] stapling ${dmg} …`);
    execFileSync('xcrun', ['stapler', 'staple', dmg], { stdio: 'inherit' });
    console.log(`[staple-dmg] ${dmg} stapled.`);
  }
};
