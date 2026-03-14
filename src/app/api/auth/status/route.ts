import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import crypto from 'crypto'

const COOKIE_NAME = 'gate_session'
const COOKIE_PAYLOAD = 'verified'

function sign(value: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(value).digest('hex')
}

export async function GET() {
  // Dynamic key so Next.js doesn't inline at build time (Cloud Run sets this at runtime)
  const loginKey = (process.env['LOGIN_API_KEY'] ?? '').trim()
  const gateEnabled = !!loginKey

  if (!gateEnabled) {
    const res = NextResponse.json({ gateEnabled: false, authenticated: true })
    // So you can confirm in DevTools → Network why the gate didn't show (e.g. on Cloud Run, set LOGIN_API_KEY in service env vars)
    res.headers.set('X-Gate-Disabled', 'LOGIN_API_KEY not set')
    return res
  }

  const cookieStore = await cookies()
  const cookie = cookieStore.get(COOKIE_NAME)?.value
  if (!cookie) {
    return NextResponse.json({ gateEnabled: true, authenticated: false })
  }

  const expected = sign(COOKIE_PAYLOAD, loginKey)
  let authenticated = false
  try {
    if (cookie.length === expected.length) {
      authenticated = crypto.timingSafeEqual(
        Buffer.from(cookie, 'hex'),
        Buffer.from(expected, 'hex')
      )
    }
  } catch {
    /* invalid cookie */
  }

  return NextResponse.json({ gateEnabled: true, authenticated })
}
