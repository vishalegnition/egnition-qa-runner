#!/bin/sh
set -e
if command -v Xvfb >/dev/null 2>&1; then
  Xvfb :99 -screen 0 1440x900x24 &
  export DISPLAY=:99
  sleep 2
fi
exec node webhook/index.js
