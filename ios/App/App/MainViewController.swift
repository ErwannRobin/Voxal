import UIKit
import Capacitor

/// The app's bridge view controller (Main.storyboard's initial controller).
///
/// Capacitor 6+ registers only the npm plugins listed in `capacitor.config.json`'s
/// `packageClassList`, which `npx cap sync` rewrites from `node_modules` — so a
/// plugin that lives in this app target is never found on its own and
/// `Capacitor.Plugins.X` stays undefined. Each one is registered here instead.
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(PTTPlugin())
        bridge?.registerPluginInstance(AudioRoutePlugin())
        bridge?.registerPluginInstance(VisionMaskPlugin())
    }
}
