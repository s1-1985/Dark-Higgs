"""CPU review renders, not game screenshots.
blender -b -t 4 --python tools/render3d/review_unit_models.py -- MODEL_DIR OUTPUT_DIR [YAW_JSON]
Yaw JSON maps a model ID to radians, matching unit-models.js. Defaults to +pi/2.
"""
import json
import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector

args = sys.argv[sys.argv.index('--') + 1:]
source, output = map(Path, args[:2])
yaws = json.loads(Path(args[2]).read_text()) if len(args) > 2 else {}
output.mkdir(parents=True, exist_ok=True)

for path in sorted(source.glob('*.glb')):
    if (output / f'{path.stem}-35.png').exists():
        continue
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(path))
    imported = list(bpy.context.scene.objects)
    meshes = [o for o in imported if o.type == 'MESH']
    corners = [o.matrix_world @ Vector(corner) for o in meshes for corner in o.bound_box]
    low = Vector(tuple(min(c[i] for c in corners) for i in range(3)))
    high = Vector(tuple(max(c[i] for c in corners) for i in range(3)))
    size, center = high - low, (high + low) / 2
    length = max(size) if path.stem.endswith('-mech') else max(size.x, size.y)
    normalizer = bpy.data.objects.new('Game normalization', None)
    bpy.context.collection.objects.link(normalizer)
    for obj in imported:
        if obj.parent is None:
            matrix = obj.matrix_world.copy()
            obj.parent = normalizer
            obj.matrix_world = matrix
            obj.location -= center
    normalizer.scale = (1 / length,) * 3
    correction = yaws.get(path.stem, math.pi / 2)
    if isinstance(correction, dict):
        # glTF +Z is Blender -Y. Roll is applied in model space before yaw.
        from mathutils import Matrix
        rotation = Matrix.Rotation(correction.get('yaw', math.pi / 2), 4, 'Z') @ Matrix.Rotation(-correction.get('roll', 0), 4, 'Y')
        normalizer.rotation_euler = rotation.to_euler()
        # Match runtime normalization: measure the roll correction before yaw.
        rolled = [Matrix.Rotation(-correction.get('roll', 0), 4, 'Y') @ (c - center) for c in corners]
        extent = [max(c[i] for c in rolled) - min(c[i] for c in rolled) for i in range(3)]
        length = max(extent) if path.stem.endswith('-mech') else max(extent[0], extent[1])
        normalizer.scale = (1 / length,) * 3
    else:
        normalizer.rotation_euler.z = correction

    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.samples = 24
    scene.cycles.use_denoising = False
    scene.render.resolution_x = scene.render.resolution_y = 320
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'PNG'
    scene.world = bpy.data.worlds.new('Review background')
    scene.world.use_nodes = True
    scene.world.node_tree.nodes['Background'].inputs[0].default_value = (0.12, 0.16, 0.21, 1)
    scene.world.node_tree.nodes['Background'].inputs[1].default_value = 0.7
    scene.view_settings.view_transform = 'Standard'
    for name, location, energy, color in [
        ('key', (-2, -3, 5), 180, (1, .94, .88)),
        ('rim', (3, 2, 3), 120, (.55, .75, 1)),
    ]:
        light = bpy.data.lights.new(name, 'AREA')
        light.energy, light.color, light.size = energy, color, 4
        obj = bpy.data.objects.new(name, light)
        scene.collection.objects.link(obj)
        obj.location = location
        obj.rotation_euler = (-obj.location).to_track_quat('-Z', 'Y').to_euler()
    camera_data = bpy.data.cameras.new('review')
    camera = bpy.data.objects.new('review', camera_data)
    scene.collection.objects.link(camera)
    camera_data.type, camera_data.ortho_scale = 'ORTHO', 1.25
    scene.camera = camera
    for tilt in (0, 35):
        radians = math.radians(tilt)
        camera.location = (0, -3 * math.sin(radians), 3 * math.cos(radians))
        camera.rotation_euler = (radians, 0, 0)
        scene.render.filepath = str(output / f'{path.stem}-{tilt}.png')
        bpy.ops.render.render(write_still=True)
    print(f'REVIEW {path.stem}: dimensions={list(size)}, yaw={normalizer.rotation_euler.z}', flush=True)
