import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import crypto from 'crypto'

const COOKIE_NAME = 'gate_session'
const COOKIE_PAYLOAD = 'verified'
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365 // 1 year — ask only once per browser

function sign(value: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(value).digest('hex')
}

export async function POST(request: Request) {
  const loginKey = process.env.LOGIN_API_KEY?.trim()
  if (!loginKey) {
    return NextResponse.json({ success: false }, { status: 400 })
  }

  let body: { key?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ success: false }, { status: 400 })
  }

  const key = typeof body.key === 'string' ? body.key.trim() : ''
  if (!key) {
    return NextResponse.json({ success: false }, { status: 400 })
  }

  const expected = sign(loginKey, 'gate-verify')
  const actual = sign(key, 'gate-verify')
  if (expected.length !== actual.length || !crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'))) {
    return NextResponse.json({ success: false }, { status: 401 })
  }

  const value = sign(COOKIE_PAYLOAD, loginKey)
  const cookieStore = await cookies()
  cookieStore.set(COOKIE_NAME, value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: COOKIE_MAX_AGE,
    path: '/',
  })

  return NextResponse.json({ success: true })
}
