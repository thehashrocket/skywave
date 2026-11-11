#!/usr/bin/env bash
# Pull and restart the radio service. Run on the Droplet from anywhere:
#   ~/skywave/deploy/deploy.sh [branch]        (default: main)
# GitHub Actions runs it through deploy/forced-command.sh after CI passes on main.
#
# A rebuild that changes the image restarts the container, which drops every
# listener (their page reports the lost connection and Listen works again once
# the service is back). A push that leaves apps/radio alone builds the same
# image from cache, and compose leaves the running container as it is.
set -euo pipefail

# Everything lives in main(), so bash has read the whole file before the git
# pull below can rewrite it.
main() {
  cd "$(dirname "$0")/.."
  local branch="${1:-main}"
  local compose=(docker compose -f docker-compose.prod.yml)

  git fetch --prune origin
  git checkout "$branch"
  git pull --ff-only origin "$branch"
  echo "deploying $(git rev-parse --short HEAD) ($branch)"

  "${compose[@]}" up -d --build --remove-orphans
  docker image prune -f >/dev/null

  local status
  for _ in $(seq 1 20); do
    status=$(docker inspect -f '{{.State.Health.Status}}' "$("${compose[@]}" ps -q radio)")
    if [[ "$status" == "healthy" ]]; then
      echo "radio is healthy"
      return 0
    fi
    sleep 3
  done
  echo "radio didn't report healthy within 60 s; check: ${compose[*]} logs radio" >&2
  return 1
}

main "$@"
