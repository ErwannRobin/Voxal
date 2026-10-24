// custom.js — scenes people add themselves, from a file: a 360° panorama (an
// equirectangular photo or render, twice as wide as it is tall) or a 3D model
// (glTF binary, .glb). See docs/custom-scenes.md for what makes a good one.
//
// A file is DATA, never code: a picture is decoded by the browser, a model is
// parsed by Three's GLTFLoader (src/assets/three/gltf-loader.min.js, loaded
// only here). Nothing in a file can run in the page.
//
// The files live on this device only, in the IndexedDB store the custom
// background image already uses ('voxal-bg' / 'images'), under 'scene:<id>';
// what is known about each (its name, its kind, a thumbnail, its options) is a
// small list in localStorage (VideoScenes.customScenes()). video-effects.js
// stores them; this module only reads. Because nobody else has the file, a
// custom scene is never offered to a keyed peer: they get your picture.
//
// load(meta) parses a file once per page and returns a scene definition
// (the same shape as src/scenes/<id>.js: { id, camera, nearness, build,
// update }); build() makes the scene's objects for one context from what was
// parsed, so a second context (the preview while a call runs) builds its own.

import { THREE } from './engine.js';
import * as K from './kit.js';

const DB_NAME = 'voxal-bg', DB_STORE = 'images';
export const blobKey = (id) => 'scene:' + id;

function idbGet(key) {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error('no indexedDB')); return; }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(DB_STORE)) req.result.createObjectStore(DB_STORE);
    };
    req.onerror = () => reject(req.error || new Error('indexedDB open failed'));
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(DB_STORE, 'readonly');
      const get = tx.objectStore(DB_STORE).get(key);
      tx.oncomplete = () => { db.close(); resolve(get.result || null); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
  });
}

const _defs = new Map();
const _loading = new Map();

// The scene definition for `meta` (an entry of VideoScenes.customScenes()),
// parsed from its stored file. Once per page per scene.
export function load(meta) {
  if (_defs.has(meta.id)) return Promise.resolve(_defs.get(meta.id));
  if (_loading.has(meta.id)) return _loading.get(meta.id);
  const p = idbGet(blobKey(meta.id)).then((blob) => {
    if (!blob) throw new Error('the file for this scene is missing');
    if (meta.kind === 'panorama') return panoramaDef(meta, blob);
    if (meta.kind === 'model') return modelDef(meta, blob);
    throw new Error('unknown kind of scene: ' + meta.kind);
  }).then((def) => {
    _defs.set(meta.id, def);
    _loading.delete(meta.id);
    return def;
  }, (e) => {
    _loading.delete(meta.id);
    throw e;
  });
  _loading.set(meta.id, p);
  return p;
}
// Already parsed (for a synchronous build on a second context), or null.
export function loaded(id) { return _defs.get(id) || null; }
// A scene removed, or its file replaced: parse it again next time.
export function forget(id) {
  const d = _defs.get(id);
  if (d && d.release) d.release();
  _defs.delete(id);
}

// --- a panorama ------------------------------------------------------------------------------
//
// The picture on the inside of a sphere around the camera, so the look-around
// (a phone's turn, a drag) turns inside it. Its colours are given to the
// engine as the radiance that the output pass turns back into exactly them at
// exposure 1 (the inverse of its tone curve), so the photo looks like itself
// in a well-lit room and darkens and tints with yours (or with the scene light
// you chose). Far away by definition: no shadow of you falls on it.

// The output pass shows radiance x as srgb(aces(x * 0.55)); this undoes aces()
// and the 0.55 for a linear colour y in [0, 1).
const ACES_INVERSE = `
vec3 engAcesInverse(vec3 y) {
  y = clamp(y, 0.0, 0.985);
  vec3 a = 2.43 * y - 2.51, b = 0.59 * y - 0.03, c = 0.14 * y;
  vec3 x = (-b - sqrt(max(b * b - 4.0 * a * c, 0.0))) / (2.0 * a);
  return max(x, 0.0) / 0.55;
}
`;

const PANO_MAX_W = 8192;

async function panoramaDef(meta, blob) {
  const o = meta.options || {};
  // Decoded upside down: WebGL cannot flip an ImageBitmap on upload (Three's
  // flipY is ignored for one), and a sphere's top is the texture's last row.
  const keep = { bmp: await createImageBitmap(blob, { imageOrientation: 'flipY' }) };
  return {
    id: meta.id,
    mirror: false,
    camera: { pos: [0, 0, 0], target: [0, 0, -1], fov: o.fov || 55, near: 0.1, far: 1000 },
    nearness: [1, 2],
    build(k) {
      // A picture wider than this GPU's textures is brought down to fit.
      const max = Math.min(PANO_MAX_W, k.renderer.capabilities.maxTextureSize || 4096);
      let image = keep.bmp;
      if (image.width > max) {
        const c = document.createElement('canvas');
        c.width = max; c.height = Math.round(max * image.height / image.width);
        c.getContext('2d').drawImage(image, 0, 0, c.width, c.height);
        image = c;
      }
      const tex = k.track(new THREE.Texture(image));
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.flipY = false;
      tex.anisotropy = Math.min(8, k.renderer.capabilities.getMaxAnisotropy ? k.renderer.capabilities.getMaxAnisotropy() : 1);
      tex.needsUpdate = true;
      const geo = new THREE.SphereGeometry(500, 96, 48);
      // Seen from inside, the sphere's own mapping is mirrored: undo it.
      geo.scale(-1, 1, 1);
      const mat = k.basic({
        map: tex,
        receiver: 0,
        patch: {
          key: 'custom-panorama',
          fragmentHead: ACES_INVERSE,
          fragmentBefore: { opaque_fragment: 'outgoingLight = engAcesInverse(outgoingLight);' }
        }
      });
      const mesh = new THREE.Mesh(geo, mat);
      // The middle of the picture straight ahead, turned by `yaw` (degrees,
      // positive to the right), and the horizon raised or lowered by `pitch`.
      mesh.rotation.y = THREE.MathUtils.degToRad(-90 + (o.yaw || 0));
      mesh.rotation.x = THREE.MathUtils.degToRad(o.pitch || 0);
      mesh.frustumCulled = false;
      k.scene.add(mesh);
      return {};
    },
    update() { /* a photograph holds still */ },
    release() { try { keep.bmp.close(); } catch (e) { /* gone */ } }
  };
}

// --- a 3D model ------------------------------------------------------------------------------
//
// glTF 2.0 binary, as Blender, SketchUp and most tools export it. Voxal looks
// through the file's first camera (put one where your eye should be, about
// 1.2 m up, looking at the wall behind you); without one, it frames the whole
// model from its front. Its lights are used as they are (KHR_lights_punctual);
// without any, a sky and a sun light it. Its animations play, from the scene's
// own clock, so a keyed peer's picture and yours would agree (they never draw
// it, but the preview and the call do). Compressed geometry or textures
// (Draco, Meshopt, KTX2) are not supported: export without them.

async function modelDef(meta, blob) {
  const o = meta.options || {};
  const { GLTFLoader, cloneSkinned } = await import('../assets/three/gltf-loader.min.js');
  const buf = await blob.arrayBuffer();
  const gltf = await new GLTFLoader().parseAsync(buf, '');
  const root = gltf.scene || (gltf.scenes && gltf.scenes[0]);
  if (!root) throw new Error('the file has no scene');
  root.updateMatrixWorld(true);

  let camera;
  const fileCam = gltf.cameras && gltf.cameras.find((c) => c.isPerspectiveCamera);
  if (fileCam) {
    fileCam.updateMatrixWorld(true);
    const pos = new THREE.Vector3(), dir = new THREE.Vector3();
    fileCam.getWorldPosition(pos);
    fileCam.getWorldDirection(dir);
    camera = {
      pos: pos.toArray(), target: pos.clone().addScaledVector(dir, 10).toArray(),
      fov: o.fov || fileCam.fov || 50, near: Math.max(0.01, fileCam.near || 0.05), far: Math.max(100, fileCam.far || 2000)
    };
  } else {
    const box = new THREE.Box3().setFromObject(root);
    const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3());
    const d = Math.max(s.x, s.y, s.z) || 1;
    camera = {
      pos: [c.x, c.y + s.y * 0.05, c.z + d * 1.2], target: c.toArray(),
      fov: o.fov || 50, near: d * 0.01, far: d * 50
    };
  }
  let hasLights = false;
  root.traverse((n) => { if (n.isLight) hasLights = true; });
  const near = o.nearness || [3, 30];

  return {
    id: meta.id,
    mirror: false,
    camera,
    nearness: near,
    build(k) {
      // This context's own copy: geometry, materials and textures are
      // uploaded (and freed) per renderer.
      const copy = cloneSkinned(root);
      const seen = new Map();
      copy.traverse((n) => {
        if (n.isMesh) {
          n.geometry = n.geometry.clone();
          const one = (m) => {
            if (seen.has(m)) return seen.get(m);
            const c = m.clone();
            for (const [key, v] of Object.entries(c)) if (v && v.isTexture) c[key] = v.clone();
            k.adopt(c, { receiver: c.transparent ? undefined : 0.9 });
            seen.set(m, c);
            return c;
          };
          n.material = Array.isArray(n.material) ? n.material.map(one) : one(n.material);
          n.castShadow = true;
          n.receiveShadow = true;
        }
        if (n.isDirectionalLight || n.isSpotLight) {
          n.castShadow = true;
          n.shadow.mapSize.set(k.quality.shadow, k.quality.shadow);
          n.shadow.bias = -0.0005;
        }
      });
      k.scene.add(copy);
      const st = { root: copy, mixer: null, env: null };
      // Without lights of its own: a sky to see, a sun, and the sky's light.
      const s = K.sky(k, { sunDir: o.sunDir || [0.5, 0.45, -0.6], cloud: { coverage: 0.25 } });
      st.env = K.envFollower(k, s, 0.25, hasLights ? 0.35 : 1);
      if (!hasLights) {
        const sun = new THREE.DirectionalLight(0xfff1dc, 3);
        const box = new THREE.Box3().setFromObject(copy);
        const c = box.getCenter(new THREE.Vector3()), r = Math.max(1, box.getSize(new THREE.Vector3()).length() / 2);
        const dir = new THREE.Vector3().fromArray(o.sunDir || [0.5, 0.45, -0.6]).normalize();
        sun.position.copy(c).addScaledVector(dir, r * 2);
        sun.target.position.copy(c);
        sun.castShadow = true;
        sun.shadow.mapSize.set(k.quality.shadow, k.quality.shadow);
        Object.assign(sun.shadow.camera, { left: -r, right: r, top: r, bottom: -r, near: 0.1, far: r * 4 });
        sun.shadow.bias = -0.0005;
        k.scene.add(sun, sun.target);
        st.sun = sun;
      }
      if (gltf.animations && gltf.animations.length) {
        st.mixer = new THREE.AnimationMixer(copy);
        gltf.animations.forEach((a) => st.mixer.clipAction(a).play());
      }
      k.shadowsChanged();
      return st;
    },
    update(k, st, t, look) {
      if (st.env && st.env(look.night)) k.renderer.resetState();
      if (st.sun) st.sun.intensity = 3 * (1 - 0.85 * look.night);
      if (st.mixer) {
        // A function of the clock alone, like everything a scene moves.
        st.mixer.setTime(t);
        k.shadowsChanged();
      }
    }
  };
}
