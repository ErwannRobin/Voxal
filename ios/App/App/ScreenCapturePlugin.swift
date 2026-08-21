import Foundation
import Capacitor
import ReplayKit
import UIKit
import Darwin

/// Bridges iOS screen capture into the WebView.
///
/// WebKit has never shipped `getDisplayMedia`, so JavaScript cannot obtain a
/// screen MediaStream on its own. Capture happens in the VoxalBroadcast
/// extension (ReplayKit only offers system-wide capture to an extension, and
/// only that survives the user leaving the app — which is the entire point of
/// sharing a screen). This plugin listens on an App Group socket for the H.264
/// the extension encodes and forwards it to `src/main.js`, which decodes it with
/// WebCodecs and republishes it exactly like a desktop screen share.
///
/// Events:
///   screenCaptureConfig  { codec, width, height }
///   screenCaptureChunk   { data (base64 Annex-B), key, timestamp }
///   screenCaptureStopped { reason, message }
@objc(ScreenCapturePlugin)
public class ScreenCapturePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ScreenCapturePlugin"
    public let jsName = "ScreenCapture"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "canCapture", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise)
    ]

    private var listenFD: Int32 = -1
    private var clientFD: Int32 = -1
    private var readSource: DispatchSourceRead?
    private var acceptSource: DispatchSourceRead?
    private var buffer = Data()
    private var announcedGeometry: (Int, Int)?
    private var pendingStart: CAPPluginCall?
    private var captureGeometry: (Int, Int)?
    private let ioQueue = DispatchQueue(label: "app.voxal.screencapture.io")

    /// How long to wait for the user to work through the system broadcast sheet
    /// (which includes ReplayKit's own 3-2-1 countdown) before treating silence
    /// as a cancel.
    private static let startTimeout: DispatchTimeInterval = .seconds(30)

    /// WebCodecs is the other half of the requirement: `VideoDecoder` arrived in
    /// Safari 16.4, and this app still deploys to iOS 15. Below that the JS side
    /// has nothing to decode with, so report unsupported rather than start a
    /// broadcast whose frames would go nowhere.
    @objc func canCapture(_ call: CAPPluginCall) {
        var supported = false
        if #available(iOS 16.4, *) {
            supported = BroadcastFrameChannel.socketPath() != nil
        }
        call.resolve(["supported": supported])
    }

    @objc func start(_ call: CAPPluginCall) {
        guard #available(iOS 16.4, *), let path = BroadcastFrameChannel.socketPath() else {
            call.reject("unsupported")
            return
        }
        // UIScreen must be read on the main thread and the frame path runs on
        // ioQueue, so read it here and carry the answer into the one ioQueue
        // block that does the rest — dispatching the two independently would
        // let openListener's closeSockets() wipe the geometry it just stored.
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            let bounds = UIScreen.main.nativeBounds
            let geometry = Self.scaleToMaxEdge(
                width: Int32(bounds.width), height: Int32(bounds.height), maxEdge: 1280)

            // Everything touching the sockets or `pendingStart` stays on
            // ioQueue, so the accept handler and this call can never race.
            self.ioQueue.async {
                do {
                    try self.openListener(at: path)
                } catch {
                    self.settle(call) { $0.reject("failed: \(error.localizedDescription)") }
                    return
                }
                self.captureGeometry = (Int(geometry.width), Int(geometry.height))
                // Resolve only once the extension actually connects, not
                // when the sheet is presented: RPSystemBroadcastPickerView
                // reports nothing about what the user did with it, so resolving
                // early would publish a share that stays black forever if they
                // back out, indistinguishable from a working one.
                self.pendingStart = call
                DispatchQueue.main.async { self.presentBroadcastPicker() }

                self.ioQueue.asyncAfter(deadline: .now() + Self.startTimeout) { [weak self] in
                    guard let self, let pending = self.pendingStart else { return }
                    self.pendingStart = nil
                    self.closeSockets()
                    self.settle(pending) { $0.reject("cancelled") }
                }
            }
        }
    }

    /// Capacitor requires resolve/reject on the main thread.
    private func settle(_ call: CAPPluginCall, _ body: @escaping (CAPPluginCall) -> Void) {
        DispatchQueue.main.async { body(call) }
    }

    @objc func stop(_ call: CAPPluginCall) {
        BroadcastFrameChannel.post(BroadcastFrameChannel.stopNotification)
        ioQueue.async { [weak self] in
            guard let self else { return }
            if let pending = self.pendingStart {
                self.pendingStart = nil
                self.settle(pending) { $0.reject("cancelled") }
            }
            self.closeSockets()
        }
        call.resolve()
    }

    // MARK: - Picker

    /// `RPSystemBroadcastPickerView` is still the only supported way to start a
    /// broadcast, and it exposes no programmatic trigger — the button has to be
    /// tapped. Sending `.touchUpInside` to its inner UIButton is the long-standing
    /// way to do that from code; the view itself stays off-screen.
    private func presentBroadcastPicker() {
        let picker = RPSystemBroadcastPickerView(
            frame: CGRect(x: 0, y: 0, width: 44, height: 44))
        picker.showsMicrophoneButton = false
        if let bundleId = Bundle.main.bundleIdentifier {
            picker.preferredExtension = "\(bundleId).VoxalBroadcast"
        }
        // Attach briefly: an unattached picker's button does nothing.
        if let host = bridge?.viewController?.view {
            picker.isHidden = true
            host.addSubview(picker)
            for case let button as UIButton in picker.subviews {
                button.sendActions(for: .touchUpInside)
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                picker.removeFromSuperview()
            }
        }
    }

    // MARK: - Socket

    private func openListener(at path: String) throws {
        closeSockets()
        // A stale socket file from a crashed run would make bind() fail with
        // EADDRINUSE; the path is ours alone, so removing it is safe.
        try? FileManager.default.removeItem(atPath: path)

        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw POSIXError(.EBADF) }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let pathBytes = Array(path.utf8)
        guard pathBytes.count < MemoryLayout.size(ofValue: addr.sun_path) else {
            close(fd)
            throw POSIXError(.ENAMETOOLONG)
        }
        withUnsafeMutablePointer(to: &addr.sun_path) { ptr in
            ptr.withMemoryRebound(to: CChar.self, capacity: pathBytes.count + 1) { dst in
                for (i, b) in pathBytes.enumerated() { dst[i] = CChar(bitPattern: b) }
                dst[pathBytes.count] = 0
            }
        }
        let size = socklen_t(MemoryLayout<sockaddr_un>.size)
        let bound = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(fd, $0, size) }
        }
        guard bound == 0, listen(fd, 1) == 0 else {
            close(fd)
            throw POSIXError(.EADDRINUSE)
        }
        listenFD = fd

        let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: ioQueue)
        source.setEventHandler { [weak self] in self?.acceptClient() }
        source.resume()
        acceptSource = source

        BroadcastFrameChannel.post(BroadcastFrameChannel.listenerReadyNotification)
    }

    private func acceptClient() {
        guard listenFD >= 0, clientFD < 0 else { return }
        let fd = accept(listenFD, nil, nil)
        guard fd >= 0 else { return }
        var on: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
        clientFD = fd

        // The extension is live: this is the first moment the share is real.
        if let pending = pendingStart {
            pendingStart = nil
            settle(pending) { $0.resolve() }
        }

        let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: ioQueue)
        source.setEventHandler { [weak self] in self?.readAvailable() }
        source.setCancelHandler { close(fd) }
        source.resume()
        readSource = source
    }

    private func readAvailable() {
        guard clientFD >= 0 else { return }
        var chunk = [UInt8](repeating: 0, count: 64 * 1024)
        let n = read(clientFD, &chunk, chunk.count)
        if n <= 0 {
            // The extension exited — the user tapped Stop in the system UI, or
            // ReplayKit tore it down.
            handleDisconnect()
            return
        }
        buffer.append(contentsOf: chunk[0..<n])
        drainFrames()
    }

    /// Frames are length-prefixed, so a short read is normal: keep whatever does
    /// not yet form a complete frame and wait for the rest.
    private func drainFrames() {
        while true {
            guard let header = BroadcastFrameChannel.decodeHeader(buffer) else { return }
            let total = BroadcastFrameChannel.headerSize + header.length
            guard buffer.count >= total else { return }
            let payload = buffer.subdata(
                in: BroadcastFrameChannel.headerSize..<total)
            buffer.removeSubrange(0..<total)
            emit(payload, isKeyframe: header.isKeyframe, timestampMicros: header.timestampMicros)
        }
    }

    private func emit(_ payload: Data, isKeyframe: Bool, timestampMicros: Int64) {
        if isKeyframe, let geometry = captureGeometry,
           announcedGeometry == nil || announcedGeometry! != geometry {
            announcedGeometry = geometry
            notifyListeners("screenCaptureConfig", data: [
                "codec": "avc1.42E01E",
                "width": geometry.0,
                "height": geometry.1
            ])
        }
        notifyListeners("screenCaptureChunk", data: [
            "data": payload.base64EncodedString(),
            "key": isKeyframe,
            "timestamp": timestampMicros
        ])
    }

    static func scaleToMaxEdge(width: Int32, height: Int32, maxEdge: Int32) -> (width: Int32, height: Int32) {
        var w = width
        var h = height
        let long = max(w, h)
        if long > maxEdge && long > 0 {
            let scale = Double(maxEdge) / Double(long)
            w = Int32((Double(w) * scale).rounded())
            h = Int32((Double(h) * scale).rounded())
        }
        return (max(2, w - (w % 2)), max(2, h - (h % 2)))
    }

    private func handleDisconnect() {
        closeSockets()
        notifyListeners("screenCaptureStopped", data: ["reason": "user"])
    }

    private func closeSockets() {
        readSource?.cancel()
        readSource = nil
        clientFD = -1
        acceptSource?.cancel()
        acceptSource = nil
        if listenFD >= 0 {
            close(listenFD)
            listenFD = -1
        }
        buffer.removeAll(keepingCapacity: false)
        announcedGeometry = nil
        captureGeometry = nil
        if let path = BroadcastFrameChannel.socketPath() {
            try? FileManager.default.removeItem(atPath: path)
        }
    }
}
