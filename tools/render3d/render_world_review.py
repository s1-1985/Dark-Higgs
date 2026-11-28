"""blender -b -t 4 --python tools/render3d/render_world_review.py -- JSON_DIR PNG_DIR"""
import json,sys,math
from pathlib import Path
import bpy
from mathutils import Vector
source,target=map(Path,sys.argv[sys.argv.index('--')+1:]);target.mkdir(parents=True,exist_ok=True)
for path in sorted(source.glob('*.json')):
    item=json.loads(path.read_text());bpy.ops.wm.read_factory_settings(use_empty=True);original=None
    if item['source']:
        bpy.ops.import_scene.gltf(filepath=item['source'])
        for obj in list(bpy.context.scene.objects):
            if obj.type=='MESH' and obj.data.materials and original is None:original=obj.data.materials[0]
            bpy.data.objects.remove(obj,do_unlink=True)
    for part in item['parts']:
        v=part['positions'];verts=[(v[i],-v[i+2],v[i+1]) for i in range(0,len(v),3)];indices=part['indices'];faces=[indices[i:i+3] for i in range(0,len(indices),3)]
        mesh=bpy.data.meshes.new(item['id']);mesh.from_pydata(verts,[],faces);mesh.update();obj=bpy.data.objects.new(item['id'],mesh);bpy.context.collection.objects.link(obj)
        if part['uv']:
            uv=mesh.uv_layers.new(name='UVMap');values=part['uv']
            for loop in mesh.loops:uv.data[loop.index].uv=values[loop.vertex_index*2:loop.vertex_index*2+2]
        if part.get('baseTexture',False) and original:mat=original
        else:
            mat=bpy.data.materials.new('review');mat.use_nodes=True;n=mat.node_tree.nodes.get('Principled BSDF');n.inputs['Base Color'].default_value=(*part['color'],1);n.inputs['Metallic'].default_value=.45;n.inputs['Roughness'].default_value=.5
            if part['opacity']<1:
                n.inputs['Alpha'].default_value=part['opacity'];mat.surface_render_method='DITHERED'
        mesh.materials.append(mat)
        for poly in mesh.polygons:poly.use_smooth=True
    scene=bpy.context.scene;scene.render.engine='CYCLES';scene.cycles.samples=16;scene.cycles.use_denoising=False
    scene.render.resolution_x=scene.render.resolution_y=320;scene.render.resolution_percentage=100;scene.render.image_settings.file_format='PNG';scene.view_settings.view_transform='Standard'
    scene.world=bpy.data.worlds.new('background');scene.world.use_nodes=True;scene.world.node_tree.nodes['Background'].inputs[0].default_value=(.08,.11,.16,1);scene.world.node_tree.nodes['Background'].inputs[1].default_value=.7
    for location,energy in [((-2,-3,5),220),((3,2,3),140)]:
        light=bpy.data.lights.new('review','AREA');light.energy=energy;light.size=4;obj=bpy.data.objects.new('review',light);scene.collection.objects.link(obj);obj.location=location;obj.rotation_euler=(-obj.location).to_track_quat('-Z','Y').to_euler()
    data=bpy.data.cameras.new('review');camera=bpy.data.objects.new('review',data);scene.collection.objects.link(camera);data.type='ORTHO';data.ortho_scale=1.6
    camera.location=(0,-3*math.sin(math.radians(35)),3*math.cos(math.radians(35)));camera.rotation_euler=(math.radians(35),0,0);scene.camera=camera
    scene.render.filepath=str(target/(item['id']+'.png'));bpy.ops.render.render(write_still=True);print('REVIEW '+item['id'],flush=True)
