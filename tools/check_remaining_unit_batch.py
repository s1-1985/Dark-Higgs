#!/usr/bin/env python3
"""Offline preflight for the remaining 24 models. Does not submit generation jobs."""
import argparse
import hashlib
import json
from pathlib import Path
import re

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
FACTIONS = ("valkyr", "rustroad", "sanctum", "fogborn")
ROLES = ("assault", "stealth", "carrier", "fighter", "scout", "mech")


def check(manifest, root=ROOT):
    expected = {f"{f}-{r}" for f in FACTIONS for r in ROLES}
    units = manifest["units"]
    if len(units) != len(expected) or {u["id"] for u in units} != expected:
        raise ValueError("Expected exactly 24 distinct units: four factions by six roles")
    commit = manifest["source_commit"]
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise ValueError("Sources must be pinned to a commit SHA")
    for unit in units:
        faction, role = unit["id"].split("-")
        source = f"prototype/assets/f2_{faction}_{role}.png"
        if (unit["faction"], unit["role"], unit["source_path"], unit["source_commit"]) != (faction, role, source, commit):
            raise ValueError(f"Source identity mismatch: {unit['id']}")
        if unit["source_url"] != f"https://raw.githubusercontent.com/s1-1985/Dark-Higgs/{commit}/{source}":
            raise ValueError(f"Source URL mismatch: {unit['id']}")
        if unit["target_path"] != f"prototype/assets/models/{unit['id']}.glb":
            raise ValueError(f"Target identity mismatch: {unit['id']}")
        data = (root / source).read_bytes()
        blob = hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()
        if blob != unit["source_blob_sha"] or hashlib.sha256(data).hexdigest() != unit["source_sha256"]:
            raise ValueError(f"Source content changed: {unit['id']}")
        with Image.open(root / source) as image:
            image.load()
            if image.format != "PNG" or "A" not in image.getbands():
                raise ValueError(f"Expected transparent PNG: {unit['id']}")
            alpha = image.getchannel("A")
            if not alpha.getbbox() or alpha.getextrema()[0] == 255:
                raise ValueError(f"Missing silhouette or transparency: {unit['id']}")
            if list(image.size) != unit["source_size"] or list(alpha.getbbox()) != unit["source_alpha_bounds"]:
                raise ValueError(f"Source dimensions changed: {unit['id']}")
        if unit["triangle_budget"] != (5000 if role in ("fighter", "scout") else 12000):
            raise ValueError(f"Unexpected triangle budget: {unit['id']}")
        if unit["generation_status"] == "completed" and not (unit.get("job_id") and unit.get("model_url")):
            raise ValueError(f"Completed unit lacks generation result: {unit['id']}")
    return units


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=ROOT / "tools/model_batches/remaining-factions-20261128.json")
    parser.add_argument("--require-generated", action="store_true")
    args = parser.parse_args()
    units = check(json.loads(args.manifest.read_text(encoding="utf-8")))
    pending = [unit["id"] for unit in units if unit["generation_status"] != "completed"]
    print(f"PASS: {len(units)} pinned PNG sources, Git blob/SHA-256, alpha bounds, identities and triangle budgets")
    print(f"Generated: {len(units) - len(pending)}/{len(units)}; pending: {len(pending)}")
    if args.require_generated and pending:
        raise SystemExit("Generation is incomplete; do not enable these models in the renderer")


if __name__ == "__main__":
    main()
