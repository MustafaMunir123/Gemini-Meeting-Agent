# How to run everything

You can run the voice agent in Zoom meetings in two ways: **minimal (no Attendee)** or **with Attendee**.

---

## Option 1: Minimal (no Attendee) – recommended

No Docker, no Postgres, no Redis. Just Node: voice server + zoom-bot runner.

### 1. One-time setup

```bash
cd zoom-agent
npm install
npx playwright install chromium
```

In `.env` (or `.env.local`), set:

- `NEXT_PUBLIC_GEMINI_API_KEY` or `GEMINI_API_KEY` – from [Google AI Studio](https://aistudio.google.com/)
- `ZOOM_CLIENT_ID` – Zoom **Meeting** SDK app client ID ([Zoom Marketplace](https://marketplace.zoom.us/) → create Meeting SDK app)
- `ZOOM_CLIENT_SECRET` – Zoom Meeting SDK app client secret

### 2. Start the voice server (terminal 1)

```bash
npm run voice-ws
```

This starts the WebSocket server on **port 3001** (or `VOICE_WS_PORT`). It receives meeting audio and talks to Gemini; it can also call Drive/Jira if those are configured.

### 3. Expose 3001 for Zoom (if the bot runs on another machine)

If the zoom-bot runs on the same machine as the voice server, you can use `ws://localhost:3001`.  
If the bot runs elsewhere (e.g. another server), expose 3001 with ngrok:

```bash
ngrok http 3001
```

Use the **wss://** URL (e.g. `wss://abc123.ngrok.io`) as `VOICE_WS_URL` in the next step.

### 4. Run the Zoom bot (terminal 2)

Same repo, second terminal:

```bash
MEETING_URL="https://zoom.us/j/YOUR_MEETING_ID?pwd=YOUR_PASSWORD" \
VOICE_WS_URL="ws://localhost:3001" \
npm run zoom-bot
```

- **Same machine**: `VOICE_WS_URL=ws://localhost:3001`
- **After ngrok**: `VOICE_WS_URL=wss://YOUR_SUBDOMAIN.ngrok.io`

The bot joins the meeting and streams meeting audio to the voice server. Speak in the meeting; the agent replies via the bot (if your voice server sends audio back to the meeting).

To see the browser: `HEADLESS=0 MEETING_URL=... VOICE_WS_URL=... npm run zoom-bot`

### Summary (minimal)

| Terminal | Command |
|----------|--------|
| 1 | `npm run voice-ws` |
| 2 | `MEETING_URL="https://zoom.us/j/XXX?pwd=YYY" VOICE_WS_URL=ws://localhost:3001 npm run zoom-bot` |

Optional: `npm run dev` for the Next.js app (e.g. Drive/Jira, or a custom UI). The **voice agent** works with just voice-ws + zoom-bot.

---

## Option 2: With Attendee

Use this if you want the full Attendee stack (Django, Redis, optional Postgres) and to launch the bot from the web UI or API.

### 1. Start Attendee (Docker)

```bash
cd attendee-main
docker compose -f dev-minimal.docker-compose.yaml run --rm attendee-app-local python manage.py migrate   # first time only
docker compose -f dev-minimal.docker-compose.yaml up --build
```

In `attendee-main/.env`: `USE_ZOOM_CREDENTIALS_FROM_ENV=1`, `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET`.

### 2. Start voice server (zoom-agent repo)

```bash
cd zoom-agent
npm run voice-ws
```

### 3. Expose voice server (e.g. ngrok)

```bash
ngrok http 3001
```

### 4. Start zoom-agent app and launch bot

```bash
cd zoom-agent
npm run dev
```

Open http://localhost:3000, use the launch flow with your meeting URL and the **wss://** ngrok URL as the voice WebSocket URL. Attendee creates the bot and streams audio to 3001.

---

## Zoom authorization (March 2026)

**Beginning March 2, 2026**, Zoom requires apps that join meetings **outside the app’s Zoom account** to use **OBF**, **ZAK**, or **RTMS** instead of the current SDK Key + Secret JWT. Our bot uses that JWT today, so it is affected when the meeting is hosted by another account (e.g. a user pastes a link to their company meeting).

- **OBF (On Behalf Of):** Recommended for bots. A user from the host’s account authorizes the app; you use an OBF token to join on their behalf.
- **ZAK:** The authorized user joins from your app using a ZAK token (different flow).
- **RTMS:** Realtime Media Streams – alternative option.

To meet the requirement we will need to implement OAuth (e.g. `user:read:token` scope) and use OBF tokens for join. See [Zoom’s FAQ](https://developers.zoom.us/docs/meeting-sdk/obf-faq/) and [Transitioning to OBF tokens](https://developers.zoom.us/blog/transition-to-obf-token-meetingsdk-apps/).

---

## Env quick reference

| Variable | Where | Purpose |
|----------|--------|--------|
| `ZOOM_CLIENT_ID` | zoom-agent `.env` (and Attendee if using env creds) | Zoom Meeting SDK app |
| `ZOOM_CLIENT_SECRET` | zoom-agent `.env` (and Attendee) | Zoom Meeting SDK app |
| `NEXT_PUBLIC_GEMINI_API_KEY` or `GEMINI_API_KEY` | zoom-agent `.env` | Gemini Live API |
| `VOICE_WS_URL` | When running `zoom-bot` | Where the bot sends audio (e.g. `ws://localhost:3001` or ngrok `wss://...`) |
| `MEETING_URL` | When running `zoom-bot` | e.g. `https://zoom.us/j/123?pwd=abc` |
