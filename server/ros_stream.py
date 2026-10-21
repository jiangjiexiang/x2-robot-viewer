#!/usr/bin/env python3
"""Read-only ROS1 -> SSE adapter. No publishers, services or hardware control.

Local development: python3 server/ros_stream.py --demo --port 8765
On robot (after sourcing ROS): python3 server/ros_stream.py --host 0.0.0.0
"""
import argparse
import functools
import json
import math
import mimetypes
from pathlib import Path
import signal
import shlex
import subprocess
import threading
import time
import uuid
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
STOP = threading.Event()


def load_config(path):
    config = json.loads(Path(path).read_text(encoding="utf-8"))
    if config["input_unit"] not in ("rad", "deg"):
        raise ValueError("input_unit must be rad or deg")
    names = config["joint_names"]
    if len(names) != 6 or len(set(names)) != 6:
        raise ValueError("Provide six distinct URDF joint_names")
    for field in ("signs", "offsets_rad"):
        values = config[field]
        if len(values) != 6 or not all(isinstance(x, (float, int)) and math.isfinite(x) for x in values):
            raise ValueError(field + " must contain six finite numbers")
    if not 1 <= config["stream_hz"] <= 60:
        raise ValueError("stream_hz must be between 1 and 60")
    if not 0 < config["stale_after_seconds"] <= 60:
        raise ValueError("stale_after_seconds must be between 0 and 60")
    if set(config["topics"]) != {"left", "right"}:
        raise ValueError("Configure left and right topics")
    for arm, bindings in config.get("model_joint_names", {}).items():
        if arm not in config["topics"] or len(bindings) != 6 or len(set(bindings)) != 6:
            raise ValueError("model_joint_names must map each arm to six distinct URDF joints")
    return config


class JointState:
    def __init__(self, config, demo=False):
        self.config = config
        self.demo = demo
        self.lock = threading.Lock()
        self.arms = {}
        self.error = None

    def accept(self, arm, positions, velocities=(), currents=()):
        positions = list(positions)
        if len(positions) < 6 or not all(isinstance(v, (int, float)) and math.isfinite(v) for v in positions):
            return False
        def optional(values):
            return [v if isinstance(v, (int, float)) and math.isfinite(v) else None for v in values]
        with self.lock:
            previous = self.arms.get(arm, {})
            self.arms[arm] = {
                "topic": self.config["topics"][arm],
                "positions": positions,
                "velocities": optional(velocities),
                "currents": optional(currents),
                "received_at": time.time(),
                "sequence": previous.get("sequence", 0) + 1,
            }
        return True

    def snapshot(self):
        with self.lock:
            return {
                "mode": "demo" if self.demo else "ros",
                "server_time": time.time(),
                "arms": dict(self.arms),
                "error": self.error,
            }


def demo_loop(state):
    start = time.monotonic()
    while not STOP.is_set():
        t = time.monotonic() - start
        for index, arm in enumerate(("left", "right")):
            p = t * 0.45 + index * 0.8
            q = [0.6 * math.sin(p), 1.15 + 0.45 * math.sin(p + 0.6),
                 1.0 + 0.5 * math.sin(p + 1.2), 0.55 * math.sin(p + 2),
                 0.65 * math.sin(p + 2.5), 0.9 * math.sin(p + 3), 0.02]
            if state.config["input_unit"] == "deg":
                q = [math.degrees(v) for v in q[:6]] + q[6:]
            state.accept(arm, q)
        STOP.wait(0.02)


def subscribe_ros(state):
    # Imported only in ROS mode: local preview needs no ROS installation.
    import rospy
    from roslib.message import get_message_class
    message = get_message_class(state.config["message_type"])
    if message is None:
        raise RuntimeError("Message type unavailable. Source the robot's workspace devel/setup.bash first.")
    rospy.init_node("urdf_viewer_joint_reader", anonymous=True, disable_signals=True)
    subscriptions = []
    for arm, topic in state.config["topics"].items():
        def callback(msg, arm=arm):
            state.accept(arm, msg.joint_pos, msg.joint_vel, msg.joint_cur)
        subscriptions.append(rospy.Subscriber(topic, message, callback, queue_size=1, tcp_nodelay=True))
    return rospy, subscriptions


def subscribe_docker(state, container, setup):
    reader_id = uuid.uuid4().hex
    shell = "source /opt/ros/noetic/setup.bash && source %s >/dev/null && exec python3 -u -" % shlex.quote(setup)
    command = ["docker", "exec", "-i",
               "-e", "VIEWER_READER_ID=" + reader_id,
               "-e", "VIEWER_TOPICS=" + json.dumps(state.config["topics"]),
               "-e", "VIEWER_MESSAGE_TYPE=" + state.config["message_type"],
               container, "bash", "-lc", shell]
    reader = Path(__file__).with_name("ros_docker_reader.py")
    with reader.open("rb") as source:
        process = subprocess.Popen(command, stdin=source, stdout=subprocess.PIPE, text=True, bufsize=1)
    process.reader_id = reader_id
    process.reader_pid = None
    process.reader_container = container

    def consume():
        for line in process.stdout:
            try:
                data = json.loads(line)
                if data.get("reader_id") == reader_id and isinstance(data.get("reader_pid"), int):
                    process.reader_pid = data["reader_pid"]
                    continue
                if data.get("arm") in state.config["topics"]:
                    state.accept(data["arm"], data["positions"], data.get("velocities", []), data.get("currents", []))
            except (ValueError, KeyError, TypeError):
                continue  # Shell startup text is not a joint message.
        code = process.wait()
        if not STOP.is_set():
            with state.lock:
                state.error = "ROS container reader exited (code %s). Restart the viewer after checking ROS." % code
    threading.Thread(target=consume, daemon=True).start()
    return process


def stop_docker_reader(process):
    # Docker CLI termination alone does not terminate its exec process. Verify
    # this reader's unique environment token before signalling that exact PID.
    cleanup = """import os, signal, sys
pid = int(sys.argv[1])
try:
    environment = open('/proc/%s/environ' % pid, 'rb').read().split(b'\\0')
    if b'VIEWER_READER_ID=' + sys.argv[2].encode() in environment:
        os.kill(pid, signal.SIGTERM)
except (FileNotFoundError, ProcessLookupError, PermissionError):
    pass
"""
    if process.reader_pid is not None:
        try:
            subprocess.run(["docker", "exec", process.reader_container, "python3", "-c", cleanup,
                            str(process.reader_pid), process.reader_id], timeout=3, check=False,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except (OSError, subprocess.TimeoutExpired):
            pass
    if process.poll() is None:
        process.terminate()
    try:
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        process.kill()


class Handler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def __init__(self, *args, state, directory, **kwargs):
        self.state = state
        super().__init__(*args, directory=directory, **kwargs)

    def send_json(self, payload):
        body = json.dumps(payload, allow_nan=False).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == "/api/config":
            return self.send_json(self.state.config)
        if path == "/api/status":
            return self.send_json(self.state.snapshot())
        if path == "/api/joints":
            return self.stream()
        if path.startswith("/api/"):
            return self.send_error(404)
        super().do_GET()

    def list_directory(self, path):
        self.send_error(404)
        return None

    def stream(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache, no-store")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        interval = 1 / self.state.config["stream_hz"]
        try:
            while not STOP.is_set():
                body = json.dumps(self.state.snapshot(), allow_nan=False, separators=(",", ":"))
                self.wfile.write(("data: " + body + "\n\n").encode())
                self.wfile.flush()
                STOP.wait(interval)
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            pass
        self.close_connection = True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--demo", action="store_true", help="Explicit synthetic data mode; never connects to ROS")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--config", type=Path, default=ROOT / "config/ros-topics.json")
    parser.add_argument("--directory", type=Path, default=ROOT / "dist")
    parser.add_argument("--docker-container", help="Read existing ROS topics inside this container, without installing files there")
    parser.add_argument("--ros-setup", default="/home/arm/prj/turtle2/arx_arm/armMasterSlave_x5r5/slave/devel/setup.bash")
    args = parser.parse_args()
    state = JointState(load_config(args.config), args.demo)
    rospy = None
    docker_reader = None
    if args.demo and args.docker_container:
        parser.error("--demo and --docker-container are mutually exclusive")
    # Reserve the HTTP port before starting a ROS subscriber. A duplicate start
    # must not leave an extra container reader behind when the port is busy.
    mimetypes.add_type("text/javascript", ".js")
    handler = functools.partial(Handler, state=state, directory=str(args.directory))
    try:
        server = ThreadingHTTPServer((args.host, args.port), handler)
    except OSError as error:
        parser.exit(1, "Web server could not start: %s\n" % error)
    server.daemon_threads = True
    server.timeout = 0.5
    if args.demo:
        threading.Thread(target=demo_loop, args=(state,), daemon=True).start()
    elif args.docker_container:
        docker_reader = subscribe_docker(state, args.docker_container, args.ros_setup)
    else:
        try:
            rospy, subscriptions = subscribe_ros(state)
        except (ImportError, RuntimeError) as error:
            parser.exit(1, "ROS reader could not start: %s\nUse --demo for local preview.\n" % error)

    def stop(*_):
        STOP.set()
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    print("%s joint viewer: http://%s:%s" % ("DEMO (synthetic)" if args.demo else "ROS read-only", args.host, args.port), flush=True)
    try:
        while not STOP.is_set():
            server.handle_request()
    finally:
        STOP.set()
        server.server_close()
        if docker_reader:
            stop_docker_reader(docker_reader)
        if rospy:
            for subscription in subscriptions:
                subscription.unregister()
            rospy.signal_shutdown("Viewer stopped")


if __name__ == "__main__":
    main()
