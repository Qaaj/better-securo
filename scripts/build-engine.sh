#!/usr/bin/env bash
# Rebuild the retirement engine bundle that the backend runs, and copy it into the backend.
# Run from the repo root with the dev stack up:  scripts/build-engine.sh
set -euo pipefail
cd "$(dirname "$0")/.."
PROJECT="${COMPOSE_PROJECT:-securo-dev}"
docker compose -p "$PROJECT" exec -T frontend npm run build:engine
mkdir -p backend/app/engine
cp frontend/engine-dist/retirement_engine.js frontend/engine-dist/retirement_engine.sha256 backend/app/engine/
echo "Copied to backend/app/engine"
