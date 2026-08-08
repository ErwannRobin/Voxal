import Foundation
import AVFoundation
import Capacitor

/// Owns the app's AVAudioSession *category*, and with it the choice between the
/// loudspeaker and the receiver (earpiece).
///
/// Two things make this less obvious than it looks:
///
///  * `overrideOutputAudioPort(.speaker)` is a hard override that beats a
///    connected headset, which is never what a user wants. So neither route uses
///    it: the loudspeaker comes from the `.defaultToSpeaker` category *option*
///    and the earpiece from its absence, and both then clear any lingering
///    override with `.none`. A wired or Bluetooth headset outranks the category
///    default, so it keeps the audio in either mode.
///  * The category is reset by things we do not control — audio interruptions,
///    and WKWebView reconfiguring the session when `getUserMedia()` starts. So
///    the desired route is remembered here and re-applied on every route change.
///
/// `setActive(_:)` is deliberately never called: on iOS 16+ `PTChannelManager`
/// owns activation exclusively (see KNOWLEDGE/learning.md), and activating the
/// session behind its back disrupts the live WebRTC pipeline.
enum AudioRoute: String {
    case speaker
    case earpiece

    private static let stateQueue = DispatchQueue(label: "app.voxal.audioroute")
    private static var _desired: AudioRoute = .speaker

    static var desired: AudioRoute {
        get { stateQueue.sync { _desired } }
        set { stateQueue.sync { _desired = newValue } }
    }

    private var categoryOptions: AVAudioSession.CategoryOptions {
        let base: AVAudioSession.CategoryOptions = [.allowBluetooth, .allowBluetoothA2DP]
        return self == .speaker ? base.union(.defaultToSpeaker) : base
    }

    /// Applies `desired` to the shared session. Errors are logged rather than
    /// swallowed — an unchecked `NSError` here is the documented reason these
    /// calls appear to "do nothing".
    @discardableResult
    static func apply() -> Bool {
        let session = AVAudioSession.sharedInstance()
        let route = desired
        do {
            try session.setCategory(.playAndRecord, mode: .voiceChat, options: route.categoryOptions)
        } catch {
            print("[AudioRoute] setCategory(\(route.rawValue)) failed: \(error)")
            return false
        }
        do {
            try session.overrideOutputAudioPort(.none)
        } catch {
            print("[AudioRoute] overrideOutputAudioPort failed: \(error)")
            return false
        }
        return true
    }

    /// What the system is *actually* playing through right now, which is not
    /// always what was asked for — a headset wins over both routes.
    static var current: AudioRoute {
        let outputs = AVAudioSession.sharedInstance().currentRoute.outputs
        return outputs.contains { $0.portType == .builtInReceiver } ? .earpiece : .speaker
    }
}

@objc(AudioRoutePlugin)
public class AudioRoutePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AudioRoutePlugin"
    public let jsName     = "AudioRoute"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getRoute", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setRoute", returnType: CAPPluginReturnPromise),
    ]

    public override func load() {
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleRouteChange),
            name: AVAudioSession.routeChangeNotification,
            object: nil
        )
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    /// A route change means the category may have been reconfigured underneath
    /// us. Re-apply, unless the change *is* a new device being plugged in — then
    /// the system picked the headset and we must not fight it.
    @objc private func handleRouteChange(_ notification: Notification) {
        guard let raw = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
              let reason = AVAudioSession.RouteChangeReason(rawValue: raw) else { return }
        switch reason {
        case .newDeviceAvailable, .oldDeviceUnavailable, .override:
            return
        default:
            AudioRoute.apply()
        }
    }

    @objc func getRoute(_ call: CAPPluginCall) {
        call.resolve([
            "route": AudioRoute.desired.rawValue,
            "actual": AudioRoute.current.rawValue
        ])
    }

    @objc func setRoute(_ call: CAPPluginCall) {
        guard let raw = call.getString("route"), let route = AudioRoute(rawValue: raw) else {
            call.reject("route must be \"speaker\" or \"earpiece\"")
            return
        }
        AudioRoute.desired = route
        guard AudioRoute.apply() else {
            call.reject("Failed to apply the \(raw) audio route")
            return
        }
        call.resolve([
            "route": route.rawValue,
            "actual": AudioRoute.current.rawValue
        ])
    }
}
