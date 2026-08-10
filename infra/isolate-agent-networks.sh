#!/usr/bin/env bash
# One-time migration: move already-running agent containers off Docker's
# default `bridge` network onto the isolated `hermes-agents` network (ICC
# disabled — sibling agent containers can no longer reach each other).
#
# New deploys already get this automatically (deployer-worker's
# ensureAgentNetwork() in src/docker.ts runs on every runContainer). This
# script only backfills agents that were already running before that change
# shipped — a fresh deploy never needs it.
#
# Safe to re-run (idempotent) and safe on a live agent: `docker network
# connect`/`disconnect` attach/detach a running container without touching its
# process, so this does NOT restart the container and does NOT trip the crash
# watcher (which only reacts to `die`/`oom` events).
#
# Run ON THE EC2 WORKER HOST:
#   ssh -i ~/.ssh/hermes-worker-deploy.pem ubuntu@<worker-ip>
#   sudo bash infra/isolate-agent-networks.sh
set -euo pipefail

NETWORK="hermes-agents"

if ! docker network inspect "$NETWORK" >/dev/null 2>&1; then
  echo "==> creating $NETWORK (icc disabled)"
  docker network create --driver bridge \
    -o com.docker.network.bridge.enable_icc=false \
    "$NETWORK"
else
  echo "==> $NETWORK already exists"
fi

mapfile -t CONTAINERS < <(docker ps --format '{{.Names}}' --filter 'name=^hermes-')

if [ "${#CONTAINERS[@]}" -eq 0 ]; then
  echo "==> no running hermes-* containers found, nothing to migrate"
  exit 0
fi

for c in "${CONTAINERS[@]}"; do
  networks="$(docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$c")"

  if [[ " $networks " == *" $NETWORK "* ]]; then
    echo "-- $c: already on $NETWORK, skipping"
  else
    echo "-- $c: connecting to $NETWORK"
    docker network connect "$NETWORK" "$c"
  fi

  if [[ " $networks " == *" bridge "* ]]; then
    echo "-- $c: disconnecting from default bridge"
    docker network disconnect bridge "$c"
  fi
done

echo "==> done. Verify with: docker network inspect $NETWORK --format '{{range .Containers}}{{.Name}} {{end}}'"
