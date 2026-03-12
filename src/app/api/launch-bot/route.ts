import { NextRequest, NextResponse } from 'next/server'

function isLocalAttendee(base: string): boolean {
  const u = base?.replace(/\/$/, '') ?? ''
  return u === 'http://localhost:8000' || u.startsWith('http://127.0.0.1:8000')
}

export async function POST(request: NextRequest) {
  const base = process.env.ATTENDEE_API_BASE_URL
  const token = process.env.ATTENDEE_API_KEY ?? ''
  if (!base) {
    return NextResponse.json(
      { error: 'Missing ATTENDEE_API_BASE_URL' },
      { status: 500 }
    )
  }
  // When using local Attendee with LOCAL_DEV_SKIP_API_KEY=1, no API key is required.
  if (!token && !isLocalAttendee(base)) {
    return NextResponse.json(
      { error: 'Missing ATTENDEE_API_KEY (required for non-local Attendee)' },
      { status: 500 }
    )
  }
  let body: { meeting_url?: string; bot_name?: string; websocket_audio_url?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  const meeting_url = body.meeting_url?.trim()
  if (!meeting_url) {
    return NextResponse.json({ error: 'meeting_url is required' }, { status: 400 })
  }
  const payload: Record<string, unknown> = {
    meeting_url,
    bot_name: body.bot_name?.trim() || 'Gemini Voice Agent',
  }
  const wsUrl = body.websocket_audio_url?.trim()
  if (wsUrl) {
    if (!wsUrl.toLowerCase().startsWith('wss://')) {
      return NextResponse.json(
        {
          error:
            'Attendee requires the Voice WebSocket URL to use wss:// (secure). For local dev, run: ngrok http 3001 and use the generated URL as wss://YOUR_SUBDOMAIN.ngrok.io',
        },
        { status: 400 }
      )
    }
    payload.websocket_settings = {
      audio: { url: wsUrl, sample_rate: 16000 },
    }
    // Voice-only: no recording file, so no recording prompt (listen-only mode).
    payload.recording_settings = { format: 'none' }
  }
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Token ${token}`
  const res = await fetch(`${base}/api/v1/bots`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const detail = data.detail
    const errMsg =
      typeof detail === 'string'
        ? detail
        : typeof detail === 'object' && detail !== null
          ? JSON.stringify(detail)
          : data.error || res.statusText
    return NextResponse.json({ error: errMsg }, { status: res.status })
  }
  return NextResponse.json(data)
}
