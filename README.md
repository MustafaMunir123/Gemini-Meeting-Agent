# Zoom + Gemini Live Voice Agent

Voice agent in Zoom Video SDK sessions powered by **Gemini Live API**. Join a Zoom session, then hold **Hold to talk to agent** to speak to the AI; your Zoom mic is muted while you talk so only the agent hears you.

## Prerequisites

- **Node.js** 18+
- **Zoom Video SDK** credentials (SDK Key & Secret) from [Zoom Marketplace](https://marketplace.zoom.us/)
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

   - `ZOOM_SDK_KEY` – Zoom Video SDK key  
   - `ZOOM_SDK_SECRET` – Zoom Video SDK secret  
   - `NEXT_PUBLIC_GEMINI_API_KEY` – Gemini API key (used in the browser)

3. **Run the app**

   ```bash
   npm run dev
   ```

   Open [http://localhost:3000](http://localhost:3000).

## Flow

1. Click **Join Zoom session** – joins the Zoom Video SDK session and connects the Gemini Live voice agent.
2. When **Gemini: Connected** appears, click and hold **Hold to talk to agent**.
3. While holding: your Zoom mic is muted, your voice is sent to Gemini, and the agent’s reply is played back.
4. Release the button – Zoom mic is unmuted again.
5. Click **Leave session** to leave Zoom and disconnect the agent.

## Project structure

- `src/data/getToken.ts` – Server-only Zoom JWT generation.
- `src/lib/GeminiLiveVoiceClient.ts` – Gemini Live client: connect, send mic audio, receive/play response audio, PTT signals.
- `src/lib/micCapture.ts` – Microphone capture to 16 kHz PCM for Gemini.
- `src/app/zoom/Videochat.tsx` – Zoom client: join/leave, video render, exposes client for mute/connection.
- `src/app/App.tsx` – Ties Zoom and Gemini: session sync (connect Gemini when Zoom connects, disconnect on leave), PTT (mute Zoom + stream mic to Gemini).

## Session name

The app uses a fixed session/topic name: `zoom-gemini-session`. To join the same “room” from another tab or device, use the same session name and a valid JWT (e.g. same Zoom app credentials).
