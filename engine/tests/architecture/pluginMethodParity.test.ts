/** Guard: `capacitor-modoki-iap`'s TS contract, Android plugin, and iOS plugin expose EXACTLY
 *  the same set of method names.
 *
 *  ## The scar
 *
 *  `ModokiIapPlugin.products()` on Android existed and compiled but was MISSING its
 *  `@PluginMethod` annotation since the plugin's first commit. Capacitor indexes plugin methods
 *  by that annotation (`PluginHandle.indexMethods`), so every JS call failed at dispatch with
 *  `"ModokiIap.products() is not implemented on android"`. Court's store could never price
 *  anything on Android and emitted `store_products_failed` on every open. iOS was fine — it had
 *  its `CAPPluginMethod(name: "products")` entry — so the defect was invisible on the platform
 *  where IAP was most exercised. NO existing gate could see this: `npm run verify` is vitest and
 *  never compiles or runs Java, and a missing annotation is not a compile error.
 *  Device-confirmed and fixed 2026-09-03; this guard is so it cannot come back.
 *
 *  This is a SHAPE guard: it reads all three source files as TEXT (no Java/Swift parser, no
 *  compiling anything) and diffs the extracted method-name sets. `npm run verify` still cannot
 *  run Java or Swift, so it cannot exercise plugin dispatch itself — only a device run can. */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { REPO_ROOT } from '../helpers/repoLayout';

const DEFINITIONS_PATH = path.join(
  REPO_ROOT,
  'engine/packages/capacitor-modoki-iap/src/definitions.ts',
);
const ANDROID_PATH = path.join(
  REPO_ROOT,
  'engine/packages/capacitor-modoki-iap/android/src/main/java/com/modokiengine/capacitor/iap/ModokiIapPlugin.java',
);
const IOS_PATH = path.join(
  REPO_ROOT,
  'engine/packages/capacitor-modoki-iap/ios/Sources/ModokiIapPlugin/IapPlugin.swift',
);

// Inherited from Capacitor's base Plugin/CAPPlugin, never annotated/declared by this plugin's
// own methods, and not part of the parity we care about here.
const BUILTIN_LISTENER_METHODS = new Set(['addListener', 'removeAllListeners']);

function excludeBuiltins(names: string[]): Set<string> {
  return new Set(names.filter((n) => !BUILTIN_LISTENER_METHODS.has(n)));
}

/** Extract the body of `export interface ModokiIapPlugin { ... }` by locating the signature and
 *  matching braces — the same technique `iapParkedCallRelease.test.ts` uses for `unpark()`. */
function extractInterfaceBody(src: string, interfaceName: string): string {
  const signature = `export interface ${interfaceName} {`;
  const start = src.indexOf(signature);
  if (start === -1) {
    throw new Error(
      `could not find "${signature}" in definitions.ts — has the interface been renamed or removed?`,
    );
  }
  let depth = 1;
  let i = start + signature.length;
  const bodyStart = i;
  for (; i < src.length && depth > 0; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
  }
  if (depth !== 0) {
    throw new Error(`${interfaceName} body braces never balanced — malformed source?`);
  }
  return src.slice(bodyStart, i - 1);
}

/** Method members are lines whose first non-whitespace characters are an identifier immediately
 *  followed by `(` — e.g. `purchase(options: {`. A JSDoc line always starts with `*` (this file's
 *  doc blocks are `/** ... *\/` with a leading `*` on every continuation line), so a comment line
 *  that happens to mention `call.reject(...)` in prose never matches: its first non-whitespace
 *  character is `*`, not an identifier. A field inside a multi-line parameter object (e.g.
 *  `productId: string;`) doesn't match either — the character after the identifier is `:`, not
 *  `(`. */
function extractTsMethodNames(interfaceBody: string): string[] {
  const names: string[] = [];
  const re = /^[ \t]*([a-zA-Z_$][\w$]*)[ \t]*\(/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(interfaceBody))) names.push(m[1]);
  return names;
}

/** Strip `//` and `/* *\/` comments down to bare, non-blank code lines, in order — mirroring the
 *  comment-aware line scanning in `iapParkedCallRelease.test.ts`. Needed so a `@PluginMethod`
 *  hiding above a javadoc block (as `products()`'s does, post-fix) still reads as directly
 *  preceding its method once the javadoc is removed. */
function extractJavaCodeLines(src: string): string[] {
  const lines: string[] = [];
  let inBlockComment = false;
  for (const rawLine of src.split('\n')) {
    const line = rawLine.trim();
    if (inBlockComment) {
      if (line.includes('*/')) inBlockComment = false;
      continue;
    }
    if (line.startsWith('/*')) {
      if (!line.includes('*/')) inBlockComment = true;
      continue;
    }
    if (line.startsWith('//')) continue;
    if (line.length === 0) continue;
    lines.push(line);
  }
  return lines;
}

/** A method is Capacitor-dispatchable only when `@PluginMethod` sits on the code line
 *  immediately above `public void <name>(PluginCall call)` (after comments are stripped) — this
 *  is exactly the annotation `PluginHandle.indexMethods` reads, and exactly what `products()` was
 *  missing. Deliberately requires the `public void ...(PluginCall call)` shape so a private
 *  helper (e.g. `rejectWithBilling`, which is mis-preceded by a stray `@PluginMethod` in the
 *  source today) is never counted, whether or not it happens to sit under that annotation. */
function extractAndroidPluginMethodNames(src: string): string[] {
  const codeLines = extractJavaCodeLines(src);
  const names: string[] = [];
  for (let i = 0; i < codeLines.length; i++) {
    const m = codeLines[i].match(/^public void (\w+)\(PluginCall call\)/);
    if (m && codeLines[i - 1] === '@PluginMethod') {
      names.push(m[1]);
    }
  }
  return names;
}

/** Extract the body of `let pluginMethods: [CAPPluginMethod] = [ ... ]` by bracket-balancing,
 *  then pull every `name:` value out of the `CAPPluginMethod(name: "...", ...)` entries inside
 *  it. Bounding to this array (rather than a bare global regex over the whole file) means a
 *  `CAPPluginMethod(name:` appearing anywhere else — a comment, a future helper — can't leak in. */
function extractIosPluginMethodNames(src: string): string[] {
  const signature = 'let pluginMethods: [CAPPluginMethod] = [';
  const start = src.indexOf(signature);
  if (start === -1) {
    throw new Error(
      `could not find "${signature}" in IapPlugin.swift — has pluginMethods been renamed or removed?`,
    );
  }
  let depth = 1;
  let i = start + signature.length;
  const bodyStart = i;
  for (; i < src.length && depth > 0; i++) {
    if (src[i] === '[') depth++;
    else if (src[i] === ']') depth--;
  }
  if (depth !== 0) {
    throw new Error('pluginMethods array brackets never balanced — malformed source?');
  }
  const body = src.slice(bodyStart, i - 1);
  const names: string[] = [];
  const re = /CAPPluginMethod\(name:\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) names.push(m[1]);
  return names;
}

const definitionsSource = fs.readFileSync(DEFINITIONS_PATH, 'utf8');
const androidSource = fs.readFileSync(ANDROID_PATH, 'utf8');
const iosSource = fs.readFileSync(IOS_PATH, 'utf8');

const tsMethods = excludeBuiltins(
  extractTsMethodNames(extractInterfaceBody(definitionsSource, 'ModokiIapPlugin')),
);
const androidMethods = excludeBuiltins(extractAndroidPluginMethodNames(androidSource));
const iosMethods = excludeBuiltins(extractIosPluginMethodNames(iosSource));

function describeSet(s: Set<string>): string {
  return `{ ${[...s].sort().join(', ')} }`;
}

describe('capacitor-modoki-iap: TS/Android/iOS plugin methods stay in parity', () => {
  it('extracted every set from real source — a broken regex cannot make the equality checks pass vacuously', () => {
    expect(tsMethods.size, `extracted 0 TS methods from ${DEFINITIONS_PATH} — extractor is broken`).toBeGreaterThan(0);
    expect(androidMethods.size, `extracted 0 Android @PluginMethod methods from ${ANDROID_PATH} — extractor is broken`).toBeGreaterThan(0);
    expect(iosMethods.size, `extracted 0 iOS CAPPluginMethod entries from ${IOS_PATH} — extractor is broken`).toBeGreaterThan(0);
  });

  it('TS definitions.ts and Android @PluginMethod-annotated methods match', () => {
    const onlyInTs = [...tsMethods].filter((n) => !androidMethods.has(n));
    const onlyInAndroid = [...androidMethods].filter((n) => !tsMethods.has(n));
    expect(
      { onlyInTs, onlyInAndroid },
      `TS methods ${describeSet(tsMethods)} vs Android @PluginMethod methods `
        + `${describeSet(androidMethods)} — a method declared in definitions.ts with no matching `
        + '`@PluginMethod` on Android dispatches nowhere (this is exactly how products() broke); '
        + 'the reverse means Android exposes something JS has no contract for.',
    ).toEqual({ onlyInTs: [], onlyInAndroid: [] });
  });

  it('TS definitions.ts and iOS CAPPluginMethod entries match', () => {
    const onlyInTs = [...tsMethods].filter((n) => !iosMethods.has(n));
    const onlyInIos = [...iosMethods].filter((n) => !tsMethods.has(n));
    expect(
      { onlyInTs, onlyInIos },
      `TS methods ${describeSet(tsMethods)} vs iOS pluginMethods `
        + `${describeSet(iosMethods)} — a method declared in definitions.ts with no matching `
        + '`CAPPluginMethod(name:)` entry on iOS dispatches nowhere; the reverse means iOS exposes '
        + 'something JS has no contract for.',
    ).toEqual({ onlyInTs: [], onlyInIos: [] });
  });
});
