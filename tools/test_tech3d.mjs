import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as T from '../prototype/vendor/three/three.module.js';
import {GLTFLoader} from '../prototype/vendor/three/GLTFLoader.js';
import {prepareTechGeometry,rigTechInstance} from '../prototype/tech3d.js';
globalThis.self=globalThis;globalThis.createImageBitmap=async()=>({width:1,height:1,close(){}});globalThis.ProgressEvent=class{constructor(t,v){Object.assign(this,v);}};
for(const faction of ['helios','crow','valkyr','rustroad','sanctum','fogborn']){
 const data=fs.readFileSync(`prototype/assets/models/${faction}-mech.glb`),gltf=await new GLTFLoader().parseAsync(data.buffer.slice(data.byteOffset,data.byteOffset+data.length),'');
 prepareTechGeometry(gltf.scene);const group=new T.Group();group.add(gltf.scene);const rig=rigTechInstance(group);assert(rig.rigs.length>0);
 const mesh=[];group.traverse(o=>{if(o.isSkinnedMesh)mesh.push(o);});assert(mesh.length);
 const skin=mesh[0],rest=[],sample=[];
 for(let i=0;i<skin.geometry.attributes.position.count;i+=113){sample.push(i);rest.push(skin.getVertexPosition(i,new T.Vector3()).clone());}
 for(let i=0;i<sample.length;i++){const original=new T.Vector3().fromBufferAttribute(skin.geometry.attributes.position,sample[i]);assert(rest[i].distanceTo(original)<1e-5,'bind pose preserves source vertices');}
 for(const pose of ['ready','slash','fire','thrust']){
  for(let i=0;i<30;i++)rig.update(pose,1+['ready','slash','fire','thrust'].indexOf(pose)+i/60);
  const moved=sample.some((index,i)=>skin.getVertexPosition(index,new T.Vector3()).distanceTo(rest[i])>.0001);
  assert(moved,`${faction}: ${pose} changes joint-weighted vertices`);
  assert(skin.geometry.attributes.skinWeight.array.every(Number.isFinite));
 }
 assert(rig.rigs.some(r=>r.jet.visible),'thrust has a 3D exhaust');
 rig.dispose();group.traverse(o=>{if(o.isMesh)o.geometry.dispose();});
}
console.log('PASS: six actual Tech GLBs; unchanged bind pose, finite weights, joint deformation in ready/slash/fire/thrust and 3D exhaust.');
