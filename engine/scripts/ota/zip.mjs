/** Minimal ZIP writer for OTA bundle zips (Phase 1 of
 *  docs/plans/mobile-ota-updates-plan.md). Produces a standard ZIP (local file
 *  headers + central directory + EOCD, per the classic APPNOTE.TXT layout) using
 *  only Node's built-in `zlib`/`crypto` — no dependency. Cross-verified against
 *  both the system `unzip` CLI and a from-scratch Swift reader (OtaZip.swift) using
 *  Apple's Compression framework — see the plan doc's Phase 1 section for the
 *  round-trip check. Entries use STORED (method 0) when deflating doesn't actually
 *  shrink the data (tiny/incompressible files), DEFLATE (method 8, raw — no zlib
 *  header, matching the ZIP spec) otherwise.
 *
 *  Deliberately NOT a general-purpose ZIP library: no encryption, no ZIP64, no
 *  directory entries, no extra fields, no comments — exactly what a bundle zip
 *  needs and nothing else, so the format surface a native reader has to trust is
 *  as small as possible. */

import { deflateRawSync, crc32 } from 'node:zlib';

function u16le(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n & 0xffff, 0); return b; }
function u32le(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; }

/** Builds a ZIP archive buffer from `entries` — an array of `{ path, data }`
 *  (`path` relative, forward-slash, no leading "/"; `data` a Buffer). */
export function buildZip(entries) {
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const { path, data } of entries) {
    const nameBuf = Buffer.from(path, 'utf8');
    const crc = crc32(data) >>> 0;
    const deflated = deflateRawSync(data);
    const useDeflate = deflated.length < data.length;
    const method = useDeflate ? 8 : 0;
    const payload = useDeflate ? deflated : data;

    const localHeader = Buffer.concat([
      u32le(0x04034b50),
      u16le(20), // version needed
      u16le(0), // flags
      u16le(method),
      u16le(0), u16le(0), // mod time/date — not meaningful for a content-addressed bundle
      u32le(crc),
      u32le(payload.length),
      u32le(data.length),
      u16le(nameBuf.length),
      u16le(0), // extra field length
      nameBuf,
    ]);
    localChunks.push(localHeader, payload);

    const centralHeader = Buffer.concat([
      u32le(0x02014b50),
      u16le(20), // version made by
      u16le(20), // version needed
      u16le(0), // flags
      u16le(method),
      u16le(0), u16le(0),
      u32le(crc),
      u32le(payload.length),
      u32le(data.length),
      u16le(nameBuf.length),
      u16le(0), u16le(0), // extra field / comment length
      u16le(0), // disk number start
      u16le(0), // internal attrs
      u32le(0), // external attrs
      u32le(offset), // offset of local header
      nameBuf,
    ]);
    centralChunks.push(centralHeader);

    offset += localHeader.length + payload.length;
  }

  const centralDir = Buffer.concat(centralChunks);
  const eocd = Buffer.concat([
    u32le(0x06054b50),
    u16le(0), u16le(0), // disk numbers
    u16le(entries.length), // records on this disk
    u16le(entries.length), // total records
    u32le(centralDir.length),
    u32le(offset), // central directory offset
    u16le(0), // comment length
  ]);

  return Buffer.concat([...localChunks, centralDir, eocd]);
}

/** Builds a ZIP from every file under `distDir` (relative paths, forward-slash),
 *  given a pre-computed `files` map (path -> absolute path is derived by the
 *  caller) — kept as a thin convenience over buildZip for ota-publish.mjs. */
export async function buildZipFromDir(distDir, relPaths) {
  const { readFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const entries = [];
  for (const rel of relPaths) {
    entries.push({ path: rel, data: await readFile(path.join(distDir, rel)) });
  }
  return buildZip(entries);
}
