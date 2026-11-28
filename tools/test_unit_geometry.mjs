// Parse the actual GLB scene graphs on CPU. Textures are placeholders here;
// embedded images and visual appearance are checked separately in Blender.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from '../prototype/vendor/three/three.module.js';
import { GLTFLoader } from '../prototype/vendor/three/GLTFLoader.js';
import { UNIT_MODELS } from '../prototype/unit-models.js';
globalThis.self = globalThis;
globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });
globalThis.ProgressEvent = class { constructor(type, info) { Object.assign(this, info); this.type = type; } };

for (const spec of Object.values(UNIT_MODELS)) {
    const data = fs.readFileSync(new URL(spec.url));
    const gltf = await new GLTFLoader().parseAsync(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), '');
    const scene = new THREE.Group(); scene.add(gltf.scene);
    const before = new THREE.Box3().setFromObject(scene).getSize(new THREE.Vector3());
    scene.rotation.z = spec.roll || 0;
    const box = new THREE.Box3().setFromObject(scene), size = box.getSize(new THREE.Vector3());
    assert([size.x, size.y, size.z].every(n => Number.isFinite(n) && n > 0), `${spec.id}: finite volumetric geometry`);
    if (spec.id === 'rustroad-carrier' || spec.id === 'rustroad-fighter') {
        assert(before.y > before.x, `${spec.id}: source was rolled onto its side`);
        assert(size.y < size.x, `${spec.id}: correction puts wings/hull width in the horizontal plane`);
    }
    let triangles = 0;
    scene.traverse(object => {
        if (!object.isMesh) return;
        const positions = object.geometry.attributes.position.array;
        assert(positions.every(Number.isFinite), `${spec.id}: no NaN vertices`);
        triangles += (object.geometry.index?.count ?? positions.length / 3) / 3;
        assert(object.material, `${spec.id}: material is connected`);
    });
    assert(triangles > 0, `${spec.id}: renderable surfaces`);
    scene.traverse(object => { if (object.isMesh) { object.geometry.dispose(); for (const material of [].concat(object.material)) { for (const value of Object.values(material)) if (value?.isTexture) value.dispose(); material.dispose(); } } });
}
assert.equal(UNIT_MODELS['rustroad-scout'].yaw, 0, 'Scout source faces glTF +X');
for (const id of ['rustroad-carrier','rustroad-fighter','sanctum-stealth','sanctum-scout']) assert.equal(UNIT_MODELS[id].yaw, -Math.PI / 2);
console.log('PASS: actual 36 GLB scene graphs; finite volumetric bounds and vertices; connected materials; corrected sideways hull/wing axes and reviewed headings (CPU).');
