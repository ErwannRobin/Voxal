// Compute Apple Vision's mattes over the matting footage, for the matting
// bench's `pre:<name>` engine (docs/matting-candidates.md, docs/apple-vision-evaluation.md).
//
// Same contract as scripts/matting-offline.py: read every frame of
// bench-results/matting/footage/<room>/NNNN.jpg, write the person's alpha to
// bench-results/matting/footage/pre/<name>/<room>/NNNN.png (8-bit gray), then
//
//     node scripts/matting-bench.mjs --engines pre:<name>
//
// scores it through Voxal's real pipeline like a live engine.
//
//     swiftc -O scripts/apple-vision-offline.swift -o bench-results/apple-vision-offline
//     bench-results/apple-vision-offline person-accurate [--rooms wall,living,kitchen] [--width 512]
//
// Variants:
//   person-accurate | person-balanced | person-fast
//       VNGeneratePersonSegmentationRequest (macOS 12+), run on ONE
//       VNSequenceRequestHandler per room so Vision sees the clip as video.
//   foreground
//       VNGenerateForegroundInstanceMaskRequest (macOS 14+), one image handler
//       per frame (it is built for stills), every instance merged.
//
// --width N downscales the input to N px wide first (what the app would send
// over IPC, e.g. 512) and writes the mask at Vision's own output size; the
// bench resizes it. Without it Vision sees the full 1280x720 frame, which
// flatters it. The output name gets a "-<N>" suffix so both can sit side by side.
//
// Prints the mean / p95 per-frame time of the Vision call alone (not decode or
// PNG encode), so the cost can be set against the other engines'.

import CoreGraphics
import CoreVideo
import Foundation
import ImageIO
import UniformTypeIdentifiers
import Vision

var footage = FileManager.default.currentDirectoryPath + "/bench-results/matting/footage"

var variant = ""
var rooms = ["wall", "living", "kitchen"]
var width = 0
var limit = Int.max
do {
    var it = CommandLine.arguments.dropFirst().makeIterator()
    while let a = it.next() {
        switch a {
        case "--rooms": rooms = (it.next() ?? "").split(separator: ",").map(String.init)
        case "--width": width = Int(it.next() ?? "") ?? 0
        case "--frames": limit = Int(it.next() ?? "") ?? Int.max
        case "--footage": footage = it.next() ?? footage
        default: variant = a
        }
    }
}
let known = ["person-accurate", "person-balanced", "person-fast", "foreground"]
guard known.contains(variant) else {
    FileHandle.standardError.write(Data("usage: apple-vision-offline <\(known.joined(separator: "|"))> [--rooms a,b] [--width N] [--frames N]\n".utf8))
    exit(2)
}
let outName = "apple-\(variant)" + (width > 0 ? "-\(width)" : "")

func loadFrame(_ url: URL) -> CGImage? {
    guard let src = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
    return CGImageSourceCreateImageAtIndex(src, 0, nil)
}

func scaled(_ img: CGImage, toWidth w: Int) -> CGImage {
    if w <= 0 || w >= img.width { return img }
    let h = max(1, Int((Double(img.height) * Double(w) / Double(img.width)).rounded()))
    let cs = CGColorSpace(name: CGColorSpace.sRGB)!
    guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                              space: cs, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return img }
    ctx.interpolationQuality = .high
    ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
    return ctx.makeImage() ?? img
}

/// A Vision mask (8-bit, half or 32-bit float, one component) as 8-bit gray.
func gray8(_ pb: CVPixelBuffer) -> (w: Int, h: Int, px: [UInt8]) {
    CVPixelBufferLockBaseAddress(pb, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(pb, .readOnly) }
    let w = CVPixelBufferGetWidth(pb), h = CVPixelBufferGetHeight(pb)
    let bpr = CVPixelBufferGetBytesPerRow(pb)
    let fmt = CVPixelBufferGetPixelFormatType(pb)
    let base = CVPixelBufferGetBaseAddress(pb)!
    var out = [UInt8](repeating: 0, count: w * h)
    for y in 0..<h {
        let row = base.advanced(by: y * bpr)
        for x in 0..<w {
            switch fmt {
            case kCVPixelFormatType_OneComponent8:
                out[y * w + x] = row.load(fromByteOffset: x, as: UInt8.self)
            case kCVPixelFormatType_OneComponent32Float:
                let f = row.load(fromByteOffset: x * 4, as: Float.self)
                out[y * w + x] = UInt8(max(0, min(1, f)) * 255 + 0.5)
            case kCVPixelFormatType_OneComponent16Half:
                let f = Float(row.load(fromByteOffset: x * 2, as: Float16.self))
                out[y * w + x] = UInt8(max(0, min(1, f)) * 255 + 0.5)
            default:
                fatalError("unexpected mask pixel format \(fmt)")
            }
        }
    }
    return (w, h, out)
}

func writePNG(_ m: (w: Int, h: Int, px: [UInt8]), to url: URL) {
    try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    var px = m.px
    px.withUnsafeMutableBytes { buf in
        let ctx = CGContext(data: buf.baseAddress, width: m.w, height: m.h, bitsPerComponent: 8, bytesPerRow: m.w,
                            space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue)!
        let img = ctx.makeImage()!
        let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)!
        CGImageDestinationAddImage(dest, img, nil)
        CGImageDestinationFinalize(dest)
    }
}

func quality(_ v: String) -> VNGeneratePersonSegmentationRequest.QualityLevel {
    switch v {
    case "person-fast": return .fast
    case "person-balanced": return .balanced
    default: return .accurate
    }
}

var times: [Double] = []

for room in rooms {
    let dir = URL(fileURLWithPath: footage + "/" + room)
    let files = ((try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? [])
        .filter { $0.count >= 8 && $0.hasSuffix(".jpg") && Int($0.prefix(4)) != nil }.sorted().prefix(limit)
    let seq = VNSequenceRequestHandler()
    for f in files {
        guard let full = loadFrame(dir.appendingPathComponent(f)) else { fatalError("cannot read \(f)") }
        let img = scaled(full, toWidth: width)
        var mask: (w: Int, h: Int, px: [UInt8])
        let t0 = DispatchTime.now().uptimeNanoseconds
        if variant == "foreground" {
            let req = VNGenerateForegroundInstanceMaskRequest()
            let h = VNImageRequestHandler(cgImage: img, options: [:])
            try h.perform([req])
            if let obs = req.results?.first, !obs.allInstances.isEmpty {
                let pb = try obs.generateScaledMaskForImage(forInstances: obs.allInstances, from: h)
                mask = gray8(pb)
            } else {
                mask = (img.width, img.height, [UInt8](repeating: 0, count: img.width * img.height))
            }
        } else {
            let req = VNGeneratePersonSegmentationRequest()
            req.qualityLevel = quality(variant)
            req.outputPixelFormat = kCVPixelFormatType_OneComponent8
            try seq.perform([req], on: img)
            guard let pb = req.results?.first?.pixelBuffer else { fatalError("no mask for \(room)/\(f)") }
            mask = gray8(pb)
        }
        times.append(Double(DispatchTime.now().uptimeNanoseconds - t0) / 1e6)
        writePNG(mask, to: URL(fileURLWithPath: footage + "/pre/" + outName + "/" + room + "/" + String(f.prefix(4)) + ".png"))
    }
    print("\(room): \(files.count) frames, mask \(width > 0 ? "from \(width)px input" : "from full frame")")
}

times.sort()
let mean = times.reduce(0, +) / Double(max(times.count, 1))
let p95 = times.isEmpty ? 0 : times[min(times.count - 1, Int(Double(times.count) * 0.95))]
print(String(format: "%@: Vision call mean %.1f ms, p95 %.1f ms over %d frames", outName, mean, p95, times.count))
