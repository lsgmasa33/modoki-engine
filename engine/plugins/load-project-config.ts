/** Node-side reader for project.config.json + project.user.json. Kept separate
 *  from project-config.ts so the pure type/defaults stay free of Node imports
 *  (browser-safe). */

import fs from 'fs';
import path from 'path';
import {
  mergeProjectConfig,
  mergeProjectUserConfig,
  PROJECT_CONFIG_FILENAME,
  PROJECT_USER_CONFIG_FILENAME,
  type ProjectConfig,
  type ProjectUserConfig,
} from '../project-config';

/** Read <root>/project.config.json and merge it over the defaults. A missing
 *  file or unparseable JSON falls back to the defaults. */
export function loadProjectConfig(root: string = process.cwd()): ProjectConfig {
  const file = path.join(root, PROJECT_CONFIG_FILENAME);
  try {
    if (fs.existsSync(file)) {
      return mergeProjectConfig(JSON.parse(fs.readFileSync(file, 'utf8')));
    }
  } catch (e) {
    console.warn(`[project-config] Failed to read ${file}, using defaults:`, e);
  }
  return mergeProjectConfig(null);
}

/** Write the config to <root>/project.config.json as pretty JSON. */
export function writeProjectConfig(config: ProjectConfig, root: string = process.cwd()): void {
  const file = path.join(root, PROJECT_CONFIG_FILENAME);
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
}

/** Read <root>/project.user.json (gitignored, per-machine) merged over defaults.
 *  Missing/unparseable → defaults (which mirror the repo owner's machine so a
 *  build works out of the box). */
export function loadProjectUserConfig(root: string = process.cwd()): ProjectUserConfig {
  const file = path.join(root, PROJECT_USER_CONFIG_FILENAME);
  try {
    if (fs.existsSync(file)) {
      return mergeProjectUserConfig(JSON.parse(fs.readFileSync(file, 'utf8')));
    }
  } catch (e) {
    console.warn(`[project-config] Failed to read ${file}, using defaults:`, e);
  }
  return mergeProjectUserConfig(null);
}

/** Write the per-machine settings to <root>/project.user.json. */
export function writeProjectUserConfig(user: ProjectUserConfig, root: string = process.cwd()): void {
  const file = path.join(root, PROJECT_USER_CONFIG_FILENAME);
  fs.writeFileSync(file, JSON.stringify(user, null, 2) + '\n');
}

/** Allowlist rules for the values that get interpolated into build shell
 *  commands (see the /api/build handler). These are spawned via `bash -c`, so an
 *  unsanitized value like `gs://x; rm -rf ~` would execute. Conservative patterns
 *  reject shell metacharacters while permitting the real shape of each field
 *  (UDIDs, adb serials, gs:// URIs, filesystem paths).
 *
 *  `source` selects which object the dot-path reads from: the committed config or
 *  the per-machine user config. NOTE: `build.webDeployCommand` is intentionally
 *  absent — it is a full shell command the project author wrote, so it needs
 *  metacharacters and is trusted like the user's own terminal. */
const BUILD_FIELD_RULES: { key: string; label: string; pattern: RegExp; allowEmpty: boolean; source: 'config' | 'user' }[] = [
  { key: 'app.appId',                 label: 'Bundle ID',              pattern: /^[A-Za-z0-9._-]+$/,          allowEmpty: false, source: 'config' },
  { key: 'build.appleTeamId',         label: 'Apple Team ID',          pattern: /^[A-Za-z0-9]+$/,             allowEmpty: true,  source: 'config' },
  { key: 'build.webBucket',           label: 'Web GCS bucket',         pattern: /^gs:\/\/[A-Za-z0-9._\-/]+$/, allowEmpty: true,  source: 'config' },
  { key: 'build.webBasePath',         label: 'Web base path',          pattern: /^[A-Za-z0-9._\-/]*$/,        allowEmpty: true,  source: 'config' },
  { key: 'build.webCdnUrlMap',        label: 'Web CDN url-map',        pattern: /^[A-Za-z0-9-]*$/,            allowEmpty: true,  source: 'config' },
  { key: 'build.webCdnBackendBucket', label: 'Web CDN backend-bucket', pattern: /^[A-Za-z0-9-]*$/,            allowEmpty: true,  source: 'config' },
  { key: 'device.iosDeviceId',        label: 'iOS device UDID',        pattern: /^[A-Za-z0-9-]+$/,            allowEmpty: true,  source: 'user' },
  { key: 'device.iosDevicectlId',     label: 'iOS devicectl id',       pattern: /^[A-Za-z0-9-]+$/,            allowEmpty: true,  source: 'user' },
  { key: 'device.androidDeviceId',    label: 'Android serial',         pattern: /^[A-Za-z0-9._:-]+$/,         allowEmpty: true,  source: 'user' },
  { key: 'sdk.javaHome',              label: 'JAVA_HOME',              pattern: /^[A-Za-z0-9 ._@\-/]*$/,      allowEmpty: true,  source: 'user' },
  { key: 'sdk.androidHome',           label: 'ANDROID_HOME',           pattern: /^[A-Za-z0-9 ._@\-/]*$/,      allowEmpty: true,  source: 'user' },
  { key: 'sdk.gcloudPath',            label: 'gcloud path',            pattern: /^[A-Za-z0-9 ._@\-/]*$/,      allowEmpty: true,  source: 'user' },
];

/** Validate the shell-interpolated build fields (across BOTH the committed config
 *  and the per-machine user config) against {@link BUILD_FIELD_RULES}. Returns a
 *  list of human-readable error messages (empty = valid). Call before
 *  constructing or persisting build commands. */
export function validateBuildConfig(config: ProjectConfig, user: ProjectUserConfig): string[] {
  const errors: string[] = [];
  const read = (obj: unknown, k: string): unknown =>
    k.split('.').reduce<unknown>((o, p) => (o == null ? undefined : (o as Record<string, unknown>)[p]), obj);
  for (const rule of BUILD_FIELD_RULES) {
    const v = read(rule.source === 'user' ? user : config, rule.key);
    const s = v == null ? '' : String(v);
    if (s === '') {
      if (!rule.allowEmpty) errors.push(`${rule.label} (${rule.key}) is required`);
      continue;
    }
    if (!rule.pattern.test(s)) {
      errors.push(`${rule.label} (${rule.key}) contains invalid characters: ${JSON.stringify(s)}`);
    }
  }
  return errors;
}
