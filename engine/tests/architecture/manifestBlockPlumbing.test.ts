/** Every block on `AssetEntry` must actually be PLUMBED — written by `registerAsset`, forwarded
 *  by `loadManifestJson`, and emitted by `serializeManifest`.
 *
 *  WHY (QA-ASSET-0007). `textureType` was declared on `AssetEntry`, read in exactly one place
 *  (`resolveBrowserImageUrl` → `browserVariant`), and written by NOBODY: `loadManifestJson`
 *  passed `entry.texture` plus a hand-maintained extras object and simply omitted it, and
 *  `serializeManifest` dropped it on the way out. Nothing failed — TypeScript is perfectly happy
 *  with an optional property nobody assigns, and the ONE consumer treated `undefined` as a
 *  legitimate value ("infer the type from the format"), which silently resolved every `ui`-typed
 *  KTX2 texture to the source PNG production strips.
 *
 *  That failure is structural, not incidental: `registerAsset` takes each block EXPLICITLY, so a
 *  block added to the interface is opt-in at three separate sites and its absence is invisible at
 *  all three. This guard makes the omission loud instead.
 *
 *  A source scan rather than a round-trip, deliberately: a round-trip can only exercise a field it
 *  knows how to SET, so a newly-added block nobody plumbed is exactly the one it would skip. */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { readScannedSource } from '@modoki/engine/testing';
import {
  accessPath, callsTo, callsToPath, functionsNamed, objectLiteralKeys, parseSource, propertyValue, ts, typeMembers, typesNamed,
} from '@modoki/engine/testing/sourceAst';

const SRC = path.resolve(__dirname, '../../packages/modoki/src/runtime/loaders/assetManifest.ts');
// ⚠️ ONE stripped read for every match (#1144 close-out), and every site below is a NODE of it (#1195).
// The sites used to be regexes cut at a fixed indent — `\n {2}\}\);` for the set literal, `\n {4}\}\);`
// for the push — and matched `(\w+):` inside them, so a nested literal's keys counted as fields and one
// more level of indentation made a site "not found". `guid, path, type` were appended by hand because
// the per-line regex could not see a shorthand at all.
const sf = parseSource(readScannedSource(SRC).code, SRC);

const oneFunction = (name: string): ts.ConciseBody => {
  const fns = functionsNamed(sf, name);
  expect(fns.length, `expected one function ${name} in assetManifest.ts`).toBe(1);
  return fns[0]!.body;
};

/** Does `lit`'s own `key` hold exactly `entry.<key>`? A spread, a method or an absent key does not. */
const holdsEntryField = (lit: ts.Expression, key: string): boolean => {
  const value = propertyValue(lit, key);
  return !!value && ts.isExpression(value) && accessPath(value) === `entry.${key}`;
};

/** Field names declared on an interface — its own members, not a nested block's. */
function declaredFields(iface: string): string[] {
  const decls = typesNamed(sf, iface);
  expect(decls.length, `${iface} not found in assetManifest.ts`).toBe(1);
  const members = typeMembers(decls[0]);
  expect(members, `${iface} is no longer a plain interface (a type alias, or one that extends another — read its new shape)`).toBeDefined();
  return members!.map((m) => m.name);
}

/** The keys of the single `guidToEntry.set(guid, {…})` literal inside registerAsset — what it writes. */
const written = (() => {
  const sets = callsToPath(oneFunction('registerAsset'), 'guidToEntry.set').filter((c) => objectLiteralKeys(c.arguments[1]) !== undefined);
  expect(sets.length, 'registerAsset: expected one guidToEntry.set(guid, { … })').toBe(1);
  return new Set(objectLiteralKeys(sets[0]!.arguments[1]));
})();

/** The `registerAsset(entry.guid, …)` call inside loadManifestJson — the fields it forwards. A POSITIONAL
 *  argument forwards the `entry.X` it reads; an extras-literal key forwards only when its value IS
 *  `entry.<that key>`, so `textureType: entry.model` forwards neither. */
const forwarded = (() => {
  const calls = callsTo(oneFunction('loadManifestJson'), 'registerAsset').filter((c) => c.arguments[0] && accessPath(c.arguments[0]) === 'entry.guid');
  expect(calls.length, 'loadManifestJson: expected one registerAsset(entry.guid, …) call').toBe(1);
  const out = new Set<string>();
  for (const arg of calls[0]!.arguments) {
    const keys = objectLiteralKeys(arg);
    if (keys) {
      for (const k of keys) if (holdsEntryField(arg, k)) out.add(k);
    } else {
      const p = accessPath(arg);
      if (p?.startsWith('entry.')) out.add(p.slice('entry.'.length));
    }
  }
  return out;
})();

/** The `assets.push({…})` literal in serializeManifest — the keys it emits, each counted only when its
 *  value is `entry.<that key>`. */
const emitted = (() => {
  const pushes = callsToPath(oneFunction('serializeManifest'), 'assets.push').filter((c) => objectLiteralKeys(c.arguments[0]) !== undefined);
  expect(pushes.length, 'serializeManifest: expected one assets.push({ … })').toBe(1);
  const lit = pushes[0]!.arguments[0]!;
  return new Set(objectLiteralKeys(lit)!.filter((k) => holdsEntryField(lit, k)));
})();

describe('asset-manifest block plumbing', () => {
  it('registerAsset writes every field declared on AssetEntry', () => {
    expect(declaredFields('AssetEntry').filter((f) => !written.has(f))).toEqual([]);
  });

  it('serializeManifest emits every field declared on AssetEntry', () => {
    expect(declaredFields('AssetEntry').filter((f) => !emitted.has(f))).toEqual([]);
  });

  it('loadManifestJson forwards every AssetManifestEntry field the runtime entry carries', () => {
    // `name` is scanner/panel-only (no `AssetEntry.name`), and `path` is forwarded through the
    // `pathPrefix` local rather than as `entry.path` — everything else must be passed on.
    const runtimeFields = new Set(declaredFields('AssetEntry'));
    const missing = declaredFields('AssetManifestEntry')
      .filter((f) => runtimeFields.has(f) && f !== 'path' && !forwarded.has(f));
    expect(missing).toEqual([]);
  });

  it('finds the three sites at all — a rename must fail loudly, not vacuously pass', () => {
    // A guard that silently matches nothing is worse than no guard: it would have vouched for
    // exactly the bug it exists to catch. Pin non-trivial sizes so a regex that stops matching
    // shows up as a failure here rather than as three empty diffs above.
    expect(declaredFields('AssetEntry').length).toBeGreaterThan(10);
    expect(written.size).toBeGreaterThan(10);
    expect(forwarded.size).toBeGreaterThan(10);
    expect(emitted.size).toBeGreaterThan(10);
  });
});
