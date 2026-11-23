import Foundation
import Capacitor
import CoreVideo
import Vision

/// Apple Vision's foreground mask for the camera cut-out (iOS 17+): the iOS
/// half of the `vision` segmentation engine (`src/vision-engine.js`). The Mac
/// app's twin is `src-tauri/src/vision.rs`, and the request is the same one
/// (`VNGenerateForegroundInstanceMaskRequest`, scaled mask — see
/// `docs/apple-vision-evaluation.md` for why not the person-segmentation one).
///
/// The webview owns the camera, so a downscaled frame crosses the Capacitor
/// bridge. The bridge is JSON, so the frame comes as a base64 JPEG (the
/// canvas's own encoder, ~25 KB at 512x288 against 590 KB of RGBA) and the
/// mask goes back as base64 8-bit alpha at the JPEG's own size.
///
///   call    : { image: <base64 JPEG>, width, height }
///   resolve : { width, height, mask: <base64, width*height bytes>, visionUs, totalUs }
///
/// A frame with no foreground answers an all-zero mask: a result, not an error.
@objc(VisionMaskPlugin)
public class VisionMaskPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "VisionMaskPlugin"
    public let jsName     = "VisionMask"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "foregroundMask", returnType: CAPPluginReturnPromise),
    ]

    /// Serial: one request at a time (the JS side never sends a second while
    /// one is out, and Vision's model is loaded once per queue's first call).
    private let queue = DispatchQueue(label: "app.voxal.vision-mask", qos: .userInitiated)

    @objc func foregroundMask(_ call: CAPPluginCall) {
        let t0 = DispatchTime.now()
        guard #available(iOS 17.0, *) else {
            call.reject("Apple Vision's foreground mask needs iOS 17 or later")
            return
        }
        guard let b64 = call.getString("image"), let data = Data(base64Encoded: b64), !data.isEmpty else {
            call.reject("Apple Vision was sent no image")
            return
        }
        let w = call.getInt("width") ?? 0, h = call.getInt("height") ?? 0
        guard w > 0, h > 0, w <= 4096, h <= 4096 else {
            call.reject("bad frame size \(w)x\(h)")
            return
        }
        queue.async {
            // One pool per frame: a GCD worker drains its pool only now and
            // then, and every frame autoreleases Vision's results and buffers.
            let result: Result<VisionMask, Error> = autoreleasepool {
                Result { try VisionMask.run(jpeg: data, width: w, height: h) }
            }
            switch result {
            case .failure(let e):
                call.reject(e.localizedDescription)
            case .success(let m):
                let total = DispatchTime.now().uptimeNanoseconds - t0.uptimeNanoseconds
                call.resolve([
                    "width": m.width,
                    "height": m.height,
                    "mask": m.alpha.base64EncodedString(),
                    "visionUs": m.visionUs,
                    "totalUs": Int(total / 1000),
                ])
            }
        }
    }
}

struct VisionMaskError: LocalizedError {
    let errorDescription: String?
    init(_ s: String) { errorDescription = s }
}

struct VisionMask {
    let width: Int
    let height: Int
    let alpha: Data
    let visionUs: Int

    @available(iOS 17.0, *)
    static func run(jpeg: Data, width: Int, height: Int) throws -> VisionMask {
        let handler = VNImageRequestHandler(data: jpeg, options: [:])
        let request = VNGenerateForegroundInstanceMaskRequest()
        let t0 = DispatchTime.now()
        try handler.perform([request])
        guard let obs = request.results?.first else {
            return VisionMask(width: width, height: height, alpha: Data(count: width * height),
                              visionUs: elapsedUs(t0))
        }
        // The SCALED mask, at the input's own size: the analysis mask is a
        // fixed 512x512 square whatever the frame's shape.
        let buf = try obs.generateScaledMaskForImage(forInstances: obs.allInstances, from: handler)
        let us = elapsedUs(t0)
        let (mw, mh, px) = try gray8(buf)
        return VisionMask(width: mw, height: mh, alpha: px, visionUs: us)
    }

    private static func elapsedUs(_ t0: DispatchTime) -> Int {
        Int((DispatchTime.now().uptimeNanoseconds - t0.uptimeNanoseconds) / 1000)
    }

    /// A one-component mask (8-bit, half or 32-bit float: whatever Vision
    /// chose — never assume 8-bit) as 8-bit alpha, rows packed.
    static func gray8(_ buf: CVPixelBuffer) throws -> (Int, Int, Data) {
        let fmt = CVPixelBufferGetPixelFormatType(buf)
        CVPixelBufferLockBaseAddress(buf, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(buf, .readOnly) }
        let mw = CVPixelBufferGetWidth(buf), mh = CVPixelBufferGetHeight(buf)
        let bpr = CVPixelBufferGetBytesPerRow(buf)
        guard let base = CVPixelBufferGetBaseAddress(buf) else { throw VisionMaskError("Vision mask has no pixels") }
        var out = Data(count: mw * mh)
        try out.withUnsafeMutableBytes { (dst: UnsafeMutableRawBufferPointer) in
            let d = dst.bindMemory(to: UInt8.self)
            for y in 0..<mh {
                let row = base.advanced(by: y * bpr)
                let o = y * mw
                switch fmt {
                case kCVPixelFormatType_OneComponent8:
                    let r = row.assumingMemoryBound(to: UInt8.self)
                    for x in 0..<mw { d[o + x] = r[x] }
                case kCVPixelFormatType_OneComponent16Half:
                    let r = row.assumingMemoryBound(to: UInt16.self)
                    for x in 0..<mw { d[o + x] = toU8(halfToFloat(r[x])) }
                case kCVPixelFormatType_OneComponent32Float:
                    let r = row.assumingMemoryBound(to: Float.self)
                    for x in 0..<mw { d[o + x] = toU8(r[x]) }
                default:
                    throw VisionMaskError(String(format: "unexpected mask pixel format %08x", fmt))
                }
            }
        }
        return (mw, mh, out)
    }

    /// IEEE 754 half to Float by hand: `Float16` is not on every simulator arch.
    static func halfToFloat(_ h: UInt16) -> Float {
        let sign: Float = (h & 0x8000) != 0 ? -1 : 1
        let exp = Int((h >> 10) & 0x1f)
        let frac = Float(h & 0x3ff)
        switch exp {
        case 0: return sign * frac * powf(2, -24)
        case 31: return frac == 0 ? sign * .infinity : .nan
        default: return sign * (1 + frac / 1024) * powf(2, Float(exp - 15))
        }
    }

    static func toU8(_ v: Float) -> UInt8 {
        if v >= 1 { return 255 }
        if v > 0 { return UInt8(v * 255 + 0.5) }
        return 0   // NaN and negatives
    }
}
