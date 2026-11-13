#!/usr/bin/env python3
"""Export the PyTorch matting candidates of the lab engine to ONNX
(docs/matting-candidates.md, src/lab-engine.js).

    python scripts/lab-export-torch.py modnet-webcam --repo MODNet/ --ckpt modnet_webcam_portrait_matting.ckpt --out modnet_webcam_fp32.onnx
    python scripts/lab-export-torch.py sghm --repo SemanticGuidedHumanMatting/ --ckpt SGHM-ResNet50.pth --out sghm_r50_fp32.onnx

Both graphs take RGB in NCHW with dynamic height and width. Each one is
checked against its own PyTorch module on a random input before it is
written.

* MODNet (Apache-2.0, https://github.com/ZHKKKe/MODNet): the repository's own
  ONNX variant of the network (onnx/modnet_onnx.py), with the webcam
  checkpoint. Input normalised (x - 0.5) / 0.5, sides multiples of 32. Output:
  the alpha.
* SGHM (MIT, https://github.com/cxgincsu/SemanticGuidedHumanMatting): the
  model returns three alphas (1/8, 1/4 and full scale) and its test script
  fuses them with a dilated "unknown band" computed in NumPy with cv2's
  elliptical kernels. Here that fusion is folded into the graph, with a square
  max-pool standing in for the ellipse (widths 15 and 7, as at test time), so
  one output, `pha`, comes back. Input: RGB 0-1 (the backbone normalises
  nothing), sides multiples of 64. Output: the alpha.
"""
import argparse
import sys

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F


def unknown_band(pred, width):
    band = ((pred > 1.0 / 255.0) & (pred < 1.0 - 1.0 / 255.0)).float()
    if width > 1:
        band = F.max_pool2d(band, kernel_size=width, stride=1, padding=width // 2)
    return band > 0


class SghmFused(nn.Module):
    def __init__(self, model):
        super().__init__()
        self.model = model

    def forward(self, src):
        pred = self.model(src)
        a = pred['alpha_os8']
        w4 = unknown_band(a, 15)
        a = torch.where(w4, pred['alpha_os4'], a)
        w1 = unknown_band(a, 7)
        a = torch.where(w1, pred['alpha_os1'], a)
        return a.clamp(0, 1)


def load_modnet(repo, ckpt):
    # The repository's onnx/modnet_onnx.py, loaded by path: its package is
    # called `onnx` and would shadow the real one.
    import importlib.util
    import os
    import onnx  # noqa: F401  (the real one, before the repository is on the path)
    sys.path.append(repo)
    spec = importlib.util.spec_from_file_location('modnet_onnx', os.path.join(repo, 'onnx', 'modnet_onnx.py'))
    modnet_onnx = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(modnet_onnx)
    net = modnet_onnx.MODNet(backbone_pretrained=False)
    sd = torch.load(ckpt, map_location='cpu')
    sd = {k[7:] if k.startswith('module.') else k: v for k, v in sd.items()}
    net.load_state_dict(sd)
    return net.eval(), (1, 3, 288, 512), ['input'], ['output']


def load_sghm(repo, ckpt):
    sys.path.insert(0, repo)
    from model.model import HumanMatting
    net = HumanMatting(backbone='resnet50')
    sd = torch.load(ckpt, map_location='cpu')
    sd = {k[7:] if k.startswith('module.') else k: v for k, v in sd.items()}
    net.load_state_dict(sd)
    return SghmFused(net.eval()).eval(), (1, 3, 320, 576), ['src'], ['pha']


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('model', choices=['modnet-webcam', 'sghm'])
    ap.add_argument('--repo', required=True)
    ap.add_argument('--ckpt', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--opset', type=int, default=17)
    a = ap.parse_args()
    net, shape, ins, outs = (load_modnet if a.model == 'modnet-webcam' else load_sghm)(a.repo, a.ckpt)
    x = torch.rand(*shape)
    with torch.no_grad():
        ref = net(x)
        torch.onnx.export(net, x, a.out, input_names=ins, output_names=outs, opset_version=a.opset,
                          dynamic_axes={ins[0]: {2: 'h', 3: 'w'}, outs[0]: {2: 'h', 3: 'w'}}, dynamo=False)
    import onnxruntime as ort
    s = ort.InferenceSession(a.out, providers=['CPUExecutionProvider'])
    got = s.run(None, {ins[0]: x.numpy()})[0]
    diff = float(np.abs(got - ref.numpy()).max())
    print(f'{a.out}: max |onnx - torch| = {diff:.2e}')
    if diff > 1e-3:
        sys.exit('export differs from the PyTorch module')


if __name__ == '__main__':
    main()
