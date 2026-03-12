# How the Zoom bot join + audio streaming works

This doc summarizes the flow used by Attendee so we can replicate it in a minimal utility inside zoom-agent (no Django, Celery, Postgres, Redis).

## High-level

1. **Launch**: Something triggers “join this meeting and stream audio to this WebSocket”.
2. **Browser**: A headless (or headed) Chrome runs a page that loads the Zoom Meeting SDK, joins the meeting, captures mixed meeting audio, and sends it over a **local** WebSocket.
3. **Bridge**: A process (in Attendee it’s the same Python worker) runs a **local WebSocket server**. The browser connects to it. That process also connects **as a client** to your voice server (e.g. 3001). It forwards: browser → voice server (audio), and optionally voice server → browser (e.g. TTS).
4. **Voice server (3001)**: Receives JSON like `{ trigger: 'realtime_audio.mixed', data: { chunk: '<base64 PCM>' } }` and sends it to Gemini (or your agent). It can send audio back for the bot to play.

So you need: **browser (Zoom join + capture)** ↔ **local WS server** ↔ **voice server (3001)**.

---

## 1. Join flow (Zoom Web SDK)

- **Page**: An HTML page is served (e.g. `http://127.0.0.1:<port>/zoom_web_chromedriver_page.html`). It loads:
  - Zoom Meeting SDK 4.x from `https://source.zoom.us/4.1.0/...` (react, react-dom, redux, redux-thunk, lodash, zoom-meeting-4.1.0.min.js).
  - A script that uses `ZoomMtg` to join.
- **Join data** (injected before join):
  - `zoomInitialData`: `signature` (JWT), `sdkKey` (= Zoom app client_id), `meetingNumber`, `meetingPassword`, optional `zakToken`, `joinToken`, `appPrivilegeToken`, `onBehalfToken`.
  - JWT is built like: payload `{ appKey, sdkKey, mn (meeting number), role: 0, iat, exp, tokenExp }`, signed with Zoom app **client_secret** (HS256). Same as Attendee’s `zoom_meeting_sdk_signature(meeting_number, role=0, client_id=..., client_secret=...)`.
- **Steps in the page**:
  - `ZoomMtg.preLoadWasm()` / `ZoomMtg.prepareWebSDK()`.
  - `ZoomMtg.init({ leaveUrl, patchJsMedia, ... })`.
  - `ZoomMtg.join({ signature, sdkKey, meetingNumber, passWord, userName, ... })`.
  - After join, the UI may ask for “recording” permission; for listen-only we skip that and enable sending mixed audio (see below).

---

## 2. Audio capture (browser)

- **Source of audio**: Zoom’s SDK renders the meeting and plays audio via the Web Audio API. Attendee **intercepts** `AudioNode.prototype.connect`: when something connects to the default `AudioDestinationNode` (speakers), it tees the stream and pushes it into a “style manager”.
- **Style manager**: Collects these streams and builds one combined stream:
  - Uses `AudioContext` (e.g. 48 kHz), `createMediaStreamSource` for each track, `createMediaStreamDestination()`, then `destination.stream` as the “meeting audio stream”.
- **Sending to the bridge**: For **mixed** audio, use the same approach as Google Meet in Attendee:
  - Take the single mixed track from the style manager.
  - `MediaStreamTrackProcessor({ track })` → get a readable stream of audio frames.
  - Use a `TransformStream` that, for each frame, copies Float32 samples (mono or average channels), then calls `sendMixedAudio(timestamp, audioData)`.
  - `sendMixedAudio`: send a **binary** message to the local WebSocket: 4 bytes little-endian **message type = 3** (AUDIO), then the Float32 buffer.
- **Enabling capture**: In Attendee, “enable media sending” runs `styleManager.start()` and sets `mediaSendingEnabled = true`. For listen-only we don’t ask for recording permission; we call the same “enable” path right after join so the intercept and style manager run.

---

## 3. Local WebSocket server (bridge)

- Listens on `localhost:<port>` (e.g. 8765).
- **On accept**:
  - One connection is the **browser**.
  - The same process opens a **client** connection to the voice server (e.g. `wss://...` or `ws://localhost:3001`).
- **Browser → voice server**:
  - Receive binary messages. First 4 bytes = message type (little-endian).
  - If type === 3 (AUDIO): rest is Float32. Convert to 16-bit PCM (e.g. multiply by 32768, clamp), optionally downsample to 16 kHz, base64-encode, then send to voice server as JSON: `{ trigger: 'realtime_audio.mixed', data: { chunk: '<base64>', timestamp_ms, sample_rate: 16000 } }`.
- **Voice server → browser** (optional):
  - When 3001 sends audio back (e.g. for bot to speak), the bridge forwards it to the browser; the browser would need a path to play it (e.g. via Zoom’s output or another Web Audio path). For a minimal “only stream to agent” util, this can be skipped.

---

## 4. What the voice server (3001) expects

- It already expects WebSocket messages like: `trigger === 'realtime_audio.mixed'` and `data.chunk` (base64 PCM, 16 kHz). So the bridge only has to produce that format; no change needed on 3001 if we keep the same contract.

---

## 5. Minimal utility in zoom-agent

- **No Attendee**: No Django, Celery, Redis, Postgres. No API to “create bot” or “launch bot”.
- **Single runner** (e.g. Node script):
  - Reads: `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET`, meeting URL (or meeting number + password), voice WebSocket URL (default to 3001).
  - Builds Zoom JWT (same as above).
  - Starts local HTTP server to serve the Zoom page (with COOP/COEP headers so Zoom SDK works).
  - Starts local WebSocket server (bridge).
  - Connects bridge to voice server (3001).
  - Launches Playwright (Chromium), navigates to the Zoom page, injects `zoomInitialData` and `initialData` (bot name, bridge port), then calls `joinMeeting()`.
  - Page script: Zoom SDK join + audio intercept + style manager + processMixedAudioTrack + WebSocket client to the bridge.
- **One command**: e.g. `MEETING_URL=... node scripts/zoom-bot/run.mjs` (and optionally voice server URL). No separate “Attendee” stack.

This gives you the same behavior as “click launch from :3000 and stream meeting audio to 3001” without running Attendee at all.
