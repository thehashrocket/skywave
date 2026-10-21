#!/usr/bin/env bash
# The pre-gate runner (.gstack/pregate.json). gstack-pregate takes one command
# for every selected test file, so this sends each file to its own app's
# runner: Python tests to the radio service's pytest, TypeScript tests to the
# web app's vitest. Paths arrive relative to the repo root.
set -o pipefail
cd "$(dirname "$0")/.." || exit 2

py=() web=() other=()
for f in "$@"; do
  case "$f" in
    apps/radio/*.py) py+=("$f") ;;
    apps/web/*.ts | apps/web/*.tsx) web+=("${f#apps/web/}") ;;
    *) other+=("$f") ;;
  esac
done

if ((${#other[@]})); then
  echo "pregate-run: no runner for: ${other[*]}" >&2
  exit 2
fi

status=0
if ((${#py[@]})); then
  apps/radio/.venv/bin/python -m pytest "${py[@]}" || status=1
fi
if ((${#web[@]})); then
  (cd apps/web && node_modules/.bin/vitest run "${web[@]}") || status=1
fi
exit $status
