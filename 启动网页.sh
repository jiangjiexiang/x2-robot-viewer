#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
exec python3 server/ros_stream.py --host 0.0.0.0 --port 8765 --docker-container turtle2_release "$@"
