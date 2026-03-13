'use client'

import { useState, useEffect, useCallback } from 'react'

type AuthStatus = { gateEnabled: boolean; authenticated: boolean }

export default function Gate({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AuthStatus | null>(null)
  const [key, setKey] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const checkStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/auth/status')
      const data = await res.json()
      setStatus(data)
    } catch {
      setStatus({ gateEnabled: false, authenticated: true })
    }
  }, [])

  useEffect(() => {
    checkStatus()
  }, [checkStatus])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!key.trim() || submitting) return
    setError(null)
    setSubmitting(true)
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: key.trim() }),
      })
      const data = await res.json()
      if (data.success) {
        setStatus((s) => (s ? { ...s, authenticated: true } : s))
      } else {
        setError('Invalid key')
      }
    } catch {
      setError('Request failed')
    } finally {
      setSubmitting(false)
    }
  }

  if (status === null) {
    return (
      <div className="gate-page">
        <div className="gate-loading">Loading…</div>
      </div>
    )
  }

  if (status.gateEnabled && !status.authenticated) {
    return (
      <div className="gate-page">
        <form onSubmit={handleSubmit} className="gate-form">
          <label htmlFor="gate-key">Enter access key</label>
          <input
            id="gate-key"
            type="password"
            autoComplete="off"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="Key"
            className="gate-input"
            autoFocus
          />
          {error && <p className="gate-error">{error}</p>}
          <button type="submit" disabled={submitting} className="gate-submit">
            {submitting ? 'Checking…' : 'Continue'}
          </button>
        </form>
      </div>
    )
  }

  return <>{children}</>
}
