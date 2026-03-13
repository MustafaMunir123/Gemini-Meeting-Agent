# Minimal Zoom bot (no Attendee)

Join a Zoom meeting and stream meeting audio to your voice server (e.g. port 3001). No Django, Celery, Redis, or Postgres.

## Flow

1. **run.mjs** starts a local HTTP server (serves the Zoom page with COOP/COEP), a local WebSocket server (bridge on an OS-assigned port to avoid EADDRINUSE on relaunch), and connects as a client to your voice server (VOICE_WS_URL).
2. Playwright launches Chromium, loads the Zoom Meeting SDK page, injects meeting credentials and bridge port, and runs **joinMeeting()**.
3. The **browser** joins Zoom (ZoomMtg.init / ZoomMtg.join), and an **AudioNode** intercept captures the meeting playback and feeds it into a **StyleManager** (combined stream). When **enableMediaSending()** is called, **processMixedAudioTrack** sends Float32 chunks to the bridge over WebSocket (message type 3).
4. The **bridge** converts each chunk to 16 kHz PCM, base64, and forwards `{ trigger: 'realtime_audio.mixed', data: { chunk } }` to the voice server.

See [docs/ZOOM_BOT_FLOW.md](../../docs/ZOOM_BOT_FLOW.md) for the full flow.

## Usage

```bash
# Install deps (once)
npm install
npx playwright install chromium

# From project root; ensure .env has ZOOM_CLIENT_ID and ZOOM_CLIENT_SECRET
MEETING_URL="https://zoom.us/j/MEETING_ID?pwd=PASSWORD" \
VOICE_WS_URL="wss://your-ngrok.ngrok.io" \
npm run zoom-bot
```

Or:

```bash
ZOOM_MEETING_NUMBER=123456789 \
ZOOM_MEETING_PASSWORD=abc \
VOICE_WS_URL=ws://localhost:3001 \
npm run zoom-bot
```

- **VOICE_WS_URL**: Your voice server WebSocket (e.g. `ws://localhost:3001` for local, or `wss://...` with ngrok for remote). Must be running (e.g. `npm run voice-ws`).
- **HEADLESS=0**: Run the browser with a visible window (default is headless).

## Env

| Env | Required | Description |
|-----|----------|-------------|
| ZOOM_CLIENT_ID | Yes | Zoom Meeting SDK app client ID |
| ZOOM_CLIENT_SECRET | Yes | Zoom Meeting SDK app client secret |
| MEETING_URL | Or ZOOM_MEETING_NUMBER | e.g. `https://zoom.us/j/123?pwd=abc` |
| ZOOM_MEETING_NUMBER | Or MEETING_URL | Meeting number |
| ZOOM_MEETING_PASSWORD | No | Meeting password (or in MEETING_URL `?pwd=`) |
| VOICE_WS_URL | No | Default `ws://localhost:3001` |
| ZOOM_BOT_NAME | No | Display name in meeting (default "Voice Agent") |
| ZOOM_ZAK_TOKEN | No | ZAK token for joining meetings outside your app's account (Zoom requirement from Mar 2026). See [OBF/FAQ](https://developers.zoom.us/docs/meeting-sdk/obf-faq/) |
| ZOOM_OBF_TOKEN | No | On-behalf-of (or registrant) token; alternative to ZAK for cross-account joins |
| HEADLESS | No | Set to `0` to show the browser window |

## If the bot doesn't join

- Check the terminal for **`[Bridge] Zoom join failed:`** or **`[Bot page] Join error`** — that shows Zoom’s reason.
- Run with **`HEADLESS=0`** so the browser window is visible (same as Attendee).
- Use the **same meeting URL and Zoom Meeting SDK app** (ZOOM_CLIENT_ID / ZOOM_CLIENT_SECRET) as when using Attendee.
- From March 2026, joining meetings outside your app’s account may require **ZOOM_ZAK_TOKEN** or **ZOOM_OBF_TOKEN** (see Zoom’s OBF/FAQ).
