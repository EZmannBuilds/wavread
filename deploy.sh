#!/bin/zsh
# Publish the WavRead site to Vercel production.
# Usage: ./deploy.sh   (requires the Vercel CLI, already authenticated)
set -e
cd "$(dirname "$0")"
STAGE="$(mktemp -d)/wavread"
mkdir -p "$STAGE"
cp -r docs/* "$STAGE"/
cp vercel.json "$STAGE"/ 2>/dev/null || true
cd "$STAGE"
vercel deploy --prod --yes
