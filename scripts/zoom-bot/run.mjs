#!/usr/bin/env node
/**
 * Minimal Zoom bot runner: join a Zoom meeting and stream meeting audio to the voice server (3001).
 * No Attendee, Django, Celery, Redis, or Postgres.
 *
 * Usage:
 *   MEETING_URL="https://zoom.us/j/MEETING_ID?pwd=PASSWORD" VOICE_WS_URL="wss://your-ngrok.ngrok.io" node scripts/zoom-bot/run.mjs
 *   Or: ZOOM_MEETING_NUMBER=123 ZOOM_MEETING_PASSWORD=abc VOICE_WS_URL=wss://... node scripts/zoom-bot/run.mjs
 *
 * Requires: ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET (Zoom Meeting SDK app credentials).
 */

import http from 'http'
import path from 'path'
import url from 'url'
import fs from 'fs'
import WebSocket, { WebSocketServer } from 'ws'
import jwt from 'jsonwebtoken'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const dotenv = require('dotenv')
dotenv.config()

const clientId = process.env.ZOOM_CLIENT_ID
const clientSecret = process.env.ZOOM_CLIENT_SECRET
const meetingUrl = process.env.MEETING_URL
const meetingNumber = process.env.ZOOM_MEETING_NUMBER
const meetingPassword = process.env.ZOOM_MEETING_PASSWORD || ''
const voiceWsUrl = process.env.VOICE_WS_URL || 'ws://localhost:3001'
const botName = process.env.ZOOM_BOT_NAME || 'Voice Agent'

if (!clientId || !clientSecret) {
  console.error('Set ZOOM_CLIENT_ID and ZOOM_CLIENT_SECRET (Zoom Meeting SDK app credentials).')
  process.exit(1)
}

let parsedMeetingNumber = meetingNumber
let parsedPassword = meetingPassword
if (meetingUrl) {
  const u = url.parse(meetingUrl, true)
  const pathMatch = u.pathname?.match(/\/j\/(\d+)/)
  if (pathMatch) parsedMeetingNumber = pathMatch[1]
  if (u.query?.pwd) parsedPassword = u.query.pwd
}
if (!parsedMeetingNumber) {
  console.error('Set MEETING_URL (e.g. https://zoom.us/j/123?pwd=abc) or ZOOM_MEETING_NUMBER.')
  process.exit(1)
}

// Zoom JWT (same as Attendee: 2h expiry, role 0 = participant)
const iat = Math.floor(Date.now() / 1000) - 60
const exp = iat + 2 * 60 * 60
const signature = jwt.sign(
  {
    appKey: clientId,
    sdkKey: clientId,
    mn: String(parsedMeetingNumber),
    role: 0,
    iat,
    exp,
    tokenExp: exp,
  },
  clientSecret,
  { algorithm: 'HS256' }
)

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const PORT_HTTP = 0 // pick any free port
let bridgePort = 8765
let httpPort = 0

// ---- Local WebSocket server (browser connects here) ----
let voiceWs = null
const AUDIO_MESSAGE_TYPE = 3

function connectToVoiceServer() {
  voiceWs = new WebSocket(voiceWsUrl)
  voiceWs.on('open', () => console.log('[Bridge] Connected to voice server', voiceWsUrl))
  voiceWs.on('close', () => {
    console.log('[Bridge] Voice server disconnected, reconnecting in 10s')
    setTimeout(connectToVoiceServer, 10000)
  })
  voiceWs.on('error', (err) => console.error('[Bridge] Voice WS error', err))
}

// Float32 -> PCM 16-bit, optional downsample to 16kHz (input 48kHz)
function float32ToPcm16(float32) {
  const pcm16 = new Int16Array(float32.length)
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]))
    pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return Buffer.from(pcm16.buffer)
}

function downsample48to16(pcm16Buffer) {
  const samples48 = new Int16Array(pcm16Buffer.buffer, pcm16Buffer.byteOffset, pcm16Buffer.length / 2)
  const rate = 48000 / 16000 // 3
  const outLen = Math.floor(samples48.length / rate)
  const out = new Int16Array(outLen)
  for (let i = 0; i < outLen; i++) out[i] = samples48[i * rate]
  return Buffer.from(out.buffer)
}

const wss = new WebSocketServer({ port: bridgePort }, () => {
  console.log('[Bridge] Local WS server ws://localhost:' + bridgePort)
  connectToVoiceServer()
})
wss.on('connection', (browserWs) => {
  console.log('[Bridge] Browser connected')
  if (!voiceWs || voiceWs.readyState !== 1) connectToVoiceServer()

  browserWs.binaryType = 'arraybuffer'
  browserWs.on('message', (data) => {
    if (typeof data === 'string') return
    const buf = Buffer.from(data)
    if (buf.length < 4) return
    const msgType = buf.readInt32LE(0)
    if (msgType === AUDIO_MESSAGE_TYPE && buf.length > 4 && voiceWs?.readyState === 1) {
      const float32 = new Float32Array(buf.buffer, buf.byteOffset + 4, (buf.length - 4) / 4)
      const pcm16 = float32ToPcm16(float32)
      const pcm16k = downsample48to16(pcm16)
      const chunk = pcm16k.toString('base64')
      const payload = JSON.stringify({
        trigger: 'realtime_audio.mixed',
        data: { chunk, timestamp_ms: Date.now(), sample_rate: 16000 },
      })
      voiceWs.send(payload)
    }
  })
  browserWs.on('close', () => console.log('[Bridge] Browser disconnected'))
})

// ---- HTTP server (serve Zoom page with COOP/COEP) ----
const server = http.createServer((req, res) => {
  const u = url.parse(req.url, true)
  if (u.pathname === '/' || u.pathname === '/page.html') {
    res.writeHead(200, {
      'Content-Type': 'text/html',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    })
    const html = fs.readFileSync(path.join(__dirname, 'page.html'), 'utf8')
    res.end(html)
    return
  }
  if (u.pathname === '/payload.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript' })
    res.end(fs.readFileSync(path.join(__dirname, 'browser-payload.js'), 'utf8'))
    return
  }
  res.writeHead(404)
  res.end('Not found')
})
server.listen(PORT_HTTP, '127.0.0.1', () => {
  httpPort = server.address().port
  console.log('[HTTP] Serving Zoom page at http://127.0.0.1:' + httpPort + '/page.html')
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
})

async function main() {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({
    headless: process.env.HEADLESS !== '0',
    args: ['--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  })
  const context = await browser.newContext({
    permissions: ['microphone', 'camera'],
    ignoreHTTPSErrors: true,
  })
  const page = await context.newPage()

  const zoomInitialData = {
    signature,
    sdkKey: clientId,
    meetingNumber: parsedMeetingNumber,
    meetingPassword: parsedPassword,
    joinToken: '',
    zakToken: '',
    appPrivilegeToken: '',
    onBehalfToken: '',
  }
  const initialData = {
    websocketPort: bridgePort,
    botName,
    sendMixedAudio: true,
  }

  await page.goto('http://127.0.0.1:' + httpPort + '/page.html', { waitUntil: 'networkidle' })
  await page.evaluate(({ zoom, initial }) => {
    window.zoomInitialData = zoom
    window.initialData = initial
  }, { zoom: zoomInitialData, initial: initialData })

  // Allow Zoom SDK preLoadWasm/prepareWebSDK to complete
  await new Promise((r) => setTimeout(r, 3000))
  await page.evaluate(() => window.joinMeeting())
  console.log('[Bot] Join started, waiting for meeting entry (up to 60s)...')
  await page.waitForFunction(
    () => window.userHasEnteredMeeting && window.userHasEnteredMeeting(),
    { timeout: 60000 }
  ).catch(() => {
    console.warn('[Bot] Timeout waiting for userEnteredMeeting; enabling media sending anyway.')
  })
  await page.evaluate(() => {
    if (window.ws && typeof window.ws.enableMediaSending === 'function') window.ws.enableMediaSending()
  })
  console.log('[Bot] In meeting; audio streaming to voice server.')

  await new Promise(() => {}) // keep process alive
}
