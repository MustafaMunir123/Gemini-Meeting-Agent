# Gemini Sidekick

Helper agent in meetings powered by **Gemini Live API**. Launch a bot into a meeting; it streams audio to the agent and plays replies back. You can also join in-browser and use **Hold to talk to agent**.

## Setup

### One-click deploy (Cloud Run)

1. [Install gcloud](https://cloud.google.com/sdk/docs/install), then:
   ```bash
   gcloud auth login
   gcloud config set project YOUR_PROJECT_ID
   ```
2. Deploy:
   ```bash
   curl -sL https://raw.githubusercontent.com/mm2036/gemini-sidekick/main/scripts/one-click-deploy.sh | bash
   ```
   Or **[open in Cloud Shell](https://console.cloud.google.com/cloudshell/editor?shellonly=true&cloudshell_git_repo=https://github.com/mm2036/gemini-sidekick&cloudshell_script=scripts/one-click-deploy.sh)** and run the script.
3. In [Cloud Run](https://console.cloud.google.com/run) → your service → **Edit & deploy** → **Variables & secrets**, add: `NEXT_PUBLIC_GEMINI_API_KEY`, `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET`. Set `APP_URL` to your service URL if you use the meeting bot.

### Local

```bash
git clone https://github.com/mm2036/gemini-sidekick.git
cd gemini-sidekick
npm install
cp .env.example .env.local
```

Edit `.env.local`: set `NEXT_PUBLIC_GEMINI_API_KEY`, `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET`.

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Enter a meeting URL and click **Launch meeting bot**, or **Join session** to talk to the agent in-browser.
