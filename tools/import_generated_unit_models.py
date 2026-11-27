#!/usr/bin/env python3
"""Download the approved generated unit models; no game logic or rendering settings are changed."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import struct
import tempfile
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
HOSTS = {"storage.to3d.app", "img.theapi.app"}
LIMIT = 64 * 1024 * 1024

def inspect_glb(data):
    if len(data) < 20:
        raise ValueError("Incomplete GLB")
    magic, version, total = struct.unpack_from("<4sII", data)
    if magic != b"glTF" or version != 2 or total != len(data):
        raise ValueError("Invalid GLB header")
    length, kind = struct.unpack_from("<II", data, 12)
    if kind != 0x4E4F534A or 20 + length > len(data):
        raise ValueError("Invalid GLB JSON chunk")
    gltf = json.loads(data[20:20 + length])
    for item in gltf.get("buffers", []) + gltf.get("images", []):
        uri = item.get("uri", "")
        if uri and not uri.startswith("data:"):
            raise ValueError("GLB refers to an external file")
    accessors = gltf.get("accessors", [])
    triangles = 0
    for mesh in gltf.get("meshes", []):
        for prim in mesh.get("primitives", []):
            count = accessors[prim["indices"]]["count"] if "indices" in prim else accessors[prim["attributes"]["POSITION"]]["count"]
            mode = prim.get("mode", 4)
            if mode == 4:
                triangles += count // 3
            elif mode in (5, 6):
                triangles += max(0, count - 2)
    return {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(),
            "triangles": triangles, "meshes": len(gltf.get("meshes", [])),
            "materials": len(gltf.get("materials", [])),
            "required_extensions": gltf.get("extensionsRequired", [])}

def download(url):
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "https" or parsed.hostname not in HOSTS or parsed.username or parsed.password:
        raise ValueError("Unexpected model URL")
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(request, timeout=120) as response:
        final = urllib.parse.urlsplit(response.geturl())
        if final.scheme != "https" or final.hostname not in HOSTS:
            raise ValueError("Unexpected download redirect")
        data = response.read(LIMIT + 1)
    if len(data) > LIMIT:
        raise ValueError("Model exceeds the 64 MiB limit")
    return data

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=ROOT / "tools/model_batches/helios-crow-20261128.json")
    parser.add_argument("--dest", type=Path, default=ROOT / "prototype/assets/models")
    parser.add_argument("--overwrite", action="store_true")
    args = parser.parse_args()
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    args.dest.mkdir(parents=True, exist_ok=True)
    report = []
    for unit in manifest["units"]:
        ident = unit["id"]
        if not re.fullmatch(r"(helios|crow)-(assault|stealth|carrier|fighter|scout|mech)", ident):
            raise ValueError("Unexpected unit ID: " + ident)
        if unit["generation_status"] != "completed":
            report.append({"id": ident, "status": "not_generated"})
            continue
        target = args.dest / (ident + ".glb")
        try:
            if target.exists() and not args.overwrite:
                stats = inspect_glb(target.read_bytes())
                report.append({"id": ident, "status": "already_present", **stats})
                print(ident + ": already present")
                continue
            errors = []
            data = None
            for url in [unit.get("model_url"), unit.get("fallback_model_url")]:
                if not url:
                    continue
                try:
                    candidate = download(url)
                    stats = inspect_glb(candidate)
                    data = candidate
                    break
                except (OSError, ValueError, KeyError, IndexError, urllib.error.URLError) as error:
                    errors.append(str(error))
            if data is None:
                raise ValueError("; ".join(errors) or "No model URL")
            temporary = None
            try:
                with tempfile.NamedTemporaryFile(dir=args.dest, suffix=".glb.tmp", delete=False) as output:
                    temporary = Path(output.name)
                    output.write(data)
                os.replace(temporary, target)
            finally:
                if temporary is not None and temporary.exists():
                    temporary.unlink()
            report.append({"id": ident, "status": "downloaded", **stats})
            print(ident + ": downloaded (" + str(stats["triangles"]) + " triangles)")
        except (OSError, ValueError, KeyError, IndexError) as error:
            report.append({"id": ident, "status": "failed", "error": str(error)})
            print(ident + ": FAILED: " + str(error))
    report_path = args.dest / "generation-import-report.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if any(item["status"] == "failed" for item in report):
        raise SystemExit(1)

if __name__ == "__main__":
    main()
