"""Subscriber program streamed to Python stdin inside the existing ROS container.

It emits JSON to stdout. No files are installed in the container and no control
topic is published. Configuration is provided by the parent process environment.
"""
import json
import math
import os
import sys
import threading

import rospy
from roslib.message import get_message_class

topics = json.loads(os.environ["VIEWER_TOPICS"])
message_type = os.environ["VIEWER_MESSAGE_TYPE"]
message_class = get_message_class(message_type)
if message_class is None:
    raise RuntimeError("Message type unavailable: " + message_type)
lock = threading.Lock()
print(json.dumps({"reader_pid": os.getpid(), "reader_id": os.environ["VIEWER_READER_ID"]}), flush=True)
rospy.init_node("x2_viewer_joint_reader", anonymous=True, log_level=rospy.ERROR)


def callback(msg, arm):
    positions = list(msg.joint_pos)
    if len(positions) < 6 or not all(math.isfinite(v) for v in positions):
        return
    payload = {"arm": arm, "positions": positions,
               "velocities": list(msg.joint_vel), "currents": list(msg.joint_cur)}
    try:
        line = json.dumps(payload, allow_nan=False)
    except ValueError:
        return
    with lock:
        try:
            sys.stdout.write(line + "\n")
            sys.stdout.flush()
        except BrokenPipeError:
            os._exit(0)


subscribers = [rospy.Subscriber(topic, message_class, callback, callback_args=arm,
                              queue_size=1, tcp_nodelay=True) for arm, topic in topics.items()]
rospy.spin()
