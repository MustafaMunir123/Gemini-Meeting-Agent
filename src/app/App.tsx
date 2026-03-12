'use client'

import { useCallback, useRef, useState, useEffect } from 'react'
import dynamic from 'next/dynamic'
import { GeminiLiveVoiceClient, type SessionStatus } from '@/lib/GeminiLiveVoiceClient'
import { MicCapture } from '@/lib/micCapture'
import type { ZoomClient } from '@/app/zoom/Videochat'

const VideochatClientWrapper = dynamic(
  () => import('@/app/zoom/VideochatClientWrapper'),
  { ssr: false }
)

const ZOOM_CONNECTION_CONNECTED = 2
const ZOOM_CONNECTION_CLOSED = 3

export default function App({ jwt }: { jwt: string | null }) {
  const [geminiStatus, setGeminiStatus] = useState<SessionStatus>('disconnected')
  const [error, setError] = useState<string | null>(null)
  const [isPTTActive, setIsPTTActive] = useState(false)
  const [attendeeMeetingUrl, setAttendeeMeetingUrl] = useState('')
  const [attendeeVoiceWsUrl, setAttendeeVoiceWsUrl] = useState('')
  const [attendeeLaunching, setAttendeeLaunching] = useState(false)
  const [attendeeBot, setAttendeeBot] = useState<{ id: string; state: string } | null>(null)
  const [minimalBotLaunching, setMinimalBotLaunching] = useState(false)
  const [minimalBotLaunched, setMinimalBotLaunched] = useState(false)
  const [minimalBotStopping, setMinimalBotStopping] = useState(false)
  const [driveConnected, setDriveConnected] = useState<boolean | null>(null)
  const [jiraConfigured, setJiraConfigured] = useState<boolean | null>(null)
  const zoomClientRef = useRef<ZoomClient | null>(null)
  const geminiClientRef = useRef<GeminiLiveVoiceClient | null>(null)
  const micCaptureRef = useRef<MicCapture | null>(null)
  const sessionName = 'zoom-gemini-session'

  const connectGemini = useCallback(async () => {
    const apiKey = process.env.NEXT_PUBLIC_GEMINI_API_KEY
    if (!apiKey?.trim()) {
      setError('Set NEXT_PUBLIC_GEMINI_API_KEY in .env.local')
      return
    }
    if (geminiClientRef.current?.status === 'connected') return
    setError(null)
    const client = new GeminiLiveVoiceClient(apiKey, {
      onStatusChange: setGeminiStatus,
      onError: setError,
      onAudioReceived: () => { },
    })
    geminiClientRef.current = client
    try {
      await client.connect()
    } catch {
      setGeminiStatus('error')
    }
  }, [])

  const disconnectGemini = useCallback(() => {
    geminiClientRef.current?.disconnect()
    geminiClientRef.current = null
    setGeminiStatus('disconnected')
  }, [])

  const handleZoomClientReady = useCallback(
    (client: ZoomClient) => {
      zoomClientRef.current = client
      client.on('connection-change', (e: { state?: number }) => {
        if (e.state === ZOOM_CONNECTION_CONNECTED) {
          if (geminiStatus === 'disconnected') connectGemini()
        }
        if (e.state === ZOOM_CONNECTION_CLOSED) {
          disconnectGemini()
        }
      })
      if (geminiStatus === 'disconnected') connectGemini()
    },
    [geminiStatus, connectGemini, disconnectGemini]
  )

  const handlePTTDown = useCallback(() => {
    if (geminiStatus !== 'connected') return
    const zoom = zoomClientRef.current
    if (zoom) {
      const stream = zoom.getMediaStream()
      stream?.muteAudio()
    }
    geminiClientRef.current?.pushToTalkStart()
    const mic = new MicCapture({
      onChunk: (blob) => geminiClientRef.current?.sendAudioChunk(blob),
      onError: setError,
    })
    micCaptureRef.current = mic
    mic.start().catch((err) => setError(err?.message ?? 'Mic failed'))
    setIsPTTActive(true)
  }, [geminiStatus])

  const handlePTTUp = useCallback(() => {
    if (!isPTTActive) return
    micCaptureRef.current?.stop()
    micCaptureRef.current = null
    geminiClientRef.current?.pushToTalkStop()
    const zoom = zoomClientRef.current
    if (zoom) {
      const stream = zoom.getMediaStream()
      stream?.unmuteAudio()
    }
    setIsPTTActive(false)
  }, [isPTTActive])

  useEffect(() => {
    return () => {
      micCaptureRef.current?.stop()
      disconnectGemini()
    }
  }, [disconnectGemini])

  // Drive and Jira status
  useEffect(() => {
    fetch('/api/drive/status')
      .then((r) => r.json())
      .then((d) => setDriveConnected(d.connected === true))
      .catch(() => setDriveConnected(false))
    fetch('/api/jira/status')
      .then((r) => r.json())
      .then((d) => setJiraConfigured(d.configured === true))
      .catch(() => setJiraConfigured(false))
    const params = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '')
    if (params.get('drive') === 'connected') {
      setDriveConnected(true)
      window.history.replaceState({}, '', window.location.pathname)
    }
  }, [])

  const launchAttendeeBot = useCallback(async () => {
    const url = attendeeMeetingUrl.trim()
    if (!url) {
      setError('Enter a Zoom meeting URL')
      return
    }
    setError(null)
    setAttendeeLaunching(true)
    try {
      const res = await fetch('/api/launch-bot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          meeting_url: url,
          bot_name: 'Gemini Voice Agent',
          websocket_audio_url: attendeeVoiceWsUrl.trim() || undefined,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || res.statusText)
      setAttendeeBot({ id: data.id, state: data.state })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to launch bot')
    } finally {
      setAttendeeLaunching(false)
    }
  }, [attendeeMeetingUrl, attendeeVoiceWsUrl])

  const launchMinimalBot = useCallback(async () => {
    const url = attendeeMeetingUrl.trim()
    if (!url) {
      setError('Enter a Zoom meeting URL')
      return
    }
    setError(null)
    setMinimalBotLaunching(true)
    setMinimalBotLaunched(false)
    try {
      const voiceWs = attendeeVoiceWsUrl.trim()
      const res = await fetch('/api/launch-zoom-bot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          meeting_url: url,
          voice_ws_url: voiceWs || undefined,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || res.statusText)
      setMinimalBotLaunched(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to launch minimal bot')
    } finally {
      setMinimalBotLaunching(false)
    }
  }, [attendeeMeetingUrl, attendeeVoiceWsUrl])

  const stopMinimalBot = useCallback(async () => {
    setMinimalBotStopping(true)
    setError(null)
    try {
      const res = await fetch('/api/stop-zoom-bot', { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || res.statusText)
      setMinimalBotLaunched(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Stop failed')
    } finally {
      setMinimalBotStopping(false)
    }
  }, [])

  if (jwt === null) {
    return (
      <div className="app">
        <header className="app-header">
          <h1>Zoom + Gemini (Attendee)</h1>
          <p className="subtitle">
            Launch a bot into a Zoom meeting via Attendee. Make sure Zoom OAuth is set in Attendee (localhost:8000) and you’re in the meeting first.
          </p>
        </header>
        {error && <div className="error">{error}</div>}
        <div className="controls" style={{ flexDirection: 'column', alignItems: 'stretch', gap: '0.75rem' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' }}>
            <input
              type="url"
              placeholder="https://zoom.us/j/..."
              value={attendeeMeetingUrl}
              onChange={(e) => setAttendeeMeetingUrl(e.target.value)}
              style={{
                padding: '0.5rem 0.75rem',
                borderRadius: 8,
                border: '1px solid #3f3f46',
                background: '#18181b',
                color: '#e4e4e7',
                minWidth: 280,
                flex: 1,
              }}
            />
            <button
            type="button"
            className="btn btn-join"
            onClick={launchAttendeeBot}
            disabled={attendeeLaunching}
          >
            {attendeeLaunching ? 'Launching…' : 'Launch bot'}
          </button>
          </div>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 0, fontSize: '0.85rem', color: '#a1a1aa' }}>
            Voice WebSocket URL (optional — bot will respond to speech; must be <strong>wss://</strong>)
            <input
              type="text"
              placeholder="wss://xxxx.ngrok.io"
              value={attendeeVoiceWsUrl}
              onChange={(e) => setAttendeeVoiceWsUrl(e.target.value)}
              style={{
                padding: '0.5rem 0.75rem',
                borderRadius: 8,
                border: '1px solid #3f3f46',
                background: '#18181b',
                color: '#e4e4e7',
                marginTop: 4,
              }}
            />
          </label>
        </div>
        <p style={{ marginTop: '1rem', fontSize: '0.9rem', color: '#a1a1aa' }}>
          <strong>Google Drive (OAuth in this app):</strong>{' '}
          {driveConnected === true ? (
            <span style={{ color: '#86efac' }}>Drive connected</span>
          ) : (
            <>
              <a href="/api/auth/google" style={{ color: '#818cf8' }}>Connect Google Drive</a>
              {' '}(one-time). Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and DRIVE_FOLDER_ID in .env.
            </>
          )}
        </p>
        <p style={{ marginTop: '0.5rem', fontSize: '0.9rem', color: '#a1a1aa' }}>
          <strong>Jira (read-only):</strong>{' '}
          {jiraConfigured === true ? (
            <span style={{ color: '#86efac' }}>Jira connected</span>
          ) : (
            <>Not configured. Set JIRA_BASE_URL, JIRA_EMAIL, and JIRA_API_KEY in .env.</>
          )}
          {' '}Ask in the meeting to search tickets (e.g. &quot;check Jira for onboarding&quot;).
        </p>
        {attendeeBot && (
          <div className="status" style={{ marginTop: '1rem' }}>
            Bot {attendeeBot.id} — state: {attendeeBot.state}. Check Attendee dashboard or the meeting.
          </div>
        )}
        <hr style={{ margin: '1.5rem 0', borderColor: '#3f3f46' }} />
        <p style={{ fontSize: '0.9rem', color: '#a1a1aa', marginBottom: '0.5rem' }}>
          <strong>Or run the minimal Zoom bot</strong> (no Attendee, no API key — uses ZOOM_CLIENT_ID/SECRET from this app):
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' }}>
          <button
            type="button"
            className="btn btn-join"
            onClick={launchMinimalBot}
            disabled={minimalBotLaunching}
          >
            {minimalBotLaunching ? 'Launching…' : 'Launch minimal bot'}
          </button>
          {minimalBotLaunched && (
            <button
              type="button"
              className="btn"
              onClick={stopMinimalBot}
              disabled={minimalBotStopping}
              style={{ background: '#3f3f46', color: '#e4e4e7' }}
            >
              {minimalBotStopping ? 'Stopping…' : 'Leave meeting'}
            </button>
          )}
        </div>
        {minimalBotLaunched && (
          <div className="status" style={{ marginTop: '0.5rem' }}>
            Minimal bot is joining. It uses the meeting URL and Voice WebSocket URL above. Check server logs and the meeting.
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>Zoom + Gemini Live Voice Agent</h1>
        <p className="subtitle">
          Join a Zoom session, then hold the button to talk to the AI assistant.
        </p>
      </header>
      {error && <div className="error">{error}</div>}
      <div className="status">
        Gemini: {geminiStatus === 'connecting' && 'Connecting…'}
        {geminiStatus === 'connected' && <span className="status-connected">Connected</span>}
        {geminiStatus === 'error' && 'Error'}
        {geminiStatus === 'disconnected' && 'Disconnected'}
      </div>
      <VideochatClientWrapper
        slug={sessionName}
        jwt={jwt}
        userName="User"
        onClientReady={handleZoomClientReady}
      />
      <div className="controls" style={{ marginTop: '1rem' }}>
        <button
          type="button"
          className={`btn btn-ptt ${isPTTActive ? 'ptt-active' : ''}`}
          disabled={geminiStatus !== 'connected'}
          onMouseDown={handlePTTDown}
          onMouseUp={handlePTTUp}
          onMouseLeave={handlePTTUp}
          onTouchStart={(e) => {
            e.preventDefault()
            handlePTTDown()
          }}
          onTouchEnd={(e) => {
            e.preventDefault()
            handlePTTUp()
          }}
        >
          {isPTTActive ? 'Speaking…' : 'Hold to talk to agent'}
        </button>
      </div>
      <p className="ptt-hint">
        While holding the button, your Zoom mic is muted so only the agent hears you.
      </p>
    </div>
  )
}
