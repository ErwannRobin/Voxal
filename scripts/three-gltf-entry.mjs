// The glTF loader for scenes people add themselves (src/scenes/custom.js),
// built into its own file (src/assets/three/gltf-loader.min.js) so the
// built-in scenes never download it. Its imports of 'three' are rewritten to
// './three.min.js' after the build (`make three-vendor`): the app has no
// import map, so a bare 'three' could not be resolved in the browser.
// By path, not by package name: --external:three would take the subpath too.
export { GLTFLoader } from '../node_modules/three/examples/jsm/loaders/GLTFLoader.js';
// A rigged (skinned) model must be copied with its skeleton rebound.
export { clone as cloneSkinned } from '../node_modules/three/examples/jsm/utils/SkeletonUtils.js';
