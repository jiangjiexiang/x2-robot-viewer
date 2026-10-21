#!/usr/bin/env python3
"""Build a visual x2 + R5 dual-arm model, preserving the supplied originals.

Requires local numpy/scipy only for this authoring step, not on the robot.
The mount estimates are explicitly marked unverified in configuration and UI.
"""
import copy
import hashlib
import json
from pathlib import Path
import struct
import xml.etree.ElementTree as ET

import numpy as np
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "public/robots/x2"
STL = np.dtype([("normal", "<f4", (3,)), ("vertices", "<f4", (3, 3)), ("attribute", "<u2")])


def write_body_mesh():
    path = OUTPUT / "meshes/Link-5.STL"
    data = path.read_bytes()
    count = struct.unpack_from("<I", data, 80)[0]
    assert len(data) == 84 + count * 50
    faces = np.frombuffer(data, dtype=STL, offset=84)
    triangles = faces["vertices"]
    assert np.isfinite(triangles).all()

    # Work on complete connected shells, never clip triangles through the body.
    vertices, inverse = np.unique(np.round(triangles.reshape(-1, 3), 6), axis=0, return_inverse=True)
    indices = inverse.reshape(-1, 3)
    edges = np.concatenate([indices[:, [0, 1]], indices[:, [1, 2]], indices[:, [2, 0]]])
    graph = coo_matrix((np.ones(len(edges), dtype=np.uint8), (edges[:, 0], edges[:, 1])),
                       shape=(len(vertices), len(vertices))).tocsr()
    total, labels = connected_components(graph, directed=False)
    face_labels = labels[indices[:, 0]]
    assert np.all(labels[indices] == face_labels[:, None])
    removed = []
    retained = []
    shells = []
    for component in range(total):
        points = vertices[labels == component]
        lower, upper = points.min(0), points.max(0)
        # Both complete arm assemblies lie outside the central torso, above
        # the shared mounting bar and below the head. Preserve the spanning
        # mounting bar and the electronics inboard of abs(x)=0.23 m.
        arm = (lower[0] > 0.23 or upper[0] < -0.23) and lower[1] > 0.07 and upper[1] < 0.42
        (removed if arm else retained).append(component)
        if arm:
            shells.append({"component": component, "triangles": int((face_labels == component).sum()),
                           "bounds": [lower.tolist(), upper.tolist()]})
    assert len(removed) == 74, "Unexpected source geometry: re-inspect shell selection before replacing arms"
    arm_mask = np.isin(face_labels, removed)
    body = faces[~arm_mask]
    assert len(body) + int(arm_mask.sum()) == count
    assert np.any(face_labels[~arm_mask] == 0) and np.any(face_labels[~arm_mask] == 2)
    output = OUTPUT / "meshes/Link-5-body.STL"
    with output.open("wb") as stream:
        stream.write(b"x2 torso; original arm shells replaced by articulated R5 links".ljust(80, b" "))
        stream.write(struct.pack("<I", len(body)))
        stream.write(body.tobytes())
    return {"source_sha256": hashlib.sha256(data).hexdigest(), "original_triangles": count,
            "body_triangles": len(body), "removed_arm_triangles": int(arm_mask.sum()),
            "removed_shells": shells, "retained_components": retained}


def build():
    audit = write_body_mesh()
    mounts = json.loads((ROOT / "config/x2-arm-mounts.json").read_text())
    robot = ET.parse(OUTPUT / "x2.urdf").getroot()
    robot.set("name", "x2_dual_arm_visual")
    for mesh in robot.findall(".//mesh"):
        filename = Path(mesh.get("filename")).name
        if filename == "Link-5.STL":
            filename = "Link-5-body.STL"
        mesh.set("filename", "./meshes/" + filename)

    arm_robot = ET.parse(ROOT / "config/R5a-source.urdf").getroot()
    arm_meshes = OUTPUT / "meshes/r5"
    arm_meshes.mkdir(exist_ok=True)
    assert all((arm_meshes / name).is_file() for name in
               ["base_link.STL"] + ["link%s.STL" % i for i in range(1, 9)])
    for side in ("left", "right"):
        prefix = side + "_"
        mount = ET.SubElement(robot, "joint", name=prefix + "arm_mount", type="fixed")
        ET.SubElement(mount, "origin", xyz=" ".join(map(str, mounts[side]["xyz"])),
                      rpy=" ".join(map(str, mounts[side]["rpy"])))
        ET.SubElement(mount, "parent", link=mounts["parent_link"])
        ET.SubElement(mount, "child", link=prefix + "base_link")
        for original in arm_robot:
            if original.tag not in ("link", "joint") or original.get("name") in ("target_frame", "target_frame_joint"):
                continue
            item = copy.deepcopy(original)
            item.set("name", prefix + original.get("name"))
            for reference in item.findall("parent") + item.findall("child"):
                reference.set("link", prefix + reference.get("link"))
            for mimic in item.findall("mimic"):
                mimic.set("joint", prefix + mimic.get("joint"))
            for mesh in item.findall(".//mesh"):
                mesh.set("filename", "./meshes/r5/" + Path(mesh.get("filename")).name)
            for material in item.findall(".//material"):
                material.set("name", prefix + original.get("name") + "_material")
            robot.append(item)
    names = [joint.get("name") for joint in robot.findall("joint")]
    assert len(names) == len(set(names))
    for side in ("left", "right"):
        for i in range(1, 7):
            joint = robot.find("joint[@name='%s_joint%s']" % (side, i))
            assert joint is not None and joint.get("type") == "revolute"
    links = {link.get("name") for link in robot.findall("link")}
    for joint in robot.findall("joint"):
        assert joint.find("parent").get("link") in links
        assert joint.find("child").get("link") in links
    for mesh in robot.findall(".//mesh"):
        assert (OUTPUT / mesh.get("filename")).is_file(), mesh.get("filename")
    ET.indent(robot, space="  ")
    ET.ElementTree(robot).write(OUTPUT / "x2-live.urdf", encoding="utf-8", xml_declaration=True)
    audit["mounts"] = mounts
    audit["arm_kinematics_source"] = "config/R5a-source.urdf (copied read-only from robot trajectory_smooth/model/r5a/R5a.urdf)"
    audit["status"] = "visual_binding_only_mounts_not_calibrated"
    (ROOT / "config/x2-model-audit.json").write_text(json.dumps(audit, ensure_ascii=False, indent=2))
    print("x2-live.urdf: 12 revolute arm joints; %s static arm triangles replaced; %s torso triangles retained" %
          (audit["removed_arm_triangles"], audit["body_triangles"]))


if __name__ == "__main__":
    build()
