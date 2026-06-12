#!/usr/bin/env bash
set -euo pipefail

GITHUB_OWNER="${GITHUB_OWNER:-vishalegnition}"
REPO="egnition-qa-runner"
INSTALL_DIR="${HOME}/.egnition-qa-runner"
CHROME_PROFILE="${HOME}/.egnition-qa-chrome"
ZIP_URL="https://github.com/${GITHUB_OWNER}/${REPO}/archive/refs/heads/main.zip"
LOCAL_PORT="${LOCAL_PORT:-3000}"
CHROME_PORT="${CHROME_DEBUG_PORT:-9222}"

echo ""
echo " Egnition QA Runner — Mac Installer"
echo " =================================="
echo ""

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js not found. Opening Node.js download page..."
  open "https://nodejs.org/en/download" || true
  echo "Install Node.js, then re-run this script."
  exit 0
fi

echo "[1/5] Downloading latest runner from GitHub..."
TMP_ZIP="$(mktemp /tmp/qa-runner.XXXXXX.zip)"
TMP_DIR="$(mktemp -d /tmp/qa-runner-extract.XXXXXX)"
curl -fsSL "$ZIP_URL" -o "$TMP_ZIP"
unzip -q "$TMP_ZIP" -d "$TMP_DIR"
mkdir -p "$INSTALL_DIR"
rsync -a --delete "${TMP_DIR}/${REPO}-main/" "$INSTALL_DIR/"
rm -rf "$TMP_ZIP" "$TMP_DIR"

echo "[2/5] Installing dependencies..."
cd "$INSTALL_DIR"
npm install --omit=dev

echo "[3/5] Launching QA Chrome on port ${CHROME_PORT}..."
CHROME_APP="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
if [[ ! -x "$CHROME_APP" ]]; then
  echo "Google Chrome not found. Please install Chrome and try again."
  exit 1
fi

if ! lsof -iTCP:"${CHROME_PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  "$CHROME_APP" \
    --remote-debugging-port="${CHROME_PORT}" \
    --user-data-dir="${CHROME_PROFILE}" \
    --no-first-run \
    --no-default-browser-check \
    >/dev/null 2>&1 &
  sleep 3
else
  echo "QA Chrome already running on port ${CHROME_PORT}"
fi

echo "[4/5] Starting local server on port ${LOCAL_PORT}..."
if lsof -iTCP:"${LOCAL_PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  lsof -tiTCP:"${LOCAL_PORT}" -sTCP:LISTEN | xargs kill -9 2>/dev/null || true
  sleep 1
fi

export EGNITION_QA_HOME="$INSTALL_DIR"
nohup node server/index.js >> "${INSTALL_DIR}/server.log" 2>&1 &
sleep 2

echo "[5/5] Opening web app..."
open "http://localhost:${LOCAL_PORT}"

echo ""
echo " Done! Log into your dev store in QA Chrome if prompted, then run tests."
echo " Server log: ${INSTALL_DIR}/server.log"
echo ""
