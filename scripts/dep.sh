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

# 4. Repo and image config
SERVICE_NAME="${CLOUD_RUN_SERVICE:-gemini-sidekick}"
REGION="${CLOUD_RUN_REGION:-us-central1}"
REPO_NAME="gemini-sidekick"
GAR_IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO_NAME}/gemini-sidekick:latest"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# 5. Edit .env FIRST so we have NEXT_PUBLIC_GEMINI_API_KEY at build time (inlined into client bundle)
echo "The script will open the .env file. Add NEXT_PUBLIC_GEMINI_API_KEY and other vars; this file is used for both build and runtime."
echo "When finished, press Ctrl+X, then Y, then Enter to save."
echo ""
read -p "Press Enter to open the editor..."

if ! command -v nano &> /dev/null; then
  echo "nano could not be found, please install it."
  exit 1
fi
nano .env

# 6. Prepare env file for deploy (runtime vars) and extract NEXT_PUBLIC_GEMINI_API_KEY for build
ENV_FILE_DEPLOY=""
BUILD_ARG_GEMINI_KEY=""
if [ -s ".env" ]; then
  grep -v '^#' .env | grep -v '^[[:space:]]*$' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' > .env.deploy
  if [ -s ".env.deploy" ]; then
    ENV_FILE_DEPLOY=".env.deploy"
  fi
  # Value after first = (key may contain = in value)
  BUILD_ARG_GEMINI_KEY=$(grep '^NEXT_PUBLIC_GEMINI_API_KEY=' .env 2>/dev/null | sed 's/^NEXT_PUBLIC_GEMINI_API_KEY=//' | sed 's/^["'\'']//;s/["'\'']$//' | tr -d '\n\r')
fi

if [ -z "$ENV_FILE_DEPLOY" ]; then
  echo "Warning: .env is empty. No runtime env vars will be set. Client may lack Gemini key if not passed at build."
fi

# 7. Ensure Artifact Registry repo exists, then build with cloudbuild.yaml (passes NEXT_PUBLIC at build time)
gcloud artifacts repositories describe "$REPO_NAME" --location="$REGION" --project="$PROJECT_ID" 2>/dev/null || \
  gcloud artifacts repositories create "$REPO_NAME" --repository-format=docker --location="$REGION" --project="$PROJECT_ID"

echo "Building image in Cloud Build (NEXT_PUBLIC_GEMINI_API_KEY is baked into client at build time)..."
echo "  Tag: $GAR_IMAGE"
echo ""

gcloud builds submit --config=cloudbuild.yaml --project="$PROJECT_ID" . \
  --substitutions="_IMAGE=${GAR_IMAGE},_NEXT_PUBLIC_GEMINI_API_KEY=${BUILD_ARG_GEMINI_KEY}"

DEPLOY_IMAGE="$GAR_IMAGE"
echo ""

echo "Deploying to Cloud Run..."
echo "  Image:   $DEPLOY_IMAGE"
echo "  Service: $SERVICE_NAME"
echo "  Region:  $REGION"
echo ""

if [ -n "$ENV_FILE_DEPLOY" ]; then
  echo "Deploying service with env vars from .env file..."
  gcloud run deploy "$SERVICE_NAME" \
    --image "$DEPLOY_IMAGE" \
    --region "$REGION" \
    --platform managed \
    --allow-unauthenticated \
    --timeout 300 \
    --memory 512Mi \
    --env-vars-file="$ENV_FILE_DEPLOY"
else
  gcloud run deploy "$SERVICE_NAME" \
    --image "$DEPLOY_IMAGE" \
    --region "$REGION" \
    --platform managed \
    --allow-unauthenticated \
    --timeout 300 \
    --memory 512Mi
fi

echo ""
echo "Retrieving service URL to set APP_URL..."
SERVICE_URL=$(gcloud run services describe "$SERVICE_NAME" --region "$REGION" --platform=managed --project="$PROJECT_ID" --format='value(status.url)')

if [ -z "$SERVICE_URL" ]; then
    echo "Error: Failed to retrieve Service URL. APP_URL will not be set."
    exit 1
fi

echo "  Service URL is: $SERVICE_URL"
echo "Redeploying to set APP_URL..."

# Second deploy: same env vars plus APP_URL (--env-vars-file replaces all vars, so we must include everything).
if [ -n "$ENV_FILE_DEPLOY" ]; then
  echo "APP_URL=$SERVICE_URL" >> "$ENV_FILE_DEPLOY"
  gcloud run deploy "$SERVICE_NAME" \
    --image "$DEPLOY_IMAGE" \
    --region "$REGION" \
    --platform managed \
    --allow-unauthenticated \
    --timeout 300 \
    --memory 512Mi \
    --env-vars-file="$ENV_FILE_DEPLOY"
else
  gcloud run deploy "$SERVICE_NAME" \
    --image "$DEPLOY_IMAGE" \
    --region "$REGION" \
    --platform managed \
    --allow-unauthenticated \
    --timeout 300 \
    --memory 512Mi \
    --set-env-vars="APP_URL=$SERVICE_URL"
fi

echo ""
echo "✅ Deployment complete."
echo "Service is available at: $SERVICE_URL"
echo ""