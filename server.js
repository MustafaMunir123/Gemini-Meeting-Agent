/**
 * Single-port server: Next.js (HTTP) + Voice WebSocket on /voice-ws.
 * Run: node server.js (or npm run dev / npm run start).
 * For deployment you only need one port (e.g. 3000).
 */
require('dotenv').config({ path: '.env.local' })
require('dotenv').config() // .env
const http = require('http')
const { parse } = require('url')
const path = require('path')
const next = require('next')

const dev = process.env.NODE_ENV !== 'production'
const port = Number(process.env.PORT) || 3000
const hostname = process.env.HOSTNAME || 'localhost'

const app = next({ dev, hostname, port })
const handle = app.getRequestHandler()

app.prepare().then(async () => {
  const server = http.createServer(async (req, res) => {
    const parsedUrl = parse(req.url, true)
    await handle(req, res, parsedUrl)
  })

  // Mount voice WebSocket on same server (for meeting bot audio → Gemini)
  const voiceWsPath = process.env.VOICE_WS_PATH || '/voice-ws'
  const { attachVoiceWs } = await import('./scripts/voice-ws-server.mjs')
  attachVoiceWs(server, voiceWsPath)

  server.listen(port, () => {
    console.log(`> Ready on http://${hostname}:${port}`)
    console.log(`> Voice WebSocket on ws://${hostname}:${port}${voiceWsPath}`)
  })
})
