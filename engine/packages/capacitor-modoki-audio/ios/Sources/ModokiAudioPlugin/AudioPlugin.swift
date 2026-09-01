import Foundation
import Capacitor
import AVFoundation

/**
 * Modoki's `AVAudioSession` bridge (#548).
 *
 * iOS sets no audio session category anywhere in this repo, so every game inherits the default
 * `.soloAmbient` — which deactivates whatever another app (Apple Music, a podcast) was playing
 * the instant our own audio starts. This plugin sets a category that MIXES instead, so our own
 * audio does not silence another app's.
 *
 * ⚠️ Every `AVAudioSession` call here is wrapped in do/catch and never traps. A failure to set
 * the category must degrade to the OS default (current behaviour), not crash the splash screen —
 * see `games/court/ios/App/App/AppDelegate.swift`'s doubly-guarded Firebase init for the same
 * defensiveness applied to a different subsystem.
 */
@objc(ModokiAudioPlugin)
public class ModokiAudioPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ModokiAudioPlugin"
    public let jsName = "ModokiAudio"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "configure", returnType: CAPPluginReturnPromise)
    ]

    private static let allowedCategories = ["ambient", "playback"]

    /// `load()` is the early-init hook — it runs after `didFinishLaunching` but before any
    /// playback, which is all setting the default category needs. `configure()` can still
    /// override it later (e.g. once `project.config.json` is read on the JS side), but a
    /// reasonable default is in place from the very first frame either way.
    public override func load() {
        applyCategory(.ambient)
    }

    private func applyCategory(_ category: AVAudioSession.Category) {
        do {
            try AVAudioSession.sharedInstance().setCategory(category, options: [.mixWithOthers])
            try AVAudioSession.sharedInstance().setActive(true)
        } catch {
            // Degrade to whatever category the session already has (the OS default,
            // `.soloAmbient`) rather than crash — see the class header.
            print("[ModokiAudio] failed to set AVAudioSession category: \(error.localizedDescription)")
        }
    }

    @objc func configure(_ call: CAPPluginCall) {
        guard let raw = call.getString("category"), Self.allowedCategories.contains(raw) else {
            call.reject("category must be one of: \(Self.allowedCategories.joined(separator: ", "))")
            return
        }
        let category: AVAudioSession.Category = raw == "playback" ? .playback : .ambient
        applyCategory(category)
        call.resolve()
    }
}
