#!/bin/sh
# Deploys the image CI published for one commit: run by CI over SSH, as the forced
# command of its key (see docs/DEPLOYMENT.md, "Deploying from CI"), with the commit's
# full SHA as the only input. Also works by hand: ./deploy.sh <sha>.
#
# The image is recorded in .env (RAWTISSERIE_IMAGE), so a later `docker compose up`
# keeps it. Fails, with the app's last logs, if it doesn't answer its health check.
set -eu

sha=${SSH_ORIGINAL_COMMAND:-${1:-}}
case $sha in
'' | *[!0-9a-f]*)
  echo "usage: deploy.sh <commit sha, 40 hex characters>" >&2
  exit 2
  ;;
esac
if [ ${#sha} -ne 40 ]; then
  echo "usage: deploy.sh <commit sha, 40 hex characters>" >&2
  exit 2
fi

cd "$(dirname "$0")"
image=ghcr.io/thibautre/rawtisserie:sha-$sha
docker pull -q "$image" >/dev/null
sed -i "s|^RAWTISSERIE_IMAGE=.*|RAWTISSERIE_IMAGE=$image|" .env
grep -q "^RAWTISSERIE_IMAGE=$image\$" .env || echo "RAWTISSERIE_IMAGE=$image" >>.env
docker compose up -d app

health="fetch('http://127.0.0.1:4000/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
for _ in $(seq 1 60); do
  if docker compose exec -T app node -e "$health" 2>/dev/null; then
    echo "deployed $sha"
    docker image prune -f >/dev/null
    exit 0
  fi
  sleep 2
done
echo "the app didn't come up with $image" >&2
docker compose logs --tail 50 app >&2
exit 1
