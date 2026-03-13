#!/usr/bin/env bash
# Build and push the Gemini Sidekick image to a public registry (for one-click deploy).
# Run once, then set DEFAULT_IMAGE in scripts/one-click-deploy.sh and share the one-click link.
#
# Usage:
#   DOCKER_USER=yourdockerhubuser bash scripts/publish-image.sh
#   # Or for ghcr.io: REGISTRY=ghcr.io/USERNAME bash scripts/publish-image.sh

set -e

DOCKER_USER="${DOCKER_USER:-}"
REGISTRY="${REGISTRY:-docker.io}"
TAG="${TAG:-latest}"
IMAGE_NAME="${IMAGE_NAME:-gemini-sidekick}"

if [ -z "$DOCKER_USER" ] && [ "$REGISTRY" = "docker.io" ]; then
  echo "Set DOCKER_USER (Docker Hub username). Example:"
  echo "  DOCKER_USER=myuser bash scripts/publish-image.sh"
  exit 1
fi

if [ "$REGISTRY" = "docker.io" ]; then
  FULL_IMAGE="$REGISTRY/$DOCKER_USER/$IMAGE_NAME:$TAG"
else
  FULL_IMAGE="$REGISTRY/$IMAGE_NAME:$TAG"
fi

echo "Building and pushing: $FULL_IMAGE (linux/amd64 for Cloud Run)"
echo ""

docker build --platform linux/amd64 -t "$FULL_IMAGE" .
docker push "$FULL_IMAGE"

echo ""
echo "Done. Image is at: $FULL_IMAGE"
echo "Next: set DEFAULT_IMAGE in scripts/one-click-deploy.sh to: $FULL_IMAGE"
echo "Then anyone can deploy with: GEMINI_SIDEKICK_IMAGE=$FULL_IMAGE bash scripts/one-click-deploy.sh"
echo ""
