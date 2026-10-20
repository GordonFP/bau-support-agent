#!/usr/bin/env python3
"""Host-only Docker-save -> verified single-platform OCI layout. No registry IO."""
import gzip
import hashlib
import json
import re
import shutil
import sys
import tarfile
from pathlib import Path, PurePosixPath

MANIFEST = "application/vnd.oci.image.manifest.v1+json"
CONFIG = "application/vnd.oci.image.config.v1+json"
LAYER = "application/vnd.oci.image.layer.v1.tar"
INDEX = "application/vnd.oci.image.index.v1+json"


def sha_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        while chunk := source.read(65536):
            digest.update(chunk)
    return "sha256:" + digest.hexdigest()


def encoded(value):
    return json.dumps(value, separators=(",", ":"), ensure_ascii=True).encode()


def descriptor(path, media):
    return {"mediaType": media, "digest": sha_file(path), "size": path.stat().st_size}


def blob(root, data):
    name = hashlib.sha256(data).hexdigest()
    path = root / "blobs" / "sha256" / name
    path.write_bytes(data)
    return path


def layer_diff(path, compressed):
    digest = hashlib.sha256()
    with (gzip.open(path, "rb") if compressed else open(path, "rb")) as stream:
        while chunk := stream.read(65536):
            digest.update(chunk)
    return "sha256:" + digest.hexdigest()


def verify(root):
    root = Path(root)
    assert json.loads((root / "oci-layout").read_bytes()) == {"imageLayoutVersion": "1.0.0"}
    index = json.loads((root / "index.json").read_bytes())
    assert index["schemaVersion"] == 2 and index["mediaType"] == INDEX and len(index["manifests"]) == 1

    def check(item, media):
        assert item["mediaType"] in media and re.fullmatch(r"sha256:[a-f0-9]{64}", item["digest"])
        path = root / "blobs" / "sha256" / item["digest"][7:]
        assert path.is_file() and not path.is_symlink()
        assert path.stat().st_size == item["size"] and sha_file(path) == item["digest"]
        return path

    selected = index["manifests"][0]
    assert selected["platform"] == {"os": "linux", "architecture": "arm64"}
    manifest_path = check(selected, [MANIFEST])
    manifest = json.loads(manifest_path.read_bytes())
    assert manifest["schemaVersion"] == 2 and manifest["mediaType"] == MANIFEST
    config_path = check(manifest["config"], [CONFIG])
    config = json.loads(config_path.read_bytes())
    assert config["os"] == "linux" and config["architecture"] == "arm64" and config["rootfs"]["type"] == "layers"
    assert 0 < len(manifest["layers"]) <= 256
    diffs = [layer_diff(check(item, [LAYER, LAYER + "+gzip"]), item["mediaType"].endswith("+gzip")) for item in manifest["layers"]]
    assert diffs == config["rootfs"]["diff_ids"]
    return {"schemaVersion": 1, "platform": "linux/arm64", "imageManifestDigest": selected["digest"],
            "indexDigest": sha_file(root / "index.json"), "dockerConfigId": manifest["config"]["digest"],
            "orderedDiffIds": diffs, "blobCount": len(manifest["layers"]) + 2,
            "distribution": "local_layout_only_not_published_or_remote_pull_verified"}


def convert(archive, output, expected):
    assert re.fullmatch(r"sha256:[a-f0-9]{64}", expected)
    root = Path(output)
    root.mkdir(mode=0o700)  # Never overwrite an unknown prior layout.
    (root / "blobs" / "sha256").mkdir(parents=True)
    with tarfile.open(archive, "r:*") as saved:
        members = saved.getmembers()
        assert len(members) <= 10000 and len({item.name for item in members}) == len(members)
        for item in members:
            parts = PurePosixPath(item.name).parts
            assert not item.name.startswith("/") and ".." not in parts and "\\" not in item.name
            assert item.isfile() or item.isdir()

        def read_json(name):
            item = saved.getmember(name)
            assert item.isfile() and item.size <= 1048576
            return saved.extractfile(item).read()

        images = json.loads(read_json("manifest.json"))
        assert isinstance(images, list) and len(images) == 1
        image = images[0]
        config_bytes = read_json(image["Config"])
        assert "sha256:" + hashlib.sha256(config_bytes).hexdigest() == expected
        config_path = blob(root, config_bytes)
        config = json.loads(config_bytes)
        assert config["os"] == "linux" and config["architecture"] == "arm64"
        assert len(image["Layers"]) == len(config["rootfs"]["diff_ids"]) and 0 < len(image["Layers"]) <= 256
        layers = []
        for number, member in enumerate(image["Layers"]):
            entry = saved.getmember(member)
            assert entry.isfile() and entry.size <= 1073741824
            pending = root / "blobs" / "sha256" / "pending"
            with saved.extractfile(entry) as source, pending.open("wb") as target:
                shutil.copyfileobj(source, target, length=65536)
            with pending.open("rb") as header:
                compressed = header.read(2) == b"\x1f\x8b"
            assert layer_diff(pending, compressed) == config["rootfs"]["diff_ids"][number]
            layer = descriptor(pending, LAYER + ("+gzip" if compressed else ""))
            pending.replace(root / "blobs" / "sha256" / layer["digest"][7:])
            layers.append(layer)
        manifest = {"schemaVersion": 2, "mediaType": MANIFEST, "config": descriptor(config_path, CONFIG), "layers": layers}
        selected = descriptor(blob(root, encoded(manifest)), MANIFEST)
        selected["platform"] = {"os": "linux", "architecture": "arm64"}
        (root / "oci-layout").write_bytes(encoded({"imageLayoutVersion": "1.0.0"}))
        (root / "index.json").write_bytes(encoded({"schemaVersion": 2, "mediaType": INDEX, "manifests": [selected]}))
    receipt = verify(root)
    receipt["dockerSaveArchiveDigest"] = sha_file(archive)
    return receipt


if __name__ == "__main__":
    try:
        if len(sys.argv) == 3 and sys.argv[1] == "verify":
            result = verify(sys.argv[2])
        elif len(sys.argv) == 5:
            result = convert(*sys.argv[1:])
        else:
            raise ValueError("arguments")
        print(json.dumps(result, indent=2))
    except Exception:
        print("image_artifact_unverified", file=sys.stderr)
        sys.exit(1)
