#!/usr/bin/env bash
# One-click deploy: auth → project → APIs → deploy to Cloud Run.
# Use as cloudshell_script when opening from "Run on Google Cloud" button.

set -e

echo "=============================================="
echo "  Gemini Sidekick — Deploy to Cloud Run"
echo "=============================================="
echo ""

# 1. Ensure logged in
echo "Checking Google Cloud login..."
if ! gcloud auth list --filter=status:ACTIVE --format="value(account)" 2>/dev/null | grep -q .; then
  echo "No active account. Running: gcloud auth login"
  gcloud auth login
fi
echo "  Logged in as: $(gcloud config get-value account 2>/dev/null)"
echo ""

# 2. Get project ID (prompt if not set)
PROJECT_ID="$(gcloud config get-value project 2>/dev/null)"
if [ -z "$PROJECT_ID" ]; then
  echo "No project set. Your projects:"
  gcloud projects list --format="table(projectId,name)" 2>/dev/null || true
  echo ""
  read -p "Enter your GCP PROJECT_ID: " PROJECT_ID
  if [ -z "$PROJECT_ID" ]; then
    echo "Error: PROJECT_ID is required."
    exit 1
  fi
  gcloud config set project "$PROJECT_ID"
fi
echo "Using project: $PROJECT_ID"
echo ""

# 3. Enable required APIs
echo "Enabling required APIs (Cloud Run, Artifact Registry, Cloud Build)..."
gcloud services enable run.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com --project="$PROJECT_ID" 2>/dev/null || true
echo "  Done."
echo ""

# 4. Deploy (Docker Hub "latest" is an Image Index; Cloud Run needs a single manifest — re-push to Artifact Registry)
DEFAULT_IMAGE="docker.io/mm2036/gemini-sidekick:latest"
IMAGE="${GEMINI_SIDEKICK_IMAGE:-$DEFAULT_IMAGE}"
SERVICE_NAME="${CLOUD_RUN_SERVICE:-gemini-sidekick}"
REGION="${CLOUD_RUN_REGION:-us-central1}"
DEPLOY_IMAGE="$IMAGE"

if [[ "$IMAGE" == docker.io/* ]]; then
  REPO_NAME="gemini-sidekick"
  GAR_IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO_NAME}/gemini-sidekick:latest"
  echo "Docker Hub 'latest' is a multi-arch index; copying amd64 image to Artifact Registry for Cloud Run..."
  echo "  Pull: $IMAGE"
  echo "  Push: $GAR_IMAGE"
  echo ""

  gcloud artifacts repositories describe "$REPO_NAME" --location="$REGION" --project="$PROJECT_ID" 2>/dev/null || \
    gcloud artifacts repositories create "$REPO_NAME" --repository-format=docker --location="$REGION" --project="$PROJECT_ID"
  gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet

  docker pull --platform linux/amd64 "$IMAGE"
  docker tag "$IMAGE" "$GAR_IMAGE"
  docker push "$GAR_IMAGE"

  DEPLOY_IMAGE="$GAR_IMAGE"
  echo ""
fi

echo "Deploying to Cloud Run..."
echo "  Image:   $DEPLOY_IMAGE"
echo "  Service: $SERVICE_NAME"
echo "  Region:  $REGION"
echo ""

gcloud run deploy "$SERVICE_NAME" \
  --image "$DEPLOY_IMAGE" \
  --region "$REGION" \
  --platform managed \
  --allow-unauthenticated

echo ""
echo "Done. Open your service URL and set env vars in the Cloud Run console:"
echo "  Edit & Deploy → Variables & Secrets"
echo "  Required: NEXT_PUBLIC_GEMINI_API_KEY, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET"
echo "  Optional: JIRA_*, GOOGLE_*, DRIVE_*, APP_URL (your Cloud Run URL)"
echo ""
