#!/usr/bin/env python3
"""Package the built viewer and ROS reader. Does not connect to a robot."""
from pathlib import Path
import tarfile

root = Path(__file__).resolve().parents[1]
if not (root / "dist/index.html").is_file():
    raise SystemExit("Build the frontend first.")
output = root.parent / "x2关节查看器-部署包.tar.gz"
with tarfile.open(output, "w:gz") as archive:
    for name in ("dist", "server", "config", "LICENSE", "本地开发说明.md", "启动网页.sh"):
        source = root / name
        archive.add(source, arcname="x2-joint-viewer/" + name,
                    filter=lambda info: None if "__pycache__" in info.name or info.name.endswith(".pyc") else info)
print(output)
