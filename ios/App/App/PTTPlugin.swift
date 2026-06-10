import Foundation
import Capacitor
import PushToTalk
import AVFoundation

// MARK: - Restoration delegate (no-op — we don't persist rooms across app kill)

@available(iOS 16.0, *)
private class PTTRestorationDelegate: NSObject, PTChannelRestorationDelegate {
    func channelDescriptor(restoringActiveChannelUUID uuid: UUID) -> PTChannelDescriptor {
        // Return a generic descriptor; JS will call leave() immediately on launch
        // if there is no active room.
        return PTChannelDescriptor(name: "Voxal", image: nil)
    }
}

// MARK: - Channel manager delegate

@available(iOS 16.0, *)
private class PTTChannelDelegate: NSObject, PTChannelManagerDelegate {
    weak var plugin: PTTPlugin?

    /// Called by the system when the PTT button (Dynamic Island / Lock Screen) is pressed
    /// OR when the in-app button calls requestBeginTransmitting.
    func channelManager(_ channelManager: PTChannelManager,
                        didActivateAudioSession audioSession: AVAudioSession) {
        do {
            try audioSession.setCategory(.playAndRecord,
                                         mode: .voiceChat,
                                         options: [.allowBluetooth, .allowBluetoothA2DP, .defaultToSpeaker])
            try audioSession.setActive(true)
        } catch {
            print("[PTT] Audio session activation failed: \(error)")
        }
        plugin?.notifyListeners("ptt-press", data: [:])
    }

    /// Called when PTT is released.
    func channelManager(_ channelManager: PTChannelManager,
                        didDeactivateAudioSession audioSession: AVAudioSession) {
        try? audioSession.setActive(false, options: .notifyOthersOnDeactivation)
        plugin?.notifyListeners("ptt-release", data: [:])
    }

    /// The framework may issue ephemeral APNs push tokens for remote wakeup.
    /// Serverless — we don't use a push server, so we discard it.
    func channelManager(_ channelManager: PTChannelManager,
                        receivedEphemeralPushToken pushToken: Data) {}

    func channelManager(_ channelManager: PTChannelManager,
                        failedToJoinChannel channelUUID: UUID, error: Error) {
        plugin?.notifyListeners("ptt-error", data: ["message": error.localizedDescription])
    }

    func channelManager(_ channelManager: PTChannelManager,
                        failedToLeaveChannel channelUUID: UUID, error: Error) {
        print("[PTT] Failed to leave channel: \(error)")
    }
}

// MARK: - Capacitor Plugin

@objc(PTTPlugin)
public class PTTPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier  = "PTTPlugin"
    public let jsName      = "PTTPlugin"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "join",             returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "leave",            returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startTransmitting", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopTransmitting",  returnType: CAPPluginReturnPromise),
    ]

    private var channelManager: PTChannelManager?
    private var channelDelegate: PTTChannelDelegate?
    private var restorationDelegate: PTTRestorationDelegate?
    private var activeChannelUUID: UUID?

    public override func load() {
        guard #available(iOS 16.0, *) else { return }
        channelDelegate      = PTTChannelDelegate()
        channelDelegate?.plugin = self
        restorationDelegate  = PTTRestorationDelegate()

        Task {
            do {
                channelManager = try await PTChannelManager.channelManager(
                    delegate: channelDelegate!,
                    restorationDelegate: restorationDelegate!
                )
            } catch {
                print("[PTT] Failed to create channel manager: \(error)")
            }
        }
    }

    // MARK: - JS-callable methods

    @objc func join(_ call: CAPPluginCall) {
        guard #available(iOS 16.0, *), let channelManager else {
            call.resolve(["supported": false]); return
        }
        let roomName = call.getString("roomName") ?? "Room"
        let uuid     = UUID()
        activeChannelUUID = uuid

        let descriptor = PTChannelDescriptor(name: roomName, image: nil)
        Task {
            do {
                try await channelManager.requestJoinChannel(channelUUID: uuid,
                                                            descriptor: descriptor)
                await MainActor.run { call.resolve(["supported": true]) }
            } catch {
                activeChannelUUID = nil
                await MainActor.run { call.reject(error.localizedDescription) }
            }
        }
    }

    @objc func leave(_ call: CAPPluginCall) {
        guard #available(iOS 16.0, *), let channelManager,
              let uuid = activeChannelUUID else {
            call.resolve(); return
        }
        Task {
            do {
                try await channelManager.requestLeaveChannel(channelUUID: uuid)
            } catch {
                print("[PTT] Leave error: \(error)")
            }
            activeChannelUUID = nil
            await MainActor.run { call.resolve() }
        }
    }

    /// Called by the in-app PTT button so the Dynamic Island shows "transmitting".
    @objc func startTransmitting(_ call: CAPPluginCall) {
        guard #available(iOS 16.0, *), let channelManager,
              let uuid = activeChannelUUID else {
            call.resolve(); return
        }
        channelManager.requestBeginTransmitting(channelUUID: uuid)
        call.resolve()
    }

    @objc func stopTransmitting(_ call: CAPPluginCall) {
        guard #available(iOS 16.0, *), let channelManager,
              let uuid = activeChannelUUID else {
            call.resolve(); return
        }
        channelManager.stopTransmitting(channelUUID: uuid)
        call.resolve()
    }
}
