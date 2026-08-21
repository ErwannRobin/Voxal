import Foundation

/// The wire between the broadcast extension and the app.
///
/// ReplayKit runs a Broadcast Upload Extension in its own process, so encoded
/// frames have to cross a process boundary before they can reach the WebView.
/// A Unix domain socket in the shared App Group container is the cheapest way
/// to do that at video rates: no serialisation, no file churn, and back-pressure
/// for free when the reader falls behind. A Darwin notification announces the
/// listener so the extension does not have to poll for it.
///
/// Compiled into BOTH targets — the app opens the listening end, the extension
/// connects to it.
enum BroadcastFrameChannel {
    /// Must match the App Group on both targets' entitlements.
    static let appGroup = "group.com.erwann.voxal.app"
    static let socketName = "vx.sock"

    static let listenerReadyNotification = "app.voxal.screenshare.listenerReady" as CFString
    static let stopNotification = "app.voxal.screenshare.stop" as CFString

    /// Frames are length-prefixed so the reader can find message boundaries in
    /// a byte stream: 4-byte big-endian length, 1 flag byte (1 = keyframe),
    /// 8-byte big-endian presentation time in microseconds, then Annex-B.
    static let headerSize = 13

    static func socketPath() -> String? {
        guard let container = FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: appGroup) else { return nil }
        // A sockaddr_un path is capped at 104 bytes on Darwin and an App Group
        // container URL already spends ~82 of them, so the socket sits at the
        // container root under a deliberately tiny name. Callers still check.
        return container.appendingPathComponent(socketName).path
    }

    static func encodeHeader(length: Int, isKeyframe: Bool, timestampMicros: Int64) -> Data {
        var out = Data(capacity: headerSize)
        var beLength = UInt32(length).bigEndian
        withUnsafeBytes(of: &beLength) { out.append(contentsOf: $0) }
        out.append(isKeyframe ? 1 : 0)
        var beTime = UInt64(bitPattern: timestampMicros).bigEndian
        withUnsafeBytes(of: &beTime) { out.append(contentsOf: $0) }
        return out
    }

    static func decodeHeader(_ data: Data) -> (length: Int, isKeyframe: Bool, timestampMicros: Int64)? {
        guard data.count >= headerSize else { return nil }
        let bytes = [UInt8](data.prefix(headerSize))
        let length = (UInt32(bytes[0]) << 24) | (UInt32(bytes[1]) << 16)
            | (UInt32(bytes[2]) << 8) | UInt32(bytes[3])
        var time: UInt64 = 0
        for i in 5..<13 { time = (time << 8) | UInt64(bytes[i]) }
        return (Int(length), bytes[4] == 1, Int64(bitPattern: time))
    }

    static func post(_ name: CFString) {
        CFNotificationCenterPostNotification(
            CFNotificationCenterGetDarwinNotifyCenter(), CFNotificationName(name), nil, nil, true)
    }
}
