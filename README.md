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

## Project structure

- `src/data/getToken.ts` – Server-only JWT generation for the in-browser session.
- `src/lib/GeminiLiveVoiceClient.ts` – Gemini Live client: connect, send mic audio, receive/play response audio, PTT signals.
- `server.js` – Single-port server: Next.js + Voice WebSocket at `/voice-ws`. Run with `npm run dev` or `npm run start`.
- `scripts/voice-ws-server.mjs` – Voice WebSocket logic; mounted on the main server, or run standalone with `npm run voice-ws` (port 3001).
- `scripts/zoom-bot/` – Standalone meeting bot script (joins via URL, no in-browser client required).
- `src/app/App.tsx` – Launch flow, integrations, and in-browser session UI.

## Session name

The in-browser session uses a fixed session/topic name. To join the same “room” from another tab or device, use the same session name and a valid JWT.
