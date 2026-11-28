// Export CPU-deformed geometry for Blender review; these are not game screenshots.
import fs from 'node:fs';
import path from 'node:path';
import * as T from '../../prototype/vendor/three/three.module.js';
import {GLTFLoader} from '../../prototype/vendor/three/GLTFLoader.js';
import {createWorldTemplate} from '../../prototype/world3d.js';
import {prepareTechGeometry,rigTechInstance} from '../../prototype/tech3d.js';
const dest=process.argv[2];if(!dest)throw Error('Supply an output directory');fs.mkdirSync(dest,{recursive:true});
globalThis.self=globalThis;globalThis.createImageBitmap=async()=>({width:1,height:1,close(){}});globalThis.ProgressEvent=class{constructor(t,v){Object.assign(this,v);}};
function save(id,root,source=null){
 root.updateMatrixWorld(true);const parts=[];
 root.traverse(mesh=>{if(!mesh.isMesh||!mesh.visible)return;let p=mesh;while(p){if(!p.visible)return;p=p.parent;}
  const g=mesh.geometry,a=g.attributes.position,positions=[],uv=[],v=new T.Vector3();
  for(let i=0;i<a.count;i++){mesh.getVertexPosition(i,v).applyMatrix4(mesh.matrixWorld);positions.push(...v.toArray().map(x=>Math.round(x*1e6)/1e6));if(g.attributes.uv)uv.push(g.attributes.uv.getX(i),g.attributes.uv.getY(i));}
  const material=[].concat(mesh.material)[0];parts.push({positions,indices:g.index?Array.from(g.index.array):Array.from({length:a.count},(_,i)=>i),uv,color:material.color?.toArray()||[.5,.5,.5],opacity:material.opacity,baseTexture:!!mesh.isSkinnedMesh});
 });fs.writeFileSync(path.join(dest,id+'.json'),JSON.stringify({id,source,parts}));
}
for(const kind of ['colony','node','station','rock','wreck','derelict','convoy','cache','mine','turret','barrier','beacon','cloud','storm','vent'])save(kind,createWorldTemplate({kind,color:kind==='vent'?0xff9146:0x64cfff}));
for(const faction of ['helios','crow','valkyr','rustroad','sanctum','fogborn']){
 const source=path.resolve(`prototype/assets/models/${faction}-mech.glb`),data=fs.readFileSync(source),gltf=await new GLTFLoader().parseAsync(data.buffer.slice(data.byteOffset,data.byteOffset+data.length),'');prepareTechGeometry(gltf.scene);
 const box=new T.Box3().setFromObject(gltf.scene),size=box.getSize(new T.Vector3()),center=box.getCenter(new T.Vector3());
 for(const pose of ['ready','slash','fire','thrust']){
  const root=new T.Group(),model=gltf.scene.clone(true);model.position.sub(center);root.add(model);root.scale.setScalar(1/Math.max(size.x,size.y,size.z));root.rotation.y=Math.PI/2;
  const rig=rigTechInstance(root);for(let i=0;i<30;i++)rig.update(pose,1+i/60);save(faction+'-'+pose,root,source);rig.dispose();
 }
}console.log('Exported 15 solid environment recipes and 24 deformed Tech poses for offline review.');
