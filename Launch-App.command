#!/bin/bash
# Attentix - double-click to start (macOS Finder; on Linux run it from your file manager).
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20 or newer is needed to run from source: https://nodejs.org"
  echo "Or use the Attentix-macos / -linux executable, which needs nothing installed."
  read -n 1 -r -p "Press any key to close..."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "First run: installing the components this app needs (needs internet)..."
  npm install --omit=dev --no-audit --no-fund || { echo "The install failed. Check your connection and try again."; read -n 1 -r -p "Press any key to close..."; exit 1; }
fi

# The server opens your browser by itself, creates its settings on first run and prints the address for students.
exec node src/index.js
