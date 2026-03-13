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

const clientId = (process.env.ZOOM_CLIENT_ID || '').trim()
const clientSecret = (process.env.ZOOM_CLIENT_SECRET || '').trim()
const meetingUrl = process.env.MEETING_URL
const meetingNumber = process.env.ZOOM_MEETING_NUMBER
const meetingPassword = process.env.ZOOM_MEETING_PASSWORD || ''
const voiceWsUrl = process.env.VOICE_WS_URL || 'ws://localhost:3001'
const botName = process.env.ZOOM_BOT_NAME || 'Gemini Sidekick'

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

/** Build Zoom Meeting SDK JWT (same payload as Attendee zoom_meeting_sdk_signature). */
function buildSignature() {
  const iat = Math.floor(Date.now() / 1000) - 60
  const exp = iat + 2 * 60 * 60
  return jwt.sign(
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
}

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const PORT_HTTP = 0 // pick any free port
let bridgePort = 8765 // set when WSS binds (use 0 to avoid EADDRINUSE on relaunch)
let httpPort = 0

// ---- Local WebSocket server (browser connects here) ----
let voiceWs = null
const AUDIO_MESSAGE_TYPE = 3
const JSON_MESSAGE_TYPE = 1
/** Set in main() so bridge can call page.evaluate when recording permission is granted. */
let currentPage = null
/** Current browser WebSocket so we can forward agent audio from voice server to browser. */
let currentBrowserWs = null

function connectToVoiceServer() {
  voiceWs = new WebSocket(voiceWsUrl)
  voiceWs.on('open', () => console.log('[Bridge] Connected to voice server', voiceWsUrl))
  voiceWs.on('close', () => {
    console.log('[Bridge] Voice server disconnected, reconnecting in 10s')
    setTimeout(connectToVoiceServer, 10000)
  })
  voiceWs.on('error', (err) => console.error('[Bridge] Voice WS error', err))
  voiceWs.on('message', (data) => {
    if (!currentBrowserWs || currentBrowserWs.readyState !== 1) return
    const str = typeof data === 'string' ? data : (Buffer.isBuffer(data) ? data.toString('utf8') : String(data))
    currentBrowserWs.send(str)
  })
}

// Float32 [-1,1] -> PCM 16-bit (match Attendee: multiply by 32768, clamp to int16)
function float32ToPcm16(float32) {
  const pcm16 = new Int16Array(float32.length)
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]))
    const v = Math.round(s * 32768)
    pcm16[i] = Math.max(-32768, Math.min(32767, v))
  }
  return Buffer.from(pcm16.buffer)
}

// 48 kHz → 16 kHz with box-filter anti-aliasing (average 3 samples per output). Naive decimation destroys speech.
function downsample48to16(pcm16Buffer) {
  const samples48 = new Int16Array(pcm16Buffer.buffer, pcm16Buffer.byteOffset, pcm16Buffer.length / 2)
  const ratio = 3
  const outLen = Math.floor(samples48.length / ratio)
  const out = new Int16Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const j = i * ratio
    const a = samples48[j]
    const b = j + 1 < samples48.length ? samples48[j + 1] : a
    const c = j + 2 < samples48.length ? samples48[j + 2] : a
    out[i] = Math.max(-32768, Math.min(32767, Math.round((a + b + c) / 3)))
  }
  return Buffer.from(out.buffer)
}

// Use port 0 so OS assigns a free port (avoids EADDRINUSE when relaunching before previous process released 8765)
const wss = new WebSocketServer({ port: 0 }, () => {
  bridgePort = wss.address().port
  console.log('[Bridge] Local WS server ws://localhost:' + bridgePort)
  connectToVoiceServer()
})
wss.on('connection', (browserWs) => {
  console.log('[Bridge] Browser connected')
  currentBrowserWs = browserWs
  browserWs.on('close', () => {
    if (currentBrowserWs === browserWs) currentBrowserWs = null
    console.log('[Bridge] Browser disconnected')
  })
  if (!voiceWs || voiceWs.readyState !== 1) connectToVoiceServer()

  browserWs.binaryType = 'arraybuffer'
  browserWs.on('message', (data) => {
    if (typeof data === 'string') return
    const buf = Buffer.from(data)
    if (buf.length < 4) return
    const msgType = buf.readInt32LE(0)
    if (msgType === JSON_MESSAGE_TYPE && buf.length > 4) {
      try {
        const json = JSON.parse(buf.toString('utf8', 4))
        if (json.type === 'JoinError') {
          console.error('[Bridge] Zoom join failed:', json.error || json)
          if (json.raw && (json.raw.errorCode === 3712 || (json.error && String(json.error).includes('Invalid signature')))) {
            console.error('[Bridge] 3712 = Invalid signature. Use the SAME Zoom Meeting SDK credentials (ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET) as in Attendee. Copy them from Attendee\'s env/docker into this app\'s .env. No extra spaces/newlines.')
          }
        } else if (json.type === 'RecordingPermissionChange' && json.change === 'granted') {
          // Match Attendee: unmute bot (Zoom gets our virtual/silent mic, so no loopback) and enable media sending.
          console.log('[Bridge] Recording permission granted; unmuting mic and enabling media sending.')
          if (currentPage) {
            currentPage.evaluate(() => {
              if (typeof window.turnOnMic === 'function') window.turnOnMic()
              if (typeof window.ensureMicOn === 'function') window.ensureMicOn()
            }).catch((err) => console.error('[Bridge] turnOnMic failed', err))
            setTimeout(() => {
              if (currentPage) {
                currentPage.evaluate(() => {
                  if (window.ws && typeof window.ws.enableMediaSending === 'function') {
                    window.ws.enableMediaSending()
                  }
                }).catch((err) => console.error('[Bridge] enableMediaSending failed', err))
              }
            }, 800)
          }
        }
      } catch (e) {
        // ignore parse errors
      }
      return
    }
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

  // Generate signature at join time (same credentials as Attendee; must be Meeting SDK app SDK Key + Secret)
  const signature = buildSignature()
  // For meetings outside your app's account (Zoom requirement from March 2026), set ZOOM_ZAK_TOKEN or ZOOM_OBF_TOKEN. See https://developers.zoom.us/docs/meeting-sdk/obf-faq/
  const zakToken = process.env.ZOOM_ZAK_TOKEN?.trim() || ''
  const obfToken = process.env.ZOOM_OBF_TOKEN?.trim() || process.env.ZOOM_REGISTRANT_TOKEN?.trim() || ''
  const zoomInitialData = {
    signature,
    sdkKey: clientId,
    meetingNumber: parsedMeetingNumber,
    meetingPassword: parsedPassword,
    joinToken: '',
    zakToken,
    appPrivilegeToken: '',
    onBehalfToken: obfToken,
    registrantToken: obfToken,
  }
  const initialData = {
    websocketPort: bridgePort,
    botName,
    sendMixedAudio: true,
  }

  currentPage = page
  page.on('console', (msg) => {
    const text = msg.text()
    if (text.includes('Join error') || text.includes('Init error') || text.includes('Missing zoomInitialData')) {
      console.error('[Bot page]', text)
    }
  })
  // Inject credentials before page load (same as Attendee: data is there before any script runs)
  await page.addInitScript((data) => {
    window.zoomInitialData = data.zoom
    window.initialData = data.initial
  }, { zoom: zoomInitialData, initial: initialData })
  await page.goto('http://127.0.0.1:' + httpPort + '/page.html', { waitUntil: 'networkidle' })

  // Allow Zoom SDK preLoadWasm/prepareWebSDK to complete
  await new Promise((r) => setTimeout(r, 3000))
  console.log('[Bot] Joining meeting', parsedMeetingNumber, '...')
  await page.evaluate(() => window.joinMeeting())
  console.log('[Bot] Join started, waiting for meeting entry (up to 20s)...')
  const entered = await Promise.race([
    page.waitForFunction(
      () => window.userHasEnteredMeeting && window.userHasEnteredMeeting(),
      { timeout: 20000 }
    ).then(() => true).catch(() => false),
    new Promise((r) => setTimeout(() => r(false), 20000)),
  ])
  if (!entered) {
    console.warn('[Bot] Proceeding anyway after 20s (join may still be in progress).')
  } else {
    console.log('[Bot] In meeting.')
  }
  // Match Attendee: ask for recording permission so Zoom shows the prompt; enable media only after permission granted.
  console.log('[Bot] Asking for recording permission (user must accept in Zoom)...')
  await page.evaluate(() => {
    if (typeof window.askForMediaCapturePermission === 'function') {
      window.askForMediaCapturePermission()
    } else if (window.ws && typeof window.ws.enableMediaSending === 'function') {
      window.ws.enableMediaSending()
    }
  })
  console.log('[Bot] After you accept recording in Zoom, audio will stream to the voice server.')

  await new Promise(() => { }) // keep process alive
}
