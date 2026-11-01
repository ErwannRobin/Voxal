"""Export the official P3M-Net (ResNet-34) checkpoint to ONNX for the browser.

EXPERIMENTAL, for the P3M-Net evaluation only (docs/p3m-evaluation.md). Run by
scripts/p3m-assets.sh (make p3m-assets), which fetches the official code and
checkpoint and pins both by hash; this file only converts.

P3M-Net (https://github.com/JizhiziLi/P3M, MIT) is an image matting network: a
ResNet-34 encoder whose five max-pools keep their argmax indices, a global
decoder that predicts a 3-class trimap (background / transition / foreground)
and a local decoder that predicts the alpha in the transition band, rebuilt
with MaxUnpool from those indices. The fused alpha is the local one where the
trimap says "transition", 0 or 1 elsewhere.

Two parts of that graph do not run on ONNX Runtime Web's WebGPU backend:
MaxPool with an Indices output and MaxUnpool. Unsupported nodes would fall
back to the CPU inside the session, copying full-resolution feature maps
across every frame. So the export swaps them for an exact equivalent made of
plain MaxPool, Pad, Slice, Equal, Where and DepthToSpace:

  * the pool keeps, per pooled cell, WHICH of its 3x3 window positions held
    the maximum (0-8, the first in row-major order on a tie — PyTorch's own
    rule), instead of a flat index;
  * the unpool writes each pooled value back to that position. With a 3x3
    window and stride 2 an output pixel can be the argmax of up to four
    windows; PyTorch's CPU kernel lets the last one written (the highest flat
    index) win, and so does this.

The equivalence is checked numerically against the original module at the
end (--verify), on the repository's sample portraits.

ImageNet normalisation is folded into the graph: input `src` is RGB in 0-1,
NCHW, H and W multiples of 32. Output `pha` is the fused alpha, 0-1, same size.

Usage (from the repository root, inside a venv with torch, onnx, onnxruntime):
  python -I scripts/p3m-export.py --core <P3M>/core --ckpt <file.pth> \
         --out src/assets/p3m [--verify <P3M>/samples/original] [--fp16]
"""
import argparse
import os
import sys
import types

import numpy as np
import torch
import torch.nn.functional as F


def load_official(core, ckpt):
    """The official P3mNet with the checkpoint's weights, eval mode."""
    sys.path.insert(0, core)
    import network.resnet_mp as rmp      # noqa: E402  (needs core/ on sys.path)
    import network.P3mNet as pm          # noqa: E402
    # resnet34_mp() loads the ImageNet backbone from a configured path in its
    # constructor; the matting checkpoint replaces every weight anyway.
    pm.resnet34_mp = lambda: rmp.ResNet(rmp.BasicBlock, [3, 4, 6, 3])
    net = pm.P3mNet()
    # weights_only: the checkpoint is a pickle; never let it run code.
    ck = torch.load(ckpt, map_location='cpu', weights_only=True)
    sd = ck.get('state_dict', ck)
    sd = {k[7:] if k.startswith('module.') else k: v for k, v in sd.items()}
    missing, unexpected = net.load_state_dict(sd, strict=False)
    # The backbone's classifier (fc) is never used by P3mNet.forward.
    missing = [k for k in missing if not k.startswith('resnet.fc')]
    if missing or [k for k in unexpected if not k.startswith('resnet.fc')]:
        raise SystemExit('checkpoint mismatch: missing %s unexpected %s' % (missing[:5], unexpected[:5]))
    return net.eval()


# --- MaxPool(3, 2, 1) with an argmax, MaxUnpool from it: WebGPU-safe ----------

def pool_k(x):
    """MaxPool2d(3, 2, padding=1) and, per output cell, the window offset
    (dy * 3 + dx, as float) of its maximum: first in row-major order on a tie.

    Written without anything shaped like the input (no zeros_like, no slice
    end read from a Shape): those export as ConstantOfShape / Shape nodes,
    which ONNX Runtime Web runs on the CPU. For an even H, rows dy, dy+2, ...
    of the padded map stop H/2 rows later at end -2, -1, None for dy = 0, 1, 2."""
    m = F.max_pool2d(x, 3, 2, 1)
    xp = F.pad(x, (1, 1, 1, 1), value=float('-inf'))
    ends = (-2, -1, None)
    # Visited last-to-first so the earliest hit is written last and wins: only
    # Equal and Where (ONNX Runtime Web has no WebGPU And / Or / Not).
    k = None
    for o in range(8, -1, -1):
        dy, dx = divmod(o, 3)
        c = xp[:, :, dy:ends[dy]:2, dx:ends[dx]:2]
        k = torch.where(c == m, float(o), -1.0 if k is None else k)
    return m, k


def _shift(t, di, dj, fill):
    """t[i + di, j + dj] at (i, j), `fill` past the edge (di, dj in {0, 1})."""
    if di:
        t = F.pad(t[:, :, 1:, :], (0, 0, 0, 1), value=fill)
    if dj:
        t = F.pad(t[:, :, :, 1:], (0, 1, 0, 0), value=fill)
    return t


class _DepthToSpaceDCR(torch.autograd.Function):
    """[N, 4C, H, W] with channel s*C + c -> [N, C, 2H, 2W], s = a*2 + b at
    (2i + a, 2j + b): ONNX DepthToSpace in DCR mode, one node."""

    @staticmethod
    def forward(ctx, x):
        n, c4, h, w = x.shape
        c = c4 // 4
        return x.view(n, 2, 2, c, h, w).permute(0, 3, 4, 1, 5, 2).reshape(n, c, h * 2, w * 2)

    @staticmethod
    def symbolic(g, x):
        return g.op('DepthToSpace', x, blocksize_i=2, mode_s='DCR')


def unpool_k(y, k):
    """MaxUnpool2d(3, 2, padding=1) of y at 2x its size, positions from pool_k.

    Output pixel (2i + a, 2j + b) can be the argmax of window i (a = 0: offset
    row 1; a = 1: offset row 2) or of window i + 1 (a = 1: offset row 0), and
    the same for columns. Candidates are visited in increasing flat window
    index so the last match wins, as in PyTorch's CPU kernel."""
    rows = {0: [(0, 1)], 1: [(0, 2), (1, 0)]}   # a -> [(window shift, offset row)]
    shifted = {}
    classes = []
    for a in (0, 1):
        for b in (0, 1):
            out = None
            for di, oy in rows[a]:
                for dj, ox in rows[b]:
                    key = (di, dj)
                    if key not in shifted:
                        shifted[key] = (_shift(y, di, dj, 0.0), _shift(k, di, dj, -1.0))
                    ys, ks = shifted[key]
                    out = torch.where(ks == float(oy * 3 + ox), ys, 0.0 if out is None else out)
            classes.append(out)
    return _DepthToSpaceDCR.apply(torch.cat(classes, 1))


class P3mExport(torch.nn.Module):
    """P3mNet.forward with the pools/unpools above, the normalisation folded
    in, and only the fused alpha out."""

    def __init__(self, net):
        super().__init__()
        self.n = net
        self.register_buffer('mean', torch.tensor([0.485, 0.456, 0.406]).view(1, 3, 1, 1))
        self.register_buffer('std', torch.tensor([0.229, 0.224, 0.225]).view(1, 3, 1, 1))

    @staticmethod
    def _dbfi(m, s, e4):
        # DBFI.forward without its side output (training-only deep supervision).
        x = torch.cat((m.transform1(s), m.upsample(m.transform2(e4))), 1)
        return m.relu(m.bn1(m.conv1(x))) + s

    def forward(self, src):
        n = self.n
        x = (src - self.mean) / self.std
        e0 = n.encoder0(x)
        e0p, k0 = pool_k(e0)
        e1p, k1 = pool_k(e0p)
        e1 = n.encoder1(e1p)
        e2p, k2 = pool_k(e1)
        e2 = n.encoder2(e2p)
        e3p, k3 = pool_k(e2)
        e3 = n.encoder3(e3p)
        e4p, k4 = pool_k(e3)
        e4 = n.encoder4(e4p)
        # global
        d4_g = n.decoder4_g(e4)
        d3_g = n.decoder3_g(d4_g)
        d2_g = n.decoder2_g(self._dbfi(n.dbfi_2, d3_g, e4))
        d1_g = n.decoder1_g(self._dbfi(n.dbfi_1, d2_g, e4))
        g = n.decoder0_g(self._dbfi(n.dbfi_0, d1_g, e4))
        # local
        d4_l = unpool_k(n.decoder4_l(e4), k4)
        d3_l = n.decoder3_l(n.tfi_3(d4_g, d4_l, e3))
        d3_l = unpool_k(d3_l, k3)
        d2_l = n.decoder2_l(n.sbfi_2(n.tfi_2(d3_g, d3_l, e2), e0))
        d2_l = unpool_k(d2_l, k2)
        d1_l = n.decoder1_l(n.sbfi_1(n.tfi_1(d2_g, d2_l, e1), e0))
        d1_l = unpool_k(d1_l, k1)
        d0_l = n.decoder0_l(n.sbfi_0(n.tfi_0(d1_g, d1_l, e0p), e0))
        d0_l = unpool_k(d0_l, k0)
        local = torch.sigmoid(n.decoder_final_l(d0_l))
        # fusion: argmax over the trimap logits, first index on a tie —
        # background (0) when g0 is the largest, else transition (local alpha)
        # when g1 >= g2, else foreground (1). Nested Where, no boolean ops.
        g0, g1, g2 = g[:, 0:1], g[:, 1:2], g[:, 2:3]
        y = torch.where(g1 >= g2, local, 1.0)
        return torch.where(g0 >= g1, torch.where(g0 >= g2, 0.0, y), y)


def official_fusion(net, src):
    """The original module's fused alpha, for the comparison."""
    x = (src - torch.tensor([0.485, 0.456, 0.406]).view(1, 3, 1, 1)) / torch.tensor([0.229, 0.224, 0.225]).view(1, 3, 1, 1)
    return net(x)[2]


def export(net, out, h, w, opset):
    m = P3mExport(net).eval()
    dummy = torch.rand(1, 3, h, w)
    path = os.path.join(out, 'p3m_r34_fp32.onnx')
    torch.onnx.export(m, (dummy,), path, input_names=['src'], output_names=['pha'],
                      dynamic_axes={'src': {2: 'h', 3: 'w'}, 'pha': {2: 'h', 3: 'w'}},
                      opset_version=opset, do_constant_folding=True, dynamo=False)
    fold(path)
    return m, path


def fold(path):
    """Constant-fold what the exporter leaves behind (F.pad's pads arrive as a
    Shape / ConstantOfShape / Reshape chain) with ONNX Runtime's basic level,
    which only uses standard ONNX ops, so the file stays portable."""
    import onnxruntime as ort
    so = ort.SessionOptions()
    so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_BASIC
    so.optimized_model_filepath = path + '.tmp'
    ort.InferenceSession(path, so, providers=['CPUExecutionProvider'])
    os.replace(path + '.tmp', path)


def to_fp16(path):
    """Half-float compute (every tensor fp16). Measured to move the alpha by
    1-2.6% on average (up to 0.95 on a pixel) on the sample portraits, so it
    is kept for timing comparisons only."""
    import onnx
    from onnxconverter_common import float16
    model = onnx.load(path)
    # keep_io_types: the page still feeds float32 and reads float32.
    m16 = float16.convert_float_to_float16(model, keep_io_types=True)
    out = path.replace('_fp32', '_fp16')
    onnx.save(m16, out)
    return out


def to_w16(path):
    """Half-float STORAGE, fp32 compute: each weight is stored as fp16 and
    widened by a Cast in front of its use, which ONNX Runtime folds back into
    an fp32 initializer when the session is created. Half the download of the
    fp32 file, the fp32 graph's arithmetic (only the weights' rounding)."""
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


def verify(net, wrapped, paths, sample_dir, size):
    import onnxruntime as ort
    from PIL import Image
    imgs = sorted(os.path.join(sample_dir, f) for f in os.listdir(sample_dir) if f.lower().endswith(('.jpg', '.png')))
    sessions = {p: ort.InferenceSession(p, providers=['CPUExecutionProvider']) for p in paths}
    print('verify at %dx%d (w x h), %d images' % (size[1], size[0], len(imgs)))
    for f in imgs:
        im = Image.open(f).convert('RGB').resize((size[1], size[0]), Image.BILINEAR)
        src = torch.from_numpy(np.asarray(im, dtype=np.float32) / 255.0).permute(2, 0, 1)[None]
        with torch.no_grad():
            ref = official_fusion(net, src).numpy()
            mine = wrapped(src).numpy()
        line = '  %s  torch rewrite vs official: max %.2e' % (os.path.basename(f), np.abs(ref - mine).max())
        for p, s in sessions.items():
            o = s.run(None, {'src': src.numpy()})[0]
            d = np.abs(ref - o)
            line += ' | %s: max %.3f mean %.5f' % (os.path.basename(p), d.max(), d.mean())
        print(line)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--core', required=True, help='the official repository\'s core/ directory')
    ap.add_argument('--ckpt', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--verify', help='a directory of portraits to compare on')
    ap.add_argument('--fp16', action='store_true')
    ap.add_argument('--opset', type=int, default=17)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    torch.set_grad_enabled(False)
    net = load_official(a.core, a.ckpt)
    wrapped, path = export(net, a.out, 288, 512, a.opset)
    paths = [path]
    paths.append(to_w16(path))
    if a.fp16:
        paths.append(to_fp16(path))
    for p in paths:
        print('wrote %s (%.1f MB)' % (p, os.path.getsize(p) / 1e6))
    if a.verify:
        for size in [(288, 512), (384, 672)]:
            verify(net, wrapped, paths, a.verify, size)


if __name__ == '__main__':
    main()
