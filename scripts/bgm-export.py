"""Export BackgroundMattingV2 (MobileNetV2) to ONNX for the browser.

EXPERIMENTAL, for the BackgroundMattingV2 evaluation only
(docs/bgm-evaluation.md). Run by scripts/bgm-assets.sh (make bgm-assets), which
fetches the official code and checkpoint and pins both; this file only converts.

BackgroundMattingV2 (https://github.com/PeterL1n/BackgroundMattingV2, MIT) is a
matting network that is handed TWO pictures: the camera frame and a photograph
of the same room without the person in it (the "plate"). A MobileNetV2 base
runs on both at a fraction of the size (`backbone_scale`) and predicts a coarse
alpha, foreground residual, error map and a 32-channel hidden encoding; a small
refiner then brings alpha and foreground to the full input size.

The release's own ONNX files use the refiner's "sampling" mode: it picks the
patches with the largest predicted error (TopK), crops them (NonZero, RoiAlign)
and writes them back (ScatterElements, If). ONNX Runtime Web's WebGPU backend
runs none of those, so each would fall back to the CPU inside the session,
copying full-size feature maps every frame (the P3M-Net lesson, see
docs/p3m-evaluation.md). The refiner's "full" mode is the same weights applied
everywhere with ordinary convolutions: plain Conv, Pad, Resize and Concat.
It costs more arithmetic than refining a few thousand patches, but it is all
GPU work, and on a webcam-sized input it is small. --verify checks that
"full" equals "sampling" with every patch selected, i.e. that nothing but the
patch selection changed.

The export's inputs are `src` and `bgr`, RGB in 0-1, NCHW, both sides
multiples of 4 (the refiner works at 1/2 and 1/4 size). Outputs: `pha`, the
alpha (0-1), and `fgr`, the person's own colour (0-1), both at the input size.

`backbone_scale` is a constant of the graph, so each scale is its own file:
bgm_mnv2_s<NN>_<prec>.onnx, NN = scale x 100.

Usage (from the repository root, inside a venv with torch, onnx, onnxruntime):
  python -I scripts/bgm-export.py --repo <BackgroundMattingV2> --ckpt <file.pth> \
         --out src/assets/bgm [--scales 0.25,0.5] \
         [--verify-src frame.jpg --verify-bgr plate.png]
"""
import argparse
import os
import sys

import numpy as np
import torch
import torch.nn.functional as F
from torch import nn


def load_official(repo, ckpt, scale, mode='full', sample_pixels=80_000, prevent_oversampling=True):
    """The official MattingRefine with the checkpoint's weights, eval mode."""
    if repo not in sys.path:
        sys.path.insert(0, repo)
    from model import MattingRefine      # noqa: E402  (needs the repository on sys.path)
    net = MattingRefine('mobilenetv2', backbone_scale=scale, refine_mode=mode,
                        refine_sample_pixels=sample_pixels,
                        refine_prevent_oversampling=prevent_oversampling)
    # weights_only: the checkpoint is a pickle; never let it run code.
    sd = torch.load(ckpt, map_location='cpu', weights_only=True)
    net.load_state_dict(sd, strict=True)
    return net.eval()


class BgmExport(nn.Module):
    """MattingRefine.forward, minus what the browser does not read (the coarse
    outputs) and without its in-place clamps: `x[:, 0:1].clamp_()` and
    `fgr.add_(src)` on a slice export as ScatterND (with a Range / Equal /
    Where index chain), which is not a WebGPU kernel. Out of place, they are
    Clip and Add. --verify compares the result with the original module."""

    def __init__(self, net):
        super().__init__()
        self.net = net

    def forward(self, src, bgr):
        n = self.net
        s = n.backbone_scale
        src_sm = F.interpolate(src, scale_factor=s, mode='bilinear', align_corners=False,
                               recompute_scale_factor=True)
        bgr_sm = F.interpolate(bgr, scale_factor=s, mode='bilinear', align_corners=False,
                               recompute_scale_factor=True)
        x, *shortcuts = n.backbone(torch.cat([src_sm, bgr_sm], dim=1))
        x = n.decoder(n.aspp(x), *shortcuts)
        pha_sm = x[:, 0:1].clamp(0., 1.)
        fgr_sm = x[:, 1:4]
        err_sm = x[:, 4:5].clamp(0., 1.)
        hid_sm = x[:, 5:].relu()
        pha, fgr, _ = n.refiner(src, bgr, pha_sm, fgr_sm, err_sm, hid_sm)
        return pha.clamp(0., 1.), (fgr + src).clamp(0., 1.)


def export(net, path, h, w, opset):
    m = BgmExport(net).eval()
    src, bgr = torch.rand(1, 3, h, w), torch.rand(1, 3, h, w)
    axes = {2: 'h', 3: 'w'}
    torch.onnx.export(m, (src, bgr), path, input_names=['src', 'bgr'], output_names=['pha', 'fgr'],
                      dynamic_axes={'src': axes, 'bgr': axes, 'pha': axes, 'fgr': axes},
                      opset_version=opset, do_constant_folding=True, dynamo=False)
    fold(path)
    return m


def fold(path):
    """Constant-fold what the exporter leaves behind (F.pad's pads and the
    interpolations' sizes arrive as Shape / Gather / Concat chains) with ONNX
    Runtime's basic level, which only uses standard ONNX ops, so the file stays
    portable."""
    import onnxruntime as ort
    so = ort.SessionOptions()
    so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_BASIC
    so.optimized_model_filepath = path + '.tmp'
    ort.InferenceSession(path, so, providers=['CPUExecutionProvider'])
    os.replace(path + '.tmp', path)


def to_w16(path):
    """Half-float STORAGE, fp32 compute: each weight is stored as fp16 and
    widened by a Cast in front of its use, which ONNX Runtime folds back into
    an fp32 initializer when the session is created (same as P3M-Net's)."""
    import onnx
    from onnx import helper, numpy_helper, TensorProto
    model = onnx.load(path)
    g = model.graph
    keep, casts = [], []
    for init in g.initializer:
        if init.data_type == TensorProto.FLOAT and np.prod(init.dims) >= 16:
            arr = numpy_helper.to_array(init).astype(np.float16)
            h = numpy_helper.from_array(arr, init.name + '__w16')
            keep.append(h)
            casts.append(helper.make_node('Cast', [h.name], [init.name], to=TensorProto.FLOAT,
                                          name=init.name + '__widen'))
        else:
            keep.append(init)
    del g.initializer[:]
    g.initializer.extend(keep)
    nodes = list(g.node)
    del g.node[:]
    g.node.extend(casts + nodes)
    out = path.replace('_fp32', '_w16')
    onnx.save(model, out)
    return out


def op_census(path):
    import onnx
    from collections import Counter
    c = Counter(n.op_type for n in onnx.load(path).graph.node)
    return ', '.join('%s %d' % kv for kv in sorted(c.items()))


def load_pair(src_path, bgr_path, h, w):
    from PIL import Image

    def t(p):
        im = Image.open(p).convert('RGB').resize((w, h), Image.BILINEAR)
        return torch.from_numpy(np.asarray(im, dtype=np.float32) / 255.0).permute(2, 0, 1)[None]
    return t(src_path), t(bgr_path)


def verify(repo, ckpt, scale, paths, src_path, bgr_path, h, w):
    import onnxruntime as ort
    src, bgr = load_pair(src_path, bgr_path, h, w)
    with torch.no_grad():
        full = load_official(repo, ckpt, scale, 'full')(src, bgr)
        # Every 4x4 patch selected: the patch path computing what "full" does.
        every = load_official(repo, ckpt, scale, 'sampling', sample_pixels=h * w,
                              prevent_oversampling=False)(src, bgr)
        # What the authors ship: the 80,000 pixels with the largest error.
        shipped = load_official(repo, ckpt, scale, 'sampling')(src, bgr)
        mine = BgmExport(load_official(repo, ckpt, scale, 'full')).eval()(src, bgr)
    d = lambda a, b: (np.abs(a.numpy() - b.numpy()).max(), np.abs(a.numpy() - b.numpy()).mean())
    print('verify %dx%d, backbone_scale %.2f' % (w, h, scale))
    print('  export wrapper vs official full: pha max %.2e | fgr max %.2e' %
          (d(mine[0], full[0])[0], d(mine[1], full[1])[0]))
    print('  full vs sampling(every patch): pha max %.2e mean %.2e | fgr max %.2e' %
          (*d(full[0], every[0]), d(full[1], every[1])[0]))
    print('  full vs sampling(80k, as shipped): pha max %.3f mean %.5f' % d(full[0], shipped[0]))
    for p in paths:
        s = ort.InferenceSession(p, providers=['CPUExecutionProvider'])
        pha, fgr = s.run(None, {'src': src.numpy(), 'bgr': bgr.numpy()})
        print('  %s vs torch full: pha max %.3f mean %.6f | fgr max %.3f mean %.6f' % (
            os.path.basename(p),
            np.abs(pha - full[0].numpy()).max(), np.abs(pha - full[0].numpy()).mean(),
            np.abs(fgr - full[1].numpy()).max(), np.abs(fgr - full[1].numpy()).mean()))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--repo', required=True, help='the official repository (its model/ package)')
    ap.add_argument('--ckpt', required=True, help='pytorch_mobilenetv2.pth from the v1.0.0 release')
    ap.add_argument('--out', required=True)
    ap.add_argument('--scales', default='0.25,0.5')
    ap.add_argument('--opset', type=int, default=17)
    ap.add_argument('--verify-src', help='a camera frame with somebody in it')
    ap.add_argument('--verify-bgr', help='the same room, empty')
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    torch.set_grad_enabled(False)
    for scale in [float(s) for s in a.scales.split(',')]:
        name = 'bgm_mnv2_s%02d_fp32.onnx' % round(scale * 100)
        path = os.path.join(a.out, name)
        export(load_official(a.repo, a.ckpt, scale, 'full'), path, 360, 640, a.opset)
        paths = [path, to_w16(path)]
        for p in paths:
            print('wrote %s (%.1f MB)' % (p, os.path.getsize(p) / 1e6))
        print('  ops: ' + op_census(path))
        if a.verify_src and a.verify_bgr:
            for h, w in [(360, 640), (720, 1280)]:
                verify(a.repo, a.ckpt, scale, paths, a.verify_src, a.verify_bgr, h, w)


if __name__ == '__main__':
    main()
