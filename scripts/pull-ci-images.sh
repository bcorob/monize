#!/usr/bin/env bash
# Pull the third-party images a compose stack needs, one at a time, with retries.
#
# A registry can throttle anonymous pulls per source IP ("toomanyrequests");
# `docker compose up` pulls every missing image in parallel and fails the job
# on the first 429. Pulling first, in
# sequence and with a back-off, leaves `up` nothing to pull.
# docs/verification-contract.md section 7.
#
# Usage: scripts/pull-ci-images.sh -f docker-compose.e2e.yml [-f overlay.yml]
# COMPOSE_PROFILES is honoured, so a profile's extra images are pulled too.
set -euo pipefail

attempts=5
for image in $(docker compose "$@" config --images | sort -u); do
  case "$image" in
    *:local) continue ;; # built by CI itself
    */*) ;;
    *) continue ;; # a service with no image name of its own
  esac
  for attempt in $(seq 1 "$attempts"); do
    if docker pull --quiet "$image"; then
      break
    fi
    if [ "$attempt" -eq "$attempts" ]; then
      echo "::error::could not pull $image after $attempts attempts" >&2
      exit 1
    fi
    sleep $((attempt * 15))
  done
done
