import Capacitor
import UIKit

@objc(ModokiSystemPlugin)
public class ModokiSystemPlugin: CAPPlugin, CAPBridgedPlugin {

    public let identifier = "ModokiSystemPlugin"
    public let jsName = "ModokiSystem"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "openAppSettings", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openUrl", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "kvGetAll", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "kvSet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "kvRemove", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "kvInfo", returnType: CAPPluginReturnPromise),
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
}
