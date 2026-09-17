/** #1305 — a peel migration deletes the committed value and cannot seed the gitignored local half,
 *  so nothing ever put it back. The route REPORTS the gap and the human's Re-import repairs it; this
 *  file pins the report's predicate — that an absent local half is noticed and a present one is
 *  left alone — and that the repair the hint offers exists for every block. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { blocksMissingLocalHalf, CACHE_BLOCKS, writeMetaSidecar, peelSchemaId } from '../../plugins/meta-sidecar';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';
import { parseSource, callsTo } from '@modoki/engine/testing/sourceAst';
import ts from 'typescript';

let tmpRoot: string;
let absPath: string;

beforeEach(() => {
  tmpRoot = makeScratchDir('modoki-local-half-');
  absPath = path.join(tmpRoot, 'asset.mp3');
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

/** The Inspector's hint tells the human to RE-IMPORT, for any block the route reports — so every
 *  cache block must have a reimport handler that regenerates it, or the hint offers an action that
 *  does not exist. Block → type is `<type>Cache` by convention; the table below pins that the
 *  convention still holds, and the scanner check pins that a handler is registered under it. */
const reimportTypeForBlock = (block: string): string => block.replace(/Cache$/, '');

describe('every reportable block has a re-import that can fill it', () => {
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
