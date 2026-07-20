/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * electron-builder afterSign hook (ELECTRON_PLAN Phase 7). Notarizes + staples
 * the macOS app ONLY when Apple credentials are present — so a local, unsigned
 * `--dir` / dmg build still runs with no Apple Developer account.
 *
 * Two credential paths (either one enables notarization):
 *   A. App-specific password:  APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID
 *   B. App Store Connect API key:  APPLE_API_KEY (path to .p8) + APPLE_API_KEY_ID + APPLE_API_ISSUER
 * Install the peer once: `npm i -D @electron/notarize`.
 *
 * Code SIGNING itself is handled by electron-builder automatically when a
 * "Developer ID Application" cert is in the keychain (this hook runs after it).
 */

const { execFileSync } = require('child_process');

exports.default = async function notarize(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') return;

  const env = process.env;
  const hasPassword = env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID;
  const hasApiKey = env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER;
  if (!hasPassword && !hasApiKey) {
    console.log('[notarize] skipped — no Apple credentials in env (unsigned build). ' +
      'Set APPLE_ID+APPLE_APP_SPECIFIC_PASSWORD+APPLE_TEAM_ID or APPLE_API_KEY+APPLE_API_KEY_ID+APPLE_API_ISSUER to enable.');
    return;
  }

  let notarize;
  try { ({ notarize } = require('@electron/notarize')); }
  catch {
    console.warn('[notarize] @electron/notarize not installed — run `npm i -D @electron/notarize`. Skipping.');
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;
  const opts = hasApiKey
    ? { appPath, appleApiKey: env.APPLE_API_KEY, appleApiKeyId: env.APPLE_API_KEY_ID, appleApiIssuer: env.APPLE_API_ISSUER }
    : { appPath, appleId: env.APPLE_ID, appleIdPassword: env.APPLE_APP_SPECIFIC_PASSWORD, teamId: env.APPLE_TEAM_ID };

  console.log(`[notarize] notarizing ${appPath} (${hasApiKey ? 'API key' : 'app-specific password'}) …`);
  await notarize({ tool: 'notarytool', appBundleId: context.packager.appInfo.id, ...opts });

  // Staple the ticket so the app validates offline (the dmg/zip is built AFTER
  // this hook, so it picks up the stapled .app).
  console.log('[notarize] stapling …');
  execFileSync('xcrun', ['stapler', 'staple', appPath], { stdio: 'inherit' });
  console.log('[notarize] done.');
};
