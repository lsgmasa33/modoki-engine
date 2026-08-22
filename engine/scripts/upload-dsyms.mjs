#!/usr/bin/env node
/** Upload a project's iOS dSYMs to Crashlytics by hand (#279).
 *
 *  The build phase in each project's pbxproj covers the normal case. This covers the cases it
 *  cannot: a crash already sitting in the console unprocessed, an `.xcarchive` from a TestFlight
 *  build, a dSYM that arrived some other way. Without a dSYM an iOS crash report is a list of raw
 *  addresses — the difference between a report and a puzzle.
 *
 *  Usage:
 *    npm run upload:dsyms -- games/court              # LIST what would be uploaded (the default)
 *    npm run upload:dsyms -- games/court --upload     # actually upload
 *    npm run upload:dsyms -- games/court --dsym <p>   # a specific dSYM/dir/archive
 *
 *  ⚠️ **Listing is the default and uploading is opt-in, because of how this is invoked.** It was
 *  the other way round for about an hour: upload by default, `--dry-run` to preview. But
 *  `npm run upload:dsyms games/court --dry-run` **silently eats the flag** — `--dry-run` is one of
 *  npm's OWN options, so npm consumes it and the script receives only the project path. Measured:
 *  the command echoed by npm was `node engine/scripts/upload-dsyms.mjs games/court`, and it
 *  uploaded for real while the caller believed they had asked for a preview. A safety flag that
 *  can be swallowed by the runner is worse than no safety flag, and the mistake it guards against
 *  — uploading a SIBLING CLONE's symbols, see below — is silent on the receiving end too. So the
 *  destructive direction is the one that needs the word.
 *
 *  ⚠️ **Picking the right DerivedData is the correctness-critical step, not a detail.** EVERY
 *  Capacitor project's Xcode project is literally named `App`, so
 *  `~/Library/Developer/Xcode/DerivedData/App-*` matches every game on the machine — and with
 *  several clones of this repo it matches the SAME game several times over. Measured here: three
 *  `App-*` dirs whose workspace is `<clone>/games/court/ios/App/App.xcodeproj`, one per clone. So
 *  this matches on the absolute `WorkspacePath` recorded in each candidate's `info.plist`. A
 *  substring or newest-wins heuristic would upload a sibling clone's symbols, and the failure
 *  would be silent: Crashlytics accepts them, and the crash stays unsymbolicated because the UUIDs
 *  do not match.
 *
 *  macOS only (it drives `plutil` and Apple's `upload-symbols`). */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { parseUploadDsymsArgs } from './uploadDsymsArgs.mjs';

const { projectArg, doUpload, dsym: dsymArg } = parseUploadDsymsArgs(process.argv.slice(2));

function die(msg) {
  console.error(`[upload-dsyms] ${msg}`);
  process.exit(1);
}

if (!projectArg) die('usage: npm run upload:dsyms -- <projectDir> [--upload] [--dsym <path>]');
if (process.platform !== 'darwin') die('macOS only — this drives plutil and Apple\'s upload-symbols.');

const projectDir = path.resolve(projectArg);
const iosApp = path.join(projectDir, 'ios', 'App');
if (!fs.existsSync(iosApp)) die(`no iOS project at ${iosApp} — has this project had \`Build → iOS\` run once?`);

// --- the Firebase app this project reports to ------------------------------------------------
const gsp = path.join(iosApp, 'App', 'GoogleService-Info.plist');
if (!fs.existsSync(gsp)) {
  die(`no GoogleService-Info.plist at ${gsp}. This project does not report to Crashlytics, so there `
    + 'is nothing to symbolicate — nothing to do here.');
}

/** Read one key out of a plist. Returns undefined rather than throwing: a missing key is a
 *  legitimate answer this script reports on, not a crash. */
function plistValue(file, key) {
  try {
    // stderr silenced: this is called across EVERY DerivedData entry, most of which are caches
    // with no info.plist at all, and plutil narrates each one. The absence is the answer, not news.
    return execFileSync('plutil', ['-extract', key, 'raw', '-o', '-', file],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return undefined;
  }
}

// --- which DerivedData is THIS project's (see the header) -------------------------------------
function derivedDataFor(dir) {
  const root = path.join(os.homedir(), 'Library', 'Developer', 'Xcode', 'DerivedData');
  if (!fs.existsSync(root)) return undefined;
  const wanted = [path.join(dir, 'App.xcworkspace'), path.join(dir, 'App.xcodeproj')];
  const hits = [];
  for (const entry of fs.readdirSync(root)) {
    const candidate = path.join(root, entry);
    const wp = plistValue(path.join(candidate, 'info.plist'), 'WorkspacePath');
    if (wp && wanted.includes(wp)) hits.push({ dir: candidate, mtime: fs.statSync(candidate).mtimeMs });
  }
  // Xcode can leave more than one dir for the same workspace (a path it once had, a stale hash).
  // Newest wins AMONG EXACT MATCHES — which is a different thing from newest-wins across all of
  // them, and is the only place a recency heuristic is safe here.
  hits.sort((a, b) => b.mtime - a.mtime);
  return hits[0]?.dir;
}

const derived = derivedDataFor(iosApp);
if (!derived && !dsymArg) {
  die(`no DerivedData directory whose WorkspacePath is ${iosApp}/App.xc*. Build the project once `
    + '(Build → iOS Device), or pass --dsym <path> to upload a specific dSYM.');
}

// --- Apple's uploader, out of THIS project's SPM checkout -------------------------------------
function findUploader() {
  const candidates = [
    derived && path.join(derived, 'SourcePackages', 'checkouts', 'firebase-ios-sdk', 'Crashlytics', 'upload-symbols'),
    path.join(iosApp, 'Pods', 'FirebaseCrashlytics', 'upload-symbols'),
  ].filter(Boolean);
  return candidates.find((c) => fs.existsSync(c));
}

const uploader = findUploader();
if (!uploader) {
  die('could not find Crashlytics\' `upload-symbols`. It ships inside the firebase-ios-sdk SPM '
    + 'checkout, so it only exists once Xcode has resolved packages for this project — run '
    + '`npx cap sync ios` and build once.');
}

// --- what to upload ---------------------------------------------------------------------------
/** Every `.dSYM` under a directory, one level of nesting deep — which is where both a
 *  `Build/Products/<config>-iphoneos` tree and an `.xcarchive/dSYMs` keep them. */
function findDsyms(dir) {
  const out = [];
  const walk = (d, depth) => {
    if (depth > 3 || !fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (p.endsWith('.dSYM')) out.push(p);
        else walk(p, depth + 1);
      }
    }
  };
  walk(dir, 0);
  return out;
}

const explicit = dsymArg;
let dsyms;
if (explicit) {
  const p = path.resolve(explicit);
  if (!fs.existsSync(p)) die(`--dsym ${p} does not exist`);
  dsyms = p.endsWith('.dSYM') ? [p] : findDsyms(p);
} else {
  const products = path.join(derived, 'Build', 'Products');
  dsyms = findDsyms(products).filter((p) => p.includes('-iphoneos'));
}

if (dsyms.length === 0) {
  die('found no .dSYM to upload.\n'
    + '  The usual cause is that the build was a DEBUG build with DEBUG_INFORMATION_FORMAT = dwarf,\n'
    + '  which produces no dSYM at all — check Project Settings, or see docs/native-and-sdks.md\n'
    + '  § "iOS symbolication". Pass --dsym <path> if you have one from elsewhere (an .xcarchive\'s\n'
    + '  dSYMs/ directory works).');
}

// The APP's own dSYM is the one that matters; the frameworks come along because a crash can land
// in any of them. Say which is which, so "8 unprocessed crashes" can be checked against what
// actually went up rather than assumed.
const appDsym = dsyms.find((p) => path.basename(p).startsWith('App.app'));
console.log(`[upload-dsyms] project      ${projectDir}`);
console.log(`[upload-dsyms] firebase app ${plistValue(gsp, 'GOOGLE_APP_ID') ?? '(GOOGLE_APP_ID unreadable)'}`);
console.log(`[upload-dsyms] uploader     ${uploader}`);
console.log(`[upload-dsyms] dSYMs        ${dsyms.length} (${appDsym ? 'includes App.app.dSYM' : '⚠️  NO App.app.dSYM — frameworks only'})`);
for (const d of dsyms) console.log(`               ${path.relative(derived ?? projectDir, d)}`);

if (!doUpload) {
  console.log('[upload-dsyms] listed only — nothing uploaded. Re-run with --upload to send these.');
  process.exit(0);
}

try {
  execFileSync(uploader, ['-gsp', gsp, '-p', 'ios', ...dsyms], { stdio: 'inherit' });
} catch (e) {
  die(`upload-symbols failed: ${e instanceof Error ? e.message : String(e)}`);
}
console.log(`[upload-dsyms] uploaded ${dsyms.length} dSYM(s). Crashlytics processes them within a few minutes.`);
