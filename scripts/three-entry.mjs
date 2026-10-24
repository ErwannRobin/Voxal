// The Three.js build the animated backgrounds load (src/assets/three/three.min.js).
// All of three's core, plus the few addons the scene kit uses, in ONE file: a
// second file would `import 'three'` by its bare name, which only an import
// map can resolve, and the app has no module system to provide one.
//
// Rebuilt by `make three-vendor` from the exact version pinned in package.json.
export * from 'three';
export { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
export { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
