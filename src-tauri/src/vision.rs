//! Apple Vision foreground mask for the camera cut-out (macOS 14+).
//!
//! The `vision` segmentation engine (`src/vision-engine.js`, measured in
//! `docs/apple-vision-evaluation.md`). The webview owns the camera, so a
//! downscaled frame goes webview -> Rust over Tauri IPC (raw bytes), through
//! `VNGenerateForegroundInstanceMaskRequest`, and the mask comes back as raw
//! bytes.
//!
//! Wire format
//!   request : body = RGBA8 pixels (width * height * 4); headers `x-width`, `x-height`
//!   response: 12-byte header, then `mw * mh` bytes of 8-bit alpha (0 = background)
//!             u16 LE mw, u16 LE mh, u32 LE vision_us (the Vision call alone), u32 LE total_us
//!
//! The mask is the SCALED one (`generateScaledMaskForImageForInstances`), at the
//! input's own size: Vision's analysis mask is a fixed 512x512 whatever the
//! frame's shape, and the scaled mask is what the matting bench measured. At the
//! sizes the app sends it is also the smaller answer (512x288 = 147 KB against
//! 262 KB). A frame with no foreground answers an all-zero mask at that size.

use objc2::rc::autoreleasepool;
use objc2::runtime::AnyClass;
use objc2::AnyThread;
use objc2_core_foundation::CFRetained;
use objc2_core_video::{
    kCVPixelFormatType_32BGRA, kCVPixelFormatType_OneComponent16Half,
    kCVPixelFormatType_OneComponent32Float, kCVPixelFormatType_OneComponent8, CVPixelBuffer,
    CVPixelBufferCreate, CVPixelBufferGetBaseAddress, CVPixelBufferGetBytesPerRow,
    CVPixelBufferGetHeight, CVPixelBufferGetPixelFormatType, CVPixelBufferGetWidth,
    CVPixelBufferLockBaseAddress, CVPixelBufferLockFlags, CVPixelBufferUnlockBaseAddress,
};
use objc2_foundation::{NSArray, NSDictionary};
use objc2_vision::{VNGenerateForegroundInstanceMaskRequest, VNImageRequestHandler, VNRequest};
use std::ptr::NonNull;
use std::time::Instant;

/// Largest side accepted: the response header carries u16 sizes, and the app
/// sends 640 at most.
const MAX_SIDE: usize = 4096;

pub struct Mask {
    pub w: usize,
    pub h: usize,
    pub px: Vec<u8>,
    pub vision_us: u32,
}

/// Whether this macOS has the request (macOS 14+). Asked of the runtime rather
/// than the OS version: calling a class the system lacks would panic.
fn available() -> bool {
    AnyClass::get(c"VNGenerateForegroundInstanceMaskRequest").is_some()
}

fn rgba_buffer(w: usize, h: usize, rgba: &[u8]) -> Result<CFRetained<CVPixelBuffer>, String> {
    if rgba.len() != w * h * 4 {
        return Err(format!(
            "body is {} bytes, expected {}",
            rgba.len(),
            w * h * 4
        ));
    }
    let mut out: *mut CVPixelBuffer = std::ptr::null_mut();
    let rc = unsafe {
        CVPixelBufferCreate(
            None,
            w,
            h,
            kCVPixelFormatType_32BGRA,
            None,
            NonNull::new(&mut out).unwrap(),
        )
    };
    let ptr = NonNull::new(out)
        .filter(|_| rc == 0)
        .ok_or(format!("CVPixelBufferCreate: {rc}"))?;
    // SAFETY: Create returns +1, so the buffer is owned and released on drop.
    let pb = unsafe { CFRetained::from_raw(ptr) };
    unsafe {
        CVPixelBufferLockBaseAddress(&pb, CVPixelBufferLockFlags(0));
        let base = CVPixelBufferGetBaseAddress(&pb) as *mut u8;
        let bpr = CVPixelBufferGetBytesPerRow(&pb);
        // CVPixelBufferCreate has no 32RGBA on macOS: swap R and B on the way in.
        for y in 0..h {
            let src = &rgba[y * w * 4..(y + 1) * w * 4];
            let dst = std::slice::from_raw_parts_mut(base.add(y * bpr), w * 4);
            for (d, s) in dst.chunks_exact_mut(4).zip(src.chunks_exact(4)) {
                d.copy_from_slice(&[s[2], s[1], s[0], s[3]]);
            }
        }
        CVPixelBufferUnlockBaseAddress(&pb, CVPixelBufferLockFlags(0));
    }
    Ok(pb)
}

/// IEEE 754 half float to f32 (the mask may come back as OneComponent16Half).
fn half_to_f32(h: u16) -> f32 {
    let sign = if h & 0x8000 != 0 { -1.0 } else { 1.0 };
    let exp = ((h >> 10) & 0x1f) as i32;
    let frac = (h & 0x3ff) as f32;
    match exp {
        0 => sign * frac * 2f32.powi(-24),
        31 => {
            if frac == 0.0 {
                sign * f32::INFINITY
            } else {
                f32::NAN
            }
        }
        _ => sign * (1.0 + frac / 1024.0) * 2f32.powi(exp - 15),
    }
}

fn to_u8(v: f32) -> u8 {
    // NaN clamps to 0 through the comparison chain.
    if v >= 1.0 {
        255
    } else if v > 0.0 {
        (v * 255.0 + 0.5) as u8
    } else {
        0
    }
}

/// A one-component mask buffer (8-bit, half or 32-bit float) as 8-bit alpha.
///
/// SAFETY: `buf` must be a live, unlocked CVPixelBuffer.
unsafe fn gray8(buf: &CVPixelBuffer) -> Result<(usize, usize, Vec<u8>), String> {
    let fmt = CVPixelBufferGetPixelFormatType(buf);
    CVPixelBufferLockBaseAddress(buf, CVPixelBufferLockFlags(1));
    let (mw, mh) = (CVPixelBufferGetWidth(buf), CVPixelBufferGetHeight(buf));
    let bpr = CVPixelBufferGetBytesPerRow(buf);
    let base = CVPixelBufferGetBaseAddress(buf) as *const u8;
    let mut px = vec![0u8; mw * mh];
    let mut bad = false;
    for y in 0..mh {
        let row = base.add(y * bpr);
        let dst = &mut px[y * mw..(y + 1) * mw];
        match fmt {
            f if f == kCVPixelFormatType_OneComponent8 => {
                dst.copy_from_slice(std::slice::from_raw_parts(row, mw));
            }
            f if f == kCVPixelFormatType_OneComponent16Half => {
                let r = row as *const u16;
                for (x, d) in dst.iter_mut().enumerate() {
                    *d = to_u8(half_to_f32(r.add(x).read_unaligned()));
                }
            }
            f if f == kCVPixelFormatType_OneComponent32Float => {
                let r = row as *const f32;
                for (x, d) in dst.iter_mut().enumerate() {
                    *d = to_u8(r.add(x).read_unaligned());
                }
            }
            _ => {
                bad = true;
                break;
            }
        }
    }
    CVPixelBufferUnlockBaseAddress(buf, CVPixelBufferLockFlags(1));
    if bad {
        return Err(format!("unexpected mask pixel format {fmt:#x}"));
    }
    Ok((mw, mh, px))
}

/// Run the foreground-instance request on an RGBA frame. A frame with no
/// foreground is an all-zero mask at the frame's size: a result, not an error.
pub fn foreground_mask(w: usize, h: usize, rgba: &[u8]) -> Result<Mask, String> {
    if w == 0 || h == 0 || w > MAX_SIDE || h > MAX_SIDE {
        return Err(format!("bad frame size {w}x{h}"));
    }
    if !available() {
        return Err("Apple Vision's foreground mask needs macOS 14 or later".into());
    }
    let pb = rgba_buffer(w, h, rgba)?;
    let t0 = Instant::now();
    // One pool per frame: this runs on a Tokio blocking thread, which has no
    // pool of its own, and every frame autoreleases Vision's results, arrays
    // and error strings — at 15 Hz for a whole call.
    let (mw, mh, px) = autoreleasepool(|_| unsafe {
        let handler = VNImageRequestHandler::initWithCVPixelBuffer_options(
            VNImageRequestHandler::alloc(),
            &pb,
            &NSDictionary::new(),
        );
        let request = VNGenerateForegroundInstanceMaskRequest::new();
        let as_request: &VNRequest = &request;
        handler
            .performRequests_error(&NSArray::from_slice(&[as_request]))
            .map_err(|e| e.localizedDescription().to_string())?;
        match request.results().and_then(|r| r.firstObject()) {
            None => Ok::<_, String>((w, h, vec![0u8; w * h])),
            Some(obs) => {
                let buf = obs
                    .generateScaledMaskForImageForInstances_fromRequestHandler_error(
                        &obs.allInstances(),
                        &handler,
                    )
                    .map_err(|e| e.localizedDescription().to_string())?;
                gray8(&buf)
            }
        }
    })?;
    Ok(Mask {
        w: mw,
        h: mh,
        px,
        vision_us: t0.elapsed().as_micros() as u32,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn half_floats_decode() {
        assert_eq!(half_to_f32(0x0000), 0.0);
        assert_eq!(half_to_f32(0x3c00), 1.0);
        assert_eq!(half_to_f32(0x3800), 0.5);
        assert_eq!(half_to_f32(0xbc00), -1.0);
        assert!((half_to_f32(0x0001) - 5.960_464_5e-8).abs() < 1e-12);
    }

    #[test]
    fn alpha_clamps_and_rounds() {
        assert_eq!(to_u8(-0.2), 0);
        assert_eq!(to_u8(f32::NAN), 0);
        assert_eq!(to_u8(0.5), 128);
        assert_eq!(to_u8(1.7), 255);
    }

    #[test]
    fn bad_input_is_refused_before_vision() {
        assert!(foreground_mask(0, 10, &[]).is_err());
        assert!(foreground_mask(5000, 10, &[]).is_err());
        assert!(rgba_buffer(4, 4, &[0; 10]).is_err());
    }

    /// The whole request on a real (blank) frame: an answer at the input's
    /// size, whatever this Mac's Vision makes of it.
    #[test]
    fn a_blank_frame_answers_a_mask_at_its_own_size() {
        if !available() {
            return;
        }
        let m = foreground_mask(64, 36, &vec![0u8; 64 * 36 * 4]).unwrap();
        assert_eq!((m.w, m.h, m.px.len()), (64, 36, 64 * 36));
    }
}
