#!/usr/bin/env python3
"""Convert a PaddleSeg inference model to ONNX at a FIXED input size, for the
lab engine (docs/matting-candidates.md, src/lab-engine.js).

    FLAGS_enable_pir_api=0 python scripts/lab-export-paddle.py <model_dir> <out.onnx> <height> <width>

PaddleSeg's exported models have a dynamic input (-1, 3, -1, -1), and
paddle2onnx refuses their adaptive pools on a dynamic shape ("Adaptive only
support static input shape"). So the program is loaded, its input pinned to
1x3xHxW, the shapes inferred through every op, and the program saved again
before conversion. An adaptive pool becomes a fixed AveragePool, which is the
same operation only where the feature map divides evenly into the pool's
bins: PP-MattingV2 is exact at 512x512 and wrong at 384x640 (checked below
against Paddle's own predictor, which is why that is part of the script).

Needs paddlepaddle 3.x and paddle2onnx 2.x, with the legacy program format
(FLAGS_enable_pir_api=0: the .pdmodel files are pre-PIR).
"""
import os
import subprocess
import sys
import tempfile

import numpy as np


def main():
    model_dir, out, h, w = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
    os.environ.setdefault('FLAGS_enable_pir_api', '0')
    import paddle
    import paddle.inference as pi
    paddle.enable_static()
    exe = paddle.static.Executor(paddle.CPUPlace())
    prog, feeds, fetches = paddle.static.load_inference_model(os.path.join(model_dir, 'model'), exe)
    blk = prog.global_block()
    blk.var(feeds[0]).desc.set_shape([1, 3, h, w])
    for op in blk.ops:
        if op.type not in ('feed', 'fetch'):
            op.desc.infer_shape(blk.desc)
    prog._sync_with_cpp()
    with tempfile.TemporaryDirectory() as tmp:
        fixed = os.path.join(tmp, 'model')
        paddle.static.save_inference_model(fixed, [blk.var(feeds[0])], fetches, exe, program=prog)
        subprocess.run([sys.executable, '-m', 'paddle2onnx.command', '--model_dir', tmp,
                        '--model_filename', 'model.pdmodel', '--params_filename', 'model.pdiparams',
                        '--save_file', out, '--opset_version', '13'], check=True,
                       stdout=subprocess.DEVNULL, env=dict(os.environ, FLAGS_enable_pir_api='0'))

    # The converted graph against Paddle's predictor on the original model.
    import onnxruntime as ort
    x = np.random.RandomState(0).rand(1, 3, h, w).astype(np.float32)
    c = pi.Config(os.path.join(model_dir, 'model.pdmodel'), os.path.join(model_dir, 'model.pdiparams'))
    c.disable_gpu()
    c.switch_ir_optim(False)
    c.disable_glog_info()
    p = pi.create_predictor(c)
    ih = p.get_input_handle(p.get_input_names()[0])
    ih.reshape(x.shape)
    ih.copy_from_cpu(x)
    p.run()
    ref = p.get_output_handle(p.get_output_names()[0]).copy_to_cpu()
    so = ort.SessionOptions()
    so.log_severity_level = 3   # paddle2onnx leaves unused initialisers: one warning each
    s = ort.InferenceSession(out, so, providers=['CPUExecutionProvider'])
    got = s.run(None, {s.get_inputs()[0].name: x})[0]
    diff = float(np.abs(ref - got).mean())
    print(f'{out}: mean |onnx - paddle| = {diff:.2e}')
    if diff > 5e-3:
        sys.exit('converted graph differs from Paddle at this size')


if __name__ == '__main__':
    main()
