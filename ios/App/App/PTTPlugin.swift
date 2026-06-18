import Foundation
import Capacitor
import PushToTalk
import AVFoundation

// Bridges Apple's PushToTalk framework (iOS 16+) to the web layer so a user can
// transmit into a Voxal room from the Lock Screen / Dynamic Island while the app
// is backgrounded.
//
// Flow:
//   JS joinRoom()  -> PTT.join()  -> requestJoinChannel  -> system shows PTT UI
//   Lock-screen Talk button down  -> didBeginTransmittingFrom(.userRequest)
//                                  -> notifyListeners("ptt-press")  -> JS setTalking(true)
//   Lock-screen Talk button up    -> didEndTransmittingFrom(.userRequest)
//                                  -> notifyListeners("ptt-release") -> JS setTalking(false)
//   In-app PTT button             -> JS PTT.startTransmitting() -> requestBeginTransmitting
//                                  (source .developerRequest is ignored to avoid echo)
//
// The mic is gated entirely on the JS side (audioTrack.enabled). Swift only relays
// button events and (de)activates the shared AVAudioSession when the framework asks.

// MARK: - Restoration delegate (no-op — we don't persist rooms across app kill)

@available(iOS 16.0, *)
private final class PTTRestorationDelegate: NSObject, PTChannelRestorationDelegate {
    func channelDescriptor(restoredChannelUUID channelUUID: UUID) -> PTChannelDescriptor {
        // A previous channel is being restored by the system. We don't persist
        // rooms, so return a generic descriptor; JS leaves the channel on launch
        // if there is no active room.
        return PTChannelDescriptor(name: "Voxal", image: nil)
    }
}

// MARK: - Channel manager delegate

@available(iOS 16.0, *)
private final class PTTChannelDelegate: NSObject, PTChannelManagerDelegate {
    weak var plugin: PTTPlugin?

    func channelManager(_ channelManager: PTChannelManager,
                        didJoinChannel channelUUID: UUID,
                        reason: PTChannelJoinReason) {
        // Voxal always lets you hear others while you hold to talk; the system PTT
        // UI defaults to half-duplex (transmit blocks receive). Match Voxal.
        channelManager.setTransmissionMode(.fullDuplex, channelUUID: channelUUID, completionHandler: nil)
        plugin?.notifyListeners("ptt-joined", data: [:])
    }

    func channelManager(_ channelManager: PTChannelManager,
                        didLeaveChannel channelUUID: UUID,
                        reason: PTChannelLeaveReason) {
        plugin?.handleChannelLeft(uuid: channelUUID, reason: reason)
    }

    /// The Talk button in the system UI was pressed (or a hands-free accessory
    /// button). This is the Lock Screen / Dynamic Island press we care about.
    func channelManager(_ channelManager: PTChannelManager,
                        channelUUID: UUID,
                        didBeginTransmittingFrom source: PTChannelTransmitRequestSource) {
        // .developerRequest originates from our own startTransmitting() — JS already
        // started talking, so relaying it back would be a redundant echo.
        if source == .developerRequest { return }
        plugin?.notifyListeners("ptt-press", data: [:])
    }

    /// The Talk button was released.
    func channelManager(_ channelManager: PTChannelManager,
                        channelUUID: UUID,
                        didEndTransmittingFrom source: PTChannelTransmitRequestSource) {
        if source == .developerRequest { return }
        plugin?.notifyListeners("ptt-release", data: [:])
    }

    /// Serverless — no push backend, so the ephemeral token is unused.
    func channelManager(_ channelManager: PTChannelManager,
                        receivedEphemeralPushToken pushToken: Data) {}

    /// Required. We never send pushes, so this should not fire; return a benign
    /// result if it ever does.
    func incomingPushResult(channelManager: PTChannelManager,
                            channelUUID: UUID,
                            pushPayload: [String: Any]) -> PTPushResult {
        return .leaveChannel
    }

    /// The framework owns the shared AVAudioSession. Only (de)activate it here — do
    /// NOT call setCategory, which would tear down WebRTC's existing audio pipeline.
    // NOTE: the ObjC header spells these didActivateAudioSession:/didDeactivateAudioSession:,
    // but Swift API notes rename them to didActivate:/didDeactivate:. Use the Swift names.
    func channelManager(_ channelManager: PTChannelManager,
                        didActivate audioSession: AVAudioSession) {
        try? audioSession.setActive(true)
    }

    func channelManager(_ channelManager: PTChannelManager,
                        didDeactivate audioSession: AVAudioSession) {
        try? audioSession.setActive(false, options: .notifyOthersOnDeactivation)
    }

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
        CAPPluginMethod(name: "join",              returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "leave",             returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startTransmitting", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopTransmitting",  returnType: CAPPluginReturnPromise),
    ]

    // PTChannelManager and the delegates are iOS 16+. The plugin class itself must
    // stay available on the iOS 15 deployment target so Capacitor can instantiate it,
    // so the iOS 16-only manager is type-erased behind a computed accessor.
    private var _channelManager: Any?
    private var channelDelegate: AnyObject?
    private var restorationDelegate: AnyObject?
    private var activeChannelUUID: UUID?

    @available(iOS 16.0, *)
    private var channelManager: PTChannelManager? {
        get { _channelManager as? PTChannelManager }
        set { _channelManager = newValue }
    }

    // PTChannelManager.channelManager(...) is async. A join() that arrives before it
    // finishes must wait, or the channel is silently never joined.
    private var managerReady = false
    private var managerWaiters: [UUID: CheckedContinuation<Void, Never>] = [:]

    public override func load() {
        guard #available(iOS 16.0, *) else { return }
        let delegate = PTTChannelDelegate()
        delegate.plugin = self
        channelDelegate = delegate
        let restoration = PTTRestorationDelegate()
        restorationDelegate = restoration

        Task {
            do {
                let manager = try await PTChannelManager.channelManager(
                    delegate: delegate,
                    restorationDelegate: restoration
                )
                await MainActor.run {
                    self.channelManager = manager
                    self.signalManagerReady()
                }
            } catch {
                print("[PTT] Failed to create channel manager: \(error)")
                // Unblock any pending join() calls; they'll report unsupported.
                await MainActor.run { self.signalManagerReady() }
            }
        }
    }

    // MARK: - Async-init gating

    @available(iOS 16.0, *)
    @MainActor
    private func signalManagerReady() {
        if managerReady { return }
        managerReady = true
        let waiters = managerWaiters
        managerWaiters.removeAll()
        for (_, cont) in waiters { cont.resume() }
    }

    /// Suspends until the channel manager finishes async init, with a 5s safety cap.
    @available(iOS 16.0, *)
    @MainActor
    private func awaitManagerReady() async {
        if managerReady { return }
        let id = UUID()
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            managerWaiters[id] = cont
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 5_000_000_000)
                if let pending = managerWaiters.removeValue(forKey: id) { pending.resume() }
            }
        }
    }

    // MARK: - JS-callable methods

    @objc func join(_ call: CAPPluginCall) {
        guard #available(iOS 16.0, *) else { call.resolve(["supported": false]); return }
        let roomName = call.getString("roomName") ?? "Voxal"
        Task { @MainActor in
            await self.awaitManagerReady()
            guard let manager = self.channelManager else {
                call.resolve(["supported": false]); return
            }
            let descriptor = PTChannelDescriptor(name: roomName, image: nil)
            if let uuid = self.activeChannelUUID {
                // Already joined (e.g. host migration re-join) — just refresh the name.
                manager.setChannelDescriptor(descriptor, channelUUID: uuid, completionHandler: nil)
            } else {
                let uuid = UUID()
                self.activeChannelUUID = uuid
                manager.requestJoinChannel(channelUUID: uuid, descriptor: descriptor)
            }
            call.resolve(["supported": true])
        }
    }

    @objc func leave(_ call: CAPPluginCall) {
        guard #available(iOS 16.0, *) else { call.resolve(); return }
        Task { @MainActor in
            if let manager = self.channelManager, let uuid = self.activeChannelUUID {
                manager.leaveChannel(channelUUID: uuid)
            }
            self.activeChannelUUID = nil
            call.resolve()
        }
    }

    /// Called by the in-app PTT button so the system UI shows "transmitting".
    @objc func startTransmitting(_ call: CAPPluginCall) {
        guard #available(iOS 16.0, *) else { call.resolve(); return }
        Task { @MainActor in
            if let manager = self.channelManager, let uuid = self.activeChannelUUID {
                manager.requestBeginTransmitting(channelUUID: uuid)
            }
            call.resolve()
        }
    }

    @objc func stopTransmitting(_ call: CAPPluginCall) {
        guard #available(iOS 16.0, *) else { call.resolve(); return }
        Task { @MainActor in
            if let manager = self.channelManager, let uuid = self.activeChannelUUID {
                manager.stopTransmitting(channelUUID: uuid)
            }
            call.resolve()
        }
    }

    // MARK: - Delegate callbacks

    @available(iOS 16.0, *)
    func handleChannelLeft(uuid: UUID, reason: PTChannelLeaveReason) {
        DispatchQueue.main.async {
            if self.activeChannelUUID == uuid { self.activeChannelUUID = nil }
            // Only surface a user-initiated leave (the system UI's Leave button) so JS
            // can leave the room. A programmatic leave is already JS-driven.
            if reason == .userRequest {
                self.notifyListeners("ptt-left", data: [:])
            }
        }
    }
}
