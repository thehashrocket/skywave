#!/usr/bin/env bash
# Pull and restart the radio service. Run on the Droplet from the repo root,
# or from your machine:  ssh deploy@<droplet> 'cd skywave && deploy/deploy.sh'
#
# A restart drops every listener (their page reports the lost connection and
# Listen works again once the service is back), so deploy when nobody's on.
set -euo pipefail
cd "$(dirname "$0")/.."

branch="${1:-main}"
git fetch --prune origin
git checkout "$branch"
git pull --ff-only origin "$branch"

docker compose -f docker-compose.prod.yml up -d --build --remove-orphans
docker image prune -f >/dev/null

for _ in $(seq 1 20); do
  status=$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose -f docker-compose.prod.yml ps -q radio)")
  if [[ "$status" == "healthy" ]]; then
    echo "radio is healthy"
    exit 0
  fi
  sleep 3
done
echo "radio didn't report healthy within 60 s; check: docker compose -f docker-compose.prod.yml logs radio" >&2
exit 1
