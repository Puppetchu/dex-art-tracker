#!/bin/bash
cd "$(dirname "$0")"
echo "Starting Dex Art Card Tracker. The first time this takes a few minutes..."
if docker compose up -d --build; then
  open http://localhost:8080
  echo
  echo "Running. Open http://localhost:8080 in your browser. You can close this window."
else
  echo
  echo "Something went wrong. Is Docker Desktop installed and running?"
fi
read -n 1 -s -r -p "Press any key to close"
