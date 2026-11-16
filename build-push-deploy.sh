#!/bin/sh
# This script builds and deploys the Monize backend and frontend to my private Kubernetes registry
# then restarts the Monize workloads to use the new images.
# Usage: ./build-push-deploy.sh [backend|frontend]...   (default: both)
# THIS IS NOT INTENDED FOR PUBLIC USE. DO NOT USE THIS AS A TEMPLATE FOR YOUR OWN PROJECTS.

set -e

REGISTRY=registry.laskonet.com/monize
NAMESPACE=monize

usage() {
	echo "Usage: $0 [backend|frontend]...   (default: both)" >&2
	exit 1
}

# No arguments means both, as before; otherwise build only what was asked for.
if [ $# -eq 0 ]; then
	COMPONENTS="backend frontend"
else
	COMPONENTS=""
	for arg in "$@"; do
		case "$arg" in
			backend|frontend) COMPONENTS="$COMPONENTS $arg" ;;
			all|both) COMPONENTS="$COMPONENTS backend frontend" ;;
			*) echo "Unknown component: $arg" >&2; usage ;;
		esac
	done
fi

build_component() {
	case "$1" in
		backend) docker build -t $REGISTRY/backend:latest --target production -f backend/Dockerfile . ;;
		frontend) docker build -t $REGISTRY/frontend:latest --target production ./frontend ;;
	esac
}

# Echoes "deployment" or "statefulset" for the named workload, whichever exists.
workload_kind() {
	for kind in deployment statefulset; do
		if kubectl get -n "$NAMESPACE" "$kind" "$1" >/dev/null 2>&1; then
			echo "$kind"
			return 0
		fi
	done
	echo "No deployment or statefulset named $1 in namespace $NAMESPACE" >&2
	return 1
}

for component in $COMPONENTS; do
	echo "Building $component..."
	build_component "$component"
	echo "Pushing $component..."
	docker push $REGISTRY/$component:latest
done

for component in $COMPONENTS; do
	workload=monize-$component
	kind=$(workload_kind "$workload")
	echo "Restarting $kind/$workload..."
	kubectl rollout restart -n "$NAMESPACE" "$kind/$workload"
done

for component in $COMPONENTS; do
	workload=monize-$component
	kind=$(workload_kind "$workload")
	echo "Waiting for $kind/$workload to roll out..."
	kubectl rollout status -n "$NAMESPACE" "$kind/$workload" --timeout=5m
done

echo "Done."
