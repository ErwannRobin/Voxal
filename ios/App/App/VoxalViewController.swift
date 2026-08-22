import UIKit
import Capacitor

/// Registers this app's own Swift plugins with the Capacitor bridge.
///
/// Capacitor 6+ builds its iOS plugin registry from `packageClassList` in the
/// generated `capacitor.config.json`, and that list only ever contains plugins
/// installed as npm packages. Plugins that live in the App target — which all of
/// Voxal's do — appear nowhere in it and are therefore never registered, no
/// matter that they compile, conform to `CAPBridgedPlugin` and carry `@objc`.
/// The symptom is `window.Capacitor.Plugins.<name>` being `undefined` in JS with
/// nothing logged natively to explain it.
///
/// `capacitorDidLoad()` is the documented hook for registering them by hand. The
/// storyboard points at this class instead of the stock `CAPBridgeViewController`
/// so that it runs.
///
/// **Add every new app-target plugin here**, or it will silently not exist.
class VoxalViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(PTTPlugin())
        bridge?.registerPluginInstance(AudioRoutePlugin())
        bridge?.registerPluginInstance(ScreenCapturePlugin())
    }
}
