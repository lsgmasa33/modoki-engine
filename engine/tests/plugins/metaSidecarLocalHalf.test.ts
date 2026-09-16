/** #1305 — a peel migration deletes the committed value and cannot seed the gitignored local half,
 *  so nothing ever put it back. These cover the two halves of the repair: detecting that a
 *  machine is missing a block's peeled values, and scheduling exactly one re-derivation for it.
 *
 *  The unit under test is the DECISION, not the probe. Whether `ffprobe` produces a duration is the
 *  reimport handler's business and is covered where the handlers are; what this file pins is that
 *  an absent local half is noticed, that a present one is left alone, and that a failing attempt is
 *  not retried forever. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { blocksMissingLocalHalf, reimportTypeForBlock, CACHE_BLOCKS, writeMetaSidecar, peelSchemaId } from '../../plugins/meta-sidecar';
import { scheduleLocalHalfHeal, healAttempts } from '../../plugins/backend/healLocalHalf';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';
import { parseSource, callsTo } from '@modoki/engine/testing/sourceAst';
import ts from 'typescript';

let tmpRoot: string;
let absPath: string;

beforeEach(() => {
  tmpRoot = makeScratchDir('modoki-local-half-');
  absPath = path.join(tmpRoot, 'asset.mp3');
  healAttempts.clear();
});
afterEach(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });

/** Write a committed sidecar directly, WITHOUT going through `writeMetaSidecar` — that function
 *  peels, which would produce the local half these tests exist to find missing. This is what a
 *  post-migration checkout actually looks like on disk. */
function writeCommittedOnly(doc: Record<string, unknown>): void {
  fs.writeFileSync(absPath + '.meta.json', JSON.stringify(doc, null, 2) + '\n');
}
/** A local half written by the CURRENT peel table — i.e. stamped, the way `writeMetaSidecar`
 *  produces one. Unstamped fixtures are written inline where that is the point of the test. */
function writeLocal(doc: Record<string, unknown>): void {
  fs.writeFileSync(absPath + '.meta.local.json', JSON.stringify({ ...doc, __peel: peelSchemaId() }, null, 2) + '\n');
}

describe('blocksMissingLocalHalf', () => {
  it('reports a committed block whose peeled values this machine does not have', () => {
    // Exactly the shape #1289 left behind: durationSec stripped, no local file at all.
    writeCommittedOnly({ id: 'g', version: 2, audioCache: { hash: 'h', ext: 'mp3', channels: 1 } });
    expect(blocksMissingLocalHalf(absPath)).toEqual(['audioCache']);
  });

  it('reports nothing once the local half carries a peeled key', () => {
    writeCommittedOnly({ id: 'g', version: 2, audioCache: { hash: 'h', ext: 'mp3' } });
    writeLocal({ audioCache: { durationSec: 1.5 } });
    expect(blocksMissingLocalHalf(absPath)).toEqual([]);
  });

  /** ⚠️ The trap that makes "all peeled keys present" the wrong predicate. `LOCAL_KEYS` lists all
   *  four VOLATILE_STAT_KEYS for textureCache, but a healthy texture local half holds only
   *  `variantBytes` — 66 of them do in this repo, and not one has lodBytes/triCounts/bytes.
   *  Requiring the full list would report every texture on every machine as permanently broken,
   *  and the heal would re-probe all 282 of them on every Inspector open, forever. */
  it('does not report a texture whose local half holds only variantBytes (LOCAL_KEYS is a superset)', () => {
    const tex = path.join(tmpRoot, 'tex.png');
    fs.writeFileSync(tex + '.meta.json', JSON.stringify({ id: 'g', textureCache: { hash: 'h', width: 4, height: 4 } }));
    fs.writeFileSync(tex + '.meta.local.json', JSON.stringify({ textureCache: { variantBytes: { webp: 42 } }, __peel: peelSchemaId() }));
    expect(blocksMissingLocalHalf(tex)).toEqual([]);
  });

  /** ⚠️ **The close-out finding, and the case that made the first version of this fix useless on the
   *  machine that mattered.** A local half written before a LATER peel holds exactly the keys that
   *  earlier peel produced — a non-empty subset — so "does it hold ANY peeled key" reads it as
   *  healed. Measured on `~/Projects/modoki` (the hub) 2026-09-17: 19 audio local halves, every one
   *  `{bytes}` only, none carrying `durationSec`. All 19 would have been skipped, and the owner
   *  would have seen the Duration row still blank while the fix reported success. */
  it('reports a block whose local half predates the current peel table (no stamp)', () => {
    writeCommittedOnly({ id: 'g', version: 2, audioCache: { hash: 'h', ext: 'mp3' } });
    // Exactly the hub's shape: `bytes` peeled by #1279, written before #1289 added durationSec.
    fs.writeFileSync(absPath + '.meta.local.json', JSON.stringify({ audioCache: { bytes: 2012492 } }));
    expect(blocksMissingLocalHalf(absPath)).toEqual(['audioCache']);
  });

  it('reports a block whose local half carries a STALE stamp', () => {
    writeCommittedOnly({ id: 'g', version: 2, audioCache: { hash: 'h', ext: 'mp3' } });
    fs.writeFileSync(absPath + '.meta.local.json', JSON.stringify({
      audioCache: { bytes: 1, durationSec: 2 }, __peel: 'deadbeef',
    }));
    expect(blocksMissingLocalHalf(absPath)).toEqual(['audioCache']);
  });

  /** The stamp is DERIVED from `LOCAL_KEYS`, so a peel change invalidates every local half on every
   *  machine with no constant for anyone to remember to bump. Mutation anchor: change the table and
   *  this must move. */
  it('stamps what writeMetaSidecar writes, and the stamp tracks the peel table', () => {
    writeMetaSidecar(absPath, { id: 'g', version: 2, audioCache: { hash: 'h', durationSec: 2.5 } });
    const local = JSON.parse(fs.readFileSync(absPath + '.meta.local.json', 'utf-8'));
    expect(local.__peel).toBe(peelSchemaId());
    expect(peelSchemaId()).toMatch(/^[0-9a-f]{8}$/);
  });

  /** #1279's rule, from the other side: the committed sidecar alone decides which blocks EXIST. A
   *  local block with no committed counterpart is inert, so it is not something to heal — healing
   *  it would be the gitignored file deciding what the build ships. */
  it('ignores a local block the committed sidecar does not have', () => {
    writeCommittedOnly({ id: 'g', version: 2 });
    writeLocal({ audioCache: { durationSec: 1.5 } });
    expect(blocksMissingLocalHalf(absPath)).toEqual([]);
  });

  it('treats an unparsable local half as absent (re-deriving is also how it gets rewritten)', () => {
    writeCommittedOnly({ id: 'g', version: 2, audioCache: { hash: 'h' } });
    fs.writeFileSync(absPath + '.meta.local.json', '{ "audioCache": { "durationSec"');
    expect(blocksMissingLocalHalf(absPath)).toEqual(['audioCache']);
  });

  it('reports nothing when there is no committed sidecar at all', () => {
    expect(blocksMissingLocalHalf(absPath)).toEqual([]);
  });

  /** The round trip, through the real writer: a block written by `writeMetaSidecar` is complete by
   *  construction, so the heal must not fire on anything this machine produced itself. */
  it('reports nothing for a block this machine wrote through writeMetaSidecar', () => {
    writeMetaSidecar(absPath, { id: 'g', version: 2, audioCache: { hash: 'h', durationSec: 2.5 } });
    expect(blocksMissingLocalHalf(absPath)).toEqual([]);
  });

  /** Mutation anchor for the derivation. `blocksMissingLocalHalf` must read `LOCAL_KEYS`, not a
   *  second copy of it: every block that peels anything has to be reachable by this predicate, so
   *  removing a block from the table is observable here rather than silently narrowing the guard. */
  it('can report every block that peels at least one key', () => {
    const reported = new Set<string>();
    for (const block of CACHE_BLOCKS) {
      const p = path.join(tmpRoot, `${block}-probe.bin`);
      fs.writeFileSync(p + '.meta.json', JSON.stringify({ id: 'g', [block]: { hash: 'h' } }));
      for (const b of blocksMissingLocalHalf(p)) reported.add(b);
    }
    // Every block currently peels something, so every one of them is detectable.
    expect([...reported].sort()).toEqual([...CACHE_BLOCKS].sort());
  });
});

describe('reimportTypeForBlock', () => {
  it('names the reimport handler type for every cache block', () => {
    expect(CACHE_BLOCKS.map(reimportTypeForBlock).sort())
      .toEqual(['atlas', 'audio', 'environment', 'font', 'model', 'texture', 'video']);
  });

  /** Cross-checks the derived names against the OTHER place that names them — the registration
   *  calls in the scanner. Two independent lists, so this catches "somebody added a cache block and
   *  there is no handler that can regenerate it", which is the one way the derivation can be wrong.
   *
   *  Read from source rather than from `getReimportTypes()` because registration happens inside a
   *  Vite plugin hook, so the registry is empty in a unit test. ⚠️ **Through the PARSER, not a
   *  regex** — #1179's class, and `commentStripperIsShared` enforces it: a pattern run over raw
   *  source reads a commented-out or wrapped call as a live one, and this guard's failure direction
   *  (a missing handler must be RED) is exactly the one a text-shape reader gets wrong. */
  it('names a type the scanner actually registers a handler for', () => {
    const file = path.join(__dirname, '../../plugins/vite-asset-scanner.ts');
    const sf = parseSource(fs.readFileSync(file, 'utf-8'), 'vite-asset-scanner.ts');
    const registered = new Set(
      callsTo(sf, 'registerReimportHandler')
        .map((c) => c.arguments[0])
        .filter((a): a is ts.StringLiteral => a !== undefined && ts.isStringLiteral(a))
        .map((a) => a.text),
    );
    expect(registered.size).toBeGreaterThan(0); // the call still parses as we think it does
    for (const block of CACHE_BLOCKS) {
      expect(registered.has(reimportTypeForBlock(block)), `${block} → no registered reimport handler`).toBe(true);
    }
  });
});

describe('scheduleLocalHalfHeal', () => {
  /** Collects the deferred work instead of running it, so a test can assert the route returned
   *  BEFORE the handler ran — the property that protects a 216-path batch select. */
  function collector() {
    const deferred: Array<() => Promise<void>> = [];
    const ran: string[] = [];
    return {
      deferred, ran,
      deps: (handler?: (url: string, abs: string) => Promise<void>) => ({
        getHandler: (type: string) => handler ? ((url: string, abs: string) => { ran.push(type); return handler(url, abs); }) : undefined,
        defer: (fn: () => Promise<void>) => { deferred.push(fn); },
      }),
      flush: async () => { for (const fn of deferred.splice(0)) await fn(); },
    };
  }

  it('schedules a heal for an asset missing its local half', () => {
    writeCommittedOnly({ id: 'g', version: 2, audioCache: { hash: 'h' } });
    const c = collector();
    expect(scheduleLocalHalfHeal('/assets/a.mp3', absPath, c.deps(async () => {}))).toBe('scheduled');
    expect(c.deferred).toHaveLength(1);
  });

  /** ⚠️ The accept side. Without this, a fix that healed unconditionally would pass every other
   *  test in this file while re-probing on every single Inspector open. */
  it('does NOT schedule when the local half is already complete', () => {
    writeCommittedOnly({ id: 'g', version: 2, audioCache: { hash: 'h' } });
    writeLocal({ audioCache: { durationSec: 1.5 } });
    const c = collector();
    expect(scheduleLocalHalfHeal('/assets/a.mp3', absPath, c.deps(async () => {}))).toBe('complete');
    expect(c.deferred).toHaveLength(0);
  });

  /** The response must be built and returned without the probe. `deferred` holding work that has
   *  not run yet IS the assertion — the handler records into `ran`, and `ran` is still empty. */
  it('returns before the handler runs (the route must not stall on a probe)', async () => {
    writeCommittedOnly({ id: 'g', version: 2, audioCache: { hash: 'h' } });
    const c = collector();
    scheduleLocalHalfHeal('/assets/a.mp3', absPath, c.deps(async () => {}));
    expect(c.ran).toEqual([]);      // scheduled, definitively not yet executed
    await c.flush();
    expect(c.ran).toEqual(['audio']); // and it really was the audio handler that was queued
  });

  it('schedules only once per asset, however many times the Inspector reads it', () => {
    writeCommittedOnly({ id: 'g', version: 2, audioCache: { hash: 'h' } });
    const c = collector();
    expect(scheduleLocalHalfHeal('/assets/a.mp3', absPath, c.deps(async () => {}))).toBe('scheduled');
    expect(scheduleLocalHalfHeal('/assets/a.mp3', absPath, c.deps(async () => {}))).toBe('already-attempted');
    expect(c.deferred).toHaveLength(1);
  });

  /** ⚠️ The retry-storm guard. A machine with no ffprobe can never satisfy this, so a failed
   *  attempt must still count as an attempt — otherwise the sidecar stays incomplete, the next read
   *  schedules again, and every Inspector open pays for a probe that cannot succeed. */
  it('remembers an attempt that FAILED, and does not retry it', async () => {
    writeCommittedOnly({ id: 'g', version: 2, audioCache: { hash: 'h' } });
    const c = collector();
    scheduleLocalHalfHeal('/assets/a.mp3', absPath, c.deps(async () => { throw new Error('no ffprobe'); }));
    await c.flush(); // the throw is swallowed — a GET that already answered must not reject
    expect(scheduleLocalHalfHeal('/assets/a.mp3', absPath, c.deps(async () => {}))).toBe('already-attempted');
  });

  /** ...but the memo is keyed on the sidecar's hash, so a genuine re-import gets a fresh attempt.
   *  This is what stops the "remembered forever" behaviour above from being permanent. */
  it('attempts again once the committed sidecar changes', () => {
    writeCommittedOnly({ id: 'g', version: 2, audioCache: { hash: 'h' } });
    const c = collector();
    scheduleLocalHalfHeal('/assets/a.mp3', absPath, c.deps(async () => {}));
    writeCommittedOnly({ id: 'g', version: 2, audioCache: { hash: 'DIFFERENT' } });
    expect(scheduleLocalHalfHeal('/assets/a.mp3', absPath, c.deps(async () => {}))).toBe('scheduled');
  });

  /** ⚠️ Writing the local half is only half a heal — the OPEN panel has to re-read it. The asset
   *  views refresh off `useAssetInvalidationEpoch`, which the router drives from this callback, so
   *  the TYPE has to survive: `invalidate-assets` is keyed on it. Observed live before this was
   *  wired — a texture panel kept rendering '—' with `variantBytes` already on disk, which is the
   *  "it never comes back" symptom the whole change exists to remove. */
  it('hands the healed asset AND its reimport type to onHealed', async () => {
    writeCommittedOnly({ id: 'g', version: 2, audioCache: { hash: 'h' } });
    const c = collector();
    const seen: Array<[string, string]> = [];
    scheduleLocalHalfHeal('/assets/a.mp3', absPath, {
      ...c.deps(async () => {}),
      onHealed: (p, type) => { seen.push([p, type]); },
    });
    await c.flush();
    expect(seen).toEqual([['/assets/a.mp3', 'audio']]);
  });

  it('does not announce a heal that threw', async () => {
    writeCommittedOnly({ id: 'g', version: 2, audioCache: { hash: 'h' } });
    const c = collector();
    const seen: string[] = [];
    scheduleLocalHalfHeal('/assets/a.mp3', absPath, {
      ...c.deps(async () => { throw new Error('no ffprobe'); }),
      onHealed: (p) => { seen.push(p); },
    });
    await c.flush();
    expect(seen).toEqual([]);
  });

  /** ⚠️ **The invariant, and the close-out's most dangerous finding.** The reimport handlers rebuild
   *  their whole block in canonical key order and stamp `meta.type`, so on a sidecar whose committed
   *  shape predates that, the rewrite is byte-different — measured, **43 of 282 committed texture
   *  sidecars**. Since this runs behind a GET, that would make merely CLICKING an asset dirty a
   *  tracked `games/**` file (CLAUDE.md's "never `git add -A`" rule, #18), and it is invisible to
   *  `metaSidecarChurn` because no peeled value is present. */
  it('restores the committed sidecar byte-for-byte when the handler rewrites it', async () => {
    writeCommittedOnly({ id: 'g', version: 2, audioCache: { hash: 'h', ext: 'mp3' } });
    const before = fs.readFileSync(absPath + '.meta.json');
    const c = collector();
    scheduleLocalHalfHeal('/assets/a.mp3', absPath, c.deps(async () => {
      // What a real handler does: rewrite the committed half in ITS key order, and the local half.
      fs.writeFileSync(absPath + '.meta.json', JSON.stringify({ version: 2, id: 'g', type: 'audio', audioCache: { ext: 'mp3', hash: 'h' } }, null, 2) + '\n');
      writeLocal({ audioCache: { durationSec: 3.5, bytes: 10 } });
    }));
    await c.flush();
    expect(fs.readFileSync(absPath + '.meta.json').equals(before)).toBe(true);
    // ...and the heal's actual product survives the restore — otherwise this "fix" would undo itself.
    expect(blocksMissingLocalHalf(absPath)).toEqual([]);
  });

  it('restores the committed sidecar even when the handler then threw', async () => {
    writeCommittedOnly({ id: 'g', version: 2, audioCache: { hash: 'h', ext: 'mp3' } });
    const before = fs.readFileSync(absPath + '.meta.json');
    const c = collector();
    scheduleLocalHalfHeal('/assets/a.mp3', absPath, c.deps(async () => {
      fs.writeFileSync(absPath + '.meta.json', '{"half":"written"}');
      throw new Error('died mid-write');
    }));
    await c.flush();
    expect(fs.readFileSync(absPath + '.meta.json').equals(before)).toBe(true);
  });

  /** ⚠️ The park gate (#882): the handlers read settings from DISK, so baking while an edit is
   *  parked converts with the PRE-EDIT settings. A refusal must RELEASE the memo — a park is "not
   *  now", and leaving the key set would strand the asset until the process restarted. */
  it('abandons the heal while an edit is parked, and lets a later read retry', async () => {
    writeCommittedOnly({ id: 'g', version: 2, audioCache: { hash: 'h' } });
    const c = collector();
    let parked = true;
    scheduleLocalHalfHeal('/assets/a.mp3', absPath, {
      ...c.deps(async () => {}),
      beforeRun: async () => !parked,
    });
    await c.flush();
    expect(c.ran).toEqual([]);            // gate held it
    parked = false;
    expect(scheduleLocalHalfHeal('/assets/a.mp3', absPath, c.deps(async () => {}))).toBe('scheduled');
    await c.flush();
    expect(c.ran).toEqual(['audio']);     // and the retry actually ran
  });

  it('treats a throwing gate as closed rather than proceeding', async () => {
    writeCommittedOnly({ id: 'g', version: 2, audioCache: { hash: 'h' } });
    const c = collector();
    scheduleLocalHalfHeal('/assets/a.mp3', absPath, {
      ...c.deps(async () => {}),
      beforeRun: async () => { throw new Error('probe failed'); },
    });
    await c.flush();
    expect(c.ran).toEqual([]);
  });

  /** ⚠️ Not tidiness: `metaBatchLoad` sends one GET per path in a multi-selection through
   *  `Promise.all`, and a heal is a full `toktx`/ffmpeg encode whenever the artifact cache is cold —
   *  106 of this clone's 215 healable textures are. Uncapped, selecting a folder starts a hundred
   *  concurrent encoders from a GET. */
  it('runs at most two heals concurrently', async () => {
    let concurrent = 0;
    let peak = 0;
    const release: Array<() => void> = [];
    const started: Array<Promise<void>> = [];
    for (let i = 0; i < 6; i++) {
      const p = path.join(tmpRoot, `clip${i}.mp3`);
      fs.writeFileSync(p + '.meta.json', JSON.stringify({ id: `g${i}`, audioCache: { hash: `h${i}` } }));
      scheduleLocalHalfHeal(`/assets/clip${i}.mp3`, p, {
        getHandler: () => async () => {
          concurrent++; peak = Math.max(peak, concurrent);
          await new Promise<void>((r) => release.push(r));
          concurrent--;
        },
        defer: (fn) => { started.push(fn()); },
      });
    }
    // Let the first slots take hold, then drain.
    await new Promise((r) => setTimeout(r, 0));
    expect(peak).toBeLessThanOrEqual(2);
    while (release.length) { release.shift()!(); await new Promise((r) => setTimeout(r, 0)); }
    await Promise.all(started);
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThan(0); // the cap must not be "never runs"
  });

  it('reports no-handler rather than scheduling when the type cannot be re-imported', () => {
    writeCommittedOnly({ id: 'g', version: 2, audioCache: { hash: 'h' } });
    const c = collector();
    expect(scheduleLocalHalfHeal('/assets/a.mp3', absPath, c.deps(undefined))).toBe('no-handler');
    expect(c.deferred).toHaveLength(0);
  });

  it('does not mark an attempt it never scheduled (a handler arriving later still gets its turn)', () => {
    writeCommittedOnly({ id: 'g', version: 2, audioCache: { hash: 'h' } });
    const c = collector();
    scheduleLocalHalfHeal('/assets/a.mp3', absPath, c.deps(undefined));
    expect(scheduleLocalHalfHeal('/assets/a.mp3', absPath, c.deps(async () => {}))).toBe('scheduled');
  });
});
