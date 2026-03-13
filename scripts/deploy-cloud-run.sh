#!/usr/bin/env bash
# One-click deploy Gemini Sidekick to Google Cloud Run
# Prereqs: gcloud CLI installed and logged in (gcloud auth login, gcloud config set project YOUR_PROJECT_ID)

set -e

SERVICE_NAME="${CLOUD_RUN_SERVICE:-gemini-sidekick}"
REGION="${CLOUD_RUN_REGION:-us-central1}"
PROJECT_ID="${GCLOUD_PROJECT:-$(gcloud config get-value project 2>/dev/null)}"

if [ -z "$PROJECT_ID" ]; then
  echo "Error: No GCP project set. Run: gcloud config set project YOUR_PROJECT_ID"
  exit 1
fi

echo "Deploying to Cloud Run..."
echo "  Project: $PROJECT_ID"
echo "  Service: $SERVICE_NAME"
echo "  Region:  $REGION"
echo ""

# Deploy from source (uses Dockerfile in repo root). Cloud Run sets PORT=8080.
gcloud run deploy "$SERVICE_NAME" \
  --source . \
  --region "$REGION" \
  --platform managed \
  --allow-unauthenticated

echo ""
echo "Done. Set env vars in Cloud Run console (Edit & Deploy → Variables & Secrets) or run:"
echo "  gcloud run services update $SERVICE_NAME --region $REGION --set-env-vars NEXT_PUBLIC_GEMINI_API_KEY=xxx,ZOOM_CLIENT_ID=xxx,ZOOM_CLIENT_SECRET=xxx"
echo ""
echo "Required: NEXT_PUBLIC_GEMINI_API_KEY, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET"
echo "Optional: JIRA_*, GOOGLE_*, DRIVE_*, APP_URL (your Cloud Run URL for bot voice WS)"
