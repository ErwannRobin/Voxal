//! Apple Vision foreground mask for the camera cut-out (macOS only).
//!
//! PROTOTYPE — measured in `docs/apple-vision-evaluation.md`, not used by the
//! app's pipeline yet. The webview owns the camera, so a frame goes
//! webview -> Rust over Tauri IPC (raw bytes), through
//! `VNGenerateForegroundInstanceMaskRequest`, and the mask comes back as raw
//! bytes.
//!
//! Wire format
//!   request : body = RGBA8 pixels (width * height * 4); headers `x-width`, `x-height`
//!   response: 12-byte header, then `mw * mh` bytes of 8-bit alpha (0 = background)
//!             u16 LE mw, u16 LE mh, u32 LE vision_us (the Vision call alone), u32 LE total_us
//!
//! The mask is Vision's own low-resolution analysis mask
//! (`generateMaskForInstances`), not the upscaled one: it is the cheaper read,
//! and the camera pipeline resamples a mask on the GPU anyway.

use objc2::AnyThread;
use objc2_core_foundation::CFRetained;
use objc2_core_video::{
    kCVPixelFormatType_32BGRA, CVPixelBuffer, CVPixelBufferCreate, CVPixelBufferGetBaseAddress,
    CVPixelBufferGetBytesPerRow, CVPixelBufferGetHeight, CVPixelBufferGetWidth,
    CVPixelBufferLockBaseAddress, CVPixelBufferLockFlags, CVPixelBufferUnlockBaseAddress,
};
use objc2_foundation::{NSArray, NSDictionary};
use objc2_vision::{VNGenerateForegroundInstanceMaskRequest, VNImageRequestHandler, VNRequest};
use std::ptr::NonNull;
use std::time::Instant;

pub struct Mask {
    pub w: usize,
    pub h: usize,
    pub px: Vec<u8>,
    pub vision_us: u32,
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

/// Run the foreground-instance request on an RGBA frame. `Ok(None)` = Vision
/// found no foreground (the mask is then empty, which is a result, not an error).
pub fn foreground_mask(w: usize, h: usize, rgba: &[u8]) -> Result<Mask, String> {
    let pb = rgba_buffer(w, h, rgba)?;
    let t0 = Instant::now();
    let (mw, mh, px) = unsafe {
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
        let obs = request.results().and_then(|r| r.firstObject());
        match obs {
            None => (0, 0, Vec::new()),
            Some(obs) => {
                let all = obs.allInstances();
                let buf = obs
                    .generateMaskForInstances_error(&all)
                    .map_err(|e| e.localizedDescription().to_string())?;
                CVPixelBufferLockBaseAddress(&buf, CVPixelBufferLockFlags(1));
                let (mw, mh) = (CVPixelBufferGetWidth(&buf), CVPixelBufferGetHeight(&buf));
                let bpr = CVPixelBufferGetBytesPerRow(&buf);
                let base = CVPixelBufferGetBaseAddress(&buf) as *const u8;
                let mut px = vec![0u8; mw * mh];
                for y in 0..mh {
                    let row = base.add(y * bpr) as *const f32;
                    for x in 0..mw {
                        px[y * mw + x] = (row.add(x).read().clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
                    }
                }
                CVPixelBufferUnlockBaseAddress(&buf, CVPixelBufferLockFlags(1));
                (mw, mh, px)
            }
        }
    };
    Ok(Mask {
        w: mw,
        h: mh,
        px,
        vision_us: t0.elapsed().as_micros() as u32,
    })
}
