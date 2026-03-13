# Gemini Sidekick

Helper agent in meetings powered by **Gemini Live API**. Launch a bot into a meeting; it streams audio to the agent and plays replies back.

## Setup

### One-click deploy (Cloud Run)

1. Launch your own private instance of the app to Google Cloud in just one click. No local setup required.

   [![Run on Google Cloud](./run-on-google-cloud.png)](https://console.cloud.google.com/cloudshell/editor?shellonly=true&cloudshell_git_repo=https://github.com/MustafaMunir123/Gemini-Meeting-Agent&cloudshell_script=scripts/one-click-deploy.sh)
2. In [Cloud Run](https://console.cloud.google.com/run) → your service → **Edit & deploy** → **Variables & secrets**, add:

```
NEXT_PUBLIC_GEMINI_API_KEY=
ZOOM_CLIENT_ID=
ZOOM_CLIENT_SECRET=

Optional — Google Drive
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
DRIVE_FOLDER_ID=

Optional — Jira
JIRA_API_KEY=
JIRA_BASE_URL=
JIRA_EMAIL=
```

Set `APP_URL` to your service URL if you use the meeting bot.

### Local

```bash
git clone https://github.com/MustafaMunir123/Gemini-Meeting-Agent.git
cd Gemini-Meeting-Agent
npm install
cp .env.example .env.local
```

Edit `.env.local`: set `NEXT_PUBLIC_GEMINI_API_KEY`, `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET`.

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Enter a meeting URL and click **Launch meeting bot**, or **Join session** to talk to the agent in-browser.
