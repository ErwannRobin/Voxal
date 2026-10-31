# Foreground matting evaluation: MediaPipe, Longpipe, RVM

Status: **in progress** (living document, updated as each stage lands).

Question: would a video-matting model — Robust Video Matting (RVM) or another
browser-compatible one — integrate the person into Voxal's virtual backgrounds
more naturally than the two engines already wired in (MediaPipe's selfie
segmenter and Longpipe), and what in the current compositing is wrong
whichever model is used?

Priority: natural foreground integration first, real-time performance second.

## Licensing (verified 2026-10-31)

| Engine | Code | Weights | Fit for Voxal (MIT, shipped in App Store / Play builds) |
|---|---|---|---|
| MediaPipe selfie segmenter | Apache-2.0 | Apache-2.0 (model card) | Yes (already shipped) |
| Longpipe | MIT | MIT | Yes (already shipped, default engine) |
| RVM (PeterL1n/RobustVideoMatting) | **GPL-3.0** (re-licensed 2021-09-16) | Published in the same repository's v1.0.0 release with no separate licence, so GPL-3.0 is the only grant | **No, not without a separate licence from the authors** |

RVM's `LICENSE` is the GNU GPL v3 and its README says "Code is re-released
under GPL-3.0 license". Distributing Voxal with RVM's code or weights inside it
would make the distributed work subject to GPL-3.0 (source offer for the whole
combined work, no additional restrictions — which also collides with App Store
terms). Voxal is MIT and ships proprietary-store binaries. So RVM can be
**evaluated** here, but not shipped by default: the prototype in this branch
never vendors RVM's weights or code into the repository, and loads them only
from a local, gitignored staging directory (or a URL a developer sets) for the
benchmark. A production path would need either a commercial licence from the
rights holders or a model with a permissive licence (see the recommendation
section once the measurements are in).

## Method

* One engine interface (`createSegmenter(raw, engine)` in `video-effects.js`):
  `mediapipe`, `longpipe`, and the experimental `rvm`. Everything after the mask
  (dilate, feather, temporal blend, hair refinement, decontamination, scenes,
  light) is shared, so a difference in the output is the model's.
* Identical footage, backgrounds and output settings for every engine.
* Raw masks and final composites compared on hair, shoulders, halos,
  background-colour contamination, fast movement and temporal flicker.
* Performance at 640x360 and 1280x720 on the hardware actually available;
  anything not measured is stated as not measured.
