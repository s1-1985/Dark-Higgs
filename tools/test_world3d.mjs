import assert from 'node:assert/strict';
import * as T from '../prototype/vendor/three/three.module.js';
import {worldForSprite,createWorldTemplate} from '../prototype/world3d.js';
import {createVolumeFog} from '../prototype/fog3d.js';
const files=['structure_colony','structure_colony_lbase','structure_colony_l3','node_higgs_l0','structure_derelict','terrain_rock','terrain_wreck','field_convoy','field_cache','field_trap','field_mine','drone_turret','drone_barrier','drone_buoy','drone_decoy','lure_ship','lure_sos','bcn_heat','fx_field_cloud','fx_field_storm','fx_field_vent','f2_fogborn_missile','f2_valkyr_boarder'];
for(const file of files){
 const spec=worldForSprite({src:`https://game/assets/${file}.png?v=1`});assert(spec,file);
 const model=createWorldTemplate(spec),box=new T.Box3().setFromObject(model),size=box.getSize(new T.Vector3());
 assert([size.x,size.y,size.z].every(n=>Number.isFinite(n)&&n>.001),file+' must have volume');
 assert(model.children.length<=3,'geometry must be batched, not dozens of draw calls');
 model.traverse(o=>{if(o.isMesh){assert(o.geometry.attributes.position.array.every(Number.isFinite));o.geometry.dispose();o.material.dispose();}});
}
for(const src of ['assets/fx_saber_slash.png','assets/f2_unknown_missile.png','assets/terrain_rock.png.bak','assets/app_icon.png'])assert.equal(worldForSprite({src}),null);
const fog=createVolumeFog(),source={width:200,height:100},mask={width:200,height:100};fog.update(source,mask,12,.5,.03);
const material=fog.scene.children[0].material;
assert.equal(material.uniforms.density.value.image,source);assert.equal(material.uniforms.darkness.value.image,mask);
assert(material.fragmentShader.includes('i<12'),'bounded raymarch');
assert(material.fragmentShader.includes('visible=1.-texture2D(darkness,uv0).a'),'final output pixel has its own visibility gate');
assert(material.fragmentShader.includes('alpha*=visible'),'parallax density cannot escape that gate');
assert.equal(material.depthWrite,false);fog.dispose();
console.log('PASS: 23 world sprite mappings, real solid bounds, batched geometry, exclusions and bounded fog with final-pixel darkness mask.');
