import UIKit
import Capacitor
import AVFoundation

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        configureAudioSession()
        return true
    }

    // MARK: - Audio Session

    private func configureAudioSession() {
        let session = AVAudioSession.sharedInstance()
        do {
            // .playAndRecord  — simultaneous mic input + speaker output (required for WebRTC)
            // .voiceChat      — system-level echo cancellation & noise reduction
            // .allowBluetooth — Bluetooth headsets work as input
            // .defaultToSpeaker — audio routes to speaker, not earpiece
            try session.setCategory(
                .playAndRecord,
                mode: .voiceChat,
                options: [.allowBluetooth, .allowBluetoothA2DP, .defaultToSpeaker]
            )
            try session.setActive(true)
        } catch {
            print("[AVAudioSession] Configuration failed: \(error)")
        }
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Keep the audio session active so WebRTC streams survive backgrounding.
        // UIBackgroundModes = [audio, voip] in Info.plist tells iOS not to
        // suspend the process; this call ensures the session stays live.
        try? AVAudioSession.sharedInstance().setActive(true)
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Re-configure in case another app interrupted the session
        // (phone call, Siri, etc.) while we were backgrounded.
        configureAudioSession()
    }

    // MARK: - Capacitor / URL handling

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }
}
