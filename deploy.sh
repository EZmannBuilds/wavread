#!/bin/zsh
# Publish the WavRead site to Vercel production.
# Usage: ./deploy.sh   (requires the Vercel CLI, already authenticated)
set -e
cd "$(dirname "$0")"

PROJECT="wavread"

npm run check
npm test
npm run build

STAGE="$(mktemp -d)/$PROJECT"
mkdir -p "$STAGE"
cp -r dist-site/* "$STAGE"/
cp vercel.json "$STAGE"/
cd "$STAGE"

# Say which project this goes to, rather than letting Vercel infer it from the
# staging directory's name. The inference works right up until the directory is
# called something else, and then --yes does not fail — it creates a second
# project and deploys there, so the command reports success while wavread.com
# stays exactly as it was.
vercel link --yes --project "$PROJECT"

# Linking writes .env.local, and it holds a VERCEL_OIDC_TOKEN. Everything in
# this directory is about to be published as static files on a public site, so
# it goes before the deploy, not after.
rm -f .env.local .gitignore

# Prove the link points where we think before publishing anything.
linked="$(node -e 'process.stdout.write(require("./.vercel/project.json").projectName)')"
if [ "$linked" != "$PROJECT" ]; then
  echo "Linked to '$linked', expected '$PROJECT' — refusing to deploy." >&2
  exit 1
fi

vercel deploy --prod --yes
