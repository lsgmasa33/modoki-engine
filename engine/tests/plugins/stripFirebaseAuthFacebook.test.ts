/** `stripFirebaseAuthFacebook` — removes the Facebook iOS SDK from `@capacitor-firebase/authentication`'s
 *  SPM manifest, and REFUSES when it cannot (#1062).
 *
 *  The fixture is the plugin's v8.4.0 `Package.swift` verbatim, inlined rather than read from a
 *  game's `node_modules`, so the suite means the same thing on a clone that has never installed
 *  Court's deps. An upgrade that reshapes the real file is caught by the heal's own refusal at build
 *  time, not here — that refusal is what the "reshaped" cases below pin. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  stripFacebookElements,
  facebookLeftovers,
  stripFirebaseAuthFacebook,
  firebaseAuthManifestPath,
  resolvedPinsPath,
} from '../../plugins/stripFirebaseAuthFacebook';

const V8_4_0 = `// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "CapacitorFirebaseAuthentication",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "CapacitorFirebaseAuthentication",
            targets: ["FirebaseAuthenticationPlugin"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0"),
        .package(url: "https://github.com/firebase/firebase-ios-sdk.git", .upToNextMajor(from: "12.7.0")),
        .package(url: "https://github.com/google/GoogleSignIn-iOS", from: "9.0.0"),
        .package(url: "https://github.com/facebook/facebook-ios-sdk.git", from: "18.0.0")
    ],
    targets: [
        .target(
            name: "FirebaseAuthenticationPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                .product(name: "FirebaseAuth", package: "firebase-ios-sdk"),
                .product(name: "FirebaseCore", package: "firebase-ios-sdk"),
                .product(name: "GoogleSignIn", package: "GoogleSignIn-iOS"),
                .product(name: "FacebookCore", package: "facebook-ios-sdk"),
                .product(name: "FacebookLogin", package: "facebook-ios-sdk")
            ],
            path: "ios/Plugin",
            swiftSettings: [
                .define("RGCFA_INCLUDE_GOOGLE"),
                .define("RGCFA_INCLUDE_FACEBOOK")
            ]),
        .testTarget(
            name: "FirebaseAuthenticationPluginTests",
            dependencies: ["FirebaseAuthenticationPlugin"],
            path: "ios/PluginTests")
    ]
)
`;

describe('stripFacebookElements — the pure strip', () => {
  it('removes exactly the four Facebook lines from the v8.4.0 manifest, and nothing else', () => {
    const out = stripFacebookElements(V8_4_0);
    const removed = V8_4_0.split('\n').filter((l) => !out.split('\n').includes(l)).map((l) => l.trim());
    expect(removed).toEqual([
      '.package(url: "https://github.com/facebook/facebook-ios-sdk.git", from: "18.0.0")',
      '.product(name: "FacebookCore", package: "facebook-ios-sdk"),',
      '.product(name: "FacebookLogin", package: "facebook-ios-sdk")',
      '.define("RGCFA_INCLUDE_FACEBOOK")',
    ]);
    expect(out.split('\n')).toHaveLength(V8_4_0.split('\n').length - 4);
    expect(facebookLeftovers(out)).toEqual([]);
  });

  it('keeps Google sign-in — its package, product and define all survive', () => {
    const out = stripFacebookElements(V8_4_0);
    expect(out).toContain('.package(url: "https://github.com/google/GoogleSignIn-iOS", from: "9.0.0"),');
    expect(out).toContain('.product(name: "GoogleSignIn", package: "GoogleSignIn-iOS"),');
    expect(out).toContain('.define("RGCFA_INCLUDE_GOOGLE"),');
  });

  it('is idempotent — a stripped manifest comes back byte-identical', () => {
    const once = stripFacebookElements(V8_4_0);
    expect(stripFacebookElements(once)).toBe(once);
  });

  it('leaves a WRAPPED Facebook element in place, so the post-condition sees it instead of a half-removed call', () => {
    const wrapped = V8_4_0.replace(
      '.package(url: "https://github.com/facebook/facebook-ios-sdk.git", from: "18.0.0")',
      '.package(\n            url: "https://github.com/facebook/facebook-ios-sdk.git",\n            from: "18.0.0")',
    );
    const out = stripFacebookElements(wrapped);
    expect(out).toContain('from: "18.0.0")');
    expect(facebookLeftovers(out)).toEqual(['url: "https://github.com/facebook/facebook-ios-sdk.git",']);
  });
});

describe('stripFirebaseAuthFacebook — the heal on a project', () => {
  let project: string;
  const manifest = () => fs.readFileSync(firebaseAuthManifestPath(project), 'utf8');
  const install = (text: string) => {
    fs.mkdirSync(path.dirname(firebaseAuthManifestPath(project)), { recursive: true });
    fs.writeFileSync(firebaseAuthManifestPath(project), text);
  };
  const providers = (list: string[]) => fs.writeFileSync(
    path.join(project, 'capacitor.config.json'),
    JSON.stringify({ plugins: { FirebaseAuthentication: { providers: list } } }),
  );

  const pins = (identities: string[]) => {
    fs.mkdirSync(path.dirname(resolvedPinsPath(project)), { recursive: true });
    fs.writeFileSync(resolvedPinsPath(project), JSON.stringify({
      originHash: 'abc',
      pins: identities.map((identity) => ({ identity, kind: 'remoteSourceControl', location: `https://example.invalid/${identity}.git`, state: { version: '1.0.0' } })),
      version: 3,
    }, null, 2));
  };

  beforeEach(() => { project = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-fbstrip-')); });
  afterEach(() => { fs.rmSync(project, { recursive: true, force: true }); });

  it('is a silent no-op for a project that does not depend on the plugin', () => {
    expect(stripFirebaseAuthFacebook(project)).toEqual({ ok: true, notes: [] });
    expect(fs.existsSync(firebaseAuthManifestPath(project))).toBe(false);
  });

  it('strips the installed manifest and says so', () => {
    install(V8_4_0);
    providers(['apple.com', 'google.com']);
    const r = stripFirebaseAuthFacebook(project);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0]).toContain('#1062');
    expect(manifest()).toBe(stripFacebookElements(V8_4_0));
  });

  it('a second run (the next build) changes nothing and reports nothing', () => {
    install(V8_4_0);
    stripFirebaseAuthFacebook(project);
    const after = manifest();
    expect(stripFirebaseAuthFacebook(project)).toEqual({ ok: true, notes: [] });
    expect(manifest()).toBe(after);
  });

  it('strips when there is no capacitor.config.json at all — absence asks for no Facebook', () => {
    install(V8_4_0);
    expect(stripFirebaseAuthFacebook(project).ok).toBe(true);
    expect(facebookLeftovers(manifest())).toEqual([]);
  });

  it('REFUSES, naming the leftover and WRITING NOTHING, when the manifest has a shape the strip does not remove', () => {
    const reshaped = V8_4_0.replace(
      '.define("RGCFA_INCLUDE_FACEBOOK")',
      '.define("RGCFA_INCLUDE_FACEBOOK", .when(platforms: [.iOS]))  // reshaped by an upgrade',
    ).replace('.product(name: "FacebookLogin", package: "facebook-ios-sdk")', '.product(name: "FacebookLogin",\n                         package: "facebook-ios-sdk")');
    install(reshaped);
    pins(['facebook-ios-sdk', 'firebase-ios-sdk']);
    const pinsBefore = fs.readFileSync(resolvedPinsPath(project), 'utf8');
    const r = stripFirebaseAuthFacebook(project);
    // A partial strip (the one-line package + product gone, the wrapped product left naming a package
    // no longer declared) breaks SPM resolution for every later build — review finding, #1062.
    expect(manifest()).toBe(reshaped);
    expect(fs.readFileSync(resolvedPinsPath(project), 'utf8')).toBe(pinsBefore);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.lines[0]).toContain(firebaseAuthManifestPath(project));
    expect(r.lines).toContain('  • .product(name: "FacebookLogin",');
    expect(r.lines).toContain('  • package: "facebook-ios-sdk")');
    expect(r.lines.join('\n')).toContain('"facebook.com"');
  });

  it('KEEPS the SDK, untouched, when providers lists facebook.com', () => {
    install(V8_4_0);
    providers(['apple.com', 'facebook.com']);
    const r = stripFirebaseAuthFacebook(project);
    expect(manifest()).toBe(V8_4_0);
    expect(r).toEqual({ ok: true, notes: [expect.stringContaining('kept the Facebook iOS SDK')] });
  });

  it('REFUSES when facebook.com is listed over an ALREADY-stripped manifest — that build would hang signInWithFacebook', () => {
    install(stripFacebookElements(V8_4_0));
    providers(['facebook.com']);
    const r = stripFirebaseAuthFacebook(project);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.lines.join('\n')).toContain('never resolves');
    expect(r.lines.join('\n')).toContain('rm -rf node_modules/@capacitor-firebase/authentication && npm install');
  });

  it('drops a stale facebook-ios-sdk pin from Package.resolved, keeping every other pin', () => {
    install(V8_4_0);
    pins(['abseil-cpp-binary', 'facebook-ios-sdk', 'firebase-ios-sdk']);
    const r = stripFirebaseAuthFacebook(project);
    expect(r).toEqual({ ok: true, notes: [expect.stringContaining('Package.swift'), expect.stringContaining('Package.resolved')] });
    const doc = JSON.parse(fs.readFileSync(resolvedPinsPath(project), 'utf8'));
    expect(doc.pins.map((p: { identity: string }) => p.identity)).toEqual(['abseil-cpp-binary', 'firebase-ios-sdk']);
    expect(doc.version).toBe(3);
  });

  it('drops the pin even when the MANIFEST was stripped by an earlier build — the state a clone is left in', () => {
    install(stripFacebookElements(V8_4_0));
    pins(['facebook-ios-sdk']);
    expect(stripFirebaseAuthFacebook(project)).toEqual({ ok: true, notes: [expect.stringContaining('Package.resolved')] });
    expect(fs.readFileSync(resolvedPinsPath(project), 'utf8')).not.toContain('facebook');
  });

  it('leaves Package.resolved byte-identical when it has no Facebook pin, or cannot be parsed', () => {
    install(V8_4_0);
    pins(['firebase-ios-sdk']);
    const clean = fs.readFileSync(resolvedPinsPath(project), 'utf8');
    stripFirebaseAuthFacebook(project);
    expect(fs.readFileSync(resolvedPinsPath(project), 'utf8')).toBe(clean);
    fs.writeFileSync(resolvedPinsPath(project), '{ not json facebook-ios-sdk');
    expect(stripFirebaseAuthFacebook(project)).toEqual({ ok: true, notes: [] });
    expect(fs.readFileSync(resolvedPinsPath(project), 'utf8')).toBe('{ not json facebook-ios-sdk');
  });

  it('REFUSES the keep when only a COMMENT mentions Facebook — the define is what compiles the flow in', () => {
    install(`// Facebook support was removed\n${stripFacebookElements(V8_4_0)}`);
    providers(['facebook.com']);
    expect(stripFirebaseAuthFacebook(project).ok).toBe(false);
  });

  it('REFUSES the keep when the define is only COMMENTED OUT', () => {
    install(stripFacebookElements(V8_4_0).replace('.define("RGCFA_INCLUDE_GOOGLE"),', '.define("RGCFA_INCLUDE_GOOGLE"),\n                // .define("RGCFA_INCLUDE_FACEBOOK")'));
    providers(['facebook.com']);
    expect(stripFirebaseAuthFacebook(project).ok).toBe(false);
  });

  it('leaves a Package.resolved that parses to null alone, instead of throwing', () => {
    install(V8_4_0);
    fs.mkdirSync(path.dirname(resolvedPinsPath(project)), { recursive: true });
    fs.writeFileSync(resolvedPinsPath(project), 'null');
    expect(stripFirebaseAuthFacebook(project).ok).toBe(true);
    expect(fs.readFileSync(resolvedPinsPath(project), 'utf8')).toBe('null');
  });

  it('keeps the Package.resolved pin when the project KEEPS Facebook', () => {
    install(V8_4_0);
    providers(['facebook.com']);
    pins(['facebook-ios-sdk']);
    const before = fs.readFileSync(resolvedPinsPath(project), 'utf8');
    stripFirebaseAuthFacebook(project);
    expect(fs.readFileSync(resolvedPinsPath(project), 'utf8')).toBe(before);
  });
});
