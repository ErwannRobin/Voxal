#!/usr/bin/env node
// A small glTF binary (.glb) room to try "Add a scene" with, and the builder
// the tests use (tests/e2e/unit-custom-scenes.spec.js). No dependency: the
// file is written by hand, which is also a compact illustration of what
// docs/custom-scenes.md asks of a model — a camera where your eye is, a light,
// metres, +Y up.
//
//   node scripts/custom-scene-sample.mjs [out.glb] [--no-camera] [--no-light] [--no-animation]
//
// The room: a floor, a back wall and two side walls, a low cabinet behind
// where you sit, a lamp on it whose shade glows, a tall plant box on the
// right, and a cube on the left that turns slowly (the animation).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function boxGeometry(w, h, d) {
  const pos = [], nrm = [], idx = [];
  const faces = [
    [[1, 0, 0], [0, 0, -1], [0, 1, 0]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [1, 0, 0], [0, 0, -1]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [-1, 0, 0], [0, 1, 0]]
  ];
  const half = [w / 2, h / 2, d / 2];
  for (const [n, u, v] of faces) {
    const base = pos.length / 3;
    for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      for (let a = 0; a < 3; a++) pos.push((n[a] + u[a] * su + v[a] * sv) * half[a]);
      nrm.push(...n);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { pos: new Float32Array(pos), nrm: new Float32Array(nrm), idx: new Uint16Array(idx) };
}

// The rotation (a quaternion, x y z w) that turns -Z onto direction d.
function turnTo(d) {
  const l = Math.hypot(...d), b = d.map((x) => x / l), a = [0, 0, -1];
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const ax = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const q = [ax[0], ax[1], ax[2], 1 + dot];
  const n = Math.hypot(...q);
  return q.map((x) => x / n);
}

// Returns the .glb as a Uint8Array.
export function buildGlb({ camera = true, light = true, animation = true } = {}) {
  const chunks = [];
  let byteLength = 0;
  const bufferViews = [], accessors = [];
  function view(typed, target) {
    const pad = (4 - (byteLength % 4)) % 4;
    if (pad) { chunks.push(new Uint8Array(pad)); byteLength += pad; }
    const bytes = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
    chunks.push(bytes);
    bufferViews.push(Object.assign({ buffer: 0, byteOffset: byteLength, byteLength: bytes.byteLength }, target ? { target } : {}));
    byteLength += bytes.byteLength;
    return bufferViews.length - 1;
  }
  function accessor(typed, type, componentType, count, extra) {
    accessors.push(Object.assign({ bufferView: view(typed, extra && extra.target), componentType, count, type }, extra && extra.minmax || {}));
    return accessors.length - 1;
  }

  const materials = [], meshes = [], nodes = [];
  function material(name, rgb, o = {}) {
    materials.push({
      name,
      pbrMetallicRoughness: { baseColorFactor: [...rgb, 1], metallicFactor: o.metal || 0, roughnessFactor: o.rough == null ? 0.8 : o.rough },
      ...(o.emissive ? { emissiveFactor: o.emissive } : {})
    });
    return materials.length - 1;
  }
  function boxMesh(name, w, h, d, mat) {
    const g = boxGeometry(w, h, d);
    const P = accessor(g.pos, 'VEC3', 5126, g.pos.length / 3, { target: 34962, minmax: { min: [-w / 2, -h / 2, -d / 2], max: [w / 2, h / 2, d / 2] } });
    const N = accessor(g.nrm, 'VEC3', 5126, g.nrm.length / 3, { target: 34962 });
    const I = accessor(g.idx, 'SCALAR', 5123, g.idx.length, { target: 34963 });
    meshes.push({ name, primitives: [{ attributes: { POSITION: P, NORMAL: N }, indices: I, material: mat }] });
    return meshes.length - 1;
  }
  function node(o) { nodes.push(o); return nodes.length - 1; }

  const plaster = material('plaster', [0.82, 0.78, 0.72]);
  const oak = material('oak', [0.55, 0.38, 0.22], { rough: 0.6 });
  const floor = material('floor', [0.42, 0.33, 0.26], { rough: 0.5 });
  const green = material('leaves', [0.16, 0.36, 0.18]);
  const shade = material('lamp shade', [1, 0.92, 0.8], { emissive: [1, 0.78, 0.5] });
  const blue = material('cube', [0.2, 0.32, 0.6], { rough: 0.35, metal: 0.2 });

  const top = [];
  top.push(node({ name: 'floor', mesh: boxMesh('floor', 6, 0.1, 6, floor), translation: [0, -0.05, -1.5] }));
  top.push(node({ name: 'back wall', mesh: boxMesh('back wall', 6, 3, 0.1, plaster), translation: [0, 1.5, -4.5] }));
  top.push(node({ name: 'left wall', mesh: boxMesh('left wall', 0.1, 3, 6, plaster), translation: [-3, 1.5, -1.5] }));
  top.push(node({ name: 'right wall', mesh: boxMesh('right wall', 0.1, 3, 6, plaster), translation: [3, 1.5, -1.5] }));
  top.push(node({ name: 'cabinet', mesh: boxMesh('cabinet', 1.8, 0.7, 0.45, oak), translation: [0.3, 0.35, -3.9] }));
  top.push(node({ name: 'lamp', mesh: boxMesh('lamp', 0.3, 0.35, 0.3, shade), translation: [1.0, 0.95, -3.9] }));
  top.push(node({ name: 'plant', mesh: boxMesh('plant', 0.5, 1.6, 0.5, green), translation: [2.3, 0.8, -3.3] }));
  const cube = node({ name: 'turning cube', mesh: boxMesh('turning cube', 0.4, 0.4, 0.4, blue), translation: [-1.9, 1.3, -3.6] });
  top.push(cube);

  const gltf = {
    asset: { version: '2.0', generator: 'voxal scripts/custom-scene-sample.mjs' },
    scene: 0,
    scenes: [{ name: 'sample room', nodes: top }],
    nodes, meshes, materials, accessors, bufferViews
  };
  if (camera) {
    gltf.cameras = [{ type: 'perspective', perspective: { yfov: 0.87, znear: 0.05, zfar: 100, aspectRatio: 16 / 9 } }];
    // Where the eye is: 1.2 m up, a metre and a half into the room, looking
    // at the back wall (a glTF camera looks down its -Z).
    top.push(node({ name: 'voxal camera', camera: 0, translation: [0, 1.2, 1.2] }));
  }
  if (light) {
    gltf.extensionsUsed = ['KHR_lights_punctual'];
    gltf.extensions = { KHR_lights_punctual: { lights: [
      { name: 'window', type: 'directional', color: [1, 0.95, 0.88], intensity: 3 },
      { name: 'lamp', type: 'point', color: [1, 0.8, 0.55], intensity: 4, range: 6 }
    ] } };
    // The window's light from the upper right, down toward the back wall: a
    // glTF light shines down its -Z, turned onto that direction.
    top.push(node({ name: 'window light', rotation: turnTo([-0.5, -0.7, -0.5]), extensions: { KHR_lights_punctual: { light: 0 } } }));
    top.push(node({ name: 'lamp light', translation: [1.0, 1.25, -3.7], extensions: { KHR_lights_punctual: { light: 1 } } }));
  }
  if (animation) {
    // One turn of the cube about its vertical axis every 24 s.
    const times = new Float32Array([0, 6, 12, 18, 24]);
    const rot = new Float32Array([0, 0, 0, 1, 0, Math.SQRT1_2, 0, Math.SQRT1_2, 0, 1, 0, 0, 0, Math.SQRT1_2, 0, -Math.SQRT1_2, 0, 0, 0, -1]);
    const input = accessor(times, 'SCALAR', 5126, times.length, { minmax: { min: [0], max: [24] } });
    const output = accessor(rot, 'VEC4', 5126, rot.length / 4);
    gltf.animations = [{ name: 'turn', samplers: [{ input, output, interpolation: 'LINEAR' }], channels: [{ sampler: 0, target: { node: cube, path: 'rotation' } }] }];
  }
  const padBin = (4 - (byteLength % 4)) % 4;
  if (padBin) { chunks.push(new Uint8Array(padBin)); byteLength += padBin; }
  gltf.buffers = [{ byteLength }];

  let json = new TextEncoder().encode(JSON.stringify(gltf));
  const padJson = (4 - (json.length % 4)) % 4;
  if (padJson) { const j = new Uint8Array(json.length + padJson); j.set(json); j.fill(0x20, json.length); json = j; }
  const total = 12 + 8 + json.length + 8 + byteLength;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);        // 'glTF'
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, json.length, true);
  dv.setUint32(16, 0x4e4f534a, true);       // 'JSON'
  out.set(json, 20);
  let o = 20 + json.length;
  dv.setUint32(o, byteLength, true);
  dv.setUint32(o + 4, 0x004e4942, true);    // 'BIN\0'
  o += 8;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--')) || 'scene-previews/sample-room.glb';
  const glb = buildGlb({ camera: !args.includes('--no-camera'), light: !args.includes('--no-light'), animation: !args.includes('--no-animation') });
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, glb);
  console.log(`wrote ${file} (${glb.length} bytes)`);
}
