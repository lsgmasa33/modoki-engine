/** Guard (#1267): every project that uses the engine's cloud sync turns Android backup OFF.
 *
 *  Android Auto Backup copies an app's data to the player's Google Drive about once a day and puts
 *  it back when the app is installed again, or onto a new phone. For a game with cloud save that
 *  restored copy is a STALE SAVE. Measured on Weaveling (Galaxy A23, 2026-09-15, #679): a reinstall
 *  logged `restoreFinished` two seconds after install with a days-old save, and the sign-in that
 *  followed asked "Two saves" between it and the real cloud progress — where "Keep this device"
 *  replaces the real progress. A backup can also bring back a save the player deleted with their
 *  account. Owner ruling for both shipping games: "turn it off". A signed-in player gets everything
 *  back from the cloud save; one who never signs in starts blank, as on iOS.
 *
 *  Why an ENGINE test rather than one per game: Weaveling and Court each needed the identical
 *  manifest change, and the symptom needs a real reinstall on a phone holding a Google backup — no
 *  off-device test can see it. So the population is DERIVED from who uses the sync surface, and a
 *  third game adopting cloud sync goes red here until its manifest is fixed, instead of shipping the
 *  Android default (`allowBackup="true"`, what every `cap add android` writes).
 *
 *  "Uses" means the project's shipped source NAMES a sync value (an identifier node, so comments and
 *  strings don't count) — deliberately not "imports it from `@modoki/engine`". The first cut matched
 *  plain `import` edges only and missed a named re-export, a destructured `await import()` and a game
 *  barrel (close-out review, probed). The first two keep the engine specifier in the same file; the
 *  barrel does not — `export * from '@modoki/engine/runtime'` in one file, `runCloudSync` called in
 *  another that imports `./barrel` — so no per-file edge reading can see it, and a name reading can.
 *  No other project names a sync value today (`git grep -w` over games/ + demos/, 2026-09-15), but a
 *  game CAN declare its own function with a sync name (Court's `saveSync.ts` has a local
 *  `neverSynced` and `hasLocalWrites`). A collision in a game that does not sync fails LOUD, and the
 *  right fix there is to RENAME the local, not to turn backup off — the failure message says so.
 *
 *  What a compliant project carries, each half load-bearing:
 *  - `allowBackup="false"` + `fullBackupContent="false"` — cloud backup off.
 *  - `dataExtractionRules` excluding every domain from BOTH `<cloud-backup>` and `<device-transfer>`:
 *    for an app targeting Android 12+, `allowBackup="false"` does NOT stop device-to-device transfer.
 *  - `tools:replace` naming all three: a library in the graph (AppsFlyer) declares its own, and the
 *    manifest merge FAILS without it (`processDebugMainManifest`, measured on Weaveling). `verify`
 *    builds no APK, so nothing else sees that before a native build does.
 *
 *  Layouts: the public snapshot ships no `games/` and deletes every demo's `android/`, so the
 *  population is empty there and only the detector/checker units run. Court and Weaveling are the
 *  accept-side samples wherever they exist.
 */
import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { readScannedSource } from '@modoki/engine/testing';
import { importsIn, parseSource, findNodes, ts } from '@modoki/engine/testing/sourceAst';
import { repoFiles } from '../../scripts/repoCorpus.mjs';
import { PROJECT_ROOT_DIRS } from '../../scripts/projectRoots.mjs';
import { hasInternalGames } from '../helpers/repoLayout';

const repoRoot = path.resolve(__dirname, '../../..');
const SYNC_INDEX = 'engine/packages/modoki/src/runtime/sync/index.ts';
const MANIFEST = 'android/app/src/main/AndroidManifest.xml';
const DOMAINS = ['root', 'file', 'database', 'sharedpref', 'external'] as const;
const SECTIONS = ['cloud-backup', 'device-transfer'] as const;
const REPLACED = ['android:allowBackup', 'android:fullBackupContent', 'android:dataExtractionRules'] as const;

/** The sync module's VALUE exports, read from its barrel — derived, so a new export joins without an edit here. */
function syncSurface(): Set<string> {
  const code = readScannedSource(path.join(repoRoot, SYNC_INDEX)).code;
  return new Set(importsIn(parseSource(code, SYNC_INDEX))
    .filter((e) => e.kind === 'reexport')
    .flatMap((e) => e.bindings.filter((b) => !b.typeOnly).map((b) => b.local)));
}

/** Does this source NAME a sync value — as an identifier or property name, however it was reached? (See the header.) */
function usesCloudSync(code: string, label: string, surface: ReadonlySet<string>): boolean {
  return findNodes(parseSource(code, label), ts.isIdentifier).some((id) => surface.has(id.text));
}

const stripXmlComments = (xml: string) => xml.replace(/<!--[\s\S]*?-->/g, '');
const attrsOf = (tag: string) => new Map([...tag.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)].map((m) => [m[1], m[2]]));

/** Every reason this manifest (and the rules file it names) does NOT keep backup off. Empty = compliant. */
function backupViolations(manifestXml: string, readXmlResource: (name: string) => string | undefined): string[] {
  const out: string[] = [];
  const xml = stripXmlComments(manifestXml);
  const root = xml.match(/<manifest\b[^>]*>/)?.[0];
  const apps = [...xml.matchAll(/<application\b[^>]*>/g)].map((m) => m[0]);
  if (!root || apps.length === 0) return ['no <manifest>/<application> tag'];
  if (apps.length > 1) return [`${apps.length} <application> tags — expected one`];
  const app = apps[0];
  if (attrsOf(root).get('xmlns:tools') !== 'http://schemas.android.com/tools') out.push('<manifest> does not declare xmlns:tools');
  const a = attrsOf(app);
  if (a.get('android:allowBackup') !== 'false') out.push('android:allowBackup is not "false"');
  if (a.get('android:fullBackupContent') !== 'false') out.push('android:fullBackupContent is not "false"');
  const replaced = (a.get('tools:replace') ?? '').split(',').map((s) => s.trim());
  for (const attr of REPLACED) if (!replaced.includes(attr)) out.push(`tools:replace does not name ${attr}`);
  const ref = a.get('android:dataExtractionRules')?.match(/^@xml\/(\w+)$/)?.[1];
  if (!ref) return [...out, 'android:dataExtractionRules does not name an @xml resource'];
  const rulesRaw = readXmlResource(ref);
  if (rulesRaw === undefined) return [...out, `res/xml/${ref}.xml does not exist`];
  const rules = stripXmlComments(rulesRaw);
  if (/<include\b/.test(rules)) out.push('the rules file has an <include>');
  // A self-closing section opens a match the section regex below would run on to the NEXT closing tag,
  // borrowing another section's excludes (review-probed: `<device-transfer/><cloud-backup>…` passed).
  if (/<(cloud-backup|device-transfer)\b[^>]*\/>/.test(rules)) out.push('the rules file has a self-closing <cloud-backup/> or <device-transfer/>');
  for (const section of SECTIONS) {
    const bodies = [...rules.matchAll(new RegExp(`<${section}\\b[^>]*>([\\s\\S]*?)</${section}>`, 'g'))].map((m) => m[1]);
    if (bodies.length === 0) { out.push(`<${section}> is missing`); continue; }
    if (bodies.length > 1) { out.push(`${bodies.length} <${section}> sections — expected one`); continue; }
    const body = bodies[0];
    const excluded = new Set([...body.matchAll(/<exclude\b[^>]*>/g)]
      .map((m) => attrsOf(m[0])).filter((x) => x.get('path') === '.').map((x) => x.get('domain')));
    for (const d of DOMAINS) if (!excluded.has(d)) out.push(`<${section}> does not exclude domain "${d}"`);
  }
  return out;
}

/** Project dirs (`games/court`) whose shipped source imports the sync surface. Tests don't count — a test may drive the engine without the game syncing. */
function cloudSyncProjects(surface: ReadonlySet<string>): string[] {
  const files = repoFiles({
    under: [...PROJECT_ROOT_DIRS],
    match: /\.(tsx?|mts|cts|jsx?|mjs|cjs)$/,
    exclude: ['node_modules', 'dist', 'tests', 'android', 'ios'],
    floor: 0,
  });
  const projects = new Set<string>();
  for (const { rel, abs } of files) {
    if (/\.test\.[cm]?[jt]sx?$/.test(rel) || /\.d\.[cm]?ts$/.test(rel)) continue;
    const project = rel.split('/').slice(0, 2).join('/');
    if (projects.has(project)) continue;
    if (usesCloudSync(readScannedSource(abs).code, rel, surface)) projects.add(project);
  }
  return [...projects].sort();
}

describe('usesCloudSync — the population detector', () => {
  const surface = new Set(['runCloudSync', 'defineSyncGroup']);
  const yes = (code: string) => expect(usesCloudSync(code, 'x.ts', surface), code).toBe(true);
  const no = (code: string) => expect(usesCloudSync(code, 'x.ts', surface), code).toBe(false);

  it('accepts every way a file reaches a sync value, including the ones that hide the engine specifier', () => {
    yes(`import { runCloudSync } from '@modoki/engine/runtime';`);
    yes(`import {\n  foo,\n  defineSyncGroup as group,\n} from "@modoki/engine/runtime/sync";`);
    yes(`import * as eng from '@modoki/engine/runtime';\nawait eng.runCloudSync(a, b);`);
    yes(`export { runCloudSync } from '@modoki/engine/runtime';`); // a game barrel
    yes(`import { runCloudSync } from './barrel';\nrunCloudSync(a);`); // the barrel's consumer (the barrel is \`export *\`)
    yes(`const { runCloudSync } = await import('@modoki/engine/runtime');`);
  });

  it('rejects a comment, a string, or an unrelated name', () => {
    no(`// import { runCloudSync } from '@modoki/engine/runtime';`);
    no(`/** calls runCloudSync */ export const x = 1;`);
    no(`log('runCloudSync failed');`);
    no(`import { spawn } from '@modoki/engine/runtime';\nspawn(runCloudSyncLater);`);
    no(`export * from '@modoki/engine/runtime';`);
  });
});

describe('backupViolations — the manifest checker', () => {
  const MANIFEST_OK = `<?xml version="1.0"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:tools="http://schemas.android.com/tools">
  <application android:appCategory="game" android:allowBackup="false" android:fullBackupContent="false"
      android:dataExtractionRules="@xml/rules"
      tools:replace="android:allowBackup, android:fullBackupContent,android:dataExtractionRules">
  </application>
</manifest>`;
  const section = (name: string, domains: readonly string[] = DOMAINS) =>
    `<${name}>${domains.map((d) => `<exclude domain="${d}" path="." />`).join('')}</${name}>`;
  const RULES_OK = `<data-extraction-rules>${section('cloud-backup')}${section('device-transfer')}</data-extraction-rules>`;
  const check = (manifest: string, ...rules: [string | undefined] | []) =>
    backupViolations(manifest, (name) => (name === 'rules' ? (rules.length ? rules[0] : RULES_OK) : undefined));

  it('accepts the compliant shape', () => {
    expect(check(MANIFEST_OK)).toEqual([]);
  });

  it.each([
    ['allowBackup true', MANIFEST_OK.replace('allowBackup="false"', 'allowBackup="true"'), /allowBackup/],
    ['fullBackupContent absent', MANIFEST_OK.replace('android:fullBackupContent="false"', ''), /fullBackupContent/],
    ['xmlns:tools absent', MANIFEST_OK.replace('xmlns:tools="http://schemas.android.com/tools"', ''), /xmlns:tools/],
    ['tools:replace missing one', MANIFEST_OK.replace(', android:fullBackupContent', ''), /tools:replace does not name android:fullBackupContent/],
    ['no rules reference', MANIFEST_OK.replace('android:dataExtractionRules="@xml/rules"', ''), /dataExtractionRules/],
    ['a second <application> keeping backup on', MANIFEST_OK.replace('</manifest>', '<application android:allowBackup="true"></application></manifest>'), /2 <application> tags/],
    ['backup attrs only inside a comment', MANIFEST_OK.replace(/<application[^>]*>/, '<!-- $& --><application android:appCategory="game">'), /allowBackup/],
  ])('rejects a manifest with %s', (_label, manifest, reason) => {
    expect(check(manifest).join('\n')).toMatch(reason);
  });

  it.each([
    ['a missing rules file', undefined, /does not exist/],
    ['no device-transfer section', `<data-extraction-rules>${section('cloud-backup')}</data-extraction-rules>`, /<device-transfer> is missing/],
    ...SECTIONS.flatMap((s) => DOMAINS.map((d) => [
      `${s} keeping ${d}`,
      RULES_OK.replace(section(s), section(s, DOMAINS.filter((x) => x !== d))),
      new RegExp(`<${s}> does not exclude domain "${d}"`),
    ] as [string, string, RegExp])),
    ['an exclude only inside a comment', RULES_OK.replace('<exclude domain="root" path="." />', '<!-- <exclude domain="root" path="." /> -->'), /exclude domain "root"/],
    ['an exclude narrowed to a sub-path', RULES_OK.replace('<exclude domain="file" path="." />', '<exclude domain="file" path="cache" />'), /exclude domain "file"/],
    ['a self-closing section borrowing the next one\'s excludes', `<data-extraction-rules><device-transfer/>${section('cloud-backup')}<device-transfer></device-transfer></data-extraction-rules>`, /self-closing/],
    ['an include', RULES_OK.replace('</cloud-backup>', '<include domain="sharedpref" path="." /></cloud-backup>'), /has an <include>/],
    ['a second cloud-backup section that includes', RULES_OK.replace('</data-extraction-rules>', '<cloud-backup><include domain="sharedpref" path="." /></cloud-backup></data-extraction-rules>'), /2 <cloud-backup> sections/],
  ])('rejects rules with %s', (_label, rules, reason) => {
    expect(check(MANIFEST_OK, rules).join('\n')).toMatch(reason);
  });
});

describe('every cloud-sync project keeps Android backup off (#1267)', () => {
  const surface = syncSurface();
  const projects = cloudSyncProjects(surface);

  it('the sync surface is read from the barrel (independent sample)', () => {
    expect([...surface]).toEqual(expect.arrayContaining(['runCloudSync', 'runGroupSync', 'defineSyncGroup']));
  });

  // Accept side, from OUTSIDE the detector: both shipping games run cloud sync (Court #361, Weaveling #679).
  it.runIf(hasInternalGames())('games/court and games/wordweave are detected as cloud-sync projects (accept side)', () => {
    expect(projects).toEqual(expect.arrayContaining(['games/court', 'games/wordweave']));
  });

  it.each(projects.length ? projects : ['(none in this layout)'])('%s', (project) => {
    if (!projects.length) return;
    // TRACKED files, not disk probes: `android/` is committed, and the public snapshot deletes it.
    const tracked = new Map(repoFiles({ under: `${project}/android`, floor: 0, includeUntracked: false }).map((f) => [f.rel, f.abs]));
    if (tracked.size === 0) return; // no Android app, nothing Android can back up
    const manifest = tracked.get(`${project}/${MANIFEST}`);
    expect(manifest, `${project}/${MANIFEST} (an android/ dir with no manifest at the Capacitor path)`).toBeDefined();
    // XML has no registered stripper; backupViolations strips <!-- --> itself.
    const XML = { comments: 'include', reason: 'XML: backupViolations strips <!-- --> comments itself' } as const;
    const res = (name: string) => {
      const abs = tracked.get(`${project}/android/app/src/main/res/xml/${name}.xml`);
      return abs === undefined ? undefined : readScannedSource(abs, XML).code;
    };
    expect(backupViolations(readScannedSource(manifest!, XML).code, res),
      `${project}: Android backup must be off (see this file's header). If this project does NOT cloud-sync, it was detected by a local name colliding with the sync surface — rename that local instead`).toEqual([]);
  });
});
