import Capacitor
import StoreKit
import UIKit

@objc(ModokiSystemPlugin)
public class ModokiSystemPlugin: CAPPlugin, CAPBridgedPlugin {

    public let identifier = "ModokiSystemPlugin"
    public let jsName = "ModokiSystem"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "openAppSettings", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openUrl", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "copyText", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "kvGetAll", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "kvSet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "kvRemove", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "kvInfo", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestReview", returnType: CAPPluginReturnPromise),
    ]

    private let store = BackupExcludedStore()

    // The backup-excluded key-value store PlayerPrefs uses on iOS (#1271) — see BackupExcludedStore.
    @objc func kvGetAll(_ call: CAPPluginCall) {
        do {
            call.resolve(["entries": try store.getAll(prefix: call.getString("prefix") ?? "")])
        } catch {
            call.reject("kvGetAll failed: \(error.localizedDescription)")
        }
    }

    @objc func kvSet(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), let value = call.getString("value") else {
            call.reject("kvSet needs a string key and value")
            return
        }
        do {
            try store.set(key: key, value: value)
            call.resolve()
        } catch {
            call.reject("kvSet failed: \(error.localizedDescription)")
        }
    }

    @objc func kvRemove(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else {
            call.reject("kvRemove needs a string key")
            return
        }
        do {
            try store.remove(key: key)
            call.resolve()
        } catch {
            call.reject("kvRemove failed: \(error.localizedDescription)")
        }
    }

    @objc func kvInfo(_ call: CAPPluginCall) {
        do {
            call.resolve(try store.info())
        } catch {
            call.reject("kvInfo failed: \(error.localizedDescription)")
        }
    }

    // Plain text on the general pasteboard (#1398) — a player ID the player pastes into a support
    // email. Native because a web-view clipboard write needs the tap's user activation, which an
    // engine-dispatched action cannot promise. UIPasteboard is main-thread UIKit.
    @objc func copyText(_ call: CAPPluginCall) {
        guard let text = call.getString("text"), !text.isEmpty else {
            call.resolve(["copied": false])
            return
        }
        DispatchQueue.main.async {
            UIPasteboard.general.string = text
            call.resolve(["copied": UIPasteboard.general.hasStrings])
        }
    }

    // A web page in Safari (#1196). https only: `UIApplication.open` would also act on `tel:`,
    // `sms:` or another app's custom scheme, which an authored link must never reach.
    @objc func openUrl(_ call: CAPPluginCall) {
        guard let raw = call.getString("url"),
              let url = URL(string: raw),
              url.scheme?.lowercased() == "https",
              url.host != nil else {
            call.resolve(["opened": false])
            return
        }
        DispatchQueue.main.async {
            UIApplication.shared.open(url, options: [:]) { opened in
                call.resolve(["opened": opened])
            }
        }
    }

    @objc func openAppSettings(_ call: CAPPluginCall) {
        let target = call.getString("target") ?? "app"
        DispatchQueue.main.async {
            var urlString = UIApplication.openSettingsURLString
            // The notification-specific page exists only from iOS 16; older versions land on the
            // app's own Settings page, which lists Notifications one tap further in.
            if target == "notifications", #available(iOS 16.0, *) {
                urlString = UIApplication.openNotificationSettingsURLString
            }
            guard let url = URL(string: urlString) else {
                call.resolve(["opened": false])
                return
            }
            UIApplication.shared.open(url, options: [:]) { opened in
                call.resolve(["opened": opened])
            }
        }
    }

    // The OS review prompt (#939). `requested` says only that the request was handed over: StoreKit
    // never reports whether the sheet appeared, and it silently does nothing once its own quota is
    // spent. Resolving false without a window scene rather than rejecting keeps the caller free of
    // platform branching.
    @objc func requestReview(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            // compactMap BEFORE the activation test: `first(where:)` then `as?` takes the first
            // foreground-active scene of ANY type and resolves false if it is not a window scene,
            // although a valid one exists. The ask is already stamped as spent by then, so that
            // costs the install its one opportunity and reports nothing.
            guard let scene = UIApplication.shared.connectedScenes
                .compactMap({ $0 as? UIWindowScene })
                .first(where: { $0.activationState == .foregroundActive }) else {
                call.resolve(["requested": false])
                return
            }
            SKStoreReviewController.requestReview(in: scene)
            call.resolve(["requested": true])
        }
    }
}
