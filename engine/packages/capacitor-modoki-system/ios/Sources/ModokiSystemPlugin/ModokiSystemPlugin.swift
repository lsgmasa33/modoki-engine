import Capacitor
import UIKit

@objc(ModokiSystemPlugin)
public class ModokiSystemPlugin: CAPPlugin, CAPBridgedPlugin {

    public let identifier = "ModokiSystemPlugin"
    public let jsName = "ModokiSystem"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "openAppSettings", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openUrl", returnType: CAPPluginReturnPromise),
    ]

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
