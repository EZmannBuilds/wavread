#!/bin/zsh
# Publish the WavRead site to Vercel production.
# Usage: ./deploy.sh   (requires the Vercel CLI, already authenticated)
set -e
cd "$(dirname "$0")"
npm run check
npm test
npm run build
STAGE="$(mktemp -d)/wavread"
mkdir -p "$STAGE"
cp -r dist-site/* "$STAGE"/
cp vercel.json "$STAGE"/
cd "$STAGE"
vercel deploy --prod --yes
