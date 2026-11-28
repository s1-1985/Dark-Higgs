"""Blender 4.3: blender -b -t 6 --python tools/prepare_unit_models.py -- RAW_DIR OUTPUT_DIR.
Keep downloaded originals separately. No generation or network access is performed.
"""
import bpy
import sys
import json
import hashlib
import struct
from pathlib import Path
source, target = map(Path, sys.argv[sys.argv.index('--') + 1:])
target.mkdir(parents=True, exist_ok=True)
report = []
for path in sorted(source.glob('*.glb')):
    raw = path.read_bytes()
    json_length = struct.unpack_from('<I', raw, 12)[0]
    document = json.loads(raw[20:20+json_length])
    if any(m.get('alphaMode', 'OPAQUE') != 'OPAQUE' for m in document.get('materials', [])):
        raise ValueError('Transparent source requires a lossless texture pipeline')
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(path))
    meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    before = sum(sum(len(p.vertices)-2 for p in o.data.polygons) for o in meshes)
    small = path.stem.endswith(('-fighter', '-scout'))
    budget = 5000 if small else 12000
    for obj in meshes:
        bpy.context.view_layer.objects.active = obj
        if before > budget:
            modifier = obj.modifiers.new('Game budget', 'DECIMATE')
            modifier.ratio = budget / before
            bpy.ops.object.modifier_apply(modifier=modifier.name)
    for im in bpy.data.images:
        if small and max(im.size) > 512:
            factor = 512 / max(im.size)
            im.scale(round(im.size[0]*factor), round(im.size[1]*factor))
    # These generated assets use OPAQUE materials. Keep normals/UVs; no mesh re-authoring.
    output = target / path.name
    bpy.ops.export_scene.gltf(filepath=str(output), export_format='GLB', export_image_format='JPEG', export_jpeg_quality=90, export_animations=False)
    after = sum(sum(len(p.vertices)-2 for p in o.data.polygons) for o in meshes)
    report.append({'id': path.stem, 'source_sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
                   'source_bytes': path.stat().st_size, 'source_triangles': before,
                   'bytes': output.stat().st_size, 'triangles': after,
                   'texture_size': 512 if small else 1024,
                   'sha256': hashlib.sha256(output.read_bytes()).hexdigest()})
(target / 'model-preparation-report.json').write_text(json.dumps(report, indent=2) + '\n')
