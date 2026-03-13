import { NextRequest, NextResponse } from 'next/server'
import { spawn } from 'child_process'
import path from 'path'

declare global {
  // eslint-disable-next-line no-var
  var __zoomBotProcess: ReturnType<typeof spawn> | null
}
const getZoomBotProcess = () => (globalThis as unknown as { __zoomBotProcess?: ReturnType<typeof spawn> | null }).__zoomBotProcess ?? null
const setZoomBotProcess = (p: ReturnType<typeof spawn> | null) => {
  (globalThis as unknown as { __zoomBotProcess: ReturnType<typeof spawn> | null }).__zoomBotProcess = p
}

export async function POST(request: NextRequest) {
  let body: { meeting_url?: string; voice_ws_url?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  const meeting_url = body.meeting_url?.trim()
  if (!meeting_url) {
    return NextResponse.json({ error: 'meeting_url is required' }, { status: 400 })
  }
  // Default: same server, /voice-ws. Use PORT (Cloud Run sets 8080) so localhost works when bot runs in same container.
  const port = process.env.PORT || '3000'
  const baseUrl = (process.env.APP_URL || `http://localhost:${port}`).replace(/\/$/, '')
  const defaultVoiceWs = baseUrl.replace(/^http:\/\//, 'ws://').replace(/^https:\/\//, 'wss://') + '/voice-ws'
  const voice_ws_url = body.voice_ws_url?.trim() || defaultVoiceWs

  const clientId = process.env.ZOOM_CLIENT_ID
  const clientSecret = process.env.ZOOM_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    return NextResponse.json(
      { error: 'ZOOM_CLIENT_ID and ZOOM_CLIENT_SECRET are required for the meeting bot' },
      { status: 500 }
    )
  }

  // Optional: one bot at a time — kill previous if still running
  const existing = getZoomBotProcess()
  if (existing) {
    try {
      existing.kill('SIGTERM')
    } catch {
      // ignore
    }
    setZoomBotProcess(null)
  }

  const scriptPath = path.join(process.cwd(), 'scripts', 'zoom-bot', 'run.mjs')
  const child = spawn('node', [scriptPath], {
    env: {
      ...process.env,
      MEETING_URL: meeting_url,
      VOICE_WS_URL: voice_ws_url,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: process.cwd(),
  })

  setZoomBotProcess(child)
  child.stdout?.on('data', (chunk) => process.stdout.write(chunk))
  child.stderr?.on('data', (chunk) => process.stderr.write(chunk))
  child.on('exit', (code) => {
    if (getZoomBotProcess() === child) setZoomBotProcess(null)
    if (code != null && code !== 0) {
      console.error('[launch-zoom-bot] Process exited with code', code)
    }
  })

  return NextResponse.json({
    ok: true,
    message: 'Bot is joining the meeting. Check the server logs and the meeting.',
  })
}
