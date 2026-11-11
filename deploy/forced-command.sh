#!/usr/bin/env bash
# The only thing the GitHub Actions key may run on the Droplet. Installed in
# ~deploy/.ssh/authorized_keys as:
#
#   command="/home/deploy/skywave/deploy/forced-command.sh",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty ssh-ed25519 AAAA... github-actions
#
# The client's command line arrives in SSH_ORIGINAL_COMMAND and is used only as
# a branch name, so a leaked key can redeploy a branch and nothing else.
set -euo pipefail

branch="${SSH_ORIGINAL_COMMAND:-main}"
if [[ ! "$branch" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$ || "$branch" == *..* ]]; then
  echo "refusing branch name: $branch" >&2
  exit 2
fi

exec "$(dirname "$0")/deploy.sh" "$branch"
