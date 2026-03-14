/**
 * Single-port server: Next.js (HTTP) + Voice WebSocket on /voice-ws.
 * Run: node server.js (or npm run dev / npm run start).
 * Listens on port immediately so Cloud Run sees the container as ready; Next.js and WS attach when prepared.
 */
require('dotenv').config({ path: '.env.local' })
require('dotenv').config() // .env
const http = require('http')
const { parse } = require('url')
const next = require('next')

const dev = process.env.NODE_ENV !== 'production'
const port = Number(process.env.PORT) || 3000
const hostname = process.env.HOSTNAME || 'localhost'
const listenHost = process.env.HOST || '0.0.0.0'

const app = next({ dev, hostname, port })
const handle = app.getRequestHandler()

let ready = false
const requestQueue = []

const server = http.createServer(async (req, res) => {
  const parsedUrl = parse(req.url, true)
  if (!ready) {
    requestQueue.push({ req, res, parsedUrl })
    return
  }
  await handle(req, res, parsedUrl)
})

// Listen immediately so Cloud Run doesn't kill the container before Next.js is ready
server.listen(port, listenHost, () => {
  console.log(`> Listening on http://${listenHost}:${port} (waiting for Next.js...)`)
})

app.prepare()
  .then(async () => {
    const voiceWsPath = process.env.VOICE_WS_PATH || '/voice-ws'
    const { attachVoiceWs } = await import('./scripts/voice-ws-server.mjs')
    attachVoiceWs(server, voiceWsPath)
    ready = true
    while (requestQueue.length > 0) {
      const { req, res, parsedUrl } = requestQueue.shift()
      handle(req, res, parsedUrl).catch((err) => {
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' })
        res.end(String(err?.message || err))
      })
    }
    console.log(`> Ready on http://${listenHost}:${port}`)
    console.log(`> Voice WebSocket on ws://${listenHost}:${port}${voiceWsPath}`)
  })
  .catch((err) => {
    console.error('Failed to start:', err)
    process.exit(1)
  })
