#!/usr/bin/env bash
set -e


DEFAULT_IMAGE="docker.io/mm2036/gemini-sidekick:latest"
IMAGE="${GEMINI_SIDEKICK_IMAGE:-$DEFAULT_IMAGE}"

SERVICE_NAME="${CLOUD_RUN_SERVICE:-gemini-sidekick}"
REGION="${CLOUD_RUN_REGION:-us-central1}"
PROJECT_ID="${GCLOUD_PROJECT:-$(gcloud config get-value project 2>/dev/null)}"

if [ -z "$IMAGE" ]; then
  echo "Error: No container image set."
  echo "  Use: GEMINI_SIDEKICK_IMAGE=docker.io/USER/gemini-sidekick:latest $0"
  echo "  Or set DEFAULT_IMAGE in this script (for a shared one-click link)."
  exit 1
fi

if [ -z "$PROJECT_ID" ]; then
  echo "Error: No GCP project set."
  echo "  Run: gcloud auth login"
  echo "       gcloud config set project YOUR_PROJECT_ID"
  exit 1
fi

echo "Deploying Gemini Sidekick to Cloud Run..."
echo "  Image:   $IMAGE"
echo "  Project: $PROJECT_ID"
echo "  Service: $SERVICE_NAME"
echo "  Region:  $REGION"
echo ""

gcloud run deploy "$SERVICE_NAME" \
  --image "$IMAGE" \
  --region "$REGION" \
  --platform managed \
  --allow-unauthenticated

echo ""
echo "Done. Open your service URL and set env vars in the Cloud Run console:"
echo "  Edit & Deploy → Variables & Secrets"
echo "  Required: NEXT_PUBLIC_GEMINI_API_KEY, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET"
echo "  Optional: JIRA_*, GOOGLE_*, DRIVE_*, APP_URL (your Cloud Run URL)"
echo ""
