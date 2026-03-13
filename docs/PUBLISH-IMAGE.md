# Publish a public image for one-click deploy

Do this **once** so anyone can deploy Gemini Sidekick to their own GCP project from your image (no build on their side).

## Option A: Docker Hub (simplest for “everyone”)

1. Create a [Docker Hub](https://hub.docker.com) account and log in: `docker login`.

2. From the repo root, build and push (one command):

   ```bash
   DOCKER_USER=yourusername bash scripts/publish-image.sh
   ```

3. Make the repo **Public** in Docker Hub (Settings → Make Public).

4. Set `DEFAULT_IMAGE="docker.io/yourusername/gemini-sidekick:latest"` in `scripts/one-click-deploy.sh` and push. Then share the one-click link from the README.

## Option B: Google Artifact Registry (public)

1. Create a public Artifact Registry repo (or use one you have):

   ```bash
   gcloud artifacts repositories create gemini-sidekick --repository-format=docker --location=us-central1
   # Then make the repo public in Console → Artifact Registry → your repo → Permissions
   ```

2. Configure Docker for Artifact Registry and push:

   ```bash
   gcloud auth configure-docker us-central1-docker.pkg.dev
   docker build -t us-central1-docker.pkg.dev/YOUR_PROJECT_ID/gemini-sidekick/app:latest .
   docker push us-central1-docker.pkg.dev/YOUR_PROJECT_ID/gemini-sidekick/app:latest
   ```

3. The image URL is: `us-central1-docker.pkg.dev/YOUR_PROJECT_ID/gemini-sidekick/app:latest`

## Option C: GitHub Container Registry (ghcr.io)

1. Create a personal access token with `write:packages` and log in:

   ```bash
   echo $GITHUB_TOKEN | docker login ghcr.io -u USERNAME --password-stdin
   ```

2. Build and push:

   ```bash
   docker build -t ghcr.io/USERNAME/gemini-sidekick:latest .
   docker push ghcr.io/USERNAME/gemini-sidekick:latest
   ```

3. In GitHub repo Settings → Packages → make the package public. Image URL: `ghcr.io/USERNAME/gemini-sidekick:latest`

---

After you have a **public** image URL, use it for the one-click deploy (see README).
