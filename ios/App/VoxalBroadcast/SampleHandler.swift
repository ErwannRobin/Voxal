import ReplayKit
import VideoToolbox
import CoreMedia
import CoreVideo
import Darwin

/// The ReplayKit broadcast extension: captures the device screen, encodes it to
/// H.264, and writes Annex-B access units to the app over the App Group socket.
///
/// Encoding here rather than in the app is not an optimisation, it is the
/// constraint: a Broadcast Upload Extension has a hard 50 MB memory cap, and
/// shipping raw CVPixelBuffers across the process boundary at video rates would
/// blow through it immediately. VideoToolbox's hardware encoder keeps the
/// working set to a couple of frames, and the app then receives ~1 Mbps instead
/// of hundreds.
class SampleHandler: RPBroadcastSampleHandler {
    private var session: VTCompressionSession?
    private var socketFD: Int32 = -1
    private var encodedWidth: Int32 = 0
    private var encodedHeight: Int32 = 0
    private let writeQueue = DispatchQueue(label: "app.voxal.broadcast.write")

    private let maxEdge: Int32 = 1280
    private let targetBitrate: Int32 = 1_200_000

    // Outgoing frames, whole ones only; `headOffset` tracks how much of
    // pending[0] has actually reached the socket.
    private var pending: [Data] = []
    private var headOffset = 0
    private var forceKeyframe = false
    private var lastWriteAt = Date()
    /// ~1s of video at 30fps. Past this the app is not keeping up and the
    /// backlog is stale anyway — live video wants the newest frame, not a queue.
    private static let maxQueuedFrames = 30
    /// A full send buffer means the app is alive but not draining — backgrounded,
    /// or busy. That is the case this feature exists to survive, so be patient.
    private static let backpressureTimeout: TimeInterval = 300
    /// A socket we cannot even reconnect to means the app is gone. Give up much
    /// sooner: an orphaned broadcast leaves the red recording bar up.
    private static let disconnectedTimeout: TimeInterval = 30

    override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
        // All socket state lives on writeQueue; ReplayKit's own thread never
        // touches it, so there is nothing to race against.
        writeQueue.async { [weak self] in self?.connect() }
        BroadcastFrameChannel.post(BroadcastFrameChannel.listenerReadyNotification)
    }

    override func broadcastFinished() {
        writeQueue.async { [weak self] in self?.teardown() }
    }

    override func processSampleBuffer(_ sampleBuffer: CMSampleBuffer, with type: RPSampleBufferType) {
        guard type == .video,
              let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let width = Int32(CVPixelBufferGetWidth(pixelBuffer))
        let height = Int32(CVPixelBufferGetHeight(pixelBuffer))
        let scaled = Self.scaleToMaxEdge(width: width, height: height, maxEdge: maxEdge)

        // A rotation changes the buffer geometry, which the encoder cannot
        // absorb — rebuild it and let the app's decoder resync on the next IDR.
        if session == nil || scaled.width != encodedWidth || scaled.height != encodedHeight {
            makeSession(width: scaled.width, height: scaled.height)
        }
        guard let session else { return }

        let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        // After dropping a backlog the decoder is mid-GOP with missing frames,
        // so the next one has to be an IDR or it decodes garbage until the
        // encoder's own 2s keyframe comes round.
        var frameProperties: CFDictionary?
        if forceKeyframe {
            frameProperties = [kVTEncodeFrameOptionKey_ForceKeyFrame: kCFBooleanTrue!] as CFDictionary
            forceKeyframe = false
        }
        VTCompressionSessionEncodeFrame(
            session, imageBuffer: pixelBuffer, presentationTimeStamp: pts,
            duration: .invalid, frameProperties: frameProperties,
            sourceFrameRefcon: nil, infoFlagsOut: nil)
    }

    /// Fit into maxEdge on the long side, keeping aspect, both dimensions even.
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

    private func makeSession(width: Int32, height: Int32) {
        if let session {
            VTCompressionSessionInvalidate(session)
            self.session = nil
        }
        var created: VTCompressionSession?
        let status = VTCompressionSessionCreate(
            allocator: kCFAllocatorDefault,
            width: width, height: height,
            codecType: kCMVideoCodecType_H264,
            encoderSpecification: nil,
            imageBufferAttributes: nil,
            compressedDataAllocator: nil,
            outputCallback: { refcon, _, status, _, sampleBuffer in
                guard status == noErr, let refcon, let sampleBuffer else { return }
                let handler = Unmanaged<SampleHandler>.fromOpaque(refcon).takeUnretainedValue()
                handler.emit(sampleBuffer)
            },
            refcon: Unmanaged.passUnretained(self).toOpaque(),
            compressionSessionOut: &created)
        guard status == noErr, let created else { return }

        VTSessionSetProperty(created, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
        VTSessionSetProperty(created, key: kVTCompressionPropertyKey_ProfileLevel,
                             value: kVTProfileLevel_H264_Baseline_AutoLevel)
        VTSessionSetProperty(created, key: kVTCompressionPropertyKey_AllowFrameReordering,
                             value: kCFBooleanFalse)
        VTSessionSetProperty(created, key: kVTCompressionPropertyKey_AverageBitRate,
                             value: NSNumber(value: targetBitrate))
        // A keyframe every two seconds, matching the Android encoder: short
        // enough for a decoder that loses sync to recover quickly.
        VTSessionSetProperty(created, key: kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration,
                             value: NSNumber(value: 2))
        VTCompressionSessionPrepareToEncodeFrames(created)

        session = created
        encodedWidth = width
        encodedHeight = height
    }

    /// VideoToolbox hands back AVCC (4-byte length prefixes) with the parameter
    /// sets held separately. The app's WebCodecs decoder is configured without a
    /// `description`, which means it expects Annex-B — so convert here, and
    /// prepend SPS/PPS to every keyframe so the stream is self-describing and a
    /// late or resynced decoder can pick it up mid-share.
    private func emit(_ sampleBuffer: CMSampleBuffer) {
        guard let block = CMSampleBufferGetDataBuffer(sampleBuffer) else { return }

        var isKeyframe = true
        if let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false),
           CFArrayGetCount(attachments) > 0 {
            let dict = unsafeBitCast(CFArrayGetValueAtIndex(attachments, 0), to: CFDictionary.self)
            if let notSync = CFDictionaryGetValue(
                dict, Unmanaged.passUnretained(kCMSampleAttachmentKey_NotSync).toOpaque()) {
                isKeyframe = !CFBooleanGetValue(unsafeBitCast(notSync, to: CFBoolean.self))
            }
        }

        var out = Data()
        let startCode: [UInt8] = [0x00, 0x00, 0x00, 0x01]

        if isKeyframe, let format = CMSampleBufferGetFormatDescription(sampleBuffer) {
            var count = 0
            CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
                format, parameterSetIndex: 0, parameterSetPointerOut: nil,
                parameterSetSizeOut: nil, parameterSetCountOut: &count, nalUnitHeaderLengthOut: nil)
            for i in 0..<count {
                var pointer: UnsafePointer<UInt8>?
                var size = 0
                if CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
                    format, parameterSetIndex: i, parameterSetPointerOut: &pointer,
                    parameterSetSizeOut: &size, parameterSetCountOut: nil,
                    nalUnitHeaderLengthOut: nil) == noErr, let pointer {
                    out.append(contentsOf: startCode)
                    out.append(pointer, count: size)
                }
            }
        }

        var lengthAtOffset = 0
        var totalLength = 0
        var dataPointer: UnsafeMutablePointer<Int8>?
        guard CMBlockBufferGetDataPointer(
            block, atOffset: 0, lengthAtOffsetOut: &lengthAtOffset,
            totalLengthOut: &totalLength, dataPointerOut: &dataPointer) == noErr,
            let dataPointer else { return }

        // Walk the AVCC units, swapping each 4-byte length for a start code.
        var offset = 0
        let bytes = UnsafeRawPointer(dataPointer).assumingMemoryBound(to: UInt8.self)
        while offset + 4 <= totalLength {
            var nalLength: UInt32 = 0
            memcpy(&nalLength, bytes + offset, 4)
            let size = Int(CFSwapInt32BigToHost(nalLength))
            offset += 4
            if size <= 0 || offset + size > totalLength { break }
            out.append(contentsOf: startCode)
            out.append(bytes + offset, count: size)
            offset += size
        }
        guard !out.isEmpty else { return }

        let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        let micros = Int64(CMTimeGetSeconds(pts) * 1_000_000)
        write(out, isKeyframe: isKeyframe, timestampMicros: micros)
    }

    // MARK: - Socket

    private func connect() {
        guard let path = BroadcastFrameChannel.socketPath() else { return }
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return }
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let pathBytes = Array(path.utf8)
        guard pathBytes.count < MemoryLayout.size(ofValue: addr.sun_path) else {
            close(fd)
            return
        }
        withUnsafeMutablePointer(to: &addr.sun_path) { ptr in
            ptr.withMemoryRebound(to: CChar.self, capacity: pathBytes.count + 1) { dst in
                for (i, b) in pathBytes.enumerated() { dst[i] = CChar(bitPattern: b) }
                dst[pathBytes.count] = 0
            }
        }
        let size = socklen_t(MemoryLayout<sockaddr_un>.size)
        let ok = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(fd, $0, size) }
        }
        if ok < 0 {
            close(fd)
            return
        }
        // The app is the only consumer; a dead reader must not raise SIGPIPE and
        // kill the extension, it must surface as a failed write.
        var on: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
        // Non-blocking: a backgrounded app stops reading, and a blocking write
        // would park the encoder's callback thread until iOS killed us.
        let flags = fcntl(fd, F_GETFL, 0)
        _ = fcntl(fd, F_SETFL, flags | O_NONBLOCK)
        socketFD = fd
        lastWriteAt = Date()
        forceKeyframe = true
    }

    /// Queue a whole frame and try to flush.
    ///
    /// Frames are length-prefixed, so a partial write that is then abandoned
    /// desynchronises the reader permanently — the queue therefore holds whole
    /// frames and only the head may be partially written.
    private func write(_ payload: Data, isKeyframe: Bool, timestampMicros: Int64) {
        writeQueue.async { [weak self] in
            guard let self else { return }
            // Reconnect here rather than on ReplayKit's thread: the app may have
            // restarted its listener while we were backgrounded.
            if self.socketFD < 0 { self.connect() }
            var frame = BroadcastFrameChannel.encodeHeader(
                length: payload.count, isKeyframe: isKeyframe, timestampMicros: timestampMicros)
            frame.append(payload)
            self.pending.append(frame)

            // The app has stopped draining — it is backgrounded, or busy. Drop
            // the backlog rather than grow it without bound, keeping only the
            // head (which may be half-written and cannot be discarded), and ask
            // the encoder for a keyframe so the decoder can resync on resume.
            if self.pending.count > Self.maxQueuedFrames {
                let head = self.pending.removeFirst()
                self.pending = [head]
                self.forceKeyframe = true
            }
            // Still no socket: the app has not come back yet. Keep dropping
            // frames quietly, and only give up once the stall has gone on too
            // long — otherwise a hard error would silence the watchdog forever.
            guard self.socketFD >= 0 else {
                self.checkStalled(connected: false)
                return
            }
            self.flushPending()
        }
    }

    private enum FlushOutcome { case drained, wouldBlock, hardError }

    private func flushPending() {
        guard socketFD >= 0 else { return }
        while let head = pending.first {
            var outcome = FlushOutcome.drained
            head.withUnsafeBytes { raw in
                guard let base = raw.baseAddress else { return }
                while headOffset < raw.count {
                    let n = Darwin.write(socketFD, base + headOffset, raw.count - headOffset)
                    if n > 0 {
                        headOffset += n
                        continue
                    }
                    if n < 0 && errno == EINTR { continue }
                    // A full send buffer is normal backpressure, NOT a failure:
                    // keep the frame and try again on the next one.
                    outcome = (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK))
                        ? .wouldBlock : .hardError
                    return
                }
            }
            switch outcome {
            case .wouldBlock:
                checkStalled(connected: true)
                return
            case .hardError:
                // The reader is genuinely gone. Drop the socket and let the next
                // frame reconnect; only give up if that keeps failing.
                close(socketFD)
                socketFD = -1
                pending.removeAll()
                headOffset = 0
                forceKeyframe = true
                checkStalled(connected: false)
                return
            case .drained:
                pending.removeFirst()
                headOffset = 0
                lastWriteAt = Date()
            }
        }
    }

    /// End the broadcast only after nothing has reached the app for a long time.
    /// A backgrounded app must be able to come back; an app that is gone for
    /// good should not leave a broadcast running with the red bar up forever.
    private func checkStalled(connected: Bool) {
        let limit = connected ? Self.backpressureTimeout : Self.disconnectedTimeout
        if Date().timeIntervalSince(lastWriteAt) > limit {
            finishBroadcast()
        }
    }

    private func finishBroadcast() {
        teardown()
        let error = NSError(domain: "app.voxal.screenshare", code: 1, userInfo: [
            NSLocalizedFailureReasonErrorKey: "Voxal stopped receiving the screen share."
        ])
        finishBroadcastWithError(error)
    }

    private func teardown() {
        if let session {
            VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid)
            VTCompressionSessionInvalidate(session)
            self.session = nil
        }
        if socketFD >= 0 {
            close(socketFD)
            socketFD = -1
        }
        pending.removeAll()
        headOffset = 0
    }
}
