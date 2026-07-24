// Minimal ZIP reader for OTA bundle zips (docs/plans/mobile-ota-updates-plan.md, Phase 1).
//
// Foundation + Compression only (no Capacitor/UIKit) — same reasoning as OtaCore.swift:
// this builds and tests on plain macOS via `swift test`, no device/Xcode project needed.
// Verified against BOTH the matching Node writer (engine/scripts/ota/zip.mjs) and
// independently against the system `unzip`/`zipinfo` CLI's own reading of that same file
// (see the plan doc) — so this isn't just internally self-consistent, it's been checked
// against a third, independent implementation of the ZIP format.
//
// Deliberately narrow: reads the central directory + STORED (method 0) and raw-DEFLATE
// (method 8, Apple's `COMPRESSION_ZLIB` constant name for what is actually raw deflate,
// no zlib header — confirmed by decoding real Node `zlib.deflateRawSync` output) entries
// only. No ZIP64, no encryption, no data descriptors — exactly what ota-publish.mjs's
// writer produces, no more. An OTA bundle zip is content we authored and signed
// ourselves; this is not a general-purpose unzip for arbitrary/adversarial input.

import Compression
import Foundation

public enum OtaZipError: Error {
  case notAZip
  case unsupportedCompressionMethod(UInt16)
  case truncated
  case decompressionFailed(String)
}

public enum OtaZip {
  public struct Entry {
    public let path: String
    public let data: Data
  }

  /// Parses and fully decompresses every entry in `archive`. In-memory (the caller
  /// decides whether/how to stream to disk) — bundle zips are small enough that this is
  /// simple and safe to reason about; a future size-sensitive path can stream instead
  /// without changing the format-parsing logic below.
  public static func unzip(_ archive: Data) throws -> [Entry] {
    let bytes = [UInt8](archive)
    guard let eocdOffset = findEOCD(bytes) else { throw OtaZipError.notAZip }
    let (recordCount, centralDirOffset) = try parseEOCD(bytes, at: eocdOffset)

    var entries: [Entry] = []
    var cursor = Int(centralDirOffset)
    for _ in 0..<recordCount {
      let (entry, next) = try parseCentralDirectoryRecord(bytes, at: cursor)
      entries.append(entry)
      cursor = next
    }
    return entries
  }

  // MARK: - End of central directory

  private static let eocdSignature: [UInt8] = [0x50, 0x4b, 0x05, 0x06]

  /// EOCD is a fixed 22-byte record with a variable trailing comment, so it must be
  /// found by scanning backward from the end (standard ZIP-parsing approach) — assume
  /// no comment (ota-publish.mjs never writes one) but scan a small window regardless in
  /// case a future writer or an unrelated tool appended one.
  private static func findEOCD(_ bytes: [UInt8]) -> Int? {
    guard bytes.count >= 22 else { return nil }
    let searchStart = max(0, bytes.count - 22 - 65536)
    var i = bytes.count - 22
    while i >= searchStart {
      if Array(bytes[i..<i + 4]) == eocdSignature { return i }
      i -= 1
    }
    return nil
  }

  private static func parseEOCD(_ bytes: [UInt8], at offset: Int) throws -> (count: UInt16, centralDirOffset: UInt32) {
    guard offset + 22 <= bytes.count else { throw OtaZipError.truncated }
    let totalRecords = readU16(bytes, offset + 10)
    let centralDirOffset = readU32(bytes, offset + 16)
    return (totalRecords, centralDirOffset)
  }

  // MARK: - Central directory

  private static let centralDirSignature: [UInt8] = [0x50, 0x4b, 0x01, 0x02]

  private static func parseCentralDirectoryRecord(_ bytes: [UInt8], at offset: Int) throws -> (Entry, Int) {
    guard offset + 46 <= bytes.count, Array(bytes[offset..<offset + 4]) == centralDirSignature else {
      throw OtaZipError.notAZip
    }
    let method = readU16(bytes, offset + 10)
    let compressedSize = Int(readU32(bytes, offset + 20))
    let uncompressedSize = Int(readU32(bytes, offset + 24))
    let nameLength = Int(readU16(bytes, offset + 28))
    let extraLength = Int(readU16(bytes, offset + 30))
    let commentLength = Int(readU16(bytes, offset + 32))
    let localHeaderOffset = Int(readU32(bytes, offset + 42))
    let nameStart = offset + 46
    guard nameStart + nameLength <= bytes.count else { throw OtaZipError.truncated }
    let name = String(decoding: bytes[nameStart..<nameStart + nameLength], as: UTF8.self)

    let data = try readLocalEntry(
      bytes, localHeaderOffset: localHeaderOffset, method: method,
      compressedSize: compressedSize, uncompressedSize: uncompressedSize
    )

    let next = nameStart + nameLength + extraLength + commentLength
    return (Entry(path: name, data: data), next)
  }

  // MARK: - Local file header + payload

  private static let localHeaderSignature: [UInt8] = [0x50, 0x4b, 0x03, 0x04]

  private static func readLocalEntry(
    _ bytes: [UInt8], localHeaderOffset: Int, method: UInt16, compressedSize: Int, uncompressedSize: Int
  ) throws -> Data {
    guard localHeaderOffset + 30 <= bytes.count, Array(bytes[localHeaderOffset..<localHeaderOffset + 4]) == localHeaderSignature else {
      throw OtaZipError.notAZip
    }
    let nameLength = Int(readU16(bytes, localHeaderOffset + 26))
    let extraLength = Int(readU16(bytes, localHeaderOffset + 28))
    let payloadStart = localHeaderOffset + 30 + nameLength + extraLength
    guard payloadStart + compressedSize <= bytes.count else { throw OtaZipError.truncated }
    let payload = Array(bytes[payloadStart..<payloadStart + compressedSize])

    switch method {
    case 0: // stored
      return Data(payload)
    case 8: // deflate (raw — no zlib/gzip header, per the ZIP spec)
      return try inflateRaw(payload, expectedSize: uncompressedSize)
    default:
      throw OtaZipError.unsupportedCompressionMethod(method)
    }
  }

  private static func inflateRaw(_ compressed: [UInt8], expectedSize: Int) throws -> Data {
    if expectedSize == 0 { return Data() }
    var output = [UInt8](repeating: 0, count: expectedSize)
    let capacity = output.count
    let decodedSize = output.withUnsafeMutableBytes { dst -> Int in
      compressed.withUnsafeBytes { src -> Int in
        // COMPRESSION_ZLIB here means "raw DEFLATE" (Apple's naming — confirmed by
        // decoding real Node zlib.deflateRawSync output; it is NOT the zlib-wrapped
        // (RFC 1950) format despite the constant's name).
        compression_decode_buffer(
          dst.bindMemory(to: UInt8.self).baseAddress!, capacity,
          src.bindMemory(to: UInt8.self).baseAddress!, compressed.count,
          nil, COMPRESSION_ZLIB
        )
      }
    }
    guard decodedSize == expectedSize else {
      throw OtaZipError.decompressionFailed("expected \(expectedSize) bytes, got \(decodedSize)")
    }
    return Data(output)
  }

  // MARK: - Little-endian readers

  private static func readU16(_ bytes: [UInt8], _ offset: Int) -> UInt16 {
    UInt16(bytes[offset]) | (UInt16(bytes[offset + 1]) << 8)
  }

  private static func readU32(_ bytes: [UInt8], _ offset: Int) -> UInt32 {
    UInt32(bytes[offset]) | (UInt32(bytes[offset + 1]) << 8) | (UInt32(bytes[offset + 2]) << 16) | (UInt32(bytes[offset + 3]) << 24)
  }
}
