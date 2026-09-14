import Capacitor
import UIKit

@objc(ModokiSystemPlugin)
public class ModokiSystemPlugin: CAPPlugin, CAPBridgedPlugin {

    public let identifier = "ModokiSystemPlugin"
    public let jsName = "ModokiSystem"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "openAppSettings", returnType: CAPPluginReturnPromise),
    ]

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
