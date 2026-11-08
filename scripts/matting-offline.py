#!/usr/bin/env python3
"""Compute an OFFLINE model's mattes over the matting footage, for the matting
bench's `pre:<name>` engine (docs/matting-candidates.md).

Some models are worth knowing the score of even though they cannot run in a
browser in real time: they say how much better a matte COULD be, which is what
decides whether chasing a model is worth it. This runs one over every frame of
bench-results/matting/footage/<room>/ and writes its alpha, at the model's own
output size, to footage/pre/<name>/<room>/NNNN.png; then

    node scripts/matting-bench.mjs --engines pre:<name>

puts those mattes through Voxal's real pipeline exactly like a live engine's.

    python scripts/matting-offline.py birefnet-lite   [--rooms wall,living,kitchen]
    python scripts/matting-offline.py matanyone2 --repo .cache/lab/MatAnyone2

* birefnet-lite (MIT, ZhengPeng7/BiRefNet_lite on Hugging Face, through
  transformers): 1024x1024, the size it was built for, one frame at a time.
* matanyone2 (NTU S-Lab License 1.0, non-commercial: measured, never shipped):
  a memory-based VIDEO matting model. It needs the person's mask on the first
  frame; that mask comes from MODNet (src/assets/lab/modnet_fp32.onnx,
  thresholded at 0.5) — what a real call would have — never from the truth.
  Run at the footage's own size with the repository's defaults (10 warm-up
  repeats of the first frame, erode/dilate 10).

Runs on Apple's GPU (MPS) when there is one. Needs the lab's PyTorch venv
(scripts/lab-assets.sh) plus transformers/timm/kornia (BiRefNet) or the
MatAnyone2 repository installed with `pip install --no-deps -e`.
"""
import argparse
import os
import sys
import tempfile

import numpy as np
from PIL import Image

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
FOOTAGE = os.path.join(ROOT, 'bench-results', 'matting', 'footage')


def frames(room):
    d = os.path.join(FOOTAGE, room)
    return [os.path.join(d, f) for f in sorted(os.listdir(d)) if f[:4].isdigit() and f.endswith('.jpg')]


def save(a, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    Image.fromarray((np.clip(a, 0, 1) * 255 + 0.5).astype(np.uint8)).save(path)


def run_birefnet(rooms, name, model_id):
    os.environ.setdefault('PYTORCH_ENABLE_MPS_FALLBACK', '1')   # deform_conv2d has no MPS kernel
    import torch
    from transformers import AutoModelForImageSegmentation
    dev = 'mps' if torch.backends.mps.is_available() else 'cpu'
    net = AutoModelForImageSegmentation.from_pretrained(model_id, trust_remote_code=True).eval().float().to(dev)
    mean = torch.tensor([0.485, 0.456, 0.406]).view(1, 3, 1, 1).to(dev)
    std = torch.tensor([0.229, 0.224, 0.225]).view(1, 3, 1, 1).to(dev)
    for room in rooms:
        for f in frames(room):
            x = np.asarray(Image.open(f).convert('RGB').resize((1024, 1024), Image.BILINEAR), np.float32) / 255
            x = torch.from_numpy(x).permute(2, 0, 1)[None].to(dev)
            with torch.no_grad():
                y = net((x - mean) / std)[-1].sigmoid()[0, 0].float().cpu().numpy()
            save(y, os.path.join(FOOTAGE, 'pre', name, room, os.path.basename(f)[:4] + '.png'))
        print(f'{name}: {room} done', flush=True)


def first_mask(path, out):
    import onnxruntime as ort
    s = ort.InferenceSession(os.path.join(ROOT, 'src', 'assets', 'lab', 'modnet_fp32.onnx'), providers=['CPUExecutionProvider'])
    img = Image.open(path).convert('RGB')
    x = (np.asarray(img.resize((512, 288), Image.BILINEAR), np.float32) / 255 - 0.5) / 0.5
    a = s.run(None, {'input': x.transpose(2, 0, 1)[None]})[0][0, 0]
    m = Image.fromarray(((a > 0.5) * 255).astype(np.uint8)).resize(img.size, Image.NEAREST)
    m.save(out)


def run_matanyone2(rooms, name, repo):
    sys.path.insert(0, repo)
    # Its loader downloads the weights into ./pretrained_models when it does
    # not see them there: run from the repository, not from Voxal's root.
    os.chdir(repo)
    import inference_matanyone2 as inf
    # The script also writes MP4 previews, through an imageio call newer
    # imageio refuses; only the per-frame alphas are wanted here.
    inf.imageio.mimwrite = lambda *a, **k: None
    for room in rooms:
        with tempfile.TemporaryDirectory() as tmp:
            src = os.path.join(tmp, room)
            os.makedirs(src)
            fr = frames(room)
            for f in fr:   # frames only: the folder also holds the plate
                os.symlink(f, os.path.join(src, os.path.basename(f)))
            mask = os.path.join(tmp, 'mask.png')
            first_mask(fr[0], mask)
            out = os.path.join(tmp, 'out')
            # Its model loader initialises Hydra once per call: clear it so a
            # second room can load the model again.
            from hydra.core.global_hydra import GlobalHydra
            GlobalHydra.instance().clear()
            inf.main(src, mask, out, os.path.join(repo, 'pretrained_models', 'matanyone2.pth'), save_image=True)
            pha = os.path.join(out, room, 'pha')
            for p in sorted(os.listdir(pha)):
                a = np.asarray(Image.open(os.path.join(pha, p)).convert('L'), np.float32) / 255
                save(a, os.path.join(FOOTAGE, 'pre', name, room, p))
        print(f'{name}: {room} done', flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('model', choices=['birefnet-lite', 'matanyone2'])
    ap.add_argument('--rooms', default='wall,living,kitchen')
    ap.add_argument('--repo', default=os.path.join(ROOT, '.cache', 'lab', 'MatAnyone2'))
    a = ap.parse_args()
    rooms = a.rooms.split(',')
    if a.model == 'birefnet-lite':
        run_birefnet(rooms, a.model, 'ZhengPeng7/BiRefNet_lite')
    else:
        run_matanyone2(rooms, a.model, a.repo)


if __name__ == '__main__':
    main()
