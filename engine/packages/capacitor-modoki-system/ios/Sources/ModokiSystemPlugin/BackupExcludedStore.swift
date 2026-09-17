import CryptoKit
import Foundation

/// A key-value store whose files iCloud and Finder backups never copy (#1271).
///
/// PlayerPrefs used to live in UserDefaults, which sits under `Library/Preferences` and is part of
/// every device backup, with no way to leave single keys out. A new iPhone restored from a backup
/// then came back holding a days-old save, as Android did before #1267 turned its backup off.
///
/// One file per key, in `Library/Application Support/modoki-prefs/`:
/// - The DIRECTORY carries `isExcludedFromBackup`, which Apple documents as covering everything
///   inside it. It is re-applied on every open, because the flag is a resource value on this one
///   directory and costs nothing to set again.
/// - A file is named by the SHA-256 of its key, so no key length or character can make an invalid
///   file name. The key itself is stored inside the file, next to the value.
/// - Each write is `Data.write(.atomic)` (temp file + rename), so a reader never sees a torn value.
///   That is the per-key atomicity the engine's `PrefsBackend` contract requires.
///
/// Every call runs on one serial queue, so two calls from different bridge threads never interleave.
final class BackupExcludedStore {
    private let queue = DispatchQueue(label: "com.modokiengine.system.kvstore")
    private var dir: URL?

    private func directory() throws -> URL {
        if let dir { return dir }
        let base = try FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        var url = base.appendingPathComponent("modoki-prefs", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try url.setResourceValues(values)
        dir = url
        return url
    }

    private func fileURL(_ key: String, in dir: URL) -> URL {
        let digest = SHA256.hash(data: Data(key.utf8)).map { String(format: "%02x", $0) }.joined()
        return dir.appendingPathComponent(digest + ".kv", isDirectory: false)
    }

    func getAll(prefix: String) throws -> [String: String] {
        try queue.sync {
            let dir = try directory()
            let names = try FileManager.default.contentsOfDirectory(atPath: dir.path)
            var out: [String: String] = [:]
            for name in names where name.hasSuffix(".kv") {
                // A file that cannot be read or parsed is skipped, not fatal: one bad entry must not
                // hide the rest of the save.
                guard let data = try? Data(contentsOf: dir.appendingPathComponent(name)),
                      let obj = try? JSONSerialization.jsonObject(with: data) as? [String: String],
                      let key = obj["k"], let value = obj["v"],
                      key.hasPrefix(prefix) else { continue }
                out[key] = value
            }
            return out
        }
    }

    func set(key: String, value: String) throws {
        try queue.sync {
            let dir = try directory()
            let data = try JSONSerialization.data(withJSONObject: ["k": key, "v": value])
            try data.write(to: fileURL(key, in: dir), options: .atomic)
        }
    }

    func remove(key: String) throws {
        try queue.sync {
            let dir = try directory()
            do {
                try FileManager.default.removeItem(at: fileURL(key, in: dir))
            } catch CocoaError.fileNoSuchFile {
                // Already gone — removing a missing key is a no-op, as UserDefaults treats it.
            }
        }
    }

    /// What a device check needs to confirm the store is really out of backup.
    func info() throws -> [String: Any] {
        try queue.sync {
            let dir = try directory()
            let values = try dir.resourceValues(forKeys: [.isExcludedFromBackupKey])
            let count = (try? FileManager.default.contentsOfDirectory(atPath: dir.path))?
                .filter { $0.hasSuffix(".kv") }.count ?? 0
            return [
                "path": dir.path,
                "excludedFromBackup": values.isExcludedFromBackup ?? false,
                "entries": count,
            ]
        }
    }
}
