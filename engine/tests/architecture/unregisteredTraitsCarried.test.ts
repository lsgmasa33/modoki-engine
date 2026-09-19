/** Every engine trait is either REGISTERED or a carried marker (#1427).
 *
 *  The base-scene carry and delete→undo rebuild an entity from a snapshot of the trait registry. A
 *  trait kept out of the registry is invisible to that walk, so it vanished on every such respawn:
 *  `Transient` (a runtime pool came back savable) and `TemplateAddedKey` (a template-added node lost
 *  its name) both did, silently, for months. `runtime/core/carriedMarkers.ts` now carries both.
 *
 *  This guard makes the next unregistered trait a decision rather than a leak: an exported
 *  `trait(...)` under the engine source must be registered in `engine/app/ecs/registerTraits.ts`,
 *  listed in `CARRIED_MARKER_TRAITS`, or named below with the reason it is neither.
 *
 *  Reads CODE through `readScannedSource`, so a trait named only in a comment of registerTraits.ts
 *  does not count as registered — `Transient` is mentioned there in prose, which a raw-text match
 *  took for a registration on the first survey. */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { readScannedSource } from '@modoki/engine/testing';
import { assertExemptionLedger } from '@modoki/engine/testing/exemptionLedger';
import { repoFiles } from '../../scripts/repoCorpus.mjs';
import { CARRIED_MARKER_TRAITS } from '../../packages/modoki/src/runtime/core/carriedMarkers';

const REPO = path.resolve(__dirname, '../../..');

/** Unregistered on purpose, and NOT carried — one row per trait, each with its reason. */
const NEITHER = [
  { item: 'ScreenBand', reason: 'registered by each game that authors screen bands (#800), not by the engine app shell' },
];

describe('an engine trait outside the registry is a carried marker (#1427)', () => {
  it('every exported trait is registered, carried, or named with its reason', () => {
    const files = repoFiles({
      under: ['engine/packages/modoki/src'],
      match: (rel: string) => /\.tsx?$/.test(rel) && !rel.includes('.test.'),
      exclude: ['node_modules', 'dist'],
      floor: 200,
    });
    const exported = new Map<string, string>();
    for (const { rel, abs } of files) {
      for (const m of readScannedSource(abs).code.matchAll(/export const (\w+) = trait\s*[(<]/g)) exported.set(m[1]!, rel);
    }
    const reg = readScannedSource(path.join(REPO, 'engine/app/ecs/registerTraits.ts')).code;
    const registered = new Set([...reg.matchAll(/\btrait:\s*(\w+)/g)].map((m) => m[1]!));
    // Non-vacuity: the scan reached the real population on both sides.
    expect(exported.size).toBeGreaterThan(60);
    expect(registered.size).toBeGreaterThan(60);

    const carried = new Set(Object.keys(CARRIED_MARKER_TRAITS));
    assertExemptionLedger({
      label: 'unregistered, uncarried engine traits',
      population: [...exported]
        .filter(([name]) => !registered.has(name) && !carried.has(name))
        .map(([name, rel]) => ({ item: name, site: rel })),
      exempt: NEITHER,
      floor: 60,
      scanned: exported.size,
      fix: 'register the trait in engine/app/ecs/registerTraits.ts, or — if it is a marker a respawn of '
        + 'the same entity must keep — add it to CARRIED_MARKER_TRAITS in runtime/core/carriedMarkers.ts',
    });
  });

  // Accept side: each carried marker really IS unregistered — a marker that later gets registered
  // is snapshotted by the registry walk AND restored by the carry, and should leave the list.
  it('every carried marker is genuinely unregistered', () => {
    const reg = readScannedSource(path.join(REPO, 'engine/app/ecs/registerTraits.ts')).code;
    const registered = new Set([...reg.matchAll(/\btrait:\s*(\w+)/g)].map((m) => m[1]!));
    expect(Object.keys(CARRIED_MARKER_TRAITS).filter((n) => registered.has(n))).toEqual([]);
  });
});
