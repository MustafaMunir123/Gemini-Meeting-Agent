import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import crypto from 'crypto'

const COOKIE_NAME = 'gate_session'
const COOKIE_PAYLOAD = 'verified'

function sign(value: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(value).digest('hex')
}

export async function GET() {
  const loginKey = process.env.LOGIN_API_KEY?.trim()
  const gateEnabled = !!loginKey

  if (!gateEnabled) {
    return NextResponse.json({ gateEnabled: false, authenticated: true })
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
