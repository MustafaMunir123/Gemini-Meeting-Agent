# Gemini Sidekick

Helper agent in meetings powered by **Gemini Live API**. Launch a bot into a meeting; the bot streams audio to the agent and plays replies back. You can also join via the in-browser session and hold **Hold to talk to agent** to speak to the AI (your mic is muted while you talk so only the agent hears you).

## Prerequisites

- **Node.js** 18+
- **Meeting SDK** credentials (SDK Key & Secret) for your meeting provider
- **Gemini API key** (for [Google AI Studio](https://aistudio.google.com/) or Vertex)

## Setup

1. **Clone / open the project** and install dependencies:

   ```bash
   cd zoom-agent
   npm install
   ```

2. **Environment variables**

   Copy the example env and set your keys:

   ```bash
   cp .env.example .env.local
   ```

   In `.env.local`:

   - `ZOOM_SDK_KEY` – Meeting SDK key  
   - `ZOOM_SDK_SECRET` – Meeting SDK secret  
   - `NEXT_PUBLIC_GEMINI_API_KEY` – Gemini API key (used in the browser)

3. **Run the app**

   ```bash
   npm run dev
   ```

   Open [http://localhost:3000](http://localhost:3000).

## Flow

1. **Launch meeting bot**: Enter the meeting URL and click **Launch meeting bot**. The bot joins the meeting and connects to the voice agent on the **same server** at `ws://localhost:3000/voice-ws` (single-port deployment).
2. **In-browser session** (optional): Click **Join session** to join via the embedded client, then when **Gemini: Connected** appears, click and hold **Hold to talk to agent**.
3. While holding: your mic is muted, your voice is sent to Gemini, and the agent’s reply is played back.
4. Release the button – mic is unmuted again.
5. Click **Leave session** (or **Leave meeting** for the launched bot) to disconnect.

## Integrations

- **Google Drive**: Connect to search Drive and save meeting minutes. Use **Reauthenticate** on the Drive card if you need to refresh permissions.
- **Jira**: Set `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_KEY` in `.env` to search and create tickets from the agent.

## Deploy to Cloud Run

### For everyone: one-click from a public image

If someone has already published a public image (Docker Hub / Artifact Registry / ghcr.io), you can deploy to **your** GCP project with one command (no build):

1. **Prereq:** [Install gcloud](https://cloud.google.com/sdk/docs/install), then:
   ```bash
   gcloud auth login
   gcloud config set project YOUR_PROJECT_ID
   ```

2. **Deploy** (replace the image URL with the public image you were given):
   ```bash
   GEMINI_SIDEKICK_IMAGE=docker.io/OWNER/gemini-sidekick:latest bash scripts/one-click-deploy.sh
   ```

3. Set env vars in the [Cloud Run console](https://console.cloud.google.com/run) (Edit & Deploy → Variables & Secrets): at least `NEXT_PUBLIC_GEMINI_API_KEY`, `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET`.

**One-click link for your users:** After you publish your own image (see below), set `DEFAULT_IMAGE` in `scripts/one-click-deploy.sh` to your image URL and push. Then share this link (replace `YOUR_GITHUB_USER/YOUR_REPO` with your repo):

**[Open in Cloud Shell and deploy](https://console.cloud.google.com/cloudshell/editor?shellonly=true&cloudshell_git_repo=https://github.com/YOUR_GITHUB_USER/YOUR_REPO&cloudshell_script=scripts/one-click-deploy.sh)** — they open it, pick their project if needed, and run the script.

---

### Maintainers: publish a public image (so others can one-click deploy)

1. **Build and push** the image once to a public registry (e.g. Docker Hub):

   ```bash
   docker build -t YOUR_DOCKERHUB_USER/gemini-sidekick:latest .
   docker push YOUR_DOCKERHUB_USER/gemini-sidekick:latest
   ```

   Make the repo **Public** in Docker Hub. See [docs/PUBLISH-IMAGE.md](docs/PUBLISH-IMAGE.md) for Artifact Registry and ghcr.io.

2. **Enable one-click for everyone:** Edit `scripts/one-click-deploy.sh` and set:
   ```bash
   DEFAULT_IMAGE="docker.io/YOUR_DOCKERHUB_USER/gemini-sidekick:latest"
   ```
   Commit and push. Now anyone can use the Cloud Shell link above or run:
   ```bash
   curl -sL https://raw.githubusercontent.com/YOUR_USER/YOUR_REPO/main/scripts/one-click-deploy.sh | bash
   ```
   (after `gcloud auth` and `gcloud config set project`).

---

### Deploy from source (build in GCP)

To build from this repo instead of using a pre-built image:

```bash
gcloud auth login
gcloud config set project YOUR_PROJECT_ID
npm run deploy:cloudrun
```

## Project structure

- `src/data/getToken.ts` – Server-only JWT generation for the in-browser session.
- `src/lib/GeminiLiveVoiceClient.ts` – Gemini Live client: connect, send mic audio, receive/play response audio, PTT signals.
- `server.js` – Single-port server: Next.js + Voice WebSocket at `/voice-ws`. Run with `npm run dev` or `npm run start`.
- `scripts/voice-ws-server.mjs` – Voice WebSocket logic; mounted on the main server, or run standalone with `npm run voice-ws` (port 3001).
- `scripts/zoom-bot/` – Standalone meeting bot script (joins via URL, no in-browser client required).
- `src/app/App.tsx` – Launch flow, integrations, and in-browser session UI.

## Session name

The in-browser session uses a fixed session/topic name. To join the same “room” from another tab or device, use the same session name and a valid JWT.
