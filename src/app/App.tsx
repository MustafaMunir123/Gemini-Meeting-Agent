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
  const [meetingUrl, setMeetingUrl] = useState('')
  const [botLaunching, setBotLaunching] = useState(false)
  const [botLaunched, setBotLaunched] = useState(false)
  const [botStopping, setBotStopping] = useState(false)
  const [runLocallyCommand, setRunLocallyCommand] = useState<string | null>(null)
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

  const launchBot = useCallback(async () => {
    const url = meetingUrl.trim()
    if (!url) {
      setError('Enter a meeting URL')
      return
    }
    setError(null)
    setRunLocallyCommand(null)
    setBotLaunching(true)
    setBotLaunched(false)
    try {
      const res = await fetch('/api/launch-zoom-bot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ meeting_url: url }),
      })
      const data = await res.json()
      if (!res.ok) {
        if (data.runLocally && data.command) {
          setRunLocallyCommand(data.command)
        }
        throw new Error(data.error || res.statusText)
      }
      setBotLaunched(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to launch meeting bot')
    } finally {
      setBotLaunching(false)
    }
  }, [meetingUrl])

  const stopBot = useCallback(async () => {
    setBotStopping(true)
    setError(null)
    try {
      const res = await fetch('/api/stop-zoom-bot', { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || res.statusText)
      setBotLaunched(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Stop failed')
    } finally {
      setBotStopping(false)
    }
  }, [])

  if (jwt === null) {
    return (
      <div className="app">
        <header className="app-header">
          <h1>Gemini Sidekick</h1>
          <p className="subtitle">
            Launch a helper agent into a meeting.
          </p>
        </header>
        {error && <div className="error">{error}</div>}
        {runLocallyCommand && (
          <div className="run-locally-box">
            <p className="run-locally-label">Run this in your terminal (from the app repo):</p>
            <pre className="run-locally-command">{runLocallyCommand}</pre>
          </div>
        )}
        <section className="launch-section">
          <div className="launch-row">
            <input
              type="url"
              placeholder="Meeting URL (e.g. https://…/j/…)"
              value={meetingUrl}
              onChange={(e) => setMeetingUrl(e.target.value)}
              className="input-url"
            />
            <button
              type="button"
              className="btn btn-primary"
              onClick={launchBot}
              disabled={botLaunching}
            >
              <img src="/integrations/jira-icon.png" alt="" className="btn-icon" aria-hidden />
              {botLaunching ? 'Launching…' : 'Launch meeting bot'}
            </button>
          </div>
          {botLaunched && (
            <div className="launch-actions">
              <span className="status status-ok">Bot is joining. Check the meeting and server logs.</span>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={stopBot}
                disabled={botStopping}
              >
                {botStopping ? 'Stopping…' : 'Leave meeting'}
              </button>
            </div>
          )}
        </section>

        <section className="integrations-section">
          <h2 className="integrations-title">Integrations</h2>
          <div className="integration-cards">
            <div className="integration-card">
              <div className="integration-card-header">
                <img src="/integrations/drive-icon.png" alt="" className="integration-icon" aria-hidden />
                <div>
                  <h3 className="integration-name">Google Drive</h3>
                  <span className={`integration-status ${driveConnected ? 'connected' : 'disconnected'}`}>
                    {driveConnected === true ? 'Connected' : 'Not connected'}
                  </span>
                </div>
              </div>
              <details className="tools-dropdown">
                <summary>Tools</summary>
                <ul className="tools-list">
                  <li>Search Drive</li>
                  <li>Save meeting minutes to Drive</li>
                </ul>
              </details>
              <div className="integration-card-actions">
                {driveConnected === true ? (
                  <button
                    type="button"
                    className="btn btn-reauth"
                    onClick={async () => {
                      await fetch('/api/drive/disconnect', { method: 'POST' })
                      setDriveConnected(false)
                      window.location.href = '/api/auth/google'
                    }}
                  >
                    Reauthenticate
                  </button>
                ) : (
                  <a href="/api/auth/google" className="btn btn-connect">Connect Google Drive</a>
                )}
              </div>
            </div>

            <div className="integration-card">
              <div className="integration-card-header">
                <img src="/integrations/jira-icon.png" alt="" className="integration-icon" aria-hidden />
                <div>
                  <h3 className="integration-name">Jira</h3>
                  <span className={`integration-status ${jiraConfigured ? 'connected' : 'disconnected'}`}>
                    {jiraConfigured === true ? 'Configured' : 'Not configured'}
                  </span>
                </div>
              </div>
              <details className="tools-dropdown">
                <summary>Tools</summary>
                <ul className="tools-list">
                  <li>Search tickets</li>
                  <li>Create ticket</li>
                </ul>
              </details>
              {!jiraConfigured && (
                <p className="integration-hint">Set JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_KEY in .env. Optional: JIRA_PROJECT_KEY, JIRA_BOARD_ID.</p>
              )}
            </div>

            <div className="integration-card integration-card-coming">
              <div className="integration-card-header">
                <div className="integration-icon integration-icon-placeholder" aria-hidden />
                <div>
                  <h3 className="integration-name">More</h3>
                  <span className="integration-status disconnected">Coming soon</span>
                </div>
              </div>
              <details className="tools-dropdown">
                <summary>Tools</summary>
                <ul className="tools-list">
                  <li>More integrations coming soon.</li>
                </ul>
              </details>
            </div>
          </div>
        </section>
      </div>
    )
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>Gemini Sidekick</h1>
        <p className="subtitle">
          Join a session, then hold the button to talk to the AI assistant.
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
        While holding the button, your mic is muted so only the agent hears you.
      </p>
    </div>
  )
}
