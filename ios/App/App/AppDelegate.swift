import UIKit
import Capacitor
import AVFoundation

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?
    var backgroundTask: UIBackgroundTaskIdentifier = .invalid

    // Native audio keep-alive: plays a near-silent 1 Hz sine via AVAudioEngine.
    // This holds AVAudioSession active in background, which in turn prevents iOS
    // from suspending the WKWebView JavaScript engine.
    private var audioEngine: AVAudioEngine?
    private var keepAlivePlayer: AVAudioPlayerNode?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        configureAudioSession()
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleAudioInterruption),
            name: AVAudioSession.interruptionNotification,
            object: nil
        )
        return true
    }

    // MARK: - Deep link handler

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        // Let Capacitor handle it first (fires appUrlOpen in JS via @capacitor/app)
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    // MARK: - Audio Session

    private func configureAudioSession() {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playAndRecord,
                                    mode: .voiceChat,
                                    options: [.allowBluetooth, .allowBluetoothA2DP, .defaultToSpeaker])
            try session.setActive(true)
        } catch {
            print("[AVAudioSession] Configuration failed: \(error)")
        }
    }

    @objc private func handleAudioInterruption(_ notification: Notification) {
        guard let info = notification.userInfo,
              let typeValue = info[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: typeValue) else { return }
        if type == .ended {
            configureAudioSession()
            startNativeKeepAlive()
        }
    }

    // MARK: - Native keep-alive engine

    private func startNativeKeepAlive() {
        guard audioEngine == nil else { return }

        let engine = AVAudioEngine()
        let player = AVAudioPlayerNode()
        audioEngine   = engine
        keepAlivePlayer = player

        engine.attach(player)
        let sampleRate: Double = 44100
        let format = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 1)!
        engine.connect(player, to: engine.mainMixerNode, format: format)
        engine.mainMixerNode.outputVolume = 0.01 // nearly inaudible

        // 1 Hz sine wave at −60 dB: non-zero samples iOS won't treat as silence
        let frameCount = AVAudioFrameCount(sampleRate)
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frameCount) else { return }
        buffer.frameLength = frameCount
        for i in 0..<Int(frameCount) {
            buffer.floatChannelData?[0][i] = 0.001 * Float(sin(2.0 * .pi * 1.0 * Double(i) / sampleRate))
        }

        do {
            try engine.start()
            player.scheduleBuffer(buffer, at: nil, options: .loops, completionHandler: nil)
            player.play()
        } catch {
            print("[AVAudioEngine] Keep-alive start failed: \(error)")
            audioEngine = nil
            keepAlivePlayer = nil
        }
    }

    private func stopNativeKeepAlive() {
        keepAlivePlayer?.stop()
        audioEngine?.stop()
        audioEngine     = nil
        keepAlivePlayer = nil
    }

    // MARK: - App lifecycle

    func applicationDidEnterBackground(_ application: UIApplication) {
        try? AVAudioSession.sharedInstance().setActive(true)
        startNativeKeepAlive()
        backgroundTask = application.beginBackgroundTask(withName: "VoxelAudio") {
            application.endBackgroundTask(self.backgroundTask)
            self.backgroundTask = .invalid
        }
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        stopNativeKeepAlive()
        configureAudioSession()
        if backgroundTask != .invalid {
            UIApplication.shared.endBackgroundTask(backgroundTask)
            backgroundTask = .invalid
        }
    }

    // MARK: - Capacitor / URL handling

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }
}
