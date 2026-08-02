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
  type ProjectConfigIssue,
  type ProjectUserConfig,
  type RawProjectConfig,
} from '../project-config';

/** Thrown by the raw readers when a config file EXISTS but does not parse. The
 *  loaders treat that as "use defaults" and carry on, which is right for reading —
 *  but a WRITE must not: the raw read is the base a patch merges onto, so treating
 *  a malformed file as `{}` would quietly replace the author's whole config with
 *  whatever section they happened to be editing. These files are committed JSON a
 *  human edits by hand, so a typo + a later Save is a real path to losing it. */
export class MalformedProjectConfigError extends Error {
  // Explicit fields, not constructor parameter properties — the build runs with
  // `erasableSyntaxOnly`, which rejects those.
  readonly file: string;
  readonly detail: unknown;
  constructor(file: string, detail: unknown) {
    super(`${path.basename(file)} exists but is not valid JSON (${String(detail)}). ` +
      'Fix the file by hand — refusing to save, because saving would overwrite it.');
    this.name = 'MalformedProjectConfigError';
    this.file = file;
    this.detail = detail;
  }
}

/** Read a config file as RAW parsed JSON — the subset the project actually
 *  recorded, NOT merged over the defaults. This is what a write-time merge must
 *  start from, so an edit that omits a section leaves that section as the file had
 *  it (absent stays absent) instead of resurrecting it as a default.
 *
 *  A MISSING file is `{}` (a project that never had one). A file that exists but is
 *  malformed THROWS — see {@link MalformedProjectConfigError}. */
function readRawConfig(root: string, filename: string): RawProjectConfig {
  const file = path.join(root, filename);
  if (!fs.existsSync(file)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new MalformedProjectConfigError(file, e);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new MalformedProjectConfigError(file, 'top-level value is not a JSON object');
  }
  return parsed as RawProjectConfig;
}

/** Raw (unmerged) <root>/project.config.json — see {@link readRawConfig}. Throws
 *  {@link MalformedProjectConfigError} if the file exists but does not parse. */
export function readRawProjectConfig(root: string = process.cwd()): RawProjectConfig {
  return readRawConfig(root, PROJECT_CONFIG_FILENAME);
}

/** Raw (unmerged) <root>/project.user.json — see {@link readRawProjectConfig}. */
export function readRawProjectUserConfig(root: string = process.cwd()): RawProjectConfig {
  return readRawConfig(root, PROJECT_USER_CONFIG_FILENAME);
}

/** Which of the two config files EXIST but do not parse, as display-ready
 *  messages. Empty = both are fine (or absent, which is fine too).
 *
 *  This exists because the read and write paths disagree ON PURPOSE — reading a
 *  malformed file falls back to the defaults so the editor still opens, while
 *  writing refuses (see {@link MalformedProjectConfigError}). Individually right;
 *  together they hand the Project Settings dialog a screen full of engine defaults
 *  that LOOK like the project's values (measured on games/sling: Bundle ID read
 *  `com.modokiengine.prototype`, the retired pre-#29 shared identity). The save
 *  refusal protects the file, but only once you press Apply — someone can read
 *  those fields, believe them, and act on them without ever saving. So the READ
 *  path has to say it fell back, which is what this reports. */
export function readProjectConfigParseErrors(root: string = process.cwd()): { file: string; message: string }[] {
  const errors: { file: string; message: string }[] = [];
  for (const [filename, read] of [
    [PROJECT_CONFIG_FILENAME, readRawProjectConfig],
    [PROJECT_USER_CONFIG_FILENAME, readRawProjectUserConfig],
  ] as const) {
    try {
      read(root);
    } catch (e) {
      if (e instanceof MalformedProjectConfigError) errors.push({ file: filename, message: e.message });
      else throw e;
    }
  }
  return errors;
}

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

/**
 * Out-of-union values in `<root>/project.config.json`, as build-blocking error strings (#39).
 *
 * Why this exists as a SEPARATE pass from `validateBuildConfig`: that function receives the
 * already-RESOLVED config, and resolution has by then coerced every bad value to its default —
 * so the offending value is simply not there to complain about. The only way to report it is to
 * re-resolve from the raw file with an issue collector attached, which is what this does.
 *
 * Load stays forgiving on purpose (coerce + warn) so a typo cannot make a project un-openable in
 * the editor; the BUILD is where it becomes fatal. That split is the point: the failure mode this
 * closes is a `capacitor.orientation` typo shipping rotation unlocked to the store, and the build
 * is the last moment anyone can catch it. Owner's call, #39.
 */
export function projectConfigUnionErrors(root: string = process.cwd()): string[] {
  const file = path.join(root, PROJECT_CONFIG_FILENAME);
  let raw: unknown;
  try {
    if (!fs.existsSync(file)) return [];
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // An unparseable file is not THIS check's business — loadProjectConfig already warns and
    // falls back, and reporting it here would duplicate that as a build error with worse wording.
    return [];
  }
  const issues: ProjectConfigIssue[] = [];
  mergeProjectConfig(raw as Partial<ProjectConfig>, { issues });
  return issues.map((i) => `${i.path} is ${JSON.stringify(i.value)} — must be one of `
    + `${i.allowed.map((a) => JSON.stringify(a)).join(' | ')}`);
}

/** Write the config to <root>/project.config.json as pretty JSON. Takes a PARTIAL
 *  (pruned) config on purpose — the file records only what the project chose; see
 *  the file-stays-minimal invariant in project-config.ts. */
export function writeProjectConfig(config: RawProjectConfig | ProjectConfig, root: string = process.cwd()): void {
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

/** Write the per-machine settings to <root>/project.user.json. Partial, same
 *  rationale as {@link writeProjectConfig}. */
export function writeProjectUserConfig(user: RawProjectConfig | ProjectUserConfig, root: string = process.cwd()): void {
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
