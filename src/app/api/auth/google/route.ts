import { NextResponse } from 'next/server'
import { getAuthUrl } from '@/lib/google-auth'

export async function GET() {
  try {
    const url = getAuthUrl()
    return NextResponse.redirect(url)
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Google auth failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
