import { NextRequest, NextResponse } from 'next/server'

export async function POST(request: NextRequest) {
  const base = process.env.ATTENDEE_API_BASE_URL
  const token = process.env.ATTENDEE_API_KEY
  if (!base || !token) {
    return NextResponse.json(
      { error: 'Missing ATTENDEE_API_BASE_URL or ATTENDEE_API_KEY' },
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
  }
  const res = await fetch(`${base}/api/v1/bots`, {
    method: 'POST',
    headers: {
      Authorization: `Token ${token}`,
      'Content-Type': 'application/json',
    },
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
